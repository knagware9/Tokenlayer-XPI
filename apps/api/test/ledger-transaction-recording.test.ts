/**
 * EVERY CHAIN WRITE LEAVES A ROW, and a receipt without a block number is
 * recorded as PENDING rather than assumed good. This is the seam that made the
 * invoice mint invisible: the adapter returned, the asset was marked active,
 * and nothing recorded that a transaction was outstanding.
 */
import { describe, expect, it } from "vitest";
import { MemoryLedgerTransactionRepository } from "../src/persistence/memory/index.js";
import { recordSubmission } from "../src/shared/ledger-transactions.js";

describe("recordSubmission", () => {
  it("records a confirmed receipt as confirmed", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await recordSubmission({ ledgerTransactions }, "mint", {
      txHash: "0x1", chainId: "besu", blockNumber: 9, timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(rec.status).toBe("confirmed");
    expect(rec.blockNumber).toBe(9);
  });

  it("records a receipt with NO block number as pending", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await recordSubmission({ ledgerTransactions }, "mint", {
      txHash: "0x2", chainId: "besu", timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(rec.status).toBe("pending");
    expect(rec.blockNumber).toBeNull();
  });

  it("is idempotent on (chainId, txHash)", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const r = { txHash: "0x3", chainId: "besu", timestamp: "2026-08-18T10:00:00.000Z" };
    const a = await recordSubmission({ ledgerTransactions }, "mint", r, { assetId: "a1" });
    const b = await recordSubmission({ ledgerTransactions }, "mint", r, { assetId: "a1" });
    expect(b.id).toBe(a.id);
  });

  it("a simulated chain's instant receipt is confirmed, not pending", async () => {
    // Simulated adapters genuinely finalise on return. Recording them as pending
    // would fill the confirmer's queue with rows no chain can ever answer for.
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await recordSubmission({ ledgerTransactions }, "mint", {
      txHash: "sim:abc", chainId: "fabric", blockNumber: 1, timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(rec.status).toBe("confirmed");
  });

  // RULING M: a row labelled "freeze" that was actually an unfreeze is a false
  // record, same class of bug as an unconfirmed tx marked "active" — the kind
  // recorded must match the direction of the setFrozen call, not just its family.
  it("records a freeze as kind freeze and an unfreeze as kind unfreeze", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const freezeRec = await recordSubmission({ ledgerTransactions }, "freeze", {
      txHash: "0x4", chainId: "besu", blockNumber: 3, timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(freezeRec.kind).toBe("freeze");

    const unfreezeRec = await recordSubmission({ ledgerTransactions }, "unfreeze", {
      txHash: "0x5", chainId: "besu", blockNumber: 4, timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(unfreezeRec.kind).toBe("unfreeze");
  });
});
