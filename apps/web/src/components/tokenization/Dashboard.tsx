import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { useRoute } from "../../router.js";
import type { AnalyticsSummary } from "../../types.js";
import { AreaChart } from "../charts/AreaChart.js";
import { BarChart } from "../charts/BarChart.js";
import { Donut, type DonutSlice } from "../charts/Donut.js";
import { Card, EmptyState, Skeleton, StatCard, type IconName } from "../shared/ui.js";

/** A small fixed palette so a given ledger keeps the same colour across charts. */
const LEDGER_COLORS: Record<string, string> = { besu: "#10b981", mst: "#6366f1", fabric: "#f59e0b", canton: "#8b5cf6" };
const colorFor = (chainId: string): string => LEDGER_COLORS[chainId] ?? "#64748b";

function fmtInt(s: string | number): string {
  try {
    return BigInt(String(s)).toLocaleString();
  } catch {
    return String(s);
  }
}

/** "INR 6,350,000 · USD 120,000" — no FX conversion, one entry per currency. */
function fmtMoney(byCurrency: Record<string, string>): string {
  const parts = Object.entries(byCurrency).filter(([, v]) => v !== "0");
  if (parts.length === 0) return "—";
  return parts.map(([cur, amt]) => `${fmtInt(amt)} ${cur}`).join(" · ");
}

