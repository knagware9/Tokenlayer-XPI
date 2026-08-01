import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TEMPLATES,
  validateCredentialUseCase,
  credentialUseCaseType, issuerBindingAllows, holderPolicyAllows, verifierBindingAllows,
  type CredentialUseCaseDefinition,
} from "../src/credential-use-cases.js";
import { PolicyError } from "../src/errors.js";

const KNOWN_ORG = "org_1";
const orgExists = (id: string) => id === KNOWN_ORG;

function base(): CredentialUseCaseDefinition {
  return {
    key: "corp-trade-credentials",
    name: "Corporate Trade Credentials",
    description: "Government trade credentials for corporates.",
    credentialTypes: [
      { name: "MCACredential", title: "MCA Company Master", validityDays: 365,
        claimSchema: { type: "object", required: ["cin", "companyName"],
          properties: { cin: { type: "string" }, companyName: { type: "string" } } } },
    ],
    issuer: { kind: "platform" },
    holderPolicy: { who: "any-onboarded" },
    verifier: { kind: "any" },
  };
}

describe("CREDENTIAL_TEMPLATES", () => {
  it("exposes well-formed starter templates including KYC and MCA", () => {
    expect(Object.keys(CREDENTIAL_TEMPLATES)).toEqual(
      expect.arrayContaining(["KycCredential", "MCACredential", "GSTINCredential", "EmploymentCredential", "OrganizationMembership"]),
    );
    for (const t of Object.values(CREDENTIAL_TEMPLATES)) {
      expect(t.name).toBeTruthy();
      expect(t.claimSchema.type).toBe("object");
      expect(t.validityDays).toBeGreaterThan(0);
    }
  });
});

describe("validateCredentialUseCase", () => {
  it("accepts a well-formed definition", () => {
    expect(() => validateCredentialUseCase(base(), { orgExists })).not.toThrow();
  });
  it("rejects an empty key", () => {
    expect(() => validateCredentialUseCase({ ...base(), key: "" }, { orgExists })).toThrow(PolicyError);
  });
  it("rejects zero credential types", () => {
    expect(() => validateCredentialUseCase({ ...base(), credentialTypes: [] }, { orgExists })).toThrow(/at least one/i);
  });
  it("rejects duplicate credential-type names", () => {
    const d = base(); d.credentialTypes = [d.credentialTypes[0], { ...d.credentialTypes[0] }];
    expect(() => validateCredentialUseCase(d, { orgExists })).toThrow(/duplicate/i);
  });
  it("rejects a malformed claim schema", () => {
    const d = base(); (d.credentialTypes[0].claimSchema as { type: string }).type = "array";
    expect(() => validateCredentialUseCase(d, { orgExists })).toThrow(PolicyError);
  });
  it("rejects an issuer org that does not exist", () => {
    expect(() => validateCredentialUseCase({ ...base(), issuer: { kind: "org", orgId: "ghost" } }, { orgExists }))
      .toThrow(/unknown issuer org/i);
  });
  it("rejects a verifier org that does not exist", () => {
    expect(() => validateCredentialUseCase({ ...base(), verifier: { kind: "orgs", orgIds: ["ghost"] } }, { orgExists }))
      .toThrow(/unknown verifier org/i);
  });
  it("accepts an org issuer that exists", () => {
    expect(() => validateCredentialUseCase({ ...base(), issuer: { kind: "org", orgId: KNOWN_ORG } }, { orgExists })).not.toThrow();
  });
});

const baseDef: CredentialUseCaseDefinition = {
  key: "kyc", name: "KYC", credentialTypes: [
    { name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 2,
      claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } },
  ],
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
};

describe("credentialUseCaseType", () => {
  it("resolves a type by name", () => {
    expect(credentialUseCaseType(baseDef, "KycCredential").requiredApprovals).toBe(2);
  });
  it("throws UNKNOWN_CREDENTIAL_TYPE for an absent type", () => {
    expect(() => credentialUseCaseType(baseDef, "Nope")).toThrow(/unknown credential type/i);
  });
  it("defaults a missing requiredApprovals to 1", () => {
    const def = { ...baseDef, credentialTypes: [{ ...baseDef.credentialTypes[0]!, requiredApprovals: undefined as unknown as number }] };
    expect(credentialUseCaseType(def, "KycCredential").requiredApprovals).toBe(1);
  });
});

