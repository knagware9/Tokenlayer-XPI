import { useEffect, useState } from "react";
import { API_BASE, ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import { isOrgOperatingRole, orgRoleEnabled } from "../lib/capabilities.js";
import { API_SCOPES, type ApiKeyView, type ApiScope, type OrgCapabilities, type Organization, type Role } from "../types.js";
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
    api.orgs(token)
      .then((rows) => { setOrgs(rows); setOrgId((cur) => cur ?? user?.orgId ?? rows[0]?.id ?? null); })
      .catch((err) => setError(errMessage(err, "Failed to load organizations")));
  }, [token, user?.orgId]);

  const reload = (): void => {
    if (!token || !orgId) { setKeys([]); return; }
    setError(null);
    api.listApiKeys(token, orgId)
      .then(setKeys)
      .catch((err) => setError(errMessage(err, "Failed to load API keys")));
  };
  useEffect(reload, [token, orgId]);

  const org = orgs.find((o) => o.id === orgId) ?? null;

  async function rotate(k: ApiKeyView): Promise<void> {
    if (!token || !orgId) return;
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
          orgId ? (
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
                      {k.status !== "revoked" && (
                        <>
                          <button
                            onClick={() => void rotate(k)}
                            disabled={busyId === k.id}
                            className="text-xs rounded border border-slate-300 text-slate-600 px-2.5 py-1 font-medium hover:bg-slate-50 disabled:opacity-40"
                          >
                            Rotate
                          </button>
                          <button
                            onClick={() => void revoke(k)}
                            disabled={busyId === k.id}
                            className="text-xs rounded border border-red-200 text-red-600 px-2.5 py-1 font-medium hover:bg-red-50 disabled:opacity-40"
                          >
                            Revoke
                          </button>
                        </>
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

  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>(roleOptions[0] ?? "Issuer");
  const [useCaseKey, setUseCaseKey] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [expiry, setExpiry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleScope(s: ApiScope): void {
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    if (scopes.length === 0) { setError("Select at least one scope — a key with none can do nothing"); return; }
    setBusy(true);
    try {
      // A date input yields a plain day; the API wants a future instant, so the
      // key lives to the end of the chosen day (UTC).
      const expiresAt = expiry ? `${expiry}T23:59:59.999Z` : undefined;
      const res = await api.createApiKey(token!, orgId, {
        name: name.trim(),
        role,
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
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
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
        <p className="text-xs text-slate-500 mb-2">
          A scope only ever narrows the role above — ticking one never grants authority the role does not already have.
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
      <p className="text-xs text-slate-500 mt-3">
        A key is refused a 401 if it is unknown, revoked or expired, a 403 <span className="font-mono">INSUFFICIENT_SCOPE</span> if
        the call needs a scope it was not granted, and a 429 if it exceeds its rate limit.
      </p>
    </Card>
  );
}
