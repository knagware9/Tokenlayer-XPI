import { useEffect, useState } from "react";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import { DOMAIN_LABELS, ROLE_LABELS, fullCapabilities, toggleCapability, validateEnvelope } from "../lib/capabilities.js";
import { ORG_DOMAINS, ORG_OPERATING_ROLES, type CompanyCategory, type CredentialStatusInfo, type DidDocument, type KybDocumentRef, type OrgCapabilities, type OrgDomain, type OrgMember, type OrgOperatingRole, type OrgType, type Organization, type Role } from "../types.js";
import { CredentialsPanel } from "./CredentialsPanel.js";
import { Card, EmptyState, Pill, SectionHeader } from "./ui.js";

const ORG_TYPES: OrgType[] = ["bank", "corporate", "msme", "government", "verifier"];

const CATEGORY_LABELS: Record<CompanyCategory, string> = {
  "private-limited": "Private Limited",
  "public-limited": "Public Limited",
  llp: "LLP",
  opc: "OPC",
  "section-8": "Section 8",
};

/** A compact label/value pair for the KYB details grid. */
function Kv({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-slate-400">{label}</dt>
      <dd className="font-medium text-slate-700 truncate">{value}</dd>
    </div>
  );
}

// Mirrors the server's canCreateOrgMember: only a PlatformAdmin may mint an OrgAdmin.
const MEMBER_ROLES: Role[] = ["OrgAdmin", "UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"];

