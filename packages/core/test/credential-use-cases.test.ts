import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TEMPLATES,
  validateCredentialUseCase,
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
