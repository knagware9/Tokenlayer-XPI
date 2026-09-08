import { describe, expect, it } from "vitest";
import type { LedgerAdapter } from "@tokenlayer/core";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  instrumentLedgerAdapter,
  ledgerRpcDuration,
  ledgerRpcErrorsTotal,
  proposalPendingAgeSecondsMax,
  proposalPendingTotal,
  refreshProposalBacklogMetrics,
  registry,
} from "../src/shared/metrics.js";
import { buildTestAppWithRepos } from "./helpers.js";

const spanExporter = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }).register();

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

  it("preserves instanceof and passes non-interface members straight through", async () => {
    // Mirrors why instrumentLedgerAdapter must be a Proxy, not a plain-object copy:
    // ledger-replay.ts does `adapter instanceof SimulatedAdapter` and calls the
    // simulated-only `.hydrate()`, neither of which is part of LedgerAdapter.
    class FakeSimulatedAdapter {
      readonly chainId = "test-chain";
      readonly family = "evm" as const;
      async deployAsset() { return { address: "0x1" } as never; }
      async mint() { return { txHash: "0xabc" } as never; }
      async transfer() { return { txHash: "0xabc" } as never; }
      async burn() { return { txHash: "0xabc" } as never; }
      async balanceOf() { return "0"; }
      async totalSupply() { return "0"; }
      async mintToken() { return { txHash: "0xabc" } as never; }
      async transferToken() { return { txHash: "0xabc" } as never; }
      async burnToken() { return { txHash: "0xabc" } as never; }
      async ownerOf() { return null; }
      async tokensOf() { return []; }
      async setFrozen() { return { txHash: "0xabc" } as never; }
      async setAllowed() { return { txHash: "0xabc" } as never; }
      async isFrozen() { return false; }
      async isAllowed() { return true; }
      async anchor() { return { txHash: "0xabc" } as never; }
      // NOT part of LedgerAdapter — must pass through the Proxy unwrapped.
      hydrate(marker: string) { return marker; }
    }

    const real = new FakeSimulatedAdapter();
    const wrapped = instrumentLedgerAdapter(real as unknown as LedgerAdapter);

    // instanceof must still identify the concrete class through the Proxy.
    expect(wrapped instanceof FakeSimulatedAdapter).toBe(true);

    // A member outside LEDGER_ADAPTER_METHODS must reach the real adapter untouched
    // (no instrumentation, no wrapping) — this is what a plain-object copy would drop.
    expect((wrapped as unknown as FakeSimulatedAdapter).hydrate("x")).toBe("x");

    // A wrapped interface method still records metrics as usual through the Proxy.
    await wrapped.balanceOf({ chainId: "test-chain", address: "0x1" } as never, "0xaccount");
    const duration = (await registry.getSingleMetric(ledgerRpcDuration.name)?.get())?.values.find(
      (v) => v.labels.chain === "test-chain" && v.labels.operation === "balanceOf" && v.metricName?.endsWith("_count"),
    );
    expect(duration?.value).toBeGreaterThanOrEqual(1);
  });

  it("opens a ledger.<operation> span alongside the metric", async () => {
    spanExporter.reset();
    const adapter = instrumentLedgerAdapter(stubAdapter());
    await adapter.balanceOf({ chainId: "test-chain", address: "0x1" } as never, "0xaccount");
    const span = spanExporter.getFinishedSpans().find((s) => s.name === "ledger.balanceOf");
    expect(span).toBeDefined();
    expect(span!.attributes.chain).toBe("test-chain");
    expect(span!.attributes.operation).toBe("balanceOf");
  });
});

describe("refreshProposalBacklogMetrics", () => {
  it("sets pending count and max age per kind, and clears a kind that emptied out", async () => {
    const h = await buildTestAppWithRepos();
    const now = Date.now();
    await h.deps.proposals.create({
      useCaseKey: "carbon-credit", orgId: null, assetId: "asset_1", kind: "mint",
      payload: {}, proposerId: "u1", proposerLabel: "Alice", required: 1,
    });
    // Backdate one row directly through the repository's own row store isn't
    // available generically — instead assert on "at least the count is right
    // and age is non-negative", which is what the gauge computation actually
    // promises; a precise age assertion belongs to a unit test of the pure
    // grouping logic, not this integration-level one.
    await refreshProposalBacklogMetrics(h.deps.proposals);
    const count = (await registry.getSingleMetric(proposalPendingTotal.name)?.get())?.values.find(
      (v) => v.labels.kind === "mint",
    );
    expect(count?.value).toBe(1);
    const age = (await registry.getSingleMetric(proposalPendingAgeSecondsMax.name)?.get())?.values.find(
      (v) => v.labels.kind === "mint",
    );
    expect(age?.value).toBeGreaterThanOrEqual(0);
    expect(Date.now() - now).toBeLessThan(5000); // sanity: test itself ran fast

    // Decide the proposal away, then refresh again — the gauge must not keep
    // reporting a stale count for a kind with zero pending proposals left.
    const [p] = await h.deps.proposals.list("carbon-credit", "pending");
    await h.deps.proposals.setStatus(p!.id, "approved");
    await refreshProposalBacklogMetrics(h.deps.proposals);
    const countAfter = (await registry.getSingleMetric(proposalPendingTotal.name)?.get())?.values.find(
      (v) => v.labels.kind === "mint",
    );
    expect(countAfter).toBeUndefined();
  });
});
