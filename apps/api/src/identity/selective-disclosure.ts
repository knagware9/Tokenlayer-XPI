/**
 * Platform-mediated selective disclosure: a holder chooses, per claim field,
 * to share the value, prove a numeric threshold predicate over it (only the
 * boolean result crosses the API boundary, never the value), or withhold it.
 * A verifier's `requestedFields` is advisory — validated the same way, but
 * never a floor on what the holder must disclose.
 *
 * Pure functions only: no DB, no Fastify. Route handlers own scoping data
 * (which credential's claims, which type's schema) and pass it in.
 */

export type PredicateOp = "gte" | "lte" | "gt" | "lt" | "eq";

export type FieldRequest = { kind: "value" } | { kind: "predicate"; op: PredicateOp; threshold: number };

export type DisclosureChoice =
  | { kind: "value" }
  | { kind: "predicate"; op: PredicateOp; threshold: number }
  | { kind: "withhold" };

export type ResolvedDisclosure =
  | { kind: "value"; value: unknown }
  | { kind: "predicate"; op: PredicateOp; threshold: number; result: boolean };

export interface FieldError {
  error: string;
  message: string;
}

const PREDICATE_OPS = new Set<PredicateOp>(["gte", "lte", "gt", "lt", "eq"]);

/** Runtime guard for `op` — `PredicateOp` is only a compile-time promise; a
 *  request body decoded from JSON can carry anything. Used by both
 *  `validateRequestedFields` and `resolveDisclosures` so a malformed op is
 *  rejected with a clear error before it ever reaches `evaluatePredicate`. */
function isPredicateOp(op: unknown): op is PredicateOp {
  return typeof op === "string" && PREDICATE_OPS.has(op as PredicateOp);
}

/** Runtime guard for `threshold` — must be an actual finite number, not a
 *  string, `NaN`, or `Infinity` that a loose JSON body let through. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function evaluatePredicate(value: number, op: PredicateOp, threshold: number): boolean {
  switch (op) {
    case "gte": return value >= threshold;
    case "lte": return value <= threshold;
    case "gt": return value > threshold;
    case "lt": return value < threshold;
    case "eq": return value === threshold;
    default: {
      // Exhaustive per the PredicateOp type above — reaching here means a
      // value TypeScript says can't happen actually did (a malformed request
      // that slipped past `validateRequestedFields`/`resolveDisclosures`'s own
      // op check). Fail loudly rather than silently return `undefined` from a
      // function whose return type claims `boolean`.
      const unhandled: string = op;
      throw new Error(`evaluatePredicate: unrecognized predicate operator '${unhandled}'`);
    }
  }
}

/**
 * Validates a create-time `requestedFields` map against each requested
 * type's claim schema. `schemasByType` must carry an entry for every type
 * named — the caller resolves types to schemas (a use case's own
 * `credentialTypes[]`, or the built-in catalog) before calling this.
 */
export function validateRequestedFields(
  requestedFields: Record<string, Record<string, FieldRequest>> | undefined,
  schemasByType: Map<string, { properties: Record<string, { type: string }> }>,
): FieldError | null {
  if (!requestedFields) return null;
  for (const [type, fields] of Object.entries(requestedFields)) {
    const schema = schemasByType.get(type);
    if (!schema) return { error: "UNKNOWN_FIELD", message: `credential type '${type}' is not part of this request` };
    for (const [field, fr] of Object.entries(fields)) {
      const prop = schema.properties[field];
      if (!prop) return { error: "UNKNOWN_FIELD", message: `'${field}' is not a field of ${type}` };
      if (fr.kind === "predicate") {
        if (!isPredicateOp(fr.op)) {
          return { error: "INVALID_PREDICATE_OP", message: `'${String(fr.op)}' is not a recognized predicate operator` };
        }
        if (!isFiniteNumber(fr.threshold)) {
          return { error: "INVALID_PREDICATE_THRESHOLD", message: `predicate threshold for '${field}' must be a finite number` };
        }
        if (prop.type !== "number") {
          return { error: "INVALID_PREDICATE_FIELD", message: `'${field}' is not a numeric field of ${type}; predicates only apply to numeric fields` };
        }
      } else if (fr.kind !== "value") {
        return { error: "INVALID_FIELD_REQUEST", message: `'${field}' has an unrecognized kind '${String((fr as { kind: unknown }).kind)}'` };
      }
    }
  }
  return null;
}

