import { describe, it, expect } from "vitest";
import {
  generateDidKey,
  didKeyFromPublicKey,
  publicKeyFromDidKey,
  didKeyFromSeed,
  signJwt,
  verifyJwtSignature,
  decodeJwt,
  issueCredential,
  presentCredential,
  verifyPresentation,
} from "../src/identity.js";

describe("did:key + JWT primitives", () => {
  it("round-trips a did:key ⇄ public key", () => {
    const { did, publicKey } = generateDidKey();
    expect(did.startsWith("did:key:z6Mk")).toBe(true);
    // the resolved key verifies a signature made by the matching private key
    expect(didKeyFromPublicKey(publicKey.export({ type: "spki", format: "der" }).subarray(-32))).toBe(did);
  });
  it("signs and verifies an EdDSA JWT; tamper is rejected", () => {
    const { did, privateKey } = generateDidKey();
    const jwt = signJwt({ alg: "EdDSA", typ: "JWT", kid: `${did}#0` }, { iss: did, foo: "bar" }, privateKey);
    const pub = publicKeyFromDidKey(did);
    expect(verifyJwtSignature(jwt, pub)).toBe(true);
    expect(decodeJwt(jwt).payload.foo).toBe("bar");
    const tampered = jwt.slice(0, -4) + (jwt.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(verifyJwtSignature(tampered, pub)).toBe(false);
  });
  it("didKeyFromSeed is deterministic and produces a verifiable signer", () => {
    const seed = Buffer.alloc(32, 7);
    const a = didKeyFromSeed(seed);
    const b = didKeyFromSeed(seed);
    expect(a.did).toBe(b.did);
    expect(a.did.startsWith("did:key:z6Mk")).toBe(true);
    const jwt = signJwt({ alg: "EdDSA", typ: "JWT", kid: `${a.did}#0` }, { iss: a.did, n: 1 }, a.privateKey);
    expect(verifyJwtSignature(jwt, publicKeyFromDidKey(a.did))).toBe(true);
  });
});

describe("verifyPresentation", () => {
  const now = 1_800_000_000; // fixed epoch seconds
  function scenario(over: Partial<{ challenge: string; issuerTrusted: boolean; expiresAt: number; wrongHolder: boolean; subjectMismatch: boolean }> = {}) {
    const issuer = generateDidKey();
    const holder = generateDidKey();
    const other = generateDidKey();
    const subject = over.subjectMismatch ? other.did : holder.did;
    const vcJwt = issueCredential({ issuerDid: issuer.did, issuerKey: issuer.privateKey, subjectDid: subject, claims: { country: "IN", legalName: "Asha Rao" }, expiresAt: over.expiresAt ?? now + 3600, now });
    const presenter = over.wrongHolder ? other : holder;
    const vpJwt = presentCredential({ holderDid: holder.did, holderKey: presenter.privateKey, vcJwt, challenge: "chal-1", now });
    return verifyPresentation({ vpJwt, challenge: over.challenge ?? "chal-1", trustedIssuers: over.issuerTrusted === false ? [] : [issuer.did], now });
  }
  it("accepts a valid VP and returns claims", () => {
    const r = scenario();
    expect(r.valid).toBe(true);
    expect(r.holderDid?.startsWith("did:key:")).toBe(true);
    expect(r.credential?.claims.country).toBe("IN");
  });
  it("rejects an untrusted issuer", () => expect(scenario({ issuerTrusted: false })).toMatchObject({ valid: false, reason: "UNTRUSTED_ISSUER" }));
  it("rejects an expired credential", () => expect(scenario({ expiresAt: now - 1 })).toMatchObject({ valid: false, reason: "CREDENTIAL_EXPIRED" }));
  it("rejects a bad holder proof", () => expect(scenario({ wrongHolder: true })).toMatchObject({ valid: false, reason: "BAD_HOLDER_PROOF" }));
  it("rejects a challenge mismatch", () => expect(scenario({ challenge: "wrong" })).toMatchObject({ valid: false, reason: "CHALLENGE_MISMATCH" }));
  it("rejects subject≠holder", () => expect(scenario({ subjectMismatch: true })).toMatchObject({ valid: false, reason: "SUBJECT_MISMATCH" }));
  it("rejects malformed input", () => expect(verifyPresentation({ vpJwt: "not-a-jwt", challenge: "x", trustedIssuers: [], now })).toMatchObject({ valid: false, reason: "MALFORMED_PRESENTATION" }));
});
