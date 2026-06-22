import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { Asset } from "../types.js";

type Holding = { asset: Asset; balance: string };

export function MyHoldings({ onSelect }: { onSelect: (id: string) => void }): JSX.Element {
  const { token, user } = useAuth();
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);
  const wallet = user?.walletAddress ?? null;

  useEffect(() => {
    if (!token) return;
    void (async () => {
      const assets = await api.assets(token);
      const rows: Holding[] = [];
      for (const asset of assets) {
        const accounts = await api.assetAccounts(token, asset.id);
        const mine = accounts.find((a) => a.address.toLowerCase() === wallet?.toLowerCase());
        if (mine && mine.balance !== "0") rows.push({ asset, balance: mine.balance });
      }
      setHoldings(rows);
      setLoading(false);
    })();
  }, [token, wallet]);

  if (!wallet) return <p className="text-sm text-slate-500">No wallet is linked to your account.</p>;
  if (loading) return <p className="text-sm text-slate-500">Loading holdings…</p>;
  if (!holdings.length) return <p className="text-sm text-slate-500">You don't hold any credits yet.</p>;

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-xs text-slate-500 bg-slate-50"><tr><th className="text-left px-4 py-2">Asset</th><th className="text-left px-4 py-2">Symbol</th><th className="text-right px-4 py-2">Balance</th></tr></thead>
        <tbody>
          {holdings.map((h) => (
            <tr key={h.asset.id} className="border-t border-slate-100 cursor-pointer hover:bg-slate-50" onClick={() => onSelect(h.asset.id)}>
              <td className="px-4 py-2">{h.asset.name}</td>
              <td className="px-4 py-2 text-slate-500">{h.asset.symbol}</td>
              <td className="px-4 py-2 text-right font-medium">{h.balance}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
