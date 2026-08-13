/**
 * THE SCHEME CONSOLE — a government authority's view of what it has issued.
 *
 * A SCHEME IS A CREDENTIAL PROGRAMME. Nothing new is stored for it: a scheme is
 * a credential use case, its beneficiaries are the holders it has issued to,
 * and its state is the standing of those credentials. That is a deliberate
 * choice over inventing a Scheme model — an authority running a domicile
 * certificate and an income certificate already HAS two programmes, and the
 * data to report on them was already there. What was missing was that
 * `GET /orgs/{id}/credentials` did not say which use case a credential came
 * from, so the register was one undifferentiated pile.
 *
 * WHAT AN OPERATOR CAME HERE TO DO, in order:
 *   1. see each scheme's real numbers — enrolled, in force, never taken up,
 *      withdrawn, lapsed, and what is about to lapse;
 *   2. find one person, by name, DID, credential id or any claim (a district, a
 *      ward), because that is what a counter enquiry is;
 *   3. hand that person, or a verifying office, something they can check
 *      without an account — the public verification link.
 *
 * ISSUED IS NOT IN FORCE, and this screen refuses to blur them. One "issued"
 * total would overstate delivery (it counts what was later withdrawn) and
 * understate it (it hides that holders never accepted) at the same time. See
 * `lib/schemes.ts` for the precedence and its tests.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, describeApiError } from "../api.js";
import { useAuth } from "../auth.js";
// `csvField` is shared with the activity log: one CSV escaping, tested once.
import { csvField } from "../lib/activity-log.js";
import {
  beneficiariesOf, countsFor, groupByScheme, matchesQuery, schemesRunBy, statusOf,
  type BeneficiaryRow, type BeneficiaryStatus, type SchemeCounts,
} from "../lib/schemes.js";
import type { CredentialUseCase, IssuedCredential, Organization } from "../types.js";
import { Card, EmptyState, Pill, SectionHeader, StatCard } from "./ui.js";

const STATUS_TONE: Record<BeneficiaryStatus, "ok" | "warn" | "danger" | "muted"> = {
  active: "ok", pending: "warn", rejected: "danger", revoked: "danger", expired: "muted",
};
const STATUS_LABEL: Record<BeneficiaryStatus, string> = {
  active: "In force", pending: "Not accepted", rejected: "Rejected", revoked: "Withdrawn", expired: "Lapsed",
};

/** The beneficiary register as CSV — the file an authority actually files. */
function registerCsv(rows: BeneficiaryRow[]): string {
  const cols = ["holderDid", "name", "status", "credentialId", "type", "issuedAt", "expiresAt", "revokedReason"];
  const body = rows.map((r) => [
    r.holderDid, r.name, STATUS_LABEL[r.status], r.latest.id, r.latest.type,
    r.latest.issuedAt, r.latest.expiresAt, r.latest.revokedReason,
  ].map(csvField).join(","));
  return [cols.join(","), ...body].join("\n");
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function CountRow({ counts }: { counts: SchemeCounts }): JSX.Element {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard label="Beneficiaries" value={String(counts.beneficiaries)} sub={`${counts.issued} credential${counts.issued === 1 ? "" : "s"} issued`} icon="users" />
      <StatCard label="In force" value={String(counts.active)} sub={counts.expiringSoon ? `${counts.expiringSoon} lapse within 30 days` : "none lapsing soon"} icon="check" />
      <StatCard label="Not accepted" value={String(counts.pending)} sub="issued, not taken up" icon="doc" />
      <StatCard label="Withdrawn / lapsed" value={String(counts.revoked + counts.expired)} sub={`${counts.revoked} withdrawn · ${counts.expired} lapsed`} icon="shield" />
    </div>
  );
}

