import { describe, it, expect } from "vitest";
import {
  generateDidKey,
  didKeyFromPublicKey,
  publicKeyFromDidKey,
  signJwt,
  verifyJwtSignature,
  decodeJwt,
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
});
