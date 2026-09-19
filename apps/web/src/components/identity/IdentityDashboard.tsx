import { useEffect, useMemo, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { DerivedCredentialStatus, IdentityDashboardData, Proposal } from "../../types.js";
import { Pager, SectionHeader, TableShell, staggerClass } from "../shared/ui.js";

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
  accepted: { label: "Accepted", pill: "bg-success/10 text-success border-success/25" },
  pending: { label: "Pending acceptance", pill: "bg-warning/10 text-warning border-warning/25" },
  changes_requested: { label: "Changes requested", pill: "bg-danger/10 text-danger border-danger/25" },
  rejected: { label: "Rejected by holder", pill: "bg-elevated text-muted border-border" },
  revoked: { label: "Revoked", pill: "bg-danger/10 text-danger border-danger/25" },
  expired: { label: "Expired", pill: "bg-elevated text-muted border-border" },
};
const STATUS_ORDER: DerivedCredentialStatus[] = ["pending", "accepted", "changes_requested", "rejected", "revoked", "expired"];

function StatusPill({ status }: { status: DerivedCredentialStatus }): JSX.Element {
  const m = STATUS_META[status];
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${m.pill}`}>{m.label}</span>;
}

function Tile({ label, value, tone, stagger, active, onClick }: { label: string; value: number; tone?: string; stagger?: number; active?: boolean; onClick?: () => void }): JSX.Element {
  const shared = `text-left w-full bg-surface rounded-2xl border p-4 shadow-sm transition-shadow ${staggerClass(stagger)} ${active ? "border-brand-400 ring-1 ring-brand-300" : "border-border/80"}`;
  const body = (
    <>
      <div className={`text-2xl font-bold tabular-nums font-display animate-count-in ${tone ?? "text-fg"}`}>{value.toLocaleString()}</div>
      <div className="text-[11px] font-semibold text-muted mt-1">{label}</div>
    </>
  );
  if (!onClick) return <div className={shared}>{body}</div>;
  return <button type="button" onClick={onClick} className={`${shared} hover:shadow hover:border-border cursor-pointer`}>{body}</button>;
}

function BackButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="text-sm text-muted hover:text-fg inline-flex items-center gap-1.5">
      ← Back to Dashboard
    </button>
  );
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
  const [boardDetailId, setBoardDetailId] = useState<string | null>(null);
  const [boardPage, setBoardPage] = useState(1);
  const [proposalFilter, setProposalFilter] = useState<"all" | "executed" | "failed" | null>(null);
  const [proposalDetailId, setProposalDetailId] = useState<string | null>(null);
  const [proposalPage, setProposalPage] = useState(1);
  const [activityQuery, setActivityQuery] = useState("");
  const [activityPage, setActivityPage] = useState(1);

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

  const activityRows = useMemo(() => {
    if (!data) return [];
    const q = activityQuery.trim().toLowerCase();
    return !q ? data.recent : data.recent.filter((e) => `${e.kind} ${e.type} ${e.holderLabel} ${e.summary}`.toLowerCase().includes(q));
  }, [data, activityQuery]);
  const pagedActivityRows = activityRows.slice((activityPage - 1) * PAGE_SIZE, activityPage * PAGE_SIZE);
  const ACTIVITY_KIND_LABEL: Record<string, string> = {
    issued: "Issued", revoked: "Revoked", "verification-requested": "Verify requested", "verification-decided": "Verify decided",
  };

  function toggleStatusFilter(s: DerivedCredentialStatus | "all"): void {
    setStatusFilter((cur) => (cur === s ? "all" : s));
    setBoardPage(1);
  }
  function toggleProposalFilter(f: "all" | "executed" | "failed"): void {
    setProposalFilter((cur) => (cur === f ? null : f));
    setProposalDetailId(null);
    setProposalPage(1);
  }

  if (error) return <div><SectionHeader title="Identity Dashboard" description={error} /></div>;
  if (!data) return <div><SectionHeader title="Identity Dashboard" description="Loading…" /></div>;

  if (boardDetailId) {
    const r = data.board.find((row) => row.credentialId === boardDetailId);
    if (!r) { setBoardDetailId(null); return <></>; }
    return (
      <div className="space-y-4">
        <BackButton onClick={() => setBoardDetailId(null)} />
        <SectionHeader title={r.type} description={`${r.holderLabel} · ${STATUS_META[r.status].label}`} />
        <div className="bg-surface rounded-2xl border border-border/80 shadow-sm p-5 space-y-3 max-w-2xl">
          <div className="flex items-center justify-between">
            <StatusPill status={r.status} />
            {r.acceptanceNote && <div className="text-xs text-danger">{r.acceptanceNote}</div>}
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><div className="text-[11px] text-muted">Credential id</div><div className="font-data text-fg break-all">{r.credentialId}</div></div>
            <div><div className="text-[11px] text-muted">Holder DID</div><div className="font-data text-fg break-all">{r.holderDid}</div></div>
            <div><div className="text-[11px] text-muted">Use case</div><div className="text-fg">{r.useCaseName} <span className="text-muted">({r.useCaseKey})</span></div></div>
            <div><div className="text-[11px] text-muted">Issued</div><div className="text-fg font-data">{new Date(r.issuedAt).toLocaleString()}</div></div>
            <div><div className="text-[11px] text-muted">Expires</div><div className="text-fg font-data">{r.expiresAt ? new Date(r.expiresAt).toLocaleString() : "—"}</div></div>
          </div>
        </div>
      </div>
    );
  }

  if (proposalDetailId) {
    const p = (proposals ?? []).find((row) => row.id === proposalDetailId);
    if (!p) { setProposalDetailId(null); return <></>; }
    return (
      <div className="space-y-4">
        <BackButton onClick={() => setProposalDetailId(null)} />
        <SectionHeader title={p.kind} description={`${p.proposerLabel} · ${p.status}`} />
        <div className="bg-surface rounded-2xl border border-border/80 shadow-sm p-5 space-y-3 max-w-2xl text-sm">
          {p.error && <div className="text-danger">{p.error}</div>}
          <div className="grid grid-cols-2 gap-1.5">
            {Object.entries(p.payload).filter(([k]) => k !== "claims").map(([k, v]) => (
              <div key={k} className="min-w-0"><span className="text-muted">{k}:</span> <span className="text-fg break-all">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span></div>
            ))}
          </div>
          <div className="text-[11px] text-muted border-t border-border pt-2">
            Created {new Date(p.createdAt).toLocaleString()} · {p.approvals.length}/{p.required} approval{p.required === 1 ? "" : "s"}
            {p.decidedAt && ` · decided ${new Date(p.decidedAt).toLocaleString()}`}
          </div>
        </div>
      </div>
    );
  }

  const t = data.totals;
  return (
    <div className="space-y-5">
      <SectionHeader title="Identity Dashboard" description="Credential lifecycle and verification activity across your identity use cases." />

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <Tile label="Issued" value={t.issued} stagger={1} active={statusFilter === "all"} onClick={() => toggleStatusFilter("all")} />
        <Tile label="Accepted" value={t.accepted} tone="text-success" stagger={2} active={statusFilter === "accepted"} onClick={() => toggleStatusFilter("accepted")} />
        <Tile label="Pending" value={t.pendingAcceptance} tone="text-warning" stagger={3} active={statusFilter === "pending"} onClick={() => toggleStatusFilter("pending")} />
        <Tile label="Changes req." value={t.changesRequested} tone="text-danger" stagger={4} active={statusFilter === "changes_requested"} onClick={() => toggleStatusFilter("changes_requested")} />
        <Tile label="Rejected" value={t.rejectedByHolder} tone="text-muted" stagger={5} active={statusFilter === "rejected"} onClick={() => toggleStatusFilter("rejected")} />
        <Tile label="Revoked" value={t.revoked} tone="text-danger" stagger={6} active={statusFilter === "revoked"} onClick={() => toggleStatusFilter("revoked")} />
        <Tile label="Expired" value={t.expired} tone="text-muted" stagger={7} active={statusFilter === "expired"} onClick={() => toggleStatusFilter("expired")} />
      </div>
      <p className="text-[11px] text-muted -mt-2">Click a tile to filter the credential status board below.</p>

      <div className="bg-surface rounded-2xl border border-border/80 shadow-sm p-5 animate-slide-up stagger-1">
        <h2 className="font-bold text-fg text-sm mb-1 font-display">Issuance requests</h2>
        <p className="text-xs text-muted mb-4">Outcome of the maker-checker proposals submitted to mint a credential — separate from the lifecycle totals above, which track a credential after it exists. Click a tile to see the proposals.</p>
        <div className="grid grid-cols-3 gap-3 text-center">
          <button type="button" onClick={() => toggleProposalFilter("all")}
            className={`flex flex-col gap-0.5 rounded-xl border p-2 transition-colors ${proposalFilter === "all" ? "border-brand-400 ring-1 ring-brand-300" : "border-transparent hover:bg-elevated"}`}>
            <div className="text-xl font-bold tabular-nums font-display text-fg">{issuance.issued}</div>
            <div className="text-[10px] font-semibold text-muted">Issued</div>
          </button>
          <button type="button" onClick={() => toggleProposalFilter("executed")}
            className={`flex flex-col gap-0.5 rounded-xl border p-2 transition-colors ${proposalFilter === "executed" ? "border-brand-400 ring-1 ring-brand-300" : "border-transparent hover:bg-elevated"}`}>
            <div className="text-xl font-bold tabular-nums font-display text-success">{issuance.success}</div>
            <div className="text-[10px] font-semibold text-muted">Success</div>
          </button>
          <button type="button" onClick={() => toggleProposalFilter("failed")}
            className={`flex flex-col gap-0.5 rounded-xl border p-2 transition-colors ${proposalFilter === "failed" ? "border-brand-400 ring-1 ring-brand-300" : "border-transparent hover:bg-elevated"}`}>
            <div className="text-xl font-bold tabular-nums font-display text-danger">{issuance.failed}</div>
            <div className="text-[10px] font-semibold text-muted">Failed</div>
          </button>
        </div>

        {proposalFilter && (
          <div className="mt-4">
            <TableShell>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Proposer</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pagedIssuanceRows.length === 0 && <tr><td colSpan={5} className="text-center text-muted">Nothing here.</td></tr>}
                {pagedIssuanceRows.map((p) => (
                  <tr key={p.id}>
                    <td className="text-fg">{p.kind}</td>
                    <td className="text-muted">{p.proposerLabel}</td>
                    <td className="capitalize text-fg">{p.status}</td>
                    <td className="text-muted font-data">{new Date(p.createdAt).toLocaleString()}</td>
                    <td className="text-right">
                      <button className="rounded-lg border border-border px-2.5 py-1 text-[11px]" onClick={() => setProposalDetailId(p.id)}>View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
            <Pager page={proposalPage} pageSize={PAGE_SIZE} total={issuanceRows.length} onPage={setProposalPage} />
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-surface rounded-2xl border border-border/80 shadow-sm p-5 animate-slide-up stagger-2">
          <h2 className="font-bold text-fg text-sm mb-4 font-display">Issued — last 30 days</h2>
          <ActivityStrip days={data.activity} />
        </div>
        <div className="bg-surface rounded-2xl border border-border/80 shadow-sm p-5 animate-slide-up stagger-3">
          <h2 className="font-bold text-fg text-sm mb-4 font-display">Verification activity</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            {([
              ["Pending",        data.verification.pending,       "text-warning"],
              ["Awaiting verify",data.verification.consented,     "text-sky-600"],
              ["Verified valid", data.verification.verifiedValid, "text-success"],
              ["Verified inv.",  data.verification.verifiedInvalid,"text-danger"],
              ["Rejected",       data.verification.rejected,      "text-muted"],
              ["Expired",        data.verification.expired,       "text-muted"],
            ] as const).map(([label, v, tone]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <div className={`text-xl font-bold tabular-nums font-display ${tone}`}>{v}</div>
                <div className="text-[10px] font-semibold text-muted">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-surface rounded-2xl border border-border/80 shadow-sm p-5 space-y-3 animate-slide-up stagger-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold text-fg text-sm mr-auto font-display">Recent activity</h2>
          <p className="text-xs text-muted w-full -mt-1 mb-1">Every credential issued or revoked, and every verification requested or decided, across your identity use cases — newest first.</p>
          <input value={activityQuery} onChange={(e) => { setActivityQuery(e.target.value); setActivityPage(1); }} placeholder="Search holder, type…"
            className="rounded-lg border border-border bg-elevated/80 px-2.5 py-1 text-xs focus:outline-none focus:border-primary focus:bg-surface focus:ring-4 focus:ring-primary/15" />
        </div>
        <TableShell>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Summary</th>
              <th>Use case</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {pagedActivityRows.map((e, i) => (
              <tr key={`${e.at}-${i}`}>
                <td className="text-fg font-medium">{ACTIVITY_KIND_LABEL[e.kind]}</td>
                <td className="text-fg">
                  {e.summary}
                  {e.txHash && <span className="ml-2 font-data text-[10px] text-muted">{e.txHash.slice(0, 14)}…</span>}
                </td>
                <td className="text-muted">{e.useCaseName}</td>
                <td className="text-muted font-data" title={new Date(e.at).toLocaleString()}>{new Date(e.at).toLocaleString()}</td>
              </tr>
            ))}
            {activityRows.length === 0 && (
              <tr><td colSpan={4} className="text-center text-muted">No activity yet.</td></tr>
            )}
          </tbody>
        </TableShell>
        <Pager page={activityPage} pageSize={PAGE_SIZE} total={activityRows.length} onPage={setActivityPage} />
      </div>

      <div className="bg-surface rounded-2xl border border-border/80 shadow-sm p-5 space-y-3 animate-slide-up stagger-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold text-fg text-sm mr-auto font-display">Credential status board</h2>
          <input value={search} onChange={(e) => { setSearch(e.target.value); setBoardPage(1); }} placeholder="Search holder…"
            className="rounded-lg border border-border bg-elevated/80 px-2.5 py-1 text-xs focus:outline-none focus:border-primary focus:bg-surface focus:ring-4 focus:ring-primary/15" />
          <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setBoardPage(1); }}
            className="rounded-lg border border-border bg-elevated/80 px-2 py-1 text-xs focus:outline-none focus:border-primary focus:bg-surface focus:ring-4 focus:ring-primary/15">
            <option value="all">All types</option>
            {types.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => toggleStatusFilter("all")}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${statusFilter === "all" ? "bg-primary text-white border-primary" : "bg-surface text-muted border-border hover:bg-elevated"}`}>
            All ({data.board.length})
          </button>
          {STATUS_ORDER.map((s) => {
            const n = data.board.filter((r) => r.status === s).length;
            if (n === 0) return null;
            return (
              <button key={s} onClick={() => toggleStatusFilter(s)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium ${statusFilter === s ? "bg-primary text-white border-primary" : "bg-surface text-muted border-border hover:bg-elevated"}`}>
                {STATUS_META[s].label} ({n})
              </button>
            );
          })}
        </div>
        {data.boardTotal > data.board.length && (
          <p className="text-xs text-muted">Showing the newest {data.board.length} of {data.boardTotal} credentials.</p>
        )}
        <TableShell>
          <thead>
            <tr>
              <th>Holder</th>
              <th>Credential</th>
              <th>Use case</th>
              <th>Issued</th>
              <th>Expires</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pagedRows.map((r) => (
              <tr key={r.credentialId}>
                <td className="text-fg font-medium">{r.holderLabel}</td>
                <td className="text-fg">{r.type}</td>
                <td className="text-muted">{r.useCaseName}</td>
                <td className="text-muted font-data">{new Date(r.issuedAt).toLocaleDateString()}</td>
                <td className="text-muted font-data">{r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : "—"}</td>
                <td>
                  <StatusPill status={r.status} />
                  {r.acceptanceNote && <div className="text-[11px] text-danger mt-0.5">{r.acceptanceNote}</div>}
                </td>
                <td className="text-right">
                  <button className="rounded-lg border border-border px-2.5 py-1 text-[11px]" onClick={() => setBoardDetailId(r.credentialId)}>View</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 !py-6 text-center text-muted">No credentials match.</td></tr>
            )}
          </tbody>
        </TableShell>
        <Pager page={boardPage} pageSize={PAGE_SIZE} total={rows.length} onPage={setBoardPage} />
      </div>

      {data.byUseCase.length > 1 && (
        <div className="bg-surface rounded-2xl border border-border/80 shadow-sm p-5 space-y-3">
          <h2 className="font-semibold text-fg text-sm">By use case</h2>
          {data.byUseCase.map((u) => (
            <details key={u.key} className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer text-sm text-fg font-medium">
                {u.name} <span className="text-muted font-normal">— {u.counts.issued} issued</span>
              </summary>
              <div className="mt-2 space-y-1">
                {u.byType.map((ty) => (
                  <div key={ty.type} className="flex flex-wrap gap-x-4 text-xs text-muted">
                    <span className="font-medium text-fg w-44 truncate">{ty.type}</span>
                    <span>issued {ty.counts.issued}</span>
                    <span className="text-success">accepted {ty.counts.accepted}</span>
                    <span className="text-warning">pending {ty.counts.pendingAcceptance}</span>
                    <span className="text-danger">revoked {ty.counts.revoked}</span>
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
