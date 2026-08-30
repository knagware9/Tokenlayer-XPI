# Selective Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a holder disclose credential claims field-by-field (full value, a numeric threshold predicate, or withheld) when consenting to a verification request, and let a verifier ask for specific fields — as an advisory request the holder always has final say over.

**Architecture:** Platform-mediated, not cryptographic — the VC-JWT is unchanged; the API filters what it returns from the existing consent → verify flow, which is the only path a verification ever takes on this platform (`/verify` already never returns the raw JWT). A new pure-function module (`selective-disclosure.ts`) owns validation and predicate evaluation; the route handlers become thin callers of it; two React components (verifier request form, holder consent panel) get new optional UI sections that are invisible/no-ops if never touched.

**Tech Stack:** Fastify + JSON-Schema validation, Prisma/SQLite (production) + an in-memory repository (used by the whole `apps/api` test suite — Prisma is exercised only by rebuilding and running the real containers, not by `vitest`), React + TypeScript on the frontend.

**Spec:** `docs/superpowers/specs/2026-08-30-selective-disclosure-design.md`

## Global Constraints

- Every new field on `VerificationRequestRecord` is nullable, never a new required parameter — every existing caller (route handlers, tests, the memory/Prisma repos) that doesn't know about this feature keeps compiling and behaving exactly as before.
- Predicates apply only to claim fields whose schema (or, at consent time, actual runtime value) type is `"number"` — rejected with `INVALID_PREDICATE_FIELD` otherwise.
- A field named in `requestedFields`/`disclosures` that doesn't exist on the relevant type/credential is rejected with `UNKNOWN_FIELD` — never silently ignored.
- `consentedDisclosures` is excluded from `vreqView()` (the general request-listing projection) — same precedent as the existing `verifierResult` field — and is computed into the `/verify` response only inside that route's own handler.
- No raw claim value is ever written into `consentedDisclosures` for a predicate-kind disclosure — only the boolean `result`.
- `apps/api/tsconfig.json` has `"include": ["src"]` — test files are **not** type-checked by `pnpm typecheck`; write them correctly anyway, but don't expect the compiler to catch a test-fixture slip.
- The whole `apps/api` test suite runs against `MemoryVerificationRequestRepository` (and its sibling in-memory repos), not Prisma — `vitest` never exercises the Prisma repository code path. Prisma correctness is verified by rebuilding the real containers at the end (Task 7).

---

### Task 1: Core selective-disclosure module

**Files:**
- Create: `apps/api/src/identity/selective-disclosure.ts`
- Test: `apps/api/test/selective-disclosure-core.test.ts`

**Interfaces:**
- Produces (used by every later task):
  ```ts
  export type PredicateOp = "gte" | "lte" | "gt" | "lt" | "eq";
  export type FieldRequest = { kind: "value" } | { kind: "predicate"; op: PredicateOp; threshold: number };
  export type DisclosureChoice = { kind: "value" } | { kind: "predicate"; op: PredicateOp; threshold: number } | { kind: "withhold" };
  export type ResolvedDisclosure = { kind: "value"; value: unknown } | { kind: "predicate"; op: PredicateOp; threshold: number; result: boolean };
  export interface FieldError { error: string; message: string }
  export function evaluatePredicate(value: number, op: PredicateOp, threshold: number): boolean;
  export function validateRequestedFields(requestedFields: Record<string, Record<string, FieldRequest>> | undefined, schemasByType: Map<string, { properties: Record<string, { type: string }> }>): FieldError | null;
  export function resolveDisclosures(disclosures: Record<string, Record<string, DisclosureChoice>> | undefined, claimsByCredentialId: Map<string, Record<string, unknown>>): { ok: true; resolved: Record<string, Record<string, ResolvedDisclosure>> | null } | ({ ok: false } & FieldError);
  export function redactClaims(fullClaims: Record<string, unknown> | null, resolved: Record<string, ResolvedDisclosure> | undefined): Record<string, unknown> | null;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/test/selective-disclosure-core.test.ts
import { describe, expect, it } from "vitest";
import {
  evaluatePredicate, validateRequestedFields, resolveDisclosures, redactClaims,
  type FieldRequest, type DisclosureChoice, type ResolvedDisclosure,
} from "../src/identity/selective-disclosure.js";

describe("evaluatePredicate", () => {
  it("evaluates every operator correctly", () => {
    expect(evaluatePredicate(2011, "lte", 2011)).toBe(true);
    expect(evaluatePredicate(2012, "lte", 2011)).toBe(false);
    expect(evaluatePredicate(2011, "gte", 2011)).toBe(true);
    expect(evaluatePredicate(2010, "gte", 2011)).toBe(false);
    expect(evaluatePredicate(5, "gt", 4)).toBe(true);
    expect(evaluatePredicate(4, "gt", 4)).toBe(false);
    expect(evaluatePredicate(3, "lt", 4)).toBe(true);
    expect(evaluatePredicate(4, "lt", 4)).toBe(false);
    expect(evaluatePredicate(7, "eq", 7)).toBe(true);
    expect(evaluatePredicate(7, "eq", 8)).toBe(false);
  });
});

const SCHEMAS = new Map([
  ["DomicileCredential", { properties: { holderName: { type: "string" }, continuousResidenceSinceYear: { type: "number" } } }],
]);

describe("validateRequestedFields", () => {
  it("passes through undefined unchanged", () => {
    expect(validateRequestedFields(undefined, SCHEMAS)).toBeNull();
  });
  it("accepts a value request and a predicate request on a numeric field", () => {
    const req: Record<string, Record<string, FieldRequest>> = {
      DomicileCredential: { holderName: { kind: "value" }, continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 } },
    };
    expect(validateRequestedFields(req, SCHEMAS)).toBeNull();
  });
  it("rejects an unknown credential type", () => {
    const req: Record<string, Record<string, FieldRequest>> = { NotAType: { x: { kind: "value" } } };
    const err = validateRequestedFields(req, SCHEMAS);
    expect(err?.error).toBe("UNKNOWN_FIELD");
  });
  it("rejects an unknown field on a known type", () => {
    const req: Record<string, Record<string, FieldRequest>> = { DomicileCredential: { notAField: { kind: "value" } } };
    const err = validateRequestedFields(req, SCHEMAS);
    expect(err?.error).toBe("UNKNOWN_FIELD");
  });
  it("rejects a predicate on a non-numeric field", () => {
    const req: Record<string, Record<string, FieldRequest>> = { DomicileCredential: { holderName: { kind: "predicate", op: "eq", threshold: 1 } } };
    const err = validateRequestedFields(req, SCHEMAS);
    expect(err?.error).toBe("INVALID_PREDICATE_FIELD");
  });
});

const CLAIMS = new Map([
  ["cred_1", { holderName: "Ramesh Kumar", continuousResidenceSinceYear: 2010 }],
]);

describe("resolveDisclosures", () => {
  it("returns resolved: null when disclosures is undefined", () => {
    const r = resolveDisclosures(undefined, CLAIMS);
    expect(r).toEqual({ ok: true, resolved: null });
  });
  it("rejects a credential id not in claimsByCredentialId", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = { cred_missing: { holderName: { kind: "value" } } };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("UNKNOWN_CREDENTIAL");
  });
  it("rejects an unknown field on a known credential", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = { cred_1: { notAField: { kind: "value" } } };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("UNKNOWN_FIELD");
  });
  it("rejects a predicate on a non-numeric claim", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = { cred_1: { holderName: { kind: "predicate", op: "eq", threshold: 1 } } };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("INVALID_PREDICATE_FIELD");
  });
  it("resolves a value disclosure, a true predicate, a false predicate, and omits a withheld field", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = {
      cred_1: {
        holderName: { kind: "value" },
        continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 },
      },
    };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.resolved).toEqual({
      cred_1: {
        holderName: { kind: "value", value: "Ramesh Kumar" },
        continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011, result: true },
      },
    });
  });
  it("a withheld field produces no entry in the resolved map", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = { cred_1: { holderName: { kind: "withhold" } } };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.resolved).toEqual({ cred_1: {} });
  });
  it("a failing predicate still resolves ok with result: false", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = {
      cred_1: { continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2005 } },
    };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.resolved.cred_1.continuousResidenceSinceYear).toEqual({ kind: "predicate", op: "lte", threshold: 2005, result: false });
  });
});

describe("redactClaims", () => {
  it("falls back to full claims when resolved is undefined", () => {
    const full = { a: 1, b: "x" };
    expect(redactClaims(full, undefined)).toBe(full);
  });
  it("falls back to null full claims unchanged when resolved is undefined", () => {
    expect(redactClaims(null, undefined)).toBeNull();
  });
  it("builds a value field and a predicate field, omitting anything not in resolved", () => {
    const resolved: Record<string, ResolvedDisclosure> = {
      holderName: { kind: "value", value: "Ramesh Kumar" },
      continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011, result: true },
    };
    const out = redactClaims({ holderName: "Ramesh Kumar", continuousResidenceSinceYear: 2010, state: "Maharashtra" }, resolved);
    expect(out).toEqual({
      holderName: "Ramesh Kumar",
      continuousResidenceSinceYear: { predicate: { op: "lte", threshold: 2011, result: true } },
    });
    expect(out).not.toHaveProperty("state");
  });
  it("an empty resolved map (everything withheld) produces an empty claims object", () => {
    expect(redactClaims({ a: 1 }, {})).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/selective-disclosure-core.test.ts`
