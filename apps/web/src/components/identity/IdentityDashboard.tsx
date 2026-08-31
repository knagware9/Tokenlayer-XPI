import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { DerivedCredentialStatus, IdentityDashboardData, Proposal } from "../../types.js";
import { Pager, SectionHeader } from "../shared/ui.js";

const PAGE_SIZE = 5;

/** The maker-checker proposal kinds an issuer submits to mint a credential.
 *  Distinct from the lifecycle totals above: those track what happens to a
 *  credential AFTER it exists, this tracks whether the ISSUANCE ACTION itself
 *  went through. issue-kyc is deliberately excluded — it is ungated (see
 *  POST /users/:id/identity/issue-kyc) and always succeeds, so it has no
 *  "failed" case to report. */
const ISSUANCE_PROPOSAL_KINDS = new Set(["issue-credential", "issue-usecase-credential", "issue-usecase-credential-batch"]);

// ID-N: scoped identity operations dashboard — stat tiles over the ID-L
// lifecycle, a 30-day issued strip, verification counters, and the filterable
// credential status board. Read-only; all aggregation is server-side.

const STATUS_META: Record<DerivedCredentialStatus, { label: string; pill: string }> = {
  accepted: { label: "Accepted", pill: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  pending: { label: "Pending acceptance", pill: "bg-amber-50 text-amber-700 border-amber-200" },
  changes_requested: { label: "Changes requested", pill: "bg-rose-50 text-rose-700 border-rose-200" },
  rejected: { label: "Rejected by holder", pill: "bg-slate-100 text-slate-600 border-slate-200" },
  revoked: { label: "Revoked", pill: "bg-red-50 text-red-700 border-red-200" },
  expired: { label: "Expired", pill: "bg-slate-100 text-slate-500 border-slate-200" },
};
const STATUS_ORDER: DerivedCredentialStatus[] = ["pending", "accepted", "changes_requested", "rejected", "revoked", "expired"];

function StatusPill({ status }: { status: DerivedCredentialStatus }): JSX.Element {
  const m = STATUS_META[status];
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${m.pill}`}>{m.label}</span>;
}

function Tile({ label, value, tone, stagger, active, onClick }: { label: string; value: number; tone?: string; stagger?: number; active?: boolean; onClick?: () => void }): JSX.Element {
  const shared = `text-left w-full bg-white rounded-2xl border p-4 animate-slide-up shadow-sm transition-shadow ${stagger ? `stagger-${stagger}` : ""} ${active ? "border-brand-400 ring-1 ring-brand-300" : "border-slate-200/80"}`;
  const body = (
    <>
      <div className={`text-2xl font-bold tabular-nums font-display ${tone ?? "text-slate-900"}`}>{value.toLocaleString()}</div>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mt-1">{label}</div>
    </>
  );
  if (!onClick) return <div className={shared}>{body}</div>;
  return <button type="button" onClick={onClick} className={`${shared} hover:shadow hover:border-slate-300 cursor-pointer`}>{body}</button>;
}

function ActivityStrip({ days }: { days: { date: string; issued: number }[] }): JSX.Element {
  const max = Math.max(1, ...days.map((d) => d.issued));
  return (
    <div className="flex items-end gap-[3px] h-20" title="Credentials issued per day" aria-label="Activity chart">
      {days.map((d, i) => {
        const pct = Math.max(d.issued > 0 ? 10 : 3, (d.issued / max) * 100);
        return (
          <div
            key={d.date}
            className="flex-1 rounded-t min-w-[3px] animate-bar-grow"
            style={{
              height: `${pct}%`,
              background: d.issued > 0
                ? `linear-gradient(to top, rgb(var(--brand-600)), rgb(var(--brand-400)))`
                : "rgb(226 232 230)",
              animationDelay: `${i * 0.012}s`,
              transformOrigin: "bottom",
            }}
            title={`${d.date}: ${d.issued}`}
          />
        );
      })}
    </div>
  );
}

export function IdentityDashboard(): JSX.Element {
  const { token } = useAuth();
  const [data, setData] = useState<IdentityDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DerivedCredentialStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [boardExpanded, setBoardExpanded] = useState<string | null>(null);
  const [boardPage, setBoardPage] = useState(1);
  const [proposalFilter, setProposalFilter] = useState<"all" | "executed" | "failed" | null>(null);
  const [proposalExpanded, setProposalExpanded] = useState<string | null>(null);
  const [proposalPage, setProposalPage] = useState(1);

  useEffect(() => {
    if (!token) return;
    setData(null);
    setError(null);
    api.identityDashboard(token).then(setData).catch(() => setError("Could not load the identity dashboard."));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    api.proposals(token).then(setProposals).catch(() => setProposals([]));
  }, [token]);

  const issuance = useMemo(() => {
    const rows = (proposals ?? []).filter((p) => ISSUANCE_PROPOSAL_KINDS.has(p.kind));
    return {
      issued: rows.length,
      success: rows.filter((p) => p.status === "executed").length,
      failed: rows.filter((p) => p.status === "rejected" || p.status === "failed").length,
    };
  }, [proposals]);

  const types = useMemo(() => (data ? [...new Set(data.board.map((r) => r.type))].sort() : []), [data]);
  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.board.filter((r) =>
      (statusFilter === "all" || r.status === statusFilter) &&
      (typeFilter === "all" || r.type === typeFilter) &&
      (!q || r.holderLabel.toLowerCase().includes(q)));
  }, [data, statusFilter, typeFilter, search]);
  const pagedRows = rows.slice((boardPage - 1) * PAGE_SIZE, boardPage * PAGE_SIZE);

  const issuanceRows = useMemo(() => {
    const all = (proposals ?? []).filter((p) => ISSUANCE_PROPOSAL_KINDS.has(p.kind));
    if (proposalFilter === "executed") return all.filter((p) => p.status === "executed");
    if (proposalFilter === "failed") return all.filter((p) => p.status === "rejected" || p.status === "failed");
    return all;
  }, [proposals, proposalFilter]);
  const pagedIssuanceRows = issuanceRows.slice((proposalPage - 1) * PAGE_SIZE, proposalPage * PAGE_SIZE);

  function toggleStatusFilter(s: DerivedCredentialStatus | "all"): void {
    setStatusFilter((cur) => (cur === s ? "all" : s));
    setBoardPage(1);
  }
  function toggleProposalFilter(f: "all" | "executed" | "failed"): void {
    setProposalFilter((cur) => (cur === f ? null : f));
    setProposalExpanded(null);
    setProposalPage(1);
  }

  if (error) return <div><SectionHeader title="Identity Dashboard" description={error} /></div>;
  if (!data) return <div><SectionHeader title="Identity Dashboard" description="Loading…" /></div>;

  const t = data.totals;
  return (
    <div className="space-y-5">
      <SectionHeader title="Identity Dashboard" description="Credential lifecycle and verification activity across your identity use cases." />

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <Tile label="Issued" value={t.issued} stagger={1} active={statusFilter === "all"} onClick={() => toggleStatusFilter("all")} />
        <Tile label="Accepted" value={t.accepted} tone="text-emerald-600" stagger={2} active={statusFilter === "accepted"} onClick={() => toggleStatusFilter("accepted")} />
        <Tile label="Pending" value={t.pendingAcceptance} tone="text-amber-600" stagger={3} active={statusFilter === "pending"} onClick={() => toggleStatusFilter("pending")} />
        <Tile label="Changes req." value={t.changesRequested} tone="text-rose-600" stagger={4} active={statusFilter === "changes_requested"} onClick={() => toggleStatusFilter("changes_requested")} />
        <Tile label="Rejected" value={t.rejectedByHolder} tone="text-slate-600" stagger={5} active={statusFilter === "rejected"} onClick={() => toggleStatusFilter("rejected")} />
        <Tile label="Revoked" value={t.revoked} tone="text-red-600" stagger={6} active={statusFilter === "revoked"} onClick={() => toggleStatusFilter("revoked")} />
        <Tile label="Expired" value={t.expired} tone="text-slate-400" stagger={7} active={statusFilter === "expired"} onClick={() => toggleStatusFilter("expired")} />
      </div>
      <p className="text-[11px] text-slate-400 -mt-2">Click a tile to filter the credential status board below.</p>

      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 animate-slide-up stagger-1">
        <h2 className="font-bold text-slate-900 text-sm mb-1 font-display">Issuance requests</h2>
        <p className="text-xs text-slate-500 mb-4">Outcome of the maker-checker proposals submitted to mint a credential — separate from the lifecycle totals above, which track a credential after it exists. Click a tile to see the proposals.</p>
        <div className="grid grid-cols-3 gap-3 text-center">
          <button type="button" onClick={() => toggleProposalFilter("all")}
            className={`flex flex-col gap-0.5 rounded-xl border p-2 transition-colors ${proposalFilter === "all" ? "border-brand-400 ring-1 ring-brand-300" : "border-transparent hover:bg-slate-50"}`}>
            <div className="text-xl font-bold tabular-nums font-display text-slate-900">{issuance.issued}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Issued</div>
          </button>
          <button type="button" onClick={() => toggleProposalFilter("executed")}
            className={`flex flex-col gap-0.5 rounded-xl border p-2 transition-colors ${proposalFilter === "executed" ? "border-brand-400 ring-1 ring-brand-300" : "border-transparent hover:bg-slate-50"}`}>
            <div className="text-xl font-bold tabular-nums font-display text-emerald-600">{issuance.success}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Success</div>
          </button>
          <button type="button" onClick={() => toggleProposalFilter("failed")}
            className={`flex flex-col gap-0.5 rounded-xl border p-2 transition-colors ${proposalFilter === "failed" ? "border-brand-400 ring-1 ring-brand-300" : "border-transparent hover:bg-slate-50"}`}>
            <div className="text-xl font-bold tabular-nums font-display text-red-600">{issuance.failed}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Failed</div>
          </button>
        </div>

        {proposalFilter && (
          <div className="mt-4 rounded-xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-widest text-slate-400">
                <tr>
                  <th className="text-left font-semibold px-3 py-2">Kind</th>
                  <th className="text-left font-semibold px-3 py-2">Proposer</th>
                  <th className="text-left font-semibold px-3 py-2">Status</th>
                  <th className="text-left font-semibold px-3 py-2">Created</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {pagedIssuanceRows.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-slate-400">Nothing here.</td></tr>}
                {pagedIssuanceRows.map((p) => (
                  <Fragment key={p.id}>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-700">{p.kind}</td>
                      <td className="px-3 py-2 text-slate-500">{p.proposerLabel}</td>
                      <td className="px-3 py-2 capitalize text-slate-700">{p.status}</td>
                      <td className="px-3 py-2 text-slate-400 font-data">{new Date(p.createdAt).toLocaleString()}</td>
                      <td className="px-3 py-2 text-right">
                        <button className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px]" onClick={() => setProposalExpanded((x) => (x === p.id ? null : p.id))}>{proposalExpanded === p.id ? "Hide" : "View"}</button>
                      </td>
                    </tr>
                    {proposalExpanded === p.id && (
                      <tr className="border-t border-slate-100 bg-slate-50/60">
                        <td colSpan={5} className="px-3 py-3 text-slate-600">
                          {p.error && <div className="text-rose-600 mb-1.5">{p.error}</div>}
                          <div className="grid grid-cols-2 gap-1.5">
                            {Object.entries(p.payload).filter(([k]) => k !== "claims").map(([k, v]) => (
                              <div key={k}><span className="text-slate-400">{k}:</span> {typeof v === "object" ? JSON.stringify(v) : String(v)}</div>
                            ))}
                          </div>
                          <div className="mt-1.5 text-[11px] text-slate-400">
                            {p.approvals.length}/{p.required} approval{p.required === 1 ? "" : "s"}
                            {p.decidedAt && ` · decided ${new Date(p.decidedAt).toLocaleString()}`}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            </div>
            <Pager page={proposalPage} pageSize={PAGE_SIZE} total={issuanceRows.length} onPage={setProposalPage} />
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 animate-slide-up stagger-2">
          <h2 className="font-bold text-slate-900 text-sm mb-4 font-display">Issued — last 30 days</h2>
          <ActivityStrip days={data.activity} />
        </div>
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 animate-slide-up stagger-3">
          <h2 className="font-bold text-slate-900 text-sm mb-4 font-display">Verification activity</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            {([
              ["Pending",        data.verification.pending,       "text-amber-600"],
              ["Awaiting verify",data.verification.consented,     "text-sky-600"],
              ["Verified valid", data.verification.verifiedValid, "text-emerald-600"],
              ["Verified inv.",  data.verification.verifiedInvalid,"text-red-600"],
              ["Rejected",       data.verification.rejected,      "text-slate-500"],
              ["Expired",        data.verification.expired,       "text-slate-400"],
            ] as const).map(([label, v, tone]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <div className={`text-xl font-bold tabular-nums font-display ${tone}`}>{v}</div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-3 animate-slide-up stagger-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold text-slate-900 text-sm mr-auto font-display">Credential status board</h2>
          <input value={search} onChange={(e) => { setSearch(e.target.value); setBoardPage(1); }} placeholder="Search holder…"
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs" />
          <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setBoardPage(1); }}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs bg-white">
            <option value="all">All types</option>
            {types.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => toggleStatusFilter("all")}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${statusFilter === "all" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
            All ({data.board.length})
          </button>
          {STATUS_ORDER.map((s) => {
            const n = data.board.filter((r) => r.status === s).length;
            if (n === 0) return null;
            return (
              <button key={s} onClick={() => toggleStatusFilter(s)}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${statusFilter === s ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                {STATUS_META[s].label} ({n})
              </button>
            );
          })}
        </div>
        {data.boardTotal > data.board.length && (
          <p className="text-xs text-slate-500">Showing the newest {data.board.length} of {data.boardTotal} credentials.</p>
        )}
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="text-[10px] text-slate-400 bg-slate-50/80 uppercase tracking-widest">
              <tr>
                <th className="text-left font-semibold px-3 py-2.5">Holder</th>
                <th className="text-left font-semibold px-3 py-2.5">Credential</th>
                <th className="text-left font-semibold px-3 py-2.5">Use case</th>
                <th className="text-left font-semibold px-3 py-2.5">Issued</th>
                <th className="text-left font-semibold px-3 py-2.5">Expires</th>
                <th className="text-left font-semibold px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((r) => (
                <Fragment key={r.credentialId}>
                  <tr className="border-t border-slate-100 hover:bg-slate-50/70 transition-colors">
                    <td className="px-3 py-2 text-slate-700 font-medium text-xs">{r.holderLabel}</td>
                    <td className="px-3 py-2 text-slate-700 text-xs">{r.type}</td>
                    <td className="px-3 py-2 text-slate-400 text-xs">{r.useCaseName}</td>
                    <td className="px-3 py-2 text-slate-400 text-xs font-data">{new Date(r.issuedAt).toLocaleDateString()}</td>
                    <td className="px-3 py-2 text-slate-400 text-xs font-data">{r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : "—"}</td>
                    <td className="px-3 py-2">
                      <StatusPill status={r.status} />
                      {r.acceptanceNote && <div className="text-[11px] text-rose-500 mt-0.5">{r.acceptanceNote}</div>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px]" onClick={() => setBoardExpanded((x) => (x === r.credentialId ? null : r.credentialId))}>{boardExpanded === r.credentialId ? "Hide" : "View"}</button>
                    </td>
                  </tr>
                  {boardExpanded === r.credentialId && (
                    <tr className="border-t border-slate-100 bg-slate-50/60">
                      <td colSpan={7} className="px-3 py-3 text-xs text-slate-600">
                        <div><span className="text-slate-400">Credential id:</span> <span className="font-data">{r.credentialId}</span></div>
                        <div><span className="text-slate-400">Holder DID:</span> <span className="font-data">{r.holderDid}</span></div>
                        <div><span className="text-slate-400">Use case key:</span> {r.useCaseKey}</div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400 text-xs">No credentials match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager page={boardPage} pageSize={PAGE_SIZE} total={rows.length} onPage={setBoardPage} />
      </div>

      {data.byUseCase.length > 1 && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-3">
          <h2 className="font-semibold text-slate-900 text-sm">By use case</h2>
          {data.byUseCase.map((u) => (
            <details key={u.key} className="rounded-lg border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm text-slate-800 font-medium">
                {u.name} <span className="text-slate-400 font-normal">— {u.counts.issued} issued</span>
              </summary>
              <div className="mt-2 space-y-1">
                {u.byType.map((ty) => (
                  <div key={ty.type} className="flex flex-wrap gap-x-4 text-xs text-slate-600">
                    <span className="font-medium text-slate-800 w-44 truncate">{ty.type}</span>
                    <span>issued {ty.counts.issued}</span>
                    <span className="text-emerald-600">accepted {ty.counts.accepted}</span>
                    <span className="text-amber-600">pending {ty.counts.pendingAcceptance}</span>
                    <span className="text-red-600">revoked {ty.counts.revoked}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
