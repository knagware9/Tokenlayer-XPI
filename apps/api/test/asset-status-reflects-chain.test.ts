/**
 * AN ASSET IS NOT ACTIVE UNTIL ITS ISSUING TRANSACTION IS.
 *
 * The exact failure: INV-ERP-2026-206 read `status: "active"` while on-chain
 * supply was unchanged and the holder's balance was 0.
 */
import { describe, expect, it } from "vitest";
import { MemoryLedgerTransactionRepository } from "../src/persistence/memory/index.js";
import { settlementStatus } from "../src/tokenization/asset-settlement.js";

const asset = { id: "a1", status: "active" } as { id: string; status: string };

describe("settlementStatus", () => {
  it("is active when nothing is outstanding", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    expect(await settlementStatus({ ledgerTransactions }, asset)).toBe("active");
  });

  it("is pending while the issuing transaction is unconfirmed", async () => {
    // `kind: "mint"`, matching production: a `deploy` row is recorded with
    // `assetId: null` (RULING L — the deploy tx belongs to the USE-CASE
    // contract, not to whichever asset was issued into it first), so a deploy
    // row carrying an assetId is a shape this system never produces. An asset's
    // own outstanding state is carried by its own mint.
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    await ledgerTransactions.record({ chainId: "besu", txHash: "0x1", kind: "mint", assetId: "a1", submittedAt: "2026-08-18T10:00:00.000Z" });
    expect(await settlementStatus({ ledgerTransactions }, asset)).toBe("pending");
  });

  it("is pending — not active — when the outcome is unknown", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const r = await ledgerTransactions.record({ chainId: "besu", txHash: "0x2", kind: "mint", assetId: "a1", submittedAt: "2026-08-18T10:00:00.000Z" });
    await ledgerTransactions.settle(r.id, { status: "unknown", error: "no receipt" });
    expect(await settlementStatus({ ledgerTransactions }, asset)).toBe("pending");
  });

  it("is failed when the mint REVERTED, even though the asset row still says active", async () => {
    // RULING X. Nothing sets `Asset.status = "failed"`, so before this the
    // `failed` branch was unreachable: the confirmer settled the reverted mint
    // `failed`, `listByAsset` excludes failed rows, and the asset read back
    // `active`. Reconciliation could not see it either — believed 0, chain 0,
    // no drift — which is the ORIGINAL BUG reproduced for reverts.
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const r = await ledgerTransactions.record({ chainId: "besu", txHash: "0x3", kind: "mint", assetId: "a1", amount: "500", submittedAt: "2026-08-18T10:00:00.000Z" });
    await ledgerTransactions.settle(r.id, { status: "failed", blockNumber: 12, error: "reverted" });
    expect(asset.status).toBe("active"); // the register still claims it
    expect(await settlementStatus({ ledgerTransactions }, asset)).toBe("failed");
  });

  it("is pending — not failed — while a reverted mint sits beside one still in flight", async () => {
    // Precedence matters in this direction too: the chain is still deciding, and
    // calling the asset failed now invites a re-mint of something that may land.
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const reverted = await ledgerTransactions.record({ chainId: "besu", txHash: "0x4", kind: "mint", assetId: "a1", amount: "500", submittedAt: "2026-08-18T10:00:00.000Z" });
    await ledgerTransactions.settle(reverted.id, { status: "failed", error: "reverted" });
    await ledgerTransactions.record({ chainId: "besu", txHash: "0x5", kind: "mint", assetId: "a1", amount: "500", submittedAt: "2026-08-18T10:00:01.000Z" });
    expect(await settlementStatus({ ledgerTransactions }, asset)).toBe("pending");
  });
});
