import { describe, expect, it } from "vitest";
import { decodeJwt, publicKeyFromDidKey, verifyJwtSignature } from "@tokenlayer/core";
import { createKeystore } from "../src/keystore.js";

const MASTER = "11".repeat(32); // 32 bytes of 0x11, hex

describe("keystore", () => {
  it("round-trips an encrypted seed and yields a stable DID", () => {
    const ks = createKeystore(MASTER);
    const seed = ks.newSeed();
    const enc = ks.encryptSeed(seed);
    expect(ks.decryptSeed(enc).equals(seed)).toBe(true);
    expect(ks.keyOf(enc).did).toBe(ks.keyOf(enc).did); // deterministic
    expect(ks.keyOf(enc).did.startsWith("did:key:z")).toBe(true);
  });

  it("produces distinct ciphertexts for the same seed (random IV)", () => {
    const ks = createKeystore(MASTER);
    const seed = ks.newSeed();
    expect(ks.encryptSeed(seed)).not.toBe(ks.encryptSeed(seed));
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const ks = createKeystore(MASTER);
    const enc = ks.encryptSeed(ks.newSeed());
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => ks.decryptSeed(buf.toString("base64"))).toThrow();
  });

  it("issues a membership VC signed by the org DID and bound to the member", () => {
    const ks = createKeystore(MASTER);
    const orgEnc = ks.encryptSeed(ks.newSeed());
    const org = ks.keyOf(orgEnc);
    const member = ks.keyOf(ks.encryptSeed(ks.newSeed()));
    const now = 1_800_000_000;
    const { vcJwt, expiresAt } = ks.issueMembershipCredential({
      orgEncSeed: orgEnc, orgDid: org.did, userDid: member.did,
      claims: { organization: "Acme Bank", orgId: "org_1", role: "Issuer", memberSince: "2026-07-11" }, now,
    });
    expect(verifyJwtSignature(vcJwt, publicKeyFromDidKey(org.did))).toBe(true);
    const { payload } = decodeJwt(vcJwt);
    const vc = payload.vc as { type: string[]; credentialSubject: { id: string; role: string } };
    expect(vc.type).toContain("OrganizationMembership");
    expect(vc.credentialSubject.id).toBe(member.did);
    expect(vc.credentialSubject.role).toBe("Issuer");
    expect(expiresAt).toBe(now + 365 * 24 * 3600);
  });

  it("throws on a master key that is not 32 bytes", () => {
    expect(() => createKeystore("abcd")).toThrow();
  });
});
