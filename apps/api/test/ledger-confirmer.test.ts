/**
 * RESOLVING WHAT THE CHAIN ACTUALLY DID.
 *
 * Mirrors webhooks/dispatcher.ts deliberately — listDue, CAS claim, backoff,
 * reclaimStale — because that pattern is already proven against two concurrent
 * instances and a second design would be drift.
 */
import { describe, expect, it } from "vitest";
import { MemoryLedgerTransactionRepository } from "../src/persistence/memory/index.js";
import { runConfirmerOnce } from "../src/shared/ledger-confirmer.js";

const at = (s: string) => `2026-08-18T10:00:0${s}.000Z`;

describe("the confirmer", () => {
  it("confirms a transaction the chain has mined", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await ledgerTransactions.record({ chainId: "besu", txHash: "0x1", kind: "mint", assetId: "a1", submittedAt: at("0") });
    await runConfirmerOnce(
      { ledgerTransactions },
      { workerId: "w1", now: at("1"), getReceipt: async () => ({ blockNumber: 12, status: 1 }) },
    );
    expect((await ledgerTransactions.findById(rec.id))?.status).toBe("confirmed");
    expect((await ledgerTransactions.findById(rec.id))?.blockNumber).toBe(12);
  });

  it("marks a reverted transaction failed", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await ledgerTransactions.record({ chainId: "besu", txHash: "0x2", kind: "mint", assetId: "a1", submittedAt: at("0") });
    await runConfirmerOnce(
      { ledgerTransactions },
      { workerId: "w1", now: at("1"), getReceipt: async () => ({ blockNumber: 12, status: 0 }) },
    );
    const out = await ledgerTransactions.findById(rec.id);
    expect(out?.status).toBe("failed");
  });

  it("defers — does NOT fail — a transaction with no receipt yet", async () => {
    // The stalled-chain case. Backing off leaves it recoverable; failing it
    // would invite a re-mint of a transaction that may still land.
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await ledgerTransactions.record({ chainId: "besu", txHash: "0x3", kind: "mint", assetId: "a1", submittedAt: at("0") });
    await runConfirmerOnce(
      { ledgerTransactions },
      { workerId: "w1", now: at("1"), getReceipt: async () => null },
    );
    const out = await ledgerTransactions.findById(rec.id);
    expect(out?.status).toBe("pending");
    expect(out?.attempts).toBe(1);
    expect(out?.claimedAt).toBeNull();
  });

  it("gives up into 'unknown' after the attempt ceiling, never into 'failed'", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await ledgerTransactions.record({ chainId: "besu", txHash: "0x4", kind: "mint", assetId: "a1", submittedAt: at("0") });
    for (let i = 0; i < 12; i++) {
      await runConfirmerOnce(
        { ledgerTransactions },
        { workerId: "w1", now: at("1"), getReceipt: async () => null, maxAttempts: 10 },
      );
    }
    const out = await ledgerTransactions.findById(rec.id);
    expect(out?.status).toBe("unknown");
  });
});
