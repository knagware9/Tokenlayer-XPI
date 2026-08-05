import { describe, expect, it } from "vitest";
import { resolveDid } from "../src/did-resolver.js";
import { generateDidKey } from "@tokenlayer/core";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";

describe("resolveDid", () => {
  const did = generateDidKey().did; // valid did:key ed25519

  it("resolves a valid did:key off-chain (no registry)", async () => {
    const res = await resolveDid(did, {});
    expect(res.didResolutionMetadata.error).toBeUndefined();
    expect(res.didDocument?.id).toBe(did);
    expect(res.didDocument?.verificationMethod[0]).toEqual({
      id: `${did}#0`, type: "Ed25519VerificationKey2020", controller: did,
      publicKeyMultibase: did.slice("did:key:".length),
    });
    expect(res.didDocument?.authentication).toEqual([`${did}#0`]);
    expect(res.didDocumentMetadata).toEqual({ source: "off-chain" });
  });

  it("returns invalidDid for a non-DID string and a malformed did:key", async () => {
    for (const bad of ["not-a-did", "did:key:zzz-bad-multibase"]) {
      const res = await resolveDid(bad, {});
      expect(res.didResolutionMetadata.error).toBe("invalidDid");
      expect(res.didDocument).toBeNull();
    }
  });

  it("returns methodNotSupported for another DID method", async () => {
    const res = await resolveDid("did:web:example.com", {});
    expect(res.didResolutionMetadata.error).toBe("methodNotSupported");
    expect(res.didDocument).toBeNull();
  });

  it("enriches from the registry: registered+active", async () => {
    const anchor = new FakeAnchor();
    const registry = fakeRegistry(anchor);
    await anchor.registerDid(registry.didRegistry, did);
    const res = await resolveDid(did, { registry });
    expect(res.didDocumentMetadata).toEqual({
      source: "chain", registered: true, active: true, deactivated: false,
      chainId: registry.chainId, registry: registry.didRegistry,
    });
  });

  it("reports deactivated for a deactivated DID", async () => {
    const anchor = new FakeAnchor();
    const registry = fakeRegistry(anchor);
    await anchor.registerDid(registry.didRegistry, did);
    await anchor.deactivateDid(registry.didRegistry, did);
    const res = await resolveDid(did, { registry });
    expect(res.didDocumentMetadata).toMatchObject({ source: "chain", registered: true, active: false, deactivated: true });
  });

  it("an unregistered DID resolves with registered:false (still source chain)", async () => {
    const res = await resolveDid(did, { registry: fakeRegistry(new FakeAnchor()) });
    expect(res.didDocumentMetadata).toMatchObject({ source: "chain", registered: false, active: false, deactivated: false });
  });

  it("falls back to off-chain when the registry read throws (no fabricated claims)", async () => {
    const anchor = new FakeAnchor();
    const registry = fakeRegistry(anchor);
    // FakeAnchor.didRegistration has no failNext hook — monkey-patch the instance:
    anchor.didRegistration = async () => { throw new Error("rpc down"); };
    let sawError: unknown = null;
    const res = await resolveDid(did, { registry, onChainError: (e) => { sawError = e; } });
    expect(res.didDocumentMetadata).toEqual({ source: "off-chain" });
    expect(sawError).toBeTruthy();
    expect(res.didDocument?.id).toBe(did); // document still resolves
  });
});
