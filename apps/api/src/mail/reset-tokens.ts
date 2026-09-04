/**
 * Password-reset token secrets. Same shape as API-key secrets
 * (`shared/api-keys.ts`): a bcrypt hash plus an indexed public prefix, so a
 * leaked database yields no working token and lookup never needs a full-table
 * bcrypt scan.
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { API_KEY_BCRYPT_ROUNDS } from "../shared/api-keys.js";

const PREFIX_LEN = 8;
const BODY_LEN = 32;
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export interface MintedResetToken {
  /** The raw token — returned to the caller once, embedded in the emailed link, never stored. */
  token: string;
  /** First `PREFIX_LEN` chars — safe to index. */
  prefix: string;
  /** bcrypt hash of the FULL token. */
  hash: string;
}

export async function mintResetToken(): Promise<MintedResetToken> {
  const token = Array.from(randomBytes(BODY_LEN), (b) => ALPHABET[b % ALPHABET.length]).join("");
  return { token, prefix: token.slice(0, PREFIX_LEN), hash: await bcrypt.hash(token, API_KEY_BCRYPT_ROUNDS) };
}

/** Constant-time by construction — bcrypt.compare does not short-circuit. */
export async function resetTokenMatches(raw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(raw, hash);
}
