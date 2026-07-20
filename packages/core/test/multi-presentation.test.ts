import { describe, expect, it } from "vitest";
import { didKeyFromSeed, issueCredential, presentCredentials, verifyPresentationCredentials } from "../src/index.js";

const seed = (b: number): Buffer => Buffer.alloc(32, b);
const NOW = 1_800_000_000;

function issuer(b: number) {
  const k = didKeyFromSeed(seed(b));
  return { did: k.did, key: k.privateKey };
}
function holder(b: number) {
  return didKeyFromSeed(seed(b));
}

describe("presentCredentials + verifyPresentationCredentials", () => {
  it("verifies N credentials in one holder-signed VP, per-credential verdicts", () => {
    const iss = issuer(1);
    const h = holder(9);
    const vc1 = issueCredential({ issuerDid: iss.did, issuerKey: iss.key, subjectDid: h.did, claims: { country: "IN" }, type: ["VerifiableCredential", "KycCredential"], expiresAt: NOW + 1000, now: NOW });
    const vc2 = issueCredential({ issuerDid: iss.did, issuerKey: iss.key, subjectDid: h.did, claims: { role: "CFO" }, type: ["VerifiableCredential", "AuthorizedSignatory"], expiresAt: NOW + 1000, now: NOW });
    const vp = presentCredentials({ holderDid: h.did, holderKey: h.privateKey, vcJwts: [vc1, vc2], challenge: "chal-1", now: NOW });

    const r = verifyPresentationCredentials({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [iss.did], now: NOW });
    expect(r.valid).toBe(true);
    expect(r.holderDid).toBe(h.did);
    expect(r.credentials).toHaveLength(2);
    expect(r.credentials.every((c) => c.valid)).toBe(true);
    expect(r.credentials[0]!.credential!.claims).toEqual({ country: "IN" });
    expect(r.credentials[1]!.credential!.claims).toEqual({ role: "CFO" });
  });

  it("flags one bad credential among good ones without failing the others", () => {
    const good = issuer(1), rogue = issuer(2);
    const h = holder(9);
    const vcGood = issueCredential({ issuerDid: good.did, issuerKey: good.key, subjectDid: h.did, claims: { country: "IN" }, expiresAt: NOW + 1000, now: NOW });
    const vcUntrusted = issueCredential({ issuerDid: rogue.did, issuerKey: rogue.key, subjectDid: h.did, claims: { country: "US" }, expiresAt: NOW + 1000, now: NOW });
    const vcExpired = issueCredential({ issuerDid: good.did, issuerKey: good.key, subjectDid: h.did, claims: { x: 1 }, expiresAt: NOW - 10, now: NOW - 100 });
    const vp = presentCredentials({ holderDid: h.did, holderKey: h.privateKey, vcJwts: [vcGood, vcUntrusted, vcExpired], challenge: "c", now: NOW });

    const r = verifyPresentationCredentials({ vpJwt: vp, challenge: "c", trustedIssuers: [good.did], now: NOW });
    expect(r.valid).toBe(true);
    expect(r.credentials[0]!.valid).toBe(true);
    expect(r.credentials[1]!.valid).toBe(false);
    expect(r.credentials[1]!.reason).toBe("UNTRUSTED_ISSUER");
    expect(r.credentials[2]!.valid).toBe(false);
    expect(r.credentials[2]!.reason).toBe("CREDENTIAL_EXPIRED");
  });

  it("fails the whole VP on a challenge mismatch (no per-credential results)", () => {
    const iss = issuer(1); const h = holder(9);
    const vc = issueCredential({ issuerDid: iss.did, issuerKey: iss.key, subjectDid: h.did, claims: {}, expiresAt: NOW + 1000, now: NOW });
    const vp = presentCredentials({ holderDid: h.did, holderKey: h.privateKey, vcJwts: [vc], challenge: "right", now: NOW });
    const r = verifyPresentationCredentials({ vpJwt: vp, challenge: "wrong", trustedIssuers: [iss.did], now: NOW });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("CHALLENGE_MISMATCH");
    expect(r.credentials).toHaveLength(0);
  });

  it("rejects a credential whose subject is not the holder (SUBJECT_MISMATCH)", () => {
    const iss = issuer(1); const h = holder(9); const other = holder(8);
    const vcForOther = issueCredential({ issuerDid: iss.did, issuerKey: iss.key, subjectDid: other.did, claims: {}, expiresAt: NOW + 1000, now: NOW });
    const vp = presentCredentials({ holderDid: h.did, holderKey: h.privateKey, vcJwts: [vcForOther], challenge: "c", now: NOW });
    const r = verifyPresentationCredentials({ vpJwt: vp, challenge: "c", trustedIssuers: [iss.did], now: NOW });
    expect(r.credentials[0]!.reason).toBe("SUBJECT_MISMATCH");
  });

  it("returns NO_CREDENTIAL for an empty presentation", () => {
    const h = holder(9);
    const vp = presentCredentials({ holderDid: h.did, holderKey: h.privateKey, vcJwts: [], challenge: "c", now: NOW });
    const r = verifyPresentationCredentials({ vpJwt: vp, challenge: "c", trustedIssuers: [], now: NOW });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("NO_CREDENTIAL");
  });
});
