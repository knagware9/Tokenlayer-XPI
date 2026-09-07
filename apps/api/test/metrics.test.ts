import { describe, expect, it } from "vitest";
import type { LedgerAdapter } from "@tokenlayer/core";
import { instrumentLedgerAdapter, ledgerRpcDuration, ledgerRpcErrorsTotal, registry } from "../src/shared/metrics.js";

function stubAdapter(overrides: Partial<LedgerAdapter> = {}): LedgerAdapter {
  return {
    chainId: "test-chain",
    family: "evm",
    deployAsset: async () => ({ address: "0x1" }) as never,
    mint: async () => ({ txHash: "0xabc" }) as never,
    transfer: async () => ({ txHash: "0xabc" }) as never,
    burn: async () => ({ txHash: "0xabc" }) as never,
    balanceOf: async () => "0",
    totalSupply: async () => "0",
    mintToken: async () => ({ txHash: "0xabc" }) as never,
    transferToken: async () => ({ txHash: "0xabc" }) as never,
    burnToken: async () => ({ txHash: "0xabc" }) as never,
    ownerOf: async () => null,
    tokensOf: async () => [],
    setFrozen: async () => ({ txHash: "0xabc" }) as never,
    setAllowed: async () => ({ txHash: "0xabc" }) as never,
    isFrozen: async () => false,
    isAllowed: async () => true,
    anchor: async () => ({ txHash: "0xabc" }) as never,
    ...overrides,
  };
}

describe("instrumentLedgerAdapter", () => {
  it("records duration and does not increment the error counter on success", async () => {
    const adapter = instrumentLedgerAdapter(stubAdapter());
    await adapter.balanceOf({ chainId: "test-chain", address: "0x1" } as never, "0xaccount");
    const errCount = (await registry.getSingleMetric(ledgerRpcErrorsTotal.name)?.get())?.values.find(
      (v) => v.labels.chain === "test-chain" && v.labels.operation === "balanceOf",
    );
    expect(errCount).toBeUndefined();
    const duration = (await registry.getSingleMetric(ledgerRpcDuration.name)?.get())?.values.find(
      (v) => v.labels.chain === "test-chain" && v.labels.operation === "balanceOf" && v.metricName?.endsWith("_count"),
    );
    expect(duration?.value).toBeGreaterThanOrEqual(1);
  });

  it("increments the error counter and rethrows on failure", async () => {
    const boom = new Error("rpc down");
    const adapter = instrumentLedgerAdapter(stubAdapter({ mint: async () => { throw boom; } }));
    await expect(adapter.mint({ chainId: "test-chain", address: "0x1" } as never, "0xto", "10")).rejects.toBe(boom);
    const errCount = (await registry.getSingleMetric(ledgerRpcErrorsTotal.name)?.get())?.values.find(
      (v) => v.labels.chain === "test-chain" && v.labels.operation === "mint",
    );
    expect(errCount?.value).toBeGreaterThanOrEqual(1);
  });
});
