import { describe, it, expect } from "vitest";
import { backfillTreasuries } from "../src/shared/treasury-backfill.js";
import { MemoryUseCaseRepository, MemoryOrganizationRepository, MemoryAccountRepository } from "../src/persistence/memory/index.js";
import { createKeystore } from "../src/shared/keystore.js";
import type { UseCaseDefinition } from "@tokenlayer/core";

/** A minimal but fully valid use-case definition, missing ownerOrgId/treasuryAccountId —
 *  the shape every use case created before org-owned treasuries had. */
function legacyUseCase(key: string, name: string, symbol: string): UseCaseDefinition {
  return {
    key, name, symbol, tokenStandard: "ERC-20", tokenType: "fungible",
    allowedChainIds: ["fabric"], defaultChainId: "fabric",
    metadataSchema: { type: "object", properties: {} },
    lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
    compliance: { allowlist: false, transferRestrictions: false },
    roles: ["UseCaseAdmin"],
    ownerOrgId: "", // Task 1's transitional migration default
  } as UseCaseDefinition;
}

describe("backfillTreasuries", () => {
  it("assigns an owner and a treasury to a use case that predates both", async () => {
    const useCases = new MemoryUseCaseRepository();
    const organizations = new MemoryOrganizationRepository();
    const accounts = new MemoryAccountRepository();
    const keystore = createKeystore("11".repeat(32));
    await useCases.create(legacyUseCase("legacy-uc", "Legacy", "LEG"));

    const result = await backfillTreasuries({ useCases, organizations, accounts, keystore, registry: undefined });
    expect(result.ownersAssigned).toBe(1);
    expect(result.treasuriesAssigned).toBe(1);

    const uc = await useCases.get("legacy-uc");
    expect(uc.ownerOrgId).not.toBe("");
    expect(uc.treasuryAccountId).not.toBeUndefined();

    const treasury = uc.treasuryAccountId ? await accounts.findById(uc.treasuryAccountId) : null;
    expect(treasury?.ownerOrgId).toBe(uc.ownerOrgId);
  });

  it("is idempotent", async () => {
    const useCases = new MemoryUseCaseRepository();
    const organizations = new MemoryOrganizationRepository();
    const accounts = new MemoryAccountRepository();
    const keystore = createKeystore("11".repeat(32));
    await useCases.create(legacyUseCase("legacy-uc-2", "Legacy 2", "LG2"));

    await backfillTreasuries({ useCases, organizations, accounts, keystore, registry: undefined });
    const second = await backfillTreasuries({ useCases, organizations, accounts, keystore, registry: undefined });
    expect(second.ownersAssigned).toBe(0);
    expect(second.treasuriesAssigned).toBe(0);
  });

  it("leaves a use case that already has both alone — a second run touches nothing further", async () => {
    const useCases = new MemoryUseCaseRepository();
    const organizations = new MemoryOrganizationRepository();
    const accounts = new MemoryAccountRepository();
    const keystore = createKeystore("11".repeat(32));
    await useCases.create(legacyUseCase("legacy-uc-3", "Legacy 3", "LG3"));

    const first = await backfillTreasuries({ useCases, organizations, accounts, keystore, registry: undefined });
    expect(first.ownersAssigned).toBe(1);
    expect(first.treasuriesAssigned).toBe(1);
    const afterFirst = await useCases.get("legacy-uc-3");

    await backfillTreasuries({ useCases, organizations, accounts, keystore, registry: undefined });
    const afterSecond = await useCases.get("legacy-uc-3");
    expect(afterSecond.ownerOrgId).toBe(afterFirst.ownerOrgId);
    expect(afterSecond.treasuryAccountId).toBe(afterFirst.treasuryAccountId);
  });

  it("does not touch a use case that already has both an owner and a treasury", async () => {
    const useCases = new MemoryUseCaseRepository();
    const organizations = new MemoryOrganizationRepository();
    const accounts = new MemoryAccountRepository();
    const keystore = createKeystore("11".repeat(32));
    const existingAccount = await accounts.upsert("0xexisting", "pre-existing treasury", "org_pre_existing");
    await useCases.create({
      ...legacyUseCase("already-owned", "Already Owned", "OWN"),
      ownerOrgId: "org_pre_existing",
      treasuryAccountId: existingAccount.id,
    });

    const result = await backfillTreasuries({ useCases, organizations, accounts, keystore, registry: undefined });
    expect(result.ownersAssigned).toBe(0);
    expect(result.treasuriesAssigned).toBe(0);

    const uc = await useCases.get("already-owned");
    expect(uc.ownerOrgId).toBe("org_pre_existing");
    expect(uc.treasuryAccountId).toBe(existingAccount.id);
  });
});
