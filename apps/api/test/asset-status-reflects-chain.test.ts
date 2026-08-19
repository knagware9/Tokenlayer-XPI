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
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    await ledgerTransactions.record({ chainId: "besu", txHash: "0x1", kind: "deploy", assetId: "a1", submittedAt: "2026-08-18T10:00:00.000Z" });
    expect(await settlementStatus({ ledgerTransactions }, asset)).toBe("pending");
  });

  it("is pending — not active — when the outcome is unknown", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const r = await ledgerTransactions.record({ chainId: "besu", txHash: "0x2", kind: "deploy", assetId: "a1", submittedAt: "2026-08-18T10:00:00.000Z" });
    await ledgerTransactions.settle(r.id, { status: "unknown", error: "no receipt" });
    expect(await settlementStatus({ ledgerTransactions }, asset)).toBe("pending");
  });
});
