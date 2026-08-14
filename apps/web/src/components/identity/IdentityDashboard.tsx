import { useEffect, useMemo, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { SANDBOX_EXCLUDED_NOTE } from "../../lib/modes.js";
import type { DerivedCredentialStatus, IdentityDashboardData } from "../../types.js";
import { SectionHeader } from "../shared/ui.js";

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

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }): JSX.Element {
  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4">
      <div className={`text-2xl font-semibold tabular-nums ${tone ?? "text-slate-900"}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

/** Dependency-free vertical mini bar strip (one bar per day). */
function ActivityStrip({ days }: { days: { date: string; issued: number }[] }): JSX.Element {
  const max = Math.max(1, ...days.map((d) => d.issued));
  return (
    <div className="flex items-end gap-[3px] h-16" title="Credentials issued per day">
      {days.map((d) => (
        <div key={d.date} className="flex-1 rounded-t bg-brand-500/70 min-w-[3px]"
          style={{ height: `${Math.max(d.issued > 0 ? 8 : 2, (d.issued / max) * 100)}%` }}
          title={`${d.date}: ${d.issued}`} />
      ))}
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
  // EN-D2: sandbox credential use cases are out of this aggregate unless asked
  // for, exactly as in `/analytics`. Same reasoning, same default, and the same
  // reason the note below is always on screen rather than only when it bites.
  const [includeSandbox, setIncludeSandbox] = useState(false);

  useEffect(() => {
    if (!token) return;
    setData(null);
    setError(null);
    api.identityDashboard(token, includeSandbox).then(setData).catch(() => setError("Could not load the identity dashboard."));
  }, [token, includeSandbox]);

  const types = useMemo(() => (data ? [...new Set(data.board.map((r) => r.type))].sort() : []), [data]);
  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.board.filter((r) =>
      (statusFilter === "all" || r.status === statusFilter) &&
      (typeFilter === "all" || r.type === typeFilter) &&
      (!q || r.holderLabel.toLowerCase().includes(q)));
  }, [data, statusFilter, typeFilter, search]);

  if (error) return <div><SectionHeader title="Identity Dashboard" description={error} /></div>;
  if (!data) return <div><SectionHeader title="Identity Dashboard" description="Loading…" /></div>;

  const t = data.totals;
  return (
    <div className="space-y-5">
      <SectionHeader title="Identity Dashboard" description="Credential lifecycle and verification activity across your identity use cases." />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className="text-slate-500">
          {includeSandbox
            ? "Sandbox credential use cases are INCLUDED in these figures. Simulated credentials are counted alongside real ones — do not report from this view."
            : SANDBOX_EXCLUDED_NOTE}
        </p>
        <label className="flex items-center gap-2 text-slate-600 cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={includeSandbox}
            onChange={(e) => setIncludeSandbox(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Include sandbox
        </label>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <Tile label="Issued" value={t.issued} />
        <Tile label="Accepted" value={t.accepted} tone="text-emerald-600" />
        <Tile label="Pending acceptance" value={t.pendingAcceptance} tone="text-amber-600" />
        <Tile label="Changes requested" value={t.changesRequested} tone="text-rose-600" />
        <Tile label="Rejected by holder" value={t.rejectedByHolder} tone="text-slate-600" />
        <Tile label="Revoked" value={t.revoked} tone="text-red-600" />
        <Tile label="Expired" value={t.expired} tone="text-slate-500" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
          <h2 className="font-semibold text-slate-900 text-sm mb-3">Issued — last 30 days</h2>
          <ActivityStrip days={data.activity} />
        </div>
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
          <h2 className="font-semibold text-slate-900 text-sm mb-3">Verification activity</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            {([["Pending", data.verification.pending], ["Awaiting verify", data.verification.consented],
               ["Verified valid", data.verification.verifiedValid], ["Verified invalid", data.verification.verifiedInvalid],
               ["Rejected", data.verification.rejected], ["Expired", data.verification.expired]] as const)
              .map(([label, v]) => (
                <div key={label}>
                  <div className="text-lg font-semibold tabular-nums text-slate-900">{v}</div>
                  <div className="text-[11px] text-slate-500">{label}</div>
                </div>
              ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold text-slate-900 text-sm mr-auto">Credential status board</h2>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search holder…"
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs" />
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs bg-white">
            <option value="all">All types</option>
            {types.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setStatusFilter("all")}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${statusFilter === "all" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
            All ({data.board.length})
          </button>
          {STATUS_ORDER.map((s) => {
            const n = data.board.filter((r) => r.status === s).length;
            if (n === 0) return null;
            return (
              <button key={s} onClick={() => setStatusFilter(statusFilter === s ? "all" : s)}
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
            <thead className="text-[11px] text-slate-500 bg-slate-50 uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-3 py-2">Holder</th>
                <th className="text-left font-medium px-3 py-2">Credential</th>
                <th className="text-left font-medium px-3 py-2">Use case</th>
                <th className="text-left font-medium px-3 py-2">Issued</th>
                <th className="text-left font-medium px-3 py-2">Expires</th>
                <th className="text-left font-medium px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.credentialId} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-700">{r.holderLabel}</td>
                  <td className="px-3 py-1.5 text-slate-700">{r.type}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.useCaseName}</td>
                  <td className="px-3 py-1.5 text-slate-500">{new Date(r.issuedAt).toLocaleDateString()}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : "—"}</td>
                  <td className="px-3 py-1.5">
                    <StatusPill status={r.status} />
                    {r.acceptanceNote && <div className="text-[11px] text-rose-600 mt-0.5">{r.acceptanceNote}</div>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-400">No credentials match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
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
