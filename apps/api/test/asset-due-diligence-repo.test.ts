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

  it("MemoryAssetRepository: setDueDiligence merges a patch rather than replacing the whole object", async () => {
    const assets = new MemoryAssetRepository();
    await assets.create(baseInput());
    await assets.setDueDiligence("a1", { prospectus: { id: "doc1", sha256: "0x1" } });
    await assets.setDueDiligence("a1", { riskTier: "low" });
    const after = await assets.get("a1");
    // The second call's patch must not have clobbered the first call's field —
    // this is exactly the lost-update shape the plan's final review flagged.
    expect(after?.dueDiligence).toEqual({ prospectus: { id: "doc1", sha256: "0x1" }, riskTier: "low" });
  });

  it("MemoryAssetRepository: appendAdditionalDocument appends without requiring the caller to read first", async () => {
    const assets = new MemoryAssetRepository();
    await assets.create(baseInput());
    await assets.appendAdditionalDocument("a1", { id: "doc1", sha256: "0x1", label: "Audit report" });
    await assets.appendAdditionalDocument("a1", { id: "doc2", sha256: "0x2", label: "Insurance cert" });
    const after = await assets.get("a1");
    expect(after?.dueDiligence?.additionalDocuments).toEqual([
      { id: "doc1", sha256: "0x1", label: "Audit report" },
      { id: "doc2", sha256: "0x2", label: "Insurance cert" },
    ]);
  });

  it("MemoryAssetRepository: a null in a patch clears that field without touching others", async () => {
    const assets = new MemoryAssetRepository();
    await assets.create(baseInput({ dueDiligence: { riskTier: "high", rejectionReason: "bad prospectus" } }));
    await assets.setDueDiligence("a1", { rejectionReason: null });
    const after = await assets.get("a1");
    expect(after?.dueDiligence).toEqual({ riskTier: "high", rejectionReason: null });
  });
});
