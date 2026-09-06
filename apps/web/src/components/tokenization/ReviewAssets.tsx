import { useEffect, useState } from "react";
import { api, ApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { Asset } from "../../types.js";
import { Card, EmptyState, Skeleton } from "../shared/ui.js";

export function ReviewAssets(): JSX.Element {
  const { token, user } = useAuth();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState<string | null>(null);

  async function reload(): Promise<void> {
    if (!token) return;
    setLoading(true);
    const all = await api.assets(token, user?.useCaseKey ?? undefined);
    setAssets(all.filter((a) => a.status === "pending_approval"));
    setLoading(false);
  }
  useEffect(() => { void reload(); }, [token]);

  if (loading) return <Card><Skeleton lines={4} /></Card>;
  if (assets.length === 0) return <Card><EmptyState icon="shield" title="Nothing pending review" hint="Assets awaiting due-diligence review in your use case will appear here." /></Card>;

  return (
    <div className="space-y-3">
      {assets.map((a) => (
        <div key={a.id} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm">
          <div className="p-4 flex items-center justify-between cursor-pointer" onClick={() => setReviewing((v) => (v === a.id ? null : a.id))}>
            <div>
              <div className="font-medium text-slate-800">{a.name} <span className="text-slate-400 font-normal">{a.symbol}</span></div>
              <div className="text-xs text-slate-400">{a.dueDiligence?.prospectus ? "Submitted for review" : "Awaiting documents"}</div>
            </div>
          </div>
          {reviewing === a.id && <AssetReviewPanel asset={a} onDecided={() => { setReviewing(null); void reload(); }} />}
        </div>
      ))}
    </div>
  );
}

function AssetReviewPanel({ asset, onDecided }: { asset: Asset; onDecided: () => void }): JSX.Element {
  const { token } = useAuth();
  const [riskTier, setRiskTier] = useState<"low" | "medium" | "high">("low");
  const [rejectionReason, setRejectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dd = asset.dueDiligence;

  async function decide(decision: "approved" | "rejected"): Promise<void> {
    if (!token) return;
    if (decision === "rejected" && !rejectionReason.trim()) { setError("A rejection reason is required."); return; }
    setBusy(true);
    setError(null);
    try {
      await api.decideAssetReview(token, asset.id, decision === "approved" ? { decision, riskTier } : { decision, rejectionReason: rejectionReason.trim() });
      onDecided();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record that decision");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-slate-100 p-4 space-y-3 bg-slate-50/60">
      <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
        <div>Prospectus: {dd?.prospectus ? "attached" : "missing"}</div>
        <div>Legal opinion: {dd?.legalOpinion ? "attached" : "—"}</div>
      </div>
      {dd?.additionalDocuments?.length ? <div className="text-xs text-slate-600">Additional: {dd.additionalDocuments.map((d) => d.label).join(", ")}</div> : null}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <select className="rounded border border-slate-300 px-2 py-1 text-xs" value={riskTier} onChange={(e) => setRiskTier(e.target.value as "low" | "medium" | "high")}>
          <option value="low">Low risk</option>
          <option value="medium">Medium risk</option>
          <option value="high">High risk</option>
        </select>
        <button disabled={busy || !dd?.prospectus} onClick={() => void decide("approved")} className="text-xs rounded bg-emerald-600 text-white px-3 py-1.5 font-medium hover:bg-emerald-700 disabled:opacity-40">Approve</button>
        <input className="rounded border border-slate-300 px-2 py-1 text-xs flex-1" placeholder="Rejection reason" value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} />
        <button disabled={busy} onClick={() => void decide("rejected")} className="text-xs rounded border border-red-300 text-red-600 px-3 py-1.5 font-medium hover:bg-red-50 disabled:opacity-40">Reject</button>
      </div>
    </div>
  );
}
