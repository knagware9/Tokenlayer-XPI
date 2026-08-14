import { describe, expect, it } from "vitest";
import { API_SCOPES, API_SCOPE_RESOURCES, scopeAllows, validateScopes } from "../src/shared/api-scopes.js";
import { PolicyError } from "../src/shared/errors.js";

describe("scopeAllows", () => {
  it("null granted (a human session) allows everything — scopes are a key-only concept", () => {
    expect(scopeAllows(null, "credentials:issue")).toBe(true);
  });
  it("the wildcard allows everything", () => {
    expect(scopeAllows(["*"], "assets:transfer")).toBe(true);
  });
  it("an exact grant allows only that action", () => {
    expect(scopeAllows(["credentials:issue"], "credentials:issue")).toBe(true);
    expect(scopeAllows(["credentials:issue"], "credentials:revoke")).toBe(false);
  });
  it("a resource wildcard allows every action on that resource only", () => {
    expect(scopeAllows(["verifications:*"], "verifications:verify")).toBe(true);
    expect(scopeAllows(["verifications:*"], "credentials:issue")).toBe(false);
  });
  it("an empty grant list allows nothing", () => {
    expect(scopeAllows([], "credentials:read")).toBe(false);
  });
  it("a colonless required action matches NO wildcard — a scope must never widen", () => {
    // "credentials".slice(0, -1) === "credential", so an unguarded resource
    // split would let a different resource's wildcard cover it.
    expect(scopeAllows(["credential:*"], "credentials" as never)).toBe(false);
    expect(scopeAllows([":*"], "*" as never)).toBe(false);
  });
});

describe("validateScopes", () => {
  it("accepts known scopes, the wildcard, and resource wildcards", () => {
    expect(validateScopes(["*"])).toEqual(["*"]);
    expect(validateScopes(["credentials:issue", "verifications:*"])).toEqual(["credentials:issue", "verifications:*"]);
  });
  it("rejects unknown scopes, duplicates, non-arrays, and an empty list", () => {
    expect(() => validateScopes(["ledger:drop"])).toThrow(/unknown scope/);
    expect(() => validateScopes(["credentials:issue", "credentials:issue"])).toThrow(/duplicate/);
    expect(() => validateScopes("credentials:issue" as never)).toThrow(PolicyError);
    expect(() => validateScopes("credentials:issue" as never)).toThrow(/must be an array/);
    expect(() => validateScopes([])).toThrow(/at least one/);
  });
  it("rejects a wildcard over a forged resource — the stem must be a known resource", () => {
    expect(() => validateScopes(["ledger:*"])).toThrow(/unknown scope resource/);
    expect(() => validateScopes([":*"])).toThrow(/unknown scope resource/);
    expect(() => validateScopes(["*:*"])).toThrow(/unknown scope resource/);
  });
  it("rejects a non-string entry", () => {
    expect(() => validateScopes([123])).toThrow(/must be strings/);
    expect(() => validateScopes([123])).toThrow(PolicyError);
  });
});

describe("API_SCOPES", () => {
  it("every scope is resource:action drawn from the closed resource set the validator uses", () => {
    for (const s of API_SCOPES) expect(s).toMatch(/^[a-z]+:[a-z]+$/);
    // Inventory assertion: extend it when the vocabulary legitimately grows.
    // "usecases" was added for EN-B's `usecases:provision` (configuration
    // authoring — use cases, templates, orgs, the one-step provisioner), which
    // `users:onboard` would have described dishonestly.
    // "webhooks" was added for EN-C's `webhooks:read`/`webhooks:write`
    // (managing an org's own webhook endpoints and reading its event log).
    // "identity" was added for `identity:assert` — the PEER scope a separately
    // deployed Tokenization instance uses to ask Identity whether a subject
    // holds a valid credential. Its own stem rather than `credentials:*`
    // because it is not a credential read: it returns a yes/no and never the
    // credential, and it is granted to a peer platform rather than a tenant.
    expect([...API_SCOPE_RESOURCES].sort()).toEqual(["assets", "credentials", "identity", "org", "usecases", "users", "verifications", "webhooks"]);
  });
});
