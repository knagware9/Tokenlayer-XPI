import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import { useRoute } from "../router.js";
import type { AnalyticsSummary } from "../types.js";
import { AreaChart } from "./charts/AreaChart.js";
import { BarChart } from "./charts/BarChart.js";
import { Donut, type DonutSlice } from "./charts/Donut.js";
import { Card, EmptyState, Skeleton, StatCard, type IconName } from "./ui.js";

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
  const scrollTo = (id: string): void => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  useEffect(() => {
    if (!token) return;
    setData(null);
    setError(null);
    api
      .analytics(token, useCaseKey ? { useCaseKey } : {})
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
      <Card>
        <EmptyState
          icon="coins"
          title="No assets yet"
          hint="Issue an asset to see cross-ledger analytics — supply, holders, value and trading activity."
        />
      </Card>
    );
  }

  const t = data.totals;
  const ledgerSlices: DonutSlice[] = data.byLedger.map((l) => ({ label: l.chainId, value: Number(l.supply), color: colorFor(l.chainId) }));
  const activityPoints = data.activity.map((a) => ({ label: a.date, value: a.count }));

  return (
    <div className="space-y-4">
      {/* headline cards — click to drill into the matching breakdown */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat icon="coins" label="Tokenized value" value={fmtMoney(t.valueByCurrency)} sub={`${t.assets} assets · ${t.useCases} use case${t.useCases === 1 ? "" : "s"}`} onClick={() => scrollTo(data.scope === "platform" ? "dash-usecases" : "dash-ledger")} />
        <Stat icon="spark" label="Total supply" value={fmtInt(t.supply)} sub="minted − burned" onClick={() => scrollTo("dash-ledger")} />
        <Stat icon="users" label="Holders" value={String(t.holders)} sub="distinct accounts" onClick={() => scrollTo(data.scope === "platform" ? "dash-usecases" : "dash-ledger")} />
        <Stat icon="arrow" label={`Traded (${data.activity.length}d)`} value={fmtMoney(t.tradedByCurrency)} sub={`${t.trades} trade${t.trades === 1 ? "" : "s"}`} onClick={() => scrollTo("dash-recent")} />
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
                <thead className="text-slate-400 text-[10px] uppercase tracking-wide">
                  <tr>
                    <th className="text-left py-1.5">Use case</th>
                    <th className="text-left">Ledger</th>
                    <th className="text-right">Supply</th>
                    <th className="text-right">Holders</th>
                    <th className="text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byUseCase.map((u) => (
                    <tr key={u.useCaseKey} onClick={() => navigate(`/${u.useCaseKey}`)} title={`Open ${u.name}`} className="border-t border-slate-100 cursor-pointer hover:bg-slate-50">
                      <td className="py-1.5">
                        {u.name} <span className="text-slate-400">{u.symbol}</span>
                      </td>
                      <td>
                        <span style={{ color: colorFor(u.chainId) }}>●</span> {u.chainId}
                      </td>
                      <td className="text-right tabular-nums">{fmtInt(u.supply)}</td>
                      <td className="text-right tabular-nums">{u.holders}</td>
                      <td className="text-right">{fmtMoney(u.valueByCurrency)}</td>
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
            <ol className="space-y-1.5">
              {data.recent.slice(0, 8).map((e, i) => {
                const clickable = !!e.useCaseKey;
                return (
                  <li
                    key={`${e.at}-${e.assetId}-${i}`}
                    onClick={clickable ? () => navigate(`/${e.useCaseKey}`) : undefined}
                    title={clickable ? `Open ${e.assetName}` : undefined}
                    className={`flex items-start gap-2 text-xs rounded px-1 -mx-1 ${clickable ? "cursor-pointer hover:bg-slate-50" : ""}`}
                  >
                    <span className="mt-0.5 w-16 shrink-0 text-[10px] font-semibold text-brand-600 uppercase">{e.action}</span>
                    <span className="flex-1 text-slate-600">
                      <span className="text-slate-800">{e.assetName}</span> · {e.summary}
                    </span>
                    <span className="text-[10px] text-slate-400">{new Date(e.at).toLocaleDateString()}</span>
                  </li>
                );
              })}
              {data.recent.length === 0 && <li className="text-xs text-slate-400">No activity yet.</li>}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** A StatCard that keeps the old drill-down click behavior. */
function Stat({ icon, label, value, sub, onClick }: { icon: IconName; label: string; value: string; sub?: string; onClick?: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="text-left w-full cursor-pointer transition hover:-translate-y-0.5">
      <StatCard icon={icon} label={label} value={value} sub={sub} />
    </button>
  );
}
