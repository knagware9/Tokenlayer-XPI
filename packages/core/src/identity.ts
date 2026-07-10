/**
 * Digital identity primitives: did:key (Ed25519) and EdDSA JWT signing/verify.
 * Pure crypto over `node:crypto` native Ed25519 — zero external dependencies.
 * No I/O and no `Date.now`; callers pass `now`.
 */
import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

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