Expected: FAIL — `Cannot find module '../src/identity/selective-disclosure.js'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/identity/selective-disclosure.ts
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

export function evaluatePredicate(value: number, op: PredicateOp, threshold: number): boolean {
  switch (op) {
    case "gte": return value >= threshold;
    case "lte": return value <= threshold;
    case "gt": return value > threshold;
    case "lt": return value < threshold;
    case "eq": return value === threshold;
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
      if (fr.kind === "predicate" && prop.type !== "number") {
        return { error: "INVALID_PREDICATE_FIELD", message: `'${field}' is not a numeric field of ${type}; predicates only apply to numeric fields` };
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
      if (choice.kind === "withhold") continue;
      if (!(field in claims)) return { ok: false, error: "UNKNOWN_FIELD", message: `'${field}' is not a claim of credential '${credentialId}'` };
      if (choice.kind === "value") {
        out[field] = { kind: "value", value: claims[field] };
      } else {
        const value = claims[field];
        if (typeof value !== "number") {
          return { ok: false, error: "INVALID_PREDICATE_FIELD", message: `'${field}' is not a numeric claim; predicates only apply to numeric fields` };
        }
        out[field] = { kind: "predicate", op: choice.op, threshold: choice.threshold, result: evaluatePredicate(value, choice.op, choice.threshold) };
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/selective-disclosure-core.test.ts`
Expected: PASS — 14 tests

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors (this file is under `src/`, so it IS checked)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/identity/selective-disclosure.ts apps/api/test/selective-disclosure-core.test.ts
git commit -m "feat(identity): core selective-disclosure validation and predicate evaluation"
```

---

### Task 2: Persistence layer

**Files:**
- Modify: `apps/api/src/persistence/types/identity.ts`
- Modify: `apps/api/src/persistence/memory/identity.ts`
- Modify: `apps/api/src/persistence/prisma/identity.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/test/verification-repo.test.ts`

**Interfaces:**
- Consumes: `FieldRequest`, `ResolvedDisclosure` from Task 1 (`apps/api/src/identity/selective-disclosure.js`).
- Produces: `VerificationRequestRecord.requestedFields` / `.consentedDisclosures`; `VerificationRequestRepository.setConsented`'s new `disclosures` input field — every later task's route/repo code relies on these exact names.

- [ ] **Step 1: Update `VerificationRequestRecord` and `VerificationRequestRepository`**

In `apps/api/src/persistence/types/identity.ts`, add the import and extend the interface (current content shown for exact placement):

```ts
// Add to the top-of-file imports:
import type { FieldRequest, ResolvedDisclosure } from "../../identity/selective-disclosure.js";
```

Change:
```ts
export interface VerificationRequestRecord {
  id: string;
  verifierOrgId: string;
  holderDid: string;
  requestedTypes: string[];
  purpose: string;
  credentialUseCaseKey: string | null;
  challenge: string;
  status: VerificationStatus;
  presentationVpJwt: string | null;
  consentedAt: string | null;
  consentedCredentialIds: string[] | null;
  verifierResult: Record<string, unknown> | null;
  verifiedAt: string | null;
  createdAt: string;
  expiresAt: string;
}
```
to:
```ts
export interface VerificationRequestRecord {
  id: string;
  verifierOrgId: string;
  holderDid: string;
  requestedTypes: string[];
  purpose: string;
  credentialUseCaseKey: string | null;
  challenge: string;
  status: VerificationStatus;
  presentationVpJwt: string | null;
  consentedAt: string | null;
  consentedCredentialIds: string[] | null;
  /** The verifier's advisory per-field ask, set at create time. Never a floor
   *  on disclosure — see `consentedDisclosures`. */
  requestedFields: Record<string, Record<string, FieldRequest>> | null;
  /** What the holder actually chose to disclose, resolved (predicates
   *  evaluated to a boolean, never a raw value) at consent time. `null` means
   *  "no `disclosures` was supplied" — every field of every consented
   *  credential discloses in full, same as before this feature existed. */
  consentedDisclosures: Record<string, Record<string, ResolvedDisclosure>> | null;
  verifierResult: Record<string, unknown> | null;
  verifiedAt: string | null;
  createdAt: string;
  expiresAt: string;
}
```

Change `setConsented`'s signature:
```ts
setConsented(id: string, input: { vpJwt: string; credentialIds: string[]; at: string }): Promise<VerificationRequestRecord>;
```
to:
```ts
setConsented(id: string, input: { vpJwt: string; credentialIds: string[]; at: string; disclosures: Record<string, Record<string, ResolvedDisclosure>> | null }): Promise<VerificationRequestRecord>;
```

- [ ] **Step 2: Update the Memory repository**

In `apps/api/src/persistence/memory/identity.ts`, `create` needs no change (it spreads `input`, so the new fields flow through automatically once callers supply them). Change `setConsented`:

```ts
  async setConsented(reqId: string, input: { vpJwt: string; credentialIds: string[]; at: string }): Promise<VerificationRequestRecord> {
    const rec = this.byId.get(reqId);
    if (!rec) throw new Error(`unknown verification request '${reqId}'`);
    rec.status = "consented"; rec.presentationVpJwt = input.vpJwt; rec.consentedCredentialIds = input.credentialIds; rec.consentedAt = input.at;
    return rec;
  }
```
to:
```ts
  async setConsented(reqId: string, input: { vpJwt: string; credentialIds: string[]; at: string; disclosures: Record<string, Record<string, ResolvedDisclosure>> | null }): Promise<VerificationRequestRecord> {
    const rec = this.byId.get(reqId);
    if (!rec) throw new Error(`unknown verification request '${reqId}'`);
    rec.status = "consented"; rec.presentationVpJwt = input.vpJwt; rec.consentedCredentialIds = input.credentialIds; rec.consentedAt = input.at;
    rec.consentedDisclosures = input.disclosures;
    return rec;
  }
