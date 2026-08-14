import { useEffect, useState } from "react";
import { ApiError, api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { CredentialTypeInfo, IssuedCredential, OrgMember, Organization } from "../../types.js";
import { Card, EmptyState, Pill, SectionHeader, Skeleton } from "../shared/ui.js";

function truncateDid(v: string): string {
  return v.length > 28 ? `${v.slice(0, 18)}…${v.slice(-6)}` : v;
}

function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Credential issuance and revocation for one organization. Both operations are
 * maker-checker gated: the API answers 202 with a PROPOSAL, so nothing here
 * ever claims a credential was issued or revoked — only that it was requested.
 * The pending proposal is then decided in the Approvals inbox.
 */
export function CredentialsPanel({ org, members }: { org: Organization; members: OrgMember[] }): JSX.Element {
  const { token } = useAuth();
  const [types, setTypes] = useState<CredentialTypeInfo[] | null>(null);
  const [issued, setIssued] = useState<IssuedCredential[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadIssued = (): void => {
    if (!token) return;
    api.orgCredentials(token, org.id)
      .then(setIssued)
      .catch((err) => setError(errMessage(err, "Failed to load issued credentials")));
  };

  useEffect(() => {
    if (!token) return;
    setError(null);
    setIssued(null);
    void Promise.all([api.credentialTypes(token), api.orgCredentials(token, org.id)])
      .then(([t, c]) => { setTypes(t); setIssued(c); })
      .catch((err) => setError(errMessage(err, "Failed to load credentials")));
  }, [token, org.id]);

  // An org must never be offered a type it is not allowed to issue — the API 403s.
  const issuable = (types ?? []).filter((t) => t.allowedIssuerOrgTypes.includes(org.orgType));

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Credentials"
        description="Issue verifiable credentials from this organization's DID. Issuance and revocation both require approval."
      />
      {error && <p className="text-sm text-red-600">{error}</p>}

      {types === null ? (
        <Card><Skeleton lines={3} /></Card>
      ) : issuable.length === 0 ? (
        <Card>
          <EmptyState
            icon="doc"
            title={`A "${org.orgType}" organization cannot issue any credential type`}
            hint="Credential types declare which organization types may issue them. None of the configured types allow this one."
          />
        </Card>
      ) : (
        <IssueCredential org={org} members={members} types={issuable} onRequested={reloadIssued} />
      )}

      <IssuedList credentials={issued} onRevoked={reloadIssued} />
    </div>
  );
}

function IssueCredential({
  org,
  members,
  types,
  onRequested,
}: {
  org: Organization;
  members: OrgMember[];
  types: CredentialTypeInfo[];
  onRequested: () => void;
}): JSX.Element {
  const { token } = useAuth();
  // A subject with no DID has nothing to hold the credential — the API rejects it.
  const subjects = members.filter((m) => m.did);
  const [typeName, setTypeName] = useState(types[0]?.type ?? "");
  const [subjectUserId, setSubjectUserId] = useState(subjects[0]?.id ?? "");
  const [claims, setClaims] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = types.find((t) => t.type === typeName) ?? types[0];
  const props = Object.entries(selected?.claimSchema.properties ?? {});
  const required = selected?.claimSchema.required ?? [];

  // The claim inputs are rebuilt from the selected type's schema — drop stale values.
  useEffect(() => { setClaims({}); setOk(null); }, [typeName]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (!selected) return;
    if (!subjectUserId) { setError("Pick a subject — they must have a DID"); return; }
    const missing = required.filter((k) => !(claims[k] ?? "").trim());
    if (missing.length > 0) { setError(`Required: ${missing.join(", ")}`); return; }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(claims)) {
        if (value.trim()) payload[key] = value.trim();
      }
      const res = await api.requestCredential(token!, {
        type: selected.type,
        subjectUserId,
        claims: payload,
        issuerOrgId: org.id,
      });
      // 202 — a proposal, not a credential. Say exactly that.
      setOk(`Requested — ${res.proposal.required} approval(s) needed before it is issued.`);
      setClaims({});
      onRequested();
    } catch (err) {
      setError(errMessage(err, "Request failed"));
    } finally {
      setBusy(false);
    }
  }

  if (subjects.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="users"
          title="No member has a DID yet"
          hint="A credential needs a subject DID to hold it. Add a member — provisioning mints their DID."
        />
      </Card>
    );
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4 max-w-2xl">
      <h2 className="font-semibold text-slate-900">Request a credential</h2>
      <div className="grid grid-cols-2 gap-4">
        <select className="select" value={selected?.type ?? ""} onChange={(e) => setTypeName(e.target.value)}>
          {types.map((t) => <option key={t.type} value={t.type}>{t.type}</option>)}
        </select>
        <select className="select" value={subjectUserId} onChange={(e) => setSubjectUserId(e.target.value)}>
          {subjects.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
        </select>
      </div>
      {selected && (
        <p className="text-xs text-slate-500">
          {selected.description} · valid {selected.validityDays} days · {selected.requiredApprovals} approval(s)
          {selected.selfIssuedOnly && " · self-issued only"}
        </p>
      )}

      {props.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          {props.map(([key, spec]) => (
            <label key={key} className="block">
              <span className="text-xs font-medium text-slate-600">
                {key}{required.includes(key) && <span className="text-rose-600"> *</span>}
              </span>
              {spec.enum ? (
                <select
                  className="select mt-1"
                  value={claims[key] ?? ""}
                  onChange={(e) => setClaims((c) => ({ ...c, [key]: e.target.value }))}
                >
                  <option value="">—</option>
                  {spec.enum.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  className="input mt-1"
                  placeholder={spec.description ?? spec.type}
                  value={claims[key] ?? ""}
                  onChange={(e) => setClaims((c) => ({ ...c, [key]: e.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
      )}

      {ok && (
        <div className="rounded-lg bg-amber-50 border border-amber-100 p-3">
          <p className="text-xs font-medium text-amber-800">{ok}</p>
          <p className="text-[11px] text-amber-700 mt-1">Decide it in the Approvals inbox — it is not issued yet.</p>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40">
        Request credential
      </button>
    </form>
  );
}

function IssuedList({ credentials, onRevoked }: { credentials: IssuedCredential[] | null; onRevoked: () => void }): JSX.Element {
  const { token } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function revoke(c: IssuedCredential): Promise<void> {
    setError(null);
    setNote(null);
    // The API 400s without a reason, so an empty prompt is a no-op, not a request.
    const reason = window.prompt(`Revoke this ${c.type}? A reason is required.`)?.trim();
    if (!reason) return;
    setBusy(c.id);
    try {
      const res = await api.revokeCredential(token!, c.id, reason);
      setNote(`Revocation requested — ${res.proposal.required} approval(s) needed before it takes effect.`);
      onRevoked();
    } catch (err) {
      setError(errMessage(err, "Revocation request failed"));
    } finally {
      setBusy(null);
    }
  }

  if (credentials === null) return <Card><Skeleton lines={3} /></Card>;

  return (
    <div className="space-y-3">
      {note && <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-2">{note}</div>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {credentials.length === 0 ? (
        <Card>
          <EmptyState icon="doc" title="No credentials issued yet" hint="Approved requests appear here once they are issued." />
        </Card>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500 bg-slate-50 uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Type</th>
                <th className="text-left font-medium px-4 py-2.5">Holder</th>
                <th className="text-left font-medium px-4 py-2.5">Issued</th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.id} className="border-t border-slate-100 align-top">
                  <td className="px-4 py-2">{c.type}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500" title={c.holderDid}>
                    {truncateDid(c.holderDid)}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{fmtDate(c.issuedAt)}</td>
                  <td className="px-4 py-2">
                    <Pill tone={c.revoked ? "muted" : "ok"}>{c.revoked ? "revoked" : "valid"}</Pill>
                    {c.revoked && c.revokedReason && (
                      <div className="text-xs text-rose-600 mt-1">{c.revokedReason}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!c.revoked && (
                      <button
                        onClick={() => void revoke(c)}
                        disabled={busy === c.id}
                        className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
