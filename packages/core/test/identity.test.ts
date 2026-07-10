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

describe("verifyPresentation — adversarial (security-critical)", () => {
  const now = 1_800_000_000;
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  const VC_CTX = ["https://www.w3.org/2018/credentials/v1"];
  // Craft a VC-JWT with full control over signer and payload (attacker toolkit).
  function craftVc(over: { issuerDid: string; signerKey: Parameters<typeof signJwt>[2]; subjectDid?: string; noSubjectId?: boolean; exp?: number | undefined; nbf?: number; extraClaims?: Record<string, unknown> }): string {
    const cs: Record<string, unknown> = { country: "IN", ...(over.extraClaims ?? {}) };
    if (!over.noSubjectId) cs.id = over.subjectDid;
    const payload: Record<string, unknown> = {
      iss: over.issuerDid, sub: over.subjectDid, iat: now, nbf: over.nbf ?? now,
      vc: { "@context": VC_CTX, type: ["VerifiableCredential", "KycCredential"], credentialSubject: cs },
    };
    if (over.exp !== undefined) payload.exp = over.exp;
    return signJwt({ alg: "EdDSA", typ: "JWT", kid: `${over.issuerDid}#0` }, payload, over.signerKey);
  }
  // Craft a VP-JWT with full control over holder signer and vp container.
  function craftVp(over: { holderDid: string; signerKey: Parameters<typeof signJwt>[2]; challenge?: string; vc?: unknown; vcList?: unknown[]; omitVp?: boolean }): string {
    const payload: Record<string, unknown> = { iss: over.holderDid, nonce: over.challenge ?? "chal-1", iat: now };
    if (!over.omitVp) payload.vp = { "@context": VC_CTX, type: ["VerifiablePresentation"], verifiableCredential: over.vcList ?? [over.vc] };
    return signJwt({ alg: "EdDSA", typ: "JWT", kid: `${over.holderDid}#0` }, payload, over.signerKey);
  }

  // ---- REQUIRED: the two implementer-flagged codes ----
  it("NO_CREDENTIAL: empty verifiableCredential array", () => {
    const holder = generateDidKey();
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vcList: [] });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [], now })).toMatchObject({ valid: false, reason: "NO_CREDENTIAL" });
  });
  it("BAD_ISSUER_SIGNATURE: VC re-signed by a different key but keeps issuer DID", () => {
    const issuer = generateDidKey();
    const attacker = generateDidKey();
    const holder = generateDidKey();
    // iss claims the trusted issuer, but the signature is the attacker's.
    const forgedVc = craftVc({ issuerDid: issuer.did, signerKey: attacker.privateKey, subjectDid: holder.did, exp: now + 3600 });
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vc: forgedVc });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [issuer.did], now })).toMatchObject({ valid: false, reason: "BAD_ISSUER_SIGNATURE" });
  });

  // ---- 1. alg confusion / unprotected header ----
  it("alg confusion: rewriting the VP header to alg:none breaks the holder proof", () => {
    const issuer = generateDidKey();
    const holder = generateDidKey();
    const vc = craftVc({ issuerDid: issuer.did, signerKey: issuer.privateKey, subjectDid: holder.did, exp: now + 3600 });
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vc });
    const [, p, s] = vp.split(".");
    const forged = `${b64u({ alg: "none", typ: "JWT" })}.${p}.${s}`; // swap header → signing input changes
    expect(verifyPresentation({ vpJwt: forged, challenge: "chal-1", trustedIssuers: [issuer.did], now })).toMatchObject({ valid: false, reason: "BAD_HOLDER_PROOF" });
  });
  it("alg confusion: unsigned alg:none token (empty signature) is rejected", () => {
    const holder = generateDidKey();
    const header = b64u({ alg: "none", typ: "JWT" });
    const payload = b64u({ iss: holder.did, nonce: "chal-1", vp: { verifiableCredential: [] } });
    const unsigned = `${header}.${payload}.`; // no signature
    expect(verifyPresentation({ vpJwt: unsigned, challenge: "chal-1", trustedIssuers: [], now })).toMatchObject({ valid: false, reason: "BAD_HOLDER_PROOF" });
  });

  // ---- 2. holder ≠ subject substitution ----
  it("holder substitution: presenting another DID's valid VC in my own VP → SUBJECT_MISMATCH", () => {
    const issuer = generateDidKey();
    const victim = generateDidKey();
    const attacker = generateDidKey();
    // A perfectly valid, issuer-signed VC bound to the victim.
    const victimVc = craftVc({ issuerDid: issuer.did, signerKey: issuer.privateKey, subjectDid: victim.did, exp: now + 3600 });
    // Attacker wraps it in a VP signed by their own key (iss = attacker → holder proof passes).
    const vp = craftVp({ holderDid: attacker.did, signerKey: attacker.privateKey, vc: victimVc });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [issuer.did], now })).toMatchObject({ valid: false, reason: "SUBJECT_MISMATCH" });
  });
  it("holder impersonation: iss=victim but signed with attacker key → BAD_HOLDER_PROOF", () => {
    const issuer = generateDidKey();
    const victim = generateDidKey();
    const attacker = generateDidKey();
    const victimVc = craftVc({ issuerDid: issuer.did, signerKey: issuer.privateKey, subjectDid: victim.did, exp: now + 3600 });
    const vp = craftVp({ holderDid: victim.did, signerKey: attacker.privateKey, vc: victimVc }); // lies about iss
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [issuer.did], now })).toMatchObject({ valid: false, reason: "BAD_HOLDER_PROOF" });
  });
  it("subject binding: credentialSubject.id (not sub) governs; disagreement is caught", () => {
    const issuer = generateDidKey();
    const holder = generateDidKey();
    const attacker = generateDidKey();
    // sub says holder, but the (issuer-signed) credentialSubject.id says attacker → binds to id → mismatch vs holder.
    const vc = signJwt({ alg: "EdDSA", typ: "JWT", kid: `${issuer.did}#0` },
      { iss: issuer.did, sub: holder.did, iat: now, nbf: now, exp: now + 3600,
        vc: { "@context": VC_CTX, type: ["VerifiableCredential"], credentialSubject: { id: attacker.did, country: "IN" } } }, issuer.privateKey);
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vc });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [issuer.did], now })).toMatchObject({ valid: false, reason: "SUBJECT_MISMATCH" });
  });

  // ---- 3. issuer trust: exact-match, no fragment/normalization gap ----
  it("issuer trust is exact: a #fragment on iss does not slip past the trust list", () => {
    const issuer = generateDidKey();
    const holder = generateDidKey();
    // Fragment form still resolves to the same key (sig verifies) but is NOT the trusted string.
    const vc = craftVc({ issuerDid: `${issuer.did}#0`, signerKey: issuer.privateKey, subjectDid: holder.did, exp: now + 3600 });
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vc });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [issuer.did], now })).toMatchObject({ valid: false, reason: "UNTRUSTED_ISSUER" });
  });

  // ---- 4. expiry / nbf boundaries ----
  it("expiry: a VC with NO exp is rejected as CREDENTIAL_EXPIRED", () => {
    const issuer = generateDidKey();
    const holder = generateDidKey();
    const vc = craftVc({ issuerDid: issuer.did, signerKey: issuer.privateKey, subjectDid: holder.did, exp: undefined });
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vc });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [issuer.did], now })).toMatchObject({ valid: false, reason: "CREDENTIAL_EXPIRED" });
  });
  it("expiry: nbf in the future is rejected (not-yet-valid)", () => {
    const issuer = generateDidKey();
    const holder = generateDidKey();
    const vc = craftVc({ issuerDid: issuer.did, signerKey: issuer.privateKey, subjectDid: holder.did, exp: now + 3600, nbf: now + 100 });
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vc });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [issuer.did], now })).toMatchObject({ valid: false, reason: "CREDENTIAL_EXPIRED" });
  });
  it("expiry: exp exactly == now is still accepted (boundary)", () => {
    const issuer = generateDidKey();
    const holder = generateDidKey();
    const vc = craftVc({ issuerDid: issuer.did, signerKey: issuer.privateKey, subjectDid: holder.did, exp: now });
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vc });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [issuer.did], now })).toMatchObject({ valid: true });
  });

  // ---- 5. structure confusion → always fails closed with a coded reason ----
  it("structure: VP payload with no vp claim → NO_CREDENTIAL", () => {
    const holder = generateDidKey();
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, omitVp: true });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [], now })).toMatchObject({ valid: false, reason: "NO_CREDENTIAL" });
  });
  it("structure: non-string credential entry → NO_CREDENTIAL", () => {
    const holder = generateDidKey();
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vcList: [{ not: "a jwt string" }] });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [], now })).toMatchObject({ valid: false, reason: "NO_CREDENTIAL" });
  });
  it("structure: inner 'VC' that is really a nested VP → SUBJECT_MISMATCH, never a throw", () => {
    const issuer = generateDidKey();
    const holder = generateDidKey();
    // A VP-shaped JWT signed by the trusted issuer, presented as if it were a VC (no credentialSubject).
    const innerVp = signJwt({ alg: "EdDSA", typ: "JWT", kid: `${issuer.did}#0` },
      { iss: issuer.did, nbf: now, exp: now + 3600, vp: { verifiableCredential: [] } }, issuer.privateKey);
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vc: innerVp });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [issuer.did], now })).toMatchObject({ valid: false, reason: "SUBJECT_MISMATCH" });
  });
  it("structure: garbage inner VC JWT → MALFORMED_PRESENTATION (fails closed, no throw)", () => {
    const holder = generateDidKey();
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vc: "aaa.bbb.ccc" });
    expect(verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [], now })).toMatchObject({ valid: false, reason: "MALFORMED_PRESENTATION" });
  });

  // ---- 6. base58 / did:key malformation must never crash ----
  it("did:key: malformed base58 in holder DID → MALFORMED_PRESENTATION (coded, not a throw)", () => {
    const holder = generateDidKey();
    // Valid signature over a payload whose iss is a did:key-prefixed but undecodable string.
    const badDid = "did:key:z0OIl"; // contains chars outside the base58 alphabet
    const vp = signJwt({ alg: "EdDSA", typ: "JWT" }, { iss: badDid, nonce: "chal-1", vp: { verifiableCredential: [] } }, holder.privateKey);
    const r = verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [], now });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("MALFORMED_PRESENTATION");
  });
  it("did:key: publicKeyFromDidKey throws a coded error on wrong multicodec / length (not a crash path)", () => {
    // wrong key length: 31 bytes after the ed multicodec
    expect(() => publicKeyFromDidKey(didKeyFromPublicKey(Buffer.alloc(31, 9)))).toThrow();
    // non-did:key input
    expect(() => publicKeyFromDidKey("did:web:example.com")).toThrow();
  });

  // ---- 7. signature malleability / truncation / segment count ----
  it("truncation: a chopped holder signature → BAD_HOLDER_PROOF", () => {
    const issuer = generateDidKey();
    const holder = generateDidKey();
    const vc = craftVc({ issuerDid: issuer.did, signerKey: issuer.privateKey, subjectDid: holder.did, exp: now + 3600 });
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vc });
    const [h, p, s] = vp.split(".");
    const truncated = `${h}.${p}.${s.slice(0, -8)}`; // drop 8 base64url chars from the sig
    expect(verifyPresentation({ vpJwt: truncated, challenge: "chal-1", trustedIssuers: [issuer.did], now })).toMatchObject({ valid: false, reason: "BAD_HOLDER_PROOF" });
  });
  it("segments: a 4-part VP token → MALFORMED_PRESENTATION", () => {
    const holder = generateDidKey();
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vcList: [] });
    expect(verifyPresentation({ vpJwt: `${vp}.extra`, challenge: "chal-1", trustedIssuers: [], now })).toMatchObject({ valid: false, reason: "MALFORMED_PRESENTATION" });
  });

  // ---- sanity: the toolkit builds a VP the verifier accepts ----
  it("positive control: a fully honest crafted VP verifies", () => {
    const issuer = generateDidKey();
    const holder = generateDidKey();
    const vc = craftVc({ issuerDid: issuer.did, signerKey: issuer.privateKey, subjectDid: holder.did, exp: now + 3600, extraClaims: { legalName: "Asha Rao" } });
    const vp = craftVp({ holderDid: holder.did, signerKey: holder.privateKey, vc });
    const r = verifyPresentation({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [issuer.did], now });
    expect(r.valid).toBe(true);
    expect(r.credential?.claims.legalName).toBe("Asha Rao");
    expect(r.credential?.claims.id).toBeUndefined(); // id is stripped from returned claims
  });
});
