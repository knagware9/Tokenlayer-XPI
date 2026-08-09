import { useEffect, useRef, useState } from "react";
import { API_BASE, ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import { isOrgOperatingRole, orgRoleEnabled } from "../lib/capabilities.js";
import { setNavGuard } from "../lib/nav-guard.js";
import { API_SCOPES, type ApiKeyView, type ApiScope, type OrgCapabilities, type Organization, type Role } from "../types.js";
import { Webhooks } from "./Webhooks.js";
import { Card, EmptyState, Pill, SectionHeader } from "./ui.js";

/** The public marker every secret carries — mirrors the API's KEY_PREFIX_MARKER. */
const KEY_MARKER = "tl_live_";

/**
 * Roles a key's bound service user may take. Mirrors the server's
 * `canCreateOrgMember`: never PlatformAdmin (that rule is what stops a key from
 * bootstrapping its way above the org tier), and OrgAdmin only for a
 * PlatformAdmin creator. The three OPERATING roles are additionally gated by the
 * org's EN-A envelope below — exactly as the member form gates them.
 */
const KEY_ROLES: Role[] = ["OrgAdmin", "UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor", "Holder", "Verifier"];

/**
 * One plain line per scope, for the integrator choosing them. Typed as a total
 * record over `ApiScope`, so adding a scope to the mirrored vocabulary in
 * types.ts without describing it here fails the build rather than shipping a
 * blank checkbox.
 */
const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "credentials:read": "Read issued credentials and their status.",
  "credentials:issue": "Issue new credentials to holders.",
  "credentials:revoke": "Revoke credentials this organization issued.",
  "verifications:read": "Read verification requests and their outcomes.",
  "verifications:request": "Ask a holder to present credentials.",
  "verifications:verify": "Run a verification and read its result.",
  "assets:read": "Read tokenized assets, holders and balances.",
  "assets:issue": "Tokenize new assets (mint on-chain).",
  "assets:transfer": "Move tokens between accounts.",
  "users:read": "List the users this key's role can see.",
  "users:onboard": "Onboard and manage users — new members get a DID.",
  "org:read": "Read the organization's profile and its member list.",
  "usecases:provision": "Create, update, deploy and provision use cases and templates.",
};

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Timestamps are ISO strings from the API; an unparseable one shows as "—". */
function fmt(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleString();
}

function statusTone(status: ApiKeyView["status"]): "ok" | "warn" | "danger" {
  return status === "active" ? "ok" : status === "expired" ? "warn" : "danger";
}

/**
 * Rotation is only ever meaningful for an ACTIVE key.
 *
 * The server refuses rotation on `revokedAt !== null` alone, and rotation writes
 * only `prefix` + `secretHash` — `expiresAt` is left exactly as it was. So
 * rotating an EXPIRED key succeeds, walks the operator through the irreversible
 * one-time-secret ceremony, and hands back a secret that is already past its
 * expiry and 401s on its first call. The row still reads `expired` afterwards.
 * The cure for an expired key is a NEW key, not a rotation of the dead one.
 */
export function canRotate(status: ApiKeyView["status"]): boolean {
  return status === "active";
}

/**
 * The Developers surface: an organization's machine credentials.
 *
 * SECRET HYGIENE — the one invariant this file exists to hold. A secret is
 * returned exactly once, by create and by rotate. It is held in the `revealed`
 * state below and NOWHERE ELSE: not localStorage, not sessionStorage, not the
 * URL, not a query param, not a ref that outlives the panel. This component
 * unmounts whenever the console navigates away (App.tsx renders one panel at a
 * time), so navigating is itself a discard. Nothing reads a secret back — no
 * list route returns one — so a dismissed secret is gone for good, which is
 * precisely what the acknowledgement checkbox is warning about.
 *
 * Because navigating IS a discard, every exit is confirmed while a secret is
 * unacknowledged: the Done button needs the checkbox, and the sidebar and the
 * browser's own reload/close are gated by the effect below. The discard is
 * always a decision, never a side effect of a stray click.
 */
