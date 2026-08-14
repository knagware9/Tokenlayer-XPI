import { describe, expect, it } from "vitest";
import { sign as edSign } from "node:crypto";
import { generateDidKey, verifyDidSignature } from "../src/identity/did-vc.js";

const b64u = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("verifyDidSignature", () => {
  it("accepts a valid Ed25519 signature over the message", () => {
    const { did, privateKey } = generateDidKey();
    const msg = "qr-login:sess-1:chal-abc";
    const sig = b64u(edSign(null, Buffer.from(msg, "utf8"), privateKey));
    expect(verifyDidSignature(did, msg, sig)).toBe(true);
  });
  it("rejects a signature over a different message", () => {
    const { did, privateKey } = generateDidKey();
    const sig = b64u(edSign(null, Buffer.from("qr-login:sess-1:chal-abc", "utf8"), privateKey));
    expect(verifyDidSignature(did, "qr-login:sess-1:chal-XXX", sig)).toBe(false);
  });
  it("rejects a signature from a different key", () => {
    const a = generateDidKey(); const b = generateDidKey();
    const msg = "qr-login:s:c";
    const sig = b64u(edSign(null, Buffer.from(msg, "utf8"), b.privateKey));
    expect(verifyDidSignature(a.did, msg, sig)).toBe(false);
  });
  it("returns false (no throw) for a malformed did or signature", () => {
    expect(verifyDidSignature("not-a-did", "m", "sig")).toBe(false);
    const { did, privateKey } = generateDidKey();
    expect(verifyDidSignature(did, "m", "!!!not-base64!!!")).toBe(false);
    void privateKey;
  });
});
