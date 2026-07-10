/**
 * Investor read-model: portfolio + activity aggregation over the audit fold.
 * Per-asset accounting comes from folding each asset's audit stream (NOT raw
 * ledger balances — invoice assets share one ERC-20 contract, so ledger
 * balances pool across assets). Pure aggregation — no writes.
 */
import { splitProRata } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { createFold, amountOf } from "./holders.js";
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

/** Balance of `wallet` in a fold's balances map: sum of case-insensitive matches (address casing is not canonical). */
function balanceOf(balances: Map<string, bigint>, wallet: string): bigint {
  let total = 0n;
  for (const [addr, bal] of balances) if (eq(addr, wallet)) total += bal;
  return total;
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
    // Integer strings go straight to BigInt (no Number round-trip precision loss).
    const total =
      typeof raw === "string" && /^\d+$/.test(raw)
        ? BigInt(raw)
        : typeof raw === "number" && Number.isFinite(raw) && raw >= 0
          ? BigInt(Math.round(raw))
          : typeof raw === "string" && /^\d+\.\d+$/.test(raw)
            ? BigInt(Math.round(Number(raw)))
            : null;
    if (total !== null) return { currency: valuation.currency, amount: (units * total) / supply };
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
        events.push({ ...base, kind: "subscribed", units: p.amount != null ? String(p.amount) : null, amount: typeof p.cost === "string" ? p.cost : null, currency: typeof p.currency === "string" ? p.currency : null });
      } else if ((e.action === "mint" || e.action === "transfer") && eq(p.to, wallet)) {
        const u = p.amount ?? p.tokenId;
        events.push({ ...base, kind: "received", units: u != null ? String(u) : null, amount: null, currency: null });
      } else if (e.action === "transfer" && eq(p.from, wallet)) {
        const u = p.amount ?? p.tokenId;
        events.push({ ...base, kind: "sent", units: u != null ? String(u) : null, amount: null, currency: null });
      } else if (e.action === "distribute" || e.action === "redeem") {
        const held = balanceOf(fold.state.balances, wallet);
        let share = 0n;
        if (typeof p.payments === "object" && p.payments !== null && !Array.isArray(p.payments)) {
          // Exact per-holder payments recorded at settlement — authoritative.
          // (A redemption's burns precede its audit entry, so pre-event fold
          // balances are already zero; the recorded payments still carry the share.)
          for (const [addr, amt] of Object.entries(p.payments as Record<string, unknown>)) {
            if (eq(addr, wallet) && typeof amt === "string" && /^\d+$/.test(amt)) share += BigInt(amt);
          }
        } else if (!eq(p.from, wallet)) {
          // Legacy entries without `payments`: replicate the executor exactly —
          // split the FULL amount over pre-event balances INCLUDING the payer
          // (whose own floor share was then withheld, hence the payer skip above).
          for (const [addr, amt] of splitProRata(amountOf(p, "amount"), fold.state.balances)) {
            if (eq(addr, wallet)) share += amt;
          }
        }
        if (share > 0n) {
          events.push({ ...base, kind: e.action === "redeem" ? "redemption" : "coupon", units: e.action === "redeem" && held > 0n ? held.toString() : null, amount: share.toString(), currency: typeof p.currency === "string" ? p.currency : null });
        }
      }
      fold.step(e); // apply AFTER classification so distribute sees pre-event balances
    }
  }
  return events.sort((x, y) => y.at.localeCompare(x.at)).slice(0, 100);
}
