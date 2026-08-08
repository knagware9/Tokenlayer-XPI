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
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** A grant is an exact scope, a `resource:*` wildcard, or the global `*`. */
export type ApiScopeGrant = ApiScope | "*" | `${string}:*`;

export function scopeAllows(granted: readonly string[] | null, required: ApiScope): boolean {
  if (granted === null) return true;
  if (granted.includes("*")) return true;
  if (granted.includes(required)) return true;
  const resource = required.slice(0, required.indexOf(":"));
  return granted.includes(`${resource}:*`);
}

export function validateScopes(input: unknown): string[] {
  if (!Array.isArray(input)) throw new PolicyError("INVALID_SCOPES", "scopes must be an array");
  if (input.length === 0) throw new PolicyError("INVALID_SCOPES", "provide at least one scope");
  const resources = new Set(API_SCOPES.map((s) => s.slice(0, s.indexOf(":"))));
  for (const s of input) {
    if (typeof s !== "string") throw new PolicyError("INVALID_SCOPES", "scopes must be strings");
    if (s === "*") continue;
    if (s.endsWith(":*")) {
      if (!resources.has(s.slice(0, -2))) throw new PolicyError("INVALID_SCOPES", `unknown scope resource '${s}'`);
      continue;
    }
    if (!(API_SCOPES as readonly string[]).includes(s)) throw new PolicyError("INVALID_SCOPES", `unknown scope '${s}'`);
  }
  if (new Set(input).size !== input.length) throw new PolicyError("INVALID_SCOPES", "scopes contain duplicates");
  return [...input] as string[];
}
