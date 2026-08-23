import { describe, expect, it } from "vitest";
import { MemoryUseCaseRepository, MemoryOrganizationRepository, MemoryAccountRepository } from "../src/persistence/memory/index.js";
import { seedUseCases } from "../src/tokenization/use-cases.js";
import { ensurePlatformIssuerOrg } from "../src/shared/platform-org.js";
import { provisionTreasury } from "../src/shared/wallets.js";
import { createKeystore } from "../src/shared/keystore.js";

describe("seedUseCases — every platform-seeded use case gets an owner and a treasury", () => {
  it("stamps the Platform org and a provisioned treasury on every seeded use case", async () => {
    const useCases = new MemoryUseCaseRepository();
    const organizations = new MemoryOrganizationRepository();
    const accounts = new MemoryAccountRepository();
    const keystore = createKeystore("11".repeat(32));
    const platformOrg = await ensurePlatformIssuerOrg({ organizations, keystore, registry: undefined });
    await seedUseCases(useCases, platformOrg.id, (label) => provisionTreasury({ accounts }, platformOrg.id, label));
    const carbon = await useCases.get("carbon-credit");
    expect(carbon.ownerOrgId).toBe(platformOrg.id);
    expect(carbon.treasuryAccountId).not.toBeUndefined();
    const acct = await accounts.findById(carbon.treasuryAccountId!);
    expect(acct?.ownerOrgId).toBe(platformOrg.id);
  });
});
