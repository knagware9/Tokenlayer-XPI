import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { DisclosureChoice, HeldCredential, PredicateOp, VerificationRequest } from "../../types.js";
import { Pager, SectionHeader } from "../shared/ui.js";
import { disclosableFields, defaultDisclosuresFor } from "./VerificationInbox.js";

const PAGE_SIZE = 5;

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function Tile({ label, value, tone, active, onClick }: { label: string; value: number; tone?: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left w-full bg-white rounded-2xl border p-4 animate-slide-up shadow-sm transition-shadow hover:shadow ${active ? "border-brand-400 ring-1 ring-brand-300" : "border-slate-200/80 hover:border-slate-300"}`}
    >
      <div className={`text-2xl font-bold tabular-nums font-display ${tone ?? "text-slate-900"}`}>{value.toLocaleString()}</div>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mt-1">{label}</div>
    </button>
  );
}

function BackButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="text-sm text-slate-500 hover:text-slate-800 inline-flex items-center gap-1.5">
      ← Back to Dashboard
    </button>
  );
}

type Filter = "requests" | "credentials" | "consented";
type Detail = { kind: "request"; id: string } | { kind: "credential"; id: string } | null;

/**
 * Holder-scoped overview. The three tiles are toggles: clicking one reveals a
 * table filtered to that category below (clicking again hides it). Each row's
 * View button opens a SEPARATE detail page — not an inline expansion — that
 * replaces the tiles+table entirely until "Back to Dashboard" is clicked, same
 * shape as the rest of this app's nav-driven view switching. For a pending
 * request, that page carries the same per-field disclosure choices +
 * Consent/Reject actions VerificationInbox has always offered (reusing its
 * exported `disclosableFields`/`defaultDisclosuresFor` helpers rather than
 * re-deriving that logic); for a held credential, its claim values. Reuses
 * GET /me/verification-requests and GET /me/credentials for both the tile
 * counts and the tables — no new API surface needed.
 */
export function HolderDashboard(): JSX.Element {
  const { token } = useAuth();
  const [requests, setRequests] = useState<VerificationRequest[] | null>(null);
  const [creds, setCreds] = useState<HeldCredential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<Detail>(null);
  const [picked, setPicked] = useState<Record<string, Record<string, boolean>>>({});
  const [disclosures, setDisclosures] = useState<Record<string, Record<string, Record<string, DisclosureChoice>>>>({});
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const reload = (): void => {
    if (!token) return;
    setError(null);
    Promise.all([api.myVerificationRequests(token), api.myCredentials(token)])
      .then(([r, c]) => { setRequests(r); setCreds(c); })
      .catch(() => setError("Could not load your identity activity."));
  };
  useEffect(reload, [token]);

  const counts = useMemo(() => {
    const rows = requests ?? [];
    const consented = rows.filter((r) => r.status === "consented").length;
    return { received: rows.length, consented };
  }, [requests]);

  function toggleFilter(f: Filter): void {
    setFilter((cur) => (cur === f ? null : f));
    setQuery("");
    setPage(1);
  }

  async function consent(r: VerificationRequest): Promise<void> {
    if (!token) return;
    const sel = picked[r.id] ?? {};
    const ids = Object.keys(sel).filter((k) => sel[k]);
    if (ids.length === 0) return;
    setActionErr(null); setActionMsg(null);
    const disclosuresForConsent: Record<string, Record<string, DisclosureChoice>> = {};
    for (const cid of ids) {
      const fields = disclosures[r.id]?.[cid] ?? {};
      if (Object.keys(fields).length > 0) disclosuresForConsent[cid] = fields;
    }
    try {
      await api.consentVerification(token, r.id, ids, Object.keys(disclosuresForConsent).length > 0 ? disclosuresForConsent : undefined);
      setActionMsg("Consented — the presentation was signed and released.");
      setDetail(null);
      reload();
    } catch (e) { setActionErr(errMessage(e, "Consent failed")); }
  }
  async function reject(r: VerificationRequest): Promise<void> {
    if (!token) return;
    setActionErr(null); setActionMsg(null);
    try { await api.rejectVerification(token, r.id); setDetail(null); reload(); } catch (e) { setActionErr(errMessage(e, "Reject failed")); }
  }

  if (error) return <div><SectionHeader title="Dashboard" description={error} /></div>;
  if (!requests || !creds) return <div><SectionHeader title="Dashboard" description="Loading…" /></div>;

  function onQueryChange(v: string): void { setQuery(v); setPage(1); }

  const q = query.trim().toLowerCase();
  const categoryRequests = filter === "consented" ? requests.filter((r) => r.status === "consented") : requests;
  const filteredRequests = q
    ? categoryRequests.filter((r) => r.purpose.toLowerCase().includes(q) || r.requestedTypes.some((t) => t.toLowerCase().includes(q)))
    : categoryRequests;
  const pagedRequests = filteredRequests.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const filteredCreds = q
    ? creds.filter((c) => c.type.some((t) => t.toLowerCase().includes(q)) || (c.issuerName ?? c.issuerDid).toLowerCase().includes(q))
    : creds;
  const pagedCreds = filteredCreds.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // ── Request detail page ─────────────────────────────────────────────────
  if (detail?.kind === "request") {
    const r = requests.find((x) => x.id === detail.id);
    if (!r) { setDetail(null); return <></>; }
    const sel = picked[r.id] ?? {};
    return (
      <div className="space-y-5">
        <BackButton onClick={() => setDetail(null)} />
        <SectionHeader title={r.purpose} description={`${r.requestedTypes.join(", ")} · ${r.status}`} />
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
          {actionErr && <div className="text-sm text-rose-600 mb-3">{actionErr}</div>}
          {actionMsg && <div className="text-sm text-emerald-600 mb-3">{actionMsg}</div>}
          {r.status !== "pending" ? (
            <div className="text-sm text-slate-500">
              {r.status}{r.verifiedAt ? ` · verified ${new Date(r.verifiedAt).toLocaleString()}` : ""}
            </div>
          ) : (r.eligibleCredentials ?? []).length === 0 ? (
            <div className="text-sm text-amber-600">You hold no unrevoked credential of the requested type(s).</div>
          ) : (
            <div className="space-y-4">
              {(r.eligibleCredentials ?? []).map((c) => {
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
                  <div key={c.id} className="text-sm">
                    <label className="flex items-center gap-2 font-medium">
                      <input type="checkbox" checked={!!sel[c.id]} onChange={(e) => toggleCredential(e.target.checked)} />
                      <span>{c.type} — {c.issuerName ?? c.issuerDid}</span>
                    </label>
                    {sel[c.id] && (
                      <div className="ml-6 mt-2 space-y-1.5 border-l border-slate-200 pl-4">
                        <div className="text-xs text-slate-400">
                          This only controls what the verifier receives — the credential itself is unchanged.
                        </div>
                        {disclosableFields(claims).map((field) => {
                          const value = claims[field];
                          const choice = credDisclosures[field] ?? { kind: "value" as const };
                          const isNumber = typeof value === "number";
                          const requested = requestedForType[field];
                          return (
                            <div key={field} className="flex items-center gap-2 text-xs">
                              <span className="w-32 truncate">
                                {field}
                                {requested && <span className="text-brand-500"> · requested</span>}
                              </span>
                              <select
                                className="rounded border border-slate-200 px-1.5 py-1"
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
                                    className="rounded border border-slate-200 px-1.5 py-1"
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
                                    type="number" className="w-20 rounded border border-slate-200 px-1.5 py-1"
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
              <div className="flex gap-2 pt-1">
                <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm text-white disabled:opacity-40" disabled={!Object.values(sel).some(Boolean)} onClick={() => void consent(r)}>Consent &amp; present</button>
                <button className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-rose-600" onClick={() => void reject(r)}>Reject</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Credential detail page ──────────────────────────────────────────────
  if (detail?.kind === "credential") {
    const c = creds.find((x) => x.id === detail.id);
    if (!c) { setDetail(null); return <></>; }
    return (
      <div className="space-y-5">
        <BackButton onClick={() => setDetail(null)} />
        <SectionHeader title={c.type.filter((t) => t !== "VerifiableCredential").join(", ") || c.type.join(", ")} description={`${c.issuerName ?? c.issuerDid} · ${c.revoked ? "Revoked" : "Active"}`} />
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
          <div className="grid grid-cols-2 gap-3 text-sm">
            {Object.entries(c.claims ?? {}).filter(([k]) => k !== "id").map(([k, v]) => (
              <div key={k} className="min-w-0"><span className="text-slate-400">{k}:</span> <span className="break-all">{String(v)}</span></div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-slate-100 text-xs text-slate-400 space-y-1">
            <div>Issued {new Date(c.issuedAt).toLocaleDateString()}{c.expiresAt ? ` · expires ${new Date(c.expiresAt).toLocaleDateString()}` : ""}</div>
            <div>Holder DID: <span className="font-data">{c.holderDid}</span></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SectionHeader title="Dashboard" description="Requests for your credentials, what you hold, and what you've shared." />

      <div className="grid grid-cols-3 gap-3">
        <Tile label="Requests received for credential share" value={counts.received} active={filter === "requests"} onClick={() => toggleFilter("requests")} />
        <Tile label="Credentials received" value={creds.length} tone="text-sky-600" active={filter === "credentials"} onClick={() => toggleFilter("credentials")} />
        <Tile label="Consent shared" value={counts.consented} tone="text-emerald-600" active={filter === "consented"} onClick={() => toggleFilter("consented")} />
      </div>

      {filter === "credentials" && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="px-4 pt-3 pb-1">
            <input value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder="Search type or issuer…"
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs w-64 max-w-full" />
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Type</th>
                <th className="text-left px-4 py-2 font-semibold">Issuer</th>
                <th className="text-left px-4 py-2 font-semibold">Issued</th>
                <th className="text-left px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filteredCreds.length === 0 && <tr><td colSpan={5} className="px-4 py-4 text-slate-400">{creds.length === 0 ? "No credentials held yet." : "No matches."}</td></tr>}
              {pagedCreds.map((c) => (
                <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50/70 transition-colors">
                  <td className="px-4 py-2">{c.type.filter((t) => t !== "VerifiableCredential").join(", ") || c.type.join(", ")}</td>
                  <td className="px-4 py-2">{c.issuerName ?? c.issuerDid}</td>
                  <td className="px-4 py-2">{new Date(c.issuedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-2">{c.revoked ? "Revoked" : "Active"}</td>
                  <td className="px-4 py-2 text-right">
                    <button className="rounded-lg border border-slate-200 px-3 py-1 text-xs" onClick={() => setDetail({ kind: "credential", id: c.id })}>View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <Pager page={page} pageSize={PAGE_SIZE} total={filteredCreds.length} onPage={setPage} />
        </div>
      )}

      {(filter === "requests" || filter === "consented") && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          {actionMsg && <div className="text-sm text-emerald-600 px-4 pt-3">{actionMsg}</div>}
          <div className="px-4 pt-3 pb-1">
            <input value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder="Search purpose or type…"
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs w-64 max-w-full" />
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Request</th>
                <th className="text-left px-4 py-2 font-semibold">Type</th>
                <th className="text-left px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filteredRequests.length === 0 && <tr><td colSpan={4} className="px-4 py-4 text-slate-400">{requests.length === 0 ? "Nothing here." : "No matches."}</td></tr>}
              {pagedRequests.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50/70 transition-colors">
                  <td className="px-4 py-2">{r.purpose}</td>
                  <td className="px-4 py-2">{r.requestedTypes.join(", ")}</td>
                  <td className="px-4 py-2 capitalize">{r.status}</td>
                  <td className="px-4 py-2 text-right">
                    <button className="rounded-lg border border-slate-200 px-3 py-1 text-xs" onClick={() => setDetail({ kind: "request", id: r.id })}>View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <Pager page={page} pageSize={PAGE_SIZE} total={filteredRequests.length} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
