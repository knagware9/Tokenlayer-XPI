import { useEffect, useState } from "react";
import { api, ApiError, API_BASE } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { Asset } from "../../types.js";
import { Card, EmptyState, Skeleton } from "../shared/ui.js";

export function ReviewAssets(): JSX.Element {
  const { token, user } = useAuth();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);

  async function reload(): Promise<void> {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const all = await api.assets(token, user?.useCaseKey ?? undefined);
      setAssets(all.filter((a) => a.status === "pending_approval"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load assets pending review");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void reload(); }, [token]);

  if (loading) return <Card><Skeleton lines={4} /></Card>;
  if (error) return <Card><EmptyState icon="warn" title="Could not load review queue" hint={error} /></Card>;
  if (assets.length === 0) return <Card><EmptyState icon="shield" title="Nothing pending review" hint="Assets awaiting due-diligence review in your use case will appear here." /></Card>;

  return (
    <div className="space-y-3">
      {assets.map((a) => (
        <div key={a.id} className="bg-surface rounded-2xl border border-border/80 shadow-sm">
          <div className="p-4 flex items-center justify-between cursor-pointer" onClick={() => setReviewing((v) => (v === a.id ? null : a.id))}>
            <div>
              <div className="font-medium text-fg">{a.name} <span className="text-muted font-normal">{a.symbol}</span></div>
              <div className="text-xs text-muted">{a.dueDiligence?.prospectus ? "Submitted for review" : "Awaiting documents"}</div>
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

  // Same popup-blocker-safe pattern as AssetDetail.tsx's DueDiligenceDisplay:
  // open a blank tab synchronously (before the async fetch), then redirect it
  // once the bytes arrive — a plain <a href> can't carry the Bearer token
  // this codebase uses for auth, and window.open() after an await is
  // silently blocked by real browsers' popup blockers.
  async function openDocument(docId: string): Promise<void> {
    if (!token) return;
    const win = window.open("", "_blank");
    try {
      const res = await fetch(`${API_BASE}/assets/${asset.id}/diligence/documents/${docId}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) { win?.close(); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url; else window.open(url, "_blank");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      win?.close();
    }
  }

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
    <div className="border-t border-border p-4 space-y-3 bg-elevated/60">
      <div className="grid grid-cols-2 gap-2 text-xs text-muted">
        <div>
          Prospectus:{" "}
          {dd?.prospectus
            ? <button onClick={() => void openDocument(dd.prospectus!.id)} className="text-brand-600 hover:text-brand-700 font-medium">open ↗</button>
            : "missing"}
        </div>
        <div>
          Legal opinion:{" "}
          {dd?.legalOpinion
            ? <button onClick={() => void openDocument(dd.legalOpinion!.id)} className="text-brand-600 hover:text-brand-700 font-medium">open ↗</button>
            : "—"}
        </div>
      </div>
      {dd?.additionalDocuments?.length ? (
        <div className="text-xs text-muted flex flex-wrap gap-x-1">
          Additional:{" "}
          {dd.additionalDocuments.map((d, i) => (
            <span key={d.id}>
              <button onClick={() => void openDocument(d.id)} className="text-brand-600 hover:text-brand-700 font-medium">{d.label} ↗</button>
              {i < dd.additionalDocuments!.length - 1 ? "," : ""}
            </span>
          ))}
        </div>
      ) : null}
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-3">
        <select className="rounded-lg border border-border bg-elevated/80 px-2.5 py-1 text-xs focus:outline-none focus:border-primary focus:bg-surface focus:ring-4 focus:ring-primary/15" value={riskTier} onChange={(e) => setRiskTier(e.target.value as "low" | "medium" | "high")}>
          <option value="low">Low risk</option>
          <option value="medium">Medium risk</option>
          <option value="high">High risk</option>
        </select>
        <button disabled={busy || !dd?.prospectus} onClick={() => void decide("approved")} className="text-xs rounded bg-success text-white px-3 py-1.5 font-medium hover:bg-success/90 disabled:opacity-40">Approve</button>
        <input className="rounded-lg border border-border bg-elevated/80 px-2.5 py-1 text-xs flex-1 focus:outline-none focus:border-primary focus:bg-surface focus:ring-4 focus:ring-primary/15" placeholder="Rejection reason" value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} />
        <button disabled={busy} onClick={() => void decide("rejected")} className="text-xs rounded border border-danger/40 text-danger px-3 py-1.5 font-medium hover:bg-danger/10 disabled:opacity-40">Reject</button>
      </div>
    </div>
  );
}
