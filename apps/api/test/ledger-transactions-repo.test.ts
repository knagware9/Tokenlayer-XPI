/**
 * THE DURABLE RECORD OF A LEDGER WRITE.
 *
 * The row exists so that "we asked the chain to do this" survives a crash, a
 * restart, and a chain that stops mining. The cases below are the ones that
 * actually bit: a transaction that never confirms must NOT read as failed, and
 * two confirmers must not both claim the same row.
 */
import { describe, expect, it } from "vitest";
import { MemoryLedgerTransactionRepository } from "../src/persistence/memory/index.js";

const base = { chainId: "besu", txHash: "0xabc", kind: "mint" as const, assetId: "a1" };
const at0 = "2026-08-18T10:00:00.000Z";

describe("LedgerTransactionRepository", () => {
  it("records a submission as pending", async () => {
    const repo = new MemoryLedgerTransactionRepository();
    const rec = await repo.record({ ...base, submittedAt: "2026-08-18T10:00:00.000Z" });
    expect(rec.status).toBe("pending");
    expect(rec.attempts).toBe(0);
    expect(rec.confirmedAt).toBeNull();
  });

  it("lists only rows that are due, oldest first", async () => {
    const repo = new MemoryLedgerTransactionRepository();
    const older = await repo.record({ ...base, txHash: "0x1", submittedAt: "2026-08-18T10:00:00.000Z" });
    await repo.record({ ...base, txHash: "0x2", submittedAt: "2026-08-18T10:00:01.000Z" });
    const settled = await repo.record({ ...base, txHash: "0x3", submittedAt: "2026-08-18T10:00:02.000Z" });
    await repo.settle(settled.id, { status: "confirmed", blockNumber: 7, confirmedAt: "2026-08-18T10:00:03.000Z" });

    const due = await repo.listDue("2026-08-18T11:00:00.000Z", 10);
    expect(due.map((r) => r.txHash)).toEqual(["0x1", "0x2"]);
    expect(due[0]!.id).toBe(older.id);
  });

  it("CAS claim: the second claimer gets null", async () => {
    // Without this two confirmers double-poll the same hash and race on settle.
    const repo = new MemoryLedgerTransactionRepository();
    const rec = await repo.record({ ...base, submittedAt: "2026-08-18T10:00:00.000Z" });
    const first = await repo.claim(rec.id, "worker-a", "2026-08-18T10:00:01.000Z");
    const second = await repo.claim(rec.id, "worker-b", "2026-08-18T10:00:02.000Z");
    expect(first?.claimedBy).toBe("worker-a");
    expect(second).toBeNull();
  });

  it("an unconfirmed transaction is 'unknown', NEVER 'failed'", async () => {
    // The distinction is the whole point. A submitted mint whose receipt we
    // cannot obtain may still land; calling it failed invites a re-mint and
    // double-issuance.
    const repo = new MemoryLedgerTransactionRepository();
    const rec = await repo.record({ ...base, submittedAt: "2026-08-18T10:00:00.000Z" });
    const out = await repo.settle(rec.id, { status: "unknown", error: "no receipt within 30000ms" });
    expect(out.status).toBe("unknown");
    expect(out.confirmedAt).toBeNull();
  });

  it("reclaims a claim left behind by a crashed worker", async () => {
    const repo = new MemoryLedgerTransactionRepository();
    const rec = await repo.record({ ...base, submittedAt: "2026-08-18T10:00:00.000Z" });
    await repo.claim(rec.id, "worker-a", "2026-08-18T10:00:01.000Z");
    const n = await repo.reclaimStale("2026-08-18T10:05:00.000Z");
    expect(n).toBe(1);
    const due = await repo.listDue("2026-08-18T10:06:00.000Z", 10);
    expect(due.map((r) => r.id)).toEqual([rec.id]);
  });

  it("derives believed supply from CONFIRMED mints and burns only", async () => {
    // Pending work must not count toward believed supply, or reconciliation
    // compares the chain against a number that includes what has not happened.
    const repo = new MemoryLedgerTransactionRepository();
    const minted = await repo.record({ ...base, txHash: "0xm", kind: "mint", amount: "500", submittedAt: at0 });
    await repo.settle(minted.id, { status: "confirmed", blockNumber: 1, confirmedAt: at0 });
    const burned = await repo.record({ ...base, txHash: "0xb", kind: "burn", amount: "200", submittedAt: at0 });
    await repo.settle(burned.id, { status: "confirmed", blockNumber: 2, confirmedAt: at0 });
    await repo.record({ ...base, txHash: "0xp", kind: "mint", amount: "999", submittedAt: at0 }); // still pending
    expect(await repo.settledSupply("a1")).toBe("300");
  });

  it("finds outstanding rows for one asset", async () => {
    const repo = new MemoryLedgerTransactionRepository();
    await repo.record({ ...base, txHash: "0x1", submittedAt: "2026-08-18T10:00:00.000Z" });
    const other = await repo.record({ ...base, assetId: "a2", txHash: "0x2", submittedAt: "2026-08-18T10:00:01.000Z" });
    await repo.settle(other.id, { status: "confirmed", blockNumber: 1, confirmedAt: "2026-08-18T10:00:02.000Z" });
    expect((await repo.listByAsset("a1")).map((r) => r.txHash)).toEqual(["0x1"]);
  });

  it("a fresh pending row is still returned by listDue when the table is full of unknown rows", async () => {
    // RULING AA: `listDue` is submittedAt-ASC with a limit of 25, and an
    // `unknown` row is both perpetually due and the OLDEST thing in the table.
    // Thirty of them fill every page forever, so a mint submitted a moment ago
    // is never polled and never confirms — the register's `settlement` stays
    // "pending" on work the chain finished. Settling to `unknown` therefore
    // pushes the row's next attempt well out.
    const repo = new MemoryLedgerTransactionRepository();
    for (let i = 0; i < 30; i++) {
      const old = await repo.record({ ...base, txHash: `0xold${i}`, submittedAt: `2026-08-18T10:00:${String(i).padStart(2, "0")}.000Z` });
      await repo.settle(old.id, { status: "unknown", error: "no receipt after 10 polls", nextAttemptAt: "2026-08-18T11:00:00.000Z" });
    }
    const fresh = await repo.record({ ...base, txHash: "0xfresh", submittedAt: "2026-08-18T10:30:00.000Z" });

    const due = await repo.listDue("2026-08-18T10:31:00.000Z", 25);
    expect(due.map((r) => r.id)).toContain(fresh.id);
  });

  it("settling to unknown defers the row even when the caller names no next attempt", async () => {
    // The repository, not just the confirmer, holds the rule — a second caller
    // settling `unknown` cannot reintroduce the starvation by omission.
    const repo = new MemoryLedgerTransactionRepository();
    const rec = await repo.record({ ...base, submittedAt: "2026-08-18T10:00:00.000Z" });
    const out = await repo.settle(rec.id, { status: "unknown", error: "no receipt" });
    expect(Date.parse(out.nextAttemptAt)).toBeGreaterThan(Date.parse(rec.nextAttemptAt));
    expect(await repo.listDue(rec.nextAttemptAt, 25)).toEqual([]);
  });

  it("counts rows by status, including the failed ones listByAsset hides", async () => {
    // What makes a reverted mint visible (settlementStatus) and what tells an
    // asset with no history apart from one that settled to zero (reconcile).
    const repo = new MemoryLedgerTransactionRepository();
    expect(await repo.countsByStatus("nobody")).toEqual({ pending: 0, confirmed: 0, failed: 0, unknown: 0 });

    const reverted = await repo.record({ ...base, txHash: "0xr", kind: "mint", amount: "500", submittedAt: at0 });
    await repo.settle(reverted.id, { status: "failed", blockNumber: 4, error: "reverted" });
    const good = await repo.record({ ...base, txHash: "0xg", kind: "mint", amount: "500", submittedAt: at0 });
    await repo.settle(good.id, { status: "confirmed", blockNumber: 5, confirmedAt: at0 });
    await repo.record({ ...base, txHash: "0xp2", kind: "mint", amount: "500", submittedAt: at0 });

    expect(await repo.countsByStatus("a1")).toEqual({ pending: 1, confirmed: 1, failed: 1, unknown: 0 });
    // The failed row is invisible to listByAsset — which is exactly why a
    // separate read was needed rather than counting what that returns.
    expect((await repo.listByAsset("a1")).map((r) => r.txHash)).toEqual(["0xp2"]);
  });
});