```

Add `ResolvedDisclosure` to this file's imports (mirroring wherever `VerificationRequestRecord` is already imported from `../types/index.js` — add `type ResolvedDisclosure` alongside it if the module re-exports it, otherwise import directly from `../../identity/selective-disclosure.js`).

- [ ] **Step 3: Update the Prisma schema**

In `apps/api/prisma/schema.prisma`, in the `VerificationRequest` model, add two columns (placed with the other JSON-as-string columns):

```prisma
model VerificationRequest {
  id                     String    @id @default(cuid())
  verifierOrgId          String
  holderDid              String
  requestedTypes         String // JSON array of credential-type strings
  purpose                String
  credentialUseCaseKey   String? // the CredentialUseCase scoping this request, if any
  challenge              String
  status                 String    @default("pending") // pending | consented | rejected | expired
  presentationVpJwt      String? // the holder-signed VP, set at consent
  consentedAt            DateTime?
  consentedCredentialIds String? // JSON array, set at consent
  requestedFields        String? // JSON: Record<type, Record<field, FieldRequest>>, set at create
  consentedDisclosures   String? // JSON: Record<credentialId, Record<field, ResolvedDisclosure>>, set at consent
  verifierResult         String? // JSON verification result, set at verify
  verifiedAt             DateTime?
  createdAt              DateTime  @default(now())
  expiresAt              DateTime

  @@index([holderDid, status])
  @@index([verifierOrgId, status])
}
```

Regenerate the Prisma client (needed for the next step's TypeScript to compile against the new columns):

Run: `cd apps/api && npx prisma generate`
Expected: `✔ Generated Prisma Client`

- [ ] **Step 4: Update the Prisma repository**

In `apps/api/src/persistence/prisma/identity.ts`, extend `toVerificationRequest`'s parameter type and body:

```ts
const toVerificationRequest = (r: {
  id: string; verifierOrgId: string; holderDid: string; requestedTypes: string; purpose: string; challenge: string;
  status: string; presentationVpJwt: string | null; consentedAt: Date | null; consentedCredentialIds: string | null;
  requestedFields: string | null; consentedDisclosures: string | null;
  verifierResult: string | null; verifiedAt: Date | null; createdAt: Date; expiresAt: Date;
  credentialUseCaseKey: string | null;
}): VerificationRequestRecord => ({
  id: r.id, verifierOrgId: r.verifierOrgId, holderDid: r.holderDid,
  requestedTypes: JSON.parse(r.requestedTypes) as string[], purpose: r.purpose, challenge: r.challenge,
  status: r.status as VerificationStatus, presentationVpJwt: r.presentationVpJwt,
  consentedAt: r.consentedAt ? r.consentedAt.toISOString() : null,
  consentedCredentialIds: r.consentedCredentialIds ? (JSON.parse(r.consentedCredentialIds) as string[]) : null,
  requestedFields: r.requestedFields ? (JSON.parse(r.requestedFields) as Record<string, Record<string, FieldRequest>>) : null,
  consentedDisclosures: r.consentedDisclosures ? (JSON.parse(r.consentedDisclosures) as Record<string, Record<string, ResolvedDisclosure>>) : null,
  verifierResult: r.verifierResult ? (JSON.parse(r.verifierResult) as Record<string, unknown>) : null,
  verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
  credentialUseCaseKey: r.credentialUseCaseKey,
});
```

Extend `create`:
```ts
  async create(input: Omit<VerificationRequestRecord, "id" | "createdAt">): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.create({
      data: {
        verifierOrgId: input.verifierOrgId, holderDid: input.holderDid,
        requestedTypes: JSON.stringify(input.requestedTypes), purpose: input.purpose, challenge: input.challenge,
        status: input.status, presentationVpJwt: input.presentationVpJwt,
        consentedAt: input.consentedAt ? new Date(input.consentedAt) : null,
        consentedCredentialIds: input.consentedCredentialIds ? JSON.stringify(input.consentedCredentialIds) : null,
        requestedFields: input.requestedFields ? JSON.stringify(input.requestedFields) : null,
        consentedDisclosures: input.consentedDisclosures ? JSON.stringify(input.consentedDisclosures) : null,
        verifierResult: input.verifierResult ? JSON.stringify(input.verifierResult) : null,
        verifiedAt: input.verifiedAt ? new Date(input.verifiedAt) : null,
        expiresAt: new Date(input.expiresAt),
        credentialUseCaseKey: input.credentialUseCaseKey,
      },
    }));
  }
```

Extend `setConsented`:
```ts
  async setConsented(id: string, input: { vpJwt: string; credentialIds: string[]; at: string; disclosures: Record<string, Record<string, ResolvedDisclosure>> | null }): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.update({
      where: { id },
      data: {
        status: "consented", presentationVpJwt: input.vpJwt,
        consentedCredentialIds: JSON.stringify(input.credentialIds), consentedAt: new Date(input.at),
        consentedDisclosures: input.disclosures ? JSON.stringify(input.disclosures) : null,
      },
    }));
  }
```

Add `FieldRequest, ResolvedDisclosure` to this file's type-only imports from `../../identity/selective-disclosure.js`.

- [ ] **Step 5: Extend the repo test's fixture and assertions**

In `apps/api/test/verification-repo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MemoryVerificationRequestRepository } from "../src/persistence/memory/index.js";

const base = {
  verifierOrgId: "org_v", holderDid: "did:key:zH", requestedTypes: ["KycCredential"],
  purpose: "onboarding", challenge: "chal-1", status: "pending" as const,
  presentationVpJwt: null, consentedAt: null, consentedCredentialIds: null,
  requestedFields: null, consentedDisclosures: null,
  verifierResult: null, verifiedAt: null, expiresAt: "2026-07-18T00:00:00.000Z",
  credentialUseCaseKey: null,
};

describe("MemoryVerificationRequestRepository", () => {
  it("creates, gets, and lists by holder and by verifier org", async () => {
    const repo = new MemoryVerificationRequestRepository();
    const r = await repo.create(base);
    expect(r.id).toBeTruthy();
    expect(r.status).toBe("pending");
    expect((await repo.get(r.id))?.purpose).toBe("onboarding");
    expect(await repo.listByHolder("did:key:zH")).toHaveLength(1);
    expect(await repo.listByHolder("did:key:zH", "consented")).toHaveLength(0);
    expect(await repo.listByVerifierOrg("org_v")).toHaveLength(1);
    expect(await repo.listByVerifierOrg("org_other")).toHaveLength(0);
  });

  it("stores requestedFields at create time", async () => {
    const repo = new MemoryVerificationRequestRepository();
    const r = await repo.create({
      ...base,
      requestedFields: { DomicileCredential: { continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 } } },
    });
    expect(r.requestedFields).toEqual({ DomicileCredential: { continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 } } });
  });

  it("sets consent, disclosures, and status transitions", async () => {
    const repo = new MemoryVerificationRequestRepository();
    const r = await repo.create(base);
    const disclosures = { cred_1: { continuousResidenceSinceYear: { kind: "predicate" as const, op: "lte" as const, threshold: 2011, result: true } } };
    const c = await repo.setConsented(r.id, { vpJwt: "a.b.c", credentialIds: ["cred_1"], at: "2026-07-17T12:00:00.000Z", disclosures });
    expect(c.status).toBe("consented");
    expect(c.presentationVpJwt).toBe("a.b.c");
    expect(c.consentedCredentialIds).toEqual(["cred_1"]);
    expect(c.consentedDisclosures).toEqual(disclosures);
    const rej = await repo.setStatus(r.id, "rejected");
    expect(rej.status).toBe("rejected");
    const v = await repo.setVerifierResult(r.id, { result: { valid: true }, at: "2026-07-17T13:00:00.000Z" });
    expect(v.verifierResult).toEqual({ valid: true });
    expect(v.verifiedAt).toBe("2026-07-17T13:00:00.000Z");
  });

  it("setConsented with disclosures: null preserves full-disclosure fallback behavior", async () => {
    const repo = new MemoryVerificationRequestRepository();
    const r = await repo.create(base);
    const c = await repo.setConsented(r.id, { vpJwt: "a.b.c", credentialIds: ["cred_1"], at: "2026-07-17T12:00:00.000Z", disclosures: null });
    expect(c.consentedDisclosures).toBeNull();
  });
});
```

- [ ] **Step 6: Run the test**

Run: `cd apps/api && npx vitest run test/verification-repo.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 7: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors. If this fails because other callers of `create`/`setConsented` (route handlers) don't yet supply the new fields — that's expected and gets fixed in Task 4; note the specific errors but don't fix them here, to keep this task's diff scoped to the persistence layer.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/persistence apps/api/prisma/schema.prisma apps/api/test/verification-repo.test.ts
git commit -m "feat(identity): persist requestedFields/consentedDisclosures on verification requests"
```

---

### Task 3: `vreqView()` and the holder's eligible-credentials claims

**Files:**
- Modify: `apps/api/src/identity/verification-request-view.ts`
- Modify: `apps/api/src/http/routes/shared.ts`

**Interfaces:**
- Consumes: `VerificationRequestRecord.requestedFields` (Task 2).
- Produces: `vreqView()`'s output now carries `requestedFields`; `GET /me/verification-requests`'s `eligibleCredentials[].claims` — the holder UI (Task 6) reads both.

- [ ] **Step 1: Add `requestedFields` to `vreqView()`, keep `consentedDisclosures` excluded**

In `apps/api/src/identity/verification-request-view.ts`, change:
```ts
export function vreqView(r: VerificationRequestRecord) {
  return {
    id: r.id, verifierOrgId: r.verifierOrgId, holderDid: r.holderDid, requestedTypes: r.requestedTypes,
    purpose: r.purpose, status: r.status, consentedCredentialIds: r.consentedCredentialIds,
    consentedAt: r.consentedAt, verifiedAt: r.verifiedAt, createdAt: r.createdAt, expiresAt: r.expiresAt,
    credentialUseCaseKey: r.credentialUseCaseKey,
  };
}
```
to:
```ts
export function vreqView(r: VerificationRequestRecord) {
  return {
    id: r.id, verifierOrgId: r.verifierOrgId, holderDid: r.holderDid, requestedTypes: r.requestedTypes,
    purpose: r.purpose, status: r.status, consentedCredentialIds: r.consentedCredentialIds,
    // The verifier's own advisory ask — visible to both sides already via
    // requestedTypes, so there's nothing sensitive here. NOT `consentedDisclosures`:
    // that's the resolved, disclosed-or-not answer, and stays out of every general
    // listing for the same reason `verifierResult` does (see the file comment above).
    requestedFields: r.requestedFields,
    consentedAt: r.consentedAt, verifiedAt: r.verifiedAt, createdAt: r.createdAt, expiresAt: r.expiresAt,
    credentialUseCaseKey: r.credentialUseCaseKey,
  };
}
```

- [ ] **Step 2: Add `claims` to `eligibleCredentials`**

In `apps/api/src/http/routes/shared.ts`, in the `GET /me/verification-requests` handler, change:
```ts
    return Promise.all(rows.map(async (r) => ({
      ...vreqView(r),
      eligibleCredentials: await Promise.all(
        mine
          .filter((c) => !c.revoked && c.acceptance === "accepted" && r.requestedTypes.includes(c.type))
          .map(async (c) => ({
            id: c.id, type: c.type, issuerDid: c.issuerDid, issuerName: await nameOf(c.issuerDid),
            issuedAt: c.issuedAt, expiresAt: c.expiresAt,
          })),
      ),
    })));
