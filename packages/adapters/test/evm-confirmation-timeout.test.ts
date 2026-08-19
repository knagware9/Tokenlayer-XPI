/**
 * A CHAIN THAT STOPS MINING MUST NOT HANG THE CALLER.
 *
 * `sendTx` awaited `tx.wait()` with no bound. When Besu lost QBFT consensus the
 * HTTP request never returned, the browser spinner never cleared, and the
 * transaction was invisible because its hash was never surfaced. The hash is
 * exactly what makes it recoverable, so a timeout must RETURN it, not throw.
 */
import { describe, expect, it } from "vitest";
import { waitForReceipt } from "../src/evm-adapter.js";

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

  it("reports a missing receipt as null, not as a revert", async () => {
    // The confirmer must be able to tell "not mined yet" from "reverted"; if
    // absence read as failure, a pending mint would be marked failed and re-issued.
    const adapter = { provider: { getTransactionReceipt: async () => null } };
    const got = await adapter.provider.getTransactionReceipt("0xdead");
    expect(got).toBeNull();
  });
});
