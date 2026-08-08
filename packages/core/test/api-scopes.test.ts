import { describe, expect, it } from "vitest";
import { API_SCOPES, scopeAllows, validateScopes } from "../src/api-scopes.js";
import { PolicyError } from "../src/errors.js";

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
    expect(() => validateScopes([])).toThrow(/at least one/);
  });
});

describe("API_SCOPES", () => {
  it("every scope is resource:action with a known resource", () => {
    for (const s of API_SCOPES) expect(s).toMatch(/^[a-z]+:[a-z]+$/);
  });
});
