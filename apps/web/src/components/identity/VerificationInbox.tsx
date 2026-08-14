import { useEffect, useState } from "react";
import { ApiError, api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { VerificationRequest } from "../../types.js";
import { Card, Pill } from "../shared/ui.js";

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Holder side: verification requests aimed at this DID. Nothing is disclosed
 * until the holder consents and picks which eligible credentials to present.
 */
export function VerificationInbox(): JSX.Element {
  const { token } = useAuth();
  const [requests, setRequests] = useState<VerificationRequest[]>([]);
  const [picked, setPicked] = useState<Record<string, Record<string, boolean>>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = (): void => { if (token) void api.myVerificationRequests(token).then(setRequests).catch((e) => setErr(errMessage(e, "Failed to load requests"))); };
  useEffect(reload, [token]);

  async function consent(r: VerificationRequest): Promise<void> {
    if (!token) return;
    const sel = picked[r.id] ?? {};
    const ids = Object.keys(sel).filter((k) => sel[k]);
    if (ids.length === 0) return;
    setErr(null); setMsg(null);
    try { await api.consentVerification(token, r.id, ids); setMsg("Consented — the presentation was signed and released."); reload(); }
    catch (e) { setErr(errMessage(e, "Consent failed")); }
  }
  async function reject(r: VerificationRequest): Promise<void> {
    if (!token) return;
    setErr(null); setMsg(null);
    try { await api.rejectVerification(token, r.id); reload(); } catch (e) { setErr(errMessage(e, "Reject failed")); }
  }

  const pending = requests.filter((r) => r.status === "pending");
  const past = requests.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-5">
      <Card title="Verification requests" description="Relying parties asking you to present credentials. Nothing is shared until you consent.">
        {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
        {msg && <div className="text-sm text-emerald-600 mb-2">{msg}</div>}
        {pending.length === 0 && <div className="text-sm text-slate-500">No pending requests.</div>}
        <div className="space-y-3">
          {pending.map((r) => {
            const sel = picked[r.id] ?? {};
            return (
            <div key={r.id} className="border border-slate-100 rounded-lg p-3">
              <div className="text-sm font-medium">{r.purpose}</div>
              <div className="text-xs text-slate-500 mb-2">from {r.verifierOrgId} · asks for {r.requestedTypes.join(", ")}</div>
              {(r.eligibleCredentials ?? []).length === 0
                ? <div className="text-xs text-amber-600">You hold no unrevoked credential of the requested type(s).</div>
                : (r.eligibleCredentials ?? []).map((c) => (
                    <label key={c.id} className="text-sm flex items-center gap-1">
                      <input type="checkbox" checked={!!sel[c.id]} onChange={(e) => setPicked({ ...picked, [r.id]: { ...sel, [c.id]: e.target.checked } })} /> {c.type}
                    </label>
                  ))}
              <div className="flex gap-2 mt-2">
                <button className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white disabled:opacity-40" disabled={!Object.values(sel).some(Boolean)} onClick={() => void consent(r)}>Consent &amp; present</button>
                <button className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-rose-600" onClick={() => void reject(r)}>Reject</button>
              </div>
            </div>
            );
          })}
        </div>
      </Card>
      {past.length > 0 && (
        <Card title="Past requests">
          <div className="space-y-1">
            {past.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-sm border-t border-slate-100 py-1">
                <span>{r.purpose} · {r.requestedTypes.join(", ")}</span>
                <Pill tone={r.status === "consented" ? "ok" : r.status === "rejected" ? "muted" : "warn"}>{r.status}</Pill>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
