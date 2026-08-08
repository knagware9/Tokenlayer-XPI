import { describe, expect, it } from "vitest";
import { MemoryOrganizationRepository } from "../src/persistence/memory.js";

describe("Organization.capabilities persistence (EN-A task A2)", () => {
  it("create stores an explicit envelope; setCapabilities replaces it; null round-trips", async () => {
    const repo = new MemoryOrganizationRepository();
    const base = {
      name: "Caps Org",
      orgType: "corporate" as const,
      registrationId: null,
      jurisdiction: null,
      did: "did:key:zCaps",
      didSeedEncrypted: "enc",
      status: "active" as const,
      verified: false,
      verifiedAt: null,
      companyProfile: null,
      capabilities: { domains: ["identity" as const], roles: ["Issuer" as const] },
    };
    const o = await repo.create(base);
    expect(o.capabilities).toEqual({ domains: ["identity"], roles: ["Issuer"] });

    // Replace with an all-empty envelope — "everything off" is distinct from null.
    const tightened = await repo.setCapabilities(o.id, { domains: [], roles: [] });
    expect(tightened.capabilities).toEqual({ domains: [], roles: [] });

    // Clearing back to null restores the unrestricted-legacy sentinel.
    const cleared = await repo.setCapabilities(o.id, null);
    expect(cleared.capabilities).toBeNull();
  });
});
