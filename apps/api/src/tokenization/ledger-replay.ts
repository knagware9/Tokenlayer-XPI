/**
 * Restores a simulated chain's in-memory ledger state from its audit trail.
 * `SimulatedAdapter` keeps every balance, supply figure, and compliance flag
 * in process memory with no persistence of its own — a real chain doesn't
 * need this because the chain IS the persistence, but the simulated
 * stand-in loses everything the instant the API process restarts, while
 * `seedUseCases` only ever re-deploys the (now empty) contract shell.
 * Postgres's audit log is the durable record of what actually happened;
 * this replays it back onto that fresh shell at boot so a restart is
 * invisible to anyone reading balances, totalSupply, or allow/freeze state
 * afterward — the read-model computePortfolio/computeActivity already build
 * from the same audit log, so this closes the gap between "what the Buyer's
 * own portfolio shows" and "what the live ledger reads say" rather than
 * introducing a third source of truth.
 *
 * A use case's contract is SHARED across every asset issued under it (see
 * LifecycleEngine.issue's own comment: "no per-asset deploy") — so replay
 * groups assets by (chainId, contractRef) and folds their COMBINED audit
 * stream in one pass, not per-asset.
 */
import { SimulatedAdapter, type LedgerHydration } from "@tokenlayer/adapters";
import type { TokenType } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import type { AuditEntryRecord } from "../persistence/types/index.js";

/** Read an integer-string field from an audit payload; missing/invalid → 0n. */
function amountOf(p: Record<string, unknown>): bigint {
  const v = p.amount;
  return typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : 0n;
}

/**
 * Fold one contract's full audit stream (oldest→newest) into the ledger
 * state it should have right now: net balances, supply, NFT ownership, and
 * compliance (allow/freeze) sets. Same event math the balance-only fold in
 * holders.ts uses, extended with the state that fold never needed to track
 * because no other reader consumed it.
 */
function foldLedgerState(entries: AuditEntryRecord[]): Omit<LedgerHydration, "tokenType" | "allowlistEnabled"> {
  const balances = new Map<string, bigint>();
  const owners = new Map<string, string>();
  const uris = new Map<string, string>();
  const frozen = new Set<string>();
  const allowed = new Set<string>();
  let supply = 0n;

  const bump = (addr: unknown, delta: bigint): void => {
    if (typeof addr !== "string" || addr === "") return;
    balances.set(addr, (balances.get(addr) ?? 0n) + delta);
  };

  for (const e of entries) {
    const p = e.payload ?? {};
    const tokenId = typeof p.tokenId === "string" ? p.tokenId : null;
    switch (e.action) {
      case "mint":
        if (tokenId) {
          if (!owners.has(tokenId)) {
            owners.set(tokenId, String(p.to));
            if (typeof p.uri === "string" && p.uri) uris.set(tokenId, p.uri);
            supply += 1n;
            bump(p.to, 1n);
          }
        } else {
          const amt = amountOf(p);
          supply += amt;
          bump(p.to, amt);
        }
        break;
      case "transfer":
        if (tokenId) {
          const cur = owners.get(tokenId) ?? (typeof p.from === "string" ? p.from : undefined);
          bump(cur, -1n);
          owners.set(tokenId, String(p.to));
          bump(p.to, 1n);
        } else {
          const amt = amountOf(p);
          bump(p.from, -amt);
          bump(p.to, amt);
        }
        break;
      case "buy": {
        // Secondary-market buys record `from = escrow` but carry the economic
        // seller in `seller` — debit the seller, mirroring holders.ts's fold,
        // so a seller with unsold escrowed inventory keeps their balance.
        const amt = amountOf(p);
        const debit = p.secondary === true && typeof p.seller === "string" ? p.seller : p.from;
        bump(debit, -amt);
        bump(p.to, amt);
        break;
      }
      case "burn":
        if (tokenId) {
          const cur = owners.get(tokenId);
          if (cur !== undefined) {
            supply -= 1n;
            bump(cur, -1n);
            owners.delete(tokenId);
            uris.delete(tokenId);
          }
        } else {
          const amt = amountOf(p);
          supply -= amt;
          bump(p.from, -amt);
        }
        break;
      case "freeze":
        if (typeof p.account === "string") frozen.add(p.account);
        break;
      case "unfreeze":
        if (typeof p.account === "string") frozen.delete(p.account);
        break;
      case "allow":
        if (typeof p.account === "string") allowed.add(p.account);
        break;
      case "disallow":
        if (typeof p.account === "string") allowed.delete(p.account);
        break;
      default:
        break; // issue/read/list/cancel-listing: no ledger-state effect
    }
  }
  return { balances, supply, owners, uris, frozen, allowed };
}

interface ContractGroup {
  chainId: string;
  contractRef: string;
  useCaseKey: string;
  tokenType: TokenType;
  assetIds: string[];
}

/**
 * Rehydrate every simulated-chain contract from its audit trail. Best-effort
 * per contract group: one group's failure (a use case that vanished, an
 * unreadable audit page) is logged and skipped rather than aborting boot or
 * leaving every OTHER contract still empty.
 */
export async function rehydrateSimulatedLedgers(
  deps: Pick<AppDeps, "assets" | "audit" | "chains" | "useCases">,
  log: { warn: (obj: unknown, msg: string) => void } = console,
): Promise<{ contracts: number; entries: number }> {
  const { items: assets } = await deps.assets.list({}, { limit: 100000, offset: 0 });

  const groups = new Map<string, ContractGroup>();
  for (const a of assets) {
    let adapter;
    try {
      adapter = deps.chains.resolveAdapter(a.chainId);
    } catch {
      continue; // chain not configured/absent right now — nothing to rehydrate
    }
    if (!(adapter instanceof SimulatedAdapter)) continue; // real chain: its own state is authoritative
    const key = `${a.chainId}::${a.contractRef}`;
    const g = groups.get(key);
    if (g) g.assetIds.push(a.id);
    else groups.set(key, { chainId: a.chainId, contractRef: a.contractRef, useCaseKey: a.useCaseKey, tokenType: a.tokenType, assetIds: [a.id] });
  }
  if (groups.size === 0) return { contracts: 0, entries: 0 };

  let totalEntries = 0;
  for (const g of groups.values()) {
    try {
      const useCase = await deps.useCases.get(g.useCaseKey);
      const { items: entries } = await deps.audit.listByAssetIds(g.assetIds, { limit: 100000, offset: 0 });
      const state = foldLedgerState(entries);
      const adapter = deps.chains.resolveAdapter(g.chainId) as SimulatedAdapter;
      // Any member asset's id will do — SimulatedLedger keys purely by
      // contractRef, and every group is seeded with at least one assetId.
      adapter.hydrate({ id: g.assetIds[0]!, chainId: g.chainId, contractRef: g.contractRef }, {
        tokenType: g.tokenType,
        allowlistEnabled: useCase.compliance.allowlist,
        ...state,
      });
      totalEntries += entries.length;
    } catch (err) {
      log.warn({ err, chainId: g.chainId, contractRef: g.contractRef }, "[ledger-replay] could not rehydrate a simulated contract — leaving it as seedUseCases left it");
    }
  }
  return { contracts: groups.size, entries: totalEntries };
}
