import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { UseCaseDefinition } from "@tokenlayer/core";
import { MemoryUseCaseRepository, MemoryOrganizationRepository, MemoryAccountRepository } from "../src/persistence/memory/index.js";
import { seedUseCases } from "../src/tokenization/use-cases.js";
import { ensurePlatformIssuerOrg } from "../src/shared/platform-org.js";
import { backfillTreasuries } from "../src/shared/treasury-backfill.js";
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

describe("boot on an UPGRADED deployment — the gap seedUseCases deliberately leaves", () => {
  it("seedUseCases skips a pre-existing use case; the boot backfill is what gives it a treasury", async () => {
    const useCases = new MemoryUseCaseRepository();
    const organizations = new MemoryOrganizationRepository();
    const accounts = new MemoryAccountRepository();
    const keystore = createKeystore("11".repeat(32));
    const platformOrg = await ensurePlatformIssuerOrg({ organizations, keystore, registry: undefined });

    // A use case written by a PREVIOUS version of the API: it exists, so
    // seedUseCases `continue`s past it (correctly — re-seeding would clobber an
    // operator's edits), and it has no owner and no treasury.
    await useCases.create({
      key: "carbon-credit", name: "Carbon Credit", symbol: "VCU", tokenStandard: "ERC-20", tokenType: "fungible",
      allowedChainIds: ["fabric"], defaultChainId: "fabric",
      metadataSchema: { type: "object", properties: {} },
      lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
      compliance: { allowlist: false, transferRestrictions: false },
      roles: ["UseCaseAdmin"], ownerOrgId: "",
    } as UseCaseDefinition);

    await seedUseCases(useCases, platformOrg.id, (label) => provisionTreasury({ accounts }, platformOrg.id, label));
    const afterSeed = await useCases.get("carbon-credit");
    expect(afterSeed.ownerOrgId).toBe("");
    expect(afterSeed.treasuryAccountId).toBeUndefined();

    // The line server.ts now runs right after seedUseCases. Without it, every
    // issuance with supply or sale terms and every setPrice 400s
    // MISSING_TREASURY until an operator remembers a script.
    await backfillTreasuries({ useCases, accounts, organizations, keystore, registry: undefined });
    const afterBackfill = await useCases.get("carbon-credit");
    expect(afterBackfill.ownerOrgId).toBe(platformOrg.id);
    expect(afterBackfill.treasuryAccountId).toBeTruthy();
  });

  it("server.ts calls the backfill at boot, after seedUseCases, inside the tokenization guard", () => {
    // The wiring itself, asserted on the source: the behaviour above is only
    // worth anything if boot actually runs it. Same style as the other
    // source-level boundary tests in this suite.
    const src = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
    const seed = src.indexOf("await seedUseCases(");
    const guard = src.lastIndexOf('env.enabledDomains.includes("tokenization")', seed);
    const backfill = src.indexOf("await backfillTreasuries(");
    expect(guard).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(guard);
    expect(backfill).toBeGreaterThan(seed);
    // Still inside the same `if` block: nothing re-opens the guard between them.
    expect(src.slice(seed, backfill)).not.toContain("env.enabledDomains.includes(");
  });
});
