import { describe, it, expect } from "vitest";
import { useCaseDomainOf } from "../src/use-case-domain.js";
import { assignableRoles, canCreateUser } from "../src/user-policy.js";

describe("useCaseDomainOf", () => {
  const known = { tokenizationKeys: ["invoice-tokenization", "carbon-credit"], credentialKeys: ["kyc-credential", "mca-verification"] };

  it("resolves a tokenization key", () => {
    expect(useCaseDomainOf("invoice-tokenization", known)).toBe("tokenization");
    expect(useCaseDomainOf("carbon-credit", known)).toBe("tokenization");
  });

  it("resolves an identity key", () => {
    expect(useCaseDomainOf("kyc-credential", known)).toBe("identity");
    expect(useCaseDomainOf("mca-verification", known)).toBe("identity");
  });

  it("returns undefined for a key that is neither", () => {
    expect(useCaseDomainOf("unknown-key", known)).toBeUndefined();
  });
});

describe("assignableRoles (domain-aware)", () => {
  it("identity domain roster is Issuer/Holder/Verifier", () => {
    expect(assignableRoles("UseCaseAdmin", "identity")).toEqual(["Issuer", "Holder", "Verifier"]);
  });

  it("tokenization domain roster is Issuer/Buyer/Auditor (default when domain omitted)", () => {
    expect(assignableRoles("UseCaseAdmin", "tokenization")).toEqual(["Issuer", "Buyer", "Auditor"]);
    expect(assignableRoles("UseCaseAdmin")).toEqual(["Issuer", "Buyer", "Auditor"]);
  });

  it("PlatformAdmin identity roster includes UseCaseAdmin + the DID/VC roster, never Buyer/Trader", () => {
    const roster = assignableRoles("PlatformAdmin", "identity");
    expect(roster).toContain("UseCaseAdmin");
    expect(roster).toContain("Issuer");
    expect(roster).toContain("Holder");
    expect(roster).toContain("Verifier");
    expect(roster).not.toContain("Buyer");
    expect(roster).not.toContain("Trader");
  });

  it("UseCaseAdmin identity roster is exactly Issuer/Holder/Verifier (no UseCaseAdmin)", () => {
    expect(assignableRoles("UseCaseAdmin", "identity")).toEqual(["Issuer", "Holder", "Verifier"]);
  });
});

describe("canCreateUser (domain-aware)", () => {
  const scopedAdmin = { role: "UseCaseAdmin", useCaseKey: "kyc-credential" } as const;

  it("allows a Holder in an identity use case for a scoped UseCaseAdmin", () => {
    expect(canCreateUser(scopedAdmin, "Holder", "kyc-credential", "identity")).toBe(true);
  });

  it("rejects a Holder in a tokenization use case", () => {
    const tokAdmin = { role: "UseCaseAdmin", useCaseKey: "invoice-tokenization" } as const;
    expect(canCreateUser(tokAdmin, "Holder", "invoice-tokenization", "tokenization")).toBe(false);
    expect(canCreateUser(tokAdmin, "Holder", "invoice-tokenization")).toBe(false);
  });

  it("rejects a Buyer in an identity use case", () => {
    expect(canCreateUser(scopedAdmin, "Buyer", "kyc-credential", "identity")).toBe(false);
  });
});
