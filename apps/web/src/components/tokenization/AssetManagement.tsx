import { useState } from "react";
import { useAuth } from "../../auth.js";
import { can } from "../../rbac.js";
import type { ChainInfo, UseCase } from "../../types.js";
import { AssetDetail } from "./AssetDetail.js";
import { AssetList } from "./AssetList.js";
import { IssuePanel } from "./IssuePanel.js";
import { MyHoldings } from "./MyHoldings.js";
import { ReviewAssets } from "./ReviewAssets.js";

type Sub = "issuance" | "marketplace" | "holdings" | "review";

/** Identifies any use case whose schema carries the canonical invoice fields. */
const INVOICE_FIELDS = ["invoiceHash", "invoiceNumber", "buyerName", "currency", "amount", "dueDate"];
export function isInvoiceUseCase(u: UseCase | undefined): u is UseCase {
  return !!u && INVOICE_FIELDS.every((f) => f in (u.metadataSchema?.properties ?? {}));
}

export function AssetManagement({ useCaseKey, useCases, chains }: { useCaseKey: string; useCases: UseCase[]; chains: ChainInfo[] }): JSX.Element {
  const { user } = useAuth();
  const isPlatform = user?.role === "PlatformAdmin";
  const canIssue = user ? can(user.role, "issue") : false;
  const hasWallet = !!user?.walletAddress;
  const isUseCaseAdmin = user?.role === "UseCaseAdmin";

  const subs: { id: Sub; label: string }[] = [
    ...(canIssue ? [{ id: "issuance" as Sub, label: "Token Issuance" }] : []),
    { id: "marketplace" as Sub, label: "Marketplace" },
    ...(hasWallet ? [{ id: "holdings" as Sub, label: "My Holdings" }] : []),
    ...(isUseCaseAdmin ? [{ id: "review" as Sub, label: "Review Assets" }] : []),
  ];
  const [selectedSub, setSub] = useState<Sub>(subs[0]?.id ?? "marketplace");
  // Fall back if the selected tab disappears (e.g. active use case changes away from invoices).
  const sub: Sub = subs.some((s) => s.id === selectedSub) ? selectedSub : subs[0]?.id ?? "marketplace";
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Issuance is locked to the active use case; PlatformAdmin filters the list by it.
  const issueUseCases = useCases.filter((u) => u.key === useCaseKey);
  const listKey = isPlatform ? useCaseKey : undefined;

  if (selected) {
    return <AssetDetail assetId={selected} useCases={useCases} chains={chains} onBack={() => setSelected(null)} onChanged={() => setRefreshKey((k) => k + 1)} />;
  }

  return (
    <div>
      <div className="flex gap-1 mb-5">
        {subs.map((s) => (
          <button
            key={s.id}
            onClick={() => setSub(s.id)}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-medium ${sub === s.id ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {sub === "issuance" && <IssuePanel useCases={issueUseCases} chains={chains} onIssued={(id) => { setRefreshKey((k) => k + 1); setSelected(id); }} />}
      {sub === "marketplace" && <AssetList chains={chains} useCaseKey={listKey} refreshKey={refreshKey} onSelect={setSelected} />}
      {sub === "holdings" && <MyHoldings onSelect={setSelected} />}
      {sub === "review" && <ReviewAssets />}
    </div>
  );
}
