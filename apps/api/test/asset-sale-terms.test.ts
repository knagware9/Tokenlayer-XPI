import { describe, it, expect } from "vitest";
import { MemoryAssetRepository } from "../src/persistence/memory/index.js";

const base = {
  id: "a1", useCaseKey: "carbon-credit", name: "X", symbol: "X", chainId: "fabric",
  contractRef: "ref", tokenType: "fungible" as const, tokenStandard: "ERC-20" as const,
  metadata: {}, status: "active", createdBy: "u1",
  unitPrice: null, currency: null, treasuryAccount: null,
};

describe("AssetRepository sale terms", () => {
  it("defaults sale terms to null and sets them", async () => {
    const repo = new MemoryAssetRepository();
    const a = await repo.create(base);
    expect(a.unitPrice).toBeNull();
    await repo.setSaleTerms("a1", { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: "0xT" });
    const got = await repo.get("a1");
    expect(got).toMatchObject({ unitPrice: "5", currency: "CBDC-INR", treasuryAccount: "0xT" });
  });
});
