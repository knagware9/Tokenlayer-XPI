import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import { clampAccent } from "../lib/branding.js";
import { DOMAIN_LABELS, ROLE_LABELS, fullCapabilities, isOrgOperatingRole, orgRoleEnabled, toggleCapability, validateEnvelope } from "../lib/capabilities.js";
import { ORG_DOMAINS, ORG_OPERATING_ROLES, type CompanyCategory, type CredentialStatusInfo, type DidDocument, type KybDocumentRef, type OrgCapabilities, type OrgDomain, type OrgMember, type OrgOperatingRole, type OrgType, type Organization, type Role } from "../types.js";
import { useOrgLogo } from "./AppShell.js";
import { CredentialsPanel } from "./CredentialsPanel.js";
import { Card, EmptyState, Pill, SectionHeader } from "./ui.js";

const ORG_TYPES: OrgType[] = ["bank", "corporate", "msme", "government", "verifier"];

/** The platform's own `--brand-500`. Seeds the picker for an unbranded org so it
 * opens on the colour that org is actually wearing, not on black. */
const DEFAULT_ACCENT = "#12b39a";

/** Read a File as base64 (no data-URL prefix) via FileReader — safe for MB-sized files. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read file"));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

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
 * EN-E: the org's own mark and accent colour.
 *
 * Gated in the UI exactly as the two routes behind it are gated — a
 * PlatformAdmin or an OrgAdmin of THIS org — so the control is never offered to
 * somebody who would only earn a 403 by pressing it.
 *
 * Mounted with key={org.id} so the draft re-seeds when the selection changes.
 */
