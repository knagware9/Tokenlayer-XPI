/**
 * Shared audit-stream folding: net balances, positive-balance holders, and
 * first-acquisition timestamps for a single asset. Extracted from analytics.ts
 * so the ComplianceProvider (holderCount / acquiredAt) and the analytics
 * dashboard fold the audit stream identically. Pure — no I/O; every input is a
 * plain audit-entry array. All token math is BigInt over integer strings.
 */
import type { AuditEntryRecord } from "./persistence/types.js";

/** Read an integer-string field from an audit payload; missing/invalid → 0n. */
export function amountOf(payload: Record<string, unknown>, field: string): bigint {
  const v = payload[field];
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
}

/** Per-asset fold of the audit stream: net supply, positive-balance holders. */
export interface AssetState {
  supply: bigint;
  balances: Map<string, bigint>; // address → net balance
}

/**
 * Fold an asset's audit entries into net supply + per-address balances.
 * Order-sensitive for correctness of running balances — callers pass entries in
 * chronological (oldest→newest) order.
 */
export function foldAsset(entries: AuditEntryRecord[]): AssetState {
  const balances = new Map<string, bigint>();
  const bump = (addr: unknown, delta: bigint): void => {
    if (typeof addr !== "string" || addr === "") return;
    balances.set(addr, (balances.get(addr) ?? 0n) + delta);
  };
  let supply = 0n;
  for (const e of entries) {
    const p = e.payload ?? {};
    switch (e.action) {
      case "mint": {
        const amt = amountOf(p, "amount");
        supply += amt;
        bump(p.to, amt);
        break;
      }
      case "transfer": {
        const amt = amountOf(p, "amount");
        bump(p.from, -amt);
        bump(p.to, amt);
        break;
      }
      case "buy": {
        const amt = amountOf(p, "amount");
        bump(p.from, -amt);
        bump(p.to, amt);
        break;
      }
      case "burn": {
        const amt = amountOf(p, "amount");
        supply -= amt;
        bump(p.from, -amt);
        break;
      }
      default:
        break; // issue/freeze/unfreeze/allow/disallow/read: no supply/balance effect
    }
  }
  return { supply, balances };
}

/** Distinct addresses with a strictly positive net balance across a set of assets. */
export function collectPositiveHolders(states: AssetState[]): Set<string> {
  // Deduplicate a holder across assets by address: an address counts once if it
  // holds a positive balance in ANY asset in the subset. (An address net-positive
  // in asset A but zero in asset B is still a holder of the subset.)
  const net = new Map<string, boolean>();
  for (const s of states) {
    for (const [addr, bal] of s.balances) {
      if (bal > 0n) net.set(addr, true);
    }
  }
  return new Set(net.keys());
}

/** Distinct positive-balance holders of a single asset's audit stream. */
export function holderCountOf(entries: AuditEntryRecord[]): number {
  return collectPositiveHolders([foldAsset(entries)]).size;
}

/**
 * ISO timestamp of `account`'s earliest audit entry that credited it (mint/
 * transfer-in/buy-in) for this asset, or null if the account was never credited.
 * Entries need not be pre-sorted — the minimum createdAt is taken.
 */
export function firstAcquisitionOf(entries: AuditEntryRecord[], account: string): string | null {
  let earliest: string | null = null;
  for (const e of entries) {
    const p = e.payload ?? {};
    let credited = false;
    switch (e.action) {
      case "mint":
        credited = p.to === account && amountOf(p, "amount") > 0n;
        break;
      case "transfer":
      case "buy":
        credited = p.to === account && amountOf(p, "amount") > 0n;
        break;
      default:
        break;
    }
    if (credited && (earliest === null || e.createdAt < earliest)) earliest = e.createdAt;
  }
  return earliest;
}
