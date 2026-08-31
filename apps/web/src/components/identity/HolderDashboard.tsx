import { useEffect, useMemo, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { HeldCredential, VerificationRequest } from "../../types.js";
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
 * Holder-scoped overview: how many relying parties have asked to see a
 * credential, how many credentials this DID actually holds, and how many
 * times consent was given to share one. Reuses GET /me/verification-requests
 * and GET /me/credentials — the same data the Verification Requests and My
 * Credentials pages already fetch — no new API surface needed.
 */
export function HolderDashboard({ onNavigate }: { onNavigate?: (view: string) => void }): JSX.Element {
  const { token } = useAuth();
  const [requests, setRequests] = useState<VerificationRequest[] | null>(null);
  const [creds, setCreds] = useState<HeldCredential[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setError(null);
    Promise.all([api.myVerificationRequests(token), api.myCredentials(token)])
      .then(([r, c]) => { setRequests(r); setCreds(c); })
      .catch(() => setError("Could not load your identity activity."));
  }, [token]);

  const counts = useMemo(() => {
    const rows = requests ?? [];
    const consented = rows.filter((r) => r.status === "consented").length;
    const pending = rows.filter((r) => r.status === "pending").length;
    return { received: rows.length, consented, pending };
  }, [requests]);

  if (error) return <div><SectionHeader title="Dashboard" description={error} /></div>;
  if (!requests || !creds) return <div><SectionHeader title="Dashboard" description="Loading…" /></div>;

  return (
    <div className="space-y-5">
      <SectionHeader title="Dashboard" description="Requests for your credentials, what you hold, and what you've shared." />

      <div className="grid grid-cols-3 gap-3">
        <Tile label="Requests received for credential share" value={counts.received} onClick={onNavigate ? () => onNavigate("requests") : undefined} />
        <Tile label="Credentials received" value={creds.length} tone="text-sky-600" onClick={onNavigate ? () => onNavigate("credentials") : undefined} />
        <Tile label="Consent shared" value={counts.consented} tone="text-emerald-600" onClick={onNavigate ? () => onNavigate("requests") : undefined} />
      </div>

      {counts.pending > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-800">
          {counts.pending} request{counts.pending === 1 ? "" : "s"} still {counts.pending === 1 ? "needs" : "need"} your consent — see Verification Requests.
        </div>
      )}
    </div>
  );
}
