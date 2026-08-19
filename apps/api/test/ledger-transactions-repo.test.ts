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
});
