/**
 * API-key secrets (EN-B). The secret exists exactly once — in the create/rotate
 * response. We store a bcrypt hash plus an indexed public prefix, so a leaked
 * database yields no working credential (an unsalted-hash lookup would).
 */
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

/** Public marker distinguishing a key from a JWT in the Authorization header. */
export const KEY_PREFIX_MARKER = "tl_live_";
/** Chars of the secret body kept in the clear, for display and the indexed lookup. */
const PREFIX_LEN = 8;
/**
 * 22 base62 chars. The `% ALPHABET.length` below is slightly biased (256 is not
 * a multiple of 62), costing 0.1 bits: ~130.9 bits of entropy rather than a
 * clean ~131, with a worst-case min-entropy of ~124.9. Unexploitable at that
 * magnitude, so the simpler code stands.
 */
const BODY_LEN = 22;
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export interface MintedSecret {
  /** The full credential — returned to the caller ONCE and never stored. */
  secret: string;
  /** First `PREFIX_LEN` chars of the body: safe to display, index and log. */
  prefix: string;
  /** bcrypt hash of the FULL secret (prefix included). */
  hash: string;
}

export async function mintSecret(rounds: number): Promise<MintedSecret> {
  const body = Array.from(randomBytes(BODY_LEN), (b) => ALPHABET[b % ALPHABET.length]).join("");
  const secret = `${KEY_PREFIX_MARKER}${body}`;
  return { secret, prefix: body.slice(0, PREFIX_LEN), hash: await bcrypt.hash(secret, rounds) };
}

/**
 * The prefix a raw credential claims, or null when it isn't a key at all —
 * null is the signal to take the JWT path, so this must never throw.
 */
export function prefixOf(raw: string): string | null {
  if (!raw.startsWith(KEY_PREFIX_MARKER)) return null;
  const body = raw.slice(KEY_PREFIX_MARKER.length);
  return body.length >= PREFIX_LEN ? body.slice(0, PREFIX_LEN) : null;
}

/** Constant-time by construction — bcrypt.compare does not short-circuit. */
export async function secretMatches(raw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(raw, hash);
}

/**
 * Cost factor for API-key secrets — deliberately LOWER than the repo's
 * `BCRYPT_ROUNDS = 12` for human passwords, and that difference is the point.
 *
 * A work factor exists to make an offline dictionary attack on a leaked hash
 * expensive, which matters because humans pick low-entropy passwords. A key
 * secret is 22 random base62 chars — ~131 bits — so brute-forcing one costs
 * ~2^130 hashes at cost 10 and ~2^130 hashes at cost 12: the entropy already
 * does all of the work, and the extra rounds buy nothing an attacker would
 * notice. What they DO buy is a 4x online cost we pay on every single request:
 * ~200ms per compare at cost 12, and bcryptjs is pure JS (CPU-bound, no thread
 * pool), so concurrency does not help — that is ~5 key requests/second/process,
 * far under the 600/min per-key ceiling we advertise. Cost 10 plus the verified-
 * prefix cache below brings the steady state in line with the limit.
 */
export const API_KEY_BCRYPT_ROUNDS = 10;

/**
 * Verified-prefix cache. Repeat traffic on a hot key skips bcrypt entirely.
 *
 * The SECRET IS NEVER CACHED. An entry records only that some presented string
 * whose SHA-256 is `fingerprint` verified against `secretHash` for key `keyId`.
 * SHA-256 of a ~131-bit random secret is not invertible, so an attacker who
 * reads process memory learns nothing they could present — and if they can read
 * this process's memory they already hold the JWT signing secret and the DID
 * master key, so this is not the weakest link either way.
 *
 * CORRECTNESS DOES NOT DEPEND ON THE TTL. The caller looks the key row up and
 * rejects revoked/expired rows BEFORE consulting the cache, so a revoked key has
 * no staleness window at all; and an entry is bound to the row's `secretHash`,
 * so a rotation invalidates it by construction (the new row's hash cannot match
 * a pre-rotation entry). `invalidateVerifiedPrefix` on revoke/rotate is belt and
 * braces plus memory hygiene; the TTL only bounds how long an idle entry sits.
 */
const VERIFIED_TTL_MS = 60_000;
/** Hard ceiling so a flood of distinct prefixes cannot grow the map without bound. */
const VERIFIED_MAX_ENTRIES = 1000;

interface VerifiedEntry {
  keyId: string;
  /** The row's bcrypt hash at verification time — a rotation changes it. */
  secretHash: string;
  /** SHA-256 of the presented secret. Never the secret. */
  fingerprint: string;
  expiresAt: number;
}

const verified = new Map<string, VerifiedEntry>();
let cacheHits = 0;
let cacheMisses = 0;

const fingerprintOf = (raw: string): string => createHash("sha256").update(raw).digest("hex");

/**
 * True when this exact (prefix, key row, presented secret) triple has already
 * been verified by bcrypt and the entry is still fresh. Callers MUST have
 * already checked revocation/expiry against the live row.
 */
export function cachedVerification(prefix: string, raw: string, key: { id: string; secretHash: string }): boolean {
  const entry = verified.get(prefix);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) verified.delete(prefix);
    cacheMisses += 1;
    return false;
  }
  const hit = entry.keyId === key.id && entry.secretHash === key.secretHash && entry.fingerprint === fingerprintOf(raw);
  if (hit) cacheHits += 1;
  else cacheMisses += 1;
  return hit;
}

/** Record a bcrypt-verified triple. Only ever called after a real compare. */
export function rememberVerification(prefix: string, raw: string, key: { id: string; secretHash: string }): void {
  if (verified.size >= VERIFIED_MAX_ENTRIES && !verified.has(prefix)) {
    // Cheapest useful eviction: drop whatever the map yields first (insertion
    // order). This is a performance cache — evicting a live entry only costs
    // one bcrypt compare.
    const oldest = verified.keys().next();
    if (!oldest.done) verified.delete(oldest.value);
  }
  verified.set(prefix, { keyId: key.id, secretHash: key.secretHash, fingerprint: fingerprintOf(raw), expiresAt: Date.now() + VERIFIED_TTL_MS });
}

/** Drop any cached verification for a prefix — called on revoke and rotate. */
export function invalidateVerifiedPrefix(prefix: string): void {
  verified.delete(prefix);
}

/** Observability (and the hook tests use to prove the cache is actually hit). */
export function verifiedPrefixCacheStats(): { hits: number; misses: number; size: number } {
  return { hits: cacheHits, misses: cacheMisses, size: verified.size };
}
