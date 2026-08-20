/**
 * EVERY CHAIN WRITE LEAVES A ROW, and a receipt without a block number is
 * recorded as PENDING rather than assumed good. This is the seam that made the
 * invoice mint invisible: the adapter returned, the asset was marked active,
 * and nothing recorded that a transaction was outstanding.
 */
import { describe, expect, it } from "vitest";
import type { LedgerAdapter } from "@tokenlayer/core";
import { MemoryLedgerTransactionRepository } from "../src/persistence/memory/index.js";
import { recordSubmission } from "../src/shared/ledger-transactions.js";

/**
 * The only thing `recordSubmission` asks a chain is whether its adapter can be
 * POLLED — i.e. whether `getReceipt` exists. `pollable("besu")` stands for an
 * EVM adapter; `unpollable("fabric")` for the Fabric gateway and Canton JSON
 * API adapters, which have no `getReceipt` and never will.
 */
const pollable = (chainId: string) => ({
  resolveAdapter: (id: string) => {
    if (id !== chainId) throw new Error(`chain '${id}' is not configured`);
    return { chainId, getReceipt: async () => null } as unknown as LedgerAdapter;
  },
});
const unpollable = (chainId: string) => ({
  resolveAdapter: (id: string) => {
    if (id !== chainId) throw new Error(`chain '${id}' is not configured`);
    return { chainId } as unknown as LedgerAdapter;
  },
});
const chains = pollable("besu");

describe("recordSubmission", () => {
  it("records a confirmed receipt as confirmed", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await recordSubmission({ ledgerTransactions, chains }, "mint", {
      txHash: "0x1", chainId: "besu", blockNumber: 9, timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(rec.status).toBe("confirmed");
    expect(rec.blockNumber).toBe(9);
  });

  it("records a receipt with NO block number as pending", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await recordSubmission({ ledgerTransactions, chains }, "mint", {
      txHash: "0x2", chainId: "besu", timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(rec.status).toBe("pending");
    expect(rec.blockNumber).toBeNull();
  });

  it("is idempotent on (chainId, txHash)", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const r = { txHash: "0x3", chainId: "besu", timestamp: "2026-08-18T10:00:00.000Z" };
    const a = await recordSubmission({ ledgerTransactions, chains }, "mint", r, { assetId: "a1" });
    const b = await recordSubmission({ ledgerTransactions, chains }, "mint", r, { assetId: "a1" });
    expect(b.id).toBe(a.id);
  });

  it("a chain whose adapter cannot be polled is confirmed on return, with NO invented block number", async () => {
    // THE SHAPE A REAL FABRIC RECEIPT ACTUALLY HAS: txHash + chainId +
    // timestamp, and no blockNumber — FabricGatewayAdapter.submit and
    // CantonLedgerAdapter.exercise return exactly this. The earlier version of
    // this test hand-built one WITH `blockNumber: 1`, which no Fabric receipt
    // has ever carried, so it proved nothing and hid the real behaviour: the
    // row stayed pending, deferred ten times into `unknown`, and every
    // Fabric/Canton asset reported settlement "pending" forever while
    // /reconciliation called all of them drifted.
    //
    // The signal is the ADAPTER, not the receipt: no `getReceipt` means nobody
    // can ever ask this chain again, so the submission is already final.
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await recordSubmission({ ledgerTransactions, chains: unpollable("fabric") }, "mint", {
      txHash: "fabric-tx-abc", chainId: "fabric", timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1", amount: "500" });
    expect(rec.status).toBe("confirmed");
    expect(rec.confirmedAt).toBe("2026-08-18T10:00:00.000Z");
    // No height is fabricated — the absence is the truth, and a made-up number
    // would be precisely the claim the database is not allowed to make.
    expect(rec.blockNumber).toBeNull();
    // And because it is confirmed, it counts toward believed supply and leaves
    // nothing outstanding, which is what ends the permanent-drift report.
    expect(await ledgerTransactions.settledSupply("a1")).toBe("500");
    expect(await ledgerTransactions.listByAsset("a1")).toEqual([]);
  });

  it("a receipt with no block number on a POLLABLE chain is still pending", async () => {
    // The mirror case, and the reason the rule keys on the adapter rather than
    // on "no blockNumber ⇒ finalised": an EVM send whose confirmation timed out
    // returns the same shape, and it is genuinely outstanding.
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await recordSubmission({ ledgerTransactions, chains: pollable("besu") }, "mint", {
      txHash: "0xtimedout", chainId: "besu", timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a2", amount: "500" });
    expect(rec.status).toBe("pending");
    expect(await ledgerTransactions.settledSupply("a2")).toBe("0");
  });

  it("a chain that is absent right now stays pending — ignorance is not finality", async () => {
    // resolveAdapter throws for an unconfigured chain (CHAIN_STRICT=0, an RPC
    // being restarted). Reading that as "cannot be polled, therefore confirmed"
    // would mark a transaction confirmed on no evidence at all.
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await recordSubmission({ ledgerTransactions, chains: pollable("besu") }, "mint", {
      txHash: "0xabsent", chainId: "mst", timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a3" });
    expect(rec.status).toBe("pending");
  });

  // RULING M: a row labelled "freeze" that was actually an unfreeze is a false
  // record, same class of bug as an unconfirmed tx marked "active" — the kind
  // recorded must match the direction of the setFrozen call, not just its family.
  it("records a freeze as kind freeze and an unfreeze as kind unfreeze", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const freezeRec = await recordSubmission({ ledgerTransactions, chains }, "freeze", {
      txHash: "0x4", chainId: "besu", blockNumber: 3, timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(freezeRec.kind).toBe("freeze");

    const unfreezeRec = await recordSubmission({ ledgerTransactions, chains }, "unfreeze", {
      txHash: "0x5", chainId: "besu", blockNumber: 4, timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(unfreezeRec.kind).toBe("unfreeze");
  });
});