export function Developers(): JSX.Element {
  const { token, user } = useAuth();
  const isPlatform = user?.role === "PlatformAdmin";
  const [orgs, setOrgs] = useState<Organization[]>([]);
  // `GET /orgs` already scopes itself: an OrgAdmin gets exactly their own org,
  // so the picker below only ever appears for a PlatformAdmin.
  const [orgId, setOrgId] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // `seq` only exists to key the panel below: a second reveal (rotate while an
  // earlier panel is still open) must mount a FRESH panel, or it would inherit
  // the previous one's ticked acknowledgement and be dismissable in one click.
  const [revealed, setRevealed] = useState<{ name: string; secret: string; rotated: boolean; seq: number } | null>(null);
  const reveal = (name: string, secret: string, rotated: boolean): void =>
    setRevealed((cur) => ({ name, secret, rotated, seq: (cur?.seq ?? 0) + 1 }));

  useEffect(() => {
    if (!token) return;
    let live = true;
    api.orgs(token)
      .then((rows) => { if (!live) return; setOrgs(rows); setOrgId((cur) => cur ?? user?.orgId ?? rows[0]?.id ?? null); })
      .catch((err) => { if (live) setError(errMessage(err, "Failed to load organizations")); });
    return () => { live = false; };
  }, [token, user?.orgId]);

  /**
   * Every key load is generation-guarded. A PlatformAdmin can switch from org A
   * to org B while A's list is still in flight; without this, A's response would
   * land after B's and paint A's keys under B's heading — a wrong answer that
   * looks exactly like a right one. The counter (rather than a per-effect `live`
   * flag) is what also invalidates the IMPERATIVE reloads fired after rotate,
   * revoke and create, which are not tied to any effect's lifetime.
   */
  const loadGen = useRef(0);
  const reload = (): void => {
    const gen = ++loadGen.current;
    if (!token || !orgId) { setKeys([]); return; }
    setError(null);
    api.listApiKeys(token, orgId)
      .then((rows) => { if (loadGen.current === gen) setKeys(rows); })
      .catch((err) => { if (loadGen.current === gen) setError(errMessage(err, "Failed to load API keys")); });
  };
  // The cleanup bumps the generation, so anything still in flight for the org we
  // are leaving is discarded rather than applied.
  useEffect(() => { reload(); return () => { loadGen.current++; }; }, [token, orgId]);

  const org = orgs.find((o) => o.id === orgId) ?? null;

  /**
   * The secret lives in `revealed` and NOWHERE else, so unmounting this panel
   * destroys it. Guard both ways out while one is unacknowledged: the console's
   * own sidebar (via the shared nav guard, which App.tsx consults before swapping
   * panels) and the browser's reload/close (via `beforeunload`). The Done button
   * already required an acknowledgement; these are the paths that did not.
   */
  useEffect(() => {
    if (!revealed) return;
    const warn = (): boolean => window.confirm(
      "You have not acknowledged the new API key secret. It is shown only once and cannot be retrieved — leaving this page loses it for good. Leave anyway?",
    );
    const release = setNavGuard(warn);
    const onBeforeUnload = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => { release(); window.removeEventListener("beforeunload", onBeforeUnload); };
  }, [revealed]);

  async function rotate(k: ApiKeyView): Promise<void> {
    if (!token || !orgId) return;
    // Belt and braces for the render gate below: a row can be stale by the time
    // it is clicked, and rotating anything but an active key produces a secret
    // that is dead on arrival (see the Rotate button's comment).
    if (!canRotate(k.status)) { setError(`"${k.name}" is ${k.status} — rotating it would mint a secret that cannot be used. Create a new key instead.`); return; }
    if (!window.confirm(`Rotate "${k.name}"? The current secret stops working immediately — anything still using it will start failing.`)) return;
    setBusyId(k.id); setError(null);
    try {
      const res = await api.rotateApiKey(token, orgId, k.id);
      reveal(res.key.name, res.secret, true);
      setCreating(false);
      reload();
    } catch (err) {
      setError(errMessage(err, "Rotate failed"));
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(k: ApiKeyView): Promise<void> {
    if (!token || !orgId) return;
    if (!window.confirm(`Revoke "${k.name}"? This cannot be undone; the key stops working immediately.`)) return;
    setBusyId(k.id); setError(null);
    try {
      await api.revokeApiKey(token, orgId, k.id);
      reload();
    } catch (err) {
      setError(errMessage(err, "Revoke failed"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Developers"
        description="API keys let a system call TokenLayer without a person signing in. A key acts as a service account with a role, and its scopes can only narrow what that role may already do."
        actions={
          // Gated on the RESOLVED org, not just its id: the create form needs the
          // org's capability envelope to filter the role list, so it renders on
          // `org` below. Offering the button on `orgId` alone made it a silent
          // no-op whenever the id is not in the visible list.
          org ? (
            <button
              onClick={() => { setCreating((v) => !v); setError(null); }}
              className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
            >
              {creating ? "Close" : "Create API key"}
            </button>
          ) : undefined
        }
      />

      {isPlatform && orgs.length > 1 && (
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Organization</label>
          <select
            className="select max-w-xs"
            value={orgId ?? ""}
            onChange={(e) => { setOrgId(e.target.value || null); setCreating(false); }}
          >
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {orgId && !org && (
        <p className="text-sm text-slate-500">
          Existing keys for this organization are listed below, but a new one cannot be created here — this account&rsquo;s
          organization is not in the list you can see, so its capability envelope (which decides the roles a key may take) is
          unavailable.
        </p>
      )}

      {revealed && (
        <SecretPanel
          key={revealed.seq}
          name={revealed.name}
          secret={revealed.secret}
          rotated={revealed.rotated}
          onDismiss={() => setRevealed(null)}
        />
      )}

      {creating && org && (
        <CreateKey
          orgId={org.id}
          capabilities={org.capabilities ?? null}
          onCreated={(name, secret) => { reveal(name, secret, false); setCreating(false); reload(); }}
        />
      )}

      {!orgId ? (
        <Card>
          <EmptyState icon="code" title="No organization" hint="Your account is not linked to an organization, so there is nothing to issue keys for." />
        </Card>
      ) : keys.length === 0 ? (
        <Card>
          <EmptyState icon="code" title="No API keys yet" hint="Create one to let a system integrate with this organization." />
        </Card>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500 bg-slate-50 uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Name</th>
                <th className="text-left font-medium px-4 py-2.5">Key</th>
                <th className="text-left font-medium px-4 py-2.5">Scopes</th>
                <th className="text-left font-medium px-4 py-2.5">Role</th>
                <th className="text-left font-medium px-4 py-2.5">Last used</th>
                <th className="text-left font-medium px-4 py-2.5">Expires</th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
                <th className="text-right font-medium px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-slate-100 align-top">
                  <td className="px-4 py-2 font-medium text-slate-800">{k.name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">{KEY_MARKER}{k.prefix}…</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.length === 0
                        ? <Pill tone="muted">no scopes</Pill>
                        : k.scopes.map((s) => <Pill key={s} tone="info">{s}</Pill>)}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-slate-600">
                    {k.role ?? "—"}
                    {k.useCaseKey && <span className="block text-xs text-slate-400">{k.useCaseKey}</span>}
                  </td>
                  <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{fmt(k.lastUsedAt)}</td>
                  <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{k.expiresAt ? fmt(k.expiresAt) : "never"}</td>
                  <td className="px-4 py-2"><Pill tone={statusTone(k.status)}>{k.status}</Pill></td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      {/*
                        Rotate is offered for ACTIVE keys only. Rotation replaces
                        the prefix and the hash and leaves `expiresAt` untouched,
                        so rotating an EXPIRED key mints a secret that is already
                        past its expiry — the operator would be walked through the
                        one-time-secret ceremony for a credential that 401s on its
                        very first call. An expired key is replaced by creating a
                        new one, not by rotating the dead one. Revoke stays
                        available for anything not already revoked.
                      */}
                      {canRotate(k.status) && (
                        <button
                          onClick={() => void rotate(k)}
                          disabled={busyId === k.id}
                          className="text-xs rounded border border-slate-300 text-slate-600 px-2.5 py-1 font-medium hover:bg-slate-50 disabled:opacity-40"
                        >
                          Rotate
                        </button>
                      )}
                      {k.status !== "revoked" && (
                        <button
                          onClick={() => void revoke(k)}
                          disabled={busyId === k.id}
                          className="text-xs rounded border border-red-200 text-red-600 px-2.5 py-1 font-medium hover:bg-red-50 disabled:opacity-40"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <UsingYourKey />

      {/*
        EN-C webhooks live HERE rather than behind their own nav entry.
        Integration is one job — keys and delivery destinations are configured
        by the same person in the same sitting — and a new nav item would need a
        domain classification, which is what made an ID-N surface vanish for the
        orgs that lacked that domain, taking the only control that could fix it
        with it. This page is already gated to PlatformAdmin and OrgAdmin, which
        is exactly who may manage webhooks.
      */}
      <div className="pt-2 border-t border-slate-200/70">
        <Webhooks orgId={orgId} org={org} />
      </div>
    </div>
  );
}

/**
 * The one-time secret. Shown after create and after rotate, and dismissible only
 * once the operator has ticked the acknowledgement — there is no way to see it
 * again, so an accidental click must not be able to lose it.
 */
function SecretPanel({ name, secret, rotated, onDismiss }: {
  name: string;
  secret: string;
  rotated: boolean;
  onDismiss: () => void;
}): JSX.Element {
  const [acked, setAcked] = useState(false);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied("ok");
    } catch {
      // Insecure origin or a denied permission — say so rather than pretending.
      setCopied("fail");
    }
  }

  return (
    <div className="bg-white rounded-2xl border-2 border-amber-300 shadow-sm">
      <div className="px-5 pt-4 pb-3 border-b border-amber-100">
        <h3 className="text-sm font-semibold text-slate-900">
          {rotated ? "New secret for" : "Your new API key"} <span className="font-mono">{name}</span>
        </h3>
        <p className="text-xs text-amber-700 mt-1 font-medium">
          This is the only time you will see this secret. It is not stored anywhere you can read it back — if you lose it,
          rotate the key to mint a new one.
          {rotated && " The previous secret stopped working the moment this one was created."}
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Leaving this page — a sidebar click, a reload, closing the tab — discards it. You will be asked to confirm first.
        </p>
      </div>
      <div className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 break-all rounded-lg bg-slate-900 text-slate-100 font-mono text-xs px-3 py-2.5">{secret}</code>
          <button
            onClick={() => void copy()}
            className="shrink-0 rounded-lg border border-slate-300 text-slate-600 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
          >
            {copied === "ok" ? "Copied" : "Copy"}
          </button>
        </div>
        {copied === "fail" && <p className="text-xs text-red-600">Could not reach the clipboard — select the secret above and copy it manually.</p>}
        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={acked}
            onChange={(e) => setAcked(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          I have stored this secret somewhere safe.
        </label>
        <button
          onClick={onDismiss}
          disabled={!acked}
          className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
        >
          Done — hide the secret
        </button>
      </div>
    </div>
  );
}

/** What the create form has collected so far. `role: ""` means "not chosen yet". */
export interface KeyDraft {
  name: string;
  role: Role | "";
  scopes: readonly ApiScope[];
}

/**
 * The starting draft — deliberately carrying NO role.
 *
 * `KEY_ROLES` is ordered most→least privileged, so seeding this with the first
 * offered role (as this form used to) meant an operator who typed a name, ticked
 * a scope and submitted without ever opening the select minted an OrgAdmin
 * machine credential. Scopes clamp what the KEY may call, but the bound service
 * principal is a full org member either way — with `users:onboard` it can create
 * further members — so the untouched default decided real authority. A
 * credential-minting form gets no privileged default, and rather than assert a
 * total privilege order over the remaining roles (which `KEY_ROLES` only loosely
 * implies) the choice is simply required.
 */
export const EMPTY_KEY_DRAFT: KeyDraft = { name: "", role: "", scopes: [] };

/**
 * Everything the draft must satisfy before it is worth sending.
 *
 * The role arm is what makes `EMPTY_KEY_DRAFT`'s missing role ENFORCED rather
 * than merely intended: without it, an untouched select would sail through. The
 * result is a discriminated union rather than a message-or-null so that the `ok`
 * arm carries a narrowed `Role` — the caller cannot post the draft without
 * having passed this check.
 */
export type KeyDraftCheck = { ok: true; role: Role } | { ok: false; message: string };

export function checkKeyDraft(draft: KeyDraft): KeyDraftCheck {
  if (!draft.name.trim()) return { ok: false, message: "Name is required" };
  if (!draft.role) {
    return {
      ok: false,
      message: "Choose the role this key acts as — there is no default, because that choice decides what the key's service account may do",
    };
  }
  if (draft.scopes.length === 0) return { ok: false, message: "Select at least one scope — a key with none can do nothing" };
  return { ok: true, role: draft.role };
}

/**
 * Mint a key. The role list is filtered by the org's EN-A capability envelope
 * exactly as the member form is (same helpers, same PlatformAdmin bypass, same
 * "why is that missing?" note), because the key's bound principal IS an org
 * member: a key can never be a role its creator could not have hired.
 */
function CreateKey({ orgId, capabilities, onCreated }: {
  orgId: string;
  capabilities: OrgCapabilities | null;
  onCreated: (name: string, secret: string) => void;
}): JSX.Element {
  const { token, user } = useAuth();
  // An OrgAdmin may not mint another OrgAdmin — the API 403s.
  const allowedByRank = user?.role === "PlatformAdmin" ? KEY_ROLES : KEY_ROLES.filter((r) => r !== "OrgAdmin");
  // EN-A: only offer roles this org's envelope allows. A PlatformAdmin bypasses
  // the envelope server-side, and a legacy (null) envelope is unrestricted —
  // both keep the full list. Only the three OPERATING roles are gated.
  const roleOptions = user?.role === "PlatformAdmin"
    ? allowedByRank
    : allowedByRank.filter((r) => !isOrgOperatingRole(r) || orgRoleEnabled(capabilities, r));
  const hiddenByEnvelope = allowedByRank.filter((r) => !roleOptions.includes(r));

  const [name, setName] = useState(EMPTY_KEY_DRAFT.name);
  // No default role — see EMPTY_KEY_DRAFT above for why.
  const [role, setRole] = useState<Role | "">(EMPTY_KEY_DRAFT.role);
  const [useCaseKey, setUseCaseKey] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>([...EMPTY_KEY_DRAFT.scopes]);
  const [expiry, setExpiry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleScope(s: ApiScope): void {
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const check = checkKeyDraft({ name, role, scopes });
    if (!check.ok) { setError(check.message); return; }
    setBusy(true);
    try {
      // A date input yields a plain day; the API wants a future instant, so the
      // key lives to the end of the chosen day (UTC).
      const expiresAt = expiry ? `${expiry}T23:59:59.999Z` : undefined;
      const res = await api.createApiKey(token!, orgId, {
        name: name.trim(),
        // From the check, not from state: the narrowed `Role` only exists on the
        // ok arm, so an unchosen role cannot reach the wire.
        role: check.role,
        useCaseKey: useCaseKey.trim() || undefined,
        scopes,
        expiresAt,
      });
      // Hand the secret straight to the panel and keep NO copy here: this form
      // is about to be unmounted, and the secret must not outlive the handoff.
      onCreated(res.key.name, res.secret);
    } catch (err) {
      setError(errMessage(err, "Could not create the key"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4">
      <h2 className="font-semibold text-slate-900">Create an API key</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Name</label>
          <input className="input" placeholder="e.g. ERP invoice sync" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Acts as role</label>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role | "")}>
            <option value="">Choose a role…</option>
            {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Use case (optional)</label>
          <input className="input" placeholder="use-case key" value={useCaseKey} onChange={(e) => setUseCaseKey(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Expires (optional)</label>
          {/* `min` is a courtesy only — the API rejects a past expiry with 400 INVALID_EXPIRY. */}
          <input className="input" type="date" min={new Date().toISOString().slice(0, 10)} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </div>
      </div>

      {hiddenByEnvelope.length > 0 && (
        <p className="text-xs text-slate-500">
          {hiddenByEnvelope.join(", ")} {hiddenByEnvelope.length === 1 ? "is" : "are"} not offered — this organization&rsquo;s
          capability envelope does not include {hiddenByEnvelope.length === 1 ? "that role" : "those roles"}.
        </p>
      )}

      <fieldset>
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Scopes</legend>
        {/*
          These checkboxes are DELIBERATELY not filtered by the role above.

          Filtering would need a role→scope map, and the server has no such map to
          mirror: authorization is `roleAllows && envelopeAllows && scopeAllows`,
          where the role half is decided per ROUTE by half a dozen unrelated gates
          (core's rbac MATRIX, canManageUsers/canCreateUser/canCreateOrgMember,
          orgScoped, verifierScoped, resolveIssuer, holder-DID equality) rather
          than by anything scope-shaped. It is not derivable from rbac.ts either:
          that matrix has OrgAdmin as read-only, yet an OrgAdmin key really can
          issue credentials, onboard members and provision use cases via routes
          gated on org ownership instead of the matrix. Three scopes are also
          reachable by EVERY role through an unguarded /me/… route while meaning
          almost nothing there — greying `assets:read` "in" for a Holder would be
          truer to the code and more misleading to the reader than saying nothing.
          A wrong map is worse than no map, so the honest warning below stands in
          for one until the server exposes the effective set itself.
        */}
        <p className="text-xs text-slate-500 mb-2">
          A scope only ever narrows the role above — ticking one never grants authority the role does not already have. This
          console does not check the two against each other, and neither does the create call: a combination the role cannot
          exercise (say <span className="font-mono">Auditor</span> with <span className="font-mono">assets:issue</span>) is
          accepted here and then refused with a <span className="font-mono">403</span> at every call. Choose the role first, and
          tick only what that role is meant to do.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
          {API_SCOPES.map((s) => (
            <label key={s} className="flex items-start gap-2 py-1 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={scopes.includes(s)}
                onChange={() => toggleScope(s)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="min-w-0">
                <span className="font-mono text-xs text-slate-800">{s}</span>
                <span className="block text-xs text-slate-500">{SCOPE_DESCRIPTIONS[s]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40">
        Create key
      </button>
    </form>
  );
}

/** How to actually use a key: a real endpoint, a real header, copy-pasteable. */
function UsingYourKey(): JSX.Element {
  const snippet = [
    "# Check the key and see the principal it authenticates as",
    `curl -H "Authorization: Bearer ${KEY_MARKER}your-secret-here" \\`,
    `  ${API_BASE}/me`,
    "",
    "# A real call — list this organization's assets (needs the assets:read scope)",
    `curl -H "Authorization: Bearer ${KEY_MARKER}your-secret-here" \\`,
    `  ${API_BASE}/assets`,
  ].join("\n");
  return (
    <Card title="Using your key" description="Send the secret as a bearer token. No cookie, no login, no expiry to refresh.">
      <pre className="overflow-x-auto rounded-lg bg-slate-900 text-slate-100 font-mono text-xs p-4 leading-5">{snippet}</pre>
      <div className="text-xs text-slate-500 mt-3 space-y-1.5">
        <p>
          A key is refused a <span className="font-mono">401</span> if it is unknown, revoked or expired, and a
          {" "}<span className="font-mono">403 INSUFFICIENT_SCOPE</span> if the call needs a scope it was not granted. A
          {" "}<span className="font-mono">403</span> can also come from the key&rsquo;s role or from this organization&rsquo;s
          capability envelope — those checks run whatever the scopes say, because a scope only narrows.
        </p>
        <p>
          <span className="font-mono">403 ORG_CAPABILITY_MISSING</span> means the organization&rsquo;s capability envelope no
          longer includes what the call needs. A key that worked yesterday can start failing this way without anything about the
          key changing — ask an administrator to widen the envelope, or point the integration at a capability the organization
          still has.
        </p>
        <p>
          <span className="font-mono">429 RATE_LIMITED</span> means the key exceeded its request budget: by default
          {" "}<strong>600 requests per key per 60-second window</strong>, counted per API instance and only for requests whose
          secret actually verified. The response carries a <span className="font-mono">Retry-After</span> header with the whole
          number of seconds until the window resets — wait that long before retrying rather than retrying immediately.
        </p>
      </div>
    </Card>
  );
}
