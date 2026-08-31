import { Fragment, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { VerificationRequest, VerificationResult } from "../../types.js";
import { SectionHeader } from "../shared/ui.js";

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** The verifier's step-by-step detail rows, in check order (ID-O). Mirrors VerificationRequests.tsx. */
const CHECK_ROWS = [
  { key: "signature", label: "Signature valid" },
  { key: "trusted", label: "Issuer trusted" },
  { key: "notExpired", label: "Not expired" },
  { key: "subjectBound", label: "Subject bound to holder" },
  { key: "notRevoked", label: "Not revoked" },
] as const;

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

function claimsLine(claims: Record<string, unknown>): string {
  return Object.entries(claims).map(([k, v]) => {
    const isPredicate = v && typeof v === "object" && "predicate" in v;
    if (isPredicate) {
      const p = (v as { predicate: { op: string; threshold: number; result: boolean } }).predicate;
      const opSymbol = { gte: "≥", lte: "≤", gt: ">", lt: "<", eq: "=" }[p.op] ?? p.op;
      return `${k}: ${opSymbol} ${p.threshold} ${p.result ? "✓" : "✗"}`;
    }
    return `${k}: ${String(v)}`;
  }).join(" · ");
}

type Filter = "sent" | "pending" | "verified";

/**
 * Verifier-scoped overview. The three tiles are toggles: clicking one reveals
 * a table filtered to that category below (clicking again hides it). Each row
 * has a View button that expands it inline to show the request's detail and,
 * once run, the verification result — the same per-credential check rows and
 * claims rendering VerificationRequests.tsx has always shown — and a Run
 * verification button for a consented-but-not-yet-verified row. `status`
 * never becomes "verified" — the request record stays "consented" once
 * verified, so "verified" here means `verifiedAt` is set, and "pending" means
 * it is not (whether or not the holder has consented yet). Reuses GET
 * /verification-requests for both the tile counts and the table.
 */
export function VerifierDashboard(): JSX.Element {
  const { token } = useAuth();
  const [requests, setRequests] = useState<VerificationRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, VerificationResult>>({});
  const [actionErr, setActionErr] = useState<string | null>(null);

  const reload = (): void => {
    if (!token) return;
    setError(null);
    api.verificationRequests(token).then(setRequests).catch(() => setError("Could not load verification requests."));
  };
  useEffect(reload, [token]);

  const counts = useMemo(() => {
    const rows = requests ?? [];
    const verified = rows.filter((r) => r.verifiedAt).length;
    const rejected = rows.filter((r) => !r.verifiedAt && r.status === "rejected").length;
    const expired = rows.filter((r) => !r.verifiedAt && r.status === "expired").length;
    const pending = rows.length - verified - rejected - expired;
    return { sent: rows.length, verified, pending, rejected, expired };
  }, [requests]);

  function toggleFilter(f: Filter): void {
    setFilter((cur) => (cur === f ? null : f));
    setExpanded(null);
  }

  async function runVerify(id: string): Promise<void> {
    if (!token) return;
    setActionErr(null);
    try {
      const result = await api.verifyVerification(token, id);
      setResults((r) => ({ ...r, [id]: result }));
      setExpanded(id);
      reload();
    } catch (e) { setActionErr(errMessage(e, "Verification failed")); }
  }

  if (error) return <div><SectionHeader title="Dashboard" description={error} /></div>;
  if (!requests) return <div><SectionHeader title="Dashboard" description="Loading…" /></div>;

  const filteredRequests =
    filter === "pending" ? requests.filter((r) => !r.verifiedAt)
      : filter === "verified" ? requests.filter((r) => r.verifiedAt)
        : requests;

  return (
    <div className="space-y-5">
      <SectionHeader title="Dashboard" description="Presentation requests this desk has sent, and where each one stands." />

      <div className="grid grid-cols-3 gap-3">
        <Tile label="Verification request sent" value={counts.sent} active={filter === "sent"} onClick={() => toggleFilter("sent")} />
        <Tile label="Verification pending" value={counts.pending} tone="text-amber-600" active={filter === "pending"} onClick={() => toggleFilter("pending")} />
        <Tile label="Verified" value={counts.verified} tone="text-emerald-600" active={filter === "verified"} onClick={() => toggleFilter("verified")} />
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

      {filter && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          {actionErr && <div className="text-sm text-rose-600 px-4 pt-3">{actionErr}</div>}
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Request</th>
                <th className="text-left px-4 py-2 font-semibold">Type</th>
                <th className="text-left px-4 py-2 font-semibold">Holder</th>
                <th className="text-left px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filteredRequests.length === 0 && <tr><td colSpan={5} className="px-4 py-4 text-slate-400">Nothing here.</td></tr>}
              {filteredRequests.map((r) => {
                const result = results[r.id];
                return (
                  <Fragment key={r.id}>
                    <tr className="border-t border-slate-100">
                      <td className="px-4 py-2">{r.purpose}</td>
                      <td className="px-4 py-2">{r.requestedTypes.join(", ")}</td>
                      <td className="px-4 py-2">{r.holderDid.slice(0, 20)}…</td>
                      <td className="px-4 py-2 capitalize">{r.verifiedAt ? "verified" : r.status}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {r.status === "consented" && (
                          <button className="rounded-lg border border-slate-200 px-3 py-1 text-xs mr-2" onClick={() => void runVerify(r.id)}>Run verification</button>
                        )}
                        <button className="rounded-lg border border-slate-200 px-3 py-1 text-xs" onClick={() => setExpanded((x) => (x === r.id ? null : r.id))}>{expanded === r.id ? "Hide" : "View"}</button>
                      </td>
                    </tr>
                    {expanded === r.id && (
                      <tr className="border-t border-slate-100 bg-slate-50/60">
                        <td colSpan={5} className="px-4 py-3 text-xs">
                          <div className="text-slate-500 mb-2">
                            created {new Date(r.createdAt).toLocaleString()}
                            {r.verifiedAt && ` · verified ${new Date(r.verifiedAt).toLocaleString()}`}
                          </div>
                          {!result ? (
                            <div className="text-slate-400">
                              {r.status !== "consented"
                                ? `Nothing to verify — request is ${r.status}.`
                                : r.verifiedAt
                                  ? "Already verified — click Run verification to see the result again."
                                  : "Not verified yet — click Run verification."}
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <div>
                                <span className={`font-medium ${result.valid ? "text-emerald-700" : "text-rose-700"}`}>{result.valid ? "Presentation is valid." : "Presentation did not fully verify."}</span>
                              </div>
                              {result.credentials.map((c, i) => {
                                const checks = c.checks;
                                const firstFail = checks && CHECK_ROWS.find(({ key }) => checks[key] === false)?.key;
                                return (
                                  <div key={i} className="border border-slate-200 rounded-lg p-2">
                                    <div className="font-medium">{c.type ?? "unknown credential"} {c.reason && !firstFail && <span className="text-rose-600">· {c.reason}</span>}</div>
                                    {checks && (
                                      <div className="mt-1 space-y-0.5">
                                        {CHECK_ROWS.map(({ key, label }) => {
                                          const v = checks[key];
                                          return (
                                            <div key={key} className="flex items-center gap-1.5">
                                              <span className={v === true ? "text-emerald-600" : v === "unknown" ? "text-slate-400" : "text-rose-600"}>{v === true ? "✓" : v === "unknown" ? "?" : "✗"}</span>
                                              <span className={v === false ? "text-rose-700" : "text-slate-700"}>{label}</span>
                                              {key === firstFail && c.reason && <span className="text-rose-500">— {c.reason}</span>}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                    {c.claims && <div className="text-slate-500 mt-1">{claimsLine(c.claims)}</div>}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
