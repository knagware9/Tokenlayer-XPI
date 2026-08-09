/**
 * Endpoint signing secrets at rest (EN-C). Stored ENCRYPTED, not hashed, and
 * the asymmetry with EN-B is the whole point.
 *
 * EN-B's API keys are bcrypt-hashed because the platform only ever VERIFIES a
 * secret someone presents: it never needs the original back, so the strongest
 * available choice is to not be able to recover it. HMAC signing is the exact
 * opposite direction — the dispatcher must REPRODUCE the secret on every single
 * delivery to compute the signature, so a one-way hash makes signing impossible.
 * That leaves encryption: plaintext at rest would hand over every integrator's
 * signing key in one database read, and with a signing key an attacker forges
 * deliveries that the integrator's verifier accepts as genuine.
 *
 * Envelope: the same one keystore.ts already uses for custodial DID seeds —
 * 12-byte IV ‖ 16-byte GCM auth tag ‖ ciphertext, base64. Deliberately identical
 * rather than a second scheme to reason about; GCM's tag also means a tampered
 * row fails loudly on open() instead of silently signing with garbage.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12; // AES-GCM standard nonce length
const TAG_LEN = 16;
/** 24 random bytes = 192 bits, well past what an HMAC-SHA256 key needs. */
const SECRET_BYTES = 24;

export interface SecretBox {
  seal(plaintext: string): string;
  open(sealed: string): string;
  /** A fresh endpoint secret. Shown once at creation, never retrievable again. */
  mint(): string;
}

/** Build a secret box bound to a 32-byte master key (hex, 64 chars). */
export function createSecretBox(masterKeyHex: string): SecretBox {
  const key = Buffer.from(masterKeyHex, "hex");
  if (key.length !== 32) throw new Error("webhook secret key must be 32 bytes (64 hex chars)");

  return {
    seal(plaintext) {
      // A FRESH IV per seal. Reusing a nonce under one key is the catastrophic
      // failure mode of GCM, so it is generated here and never passed in.
      const iv = randomBytes(IV_LEN);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
    },
    open(sealed) {
      const buf = Buffer.from(sealed, "base64");
      const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_LEN));
      d.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
      return Buffer.concat([d.update(buf.subarray(IV_LEN + TAG_LEN)), d.final()]).toString("utf8");
    },
    // base64url, so the secret survives a copy-paste through a URL, a shell or
    // an .env file without an escaping step the integrator will get wrong.
    mint: () => `whsec_${randomBytes(SECRET_BYTES).toString("base64url")}`,
  };
}