function truncateDid(v: string): string {
  return v.length > 28 ? `${v.slice(0, 18)}…${v.slice(-6)}` : v;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * The EN-A capability envelope as pills. `null`/absent is the UNRESTRICTED
 * LEGACY envelope (org predates EN-A and keeps full powers) — never "none".
 * An explicit envelope with an empty half really is restrictive, so it says so.
 */
function CapabilityPills({ caps }: { caps: OrgCapabilities | null | undefined }): JSX.Element {
  if (caps == null) return <Pill tone="muted">unrestricted (legacy)</Pill>;
  return (
    <>
      {caps.domains.length === 0
        ? <Pill tone="warn">no domains</Pill>
        : caps.domains.map((d) => <Pill key={d} tone="info">{DOMAIN_LABELS[d] ?? d}</Pill>)}
      {caps.roles.length === 0
        ? <Pill tone="warn">no roles</Pill>
        : caps.roles.map((r) => <Pill key={r} tone="muted">{ROLE_LABELS[r] ?? r}</Pill>)}
    </>
  );
}

/** Two checkbox groups over an envelope draft — shared by the platform's direct
 * grant and the org's change request. */
function CapabilityEditor({ value, onChange, disabled }: {
  value: OrgCapabilities;
  onChange: (next: OrgCapabilities) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <fieldset>
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Domains</legend>
        {ORG_DOMAINS.map((d) => (
          <label key={d} className="flex items-center gap-2 py-1 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox" disabled={disabled} checked={value.domains.includes(d)}
              onChange={() => onChange({ ...value, domains: toggleCapability<OrgDomain>(value.domains, d) })}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            {DOMAIN_LABELS[d]}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Operating roles</legend>
        {ORG_OPERATING_ROLES.map((r) => (
          <label key={r} className="flex items-center gap-2 py-1 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox" disabled={disabled} checked={value.roles.includes(r)}
              onChange={() => onChange({ ...value, roles: toggleCapability<OrgOperatingRole>(value.roles, r) })}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            {ROLE_LABELS[r]}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

/**
 * The selected org's capability envelope plus the one management surface the
 * signed-in role is entitled to: a PlatformAdmin grants directly (PATCH), an
 * OrgAdmin of THIS org proposes a change (202 → pending platform approval).
 * Everyone else just reads the pills. Mounted with key={org.id} so the draft
 * re-seeds when the selection changes.
 */
function OrgCapabilitiesCard({ org, onChanged }: { org: Organization; onChanged: () => void }): JSX.Element {
  const { token, user, refreshSession } = useAuth();
  const isPlatform = user?.role === "PlatformAdmin";
  const canRequest = user?.role === "OrgAdmin" && user.orgId === org.id;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<OrgCapabilities>(org.capabilities ?? fullCapabilities());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const invalid = validateEnvelope(draft);

  async function save(caps: OrgCapabilities | null): Promise<void> {
    if (!token) return;
    setBusy(true); setError(null); setNote(null);
    try {
      await api.setOrgCapabilities(token, org.id, caps);
      setEditing(false);
      setNote(caps === null ? "Cleared to the unrestricted legacy envelope." : "Capabilities updated.");
      onChanged();
      // The envelope rides the session and drives the sidebar. Without this the
      // nav keeps the login-time snapshot and disagrees with the card beside it
      // (a reload would not help — it restores from localStorage). Best-effort:
      // the grant itself already succeeded, so a refresh failure must not
      // surface as if it had not.
      await refreshSession().catch(() => undefined);
    } catch (err) {
      setError(errMessage(err, "Could not update capabilities"));
    } finally {
      setBusy(false);
    }
  }

  async function requestChange(): Promise<void> {
    if (!token) return;
    setBusy(true); setError(null); setNote(null);
    try {
      await api.requestOrgCapabilities(token, org.id, draft);
      setEditing(false);
      // No refresh here: nothing has changed yet, and when it does it is a
      // PlatformAdmin approving elsewhere — this session cannot observe it.
      setNote("Change requested — pending approval by a platform administrator. Once granted, it takes effect for you at your next sign-in.");
    } catch (err) {
      setError(errMessage(err, "Could not request a capability change"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Capabilities"
      description="What this organization may do on the platform — the domains it operates and the roles it plays."
    >
      <div className="flex flex-wrap items-center gap-2">
        <CapabilityPills caps={org.capabilities} />
        {(isPlatform || canRequest) && (
          <button
            onClick={() => { setEditing((v) => !v); setError(null); setNote(null); setDraft(org.capabilities ?? fullCapabilities()); }}
            className="ml-auto text-xs rounded border border-slate-300 text-slate-600 px-3 py-1.5 font-medium hover:bg-slate-50"
          >
            {editing ? "Cancel" : isPlatform ? "Edit" : "Request change"}
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          <CapabilityEditor value={draft} onChange={setDraft} disabled={busy} />
          {invalid && <p className="text-xs text-amber-700">{invalid}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void (isPlatform ? save(draft) : requestChange())}
              disabled={busy || invalid !== null}
              className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
            >
              {isPlatform ? "Save capabilities" : "Submit request"}
            </button>
            {isPlatform && org.capabilities != null && (
              <button
                onClick={() => void save(null)}
                disabled={busy}
                className="rounded-lg border border-slate-300 text-slate-600 py-1.5 px-4 text-sm font-medium hover:bg-slate-50 disabled:opacity-40"
              >
                Clear to legacy
              </button>
            )}
          </div>
        </div>
      )}

      {note && <p className="mt-3 text-sm text-emerald-700">{note}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Card>
  );
}

/**
 * The organization area: a PlatformAdmin provisions organizations and their
 * members; an OrgAdmin sees only their own org's roster. Every member minted
 * here gets a DID and a membership credential from the org's issuer DID.
 */
export function Organizations(): JSX.Element {
  const { token, user } = useAuth();
  const isPlatform = user?.role === "PlatformAdmin";
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [pending, setPending] = useState<Organization[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Lives HERE, not in PendingOrgs: the queue card unmounts when the last
  // pending org is approved, and the issuance notice must survive that.
  const [issued, setIssued] = useState<{ name: string; did: string } | null>(null);

  const reload = (): void => {
    if (!token) return;
    setError(null);
    api.orgs(token).then((rows) => {
      setOrgs(rows);
      setSelected((cur) => cur ?? rows[0]?.id ?? null);
    }).catch((err) => setError(errMessage(err, "Failed to load organizations")));
  };
  useEffect(reload, [token]);

  // PlatformAdmin only: the self-service registration queue awaiting a decision.
  const reloadPending = (): void => {
    if (token && isPlatform) void api.pendingOrgs(token).then(setPending).catch(() => setPending([]));
  };
  useEffect(reloadPending, [token]);

  const selectedOrg = orgs.find((o) => o.id === selected) ?? null;

  // Resolved once for the selected org only — a DID document per card would be
  // one request per org on every render of the list.
  const selectedDid = selectedOrg?.did ?? null;
  const [registration, setRegistration] = useState<DidDocument["registration"]>(null);
  useEffect(() => {
    if (!token || !selectedDid) { setRegistration(null); return; }
    void api.didDocument(token, selectedDid)
      .then((d) => setRegistration(d.registration ?? null))
      .catch(() => setRegistration(null));
  }, [token, selectedDid]);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Organizations"
        description={isPlatform ? "Provision organizations and their members. Each gets a DID; members receive a membership credential." : "Your organization and its members."}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}

      {isPlatform && issued && (
        <p className="text-sm rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-2">
          <span className="font-semibold">{issued.name}</span> approved — DID issued by TokenLayer Platform
          <span className="font-mono text-xs"> {issued.did.slice(0, 24)}…</span> · registered on-chain · OrganizationCredential anchored.
        </p>
      )}
      {isPlatform && pending.length > 0 && (
        <PendingOrgs
          pending={pending}
          onIssued={setIssued}
          onApproved={() => { reloadPending(); reload(); }}
          onRejected={reloadPending}
        />
      )}

      {isPlatform && <CreateOrg onCreated={reload} />}

      {orgs.length === 0 ? (
        <Card>
          <EmptyState
            icon="globe"
            title="No organizations yet"
            hint={isPlatform ? "Create one above to start onboarding members." : "Your account is not linked to an organization."}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {orgs.map((o) => (
            <OrgCard
              key={o.id}
              org={o}
              selected={o.id === selected}
              registration={o.id === selected ? registration : null}
              onSelect={() => setSelected(o.id)}
            />
          ))}
        </div>
      )}

      {selectedOrg && <OrgCapabilitiesCard key={selectedOrg.id} org={selectedOrg} onChanged={reload} />}

      {selectedOrg && <Members org={selectedOrg} />}
    </div>
  );
}

function OrgCard({ org, selected, registration, onSelect }: {
  org: Organization;
  selected: boolean;
  /** Only ever set for the selected org — the DID document is resolved once, not per card. */
  registration: DidDocument["registration"];
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onSelect}
      className={`text-left bg-white rounded-2xl border shadow-sm p-4 space-y-2 hover:border-brand-400 ${selected ? "border-brand-500 ring-1 ring-brand-200" : "border-slate-200/80"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold text-slate-900 truncate">{org.name}</div>
        <Pill tone={org.verified ? "ok" : "warn"}>{org.verified ? "verified" : "unverified"}</Pill>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="info">{org.orgType}</Pill>
        {org.jurisdiction && <Pill tone="muted">{org.jurisdiction}</Pill>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <CapabilityPills caps={org.capabilities} />
      </div>
      {org.status !== "active" ? (
        <Pill tone="warn">DID pending issuance</Pill>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-mono text-slate-500 truncate" title={org.did}>
              {truncateDid(org.did)}
            </span>
            {registration?.registered && (
              <Pill tone={registration.active ? "ok" : "muted"}>{registration.active ? "on-chain" : "deactivated"}</Pill>
            )}
          </div>
          {(() => {
            const oc = org.credentials?.find((c) => c.type === "OrganizationCredential" && !c.revoked);
            return oc ? (
              <span className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">Issued by <span className="font-medium text-slate-700">TokenLayer Platform</span></span>
                <CredStatusPill id={oc.id} />
              </span>
            ) : null;
          })()}
        </div>
      )}
    </button>
  );
}

/**
 * The corporate self-service approval queue: organizations that self-registered
 * and are pending a PlatformAdmin decision. Approving activates the org (and its
 * pending admin); rejecting records a reason.
 */
function PendingOrgs({ pending, onIssued, onApproved, onRejected }: {
  pending: Organization[];
  onIssued: (issued: { name: string; did: string }) => void;
  onApproved: () => void;
  onRejected: () => void;
}): JSX.Element {
  const { token } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function approve(id: string): Promise<void> {
    if (!token) return;
    setBusy(id);
    setError(null);
    try {
      const res = await api.approveOrg(token, id);
      onIssued({ name: res.name, did: res.did });
      onApproved();
    } catch (err) {
      setError(errMessage(err, "Approve failed"));
    } finally {
      setBusy(null);
    }
  }

  async function reject(id: string): Promise<void> {
    if (!token) return;
    const reason = window.prompt("Reason for rejecting this registration?")?.trim();
    if (!reason) return;
    setBusy(id);
    setError(null);
    try {
      await api.rejectOrg(token, id, reason);
      onRejected();
    } catch (err) {
      setError(errMessage(err, "Reject failed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Pending corporate registrations" description="Self-service sign-ups awaiting a platform decision.">
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      <div className="space-y-2">
        {pending.map((o) => {
          const p = o.companyProfile;
          return (
            <div key={o.id} className="rounded-lg border border-slate-200 px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900 truncate">{o.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Pill tone="info">{o.orgType}</Pill>
                    {p && <Pill tone="muted">{CATEGORY_LABELS[p.category] ?? p.category}</Pill>}
                    {p && <Pill tone={p.companyStatus === "active" ? "ok" : "warn"}>{p.companyStatus}</Pill>}
                    {o.jurisdiction && <Pill tone="muted">{o.jurisdiction}</Pill>}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => setOpen((cur) => (cur === o.id ? null : o.id))}
                    className="text-xs rounded border border-slate-300 text-slate-600 px-3 py-1.5 font-medium hover:bg-slate-50"
                  >
                    {open === o.id ? "Hide" : "Review"}
                  </button>
                  <button
                    onClick={() => void approve(o.id)}
                    disabled={busy === o.id}
                    className="text-xs rounded bg-brand-600 text-white px-3 py-1.5 font-medium hover:bg-brand-700 disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => void reject(o.id)}
                    disabled={busy === o.id}
                    className="text-xs rounded border border-slate-300 text-slate-600 px-3 py-1.5 font-medium hover:bg-slate-50 disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
              </div>
              {open === o.id && (
                <>
                  {/* The requested capability envelope is part of what is being approved. */}
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <div className="text-xs text-slate-400 mb-1.5">Requested capabilities</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <CapabilityPills caps={o.capabilities} />
                    </div>
                  </div>
                  {p && (
                    <dl className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 border-t border-slate-100 pt-3 text-xs">
                      <Kv label="CIN" value={p.cin} />
                      <Kv label="PAN" value={p.pan} />
                      <Kv label="GSTIN" value={p.gstin || "—"} />
                      <Kv label="Incorporated" value={p.dateOfIncorporation} />
                      <Kv label="State" value={p.state} />
                      <Kv label="Pincode" value={p.pincode} />
                    </dl>
                  )}
                  {p?.documents && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <DocLink token={token!} label="CIN certificate" doc={p.documents.cinCertificate} />
                      {p.documents.gstinCertificate && <DocLink token={token!} label="GSTIN certificate" doc={p.documents.gstinCertificate} />}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Authenticated download of a stored KYB certificate (blob → save). */
function DocLink({ token, label, doc }: { token: string; label: string; doc: KybDocumentRef }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function download(): Promise<void> {
    setBusy(true);
    setError(false);
    try {
      const blob = await api.downloadDocument(token, doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = label.toLowerCase().replace(/\s+/g, "-");
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={() => void download()}
      disabled={busy}
      className="text-xs rounded border border-slate-300 text-slate-600 px-2.5 py-1 font-medium hover:bg-slate-50 disabled:opacity-40"
    >
      ⬇ {label} <span className="text-slate-400 font-normal">{doc.sha256.slice(0, 10)}…</span>
      {error && <span className="text-red-500"> — failed</span>}
    </button>
  );
}

/** Live status pill for one credential via the public status endpoint. */
function CredStatusPill({ id }: { id: string }): JSX.Element | null {
  const [status, setStatus] = useState<CredentialStatusInfo | null>(null);
  useEffect(() => { void api.credentialStatus(id).then(setStatus).catch(() => setStatus(null)); }, [id]);
  if (!status) return null;
  return <Pill tone={status.revoked ? "danger" : "ok"}>{status.revoked ? "revoked" : status.source === "chain" ? "anchored on-chain" : "issued"}</Pill>;
}

function CreateOrg({ onCreated }: { onCreated: () => void }): JSX.Element {
  const { token } = useAuth();
  const [name, setName] = useState("");
  const [orgType, setOrgType] = useState<OrgType>("bank");
  const [registrationId, setRegistrationId] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true);
    try {
      await api.createOrg(token!, {
        name: name.trim(),
        orgType,
        registrationId: registrationId.trim() || undefined,
        jurisdiction: jurisdiction.trim() || undefined,
      });
      setName(""); setRegistrationId(""); setJurisdiction("");
      onCreated();
    } catch (err) {
      setError(errMessage(err, "Create failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4 max-w-2xl">
      <h2 className="font-semibold text-slate-900">Create an organization</h2>
      <div className="grid grid-cols-2 gap-4">
        <input className="input" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="select" value={orgType} onChange={(e) => setOrgType(e.target.value as OrgType)}>
          {ORG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className="input" placeholder="registration id (optional)" value={registrationId} onChange={(e) => setRegistrationId(e.target.value)} />
        <input className="input" placeholder="jurisdiction (optional, e.g. IN)" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40">
        Create organization
      </button>
    </form>
  );
}

function Members({ org }: { org: Organization }): JSX.Element {
  const { token } = useAuth();
  const orgId = org.id;
  const [rows, setRows] = useState<OrgMember[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = (): void => {
    if (!token) return;
    setError(null);
    api.orgMembers(token, orgId)
      .then(setRows)
      .catch((err) => setError(errMessage(err, "Failed to load members")));
  };
  useEffect(reload, [token, orgId]);

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Members"
        description="Every member holds a DID and a membership credential issued by the organization."
        actions={
          <button
            onClick={() => setAdding((v) => !v)}
            className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
          >
            {adding ? "Close" : "Add member"}
          </button>
        }
      />
      {adding && <AddMember orgId={orgId} onAdded={reload} />}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {rows.length === 0 ? (
        <Card>
          <EmptyState icon="users" title="No members yet" hint="Add a member to mint their DID and membership credential." />
        </Card>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500 bg-slate-50 uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Email</th>
                <th className="text-left font-medium px-4 py-2.5">Role</th>
                <th className="text-left font-medium px-4 py-2.5">Use case</th>
                <th className="text-left font-medium px-4 py-2.5">DID</th>
                <th className="text-left font-medium px-4 py-2.5">KYC</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-t border-slate-100">
                  <td className="px-4 py-2">{m.email}</td>
                  <td className="px-4 py-2">{m.role}</td>
                  <td className="px-4 py-2 text-slate-500">{m.useCaseKey ?? "—"}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500" title={m.did ?? ""}>
                    {m.did ? truncateDid(m.did) : "—"}
                  </td>
                  <td className="px-4 py-2">
                    <Pill tone={m.kycStatus === "approved" ? "ok" : m.kycStatus === "rejected" ? "danger" : "warn"}>{m.kycStatus}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CredentialsPanel org={org} members={rows} />
    </div>
  );
}

function AddMember({ orgId, onAdded }: { orgId: string; onAdded: () => void }): JSX.Element {
  const { token, user } = useAuth();
  // An OrgAdmin may not mint another OrgAdmin — the API 403s.
  const roleOptions = user?.role === "PlatformAdmin" ? MEMBER_ROLES : MEMBER_ROLES.filter((r) => r !== "OrgAdmin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>(roleOptions[0] ?? "Issuer");
  const [useCaseKey, setUseCaseKey] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<{ did: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    setBusy(true);
    try {
      const res = await api.createMember(token!, orgId, {
        email,
        password,
        role,
        useCaseKey: useCaseKey.trim() || undefined,
        walletAddress: walletAddress.trim() || undefined,
      });
      setOk({ did: res.did });
      setEmail(""); setPassword(""); setUseCaseKey(""); setWalletAddress("");
      onAdded();
    } catch (err) {
      setError(errMessage(err, "Create failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4 max-w-2xl">
      <h2 className="font-semibold text-slate-900">Add a member</h2>
      <div className="grid grid-cols-2 gap-4">
        <input className="input" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" placeholder="password (min 6)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <input className="input" placeholder="use-case key (optional)" value={useCaseKey} onChange={(e) => setUseCaseKey(e.target.value)} />
        <input className="input col-span-2" placeholder="wallet address 0x… (optional)" value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} />
      </div>
      {ok && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3">
          <p className="text-xs font-medium text-emerald-700">Member created · membership credential issued</p>
          <p className="text-[11px] font-mono text-emerald-800 break-all mt-1">{ok.did}</p>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40">
        Create member
      </button>
    </form>
  );
}
