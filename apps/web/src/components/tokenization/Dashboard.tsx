import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { useRoute } from "../../router.js";
import { SANDBOX_EXCLUDED_NOTE } from "../../lib/shared/modes.js";
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

export function Dashboard({ useCaseKey }: { useCaseKey?: string }): JSX.Element {
  const { token } = useAuth();
  const { navigate } = useRoute();
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * EN-D2: the server leaves SANDBOX use cases out of `/analytics` unless asked
   * for them by name. Every figure below is therefore smaller than the catalog
   * a reader can see in Use Cases, and the difference is invisible without this
   * — a silently-shrunken total is the reporting defect nobody catches, because
   * the number still looks like a number.
   *
   * Off by default, matching the server: a real total is the one an operator is
   * asking for, and the toggle exists so "where did my sandbox go?" has a
   * one-click answer rather than a support ticket.
   */
  const [includeSandbox, setIncludeSandbox] = useState(false);
  const scrollTo = (id: string): void => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  useEffect(() => {
    if (!token) return;
    setData(null);
    setError(null);
    api
      .analytics(token, { ...(useCaseKey ? { useCaseKey } : {}), includeSandbox })
      .then(setData)
      .catch(() => setError("Could not load analytics"));
  }, [token, useCaseKey, includeSandbox]);

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

  /**
   * The scope note plus its toggle. Rendered in BOTH branches below, and the
   * empty one is the branch that matters: an organization whose only work so far
   * is in the sandbox otherwise reads "No assets yet" while its register is full
   * of them, with nothing on the screen to suggest a second environment exists.
   */
  const sandboxControl = (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <p className="text-slate-500">
        {includeSandbox
          ? "Sandbox use cases are INCLUDED in these figures. Simulated assets are counted alongside real ones — do not report from this view."
          : SANDBOX_EXCLUDED_NOTE}
      </p>
      <label className="flex items-center gap-2 text-slate-600 cursor-pointer shrink-0">
        <input
          type="checkbox"
          checked={includeSandbox}
          onChange={(e) => setIncludeSandbox(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        Include sandbox
      </label>
    </div>
  );

  if (data.totals.assets === 0) {
    return (
      <div className="space-y-3">
        {sandboxControl}
        <Card>
          <EmptyState
            icon="coins"
            title="No assets yet"
            hint={includeSandbox
              ? "Issue an asset to see cross-ledger analytics — supply, holders, value and trading activity."
              : "Issue an asset to see cross-ledger analytics — supply, holders, value and trading activity. Sandbox use cases are not counted here; tick Include sandbox if your work so far is in the sandbox."}
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
      {sandboxControl}
      {/* headline cards — click to drill into the matching breakdown */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat icon="coins" label="Tokenized value" value={fmtMoney(t.valueByCurrency)} sub={`${t.assets} assets · ${t.useCases} use case${t.useCases === 1 ? "" : "s"}`} onClick={() => scrollTo(data.scope === "platform" ? "dash-usecases" : "dash-ledger")} stagger={1} />
        <Stat icon="spark" label="Total supply" value={fmtInt(t.supply)} sub="minted − burned" onClick={() => scrollTo("dash-ledger")} stagger={2} />
        <Stat icon="users" label="Holders" value={String(t.holders)} sub="distinct accounts" onClick={() => scrollTo(data.scope === "platform" ? "dash-usecases" : "dash-ledger")} stagger={3} />
        <Stat icon="arrow" label={`Traded (${data.activity.length}d)`} value={fmtMoney(t.tradedByCurrency)} sub={`${t.trades} trade${t.trades === 1 ? "" : "s"}`} onClick={() => scrollTo("dash-recent")} stagger={4} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div id="dash-ledger" className="scroll-mt-4">
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
        <div id="dash-usecases" className="scroll-mt-4">
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
        <div id="dash-recent" className="scroll-mt-4">
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
