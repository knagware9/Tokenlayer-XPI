import { describe, expect, it } from "vitest";
import { GAS_MARGIN_PERCENT, SerialNonceSigner, withGasMargin } from "../src/evm-adapter.js";

/**
 * WHY THIS EXISTS — a real, reproduced production failure.
 *
 * Booting the API against live Besu, the `corporate-bond` use case (the only
 * ERC-3643 one) failed to deploy, every time, while every ERC-20 and ERC-721
 * use case deployed fine. The failing transaction was
 * `bindIdentityRegistry(address)` on a T-REX IdentityRegistryStorage PROXY.
 *
 * Replayed against the exact parent block, Besu contradicted itself:
 *
 *   eth_estimateGas          -> 110_159
 *   eth_call with 110_159    -> execution reverted
 *   binary search for the true minimum -> 113_520
 *
 * A T-REX proxy call is a nested CALL + DELEGATECALL. EIP-150 lets a frame
 * forward only 63/64 of its remaining gas, so the caller must HOLD gas it never
 * spends. Besu's estimate is consumption-based and cannot see that reserve, so
 * it under-reports by 3.1% here. ethers v6 then uses the estimate VERBATIM —
 * it adds no margin — and the transaction reverts.
 *
 * It never showed up in the adapter's own T-REX suite because that suite runs
 * against Hardhat (see `testing/local-chain.ts`), whose estimator is generous.
 * A green ERC-3643 integration test on Hardhat says nothing about Besu.
 *
 * These tests pin the margin with the MEASURED numbers, so the fix cannot be
 * quietly tuned back below the value that was actually observed to be needed.
 */
describe("withGasMargin", () => {
  it("covers the shortfall measured on Besu: 110159 estimated, 113520 truly required", () => {
    expect(withGasMargin(110_159n)).toBeGreaterThanOrEqual(113_520n);
  });

  it("is a proportional margin, not a flat addend — a big call needs a big reserve", () => {
    // The reserve a nested call must hold scales with the gas in flight, so a
    // fixed "+10k" would cover the small cases and under-cover the large ones.
    expect(withGasMargin(1_000_000n) - 1_000_000n).toBeGreaterThan(withGasMargin(100_000n) - 100_000n);
  });

  it("never returns less than the estimate, including at zero", () => {
    for (const est of [0n, 1n, 21_000n, 110_159n, 30_000_000n]) {
      expect(withGasMargin(est)).toBeGreaterThanOrEqual(est);
    }
  });

  it("stays within a sane bound — headroom, not a blank cheque", () => {
    // Unused gas is refunded, so a margin costs nothing at settlement; but the
    // limit is still checked against the sender's balance and the block, so it
    // must stay modest.
    expect(GAS_MARGIN_PERCENT).toBeGreaterThanOrEqual(10n);
    expect(GAS_MARGIN_PERCENT).toBeLessThanOrEqual(50n);
  });
});

/** Minimal stand-in for the wrapped signer: records what it was asked to send. */
function stubSigner(estimate: bigint) {
  const sent: Record<string, unknown>[] = [];
  const estimated: Record<string, unknown>[] = [];
  return {
    sent,
    estimated,
    signer: {
      getNonce: async () => 7,
      estimateGas: async (tx: Record<string, unknown>) => {
        estimated.push(tx);
        return estimate;
      },
      sendTransaction: async (tx: Record<string, unknown>) => {
        sent.push(tx);
        return { hash: "0xdeadbeef", wait: async () => ({}) };
      },
    },
  };
}

describe("SerialNonceSigner applies the margin (the wiring, not just the maths)", () => {
  it("sets gasLimit from the estimate PLUS the margin when the caller sets none", async () => {
    const stub = stubSigner(110_159n);
    const signer = new SerialNonceSigner(stub.signer as never);

    await signer.sendTransaction({ to: "0x" + "11".repeat(20), data: "0x690a49f9" });

    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]!.gasLimit).toBe(withGasMargin(110_159n));
    // The exact failure this fixes: sending 110_159 is what reverted on Besu.
    expect(stub.sent[0]!.gasLimit).toBeGreaterThanOrEqual(113_520n);
  });

  it("respects an explicit gasLimit and does not estimate at all", async () => {
    const stub = stubSigner(110_159n);
    const signer = new SerialNonceSigner(stub.signer as never);

    await signer.sendTransaction({ to: "0x" + "11".repeat(20), gasLimit: 500_000n });

    expect(stub.sent[0]!.gasLimit).toBe(500_000n);
    expect(stub.estimated).toHaveLength(0);
  });

  it("estimates the transaction it will SEND — nonce included, so the provider cache cannot cross-serve", async () => {
    // ethers memoises estimateGas for ~250ms keyed by the request payload. The
    // allowlist flow mints to a blocked account (refused), allows it, and mints
    // again — byte-identical calldata. Estimating without the nonce makes both
    // requests one cache entry, and the second inherits the first's REJECTION.
    const stub = stubSigner(21_000n);
    const signer = new SerialNonceSigner(stub.signer as never);

    await signer.sendTransaction({ to: "0x" + "11".repeat(20), data: "0xf76e8ba9" });
    await signer.sendTransaction({ to: "0x" + "11".repeat(20), data: "0xf76e8ba9" });

    expect(stub.estimated.map((t) => t.nonce)).toEqual([7, 8]);
  });

  it("still assigns serial nonces from the local counter", async () => {
    const stub = stubSigner(21_000n);
    const signer = new SerialNonceSigner(stub.signer as never);

    await signer.sendTransaction({ to: "0x" + "11".repeat(20) });
    await signer.sendTransaction({ to: "0x" + "11".repeat(20) });

    expect(stub.sent.map((t) => t.nonce)).toEqual([7, 8]);
  });

  it("does not advance the nonce when the estimate throws — nothing was broadcast", async () => {
    // The counter advances only after a successful broadcast; an estimate that
    // reverts (a genuine contract refusal) must not burn a nonce, or every
    // later transaction queues behind a gap that never fills.
    const stub = stubSigner(21_000n);
    stub.signer.estimateGas = async () => {
      throw new Error("execution reverted");
    };
    const signer = new SerialNonceSigner(stub.signer as never);

    await expect(signer.sendTransaction({ to: "0x" + "11".repeat(20) })).rejects.toThrow(/reverted/);
    expect(stub.sent).toHaveLength(0);

    stub.signer.estimateGas = async () => 21_000n;
    await signer.sendTransaction({ to: "0x" + "11".repeat(20) });
    expect(stub.sent[0]!.nonce).toBe(7);
  });
});
