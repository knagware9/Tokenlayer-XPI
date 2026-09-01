/**
 * Shared audit-stream folding: net balances, positive-balance holders, and
 * first-acquisition timestamps for a single asset. Extracted from analytics.ts
 * so the ComplianceProvider (holderCount / acquiredAt) and the analytics
 * dashboard fold the audit stream identically. Pure — no I/O; every input is a
 * plain audit-entry array. All token math is BigInt over integer strings.
 */
import type { AuditEntryRecord } from "../persistence/types/index.js";

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
 *
 * Handles BOTH token types (an asset's stream is entirely one kind):
 *  - fungible: mint/transfer/burn/buy carry an integer `amount`; supply = minted
 *    − burned, balances = net amount per address.
 *  - non-fungible (ERC-721): mint/transfer/burn carry a `tokenId` and no amount;
 *    each live token counts as 1, so supply = live token count and balances =
 *    number of tokens per owner. Ownership is tracked by tokenId so a transfer
 *    debits the actual current owner (authoritative over the payload `from`).
 */
export function foldAsset(entries: AuditEntryRecord[]): AssetState {
  const f = createFold();
  for (const e of entries) f.step(e);
  return f.state;
}

/** Incremental fold: feed entries oldest→newest via step(); read state anytime. */
export interface Fold {
  state: AssetState;
  step(e: AuditEntryRecord): void;
}

export function createFold(): Fold {
  const balances = new Map<string, bigint>();
  const owners = new Map<string, string>(); // tokenId → current owner (NFT only)
  const bump = (addr: unknown, delta: bigint): void => {
    if (typeof addr !== "string" || addr === "") return;
    balances.set(addr, (balances.get(addr) ?? 0n) + delta);
  };
  const state: AssetState = { supply: 0n, balances };
  const step = (e: AuditEntryRecord): void => {
    const p = e.payload ?? {};
    const tokenId = typeof p.tokenId === "string" ? p.tokenId : null;
    switch (e.action) {
      case "mint": {
        if (tokenId) {
          if (!owners.has(tokenId)) { owners.set(tokenId, String(p.to)); state.supply += 1n; bump(p.to, 1n); }
        } else {
          const amt = amountOf(p, "amount");
          state.supply += amt;
          bump(p.to, amt);
        }
        break;
      }
      case "transfer": {
        if (tokenId) {
          const cur = owners.get(tokenId) ?? (typeof p.from === "string" ? p.from : undefined);
          bump(cur, -1n);
          owners.set(tokenId, String(p.to));
          bump(p.to, 1n);
        } else {
          const amt = amountOf(p, "amount");
          bump(p.from, -amt);
          bump(p.to, amt);
        }
        break;
      }
      case "buy": {
        // Secondary market is fungible-only. Buys record `from = escrow` (the
        // pooled market escrow account) but carry the economic sender in `seller`.
        // Debit the seller so the escrow never enters balances: the seller keeps
        // the balance while escrowed (unsold inventory — `list`/`cancel-listing`
        // stay no-ops below) and loses it exactly when a take fills. Folding the
        // escrow instead leaves a fully-exited seller with a phantom credit,
        // over-counting holders (false HOLDER_LIMIT_EXCEEDED).
        const amt = amountOf(p, "amount");
        const debit = p.secondary === true && typeof p.seller === "string" ? p.seller : p.from;
        bump(debit, -amt);
        bump(p.to, amt);
        break;
      }
      case "burn": {
        if (tokenId) {
          const cur = owners.get(tokenId);
          if (cur !== undefined) { state.supply -= 1n; bump(cur, -1n); owners.delete(tokenId); }
        } else {
          const amt = amountOf(p, "amount");
          state.supply -= amt;
          bump(p.from, -amt);
        }
        break;
      }
      default:
        break; // issue/freeze/unfreeze/allow/disallow/read/list/cancel-listing: no supply/balance effect
    }
  };
  return { state, step };
}

/**
 * Fold an asset's audit entries into LITERAL on-chain balances — every
 * transfer-shaped action (transfer/buy/list/cancel-listing) moves balance
 * exactly as the underlying ledger transfer did, escrow legs included.
 *
 * This is the raw-ledger view, deliberately DIFFERENT from `createFold`'s
 * economic-ownership one: that fold treats `list`/`cancel-listing` as a
 * no-op and debits a secondary `buy`'s SELLER rather than the escrow
 * account, so a seller's escrowed-but-unsold units still count as theirs —
 * correct for portfolio/holder-count/holder-limit purposes, wrong for a
 * literal "what does this address currently hold" table. Here, a seller's
 * balance really does drop the moment they list, and a secondary buy's `to`
 * receives from the escrow account it actually came from, because that is
 * what the ledger transfer underneath the audit entry did.
 */
export function foldAssetRawBalances(entries: AuditEntryRecord[]): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  const owners = new Map<string, string>(); // tokenId → current owner (NFT only)
  const bump = (addr: unknown, delta: bigint): void => {
    if (typeof addr !== "string" || addr === "") return;
    balances.set(addr, (balances.get(addr) ?? 0n) + delta);
  };
  for (const e of entries) {
    const p = e.payload ?? {};
    const tokenId = typeof p.tokenId === "string" ? p.tokenId : null;
    switch (e.action) {
      case "mint": {
        if (tokenId) {
          if (!owners.has(tokenId)) { owners.set(tokenId, String(p.to)); bump(p.to, 1n); }
        } else {
          bump(p.to, amountOf(p, "amount"));
        }
        break;
      }
      case "transfer":
      case "buy": {
        // Literal `from`/`to` — NOT the `secondary`/`seller` override
        // `createFold` applies for a secondary buy: on the raw ledger the
        // tokens actually moved out of the escrow account named in `from`.
        if (tokenId) {
          const cur = owners.get(tokenId) ?? (typeof p.from === "string" ? p.from : undefined);
          bump(cur, -1n);
          owners.set(tokenId, String(p.to));
          bump(p.to, 1n);
        } else {
          const amt = amountOf(p, "amount");
          bump(p.from, -amt);
          bump(p.to, amt);
        }
        break;
      }
      case "list": {
        const amt = amountOf(p, "amount");
        bump(p.seller, -amt);
        bump(p.escrow, amt);
        break;
      }
      case "cancel-listing": {
        const amt = amountOf(p, "amount");
        bump(p.escrow, -amt);
        bump(p.seller, amt);
        break;
      }
      case "burn": {
        if (tokenId) {
          if (owners.has(tokenId)) { bump(owners.get(tokenId), -1n); owners.delete(tokenId); }
        } else {
          bump(p.from, -amountOf(p, "amount"));
        }
        break;
      }
      default:
        break; // issue/freeze/unfreeze/allow/disallow/read: no balance effect
    }
  }
  return balances;
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
    // A credit is a positive fungible amount OR an NFT token-id received.
    const isCredit = amountOf(p, "amount") > 0n || typeof p.tokenId === "string";
    switch (e.action) {
      case "mint":
      case "transfer":
      case "buy":
        credited = p.to === account && isCredit;
        break;
      default:
        break;
    }
    if (credited && (earliest === null || e.createdAt < earliest)) earliest = e.createdAt;
  }
  return earliest;
}
