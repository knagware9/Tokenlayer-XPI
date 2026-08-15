import { describe, expect, it } from "vitest";
import { certificateSubjectName, resolveCertificateFields } from "../src/identity/certificate-fields.js";
import type { CredentialRecord } from "../src/persistence/types/index.js";
import type { CredentialTypeSpec } from "@tokenlayer/core";

const spec: CredentialTypeSpec = {
  name: "DomicileCredential", title: "Domicile Certificate", validityDays: 365, requiredApprovals: 1,
  claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" }, district: { type: "string" } } },
  certificate: { enabled: true, heading: "Certificate of Domicile", subheading: "Revenue Department" },
};

function cred(over: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "cred_1", holderDid: "did:key:zHolder", issuerDid: "did:key:zIssuer",
    type: "DomicileCredential", vcJwt: "x.y.z",
    subjectClaims: { fullName: "Ada Lovelace", district: "Pune" },
    issuedAt: "2026-01-15T00:00:00.000Z", expiresAt: "2027-01-15T00:00:00.000Z",
    revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
    proposalId: null, credentialUseCaseKey: "domicile",
    acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
    anchorTxHash: null, anchorChainId: null, revokeTxHash: null,
    ...over,
  };
}

describe("certificateSubjectName", () => {
  it("prefers fullName, then legalName, then holderName, then falls back to the DID", () => {
    expect(certificateSubjectName(cred({ subjectClaims: { fullName: "Ada" } }))).toBe("Ada");
    expect(certificateSubjectName(cred({ subjectClaims: { legalName: "Acme Ltd" } }))).toBe("Acme Ltd");
    expect(certificateSubjectName(cred({ subjectClaims: { holderName: "Bob" } }))).toBe("Bob");
    // A certificate with a blank name line is worse than one showing the DID.
    expect(certificateSubjectName(cred({ subjectClaims: {} }))).toBe("did:key:zHolder");
    expect(certificateSubjectName(cred({ subjectClaims: { fullName: "   " } }))).toBe("did:key:zHolder");
  });
});

describe("resolveCertificateFields", () => {
  const values = resolveCertificateFields({ credential: cred(), spec, issuerName: "Revenue Dept" });

  it("resolves claims, identity, dates and the config strings", () => {
    expect(values.get("claim:fullName")).toBe("Ada Lovelace");
    expect(values.get("claim:district")).toBe("Pune");
    expect(values.get("subject.name")).toBe("Ada Lovelace");
    expect(values.get("subject.did")).toBe("did:key:zHolder");
    expect(values.get("credential.id")).toBe("cred_1");
    expect(values.get("credential.type")).toBe("Domicile Certificate");
    expect(values.get("issuer.name")).toBe("Revenue Dept");
    expect(values.get("issuer.did")).toBe("did:key:zIssuer");
    expect(values.get("config.heading")).toBe("Certificate of Domicile");
    expect(values.get("config.subheading")).toBe("Revenue Department");
    expect(values.get("credential.issuedAt")).toBeTruthy();
  });

  it("falls back to the issuer DID when the org is unknown, rather than printing 'null'", () => {
    const v = resolveCertificateFields({ credential: cred(), spec, issuerName: null });
    expect(v.get("issuer.name")).toBe("did:key:zIssuer");
  });

  it("says 'No expiry' rather than leaving the line blank", () => {
    const v = resolveCertificateFields({ credential: cred({ expiresAt: null }), spec, issuerName: null });
    expect(v.get("credential.expiresAt")).toBe("No expiry");
  });

  it("omits absent claims entirely, so a placement for one simply prints nothing", () => {
    const v = resolveCertificateFields({ credential: cred({ subjectClaims: { fullName: "Ada" } }), spec, issuerName: null });
    expect(v.has("claim:district")).toBe(false);
  });

  it("has no entry for qr — the QR is an op, not a string", () => {
    expect(values.has("qr")).toBe(false);
  });
});
