import { describe, expect, it } from "vitest";
import { MemoryAssetRepository } from "../src/persistence/memory/index.js";
import type { AssetDueDiligence, AssetRecord } from "../src/persistence/types/index.js";

const baseInput = (over: Partial<AssetRecord> = {}): Omit<AssetRecord, "createdAt"> => ({
  id: "a1", useCaseKey: "carbon-credit", name: "T", symbol: "T", chainId: "fabric",
  contractRef: "0xref", tokenType: "fungible", tokenStandard: "ERC-20",
  metadata: {}, status: "pending_approval", createdBy: "u1",
  unitPrice: null, currency: null, treasuryAccount: null, uniqueKey: null,
  ...over,
});

describe("AssetRepository.setDueDiligence", () => {
  it("MemoryAssetRepository: create() with no dueDiligence stores null; setDueDiligence() then updates it", async () => {
    const assets = new MemoryAssetRepository();
    const created = await assets.create(baseInput());
    expect(created.dueDiligence).toBeNull();

    const dd: AssetDueDiligence = {
      prospectus: { id: "doc1", sha256: "0xabc" },
      riskTier: "low",
      pendingInitialSupply: "1000",
      pendingSale: { unitPrice: "5", currency: "CBDC-INR" },
    };
    await assets.setDueDiligence("a1", dd);
    const after = await assets.get("a1");
    expect(after?.dueDiligence).toEqual(dd);
  });

  it("MemoryAssetRepository: create() with dueDiligence already set stores it verbatim", async () => {
    const assets = new MemoryAssetRepository();
    const dd: AssetDueDiligence = { legalOpinion: { id: "doc2", sha256: "0xdef" } };
    const created = await assets.create(baseInput({ dueDiligence: dd }));
    expect(created.dueDiligence).toEqual(dd);
  });
});
