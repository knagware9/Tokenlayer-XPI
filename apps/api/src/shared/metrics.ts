import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { LedgerAdapter } from "@tokenlayer/core";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});

export const ledgerRpcErrorsTotal = new Counter({
  name: "ledger_rpc_errors_total",
  help: "Ledger adapter calls that threw",
  labelNames: ["chain", "operation"],
  registers: [registry],
});

export const ledgerRpcDuration = new Histogram({
  name: "ledger_rpc_duration_seconds",
  help: "Ledger adapter call duration in seconds",
  labelNames: ["chain", "operation"],
  registers: [registry],
});

/**
 * Wraps every method on a LedgerAdapter with duration/error recording,
 * labeled by chain and operation (method name). Wrapping at this interface
 * boundary — rather than inside each of EvmLedgerAdapter/FabricLedgerAdapter/
 * CantonLedgerAdapter/the simulated adapter — is deliberate: the four chain
 * families don't share a transport (ethers v6 uses fetch/undici, fabric-network
 * uses gRPC), so a transport-level approach would need separate handling per
 * family. This is transport-agnostic by construction.
 */
// The fixed method list from the LedgerAdapter interface (packages/core/src/shared/types.ts:100).
// NOT Object.keys(adapter) — every implementation (EvmLedgerAdapter included) defines these as
// ordinary class methods on the prototype, not instance-field arrow functions, so Object.keys()
// on an instance would enumerate none of them (only own fields like chainId/family) and silently
// wrap nothing.
const LEDGER_ADAPTER_METHODS = [
  "deployAsset", "mint", "transfer", "burn", "balanceOf", "totalSupply",
  "mintToken", "transferToken", "burnToken", "ownerOf", "tokensOf",
  "setFrozen", "setAllowed", "isFrozen", "isAllowed", "anchor", "getReceipt",
] as const;

export function instrumentLedgerAdapter(adapter: LedgerAdapter): LedgerAdapter {
  const wrappedMethods = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  for (const key of LEDGER_ADAPTER_METHODS) {
    const value = adapter[key];
    if (typeof value !== "function") continue; // getReceipt is optional — absent on simulated/Fabric/Canton adapters
    wrappedMethods.set(key, async (...args: unknown[]) => {
      const stop = ledgerRpcDuration.startTimer({ chain: adapter.chainId, operation: key });
      try {
        return await (value as (...a: unknown[]) => unknown).apply(adapter, args);
      } catch (err) {
        ledgerRpcErrorsTotal.inc({ chain: adapter.chainId, operation: key });
        throw err;
      } finally {
        stop();
      }
    });
  }
  // A Proxy, not a plain-object copy: some call sites reach past the LedgerAdapter
  // interface — ledger-replay.ts does `adapter instanceof SimulatedAdapter` and calls
  // the simulated-only `.hydrate()`. A copy would break both: every adapter would stop
  // being `instanceof` its concrete class, and any adapter-specific member not in
  // LEDGER_ADAPTER_METHODS would silently vanish. The Proxy forwards everything except
  // the enumerated methods straight to the real adapter, so identity and any
  // adapter-specific extras pass through untouched.
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && wrappedMethods.has(prop)) return wrappedMethods.get(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
}
