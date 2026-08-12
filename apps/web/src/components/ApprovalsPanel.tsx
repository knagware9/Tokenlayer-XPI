import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import type { BatchReport, Proposal } from "../types.js";
import { Pill } from "./ui.js";

/** True when a proposal's `result` looks like a batch report (as opposed to some
 * other kind-specific result shape, or absent). */
function isBatchReport(result: Proposal["result"]): result is BatchReport {
  return !!result && typeof (result as { total?: unknown }).total === "number" && Array.isArray((result as { rows?: unknown }).rows);
}

const STATUS_TONE: Record<Proposal["status"], "ok" | "warn" | "danger" | "info" | "muted"> = {
  pending: "warn",
  approved: "info",
  executed: "ok",
  rejected: "muted",
  failed: "danger",
};

/** One-line summary of what a proposal will do, from its server-built payload. */
function summarize(p: Proposal): string {
  const pl = p.payload ?? {};
  // Credential arms come first: "issue-credential" must not be swallowed by the
  // looser asset-issuance arm below.
  if (p.kind === "issue-credential") return `issue a ${String(pl.type ?? "credential")} to ${String((pl.claims as Record<string, unknown>)?.legalName ?? pl.subjectDid ?? "a subject")}`;
  if (p.kind === "issue-usecase-credential") {
    const subject = pl.subjectOrgId ? "an organization" : "a user";
    return `issue ${String(pl.credentialType ?? "credential")} to ${subject} · ${String(pl.credentialUseCaseKey ?? "")}`.trim();
  }
  if (p.kind === "revoke-credential") return `revoke a credential — ${String(pl.reason ?? "no reason given")}`;
  if (p.kind === "onboard-user") return `onboard ${String(pl.role ?? "user")} ${String(pl.email ?? "")}${(pl.kyc as Record<string, unknown> | null)?.country ? ` (KYC: ${String((pl.kyc as Record<string, unknown>).country)})` : ""}`;
  if (p.kind === "onboard-user-batch") return `onboard ${(pl.rows as unknown[] | undefined)?.length ?? "?"} users${p.useCaseKey ? ` — ${p.useCaseKey}` : ""}`;
  if (p.kind === "issue-usecase-credential-batch") return `issue ${(pl.rows as unknown[] | undefined)?.length ?? "?"} × ${String(pl.credentialType ?? "credential")} — ${String(pl.useCaseKey ?? "")}`;
  if (p.kind === "revoke-user-identity") return `revoke a user's identity — ${String(pl.reason ?? "no reason given")}`;
  if (p.kind === "org-capability-change") {
    const caps = pl.capabilities as { domains?: string[]; roles?: string[] } | undefined;
    const domains = caps?.domains?.length ? caps.domains.join(" · ") : "no domains";
    const roles = caps?.roles?.length ? caps.roles.join(", ") : "no roles";
    // The panel has no org roster to hand — the short id keeps this to one request.
    const orgId = String(pl.orgId ?? p.orgId ?? "");
    return `capability change${orgId ? ` for org ${orgId.slice(0, 8)}…` : ""} — ${domains} · ${roles}`;
  }
  if (p.kind === "create-use-case") return `configure use case ${String(pl.name ?? pl.key ?? "")} (${String(pl.symbol ?? "")})`;
  if (p.kind === "issue") {
    const supply = pl.initialSupply as string | undefined;
    return supply ? `mint ${Number(supply).toLocaleString()} tokens to treasury on activation` : "activate the asset";
  }
  if (p.kind === "cashflow-execute") return `settle a cashflow from ${String(pl.from ?? "").slice(0, 10)}…`;
  const b = (pl.body ?? {}) as Record<string, string>;
  const detail = b.amount ? `${Number(b.amount).toLocaleString()} → ${(b.to ?? "").slice(0, 8)}…` : b.account ? (b.account as string).slice(0, 10) + "…" : "";
  return `${p.kind} ${detail}`.trim();
}

