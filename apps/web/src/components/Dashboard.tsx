import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { AnalyticsSummary } from "../types.js";
import { AreaChart } from "./charts/AreaChart.js";
import { BarChart } from "./charts/BarChart.js";
import { Donut, type DonutSlice } from "./charts/Donut.js";

/** A small fixed palette so a given ledger keeps the same colour across charts. */
const LEDGER_COLORS: Record<string, string> = { besu: "#10b981", mst: "#6366f1", fabric: "#f59e0b", canton: "#8b5cf6", "local-evm": "#0ea5e9" };
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
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setData(null);
    setError(null);
    api
      .analytics(token, useCaseKey ? { useCaseKey } : {})
      .then(setData)
      .catch(() => setError("Could not load analytics"));
  }, [token, useCaseKey]);

  if (error) return <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-red-600">{error}</div>;
  if (!data) return <div className="text-sm text-slate-400">Loading analytics…</div>;

  if (data.totals.assets === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">
        No assets yet — issue one to see analytics here.
      </div>
    );
  }

  const t = data.totals;
  const ledgerSlices: DonutSlice[] = data.byLedger.map((l) => ({ label: l.chainId, value: Number(l.supply), color: colorFor(l.chainId) }));
  const activityPoints = data.activity.map((a) => ({ label: a.date, value: a.count }));

  return (
    <div className="space-y-4">
      {/* headline cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Tokenized value" value={fmtMoney(t.valueByCurrency)} sub={`${t.assets} assets · ${t.useCases} use case${t.useCases === 1 ? "" : "s"}`} />
        <Stat label="Total supply" value={fmtInt(t.supply)} sub="minted − burned" />
        <Stat label="Holders" value={String(t.holders)} sub="distinct accounts" />
        <Stat label={`Traded (${data.activity.length}d)`} value={fmtMoney(t.tradedByCurrency)} sub={`${t.trades} trade${t.trades === 1 ? "" : "s"}`} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Supply by ledger">
          <Donut slices={ledgerSlices} />
        </Card>
        <Card title={`Activity — transactions / day (${data.activity.length}d)`}>
          <AreaChart points={activityPoints} />
          <div className="flex justify-between text-[10px] text-slate-400 mt-1">
            <span>{data.activity[0]?.date}</span>
            <span>{data.activity[data.activity.length - 1]?.date}</span>
          </div>
        </Card>
      </div>

      {data.scope === "platform" && data.byUseCase.length > 0 && (
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
                  <tr key={u.useCaseKey} className="border-t border-slate-100">
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
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Supply by ledger (detail)">
          <BarChart bars={data.byLedger.map((l) => ({ label: `${l.chainId} · ${l.mode}`, value: Number(l.supply) }))} />
        </Card>
        <Card title="Recent activity">
          <ol className="space-y-1.5">
            {data.recent.slice(0, 8).map((e, i) => (
              <li key={`${e.at}-${e.assetId}-${i}`} className="flex items-start gap-2 text-xs">
                <span className="mt-0.5 w-16 shrink-0 text-[10px] font-semibold text-brand-600 uppercase">{e.action}</span>
                <span className="flex-1 text-slate-600">
                  <span className="text-slate-800">{e.assetName}</span> · {e.summary}
                </span>
                <span className="text-[10px] text-slate-400">{new Date(e.at).toLocaleDateString()}</span>
              </li>
            ))}
            {data.recent.length === 0 && <li className="text-xs text-slate-400">No activity yet.</li>}
          </ol>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-lg font-bold text-slate-900 mt-0.5 break-words">{value}</div>
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="font-semibold text-slate-800 text-sm mb-3">{title}</div>
      {children}
    </div>
  );
}
