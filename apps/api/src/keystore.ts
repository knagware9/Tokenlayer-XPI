/**
 * Custodial key management. The platform holds each DID's 32-byte Ed25519 seed
 * encrypted at rest (AES-256-GCM under DID_MASTER_KEY) and reconstructs the
 * keypair on demand via `didKeyFromSeed` — no KeyObject is ever serialized.
 * The org's key signs OrganizationMembership VCs on its behalf.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { didKeyFromSeed, issueCredential, type DidKey } from "@tokenlayer/core";

const IV_LEN = 12; // AES-GCM standard nonce length
const TAG_LEN = 16;
const MEMBERSHIP_TTL_SECONDS = 365 * 24 * 3600;

export interface MembershipInput {
  orgEncSeed: string;
  orgDid: string;
  userDid: string;
  /** { organization, orgId, role, memberSince } — merged into credentialSubject. */
  claims: Record<string, unknown>;
  /** Unix seconds. */
  now: number;
}

export interface Keystore {
  newSeed(): Buffer;
  encryptSeed(seed: Buffer): string;
  decryptSeed(enc: string): Buffer;
  keyOf(enc: string): DidKey;
  issueMembershipCredential(input: MembershipInput): { vcJwt: string; expiresAt: number };
}

/** Build a keystore bound to a 32-byte master key (hex, 64 chars). */
export function createKeystore(masterKeyHex: string): Keystore {
  const key = Buffer.from(masterKeyHex, "hex");
  if (key.length !== 32) throw new Error("DID master key must be 32 bytes (64 hex chars)");

  const newSeed = (): Buffer => randomBytes(32);

  const encryptSeed = (seed: Buffer): string => {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(seed), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  };

  const decryptSeed = (enc: string): Buffer => {
    const buf = Buffer.from(enc, "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  };

  const keyOf = (enc: string): DidKey => didKeyFromSeed(decryptSeed(enc));

  const issueMembershipCredential = ({ orgEncSeed, orgDid, userDid, claims, now }: MembershipInput): { vcJwt: string; expiresAt: number } => {
    const orgKey = keyOf(orgEncSeed);
    const expiresAt = now + MEMBERSHIP_TTL_SECONDS;
    const vcJwt = issueCredential({
      issuerDid: orgDid, issuerKey: orgKey.privateKey, subjectDid: userDid,
      claims, expiresAt, now, type: ["VerifiableCredential", "OrganizationMembership"],
    });
    return { vcJwt, expiresAt };
  };

  return { newSeed, encryptSeed, decryptSeed, keyOf, issueMembershipCredential };
}
