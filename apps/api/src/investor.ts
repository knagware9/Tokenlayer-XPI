/**
 * Investor read-model: portfolio + activity aggregation over the audit fold.
 * Per-asset accounting comes from folding each asset's audit stream (NOT raw
 * ledger balances — invoice assets share one ERC-20 contract, so ledger
 * balances pool across assets). Pure aggregation — no writes.
 */
import { splitProRata } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { createFold, amountOf } from "./holders.js";
import { dropPayerShare } from "./executors.js";
import type { AssetRecord, AuditEntryRecord } from "./persistence/types.js";

export interface Holding {
  assetId: string; name: string; symbol: string; useCaseKey: string; chainId: string;
  units: string; unitPrice: string | null; currency: string | null; value: string | null;
}
export interface Portfolio {
  wallet: string;
  cash: { currency: string; amount: string }[];
  holdings: Holding[];
  totalByCurrency: Record<string, string>;
}
export interface ActivityEvent {
  at: string; kind: "subscribed" | "received" | "sent" | "coupon" | "redemption";
  assetId: string; assetName: string; units: string | null;
  amount: string | null; currency: string | null; txHash: string | null;
}

const eq = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** Balance of `wallet` in a fold's balances map, case-insensitive. */
function balanceOf(balances: Map<string, bigint>, wallet: string): bigint {
  for (const [addr, bal] of balances) if (eq(addr, wallet)) return bal;
  return 0n;
}

/** The use case's assets + their chronological audit entries, grouped. */
async function assetStreams(deps: AppDeps, useCaseKey?: string): Promise<{ assets: AssetRecord[]; byAsset: Map<string, AuditEntryRecord[]> }> {
  const { items: assets } = await deps.assets.list(useCaseKey ? { useCaseKey } : {}, { limit: 1000 });
  const { items } = await deps.audit.listByAssetIds(assets.map((a) => a.id), { limit: 100000 });
  const byAsset = new Map<string, AuditEntryRecord[]>();
  for (const e of items) {
    if (!e.assetId) continue;
    const list = byAsset.get(e.assetId) ?? [];
    list.push(e);
    byAsset.set(e.assetId, list);
  }
  // listByAssetIds returns createdAt ASC already; keep a defensive per-asset sort.
  for (const list of byAsset.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { assets, byAsset };
}

/** Value of `units` of an asset: unitPrice × units, else pro-rata of the use case's valuation field. */
function holdingValue(a: AssetRecord, units: bigint, supply: bigint, valuation?: { metadataField: string; currency: string }): { currency: string; amount: bigint } | null {
  if (a.unitPrice && a.currency && /^\d+$/.test(a.unitPrice)) return { currency: a.currency, amount: units * BigInt(a.unitPrice) };
  if (valuation && supply > 0n) {
    const raw = a.metadata?.[valuation.metadataField];
    const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 0) return { currency: valuation.currency, amount: (units * BigInt(Math.round(n))) / supply };
  }
  return null;
}

export async function computePortfolio(deps: AppDeps, wallet: string, useCaseKey?: string): Promise<Portfolio> {
  const { assets, byAsset } = await assetStreams(deps, useCaseKey);
  const valuations = new Map((await deps.useCases.list()).map((u) => [u.key, u.valuation] as const));
  const holdings: Holding[] = [];
  const totals = new Map<string, bigint>();
  for (const a of assets) {
    const fold = createFold();
    for (const e of byAsset.get(a.id) ?? []) fold.step(e);
    const units = balanceOf(fold.state.balances, wallet);
    if (units <= 0n) continue;
    const v = holdingValue(a, units, fold.state.supply, valuations.get(a.useCaseKey));
    if (v) totals.set(v.currency, (totals.get(v.currency) ?? 0n) + v.amount);
    holdings.push({
      assetId: a.id, name: a.name, symbol: a.symbol, useCaseKey: a.useCaseKey, chainId: a.chainId,
      units: units.toString(), unitPrice: a.unitPrice ?? null, currency: v?.currency ?? a.currency ?? null,
      value: v ? v.amount.toString() : null,
    });
  }
  const cash = (await deps.cash.balancesOf(wallet)).map((b) => ({ currency: b.currency, amount: b.amount }));
  return { wallet, cash, holdings, totalByCurrency: Object.fromEntries([...totals].map(([c, v]) => [c, v.toString()])) };
}

export async function computeActivity(deps: AppDeps, wallet: string, useCaseKey?: string): Promise<ActivityEvent[]> {
  const { assets, byAsset } = await assetStreams(deps, useCaseKey);
  const nameOf = new Map(assets.map((a) => [a.id, a] as const));
  const events: ActivityEvent[] = [];
  for (const a of assets) {
    const fold = createFold();
    for (const e of byAsset.get(a.id) ?? []) {
      const p = e.payload ?? {};
      const base = { at: e.createdAt, assetId: a.id, assetName: nameOf.get(a.id)?.name ?? "", txHash: e.txHash ?? null };
      if (e.action === "buy" && eq(p.to, wallet)) {
        events.push({ ...base, kind: "subscribed", units: String(p.amount ?? ""), amount: typeof p.cost === "string" ? p.cost : null, currency: typeof p.currency === "string" ? p.currency : null });
      } else if ((e.action === "mint" || e.action === "transfer") && eq(p.to, wallet)) {
        events.push({ ...base, kind: "received", units: String(p.amount ?? p.tokenId ?? ""), amount: null, currency: null });
      } else if (e.action === "transfer" && eq(p.from, wallet)) {
        events.push({ ...base, kind: "sent", units: String(p.amount ?? p.tokenId ?? ""), amount: null, currency: null });
      } else if (e.action === "distribute" || e.action === "redeem") {
        // Recompute this wallet's share exactly as settlement paid it: balances at
        // this point in the stream → drop the payer → splitProRata → my slice.
        const held = balanceOf(fold.state.balances, wallet);
        const split = new Map(fold.state.balances);
        if (typeof p.from === "string") dropPayerShare(split, p.from);
        const mine = splitProRata(amountOf(p, "paid") || amountOf(p, "amount"), split);
        let share = 0n;
        for (const [addr, amt] of mine) if (eq(addr, wallet)) share = amt;
        if (share > 0n) {
          events.push({ ...base, kind: e.action === "redeem" ? "redemption" : "coupon", units: e.action === "redeem" ? held.toString() : null, amount: share.toString(), currency: typeof p.currency === "string" ? p.currency : null });
        }
      }
      fold.step(e); // apply AFTER classification so distribute sees pre-event balances
    }
  }
  return events.sort((x, y) => y.at.localeCompare(x.at)).slice(0, 100);
}
