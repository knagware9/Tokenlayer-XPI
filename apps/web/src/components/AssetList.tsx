import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { Asset, ChainInfo } from "../types.js";

interface Props {
  chains: ChainInfo[];
  refreshKey: number;
  onSelect: (id: string) => void;
  useCaseKey?: string;
}

export function AssetList({ chains, refreshKey, onSelect, useCaseKey }: Props): JSX.Element {
  const { token } = useAuth();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api.assets(token, useCaseKey).then((a) => {
      setAssets(a);
      setLoading(false);
    });
  }, [token, refreshKey, useCaseKey]);

  const chainLabel = (id: string): string => chains.find((c) => c.id === id)?.label ?? id;

  if (loading) return <p className="text-sm text-slate-400">Loading assets…</p>;
  if (assets.length === 0)
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">
        No assets yet. Switch to <span className="font-medium text-slate-700">Token Issuance</span> to create one.
      </div>
    );

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left font-medium px-4 py-2.5">Asset</th>
            <th className="text-left font-medium px-4 py-2.5">Use case</th>
            <th className="text-left font-medium px-4 py-2.5">Chain</th>
            <th className="text-left font-medium px-4 py-2.5">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {assets.map((a) => (
            <tr key={a.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => onSelect(a.id)}>
              <td className="px-4 py-3">
                <div className="font-medium text-slate-800">{a.name}</div>
                <div className="text-xs text-slate-400">{a.symbol}</div>
              </td>
              <td className="px-4 py-3 text-slate-600">{a.useCaseKey}</td>
              <td className="px-4 py-3">
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{chainLabel(a.chainId)}</span>
              </td>
              <td className="px-4 py-3">
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">{a.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
