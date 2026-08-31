import { useEffect, useState } from "react";
import { ApiError, api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { DisclosureChoice, PredicateOp, VerificationRequest } from "../../types.js";
import { Card, Pill } from "../shared/ui.js";

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function truncateDid(v: string): string { return v.length > 28 ? `${v.slice(0, 18)}…${v.slice(-6)}` : v; }
function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}
/** Distinguishes same-type credentials from different issuers when the holder is picking which to present. */
function candidateLabel(c: { type: string; issuerDid: string; issuerName?: string | null; issuedAt: string; expiresAt: string | null }): string {
  const issuer = c.issuerName ?? truncateDid(c.issuerDid);
  return `${c.type} — ${issuer} · issued ${fmtDate(c.issuedAt)}${c.expiresAt ? ` · expires ${fmtDate(c.expiresAt)}` : ""}`;
}

/**
 * Holder side: verification requests aimed at this DID. Nothing is disclosed
 * until the holder consents and picks which eligible credentials to present.
 */
export function VerificationInbox(): JSX.Element {
  const { token } = useAuth();
  const [requests, setRequests] = useState<VerificationRequest[]>([]);
  const [picked, setPicked] = useState<Record<string, Record<string, boolean>>>({});
  // Keyed by request id → credential id → field → choice. Populated with a
  // sensible default the first time a credential is checked (see toggleCredential).
  const [disclosures, setDisclosures] = useState<Record<string, Record<string, Record<string, DisclosureChoice>>>>({});
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
    const disclosuresForConsent: Record<string, Record<string, DisclosureChoice>> = {};
    for (const cid of ids) {
      const fields = disclosures[r.id]?.[cid] ?? {};
      if (Object.keys(fields).length > 0) disclosuresForConsent[cid] = fields;
    }
    try {
      await api.consentVerification(token, r.id, ids, Object.keys(disclosuresForConsent).length > 0 ? disclosuresForConsent : undefined);
      setMsg("Consented — the presentation was signed and released.");
      reload();
    } catch (e) { setErr(errMessage(e, "Consent failed")); }
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
                : (r.eligibleCredentials ?? []).map((c) => {
                    const requestedForType = r.requestedFields?.[c.type] ?? {};
                    const credDisclosures = disclosures[r.id]?.[c.id] ?? {};
                    const toggleCredential = (checked: boolean): void => {
                      setPicked({ ...picked, [r.id]: { ...sel, [c.id]: checked } });
                      if (checked && !disclosures[r.id]?.[c.id]) {
                        // Default: a requested field matches the request (value or
                        // predicate, as asked); everything else starts withheld —
                        // least-disclosure by default.
                        const initial: Record<string, DisclosureChoice> = {};
                        for (const field of Object.keys(c.claims)) {
                          const req = requestedForType[field];
                          initial[field] = req ? (req.kind === "predicate" ? { kind: "predicate", op: req.op, threshold: req.threshold } : { kind: "value" }) : { kind: "withhold" };
                        }
                        setDisclosures({ ...disclosures, [r.id]: { ...disclosures[r.id], [c.id]: initial } });
                      }
                    };
                    const setFieldChoice = (field: string, choice: DisclosureChoice): void => {
                      setDisclosures({ ...disclosures, [r.id]: { ...disclosures[r.id], [c.id]: { ...credDisclosures, [field]: choice } } });
                    };
                    return (
                      <div key={c.id} className="mb-1.5">
                        <label className="text-sm flex items-center gap-1.5">
                          <input type="checkbox" checked={!!sel[c.id]} onChange={(e) => toggleCredential(e.target.checked)} />
                          <span>{candidateLabel(c)}</span>
                        </label>
                        {sel[c.id] && (
                          <div className="ml-5 mt-1 space-y-1 border-l border-slate-100 pl-3">
                            {Object.entries(c.claims).map(([field, value]) => {
                              const choice = credDisclosures[field] ?? { kind: "withhold" as const };
                              const isNumber = typeof value === "number";
                              const requested = requestedForType[field];
                              return (
                                <div key={field} className="flex items-center gap-2 text-xs">
                                  <span className="w-40 truncate">
                                    {field}
                                    {requested && <span className="text-brand-500"> · requested{requested.kind === "predicate" ? ` (${requested.op} ${requested.threshold})` : ""}</span>}
                                  </span>
                                  <select
                                    className="rounded border border-slate-200 px-1 py-0.5"
                                    value={choice.kind}
                                    onChange={(e) => {
                                      const kind = e.target.value as DisclosureChoice["kind"];
                                      if (kind === "value") setFieldChoice(field, { kind: "value" });
                                      else if (kind === "withhold") setFieldChoice(field, { kind: "withhold" });
                                      else setFieldChoice(field, { kind: "predicate", op: requested?.kind === "predicate" ? requested.op : "lte", threshold: requested?.kind === "predicate" ? requested.threshold : 0 });
                                    }}
                                  >
                                    <option value="withhold">Withhold</option>
                                    <option value="value">Share value</option>
                                    {isNumber && <option value="predicate">Share as threshold check</option>}
                                  </select>
                                  {choice.kind === "predicate" && (
                                    <>
                                      <select
                                        className="rounded border border-slate-200 px-1 py-0.5"
                                        value={choice.op}
                                        onChange={(e) => setFieldChoice(field, { kind: "predicate", op: e.target.value as PredicateOp, threshold: choice.threshold })}
                                      >
                                        <option value="lte">≤</option>
                                        <option value="gte">≥</option>
                                        <option value="lt">&lt;</option>
                                        <option value="gt">&gt;</option>
                                        <option value="eq">=</option>
                                      </select>
                                      <input
                                        type="number" className="w-20 rounded border border-slate-200 px-1 py-0.5"
                                        value={choice.threshold}
                                        onChange={(e) => setFieldChoice(field, { kind: "predicate", op: choice.op, threshold: Number(e.target.value) })}
                                      />
                                    </>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
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
