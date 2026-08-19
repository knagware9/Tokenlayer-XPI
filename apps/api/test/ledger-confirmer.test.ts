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
    // Backoff means a fixed `now` would never come due twice — a real poller
    // advances real time, so this test advances a logical clock instead, by a
    // day each pass. A day comfortably clears the largest backoff maxAttempts=10
    // can ever produce (5000ms * 2^8 ≈ 21.3 minutes, the last delay before the
    // ceiling fires), so every pass here genuinely finds the row due, mirroring
    // what a live poller would see over the same span of wall-clock time.
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await ledgerTransactions.record({ chainId: "besu", txHash: "0x4", kind: "mint", assetId: "a1", submittedAt: at("0") });
    let nowMs = Date.parse(at("1"));
    for (let i = 0; i < 12; i++) {
      await runConfirmerOnce(
        { ledgerTransactions },
        { workerId: "w1", now: new Date(nowMs).toISOString(), getReceipt: async () => null, maxAttempts: 10 },
      );
      nowMs += 24 * 60 * 60_000; // +1 day
    }
    const out = await ledgerTransactions.findById(rec.id);
    expect(out?.status).toBe("unknown");
    // The distinction is load-bearing: `failed` says the chain reverted it,
    // which would send an operator to re-mint a transaction that may still land.
    expect(out?.status).not.toBe("failed");
  });

  it("backs off with a growing delay — a stalled chain is not re-polled every tick", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await ledgerTransactions.record({ chainId: "besu", txHash: "0x5", kind: "mint", assetId: "a1", submittedAt: at("0") });

    const firstNow = at("1");
    await runConfirmerOnce({ ledgerTransactions }, { workerId: "w1", now: firstNow, getReceipt: async () => null });
    const afterFirst = await ledgerTransactions.findById(rec.id);
    // Deferred strictly INTO THE FUTURE relative to the poll that found nothing
    // — the row must not be immediately due again on the very next tick.
    const delay1 = Date.parse(afterFirst!.nextAttemptAt) - Date.parse(firstNow);
    expect(delay1).toBeGreaterThan(0);

    // Advance just past the first backoff window so the row is due again, then
    // poll a second time.
    const secondNow = new Date(Date.parse(afterFirst!.nextAttemptAt) + 1).toISOString();
    await runConfirmerOnce({ ledgerTransactions }, { workerId: "w1", now: secondNow, getReceipt: async () => null });
    const afterSecond = await ledgerTransactions.findById(rec.id);
    const delay2 = Date.parse(afterSecond!.nextAttemptAt) - Date.parse(secondNow);

    // GROWING: the second silent poll backs off further than the first did.
    expect(delay2).toBeGreaterThan(delay1);
  });
});
