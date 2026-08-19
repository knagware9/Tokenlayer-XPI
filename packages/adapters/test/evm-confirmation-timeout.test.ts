/**
 * A CHAIN THAT STOPS MINING MUST NOT HANG THE CALLER.
 *
 * `sendTx` awaited `tx.wait()` with no bound. When Besu lost QBFT consensus the
 * HTTP request never returned, the browser spinner never cleared, and the
 * transaction was invisible because its hash was never surfaced. The hash is
 * exactly what makes it recoverable, so a timeout must RETURN it, not throw.
 */
import { describe, expect, it } from "vitest";
import type { TokenStandard } from "@tokenlayer/core";
import { EvmLedgerAdapter, waitForReceipt, type EvmArtifact } from "../src/evm-adapter.js";
import { HARDHAT_OPERATOR_KEY } from "../src/testing/local-chain.js";

describe("bounded confirmation", () => {
  it("returns the receipt when it arrives in time", async () => {
    const tx = { hash: "0xaaa", wait: async () => ({ blockNumber: 42 }) };
    expect(await waitForReceipt(tx, 1, 1000)).toEqual({ blockNumber: 42 });
  });

  it("returns null — not a throw — when the wait exceeds the budget", async () => {
    const never = { hash: "0xbbb", wait: () => new Promise<never>(() => {}) };
    expect(await waitForReceipt(never, 1, 50)).toBeNull();
  });

  it("propagates a genuine revert rather than swallowing it as a timeout", async () => {
    // A reverted transaction is a real answer and must not be reported as
    // "unknown" — the two lead to opposite operator decisions.
    const reverted = { hash: "0xccc", wait: async () => { throw new Error("execution reverted"); } };
    await expect(waitForReceipt(reverted, 1, 1000)).rejects.toThrow("execution reverted");
  });

  it("does not leave an unhandled rejection when the abandoned wait() later rejects", async () => {
    // Promise.race doesn't cancel the loser. If the timeout wins and the real
    // wait() later rejects with nothing listening, Node would report an
    // unhandled rejection. Assert none is reported for the duration of this test.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const lateReject = { hash: "0xeee", wait: () => new Promise<never>((_r, reject) => setTimeout(() => reject(new Error("late revert")), 30)) };
      expect(await waitForReceipt(lateReject, 1, 5)).toBeNull();
      // Give the abandoned wait() promise time to reject and be (silently) caught.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

// A minimal, structurally-valid artifact set. getReceipt never deploys or calls a
// contract, so these values are never dereferenced — only the shape matters for
// the constructor's type.
const artifacts: Record<TokenStandard, EvmArtifact> = {
  "ERC-20": { abi: [], bytecode: "0x" },
  "ERC-721": { abi: [], bytecode: "0x" },
  "ERC-3643": { abi: [], bytecode: "0x" },
};

type ReceiptStub = { getTransactionReceipt: (hash: string) => Promise<{ blockNumber: number; status: number | null } | null> };

/**
 * Builds a real EvmLedgerAdapter and swaps its private `provider` field for a
 * stub we control, so `getReceipt` is exercised end-to-end rather than via a
 * bare mock that never touches the method under test. `provider` is private —
 * this cast is narrowly scoped to test setup only.
 */
function adapterWithStubProvider(stub: ReceiptStub): EvmLedgerAdapter {
  const adapter = new EvmLedgerAdapter({
    chainId: "test-evm",
    rpcUrl: "http://127.0.0.1:1", // never dialed — provider is swapped below
    privateKey: HARDHAT_OPERATOR_KEY,
    artifacts,
  });
  (adapter as unknown as { provider: ReceiptStub }).provider = stub;
  return adapter;
}

describe("EvmLedgerAdapter#getReceipt", () => {
  it("reports a missing receipt as null, not as a revert", async () => {
    // The confirmer must be able to tell "not mined yet" from "reverted"; if
    // absence read as failure, a pending mint would be marked failed and re-issued.
    const adapter = adapterWithStubProvider({ getTransactionReceipt: async () => null });
    expect(await adapter.getReceipt("0xdead")).toBeNull();
  });

  it("reports a confirmed receipt with blockNumber and status 1", async () => {
    const adapter = adapterWithStubProvider({ getTransactionReceipt: async () => ({ blockNumber: 12, status: 1 }) });
    expect(await adapter.getReceipt("0xbeef")).toEqual({ blockNumber: 12, status: 1 });
  });

  it("reports a reverted receipt as status 0 — final and distinct from null", async () => {
    const adapter = adapterWithStubProvider({ getTransactionReceipt: async () => ({ blockNumber: 12, status: 0 }) });
    expect(await adapter.getReceipt("0xf00d")).toEqual({ blockNumber: 12, status: 0 });
  });

  it("never defaults a missing status to success", async () => {
    // A mined receipt with no status field is itself an unresolved outcome. If it
    // were coerced to 1, a genuinely ambiguous receipt would read as "confirmed
    // ok" — exactly the optimism this whole task exists to remove.
    const adapter = adapterWithStubProvider({ getTransactionReceipt: async () => ({ blockNumber: 12, status: null }) });
    expect(await adapter.getReceipt("0xface")).toEqual({ blockNumber: 12, status: undefined });
  });
});
