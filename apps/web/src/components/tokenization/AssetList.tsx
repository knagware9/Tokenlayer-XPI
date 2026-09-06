import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { can } from "../../rbac.js";
import type { Asset, ChainInfo } from "../../types.js";
import { Card, EmptyState, Pill, Skeleton } from "../shared/ui.js";

interface Props {
  chains: ChainInfo[];
  refreshKey: number;
  onSelect: (id: string) => void;
  useCaseKey?: string;
}

/** Is the asset listed for sale with treasury stock still available to buy? */
export function availability(a: Asset): "available" | "sold-out" | "not-listed" {
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
  // "issue" is the same capability the setPrice action itself requires server-side —
  // whoever can issue an asset can also list it (or relist it) for primary sale.
  const canListForSale = user ? can(user.role, "issue") : false;

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api.assets(token, useCaseKey).then((a) => {
      setAssets(a);
      setLoading(false);
    });
  }, [token, refreshKey, useCaseKey]);

  const chainOf = (id: string): ChainInfo | undefined => chains.find((c) => c.id === id);

  if (loading)
    return (
      <Card>
        <Skeleton lines={4} />
      </Card>
    );
  if (assets.length === 0)
    return (
      <Card>
        <EmptyState icon="coins" title="No assets yet" hint="Issue an asset from the Token Issuance tab to see it listed here." />
      </Card>
    );

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left font-medium px-4 py-2.5">Asset name</th>
            <th className="text-left font-medium px-4 py-2.5">Type</th>
            <th className="text-right font-medium px-4 py-2.5">Token price</th>
            <th className="text-right font-medium px-4 py-2.5">Total supply</th>
            <th className="text-left font-medium px-4 py-2.5">On-chain</th>
            <th className="text-left font-medium px-4 py-2.5">Available</th>
            <th className="text-left font-medium px-4 py-2.5">Risk</th>
            <th className="text-right font-medium px-4 py-2.5">{canBuy ? "Buy" : canListForSale ? "List" : ""}</th>
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
                    return (
                      <span title={a.contractRef}>
                        <Pill tone={real ? "ok" : "muted"}>
                          {real ? "⛓" : "🧪"} {chain?.label ?? a.chainId}{real ? "" : " · sim"}
                        </Pill>
                      </span>
                    );
                  })()}
                </td>
                <td className="px-4 py-3">
                  {avail === "available" && <Pill tone="ok">Available</Pill>}
                  {avail === "sold-out" && <Pill tone="warn">Sold out</Pill>}
                  {avail === "not-listed" && <Pill tone="muted">Not listed</Pill>}
                </td>
                <td className="px-4 py-3">
                  {a.status === "pending_approval" ? (
                    <Pill tone="muted">Pending review</Pill>
                  ) : a.dueDiligence?.riskTier ? (
                    <Pill tone={a.dueDiligence.riskTier === "low" ? "ok" : a.dueDiligence.riskTier === "medium" ? "warn" : "danger"}>{a.dueDiligence.riskTier}</Pill>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
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
                  {canListForSale && avail === "not-listed" && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onSelect(a.id); }}
                      className="rounded-lg border border-brand-600 text-brand-600 px-3 py-1 text-xs font-medium hover:bg-brand-50"
                    >
                      List
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
