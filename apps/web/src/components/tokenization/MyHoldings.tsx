import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { TableShell } from "../shared/ui.js";
import type { Asset } from "../../types.js";

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

  if (!wallet) return <p className="text-sm text-muted">No wallet is linked to your account.</p>;
  if (loading) return <p className="text-sm text-muted">Loading holdings…</p>;
  if (!holdings.length && !cashBalances.length) return <p className="text-sm text-muted">You don't hold any credits yet.</p>;

  return (
    <div className="space-y-4">
      {cashBalances.length > 0 && (
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="text-xs font-semibold text-muted mb-2">Cash / CBDC balances</div>
          <div className="space-y-1">
            {cashBalances.map((b) => (
              <div key={b.currency} className="flex justify-between text-sm">
                <span className="text-muted">{b.currency}</span>
                <span className="font-medium text-fg">{b.amount}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {holdings.length > 0 && (
        <TableShell>
          <thead><tr><th>Asset</th><th>Symbol</th><th className="text-right">Balance</th><th></th></tr></thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.asset.id} className="cursor-pointer" onClick={() => onSelect(h.asset.id)}>
                <td className="text-fg">{h.asset.name}</td>
                <td className="text-muted">{h.asset.symbol}</td>
                <td className="num text-fg font-medium">{h.balance}</td>
                <td className="text-right">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(h.asset.id);
                    }}
                    title="View the asset's detail, including its sell options"
                    className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}
