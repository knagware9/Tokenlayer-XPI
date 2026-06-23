import { describe, it, expect } from "vitest";
import { InMemoryAssetRepository } from "../src/persistence/memory.js";

const base = {
  id: "a1", useCaseKey: "carbon-credit", name: "X", symbol: "X", chainId: "besu",
  contractRef: "ref", tokenType: "fungible" as const, tokenStandard: "ERC-20" as const,
  metadata: {}, status: "active", createdBy: "u1",
  unitPrice: null, currency: null, treasuryAccount: null,
};

describe("AssetRepository sale terms", () => {
  it("defaults sale terms to null and sets them", async () => {
    const repo = new InMemoryAssetRepository();
    const a = await repo.create(base);
    expect(a.unitPrice).toBeNull();
    await repo.setSaleTerms("a1", { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: "0xT" });
    const got = await repo.get("a1");
    expect(got).toMatchObject({ unitPrice: "5", currency: "CBDC-INR", treasuryAccount: "0xT" });
  });
});