/**
 * Maker-checker Approvals inbox: every pending proposal the signed-in user (a
 * capability holder who is NOT the proposer) can approve or reject — both
 * use-case-scoped (asset issuance, cashflows) and org-scoped (credential
 * issuance/revocation) — plus a log of recent decisions. The server decides
 * what the caller may see, so this panel is scope-agnostic.
 */
export function ApprovalsPanel({ onChanged }: { onChanged?: () => void }): JSX.Element {
  const { token, user } = useAuth();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      setProposals(await api.proposals(token));
    } catch {
      /* transient — leave the last list */
    }
  }, [token]);
  useEffect(() => { void reload(); }, [reload]);

  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending").slice(0, 12);

  async function decide(p: Proposal, verdict: "approve" | "reject"): Promise<void> {
    if (!token) return;
    setBusy(p.id);
    setError(null);
    try {
      const res = verdict === "approve" ? await api.approveProposal(token, p.id) : await api.rejectProposal(token, p.id);
      if (res.proposal.status === "failed") setError(`Execution failed: ${res.proposal.error ?? "unknown error"}`);
      await reload();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Decision failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}

      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-3">
        <h2 className="font-semibold text-slate-900">Pending approvals <span className="text-slate-400 font-normal">({pending.length})</span></h2>
        {pending.length === 0 && <p className="text-sm text-slate-400">Nothing awaiting approval.</p>}
        {pending.map((p) => {
          const isProposer = p.proposerId === user?.id;
          return (
            <div key={p.id} className="rounded-lg border border-slate-200 p-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-[10px] font-semibold uppercase">{p.kind}</span>
                  <span className="text-slate-700">{summarize(p)}</span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  by {p.proposerLabel} · {p.approvals.length}/{p.required} approvals
                  {p.assetId && <> · asset {p.assetId.slice(0, 8)}…</>}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button disabled={isProposer || busy === p.id} title={isProposer ? "You proposed this — a different approver is required" : ""}
                  onClick={() => void decide(p, "approve")}
                  className="text-xs rounded bg-brand-600 text-white px-3 py-1.5 font-medium hover:bg-brand-700 disabled:opacity-40">Approve</button>
                <button disabled={isProposer || busy === p.id}
                  onClick={() => void decide(p, "reject")}
                  className="text-xs rounded border border-slate-300 text-slate-600 px-3 py-1.5 font-medium hover:bg-slate-50 disabled:opacity-40">Reject</button>
              </div>
            </div>
          );
        })}
      </div>

      {decided.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-2">
          <h3 className="text-sm font-semibold text-slate-800">Recent decisions</h3>
          {decided.map((p) => <DecisionRow key={p.id} p={p} />)}
        </div>
      )}
    </div>
  );
}

/** One "recent decisions" row. When the proposal executed a batch (onboard-user-batch,
 * issue-usecase-credential-batch), an expandable summary line shows the per-row report. */
function DecisionRow({ p }: { p: Proposal }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const report = isBatchReport(p.result) ? p.result : null;
  const failedRows = report?.rows.filter((r) => r.status === "failed") ?? [];

  return (
    <div className="text-sm py-1 border-b border-slate-50 last:border-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-600 truncate">
          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-semibold uppercase mr-2">{p.kind}</span>
          {summarize(p)}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {report && (
            <button onClick={() => setExpanded((e) => !e)} className="text-[11px] text-brand-600 hover:text-brand-700 font-medium">
              {expanded ? "Hide report" : "View report"}
            </button>
          )}
          <span title={p.error ?? ""}><Pill tone={STATUS_TONE[p.status]}>{p.status}</Pill></span>
        </div>
      </div>
      {report && expanded && (
        <div className="mt-1.5 mb-1 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-xs text-slate-600">
          <div>Total: {report.total} | Successful: {report.succeeded} | Failed: {report.failed}</div>
          {failedRows.length > 0 && (
            <ul className="mt-1 list-disc pl-5 space-y-0.5 text-rose-600">
              {failedRows.map((r) => (
                <li key={r.index}>#{r.index + 1} {r.email ?? r.subjectEmail ?? "?"}: {r.error ?? "failed"}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