```
to:
```ts
    return Promise.all(rows.map(async (r) => ({
      ...vreqView(r),
      eligibleCredentials: await Promise.all(
        mine
          .filter((c) => !c.revoked && c.acceptance === "accepted" && r.requestedTypes.includes(c.type))
          .map(async (c) => ({
            id: c.id, type: c.type, issuerDid: c.issuerDid, issuerName: await nameOf(c.issuerDid),
            issuedAt: c.issuedAt, expiresAt: c.expiresAt,
            // So the holder's own consent UI can render one row per field
            // without a second round-trip. No new exposure: this is the
            // holder's own inbox for their own credentials, already readable
            // in full via GET /me/credentials.
            claims: c.subjectClaims,
          })),
      ),
    })));
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no new errors from these two files (other pre-existing errors from Task 2's unfinished callers are still expected and get fixed next).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/identity/verification-request-view.ts apps/api/src/http/routes/shared.ts
git commit -m "feat(identity): surface requestedFields and eligible-credential claims to the holder"
```

---

### Task 4: API schemas + route handlers

**Files:**
- Modify: `apps/api/src/http/schemas/components.ts`
- Modify: `apps/api/src/http/schemas/identity.ts`
- Modify: `apps/api/src/http/routes/identity.ts`
- Test: `apps/api/test/selective-disclosure.test.ts` (new)

**Interfaces:**
- Consumes: everything from Tasks 1–3 (`selective-disclosure.js` functions/types, the extended `VerificationRequestRecord`/`setConsented`, `vreqView()`).
- Produces: the full end-to-end feature at the API layer — this is what Tasks 5–6 (web) call.

- [ ] **Step 1: Add `requestedFields`/`disclosures` to the schemas**

In `apps/api/src/http/schemas/components.ts`, in the `VerificationRequest` component (`$id: "VerificationRequest"`), add a `requestedFields` property alongside the existing `eligibleCredentials` one:

```ts
      credentialUseCaseKey: { type: "string", nullable: true },
      // The verifier's advisory per-field ask, set at create time — never a
      // floor on what the holder discloses.
      requestedFields: {
        type: "object", nullable: true,
        description: "Per requested credential type, per field: { kind: \"value\" } or { kind: \"predicate\", op, threshold }.",
        additionalProperties: true,
      },
      // Added by GET /me/verification-requests only — the holder's own view,
      // which pre-computes what they could consent with. Absent elsewhere.
      eligibleCredentials: {
        type: "array",
        description: "HOLDER VIEW ONLY. The caller's own unrevoked, accepted credentials whose type this request asks for.",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            id: { type: "string" },
            type: { type: "string" },
            issuerDid: { type: "string" },
            issuerName: { type: "string", nullable: true },
            issuedAt: { type: "string" },
            expiresAt: { type: "string", nullable: true },
            claims: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    required: ["id", "verifierOrgId", "holderDid", "requestedTypes", "purpose", "status", "createdAt", "expiresAt"],
  },
```

In `apps/api/src/http/schemas/identity.ts`, extend `createVerificationRequest`'s body:
```ts
    body: {
      type: "object", additionalProperties: false, required: ["holderDid", "requestedTypes", "purpose"],
      properties: {
        holderDid: { type: "string", minLength: 1 },
        requestedTypes: { type: "array", items: { type: "string" }, minItems: 1 },
        purpose: { type: "string", minLength: 1 },
        credentialUseCaseKey: { type: "string" },
        requestedFields: { type: "object", additionalProperties: true },
      },
    },
```

Extend `consentVerificationRequest`'s body:
```ts
    body: {
      type: "object", additionalProperties: false, required: ["credentialIds"],
      properties: {
        credentialIds: { type: "array", items: { type: "string" }, minItems: 1 },
        disclosures: { type: "object", additionalProperties: true },
      },
    },
```

- [ ] **Step 2: Wire `requestedFields` into `POST /verification-requests`**

In `apps/api/src/http/routes/identity.ts`, add imports at the top of the file:
```ts
import { validateRequestedFields, type FieldRequest } from "../../identity/selective-disclosure.js";
import { CREDENTIAL_TYPES } from "@tokenlayer/core";
```

Change the body-destructuring line:
```ts
    const b = request.body as { holderDid: string; requestedTypes: string[]; purpose: string; credentialUseCaseKey?: string };
```
to:
```ts
    const b = request.body as { holderDid: string; requestedTypes: string[]; purpose: string; credentialUseCaseKey?: string; requestedFields?: Record<string, Record<string, FieldRequest>> };
```

In the `Verifier`-desk branch, right after `const def = await deps.credentialUseCases.get(key); if (!def) return notFound(...)`, before the `names`/`requestedTypes` check, insert schema resolution and validation, then pass `requestedFields` into `create`:
```ts
      const names = new Set(def.credentialTypes.map((t) => t.name));
      if (!b.requestedTypes.every((t) => names.has(t))) {
        return reply.code(400).send({ error: "TYPES_NOT_IN_USECASE", message: "a requested type is not part of this use case" });
      }
      const schemasByType = new Map<string, { properties: Record<string, { type: string }> }>(def.credentialTypes.map((t) => [t.name, t.claimSchema]));
      const fieldErr = validateRequestedFields(b.requestedFields, schemasByType);
      if (fieldErr) return reply.code(400).send(fieldErr);
      const rec = await deps.verificationRequests.create({
        verifierOrgId: "", holderDid: b.holderDid, requestedTypes: b.requestedTypes, purpose: b.purpose,
        credentialUseCaseKey: key,
        challenge: randomUUID(), status: "pending", presentationVpJwt: null, consentedAt: null,
        consentedCredentialIds: null, requestedFields: b.requestedFields ?? null, consentedDisclosures: null,
        verifierResult: null, verifiedAt: null,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
```

In the `OrgAdmin` branch, the use-case-aware sub-branch already loads `def`; right after its existing `names`/`requestedTypes` check, add the same validation. The legacy (no use case) sub-branch has no `def` — build `schemasByType` from the built-in catalog instead. Change:
```ts
    if (b.credentialUseCaseKey) {
      // Use-case-aware: gate by the Verifier binding (replaces the org-type gate)
      // and require every requested type to belong to the use case.
      const def = await deps.credentialUseCases.get(b.credentialUseCaseKey);
      if (!def) return notFound(reply, `credential use case '${b.credentialUseCaseKey}' not found`);
      if (!verifierBindingAllows(def.verifier, org.id)) {
        return reply.code(403).send({ error: "VERIFIER_NOT_PERMITTED", message: "your organization may not verify this use case" });
      }
      const names = new Set(def.credentialTypes.map((t) => t.name));
      if (!b.requestedTypes.every((t) => names.has(t))) {
        return reply.code(400).send({ error: "TYPES_NOT_IN_USECASE", message: "a requested type is not part of this use case" });
      }
    } else if (org.orgType !== "verifier") {
      // Legacy generic flow: still requires a verifier org-type.
      return reply.code(403).send({ error: "NOT_A_VERIFIER", message: "your organization is not a verifier" });
    }
```
to:
```ts
    let requestSchemasByType: Map<string, { properties: Record<string, { type: string }> }>;
    if (b.credentialUseCaseKey) {
      // Use-case-aware: gate by the Verifier binding (replaces the org-type gate)
      // and require every requested type to belong to the use case.
      const def = await deps.credentialUseCases.get(b.credentialUseCaseKey);
      if (!def) return notFound(reply, `credential use case '${b.credentialUseCaseKey}' not found`);
      if (!verifierBindingAllows(def.verifier, org.id)) {
        return reply.code(403).send({ error: "VERIFIER_NOT_PERMITTED", message: "your organization may not verify this use case" });
      }
      const names = new Set(def.credentialTypes.map((t) => t.name));
      if (!b.requestedTypes.every((t) => names.has(t))) {
        return reply.code(400).send({ error: "TYPES_NOT_IN_USECASE", message: "a requested type is not part of this use case" });
      }
      requestSchemasByType = new Map<string, { properties: Record<string, { type: string }> }>(def.credentialTypes.map((t) => [t.name, t.claimSchema]));
    } else if (org.orgType !== "verifier") {
      // Legacy generic flow: still requires a verifier org-type.
      return reply.code(403).send({ error: "NOT_A_VERIFIER", message: "your organization is not a verifier" });
    } else {
      requestSchemasByType = new Map<string, { properties: Record<string, { type: string }> }>(Object.values(CREDENTIAL_TYPES).map((t) => [t.type, t.claimSchema]));
    }
    const orgFieldErr = validateRequestedFields(b.requestedFields, requestSchemasByType);
    if (orgFieldErr) return reply.code(400).send(orgFieldErr);
```

And update the `OrgAdmin` branch's `create` call:
```ts
    const rec = await deps.verificationRequests.create({
      verifierOrgId: org.id, holderDid: b.holderDid, requestedTypes: b.requestedTypes, purpose: b.purpose,
      credentialUseCaseKey: b.credentialUseCaseKey ?? null,
      challenge: randomUUID(), status: "pending", presentationVpJwt: null, consentedAt: null,
      consentedCredentialIds: null, requestedFields: b.requestedFields ?? null, consentedDisclosures: null,
      verifierResult: null, verifiedAt: null,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
```

(`CREDENTIAL_TYPES` is already re-exported from `@tokenlayer/core`'s package index — `packages/core/src/index.ts:10` has `export * from "./identity/credential-types.js";` — so the import above needs no further setup.)

- [ ] **Step 3: Wire `disclosures` into `POST /verification-requests/:id/consent`**

Add to the same import block:
```ts
import { resolveDisclosures } from "../../identity/selective-disclosure.js";
```

Change:
```ts
    const { credentialIds } = request.body as { credentialIds: string[] };
```
to:
```ts
    const { credentialIds, disclosures } = request.body as { credentialIds: string[]; disclosures?: Record<string, Record<string, DisclosureChoice>> };
```
(add `DisclosureChoice` to the same type-only import as `FieldRequest`).

After the existing eligibility loop (`for (let i = 0; i < credentialIds.length; i++) { ... }`) and before the custodial-key lookup, insert:
```ts
    const claimsByCredentialId = new Map<string, Record<string, unknown>>(chosen.map((c, i) => [credentialIds[i]!, c!.subjectClaims]));
    const disclosureResult = resolveDisclosures(disclosures, claimsByCredentialId);
    if (!disclosureResult.ok) return reply.code(400).send({ error: disclosureResult.error, message: disclosureResult.message });
```

Change the `setConsented` call:
```ts
    const updated = await deps.verificationRequests.setConsented(r.id, { vpJwt, credentialIds, at: new Date().toISOString() });
```
to:
```ts
    const updated = await deps.verificationRequests.setConsented(r.id, { vpJwt, credentialIds, at: new Date().toISOString(), disclosures: disclosureResult.resolved });
```

- [ ] **Step 4: Redact claims in `GET /verification-requests/:id/verify`**

Add to the imports:
```ts
import { redactClaims } from "../../identity/selective-disclosure.js";
```

Change:
```ts
      return {
        id: jti, type, issuer: issuerDid, claims: c.credential?.claims ?? null,
        reason: c.reason ?? null, checks, valid: c.valid && notRevoked,
```
to:
```ts
      const resolvedForThisCredential = jti ? r.consentedDisclosures?.[jti] : undefined;
      return {
        id: jti, type, issuer: issuerDid, claims: redactClaims(c.credential?.claims ?? null, resolvedForThisCredential),
        reason: c.reason ?? null, checks, valid: c.valid && notRevoked,
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Write the integration test**

```ts
// apps/api/test/selective-disclosure.test.ts
/**
 * End-to-end selective disclosure: a verifier requests a predicate on a
 * numeric claim, the holder discloses less than asked, a withheld field never
 * appears, and old-shape (no disclosures) consent still discloses in full.
 *
 * Modeled on credential-usecase-verify.test.ts's full-runtime fixture — a
 * custom use case is needed because none of the built-in CREDENTIAL_TYPES has
 * a numeric claim field.
 */
import { describe, expect, it } from "vitest";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

const DEF = {
  key: "sd-domicile", name: "Selective Disclosure Domicile",
  credentialTypes: [{
    name: "DomicileCredential", title: "Domicile", validityDays: 365, requiredApprovals: 1,
    claimSchema: {
      type: "object", required: ["holderName", "continuousResidenceSinceYear"],
      properties: { holderName: { type: "string" }, continuousResidenceSinceYear: { type: "number" } },
    },
  }],
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
};

async function setup() {
  const anchor = new FakeAnchor();
  const app = await buildTestApp({ registry: fakeRegistry(anchor) });
  const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
  expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF })).statusCode).toBe(201);

  const holderOrg = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `SD Holder Co ${Date.now()}`, orgType: "corporate" } })).json();
  const holderEmail = `sd.holder.${Date.now()}@x.io`;
  const holderMk = await app.inject({ method: "POST", url: `${V1}/orgs/${holderOrg.id}/users`, headers: auth(admin), payload: { email: holderEmail, password: "secret1", role: "Issuer" } });
  expect(holderMk.statusCode).toBe(201);
  const holder = holderMk.json() as { id: string; did: string };
  const holderToken = await loginAs(app, holderEmail, "secret1");

  const issued = await app.inject({
    method: "POST", url: `${V1}/credential-use-cases/sd-domicile/credentials`, headers: auth(admin),
    payload: { credentialType: "DomicileCredential", subjectUserId: holder.id, claims: { holderName: "Ramesh Kumar", continuousResidenceSinceYear: 2010 } },
  });
  expect(issued.statusCode).toBe(202);
  expect((await app.inject({ method: "POST", url: `${V1}/proposals/${issued.json().proposal.id}/approve`, headers: auth(admin2), payload: {} })).statusCode).toBe(200);
  const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holderToken) });
  const credentialId = (held.json() as { id: string; type: string[] }[]).find((c) => c.type.includes("DomicileCredential"))!.id;

  const verifierOrg = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `SD Verifier Co ${Date.now()}`, orgType: "corporate" } })).json();
  const verifierEmail = `sd.verifier.${Date.now()}@x.io`;
  const vMk = await app.inject({ method: "POST", url: `${V1}/orgs/${verifierOrg.id}/users`, headers: auth(admin), payload: { email: verifierEmail, password: "secret1", role: "OrgAdmin" } });
  expect(vMk.statusCode).toBe(201);
  const verifierToken = await loginAs(app, verifierEmail, "secret1");

  return { app, holder, holderToken, verifierToken, credentialId };
}

function createRequest(app: Awaited<ReturnType<typeof buildTestApp>>, token: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(token), payload: { holderDid: undefined, requestedTypes: ["DomicileCredential"], purpose: "check", credentialUseCaseKey: "sd-domicile", ...body } });
}
function consent(app: Awaited<ReturnType<typeof buildTestApp>>, token: string, id: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `${V1}/verification-requests/${id}/consent`, headers: auth(token), payload: body });
}
function verify(app: Awaited<ReturnType<typeof buildTestApp>>, token: string, id: string) {
  return app.inject({ method: "GET", url: `${V1}/verification-requests/${id}/verify`, headers: auth(token) });
}

describe("selective disclosure", () => {
  it("requesting a predicate on a non-numeric field is refused at create time", async () => {
    const { app, holder, verifierToken } = await setup();
    const res = await createRequest(app, verifierToken, {
      holderDid: holder.did,
      requestedFields: { DomicileCredential: { holderName: { kind: "predicate", op: "eq", threshold: 1 } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_PREDICATE_FIELD");
  });

  it("requesting an unknown field is refused at create time", async () => {
    const { app, holder, verifierToken } = await setup();
    const res = await createRequest(app, verifierToken, {
      holderDid: holder.did,
      requestedFields: { DomicileCredential: { notAField: { kind: "value" } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNKNOWN_FIELD");
  });

  it("disclosing a predicate on a non-numeric field is refused at consent time", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, { holderDid: holder.did });
    const requestId = created.json().id as string;
    const res = await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { holderName: { kind: "predicate", op: "eq", threshold: 1 } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_PREDICATE_FIELD");
  });

  it("disclosing an unknown field is refused at consent time", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, { holderDid: holder.did });
    const requestId = created.json().id as string;
    const res = await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { notAField: { kind: "value" } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNKNOWN_FIELD");
  });

  it("a predicate consent evaluates correctly and /verify never returns the raw value", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, {
      holderDid: holder.did,
      requestedFields: { DomicileCredential: { continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 } } },
    });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().id as string;
    expect(created.json().requestedFields).toEqual({ DomicileCredential: { continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 } } });

    const consented = await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 } } },
    });
    expect(consented.statusCode).toBe(200);

    const result = (await verify(app, verifierToken, requestId)).json();
    const claims = result.credentials[0].claims;
    expect(claims).toEqual({ continuousResidenceSinceYear: { predicate: { op: "lte", threshold: 2011, result: true } } });
    expect(JSON.stringify(claims)).not.toContain("2010");
  });

  it("a withheld field is absent from /verify's response", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, { holderDid: holder.did });
    const requestId = created.json().id as string;
    await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { holderName: { kind: "value" }, continuousResidenceSinceYear: { kind: "withhold" } } },
    });
    const result = (await verify(app, verifierToken, requestId)).json();
    expect(result.credentials[0].claims).toEqual({ holderName: "Ramesh Kumar" });
  });

  it("the holder can disclose fewer fields than requested — consent is never blocked", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, {
      holderDid: holder.did,
      requestedFields: { DomicileCredential: { holderName: { kind: "value" }, continuousResidenceSinceYear: { kind: "value" } } },
    });
    const requestId = created.json().id as string;
    const consented = await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { holderName: { kind: "value" } } }, // continuousResidenceSinceYear left off entirely
    });
    expect(consented.statusCode).toBe(200);
    const result = (await verify(app, verifierToken, requestId)).json();
    expect(result.credentials[0].claims).toEqual({ holderName: "Ramesh Kumar" });
  });

  it("a holder-volunteered predicate on a field not requested as one is honored", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    // Verifier asks for the raw value...
    const created = await createRequest(app, verifierToken, {
      holderDid: holder.did,
      requestedFields: { DomicileCredential: { continuousResidenceSinceYear: { kind: "value" } } },
    });
    const requestId = created.json().id as string;
    // ...but the holder chooses to disclose a predicate instead, with their own threshold.
    const consented = await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { continuousResidenceSinceYear: { kind: "predicate", op: "gte", threshold: 2000 } } },
    });
    expect(consented.statusCode).toBe(200);
    const result = (await verify(app, verifierToken, requestId)).json();
    expect(result.credentials[0].claims).toEqual({ continuousResidenceSinceYear: { predicate: { op: "gte", threshold: 2000, result: true } } });
  });

  it("old-shape consent (no disclosures) still discloses every field in full", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, { holderDid: holder.did });
    const requestId = created.json().id as string;
    const consented = await consent(app, holderToken, requestId, { credentialIds: [credentialId] }); // no `disclosures` key at all
    expect(consented.statusCode).toBe(200);
    const result = (await verify(app, verifierToken, requestId)).json();
    expect(result.credentials[0].claims).toEqual({ holderName: "Ramesh Kumar", continuousResidenceSinceYear: 2010 });
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `cd apps/api && npx vitest run test/selective-disclosure.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 8: Run the full API suite to check for regressions**

Run: `cd apps/api && npx vitest run --testTimeout=45000`
Expected: PASS — every pre-existing test still passes (in particular `verification.test.ts` and `credential-usecase-verify.test.ts`, which exercise the same routes with no `disclosures`/`requestedFields` at all and must behave exactly as before).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/http apps/api/test/selective-disclosure.test.ts
git commit -m "feat(identity): selective disclosure at the API layer — request, consent, verify"
```

---

### Task 5: Web types + api.ts client

**Files:**
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- Consumes: the API shapes from Task 4 (`requestedFields` on `VerificationRequest`, `claims` on `eligibleCredentials`, `disclosures` accepted by consent).
- Produces: `PredicateOp`, `FieldRequest`, `DisclosureChoice` (web-side mirrors — this package doesn't depend on `apps/api`, so these are restated, matching the existing convention documented at the top of `apps/web/src/personas.ts` for exactly this kind of cross-package mirroring); `api.createVerificationRequest`'s and `api.consentVerification`'s new parameters — Tasks 6–7 call these directly.

- [ ] **Step 1: Add the mirrored types and extend `VerificationRequest`**

In `apps/web/src/types.ts`, near the `VerificationRequest` interface, add:
```ts
export type PredicateOp = "gte" | "lte" | "gt" | "lt" | "eq";
export type FieldRequest = { kind: "value" } | { kind: "predicate"; op: PredicateOp; threshold: number };
export type DisclosureChoice = { kind: "value" } | { kind: "predicate"; op: PredicateOp; threshold: number } | { kind: "withhold" };
```

Change:
```ts
export interface VerificationRequest {
  id: string;
  verifierOrgId: string;
  holderDid: string;
  requestedTypes: string[];
  purpose: string;
  credentialUseCaseKey?: string | null;
  status: "pending" | "consented" | "rejected" | "expired";
  consentedCredentialIds: string[] | null;
  consentedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  expiresAt: string;
  eligibleCredentials?: { id: string; type: string; issuerDid: string; issuerName?: string | null; issuedAt: string; expiresAt: string | null }[];
}
```
to:
```ts
export interface VerificationRequest {
  id: string;
  verifierOrgId: string;
  holderDid: string;
  requestedTypes: string[];
  purpose: string;
  credentialUseCaseKey?: string | null;
  status: "pending" | "consented" | "rejected" | "expired";
  consentedCredentialIds: string[] | null;
  requestedFields?: Record<string, Record<string, FieldRequest>> | null;
  consentedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  expiresAt: string;
  eligibleCredentials?: { id: string; type: string; issuerDid: string; issuerName?: string | null; issuedAt: string; expiresAt: string | null; claims: Record<string, unknown> }[];
}
```

- [ ] **Step 2: Extend the client methods**

In `apps/web/src/api.ts`, change:
```ts
  createVerificationRequest: (token: string, body: { holderDid: string; requestedTypes: string[]; purpose: string; credentialUseCaseKey?: string }) =>
    request<VerificationRequest>("/verification-requests", token, { method: "POST", body: JSON.stringify(body) }),
```
to:
```ts
  createVerificationRequest: (token: string, body: { holderDid: string; requestedTypes: string[]; purpose: string; credentialUseCaseKey?: string; requestedFields?: Record<string, Record<string, FieldRequest>> }) =>
    request<VerificationRequest>("/verification-requests", token, { method: "POST", body: JSON.stringify(body) }),
```

Change:
```ts
  consentVerification: (token: string, id: string, credentialIds: string[]) =>
    request<VerificationRequest>(`/verification-requests/${encodeURIComponent(id)}/consent`, token, { method: "POST", body: JSON.stringify({ credentialIds }) }),
```
to:
```ts
  consentVerification: (token: string, id: string, credentialIds: string[], disclosures?: Record<string, Record<string, DisclosureChoice>>) =>
    request<VerificationRequest>(`/verification-requests/${encodeURIComponent(id)}/consent`, token, { method: "POST", body: JSON.stringify(disclosures ? { credentialIds, disclosures } : { credentialIds }) }),
```

Add `FieldRequest, DisclosureChoice` to `api.ts`'s existing `import type { ... } from "./types.js"` line.

- [ ] **Step 3: Typecheck the web package**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no new errors from these two files (existing callers of `consentVerification` with 3 args still compile — the 4th parameter is optional).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts
git commit -m "feat(identity): selective-disclosure types and client methods"
```

---

### Task 6: Verifier UI — request specific fields

**Files:**
- Modify: `apps/web/src/components/identity/VerificationRequests.tsx`

**Interfaces:**
- Consumes: `api.createVerificationRequest`'s `requestedFields` param (Task 5); `CredentialUseCase.credentialTypes[].claimSchema` and `CredentialTypeInfo.claimSchema` (both already exist, carrying `properties: Record<string, { type: string; ... }>`).
- Produces: nothing further downstream — this is a leaf UI change.

- [ ] **Step 1: Add per-type field state and a claim-schema lookup**

Add `FieldRequest, PredicateOp` to the existing `import type { ... } from "../../types.js"` line.

After the existing `const [picked, setPicked] = useState<Record<string, boolean>>({});` line, add:
```ts
  const [fieldRequests, setFieldRequests] = useState<Record<string, Record<string, FieldRequest>>>({});
```

After the existing `const typeNames = selectedUseCase ? ... : types.map((t) => t.type);` line, add a lookup from type name to its claim-schema properties (covers both the use-case-scoped and generic-catalog sources):
```ts
  const propertiesOf = (typeName: string): Record<string, { type: string }> => {
    const fromUseCase = selectedUseCase?.credentialTypes.find((t) => t.name === typeName)?.claimSchema.properties;
    if (fromUseCase) return fromUseCase;
    return types.find((t) => t.type === typeName)?.claimSchema.properties ?? {};
  };
```

- [ ] **Step 2: Build `requestedFields` on submit**

Change:
```ts
      const r = await api.createVerificationRequest(token, {
        holderDid: holderDid.trim(), requestedTypes, purpose: purpose.trim(),
        ...(selectedKey ? { credentialUseCaseKey: selectedKey } : {}),
      });
```
to:
```ts
      const requestedFieldsForSubmit: Record<string, Record<string, FieldRequest>> = {};
      for (const t of requestedTypes) {
        const fields = fieldRequests[t];
        if (fields && Object.keys(fields).length > 0) requestedFieldsForSubmit[t] = fields;
      }
      const r = await api.createVerificationRequest(token, {
        holderDid: holderDid.trim(), requestedTypes, purpose: purpose.trim(),
        ...(selectedKey ? { credentialUseCaseKey: selectedKey } : {}),
        ...(Object.keys(requestedFieldsForSubmit).length > 0 ? { requestedFields: requestedFieldsForSubmit } : {}),
      });
```

Also reset `fieldRequests` alongside `picked` wherever the form clears — after a successful submit, add `setFieldRequests({});` next to wherever `setPicked({})` is called for the use-case selector's `onChange` (`{ setSelectedKey(e.target.value); setPicked({}); }` → `{ setSelectedKey(e.target.value); setPicked({}); setFieldRequests({}); }`).

- [ ] **Step 3: Add the per-field UI beneath each checked type**

Change:
```ts
        <div className="flex flex-wrap gap-3 mb-2">
          {typeNames.map((t) => (
            <label key={t} className="text-sm flex items-center gap-1">
              <input type="checkbox" checked={!!picked[t]} onChange={(e) => setPicked({ ...picked, [t]: e.target.checked })} /> {t}
            </label>
          ))}
        </div>
```
to:
```ts
        <div className="space-y-2 mb-2">
          {typeNames.map((t) => {
            const props = propertiesOf(t);
            const fields = fieldRequests[t] ?? {};
            const setField = (field: string, fr: FieldRequest | null): void => {
              const next = { ...fields };
              if (fr) next[field] = fr; else delete next[field];
              setFieldRequests({ ...fieldRequests, [t]: next });
            };
            return (
              <div key={t}>
                <label className="text-sm flex items-center gap-1">
                  <input type="checkbox" checked={!!picked[t]} onChange={(e) => setPicked({ ...picked, [t]: e.target.checked })} /> {t}
                </label>
                {picked[t] && Object.keys(props).length > 0 && (
                  <div className="ml-5 mt-1 space-y-1 border-l border-slate-100 pl-3">
                    <div className="text-[11px] uppercase tracking-wide text-slate-400">Request specific fields (optional)</div>
                    {Object.entries(props).map(([field, prop]) => {
                      const fr = fields[field];
                      return (
                        <div key={field} className="flex items-center gap-2 text-xs">
                          <label className="flex items-center gap-1">
                            <input type="checkbox" checked={!!fr} onChange={(e) => setField(field, e.target.checked ? { kind: "value" } : null)} />
                            {field}
                          </label>
                          {fr && prop.type === "number" && (
                            <>
                              <select
                                className="rounded border border-slate-200 px-1 py-0.5"
                                value={fr.kind === "predicate" ? "predicate" : "value"}
                                onChange={(e) => setField(field, e.target.value === "predicate" ? { kind: "predicate", op: "lte", threshold: 0 } : { kind: "value" })}
                              >
                                <option value="value">as a value</option>
                                <option value="predicate">as a threshold check</option>
                              </select>
                              {fr.kind === "predicate" && (
                                <>
                                  <select
                                    className="rounded border border-slate-200 px-1 py-0.5"
                                    value={fr.op}
                                    onChange={(e) => setField(field, { kind: "predicate", op: e.target.value as PredicateOp, threshold: fr.threshold })}
                                  >
                                    <option value="lte">≤</option>
                                    <option value="gte">≥</option>
                                    <option value="lt">&lt;</option>
                                    <option value="gt">&gt;</option>
                                    <option value="eq">=</option>
                                  </select>
                                  <input
                                    type="number" className="w-20 rounded border border-slate-200 px-1 py-0.5"
                                    value={fr.threshold}
                                    onChange={(e) => setField(field, { kind: "predicate", op: fr.op, threshold: Number(e.target.value) })}
                                  />
                                </>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
```

- [ ] **Step 4: Render predicate results in the verify result panel**

Change:
```ts
                  {c.claims && <div className="text-xs text-slate-500 mt-2">{Object.entries(c.claims).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</div>}
```
to:
```ts
                  {c.claims && (
                    <div className="text-xs text-slate-500 mt-2">
                      {Object.entries(c.claims).map(([k, v]) => {
                        const isPredicate = v && typeof v === "object" && "predicate" in v;
                        if (isPredicate) {
                          const p = (v as { predicate: { op: string; threshold: number; result: boolean } }).predicate;
                          const opSymbol = { gte: "≥", lte: "≤", gt: ">", lt: "<", eq: "=" }[p.op] ?? p.op;
                          return `${k}: ${opSymbol} ${p.threshold} ${p.result ? "✓" : "✗"}`;
                        }
                        return `${k}: ${String(v)}`;
                      }).join(" · ")}
                    </div>
                  )}
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/identity/VerificationRequests.tsx
git commit -m "feat(identity): verifier can request specific fields or threshold predicates"
```

---

### Task 7: Holder UI — per-field disclosure controls

**Files:**
- Modify: `apps/web/src/components/identity/VerificationInbox.tsx`

**Interfaces:**
- Consumes: `api.consentVerification`'s `disclosures` param (Task 5); `eligibleCredentials[].claims` (Task 3/4); `VerificationRequest.requestedFields` (Task 2/3).
- Produces: nothing further downstream — this is a leaf UI change and the final task.

- [ ] **Step 1: Add per-credential-per-field disclosure state**

Add `DisclosureChoice, PredicateOp` to the existing `import type { VerificationRequest } from "../../types.js";` line (becomes `import type { DisclosureChoice, PredicateOp, VerificationRequest } from "../../types.js";`).

After the existing `const [picked, setPicked] = useState<Record<string, Record<string, boolean>>>({});` line, add:
```ts
  // Keyed by request id → credential id → field → choice. Populated with a
  // sensible default the first time a credential is checked (see toggleCredential).
  const [disclosures, setDisclosures] = useState<Record<string, Record<string, Record<string, DisclosureChoice>>>>({});
```

- [ ] **Step 2: Default the disclosure choices when a credential is checked**

Change:
```ts
                : (r.eligibleCredentials ?? []).map((c) => (
                    <label key={c.id} className="text-sm flex items-center gap-1.5">
                      <input type="checkbox" checked={!!sel[c.id]} onChange={(e) => setPicked({ ...picked, [r.id]: { ...sel, [c.id]: e.target.checked } })} />
                      <span>{candidateLabel(c)}</span>
                    </label>
                  ))}
```
to:
```ts
                : (r.eligibleCredentials ?? []).map((c) => {
                    const requestedForType = r.requestedFields?.[c.type] ?? {};
                    const credDisclosures = disclosures[r.id]?.[c.id] ?? {};
                    const toggleCredential = (checked: boolean): void => {
                      setPicked({ ...picked, [r.id]: { ...sel, [c.id]: checked } });
                      if (checked && !disclosures[r.id]?.[c.id]) {
                        // Default: a requested field matches the request (value or
                        // predicate, as asked); everything else starts withheld —
                        // least-disclosure by default.
                        const initial: Record<string, DisclosureChoice> = {};
                        for (const field of Object.keys(c.claims)) {
                          const req = requestedForType[field];
                          initial[field] = req ? (req.kind === "predicate" ? { kind: "predicate", op: req.op, threshold: req.threshold } : { kind: "value" }) : { kind: "withhold" };
                        }
                        setDisclosures({ ...disclosures, [r.id]: { ...disclosures[r.id], [c.id]: initial } });
                      }
                    };
                    const setFieldChoice = (field: string, choice: DisclosureChoice): void => {
                      setDisclosures({ ...disclosures, [r.id]: { ...disclosures[r.id], [c.id]: { ...credDisclosures, [field]: choice } } });
                    };
                    return (
                      <div key={c.id} className="mb-1.5">
                        <label className="text-sm flex items-center gap-1.5">
                          <input type="checkbox" checked={!!sel[c.id]} onChange={(e) => toggleCredential(e.target.checked)} />
                          <span>{candidateLabel(c)}</span>
                        </label>
                        {sel[c.id] && (
                          <div className="ml-5 mt-1 space-y-1 border-l border-slate-100 pl-3">
                            {Object.entries(c.claims).map(([field, value]) => {
                              const choice = credDisclosures[field] ?? { kind: "withhold" as const };
                              const isNumber = typeof value === "number";
                              const requested = requestedForType[field];
                              return (
                                <div key={field} className="flex items-center gap-2 text-xs">
                                  <span className="w-40 truncate">
                                    {field}
                                    {requested && <span className="text-brand-500"> · requested{requested.kind === "predicate" ? ` (${requested.op} ${requested.threshold})` : ""}</span>}
                                  </span>
                                  <select
                                    className="rounded border border-slate-200 px-1 py-0.5"
                                    value={choice.kind}
                                    onChange={(e) => {
                                      const kind = e.target.value as DisclosureChoice["kind"];
                                      if (kind === "value") setFieldChoice(field, { kind: "value" });
                                      else if (kind === "withhold") setFieldChoice(field, { kind: "withhold" });
                                      else setFieldChoice(field, { kind: "predicate", op: requested?.kind === "predicate" ? requested.op : "lte", threshold: requested?.kind === "predicate" ? requested.threshold : 0 });
                                    }}
                                  >
                                    <option value="withhold">Withhold</option>
                                    <option value="value">Share value</option>
                                    {isNumber && <option value="predicate">Share as threshold check</option>}
                                  </select>
                                  {choice.kind === "predicate" && (
                                    <>
                                      <select
                                        className="rounded border border-slate-200 px-1 py-0.5"
                                        value={choice.op}
                                        onChange={(e) => setFieldChoice(field, { kind: "predicate", op: e.target.value as PredicateOp, threshold: choice.threshold })}
                                      >
                                        <option value="lte">≤</option>
                                        <option value="gte">≥</option>
                                        <option value="lt">&lt;</option>
                                        <option value="gt">&gt;</option>
                                        <option value="eq">=</option>
                                      </select>
                                      <input
                                        type="number" className="w-20 rounded border border-slate-200 px-1 py-0.5"
                                        value={choice.threshold}
                                        onChange={(e) => setFieldChoice(field, { kind: "predicate", op: choice.op, threshold: Number(e.target.value) })}
                                      />
                                    </>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
```

- [ ] **Step 3: Send `disclosures` on consent**

Change:
```ts
    try { await api.consentVerification(token, r.id, ids); setMsg("Consented — the presentation was signed and released."); reload(); }
    catch (e) { setErr(errMessage(e, "Consent failed")); }
```
to:
```ts
    const disclosuresForConsent: Record<string, Record<string, DisclosureChoice>> = {};
    for (const cid of ids) {
      const fields = disclosures[r.id]?.[cid] ?? {};
      if (Object.keys(fields).length > 0) disclosuresForConsent[cid] = fields;
    }
    try {
      await api.consentVerification(token, r.id, ids, Object.keys(disclosuresForConsent).length > 0 ? disclosuresForConsent : undefined);
      setMsg("Consented — the presentation was signed and released.");
      reload();
    } catch (e) { setErr(errMessage(e, "Consent failed")); }
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the full web test suite**

Run: `cd apps/web && npx vitest run --testTimeout=45000`
Expected: PASS — same baseline as before this feature (the pre-existing, unrelated `/reconciliation` failure in `try-it-safety.test.ts` is the only expected failure, if present).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/identity/VerificationInbox.tsx
git commit -m "feat(identity): holder chooses per-field disclosure — value, threshold check, or withhold"
```

---

## Final verification (orchestrator, not a subagent task)

After all 7 tasks are reviewed and merged:
1. Run the full API suite (`cd apps/api && npx vitest run --testTimeout=45000`) and the full web suite (`cd apps/web && npx vitest run --testTimeout=45000`) one more time together.
2. Run `pnpm -r run typecheck` from the repo root.
3. Rebuild the identity stack's images (`tokenization-api`... no — this feature is identity-domain only: rebuild `identity-api`, `identity-issuer-web`, `identity-verifier-web`, `identity-holder-web`) and restart via `bash scripts/stack-up.sh identity --besu` (or `identity tokenization --besu` if linked mode is currently up) — this is what actually exercises the Prisma repository path, never touched by `vitest`.
4. Live browser walkthrough on the running stack: as a verifier, request a numeric field as both a plain value and a threshold predicate on a real use case (e.g. `domicile-certificate-pune-district-collectorate`'s `continuousResidenceSinceYear`); as the holder, disclose one field as a predicate and withhold another entirely; as the verifier, run verification and confirm the result shows the predicate outcome (not the raw year) and the withheld field is simply absent.
