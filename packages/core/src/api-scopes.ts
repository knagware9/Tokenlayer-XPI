/**
 * Coarse API-key scopes (EN-B). A scope can only ever NARROW what the key's
 * bound service user could already do — authorization is
 * `roleAllows && envelopeAllows && scopeAllows`, so a scope never widens
 * authority and is safe to hand to an integrator.
 *
 * `granted === null` means "not a key request" (a human JWT session): scopes
 * are a property of keys only, so every check passes.
 */
import { PolicyError } from "./errors.js";

export const API_SCOPES = [
  "credentials:read",
  "credentials:issue",
  "credentials:revoke",
  "verifications:read",
  "verifications:request",
  "verifications:verify",
  "assets:read",
  "assets:issue",
  "assets:transfer",
  "users:read",
  "users:onboard",
  "org:read",
  // EN-C: manage this org's own webhook endpoints and read its event log.
  // Split read/write because an integration that only consumes the cursor API
  // has no business rotating a secret or repointing a delivery URL.
  "webhooks:read",
  "webhooks:write",
  // Authoring/provisioning configuration: use cases, templates, and the
  // one-step provisioner. Distinct from `users:onboard` because provisioning
  // creates an ORG and a USE CASE, not people — conflating them would let a key
  // granted "may onboard users" reshape the deployment's configuration.
  "usecases:provision",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** The resource half of each scope — the only legal `resource:*` stems. */
type ApiScopeResource = ApiScope extends `${infer R}:${string}` ? R : never;

/** The same closed set at runtime, built once: its inputs are module constants. */
export const API_SCOPE_RESOURCES: ReadonlySet<string> = new Set(
  API_SCOPES.map((s) => s.slice(0, s.indexOf(":"))),
);

/**
 * A grant is an exact scope, a `resource:*` wildcard over a KNOWN resource, or
 * the global `*`. The resource arm is derived from `API_SCOPES` rather than
 * written as `${string}:*`, which would swallow the union and admit exactly the
 * forged wildcards (`ledger:*`, `:*`) that `validateScopes` exists to reject.
 */
export type ApiScopeGrant = ApiScope | "*" | `${ApiScopeResource}:*`;

export function scopeAllows(granted: readonly string[] | null, required: ApiScope): boolean {
  if (granted === null) return true;
  if (granted.includes("*")) return true;
  if (granted.includes(required)) return true;
  // A `required` with no colon has no resource, so no wildcard can cover it.
  // Without this guard `indexOf` returns -1 and `slice(0, -1)` would drop the
  // last character, letting a DIFFERENT resource's wildcard match ("credentials"
  // vs "credential:*") — the one path by which a scope could WIDEN authority.
  const i = required.indexOf(":");
  if (i < 0) return false;
  return granted.includes(`${required.slice(0, i)}:*`);
}

export function validateScopes(input: unknown): ApiScopeGrant[] {
  if (!Array.isArray(input)) throw new PolicyError("INVALID_SCOPES", "scopes must be an array");
  if (input.length === 0) throw new PolicyError("INVALID_SCOPES", "provide at least one scope");
  for (const s of input) {
    if (typeof s !== "string") throw new PolicyError("INVALID_SCOPES", "scopes must be strings");
    if (s === "*") continue;
    if (s.endsWith(":*")) {
      if (!API_SCOPE_RESOURCES.has(s.slice(0, -2))) throw new PolicyError("INVALID_SCOPES", `unknown scope resource '${s}'`);
      continue;
    }
    if (!(API_SCOPES as readonly string[]).includes(s)) throw new PolicyError("INVALID_SCOPES", `unknown scope '${s}'`);
  }
  if (new Set(input).size !== input.length) throw new PolicyError("INVALID_SCOPES", "scopes contain duplicates");
  return [...input] as ApiScopeGrant[];
}
