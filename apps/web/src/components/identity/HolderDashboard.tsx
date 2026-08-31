import { useEffect, useMemo, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { HeldCredential, VerificationRequest } from "../../types.js";
import { SectionHeader } from "../shared/ui.js";
import { VerificationInbox } from "./VerificationInbox.js";

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }): JSX.Element {
  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 animate-slide-up">
      <div className={`text-2xl font-bold tabular-nums font-display ${tone ?? "text-slate-900"}`}>{value.toLocaleString()}</div>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mt-1">{label}</div>
    </div>
  );
}

/**
 * Holder-scoped overview: the summary tiles (how many relying parties have
 * asked to see a credential, how many credentials this DID actually holds,
 * how many times consent was given) plus the actionable request list itself
 * — VerificationInbox, embedded — so a holder can review, choose disclosures,
 * consent, or reject without leaving this page. Reuses GET
 * /me/verification-requests and GET /me/credentials for the tile counts; the
 * embedded inbox fetches its own copy for its own list + actions, same as it
 * always has as a standalone page.
 */
export function HolderDashboard(): JSX.Element {
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
    return { received: rows.length, consented };
  }, [requests]);

  if (error) return <div><SectionHeader title="Dashboard" description={error} /></div>;
  if (!requests || !creds) return <div><SectionHeader title="Dashboard" description="Loading…" /></div>;

  return (
    <div className="space-y-5">
      <SectionHeader title="Dashboard" description="Requests for your credentials, what you hold, and what you've shared." />

      <div className="grid grid-cols-3 gap-3">
        <Tile label="Requests received for credential share" value={counts.received} />
        <Tile label="Credentials received" value={creds.length} tone="text-sky-600" />
        <Tile label="Consent shared" value={counts.consented} tone="text-emerald-600" />
      </div>

      <VerificationInbox />
    </div>
  );
}
