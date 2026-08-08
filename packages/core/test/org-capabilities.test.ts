import { describe, expect, it } from "vitest";
import { orgDomainEnabled, orgRoleEnabled, validateOrgCapabilities } from "../src/org-capabilities.js";
import { PolicyError } from "../src/errors.js";

describe("org capability predicates", () => {
  it("null = unrestricted legacy envelope (both predicates true)", () => {
    expect(orgDomainEnabled(null, "tokenization")).toBe(true);
    expect(orgDomainEnabled(null, "identity")).toBe(true);
    expect(orgRoleEnabled(null, "Issuer")).toBe(true);
    expect(orgRoleEnabled(null, "Holder")).toBe(true);
    expect(orgRoleEnabled(null, "Verifier")).toBe(true);
  });
  it("explicit envelope gates by membership; [] is fully restrictive (≠ null)", () => {
    const caps = { domains: ["identity" as const], roles: ["Issuer" as const, "Verifier" as const] };
    expect(orgDomainEnabled(caps, "identity")).toBe(true);
    expect(orgDomainEnabled(caps, "tokenization")).toBe(false);
    expect(orgRoleEnabled(caps, "Issuer")).toBe(true);
    expect(orgRoleEnabled(caps, "Holder")).toBe(false);
    const empty = { domains: [], roles: [] };
    expect(orgDomainEnabled(empty, "identity")).toBe(false);
    expect(orgRoleEnabled(empty, "Issuer")).toBe(false);
  });
});

describe("validateOrgCapabilities", () => {
  it("accepts a well-formed envelope (incl. empty arrays)", () => {
    expect(() => validateOrgCapabilities({ domains: ["tokenization", "identity"], roles: ["Issuer"] })).not.toThrow();
    expect(() => validateOrgCapabilities({ domains: [], roles: [] })).not.toThrow();
  });
  it("rejects unknown values, duplicates, and non-arrays", () => {
    expect(() => validateOrgCapabilities({ domains: ["defi"], roles: [] } as never)).toThrow(PolicyError);
    expect(() => validateOrgCapabilities({ domains: ["identity", "identity"], roles: [] } as never)).toThrow(PolicyError);
    expect(() => validateOrgCapabilities({ domains: ["identity"], roles: ["Admin"] } as never)).toThrow(PolicyError);
    expect(() => validateOrgCapabilities({ domains: "identity", roles: [] } as never)).toThrow(PolicyError);
    expect(() => validateOrgCapabilities(null as never)).toThrow(PolicyError);
  });
});