describe("issuerBindingAllows", () => {
  it("lets a PlatformAdmin act as any bound issuer", () => {
    expect(issuerBindingAllows({ kind: "platform" }, { callerOrgId: null, isPlatformAdmin: true })).toBe(true);
    expect(issuerBindingAllows({ kind: "org", orgId: "o1" }, { callerOrgId: null, isPlatformAdmin: true })).toBe(true);
  });
  it("lets an OrgAdmin issue only for their own org binding", () => {
    expect(issuerBindingAllows({ kind: "org", orgId: "o1" }, { callerOrgId: "o1", isPlatformAdmin: false })).toBe(true);
    expect(issuerBindingAllows({ kind: "org", orgId: "o2" }, { callerOrgId: "o1", isPlatformAdmin: false })).toBe(false);
    expect(issuerBindingAllows({ kind: "platform" }, { callerOrgId: "o1", isPlatformAdmin: false })).toBe(false);
  });
});

describe("holderPolicyAllows", () => {
  it("any-onboarded accepts anyone including a null org", () => {
    expect(holderPolicyAllows({ who: "any-onboarded" }, null)).toBe(true);
    expect(holderPolicyAllows({ who: "any-onboarded" }, { id: "o1", orgType: "corporate" })).toBe(true);
  });
  it("orgType requires a matching org", () => {
    expect(holderPolicyAllows({ who: "orgType", orgTypes: ["corporate"] }, { id: "o1", orgType: "corporate" })).toBe(true);
    expect(holderPolicyAllows({ who: "orgType", orgTypes: ["bank"] }, { id: "o1", orgType: "corporate" })).toBe(false);
    expect(holderPolicyAllows({ who: "orgType", orgTypes: ["corporate"] }, null)).toBe(false);
  });
  it("specific requires the org id to be listed", () => {
    expect(holderPolicyAllows({ who: "specific", orgIds: ["o1"] }, { id: "o1", orgType: "corporate" })).toBe(true);
    expect(holderPolicyAllows({ who: "specific", orgIds: ["o2"] }, { id: "o1", orgType: "corporate" })).toBe(false);
    expect(holderPolicyAllows({ who: "specific", orgIds: ["o1"] }, null)).toBe(false);
  });
});

describe("verifierBindingAllows", () => {
  it("any accepts any org; orgs restricts to the list", () => {
    expect(verifierBindingAllows({ kind: "any" }, "vX")).toBe(true);
    expect(verifierBindingAllows({ kind: "orgs", orgIds: ["v1"] }, "v1")).toBe(true);
    expect(verifierBindingAllows({ kind: "orgs", orgIds: ["v1"] }, "v2")).toBe(false);
  });
});

const baseDef2 = (certificate?: unknown): CredentialUseCaseDefinition => ({
  key: "domicile", name: "Domicile", credentialTypes: [{
    name: "DomicileCredential", title: "Domicile Certificate", validityDays: 365, requiredApprovals: 1,
    claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" }, district: { type: "string" } } },
    ...(certificate !== undefined ? { certificate } : {}),
  }],
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
} as CredentialUseCaseDefinition);
const certCtx = { orgExists: () => true };

describe("certificate config validation", () => {
  it("accepts a valid certificate config", () => {
    expect(() => validateCredentialUseCase(baseDef2({ enabled: true, heading: "Certificate of Domicile", subheading: "Govt of X", claimOrder: ["fullName", "district"] }), certCtx)).not.toThrow();
  });
  it("accepts a type with no certificate (back-compat)", () => {
    expect(() => validateCredentialUseCase(baseDef2(), certCtx)).not.toThrow();
  });
  it("rejects a non-boolean enabled", () => {
    expect(() => validateCredentialUseCase(baseDef2({ enabled: "yes" }), certCtx)).toThrow(/enabled/);
  });
  it("rejects a non-string heading", () => {
    expect(() => validateCredentialUseCase(baseDef2({ enabled: true, heading: 5 }), certCtx)).toThrow(/heading/);
  });
  it("rejects a claimOrder entry not in the claim schema", () => {
    expect(() => validateCredentialUseCase(baseDef2({ enabled: true, claimOrder: ["fullName", "ghost"] }), certCtx)).toThrow(/ghost|claimOrder/);
  });
});

describe("validateCredentialUseCase requiredApprovals", () => {
  it("rejects a present-but-invalid requiredApprovals", () => {
    const bad = { ...baseDef, credentialTypes: [{ ...baseDef.credentialTypes[0]!, requiredApprovals: 0 }] };
    expect(() => validateCredentialUseCase(bad, { orgExists: () => true })).toThrow(/requiredApprovals/i);
  });
  it("accepts a missing requiredApprovals (defaults later)", () => {
    const ok = { ...baseDef, credentialTypes: [{ ...baseDef.credentialTypes[0]!, requiredApprovals: undefined as unknown as number }] };
    expect(() => validateCredentialUseCase(ok, { orgExists: () => true })).not.toThrow();
  });
});
