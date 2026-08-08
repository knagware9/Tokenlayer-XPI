/**
 * API-key secrets (EN-B). The secret exists exactly once — in the create/rotate
 * response. We store a bcrypt hash plus an indexed public prefix, so a leaked
 * database yields no working credential (an unsalted-hash lookup would).
 */
import { randomBytes } from "node:crypto";
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
