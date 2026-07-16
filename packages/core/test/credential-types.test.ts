import { describe, expect, it } from "vitest";
import { CREDENTIAL_TYPES, credentialTypeDef, validateMetadata, PolicyError } from "../src/index.js";

describe("credential type registry", () => {
  it("declares the three compliance types", () => {
    expect(Object.keys(CREDENTIAL_TYPES).sort()).toEqual(["AccreditedInvestor", "AuthorizedSignatory", "KycCredential"]);
  });

  it("every type has a usable schema, >=1 approvals, and at least one permitted issuer", () => {
    for (const def of Object.values(CREDENTIAL_TYPES)) {
      expect(def.requiredApprovals).toBeGreaterThanOrEqual(1);
      expect(def.validityDays).toBeGreaterThan(0);
      expect(def.allowedIssuerOrgTypes.length).toBeGreaterThan(0);
      expect(def.claimSchema.type).toBe("object");
      expect(Object.keys(def.claimSchema.properties).length).toBeGreaterThan(0);
    }
  });

  it("AuthorizedSignatory needs two approvals and is self-issued only", () => {
    const def = credentialTypeDef("AuthorizedSignatory");
    expect(def.requiredApprovals).toBe(2);
    expect(def.selfIssuedOnly).toBe(true);
  });

  it("throws a coded PolicyError on an unknown type", () => {
    expect(() => credentialTypeDef("NopeCredential")).toThrow(PolicyError);
    try {
      credentialTypeDef("NopeCredential");
    } catch (e) {
      expect((e as PolicyError).code).toBe("UNKNOWN_CREDENTIAL_TYPE");
    }
  });
});

describe("per-type claim validation (reuses validateMetadata)", () => {
  it("accepts a good KycCredential claim set", () => {
    expect(() => validateMetadata({ legalName: "Priya R", country: "IN" }, credentialTypeDef("KycCredential").claimSchema)).not.toThrow();
  });

  it("rejects a KycCredential missing a required claim", () => {
    expect(() => validateMetadata({ legalName: "Priya R" }, credentialTypeDef("KycCredential").claimSchema)).toThrow();
  });

  it("rejects a bad country code (pattern) and a bad enum", () => {
    expect(() => validateMetadata({ legalName: "X", country: "INDIA" }, credentialTypeDef("KycCredential").claimSchema)).toThrow();
    expect(() => validateMetadata({ basis: "vibes", jurisdiction: "IN" }, credentialTypeDef("AccreditedInvestor").claimSchema)).toThrow();
  });

  it("accepts a good AccreditedInvestor claim set", () => {
    expect(() => validateMetadata({ basis: "net-worth", jurisdiction: "IN" }, credentialTypeDef("AccreditedInvestor").claimSchema)).not.toThrow();
  });
});