export function Dashboard({ useCaseKey, onNavigate }: { useCaseKey?: string; onNavigate?: (id: string) => void }): JSX.Element {
  const { token } = useAuth();
  const { navigate } = useRoute();
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A stat card's target section is often already fully in view on a short page —
  // scrollIntoView then produces no visible motion at all, and the click reads as
  // dead. The flash gives every click a visible result whether or not it scrolled.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const scrollTo = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlightedId(id);
    setTimeout(() => setHighlightedId((cur) => (cur === id ? null : cur)), 1400);
  };
  const flash = (id: string): string =>
    `scroll-mt-4 rounded-2xl transition-shadow duration-500 ${highlightedId === id ? "ring-2 ring-brand-400 shadow-lg" : "ring-2 ring-transparent"}`;

  useEffect(() => {
    if (!token) return;
    setData(null);
    setError(null);
    api
      .analytics(token, { ...(useCaseKey ? { useCaseKey } : {}) })
      .then(setData)
      .catch(() => setError("Could not load analytics"));
  }, [token, useCaseKey]);

  if (error) return <Card><p className="text-sm text-red-600">{error}</p></Card>;
  if (!data)
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i}><Skeleton lines={2} /></Card>
          ))}
        </div>
        <Card><Skeleton lines={4} /></Card>
      </div>
    );

  if (data.totals.assets === 0) {
    return (
      <div className="space-y-3">
        <Card>
          <EmptyState
            icon="coins"
            title="No assets yet"
            hint="Issue an asset to see cross-ledger analytics — supply, holders, value and trading activity."
          />
        </Card>
      </div>
    );
  }

  const t = data.totals;
  const ledgerSlices: DonutSlice[] = data.byLedger.map((l) => ({ label: l.chainId, value: Number(l.supply), color: colorFor(l.chainId) }));
  const activityPoints = data.activity.map((a) => ({ label: a.date, value: a.count }));

  return (
    <div className="space-y-4">
      {/* headline cards — click to drill into the matching breakdown */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat icon="coins" label="Tokenized value" value={fmtMoney(t.valueByCurrency)} sub={`${t.assets} assets · ${t.useCases} use case${t.useCases === 1 ? "" : "s"}`} onClick={() => (data.scope === "platform" ? scrollTo("dash-usecases") : onNavigate?.("assets"))} stagger={1} />
        <Stat icon="spark" label="Total supply" value={fmtInt(t.supply)} sub="minted − burned" onClick={() => scrollTo("dash-ledger")} stagger={2} />
        {/* "Holders" has no per-holder breakdown on this page (that lives per-asset, in
            the asset's own Holders table) — jump there instead of a scroll target with
            nothing about holders on it. */}
        <Stat icon="users" label="Holders" value={String(t.holders)} sub="distinct accounts" onClick={() => (data.scope === "platform" ? scrollTo("dash-usecases") : onNavigate?.("assets"))} stagger={3} />
        <Stat icon="arrow" label={`Traded (${data.activity.length}d)`} value={fmtMoney(t.tradedByCurrency)} sub={`${t.trades} trade${t.trades === 1 ? "" : "s"}`} onClick={() => scrollTo("dash-recent")} stagger={4} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div id="dash-ledger" className={flash("dash-ledger")}>
          <Card title="Supply by ledger">
            <Donut slices={ledgerSlices} />
          </Card>
        </div>
        <Card title={`Activity — transactions / day (${data.activity.length}d)`}>
          <AreaChart points={activityPoints} />
          <div className="flex justify-between text-[10px] text-slate-400 mt-1">
            <span>{data.activity[0]?.date}</span>
            <span>{data.activity[data.activity.length - 1]?.date}</span>
          </div>
        </Card>
      </div>

      {data.scope === "platform" && data.byUseCase.length > 0 && (
        <div id="dash-usecases" className={flash("dash-usecases")}>
          <Card title="By use case">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[10px] text-slate-400 bg-slate-50/80 uppercase tracking-widest">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2.5">Use case</th>
                    <th className="text-left font-semibold px-3 py-2.5">Ledger</th>
                    <th className="text-right font-semibold px-3 py-2.5">Supply</th>
                    <th className="text-right font-semibold px-3 py-2.5">Holders</th>
                    <th className="text-right font-semibold px-3 py-2.5">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byUseCase.map((u) => (
                    <tr key={u.useCaseKey} onClick={() => navigate(`/${u.useCaseKey}`)} title={`Open ${u.name}`}
                      className="border-t border-slate-100 cursor-pointer hover:bg-slate-50/70 transition-colors">
                      <td className="px-3 py-2.5 font-medium text-slate-800">
                        {u.name} <span className="font-normal text-slate-400">{u.symbol}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorFor(u.chainId) }} />
                          <span className="text-slate-600">{u.chainId}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-data tabular-nums text-slate-700">{fmtInt(u.supply)}</td>
                      <td className="px-3 py-2.5 text-right font-data tabular-nums text-slate-700">{u.holders}</td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{fmtMoney(u.valueByCurrency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Supply by ledger (detail)">
          <BarChart bars={data.byLedger.map((l) => ({ label: `${l.chainId} · ${l.mode}`, value: Number(l.supply) }))} />
        </Card>
        <div id="dash-recent" className={flash("dash-recent")}>
          <Card title="Recent activity">
            <ol className="space-y-0 divide-y divide-slate-100">
              {data.recent.slice(0, 8).map((e, i) => {
                const clickable = !!e.useCaseKey;
                const ACTION_COLORS: Record<string, string> = {
                  mint: "bg-emerald-50 text-emerald-700 border-emerald-200/70",
                  burn: "bg-red-50 text-red-700 border-red-200/70",
                  transfer: "bg-sky-50 text-sky-700 border-sky-200/70",
                  issue: "bg-brand-50 text-brand-700 border-brand-200/70",
                };
                const actionStyle = ACTION_COLORS[e.action.toLowerCase()] ?? "bg-slate-100 text-slate-600 border-slate-200";
                return (
                  <li
                    key={`${e.at}-${e.assetId}-${i}`}
                    onClick={clickable ? () => navigate(`/${e.useCaseKey}`) : undefined}
                    title={clickable ? `Open ${e.assetName}` : undefined}
                    className={`flex items-center gap-3 py-2.5 first:pt-0 last:pb-0 text-xs ${clickable ? "cursor-pointer hover:bg-slate-50/80 -mx-2 px-2 rounded-lg transition-colors" : ""}`}
                  >
                    <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${actionStyle}`}>
                      {e.action}
                    </span>
                    <span className="flex-1 min-w-0 text-slate-600 truncate">
                      <span className="font-semibold text-slate-800">{e.assetName}</span>
                      <span className="text-slate-400"> · </span>
                      {e.summary}
                    </span>
                    <span className="font-data text-[10px] text-slate-400 shrink-0">{new Date(e.at).toLocaleDateString()}</span>
                  </li>
                );
              })}
              {data.recent.length === 0 && (
                <li className="text-xs text-slate-400 py-4 text-center">No activity yet.</li>
              )}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, sub, onClick, stagger }: { icon: IconName; label: string; value: string; sub?: string; onClick?: () => void; stagger?: number }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left w-full cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md rounded-2xl animate-slide-up ${stagger ? `stagger-${stagger}` : ""}`}
    >
      <StatCard icon={icon} label={label} value={value} sub={sub} />
    </button>
  );
}
