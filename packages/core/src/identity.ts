/**
 * Digital identity primitives: did:key (Ed25519), EdDSA VC-JWT/VP-JWT signing
 * and `verifyPresentation`. Pure crypto over `node:crypto` native Ed25519 —
 * zero external dependencies. No I/O and no `Date.now`; callers pass `now`.
 */
import { createPublicKey, createPrivateKey, generateKeyPairSync, randomUUID, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

// --- base64url ---
const b64u = (buf: Buffer): string => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uJson = (o: unknown): string => b64u(Buffer.from(JSON.stringify(o), "utf8"));
const fromB64u = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// --- base58btc (Bitcoin alphabet), enough for did:key multibase ---
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58encode(bytes: Buffer): string {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ""; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
function base58decode(str: string): Buffer {
  let n = 0n; for (const ch of str) { const i = B58.indexOf(ch); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const bytes: number[] = []; while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of str) { if (ch === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

// Ed25519 multicodec prefix 0xed 0x01; SPKI DER header for a raw Ed25519 pubkey.
const ED_MULTICODEC = Buffer.from([0xed, 0x01]);
const SPKI_ED_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
// PKCS8 DER header for a raw 32-byte Ed25519 seed (private key).
const PKCS8_ED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function didKeyFromPublicKey(rawPub: Buffer): string {
  return "did:key:z" + base58encode(Buffer.concat([ED_MULTICODEC, rawPub]));
}

export function publicKeyFromDidKey(did: string): KeyObject {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)(#.*)?$/.exec(did);
  if (!m) throw new Error("unsupported DID (expected did:key ed25519)");
  const decoded = base58decode(m[1]!);
  if (!decoded.subarray(0, 2).equals(ED_MULTICODEC)) throw new Error("unsupported did:key codec");
  const rawPub = decoded.subarray(2);
  if (rawPub.length !== 32) throw new Error("bad ed25519 key length");
  return createPublicKey({ key: Buffer.concat([SPKI_ED_PREFIX, rawPub]), format: "der", type: "spki" });
}

export interface DidKey { did: string; publicKey: KeyObject; privateKey: KeyObject; }
export function generateDidKey(): DidKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { did: didKeyFromPublicKey(rawPub), publicKey, privateKey };
}

/** Deterministic did:key from a raw 32-byte Ed25519 seed (PKCS8-wrapped). */
export function didKeyFromSeed(seed: Buffer): DidKey {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED_PREFIX, seed.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { did: didKeyFromPublicKey(rawPub), publicKey, privateKey };
}

export function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: KeyObject): string {
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  const sig = edSign(null, Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${b64u(sig)}`;
}

export function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  return { header: JSON.parse(fromB64u(parts[0]!).toString("utf8")), payload: JSON.parse(fromB64u(parts[1]!).toString("utf8")) };
}

export function verifyJwtSignature(jwt: string, publicKey: KeyObject): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  try {
    return edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"), publicKey, fromB64u(parts[2]!));
  } catch { return false; }
}

export interface IssueInput { issuerDid: string; issuerKey: KeyObject; subjectDid: string; claims: Record<string, unknown>; expiresAt: number; now: number; type?: string[]; }
/** Mint a VC-JWT (dev/test helper). credentialSubject.id = subjectDid; jti = credential id. Defaults to a KycCredential type. */
export function issueCredential(i: IssueInput): string {
  return signJwt(
    { alg: "EdDSA", typ: "JWT", kid: `${i.issuerDid}#0` },
    { iss: i.issuerDid, sub: i.subjectDid, jti: `urn:uuid:${randomUUID()}`, iat: i.now, nbf: i.now, exp: i.expiresAt,
      vc: { "@context": ["https://www.w3.org/2018/credentials/v1"], type: i.type ?? ["VerifiableCredential", "KycCredential"], credentialSubject: { id: i.subjectDid, ...i.claims } } },
    i.issuerKey,
  );
}

export interface PresentInput { holderDid: string; holderKey: KeyObject; vcJwt: string; challenge: string; now: number; }
/** Wrap a VC-JWT in a holder-signed VP-JWT over a challenge (dev/test helper). */
export function presentCredential(p: PresentInput): string {
  return signJwt(
    { alg: "EdDSA", typ: "JWT", kid: `${p.holderDid}#0` },
    { iss: p.holderDid, nonce: p.challenge, iat: p.now,
      vp: { "@context": ["https://www.w3.org/2018/credentials/v1"], type: ["VerifiablePresentation"], verifiableCredential: [p.vcJwt] } },
    p.holderKey,
  );
}

export interface VerifiedCredential { issuer: string; subject: string; claims: Record<string, unknown>; issuedAt?: number; expiresAt?: number; }
export interface PresentationResult { valid: boolean; reason?: string; holderDid?: string; credential?: VerifiedCredential; }
export interface VerifyInput { vpJwt: string; challenge: string; trustedIssuers: string[]; now: number; }

/** Verify a VP-JWT: holder proof over the challenge, then the inner VC (issuer sig, trust, expiry, subject binding). First failure wins. */
export function verifyPresentation(input: VerifyInput): PresentationResult {
  const fail = (reason: string): PresentationResult => ({ valid: false, reason });
  let vp;
  try { vp = decodeJwt(input.vpJwt); } catch { return fail("MALFORMED_PRESENTATION"); }
  try {
    const holderDid = String(vp.payload.iss ?? "");
    if (!holderDid.startsWith("did:key:")) return fail("MALFORMED_PRESENTATION");
    if (!verifyJwtSignature(input.vpJwt, publicKeyFromDidKey(holderDid))) return fail("BAD_HOLDER_PROOF");
    if (String(vp.payload.nonce ?? "") !== input.challenge) return fail("CHALLENGE_MISMATCH");
    const vcJwt = (vp.payload.vp as { verifiableCredential?: unknown[] })?.verifiableCredential?.[0];
    if (typeof vcJwt !== "string") return fail("NO_CREDENTIAL");
    const vc = decodeJwt(vcJwt);
    const issuerDid = String(vc.payload.iss ?? "");
    if (!issuerDid.startsWith("did:key:") || !verifyJwtSignature(vcJwt, publicKeyFromDidKey(issuerDid))) return fail("BAD_ISSUER_SIGNATURE");
    if (!input.trustedIssuers.includes(issuerDid)) return fail("UNTRUSTED_ISSUER");
    const exp = Number(vc.payload.exp ?? 0), nbf = Number(vc.payload.nbf ?? vc.payload.iat ?? 0);
    if (!exp || exp < input.now || nbf > input.now) return fail("CREDENTIAL_EXPIRED");
    const subjectId = String((vc.payload.vc as { credentialSubject?: { id?: string } })?.credentialSubject?.id ?? vc.payload.sub ?? "");
    if (subjectId !== holderDid) return fail("SUBJECT_MISMATCH");
    const cs = { ...(vc.payload.vc as { credentialSubject?: Record<string, unknown> }).credentialSubject };
    delete (cs as { id?: unknown }).id;
    return { valid: true, holderDid, credential: { issuer: issuerDid, subject: subjectId, claims: cs, issuedAt: nbf, expiresAt: exp } };
  } catch { return fail("MALFORMED_PRESENTATION"); }
}
