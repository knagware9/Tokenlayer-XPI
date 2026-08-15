/**
 * WHAT THE PUBLIC PORTAL IS ALLOWED TO SAY.
 *
 * This page is read by people with no account and no context — a counterparty
 * handed a certificate, a citizen, a regulator — and it is the one surface
 * where a wrong word is worse than a missing feature. Two failures matter more
 * than any layout bug:
 *
 *   · calling an UNANCHORED record "confirmed on-chain", which would tell a
 *     verifier an independent ledger agreed when nothing of the sort happened;
 *   · calling a SANDBOX credential real. It is a rehearsal artefact that never
 *     had on-chain existence and never claimed any.
 *
 * So the verdict (is it in force?) and the provenance (who says so?) are
 * computed separately and asserted separately here — a revoked credential can
 * be confirmed by the chain, and a valid one may rest on the platform's word
 * alone. A single badge cannot carry both facts without lying about one.
 */
import { describe, expect, it } from "vitest";
import { credentialIdFrom, provenanceOf, verdictOf } from "../src/lib/identity/public-verify.js";
import type { CredentialStatusInfo } from "../src/types.js";

const status = (over: Partial<CredentialStatusInfo> = {}): CredentialStatusInfo => ({
  id: "cred_1", revoked: false, revokedAt: null, reason: null,
  anchored: true, source: "chain", ...over,
});

describe("the verdict — is this credential in force?", () => {
  it("valid when not revoked and accepted", () => {
    expect(verdictOf(status())).toMatchObject({ tone: "ok", headline: "Valid" });
  });

  it("revoked wins over everything, and repeats the issuer's stated reason", () => {
    const v = verdictOf(status({ revoked: true, reason: "employment ended" }));
    expect(v.tone).toBe("danger");
    expect(v.headline).toBe("Revoked");
    expect(v.detail).toContain("employment ended");
  });

  it("revoked with no reason still reads as revoked, not as an error", () => {
    expect(verdictOf(status({ revoked: true }))).toMatchObject({ tone: "danger", headline: "Revoked" });
  });

  it("an ABSENT acceptance field means accepted — it is omitted for the untouched default", () => {
    // The API leaves `acceptance` out entirely for a credential that was born
    // accepted and never went through the ceremony. Reading that absence as
    // "unknown" would put a warning on the commonest valid credential there is.
    expect(verdictOf(status({ acceptance: undefined })).tone).toBe("ok");
    expect(verdictOf(status({ acceptance: "accepted" })).tone).toBe("ok");
  });

  it("flags a credential the holder has not accepted — issued is not in force", () => {
    for (const acceptance of ["pending", "rejected", "changes_requested"]) {
      const v = verdictOf(status({ acceptance }));
      expect(v.tone, acceptance).toBe("warn");
      expect(v.headline).toBe("Not yet accepted");
    }
  });
});

describe("the provenance — who is actually saying so?", () => {
  it("chain: says the ledger was read, and says it is not our database", () => {
    const p = provenanceOf(status({ source: "chain" }));
    expect(p.tone).toBe("ok");
    expect(p.label).toBe("Confirmed on-chain");
    expect(p.detail).toMatch(/not from this platform's database/i);
  });

  it("database: NEVER claims a chain confirmed it", () => {
    // The failure this test exists for: a green "verified" badge over an
    // answer that rests on nothing but our own row.
    const p = provenanceOf(status({ source: "database", anchored: false }));
    expect(p.tone).not.toBe("ok");
    expect(p.label).toBe("Platform record only");
    // Not a substring ban — the honest copy legitimately says "anchors NO
    // on-chain registry". What is forbidden is the CLAIM: no "confirmed", and
    // it must say out loud that nothing independent backs this.
    expect(p.label).not.toMatch(/confirmed/i);
    expect(p.detail).not.toMatch(/confirmed|verified by the ledger/i);
    expect(p.detail).toMatch(/nothing independent/i);
    expect(p.label).not.toBe(provenanceOf(status({ source: "chain" })).label);
  });

  it("sandbox: says outright that it is not a real credential", () => {
    const p = provenanceOf(status({ source: "sandbox", sandbox: true, anchored: false }));
    expect(p.label).toMatch(/not a real credential/i);
    expect(p.detail).toMatch(/do not rely on it/i);
  });

  it("a REVOKED credential can still be chain-confirmed — the two answers are independent", () => {
    const s = status({ revoked: true, source: "chain" });
    expect(verdictOf(s).tone).toBe("danger");
    expect(provenanceOf(s).tone).toBe("ok"); // the chain is what told us it was revoked
  });

  it("a VALID credential can rest on the platform alone — the mirror case", () => {
    const s = status({ source: "database", anchored: false });
    expect(verdictOf(s).tone).toBe("ok");
    expect(provenanceOf(s).tone).toBe("warn");
  });
});

describe("what people actually paste", () => {
  it("takes a bare id", () => {
    expect(credentialIdFrom("cred_abc123")).toBe("cred_abc123");
  });

  it("takes the status URL from a certificate", () => {
    expect(credentialIdFrom("https://api.example.com/api/v1/credentials/cred_abc123/status")).toBe("cred_abc123");
  });

  it("takes the certificate PDF URL", () => {
    expect(credentialIdFrom("https://api.example.com/api/v1/credentials/cred_abc123/certificate.pdf")).toBe("cred_abc123");
  });

  it("takes a share link with ?id=", () => {
    expect(credentialIdFrom("https://console.example.com/verify?id=cred_abc123")).toBe("cred_abc123");
  });

  it("trims stray whitespace — the commonest paste artefact", () => {
    expect(credentialIdFrom("  cred_abc123\n")).toBe("cred_abc123");
  });

  it("url-decodes an encoded id rather than searching for one that does not exist", () => {
    expect(credentialIdFrom("https://x/api/v1/credentials/cred%2Fodd/status")).toBe("cred/odd");
  });

  it("empty in, empty out — the caller decides what to say about it", () => {
    expect(credentialIdFrom("   ")).toBe("");
  });
});
