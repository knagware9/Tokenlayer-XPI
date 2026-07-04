import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import { can } from "../rbac.js";
import type { Asset, ChainInfo } from "../types.js";

interface Props {
  chains: ChainInfo[];
  refreshKey: number;
  onSelect: (id: string) => void;
  useCaseKey?: string;
}

/** Is the asset listed for sale with treasury stock still available to buy? */
function availability(a: Asset): "available" | "sold-out" | "not-listed" {
  if (!a.unitPrice || !a.currency) return "not-listed";
  if (a.availableSupply == null) return "available"; // priced but balance unknown
  try {
    return BigInt(a.availableSupply) > 0n ? "available" : "sold-out";
  } catch {
    return "available";
  }
}

export function AssetList({ chains, refreshKey, onSelect, useCaseKey }: Props): JSX.Element {
  const { token, user } = useAuth();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const canBuy = user ? can(user.role, "buy") : false;

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api.assets(token, useCaseKey).then((a) => {
      setAssets(a);
      setLoading(false);
    });
  }, [token, refreshKey, useCaseKey]);

  const chainOf = (id: string): ChainInfo | undefined => chains.find((c) => c.id === id);

  if (loading) return <p className="text-sm text-slate-400">Loading assets…</p>;
  if (assets.length === 0)
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">
        No assets yet.
      </div>
    );

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left font-medium px-4 py-2.5">Asset name</th>
            <th className="text-left font-medium px-4 py-2.5">Type</th>
            <th className="text-right font-medium px-4 py-2.5">Token price</th>
            <th className="text-right font-medium px-4 py-2.5">Total supply</th>
            <th className="text-left font-medium px-4 py-2.5">On-chain</th>
            <th className="text-left font-medium px-4 py-2.5">Available</th>
            <th className="text-right font-medium px-4 py-2.5">{canBuy ? "Buy" : ""}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {assets.map((a) => {
            const avail = availability(a);
            return (
              <tr key={a.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => onSelect(a.id)}>
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-800">{a.name}</div>
                  <div className="text-xs text-slate-400">{a.symbol}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="text-slate-700">{a.tokenStandard}</div>
                  <div className="text-xs text-slate-400">{a.tokenType}</div>
                </td>
                <td className="px-4 py-3 text-right text-slate-700">
                  {a.unitPrice ? <span className="font-medium">{a.unitPrice} <span className="text-xs text-slate-400">{a.currency}</span></span> : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-4 py-3 text-right font-mono text-slate-700">{a.totalSupply ?? "—"}</td>
                <td className="px-4 py-3">
                  {(() => {
                    const chain = chainOf(a.chainId);
                    const real = chain?.mode === "real";
                    const tone = real ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500";
                    return (
                      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${tone}`} title={a.contractRef}>
                        {real ? "⛓" : "🧪"} {chain?.label ?? a.chainId}{real ? "" : " · sim"}
                      </span>
                    );
                  })()}
                </td>
                <td className="px-4 py-3">
                  {avail === "available" && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Available</span>}
                  {avail === "sold-out" && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Sold out</span>}
                  {avail === "not-listed" && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">Not listed</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  {canBuy && avail === "available" && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onSelect(a.id); }}
                      className="rounded-lg bg-brand-600 text-white px-3 py-1 text-xs font-medium hover:bg-brand-700"
                    >
                      Buy
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
