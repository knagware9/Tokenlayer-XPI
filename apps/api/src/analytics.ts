/**
 * Pure analytics aggregation. Takes already-loaded, already-scope-filtered data
 * (assets + their full audit history + catalog lookups) and folds it into a
 * dashboard summary. No I/O — every input is injected so the function is
 * deterministic and unit-testable. All token/money math is done as BigInt over
 * integer strings; outputs are decimal strings (never floats).
 */
import { amountOf, collectPositiveHolders, foldAsset, type AssetState } from "./holders.js";
import type { AssetRecord, AuditEntryRecord } from "./persistence/types.js";

export interface AnalyticsInput {
  scope: "platform" | "use-case";
  useCaseKey: string | null;
  /** Already scope-filtered assets. */
  assets: AssetRecord[];
  /** Audit entries for those assets (all history), any order. */
  audit: AuditEntryRecord[];
  /** Use-case catalog, for names/symbols in byUseCase. */
  useCases: { key: string; name: string; symbol: string }[];
  /** Chain catalog, for byLedger mode. */
  chains: { id: string; mode: "real" | "simulated" }[];
  /** Current time (ISO) — injectable for deterministic tests. */
  now: string;
  /** Activity window length in days. */
  days: number;
}

export interface LedgerRow {
  chainId: string;
  mode: "real" | "simulated";
  assets: number;
  supply: string;
  holders: number;
}

export interface UseCaseRow {
  useCaseKey: string;
  name: string;
  symbol: string;
  chainId: string;
  supply: string;
  holders: number;
  valueByCurrency: Record<string, string>;
}

export interface ActivityDay {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
  tradedByCurrency: Record<string, string>;
}

export interface RecentEvent {
  at: string;
  action: string;
  assetId: string;
  assetName: string;
  chainId: string;
  summary: string;
}

export interface AnalyticsSummary {
  scope: "platform" | "use-case";
  useCaseKey: string | null;
  totals: {
    assets: number;
    useCases: number;
    holders: number;
    supply: string;
    valueByCurrency: Record<string, string>;
    tradedByCurrency: Record<string, string>;
    trades: number;
  };
  byLedger: LedgerRow[];
  byUseCase: UseCaseRow[];
  activity: ActivityDay[];
  recent: RecentEvent[];
}

/** Add `amount` into a currency-keyed bigint accumulator. */
function addCurrency(acc: Map<string, bigint>, currency: string, amount: bigint): void {
  acc.set(currency, (acc.get(currency) ?? 0n) + amount);
}

/** Serialise a currency→bigint map to currency→decimal-string. */
function currencyMapToStrings(acc: Map<string, bigint>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [currency, amount] of acc) out[currency] = amount.toString();
  return out;
}

/** UTC calendar date (YYYY-MM-DD) of an ISO timestamp. */
function utcDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Short human summary for a recent event. */
function summarize(action: string, p: Record<string, unknown>): string {
  const short = (a: unknown): string => {
    if (typeof a !== "string" || a.length < 10) return typeof a === "string" ? a : "";
    return `${a.slice(0, 4)}..${a.slice(-4)}`;
  };
  switch (action) {
    case "mint":
      return p.tokenId !== undefined ? `#${String(p.tokenId)} → ${short(p.to)}` : `${String(p.amount ?? "")} → ${short(p.to)}`;
    case "transfer":
      return p.tokenId !== undefined ? `#${String(p.tokenId)} ${short(p.from)}→${short(p.to)}` : `${String(p.amount ?? "")} ${short(p.from)}→${short(p.to)}`;
    case "burn":
      return p.tokenId !== undefined ? `#${String(p.tokenId)}` : `${String(p.amount ?? "")} from ${short(p.from)}`;
    case "buy":
      return `${String(p.amount ?? "")} ${short(p.from)}→${short(p.to)} @ ${String(p.unitPrice ?? "")} ${String(p.currency ?? "")}`;
    case "issue":
      return "issued";
    case "freeze":
    case "unfreeze":
    case "allow":
    case "disallow":
      return `${action} ${short(p.account)}`;
    default:
      return action;
  }
}

