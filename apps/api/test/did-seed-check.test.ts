import { describe, expect, it, vi } from "vitest";
import { checkDidSeedIntegrity } from "../src/shared/did-seed-check.js";
import { MemoryOrganizationRepository } from "../src/persistence/memory/index.js";
import { createKeystore } from "../src/shared/keystore.js";

const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);

describe("checkDidSeedIntegrity", () => {
  it("logs nothing for an org whose didSeedEncrypted decrypts to its own did under the live key", async () => {
    const organizations = new MemoryOrganizationRepository();
    const keystore = createKeystore(KEY_A);
    const seed = keystore.newSeed();
    const didSeedEncrypted = keystore.encryptSeed(seed);
    const did = keystore.keyOf(didSeedEncrypted).did;
    await organizations.create({
      name: "Healthy Org", orgType: "verifier", registrationId: null, jurisdiction: null,
      did, didSeedEncrypted, status: "active", verified: true, verifiedAt: null,
      companyProfile: null, capabilities: null, brandLogoDocumentId: null, brandAccent: null,
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await checkDidSeedIntegrity(organizations, keystore);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("logs a loud, attributable error for an org whose seed was encrypted under a DIFFERENT key (the stale-volume/key-mismatch case)", async () => {
    const organizations = new MemoryOrganizationRepository();
    const keystoreA = createKeystore(KEY_A);
    const seed = keystoreA.newSeed();
    const staleDidSeedEncrypted = keystoreA.encryptSeed(seed);
    const staleDid = keystoreA.keyOf(staleDidSeedEncrypted).did;
    await organizations.create({
      name: "Stale-Key Org", orgType: "verifier", registrationId: null, jurisdiction: null,
      did: staleDid, didSeedEncrypted: staleDidSeedEncrypted, status: "active", verified: true, verifiedAt: null,
      companyProfile: null, capabilities: null, brandLogoDocumentId: null, brandAccent: null,
    });

    // The process boots with a DIFFERENT live key than the one this org's seed was encrypted under.
    const keystoreB = createKeystore(KEY_B);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await checkDidSeedIntegrity(organizations, keystoreB);
    expect(spy).toHaveBeenCalledTimes(1);
    const message = spy.mock.calls[0]![0] as string;
    expect(message).toContain("Stale-Key Org");
    expect(message).toContain("will not decrypt");
    spy.mockRestore();
  });

  it("never throws — boot must proceed regardless", async () => {
    const organizations = new MemoryOrganizationRepository();
    const keystoreA = createKeystore(KEY_A);
    const seed = keystoreA.newSeed();
    const didSeedEncrypted = keystoreA.encryptSeed(seed);
    const did = keystoreA.keyOf(didSeedEncrypted).did;
    await organizations.create({
      name: "Stale-Key Org 2", orgType: "verifier", registrationId: null, jurisdiction: null,
      did, didSeedEncrypted, status: "active", verified: true, verifiedAt: null,
      companyProfile: null, capabilities: null, brandLogoDocumentId: null, brandAccent: null,
    });
    const keystoreB = createKeystore(KEY_B);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(checkDidSeedIntegrity(organizations, keystoreB)).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});
