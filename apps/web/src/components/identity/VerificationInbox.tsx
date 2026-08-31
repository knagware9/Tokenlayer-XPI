import { useEffect, useState } from "react";
import { ApiError, api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { DisclosureChoice, FieldRequest, PredicateOp, VerificationRequest } from "../../types.js";
import { Card, Pill } from "../shared/ui.js";

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Fields a holder may choose to disclose for a credential — every claim
 * except the subject `id`. `id` is present on every credential's claims but
 * is never a real `claimSchema` property, so a verifier can never actually
 * request it (it would be refused as UNKNOWN_FIELD) — showing it in the
 * holder's disclosure list would be confusing and inconsistent with that.
 * `claims` can be absent (an older API deployment, or a caller who lacks
 * `credentials:read` — see GET /me/verification-requests), so this always
 * guards with `?? {}` rather than assuming the field exists.
 */
export function disclosableFields(claims: Record<string, unknown> | undefined | null): string[] {
  return Object.keys(claims ?? {}).filter((f) => f !== "id");
}

/**
 * The starting per-field disclosure choices when a holder checks a credential
 * to present.
 *
 * BACKWARD COMPATIBILITY: every pre-existing verifier flow never sends
 * `requestedFields` at all (it is a brand-new optional feature), so a field
 * with no entry in `requestedForType` — which is every field, for such a
 * request — must default to full VALUE disclosure. Defaulting to withhold
 * instead would silently turn "consent" into `claims: {}` while `/verify`
 * still reports `valid: true`, breaking every existing integration or UI flow
 * the design spec promises keeps working byte-for-byte.
 *
 * A field the verifier's request DID name is still only a SUGGESTION: it
 * pre-fills the holder's starting choice (value, or a predicate with the
 * verifier's own op/threshold as a convenience starting point) — the holder
 * can still change or override it before consenting.
 */
export function defaultDisclosuresFor(
  claims: Record<string, unknown> | undefined | null,
  requestedForType: Record<string, FieldRequest> | undefined,
): Record<string, DisclosureChoice> {
  const initial: Record<string, DisclosureChoice> = {};
  for (const field of disclosableFields(claims)) {
    const req = requestedForType?.[field];
    initial[field] = req?.kind === "predicate"
      ? { kind: "predicate", op: req.op, threshold: req.threshold }
      : { kind: "value" };
  }
  return initial;
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
                    const claims = c.claims ?? {};
                    const requestedForType = r.requestedFields?.[c.type] ?? {};
                    const credDisclosures = disclosures[r.id]?.[c.id] ?? {};
                    const toggleCredential = (checked: boolean): void => {
                      setPicked({ ...picked, [r.id]: { ...sel, [c.id]: checked } });
                      if (checked && !disclosures[r.id]?.[c.id]) {
                        const initial = defaultDisclosuresFor(claims, requestedForType);
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
                            <div className="text-[11px] text-slate-400">
                              This only controls what the verifier receives — the credential itself is unchanged.
                            </div>
                            {disclosableFields(claims).map((field) => {
                              const value = claims[field];
                              // Full value disclosure by default (see defaultDisclosuresFor) —
                              // this fallback only matters before toggleCredential has run.
                              const choice = credDisclosures[field] ?? { kind: "value" as const };
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
                                        onChange={(e) => {
                                          const n = Number(e.target.value);
                                          setFieldChoice(field, { kind: "predicate", op: choice.op, threshold: Number.isFinite(n) ? n : 0 });
                                        }}
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