/**
 * Validates and evaluates a consent-time `disclosures` map against the real
 * claim values of each named credential. `disclosures` being absent entirely
 * resolves to `null` — the caller stores that as-is, meaning "every field of
 * every consented credential discloses in full", byte-identical to
 * pre-feature behavior. A withheld field produces no entry (absence IS
 * withholding).
 */
export function resolveDisclosures(
  disclosures: Record<string, Record<string, DisclosureChoice>> | undefined,
  claimsByCredentialId: Map<string, Record<string, unknown>>,
): { ok: true; resolved: Record<string, Record<string, ResolvedDisclosure>> | null } | ({ ok: false } & FieldError) {
  if (!disclosures) return { ok: true, resolved: null };
  const resolved: Record<string, Record<string, ResolvedDisclosure>> = {};
  for (const [credentialId, fields] of Object.entries(disclosures)) {
    const claims = claimsByCredentialId.get(credentialId);
    if (!claims) return { ok: false, error: "UNKNOWN_CREDENTIAL", message: `'${credentialId}' is not one of the credentials being presented` };
    const out: Record<string, ResolvedDisclosure> = {};
    for (const [field, choice] of Object.entries(fields)) {
      // `hasOwnProperty`, not `in` — `in` also matches inherited properties
      // (e.g. `"toString" in claims`), letting them slip past this gate.
      if (!Object.prototype.hasOwnProperty.call(claims, field)) {
        return { ok: false, error: "UNKNOWN_FIELD", message: `'${field}' is not a claim of credential '${credentialId}'` };
      }
      if (choice.kind === "withhold") continue;
      if (choice.kind === "value") {
        out[field] = { kind: "value", value: claims[field] };
      } else if (choice.kind === "predicate") {
        if (!isPredicateOp(choice.op)) {
          return { ok: false, error: "INVALID_PREDICATE_OP", message: `'${String(choice.op)}' is not a recognized predicate operator` };
        }
        if (!isFiniteNumber(choice.threshold)) {
          return { ok: false, error: "INVALID_PREDICATE_THRESHOLD", message: `predicate threshold for '${field}' must be a finite number` };
        }
        const value = claims[field];
        if (typeof value !== "number") {
          return { ok: false, error: "INVALID_PREDICATE_FIELD", message: `'${field}' is not a numeric claim; predicates only apply to numeric fields` };
        }
        out[field] = { kind: "predicate", op: choice.op, threshold: choice.threshold, result: evaluatePredicate(value, choice.op, choice.threshold) };
      } else {
        return { ok: false, error: "INVALID_DISCLOSURE_CHOICE", message: `'${field}' has an unrecognized disclosure kind '${String((choice as { kind: unknown }).kind)}'` };
      }
    }
    resolved[credentialId] = out;
  }
  return { ok: true, resolved };
}

/**
 * Builds the claims view `/verify` returns for one credential. `resolved`
 * (from `consentedDisclosures[credentialId]`) drives it when present;
 * `undefined` falls back to the full, unredacted claims — the request was
 * consented before this feature existed, or with no `disclosures` at all.
 */
export function redactClaims(
  fullClaims: Record<string, unknown> | null,
  resolved: Record<string, ResolvedDisclosure> | undefined,
): Record<string, unknown> | null {
  if (!resolved) return fullClaims;
  const out: Record<string, unknown> = {};
  for (const [field, rd] of Object.entries(resolved)) {
    out[field] = rd.kind === "value" ? rd.value : { predicate: { op: rd.op, threshold: rd.threshold, result: rd.result } };
  }
  return out;
}
