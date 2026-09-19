import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { can } from "../../rbac.js";
import type { Asset, ChainInfo } from "../../types.js";
import { Card, EmptyState, Pill, Skeleton, TableShell } from "../shared/ui.js";

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
    <TableShell>
      <thead>
        <tr>
          <th>Asset name</th>
          <th>Type</th>
          <th>Token price</th>
          <th>Total supply</th>
          <th>On-chain</th>
          <th>Available</th>
          <th>Risk</th>
          <th>{canBuy ? "Buy" : canListForSale ? "List" : ""}</th>
        </tr>
      </thead>
      <tbody>
        {assets.map((a) => {
          const avail = availability(a);
          return (
            <tr key={a.id} className="cursor-pointer" onClick={() => onSelect(a.id)}>
              <td>
                <div className="font-medium text-fg">{a.name}</div>
                <div className="text-muted">{a.symbol}</div>
              </td>
              <td>
                <div className="text-fg">{a.tokenStandard}</div>
                <div className="text-muted">{a.tokenType}</div>
              </td>
              <td className="num text-fg">
                {a.unitPrice ? <span className="font-medium">{a.unitPrice} <span className="text-muted">{a.currency}</span></span> : <span className="text-muted">—</span>}
              </td>
              <td className="num font-mono text-fg">{a.totalSupply ?? "—"}</td>
              <td>
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
              <td>
                {avail === "available" && <Pill tone="ok">Available</Pill>}
                {avail === "sold-out" && <Pill tone="warn">Sold out</Pill>}
                {avail === "not-listed" && <Pill tone="muted">Not listed</Pill>}
              </td>
              <td>
                {a.status === "pending_approval" ? (
                  <Pill tone="muted">Pending review</Pill>
                ) : a.dueDiligence?.riskTier ? (
                  <Pill tone={a.dueDiligence.riskTier === "low" ? "ok" : a.dueDiligence.riskTier === "medium" ? "warn" : "danger"}>{a.dueDiligence.riskTier}</Pill>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className="text-right">
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
    </TableShell>
  );
}