export function computeAnalytics(input: AnalyticsInput): AnalyticsSummary {
  const { scope, useCaseKey, assets, audit, useCases, chains, now, days } = input;

  const chainMode = new Map(chains.map((c) => [c.id, c.mode] as const));
  const useCaseInfo = new Map(useCases.map((u) => [u.key, u] as const));

  // Group audit entries per asset (in chronological order — the fold is order-sensitive).
  const sortedAudit = [...audit].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const auditByAsset = new Map<string, AuditEntryRecord[]>();
  for (const e of sortedAudit) {
    if (e.assetId === undefined) continue;
    const list = auditByAsset.get(e.assetId) ?? [];
    list.push(e);
    auditByAsset.set(e.assetId, list);
  }

  // Fold each asset once.
  const stateByAsset = new Map<string, AssetState>();
  for (const a of assets) {
    stateByAsset.set(a.id, foldAsset(auditByAsset.get(a.id) ?? []));
  }

  // --- totals -------------------------------------------------------------
  let totalSupply = 0n;
  const totalValue = new Map<string, bigint>();
  for (const a of assets) {
    const st = stateByAsset.get(a.id)!;
    totalSupply += st.supply;
    if (a.unitPrice && a.currency && /^\d+$/.test(a.unitPrice)) {
      addCurrency(totalValue, a.currency, st.supply * BigInt(a.unitPrice));
    }
  }
  const totalHolders = collectPositiveHolders([...stateByAsset.values()]).size;
  const distinctUseCases = new Set(assets.map((a) => a.useCaseKey)).size;

  // --- traded / trades / activity (buy events + all-event day buckets) ----
  const tradedTotal = new Map<string, bigint>();
  let trades = 0;

  // Build the day window: `days` UTC dates ending at `now`, oldest→newest.
  const nowDate = new Date(now);
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(nowDate.getTime() - i * 24 * 60 * 60 * 1000);
    dayKeys.push(d.toISOString().slice(0, 10));
  }
  const dayIndex = new Map(dayKeys.map((k, i) => [k, i] as const));
  const activity: ActivityDay[] = dayKeys.map((date) => ({ date, count: 0, tradedByCurrency: {} }));
  const activityTraded = dayKeys.map(() => new Map<string, bigint>());

  for (const e of sortedAudit) {
    const day = utcDate(e.createdAt);
    const idx = dayIndex.get(day);
    if (idx !== undefined) {
      activity[idx]!.count += 1;
    }
    if (e.action === "buy") {
      const p = e.payload ?? {};
      const currency = typeof p.currency === "string" ? p.currency : null;
      const cost = amountOf(p, "cost");
      // trades + tradedTotal count buys within the window (per spec).
      if (idx !== undefined) {
        trades += 1;
        if (currency) {
          addCurrency(tradedTotal, currency, cost);
          addCurrency(activityTraded[idx]!, currency, cost);
        }
      }
    }
  }
  for (let i = 0; i < activity.length; i++) {
    activity[i]!.tradedByCurrency = currencyMapToStrings(activityTraded[i]!);
  }

  // --- byLedger -----------------------------------------------------------
  const ledgerGroups = new Map<string, AssetRecord[]>();
  for (const a of assets) {
    const list = ledgerGroups.get(a.chainId) ?? [];
    list.push(a);
    ledgerGroups.set(a.chainId, list);
  }
  const byLedger: LedgerRow[] = [...ledgerGroups.entries()]
    .map(([chainId, group]) => {
      const states = group.map((a) => stateByAsset.get(a.id)!);
      const supply = states.reduce((sum, s) => sum + s.supply, 0n);
      return {
        chainId,
        mode: chainMode.get(chainId) ?? "simulated",
        assets: group.length,
        supply: supply.toString(),
        holders: collectPositiveHolders(states).size,
      };
    })
    .sort((a, b) => a.chainId.localeCompare(b.chainId));

  // --- byUseCase (platform scope only) ------------------------------------
  let byUseCase: UseCaseRow[] = [];
  if (scope === "platform") {
    const ucGroups = new Map<string, AssetRecord[]>();
    for (const a of assets) {
      const list = ucGroups.get(a.useCaseKey) ?? [];
      list.push(a);
      ucGroups.set(a.useCaseKey, list);
    }
    byUseCase = [...ucGroups.entries()]
      .map(([key, group]) => {
        const states = group.map((a) => stateByAsset.get(a.id)!);
        const supply = states.reduce((sum, s) => sum + s.supply, 0n);
        const value = new Map<string, bigint>();
        for (const a of group) {
          const st = stateByAsset.get(a.id)!;
          if (a.unitPrice && a.currency && /^\d+$/.test(a.unitPrice)) {
            addCurrency(value, a.currency, st.supply * BigInt(a.unitPrice));
          }
        }
        const info = useCaseInfo.get(key);
        // chainId: the (single) ledger this use case's assets sit on; if mixed, first by id.
        const chainId = [...new Set(group.map((a) => a.chainId))].sort()[0] ?? "";
        return {
          useCaseKey: key,
          name: info?.name ?? key,
          symbol: info?.symbol ?? "",
          chainId,
          supply: supply.toString(),
          holders: collectPositiveHolders(states).size,
          valueByCurrency: currencyMapToStrings(value),
        };
      })
      .sort((a, b) => a.useCaseKey.localeCompare(b.useCaseKey));
  }

  // --- recent (last 20 events, newest first) ------------------------------
  const assetById = new Map(assets.map((a) => [a.id, a] as const));
  const recent: RecentEvent[] = [...sortedAudit]
    .reverse()
    .slice(0, 20)
    .map((e) => {
      const asset = e.assetId ? assetById.get(e.assetId) : undefined;
      return {
        at: e.createdAt,
        action: e.action,
        assetId: e.assetId ?? "",
        assetName: asset?.name ?? "",
        chainId: e.chainId ?? asset?.chainId ?? "",
        summary: summarize(e.action, e.payload ?? {}),
      };
    });

  return {
    scope,
    useCaseKey,
    totals: {
      assets: assets.length,
      useCases: distinctUseCases,
      holders: totalHolders,
      supply: totalSupply.toString(),
      valueByCurrency: currencyMapToStrings(totalValue),
      tradedByCurrency: currencyMapToStrings(tradedTotal),
      trades,
    },
    byLedger,
    byUseCase,
    activity,
    recent,
  };
}