function BeneficiaryRegister(props: { scheme: CredentialUseCase; credentials: IssuedCredential[]; onBack: () => void }): JSX.Element {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<BeneficiaryStatus | "">("");
  const all = useMemo(() => beneficiariesOf(props.credentials), [props.credentials]);
  const rows = useMemo(
    () => all.filter((r) => (status === "" || r.status === status) && matchesQuery(r, query)),
    [all, query, status],
  );
  const counts = useMemo(() => countsFor(props.credentials), [props.credentials]);

  return (
    <div className="space-y-4">
      <button onClick={props.onBack} className="text-sm text-brand-700 hover:text-brand-800 font-medium">← All schemes</button>
      <SectionHeader title={props.scheme.name} description={props.scheme.description ?? undefined} />
      <CountRow counts={counts} />

      <Card title="Beneficiary register" description="One row per person. A holder with several credentials shows the newest — that is the one in force.">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input
            className="input w-auto flex-1 min-w-[12rem] text-sm"
            placeholder="Search name, DID, credential id or any claim…"
            value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search beneficiaries"
          />
          <select className="select w-auto text-sm" value={status} onChange={(e) => setStatus(e.target.value as BeneficiaryStatus | "")} aria-label="Status">
            <option value="">Any status</option>
            {(Object.keys(STATUS_LABEL) as BeneficiaryStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          <button
            onClick={() => download(`${props.scheme.key}-register.csv`, registerCsv(rows))}
            disabled={rows.length === 0}
            className="rounded-lg bg-brand-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
          >
            Export register
          </button>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon="users"
            title={all.length === 0 ? "No beneficiaries yet" : "No one matches that"}
            hint={all.length === 0 ? "Issue this scheme's credential to enrol its first beneficiary." : "Try a different name, DID or claim."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-3 py-2.5">Beneficiary</th>
                  <th className="text-left font-medium px-3 py-2.5">Status</th>
                  <th className="text-left font-medium px-3 py-2.5">Issued</th>
                  <th className="text-left font-medium px-3 py-2.5">Valid to</th>
                  <th className="text-left font-medium px-3 py-2.5">Verify</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.holderDid}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{r.name ?? <span className="text-slate-400">unnamed</span>}</div>
                      <div className="font-mono text-[11px] text-slate-400 break-all">{r.holderDid}</div>
                      {r.credentials.length > 1 && (
                        <div className="text-[11px] text-slate-500">{r.credentials.length} credentials — showing the newest</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill>
                      {r.status === "revoked" && r.latest.revokedReason && (
                        <div className="text-[11px] text-slate-500 mt-0.5">{r.latest.revokedReason}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">{r.latest.issuedAt.slice(0, 10)}</td>
                    <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">
                      {r.latest.expiresAt ? r.latest.expiresAt.slice(0, 10) : <span className="text-slate-300">no expiry</span>}
                    </td>
                    <td className="px-3 py-2">
                      {/* What a counter hands a citizen or a verifying office —
                          the public page, not the credential itself. */}
                      <a
                        className="text-xs text-brand-600 hover:text-brand-700 underline decoration-dotted"
                        href={`/verify?id=${encodeURIComponent(r.latest.id)}`} target="_blank" rel="noopener noreferrer"
                      >
                        Public check
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-slate-500 mt-3">
          {rows.length} of {all.length} beneficiar{all.length === 1 ? "y" : "ies"} shown.
        </p>
      </Card>
    </div>
  );
}

/**
 * `orgType` decides the word, because the shape is identical for an authority
 * running a welfare scheme and a university running a degree programme — and
 * calling a university's degrees a "scheme" would be as wrong as calling a
 * district's entitlement a "programme".
 */
function nounFor(orgType: string | undefined): { one: string; many: string; Many: string } {
  return orgType === "government"
    ? { one: "scheme", many: "schemes", Many: "Schemes" }
    : { one: "programme", many: "programmes", Many: "Programmes" };
}

export function SchemeConsole(): JSX.Element {
  const { token, user } = useAuth();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [schemes, setSchemes] = useState<CredentialUseCase[]>([]);
  const [issued, setIssued] = useState<IssuedCredential[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // `GET /orgs` scopes itself, so an OrgAdmin gets exactly their own org and
  // the picker below only ever appears for a PlatformAdmin.
  useEffect(() => {
    if (!token) return;
    let live = true;
    api.orgs(token)
      .then((rows) => { if (!live) return; setOrgs(rows); setOrgId((cur) => cur ?? user?.orgId ?? rows[0]?.id ?? null); })
      .catch((err) => { if (live) setError(describeApiError(err, "Could not load organizations")); });
    return () => { live = false; };
  }, [token, user?.orgId]);

  const load = useCallback(async () => {
    if (!token || !orgId) return;
    setBusy(true); setError(null);
    try {
      const [defs, creds] = await Promise.all([api.credentialUseCases(token), api.orgCredentials(token, orgId)]);
      setSchemes(defs);
      setIssued(creds);
    } catch (err) {
      setError(describeApiError(err, "Could not load schemes"));
    } finally {
      setBusy(false);
    }
  }, [token, orgId]);
  useEffect(() => { void load(); }, [load]);

  const org = orgs.find((o) => o.id === orgId) ?? null;
  const noun = nounFor(org?.orgType);
  const { byScheme, unscoped } = useMemo(() => groupByScheme(issued), [issued]);

  // The catalog carries every authority's programmes; these are the ones THIS
  // org runs. See `schemesRunBy` for why that is the issuer binding and not
  // `ownerOrgId` — using the latter alone showed every authority an empty
  // console, because a platform-provisioned use case owns no config row.
  const mine = useMemo(() => schemesRunBy(schemes, org?.id ?? null), [schemes, org]);

  const chosen = mine.find((s) => s.key === selected) ?? null;
  if (chosen) {
    return <BeneficiaryRegister scheme={chosen} credentials={byScheme.get(chosen.key) ?? []} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        title={noun.Many}
        description={`Each ${noun.one} you run, who is enrolled, and what is actually in force.`}
        actions={
          orgs.length > 1 ? (
            <select className="select w-auto text-sm" value={orgId ?? ""} onChange={(e) => { setOrgId(e.target.value); setSelected(null); }} aria-label="Organization">
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          ) : undefined
        }
      />

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}

      {mine.length === 0 && !busy ? (
        <Card>
          <EmptyState
            icon="doc"
            title={`No ${noun.many} yet`}
            hint={`A ${noun.one} is a credential use case this organization owns. Create one from Identity → provision from a template, then enrolments appear here.`}
          />
        </Card>
      ) : (
        <div className="grid gap-4">
          {mine.map((s) => {
            const counts = countsFor(byScheme.get(s.key) ?? []);
            return (
              <Card
                key={s.key}
                title={s.name}
                description={s.description ?? undefined}
                actions={
                  <button
                    onClick={() => setSelected(s.key)}
                    className="rounded-lg border border-slate-300 text-slate-600 px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
                  >
                    Open register
                  </button>
                }
              >
                <CountRow counts={counts} />
              </Card>
            );
          })}
        </div>
      )}

      {unscoped.length > 0 && (
        <Card title="Not part of any programme" description="Credentials this organization issued outside a use case — onboarding KYC and organization credentials.">
          {/*
            Shown rather than dropped, and kept OUT of every scheme's counts:
            these are enrolment paperwork, and folding them into a scheme would
            inflate its delivery numbers with its own admin.
          */}
          <div className="text-sm text-slate-600">
            {unscoped.length} credential{unscoped.length === 1 ? "" : "s"} —{" "}
            {[...new Set(unscoped.map((c) => c.type))].join(", ")}.{" "}
            {unscoped.filter((c) => statusOf(c) === "active").length} in force.
          </div>
        </Card>
      )}

      {issued.length > 0 && (
        <div>
          <button
            onClick={() => download(`${org?.name ?? "organization"}-beneficiaries.csv`, registerCsv(beneficiariesOf(issued)))}
            className="rounded-lg border border-slate-300 text-slate-600 px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
          >
            Export every beneficiary
          </button>
        </div>
      )}
    </div>
  );
}
