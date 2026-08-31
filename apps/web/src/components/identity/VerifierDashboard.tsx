import { useEffect, useMemo, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { VerificationRequest } from "../../types.js";
import { SectionHeader } from "../shared/ui.js";

function Tile({ label, value, tone, onClick }: { label: string; value: number; tone?: string; onClick?: () => void }): JSX.Element {
  const shared = "bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 animate-slide-up";
  const body = (
    <>
      <div className={`text-2xl font-bold tabular-nums font-display ${tone ?? "text-slate-900"}`}>{value.toLocaleString()}</div>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mt-1">{label}</div>
    </>
  );
  if (!onClick) return <div className={shared}>{body}</div>;
  return (
    <button type="button" onClick={onClick} className={`${shared} text-left w-full hover:border-slate-300 hover:shadow transition-shadow cursor-pointer`}>
      {body}
    </button>
  );
}

/**
 * Verifier-scoped overview: how many presentation requests this desk has sent,
 * how many are still waiting on a holder or on this verifier to run the check,
 * and how many have a verdict. `status` never becomes "verified" — the request
 * record stays "consented" once verified, so "verified" here means `verifiedAt`
 * is set, and "pending" means it is not (whether or not the holder has consented
 * yet). Data reuses GET /verification-requests, the same outbox the Verification
 * page's "Your requests" panel already renders — no new API surface needed.
 */
export function VerifierDashboard({ onNavigate }: { onNavigate?: (view: string) => void }): JSX.Element {
  const { token } = useAuth();
  const [requests, setRequests] = useState<VerificationRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setError(null);
    api.verificationRequests(token).then(setRequests).catch(() => setError("Could not load verification requests."));
  }, [token]);

  const counts = useMemo(() => {
    const rows = requests ?? [];
    const verified = rows.filter((r) => r.verifiedAt).length;
    const rejected = rows.filter((r) => !r.verifiedAt && r.status === "rejected").length;
    const expired = rows.filter((r) => !r.verifiedAt && r.status === "expired").length;
    const pending = rows.length - verified - rejected - expired;
    return { sent: rows.length, verified, pending, rejected, expired };
  }, [requests]);

  if (error) return <div><SectionHeader title="Dashboard" description={error} /></div>;
  if (!requests) return <div><SectionHeader title="Dashboard" description="Loading…" /></div>;

  return (
    <div className="space-y-5">
      <SectionHeader title="Dashboard" description="Presentation requests this desk has sent, and where each one stands." />

      <div className="grid grid-cols-3 gap-3">
        <Tile label="Verification request sent" value={counts.sent} onClick={onNavigate ? () => onNavigate("verify") : undefined} />
        <Tile label="Verification pending" value={counts.pending} tone="text-amber-600" onClick={onNavigate ? () => onNavigate("verify") : undefined} />
        <Tile label="Verified" value={counts.verified} tone="text-emerald-600" onClick={onNavigate ? () => onNavigate("verify") : undefined} />
      </div>

      {(counts.rejected > 0 || counts.expired > 0) && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
          <h2 className="font-bold text-slate-900 text-sm mb-3 font-display">Not verified</h2>
          <div className="grid grid-cols-2 gap-3 text-center max-w-xs">
            <div className="flex flex-col gap-0.5">
              <div className="text-xl font-bold tabular-nums font-display text-slate-600">{counts.rejected}</div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Rejected by holder</div>
            </div>
            <div className="flex flex-col gap-0.5">
              <div className="text-xl font-bold tabular-nums font-display text-slate-400">{counts.expired}</div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Expired</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
