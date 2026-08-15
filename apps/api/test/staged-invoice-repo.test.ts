import { describe, expect, it } from "vitest";
import { MemoryStagedInvoiceRepository } from "../src/persistence/memory/index.js";

describe("MemoryStagedInvoiceRepository", () => {
  it("creates, finds by hash, lists by status, marks tokenized, removes", async () => {
    const repo = new MemoryStagedInvoiceRepository();
    const rec = await repo.create({
      useCaseKey: "invoice-tokenization", source: "erp", metadata: { invoiceNumber: "A1" },
      invoiceHash: "0xabc", documentId: null, documentSha256: null, status: "staged",
      assetId: null, createdBy: "u1", tokenizedAt: null,
    });
    expect(rec.id).toBeTruthy();
    expect((await repo.findByHash("invoice-tokenization", "0xabc"))?.id).toBe(rec.id);
    expect(await repo.listByUseCase("invoice-tokenization", "staged")).toHaveLength(1);
    const tok = await repo.markTokenized(rec.id, "asset-1", "2026-07-21T00:00:00.000Z");
    expect(tok.status).toBe("tokenized");
    expect(tok.assetId).toBe("asset-1");
    expect(await repo.listByUseCase("invoice-tokenization", "staged")).toHaveLength(0);
    await repo.remove(rec.id);
    expect(await repo.get(rec.id)).toBeNull();
  });
});
