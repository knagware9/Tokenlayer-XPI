import { useEffect, useMemo, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { VerificationRequest } from "../../types.js";
import { SectionHeader } from "../shared/ui.js";
import { VerificationRequests } from "./VerificationRequests.js";

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }): JSX.Element {
  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 animate-slide-up">
      <div className={`text-2xl font-bold tabular-nums font-display ${tone ?? "text-slate-900"}`}>{value.toLocaleString()}</div>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mt-1">{label}</div>
    </div>
  );
}

/**
 * Verifier-scoped overview: the summary tiles (how many presentation requests
 * this desk has sent, how many are still waiting, how many have a verdict)
 * plus the actionable list itself — VerificationRequests, embedded — so a
 * verifier can raise a new request, see the outbox, and run verification
 * without leaving this page. `status` never becomes "verified" — the request
 * record stays "consented" once verified, so "verified" here means
 * `verifiedAt` is set, and "pending" means it is not (whether or not the
 * holder has consented yet). Data reuses GET /verification-requests for the
 * tile counts; the embedded panel fetches its own copy for its own list +
 * actions, same as it always has as a standalone page.
 */
export function VerifierDashboard(): JSX.Element {
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
        <Tile label="Verification request sent" value={counts.sent} />
        <Tile label="Verification pending" value={counts.pending} tone="text-amber-600" />
        <Tile label="Verified" value={counts.verified} tone="text-emerald-600" />
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

      <VerificationRequests />
    </div>
  );
}
