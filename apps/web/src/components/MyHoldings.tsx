import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { Asset } from "../types.js";

type Holding = { asset: Asset; balance: string };

export function MyHoldings({ onSelect }: { onSelect: (id: string) => void }): JSX.Element {
  const { token, user } = useAuth();
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [cashBalances, setCashBalances] = useState<{ currency: string; amount: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const wallet = user?.walletAddress ?? null;

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const assets = await api.assets(token);
        const rows: Holding[] = [];
        for (const asset of assets) {
          const accounts = await api.assetAccounts(token, asset.id);
          const mine = accounts.find((a) => a.address.toLowerCase() === wallet?.toLowerCase());
          if (mine && mine.balance !== "0") rows.push({ asset, balance: mine.balance });
        }
        setHoldings(rows);
        if (wallet) {
          try {
            const balances = await api.cashBalances(token, wallet);
            setCashBalances(balances.map((b) => ({ currency: b.currency, amount: b.amount })));
          } catch {
            // balance load failed — section stays hidden
          }
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [token, wallet]);

  if (!wallet) return <p className="text-sm text-slate-500">No wallet is linked to your account.</p>;
  if (loading) return <p className="text-sm text-slate-500">Loading holdings…</p>;
  if (!holdings.length && !cashBalances.length) return <p className="text-sm text-slate-500">You don't hold any credits yet.</p>;

  return (
    <div className="space-y-4">
      {cashBalances.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Cash / CBDC balances</div>
          <div className="space-y-1">
            {cashBalances.map((b) => (
              <div key={b.currency} className="flex justify-between text-sm">
                <span className="text-slate-600">{b.currency}</span>
                <span className="font-medium text-slate-800">{b.amount}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {holdings.length > 0 && <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-xs text-slate-500 bg-slate-50"><tr><th className="text-left px-4 py-2">Asset</th><th className="text-left px-4 py-2">Symbol</th><th className="text-right px-4 py-2">Balance</th><th className="text-right px-4 py-2"></th></tr></thead>
        <tbody>
          {holdings.map((h) => (
            <tr key={h.asset.id} className="border-t border-slate-100 cursor-pointer hover:bg-slate-50" onClick={() => onSelect(h.asset.id)}>
              <td className="px-4 py-2">{h.asset.name}</td>
              <td className="px-4 py-2 text-slate-500">{h.asset.symbol}</td>
              <td className="px-4 py-2 text-right font-medium">{h.balance}</td>
              <td className="px-4 py-2 text-right">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(h.asset.id);
                  }}
                  title="Sell on the asset's market"
                  className="text-xs font-medium text-brand-600 hover:underline"
                >
                  Sell
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>}
    </div>
  );
}
