/**
 * THE AUDIT CONSOLE — the two questions an auditor actually asks.
 *
 *   ACTIVITY: what happened, and when? The durable event log (`GET /events`),
 *     the same globally ordered stream webhooks deliver from, readable in the
 *     browser and exportable.
 *   INTEGRITY: and can I prove the record was not edited afterwards? The
 *     hash-chain verification and its on-ledger anchor.
 *
 * ONE PAGE, TWO TABS, following the Developers precedent: a new sidebar entry
 * needs a domain classification, and getting that wrong is what caused the
 * ID-N self-lockout. These are also one job — nobody reviews activity without
 * wanting to know whether the record is trustworthy — so they belong together.
 *
 * WHY THIS EXISTS AT ALL: the integrity view had been built, tested and
 * documented, and was mounted NOWHERE. `IntegrityPanel` was the only orphaned
 * component in the app, which meant the platform's tamper-evidence — the
 * strongest thing it can show an enterprise or government buyer — could not be
 * seen from inside the product. The event log had the same shape of problem
 * from the other end: `api.events` existed and no surface called it.
 */
import { useCallback, useEffect, useState } from "react";
import { api, describeApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import { activityCsv, atEnd } from "../../lib/shared/activity-log.js";
import type { DomainKey } from "../../domains.js";
import { EVENT_TYPES, type PlatformEvent } from "../../types.js";
import { IntegrityPanel } from "./IntegrityPanel.js";
import { Card, EmptyState, Pill, SectionHeader } from "./ui.js";

const PAGE = 100;

/** Relative "n ago", matching IntegrityPanel's. */
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Colour by what the event is about, so a long list is scannable. */
function toneFor(type: string): "ok" | "warn" | "danger" | "info" | "muted" {
  if (type.endsWith(".revoked") || type.endsWith(".rejected")) return "danger";
  if (type.startsWith("credential.") || type.startsWith("verification.")) return "info";
  if (type.startsWith("asset.")) return "ok";
  if (type.startsWith("proposal.")) return "warn";
  return "muted";
}

function ActivityTab(): JSX.Element {
  const { token, user } = useAuth();
  const [events, setEvents] = useState<PlatformEvent[]>([]);
  const [type, setType] = useState("");
  const [cursor, setCursor] = useState(0);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Reload from the beginning — used on mount and whenever the filter changes. */
  const reload = useCallback(async (forType: string) => {
    if (!token) return;
    setBusy(true); setError(null);
    try {
      const res = await api.events(token, { limit: PAGE, ...(forType ? { type: forType } : {}) });
      setEvents(res.events);
      setCursor(res.nextAfter);
      setDone(atEnd(0, res.nextAfter, res.events.length));
    } catch (err) {
      setError(describeApiError(err, "Could not load the activity log."));
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => { void reload(type); }, [reload, type]);

  async function more(): Promise<void> {
    if (!token || done) return;
    setBusy(true); setError(null);
    try {
      const res = await api.events(token, { after: cursor, limit: PAGE, ...(type ? { type } : {}) });
      setEvents((rows) => [...rows, ...res.events]);
      setDone(atEnd(cursor, res.nextAfter, res.events.length));
      setCursor(res.nextAfter);
    } catch (err) {
      setError(describeApiError(err, "Could not load more events."));
    } finally {
      setBusy(false);
    }
  }

  function exportCsv(): void {
    const blob = new Blob([activityCsv(events)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <Card
        title="Activity log"
        description="Every platform fact, in the order it happened — the same durable stream webhooks deliver from."
      >
        {/*
          A TOOLBAR, NOT CARD `actions`. Three controls in the header slot
          compete with the title for the same row: the header lays out
          title-vs-actions side by side, so on any narrow column the heading
          collapses to one word per line while the controls sit intact beside
          it. Here they wrap instead.
        */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <select className="select w-auto text-sm" value={type} onChange={(e) => setType(e.target.value)} aria-label="Event type">
            <option value="">All event types</option>
            {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button
            onClick={() => void reload(type)} disabled={busy}
            className="rounded-lg border border-slate-300 text-slate-600 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            onClick={exportCsv} disabled={events.length === 0}
            className="rounded-lg bg-brand-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
          >
            Export CSV
          </button>
        </div>

        {error && <div className="mb-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}

        {/*
          WHAT THIS VIEW IS AND IS NOT, said here rather than discovered later.
          The cursor is ORG-grained, not use-case-grained: a desk operator sees
          their whole organization's events, including use cases they cannot
          otherwise open. And `seq` is a global counter, so gaps between your
          rows are other tenants' volume — not events you lost.
        */}
        <p className="text-xs text-slate-500 mb-3">
          {user?.role === "PlatformAdmin"
            ? "Platform-wide: every organization's events."
            : "Scoped to your organization — every use case in it, not just the ones you operate."}
          {" "}Gaps in the sequence are other tenants' events, never missing ones.
        </p>

        {events.length === 0 && !busy ? (
          <EmptyState
            icon="doc"
            title={type ? `No ${type} events yet` : "No activity yet"}
            hint="Events appear as credentials are issued, assets move and proposals execute."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-right font-medium px-3 py-2.5">Seq</th>
                  <th className="text-left font-medium px-3 py-2.5">When</th>
                  <th className="text-left font-medium px-3 py-2.5">Event</th>
                  <th className="text-left font-medium px-3 py-2.5">Use case</th>
                  <th className="text-left font-medium px-3 py-2.5">Subject</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-2 text-right font-mono text-xs text-slate-400">{e.seq}</td>
                    <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap" title={e.occurredAt}>{ago(e.occurredAt)}</td>
                    <td className="px-3 py-2"><Pill tone={toneFor(e.type)}>{e.type}</Pill></td>
                    <td className="px-3 py-2 text-xs text-slate-600">{e.useCaseKey ?? <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500 break-all">{e.subjectId ?? <span className="text-slate-300 font-sans">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {events.length > 0 && (
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-slate-500">{events.length} event{events.length === 1 ? "" : "s"} loaded</span>
            <button
              onClick={() => void more()} disabled={busy || done}
              className="rounded-lg border border-slate-300 text-slate-600 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-40"
            >
              {done ? "End of log" : busy ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

const TABS = [
  { id: "activity", label: "Activity" },
  { id: "integrity", label: "Integrity" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/**
 * `enabledDomains` decides whether the Integrity tab is offered at all: it
 * verifies ASSET audit chains, and on an identity-only deployment `/assets`
 * answers 404 DOMAIN_NOT_ENABLED. Offering a tab that can only produce an error
 * is worse than not offering it.
 */
export function AuditConsole(props: { useCaseKey?: string; enabledDomains: DomainKey[] }): JSX.Element {
  const showIntegrity = props.enabledDomains.includes("tokenization");
  const [tab, setTab] = useState<Tab>("activity");
  const tabs = TABS.filter((t) => t.id !== "integrity" || showIntegrity);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Audit"
        description="What happened, and proof the record of it was not edited afterwards."
      />

      {tabs.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-slate-200">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={t.id === tab ? "page" : undefined}
              className={`-mb-px rounded-t-lg border-b-2 px-3.5 py-2 text-sm font-medium ${
                t.id === tab
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === "integrity" && showIntegrity ? <IntegrityPanel useCaseKey={props.useCaseKey} /> : <ActivityTab />}
    </div>
  );
}