function OrgBrandingCard({ org, onChanged }: { org: Organization; onChanged: () => void }): JSX.Element | null {
  const { token, user, refreshSession } = useAuth();
  const canEdit = user?.role === "PlatformAdmin" || (user?.role === "OrgAdmin" && user.orgId === org.id);
  const [accent, setAccent] = useState<string>(org.brandAccent ?? DEFAULT_ACCENT);
  const [logoId, setLogoId] = useState<string | null>(org.brandLogoDocumentId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // TWO SOURCES, and the reason is an authorization one.
  //
  // The SAVED mark comes through the org's own door, which every member of the
  // org may read. A logo that has been uploaded but NOT yet saved has no such
  // door — it is not the org's mark yet — and the document store 403s for an
  // OrgAdmin, the very role this card exists for. So the pending one is
  // previewed from the `File` the browser already read to upload it: no request,
  // no gate, and the bytes are the same bytes.
  const savedPreview = useOrgLogo(org.brandLogoDocumentId ?? null, token, org.id);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  // The pending preview wins while it exists: it is the newer choice.
  const preview = pendingPreview ?? savedPreview;
  // One object URL alive at a time, and none after unmount. The live URL is
  // tracked in a REF, not read out of the state updater: `<StrictMode>`
  // double-invokes updaters, so creating and revoking inside one leaked a blob
  // per pick, and React makes no promise an updater runs at all on unmount.
  const pendingUrl = useRef<string | null>(null);
  const showPending = (file: File | null): void => {
    if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
    pendingUrl.current = file ? URL.createObjectURL(file) : null;
    setPendingPreview(pendingUrl.current);
  };
  useEffect(() => () => { if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current); pendingUrl.current = null; }, []);

  if (!canEdit) return null;

  // Only the SAVED accent is the org's colour; an unsaved draft must not claim
  // to be one, hence the comparison against the record rather than a dirty flag.
  const dirty = accent !== (org.brandAccent ?? DEFAULT_ACCENT) || logoId !== (org.brandLogoDocumentId ?? null);
  // The platform default does not itself clear AA, so an untouched picker would
  // otherwise open with a contrast warning about a colour nobody chose. Only
  // warn once the accent on screen is one this org owns or its admin just set.
  const accentChosen = org.brandAccent != null || accent !== DEFAULT_ACCENT;

  /**
   * THE PATCH IS BUILT BY PRESENCE, never by sending both keys.
   *
   * Sending both meant an OrgAdmin who uploaded a logo and never opened the
   * colour picker persisted `DEFAULT_ACCENT` — the PLATFORM's teal — as their
   * organization's own accent. It is not the same as leaving it unset: the
   * stored value runs through `clampAccent`, which darkens it (our default is
   * 2.6:1 against white), so the whole console shifted colour for an org that
   * chose nothing. It also made `accentChosen` true, pinning the "Darkened for
   * legibility" note permanently — about a colour nobody picked, which is the
   * exact thing that guard exists to prevent.
   *
   * The API, both repositories and the client were built for this: an omitted
   * key leaves the column alone, an explicit null clears it. This is the caller
   * that has to use it.
   */
  function changedBranding(): { brandAccent?: string | null; brandLogoDocumentId?: string | null } {
    const patch: { brandAccent?: string | null; brandLogoDocumentId?: string | null } = {};
    if (accent !== (org.brandAccent ?? DEFAULT_ACCENT)) patch.brandAccent = accent;
    if (logoId !== (org.brandLogoDocumentId ?? null)) patch.brandLogoDocumentId = logoId;
    return patch;
  }
  const darkened = accentChosen && clampAccent(accent) !== accent.toLowerCase();

  async function upload(file: File): Promise<void> {
    if (!token) return;
    setError(null); setNote(null);
    // PNG or JPEG, matching the server — pdfkit draws nothing else, and the old
    // copy recommended SVG, which the document store has never accepted.
    if (!/^image\/(png|jpeg)$/.test(file.type)) { setError("A brand logo must be a PNG or a JPEG"); return; }
    if (file.size > 2 * 1024 * 1024) { setError("Logo too large (max 2 MB)"); return; }
    setBusy(true);
    try {
      const up = await api.uploadBrandLogo(token, org.id, file.type, await fileToBase64(file));
      // Uploaded, not yet applied: the id only becomes the org's mark on Save,
      // so a mis-picked file can be replaced without ever having been live.
      setLogoId(up.id);
      showPending(file);
      setNote("Logo uploaded — press Save to apply it.");
    } catch (err) {
      setError(errMessage(err, "Upload failed"));
    } finally {
      setBusy(false);
    }
  }

  async function save(patch: { brandLogoDocumentId?: string | null; brandAccent?: string | null }): Promise<void> {
    if (!token) return;
    setBusy(true); setError(null); setNote(null);
    try {
      const updated = await api.updateBranding(token, org.id, patch);
      setAccent(updated.brandAccent ?? DEFAULT_ACCENT);
      setLogoId(updated.brandLogoDocumentId ?? null);
      // Saved (or cleared): the org's own door is now the truth, so drop the
      // local preview rather than keep showing bytes the record may no longer name.
      showPending(null);
      setNote(patch.brandAccent === null && patch.brandLogoDocumentId === null ? "Branding cleared." : "Branding saved.");
      onChanged();
      // The brand rides the SESSION, not the org list — without this the shell
      // keeps painting the old palette until the next sign-in. Best-effort: the
      // save already succeeded, so a refresh failure must not read as a failure.
      await refreshSession().catch(() => undefined);
    } catch (err) {
      setError(errMessage(err, "Could not save branding"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Branding"
      description="Your logo and one accent colour. Members of this organization see them across the console, and the logo appears on the certificates it issues."
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <div className="space-y-2">
          <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Accent colour</span>
          <div className="flex items-center gap-3">
            <input
              type="color" value={accent} disabled={busy}
              onChange={(e) => { setAccent(e.target.value); setNote(null); }}
              className="h-9 w-14 rounded border border-slate-300 bg-white p-1 cursor-pointer disabled:opacity-40"
              aria-label="Accent colour"
            />
            <span className="font-mono text-sm text-slate-600">{accent}</span>
          </div>
          {darkened && (
            <p className="text-[11px] text-amber-700">
              Darkened for legibility — white text on your colour would not meet contrast guidelines. Your saved colour is unchanged.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">Logo</span>
          <div className="flex items-center gap-3">
            <div className="h-12 w-24 rounded border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden shrink-0">
              {preview
                ? <img src={preview} alt="" className="max-h-full max-w-full object-contain" />
                : <span className="text-[11px] text-slate-400">none</span>}
            </div>
            <input
              type="file" accept="image/png,image/jpeg" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200"
            />
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <button
          onClick={() => void save(changedBranding())}
          disabled={busy || !dirty}
          className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
        >
          Save branding
        </button>
        {(org.brandAccent || org.brandLogoDocumentId) && (
          <button
            onClick={() => void save({ brandAccent: null, brandLogoDocumentId: null })}
            disabled={busy}
            className="rounded-lg border border-slate-300 text-slate-600 py-1.5 px-4 text-sm font-medium hover:bg-slate-50 disabled:opacity-40"
          >
            Clear branding
          </button>
        )}
      </div>

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

      {selectedOrg && <OrgBrandingCard key={`brand-${selectedOrg.id}`} org={selectedOrg} onChanged={reload} />}

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
  if (!status.revoked && status.source === "sandbox") return <Pill tone="warn">sandbox · not anchored</Pill>;
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
      {adding && <AddMember orgId={orgId} capabilities={org.capabilities ?? null} onAdded={reload} />}
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
                <th className="text-left font-medium px-4 py-2.5">Access</th>
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
                  {/* `active` was fetched on every row and rendered nowhere, so a
                      SUSPENDED member was indistinguishable from a working one in
                      the only roster an admin has. Suspension is exactly what a
                      roster is read to confirm. */}
                  <td className="px-4 py-2">
                    <Pill tone={m.active ? "ok" : "danger"}>{m.active ? "active" : "suspended"}</Pill>
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

function AddMember({ orgId, capabilities, onAdded }: { orgId: string; capabilities: OrgCapabilities | null; onAdded: () => void }): JSX.Element {
  const { token, user } = useAuth();
  // An OrgAdmin may not mint another OrgAdmin — the API 403s.
  const allowedByRank = user?.role === "PlatformAdmin" ? MEMBER_ROLES : MEMBER_ROLES.filter((r) => r !== "OrgAdmin");
  // EN-A: only offer roles this org's capability envelope allows. A PlatformAdmin
  // bypasses the envelope server-side, and a legacy (null) envelope is
  // unrestricted — both keep the full list. Only the three OPERATING roles are
  // gated; the rest (UseCaseAdmin/Trader/Buyer/…) are unaffected.
  const roleOptions = user?.role === "PlatformAdmin"
    ? allowedByRank
    : allowedByRank.filter((r) => !isOrgOperatingRole(r) || orgRoleEnabled(capabilities, r));
  const hiddenByEnvelope = allowedByRank.filter((r) => !roleOptions.includes(r));
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
        {hiddenByEnvelope.length > 0 && (
          <p className="col-span-2 text-xs text-slate-500">
            {hiddenByEnvelope.join(", ")} {hiddenByEnvelope.length === 1 ? "is" : "are"} not offered — this organization&rsquo;s capability envelope does not include {hiddenByEnvelope.length === 1 ? "that role" : "those roles"}.
          </p>
        )}
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
