/**
 * The platform issuer org's on-chain DID registration must be self-healing:
 * if the best-effort registerDid fails on the FIRST boot (chain briefly
 * unreachable), a later boot must retry it — otherwise verifier flows that
 * trust issuers via the on-chain DidRegistry permanently reject this org.
 */
import { describe, expect, it } from "vitest";
import { createKeystore } from "../src/shared/keystore.js";
import { MemoryOrganizationRepository } from "../src/persistence/memory.js";
import { ensurePlatformIssuerOrg } from "../src/shared/platform-org.js";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";

function makeDeps(anchor: FakeAnchor) {
  return {
    organizations: new MemoryOrganizationRepository(),
    keystore: createKeystore("11".repeat(32)),
    registry: fakeRegistry(anchor),
  };
}

describe("ensurePlatformIssuerOrg on-chain DID registration", () => {
  it("retries registerDid on a later boot when the first attempt failed", async () => {
    const anchor = new FakeAnchor();
    const deps = makeDeps(anchor);

    // First boot: registerDid throws (chain briefly unreachable). Boot must not
    // fail, and the org's DID is left unregistered on-chain.
    anchor.failNext = "registerDid";
    const first = await ensurePlatformIssuerOrg(deps);
    expect(anchor.dids.has(first.did)).toBe(false);

    // Second boot: org already exists, but the chain is reachable now. The
    // stale unregistered DID must be retried and anchored.
    const second = await ensurePlatformIssuerOrg(deps);
    expect(second.did).toBe(first.did);
    expect(anchor.dids.get(second.did)).toBe(true);
  });

  it("does not re-register a DID that is already registered", async () => {
    const anchor = new FakeAnchor();
    const deps = makeDeps(anchor);

    const first = await ensurePlatformIssuerOrg(deps);
    expect(anchor.dids.get(first.did)).toBe(true);

    // A registered DID must not be written again on subsequent boots.
    anchor.failNext = "registerDid"; // would throw if registerDid were called
    const second = await ensurePlatformIssuerOrg(deps);
    expect(second.did).toBe(first.did);
    expect(anchor.dids.get(second.did)).toBe(true);
    expect(anchor.failNext).toBe("registerDid"); // untouched — no register attempted
  });
});
