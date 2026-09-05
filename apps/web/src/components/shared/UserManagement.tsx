import { Fragment, useEffect, useMemo, useState } from "react";
import { API_BASE, ApiError, api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { assignableRoles, can } from "../../rbac.js";
import { activePersona } from "../../lib/shared/persona.js";
import { isExpiringOrExpired } from "../../lib/shared/kyc-expiry.js";
import type { CredentialUseCase, IdentityResult, Role, UseCase } from "../../types.js";
import type { DomainKey } from "../../domains.js";
import { Pill } from "./ui.js";
import { BatchCsv } from "./BatchCsv.js";

/** The roles PATCH /me/wallet and the auto-assignment work ever give a wallet
 *  to — mirrors apps/api/src/shared/wallets.ts's WALLET_ELIGIBLE_ROLES. Only
 *  these can meaningfully be allowlisted. */
const WALLET_ELIGIBLE_ROLES = new Set<Role>(["Buyer", "Trader", "Issuer"]);

type Summary = { id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null; active: boolean; kycStatus: "pending" | "approved" | "rejected"; kyc: {
    legalName?: string; country?: string; idType?: string; idNumber?: string; documentRef?: string;
    dateOfBirth?: string; address?: { street: string; city: string; postalCode: string }; occupation?: string; sourceOfFunds?: string; pepDeclaration?: boolean;
    idDocument?: { id: string; sha256: string } | null; addressDocument?: { id: string; sha256: string } | null;
    riskTier?: "low" | "medium" | "high" | null; expiresAt?: string | null; rejectionReason?: string | null;
  } | null; did: string | null };
type Sub = "add" | "manage";

export function UserManagement({ useCaseKey, useCases }: { useCaseKey: string; useCases: UseCase[] }): JSX.Element {
  const { token, user } = useAuth();
  const [sub, setSub] = useState<Sub>("manage");
  const [rows, setRows] = useState<Summary[]>([]);
  const reload = (): void => { if (token) void api.users(token).then(setRows); };
  useEffect(reload, [token]);

  return (
    <div>
      <div className="flex gap-1 mb-5">
        {(["add", "manage"] as Sub[]).map((s) => (
          <button
            key={s}
            onClick={() => setSub(s)}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-medium ${sub === s ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}
          >
            {s === "add" ? "Add User" : "Manage Users"}
          </button>
        ))}
      </div>
      {sub === "add" ? (
        <div className="space-y-4">
          <AddUser useCaseKey={useCaseKey} useCases={useCases} />
          <BatchOnboard />
        </div>
      ) : (
        <ManageUsers rows={rows} me={user?.email} useCases={useCases} onChanged={reload} />
      )}
    </div>
  );
}

function AddUser({ useCaseKey, useCases }: { useCaseKey: string; useCases: UseCase[] }): JSX.Element {
  const { token, user } = useAuth();
  const isPlatform = user?.role === "PlatformAdmin";
  // A PlatformAdmin picks from EVERY use case, across both domains — so credential
  // use cases must be loaded too (scoped managers are locked to their own).
  const [credUseCases, setCredUseCases] = useState<CredentialUseCase[]>([]);
  useEffect(() => {
    if (token && isPlatform) void api.credentialUseCases(token).then(setCredUseCases).catch(() => setCredUseCases([]));
  }, [token, isPlatform]);

  // The combined pick list: tokenization + credential use cases, each tagged with
  // the domain it belongs to (drives both the label and the assignable roles).
  const options = useMemo(
    () => [
      ...useCases.map((u) => ({ key: u.key, label: `${u.name} (Tokenization)`, domain: "tokenization" as DomainKey })),
      ...credUseCases.map((u) => ({ key: u.key, label: `${u.name} (Identity)`, domain: "identity" as DomainKey })),
    ],
    [useCases, credUseCases],
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [selUseCase, setSelUseCase] = useState(useCaseKey || useCases[0]?.key || "");
  // `credUseCases` — and so the identity half of `options` — loads async, after
  // this state's initializer already ran. On an identity-only deployment
  // `useCases` (tokenization) is empty, so `selUseCase` starts as "" and stays
  // that way until something re-syncs it: `options.find` below then matches
  // nothing and silently falls back to "tokenization", handing a PlatformAdmin
  // the wrong domain's roles (Issuer/Trader/Buyer/Auditor, missing Holder and
  // Verifier) — while the <select> itself LOOKS like it has the first identity
  // use case selected, because an uncontrolled-value select falls back to
  // rendering its first option. Re-sync once real options exist.
  useEffect(() => {
    if (!options.some((o) => o.key === selUseCase)) setSelUseCase(options[0]?.key ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);
  // The domain that gates the role menu. A scoped manager is locked to their own
  // use case's domain; a PlatformAdmin derives it from the currently-picked one.
  const pickedDomain: DomainKey = isPlatform
    ? (options.find((o) => o.key === selUseCase)?.domain ?? "tokenization")
    : (user?.useCaseDomain ?? "tokenization");
  const roleOptions = assignableRoles(user?.role ?? "Auditor", pickedDomain);
  const [role, setRole] = useState<Role>(roleOptions[0] ?? "Issuer");
  // Keep the selected role valid as the picked domain (hence the menu) changes.
  useEffect(() => {
    setRole((cur) => (roleOptions.includes(cur) ? cur : (roleOptions[0] ?? cur)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedDomain]);
  const [walletAddress, setWalletAddress] = useState("");
  const [legalName, setLegalName] = useState("");
  const [country, setCountry] = useState("");
  const [idType, setIdType] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [documentRef, setDocumentRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    try {
      const r = await api.createUser(token!, { email, password, role, useCaseKey: isPlatform ? selUseCase : undefined, walletAddress: walletAddress || undefined, kyc: legalName && country ? { legalName, country, idType, idNumber, documentRef } : undefined });
      setNotice(`Onboarding proposal submitted (${r.proposal.id.slice(0, 8)}…) — a second user-manager must approve it in Approvals.`);
      setEmail(""); setPassword(""); setWalletAddress("");
      setLegalName(""); setCountry(""); setIdType(""); setIdNumber(""); setDocumentRef("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Create failed");
    }
  }

  return (
    <form onSubmit={create} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4 max-w-2xl">
      <h2 className="font-semibold text-slate-900">{isPlatform ? "Onboard a user" : "Add a user to this use case"}</h2>
      <div className="grid grid-cols-2 gap-4">
        <input className="input" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" placeholder="password (min 6)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {isPlatform && (
          <select className="select" value={selUseCase} onChange={(e) => setSelUseCase(e.target.value)}>
            {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        )}
        <input className="input" placeholder="wallet address 0x… (optional)" value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} />
      </div>
      <div className="border-t border-slate-100 pt-3">
        <p className="text-xs font-semibold text-slate-500 mb-2">KYC / onboarding (reviewed before the user can transact)</p>
        <div className="grid grid-cols-2 gap-4">
          <input className="input" placeholder="legal name" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
          <input className="input" placeholder="country" value={country} onChange={(e) => setCountry(e.target.value)} />
          <input className="input" placeholder="ID type (e.g. Passport)" value={idType} onChange={(e) => setIdType(e.target.value)} />
          <input className="input" placeholder="ID number" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
          <input className="input col-span-2" placeholder="document reference (URL/ref)" value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} />
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}
      <button type="submit" className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700">Create user</button>
    </form>
  );
}

/** Collapsible CSV batch-onboarding panel, next to the single Add-User form. Rows
 * are onboarded through the same maker-checker path, one proposal per batch. */
function BatchOnboard(): JSX.Element {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-slate-200 text-slate-600 px-3.5 py-1.5 text-sm font-medium hover:bg-slate-50"
      >
        {open ? "Hide batch onboarding" : "Batch onboard (CSV)"}
      </button>
      {open && (
        <div className="mt-3 max-w-3xl">
          <BatchCsv
            title="Batch onboard users (CSV)"
            requiredHeaders={["email", "password", "role"]}
            optionalHeaders={["useCaseKey", "walletAddress"]}
            templateName="holders-template.csv"
            coerceRow={(row) => ({
              email: row.email,
              password: row.password,
              role: row.role,
              // Blank optional cells (parseCsv fills "") are dropped, not sent
              // as empty strings — the API treats the key as absent.
              ...(row.useCaseKey ? { useCaseKey: row.useCaseKey } : {}),
              ...(row.walletAddress ? { walletAddress: row.walletAddress } : {}),
            })}
            validateRow={(row) => {
              const email = String(row.email ?? "");
              const password = String(row.password ?? "");
              const role = String(row.role ?? "");
              if (!email.includes("@")) return "invalid email";
              if (password.length < 6) return "password must be at least 6 characters";
              if (!role) return "role is required";
              return null;
            }}
            onSubmit={(rows) => api.onboardUsersBatch(token!, rows).then((r) => ({ proposalId: r.proposal.id }))}
          />
        </div>
      )}
    </div>
  );
}

function ManageUsers({ rows, me, useCases, onChanged }: { rows: Summary[]; me?: string; useCases: UseCase[]; onChanged: () => void }): JSX.Element {
  const { token, user } = useAuth();
  const [editing, setEditing] = useState<Summary | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [reviewingKyc, setReviewingKyc] = useState<string | null>(null);
  const [issuingKyc, setIssuingKyc] = useState<string | null>(null);
  const [allowing, setAllowing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kycFilter, setKycFilter] = useState<"all" | "pending" | "expiring">("all");

  const filteredRows = rows.filter((u) => {
    if (kycFilter === "pending") return u.kycStatus === "pending";
    if (kycFilter === "expiring") return u.kycStatus === "approved" && isExpiringOrExpired(u.kyc?.expiresAt);
    return true;
  });

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    setNotice(null);
    try { await fn(); onChanged(); } catch (err) { setError(err instanceof ApiError ? err.message : "Action failed"); }
  };
  const manageable = (u: Summary): boolean => u.email !== me && u.role !== "PlatformAdmin";
  // Narrower than `manageable`: the server's canAdministerUser lets a PlatformAdmin
  // act on ANY row including another PlatformAdmin's (only suspend/edit/delete of a
  // peer admin stay UI-blocked) — issuing a DID/KYC credential is purely additive,
  // so it doesn't need that stricter guard. Self-targeting still stays excluded.
  const canIssueKycRow = (u: Summary): boolean => u.email !== me && !u.did;
  // /users/:id/identity (challenge+verify) and /users/:id/revoke-identity are
  // granted ONLY to the identity-issuer persona's edge (packages/core/src/shared/
  // personas.ts) — deliberately, so a tokenization edge never carries them. This
  // component is shared across every console, so without this check "Verify
  // identity (DID/VC)" and "Revoke identity" render as dead buttons on every
  // tokenization console: the request never reaches the API, nginx refuses it
  // outright (a CORS-preflight 404, surfacing to the user as a bare "Failed to
  // fetch"). `!persona` covers the combined/monolithic build, where every route
  // is reachable and this restriction does not apply.
  const persona = activePersona();
  const identityIssuerEdge = !persona || persona.key === "identity-issuer";
  const isPlatformAdmin = user?.role === "PlatformAdmin";

  // Allowlists a user's own wallet on every currently active asset in their
  // use case, in one click — the common case (a buyer should generally be
  // able to hold anything the use case offers). The per-asset fine-grained
  // control (allow/disallow on one specific asset) already exists on that
  // asset's own detail page; this is the discoverable, workflow-level door
  // for the case that actually blocks people: NOT_ALLOWLISTED on a fresh buy.
  const canAllowRow = (u: Summary): boolean =>
    manageable(u) && !!u.accountId && WALLET_ELIGIBLE_ROLES.has(u.role) && can(user?.role ?? "Auditor", "allow") &&
    (useCases.find((uc) => uc.key === u.useCaseKey)?.compliance.allowlist ?? false);

  const allowEverywhere = async (u: Summary): Promise<void> => {
    setError(null);
    setNotice(null);
    setAllowing(u.id);
    try {
      const accounts = await api.accounts(token!);
      const address = accounts.find((a) => a.id === u.accountId)?.address;
      if (!address) throw new Error("no wallet address found for this user");
      const assets = await api.assets(token!, u.useCaseKey ?? undefined);
      const active = assets.filter((a) => a.status === "active");
      let failed = 0;
      for (const asset of active) {
        try { await api.action(token!, asset.id, "allow", { account: address }); }
        catch { failed++; }
      }
      setNotice(
        failed === 0
          ? `Allowlisted ${u.email} on ${active.length} asset(s).`
          : `Allowlisted ${u.email} on ${active.length - failed}/${active.length} asset(s) — ${failed} failed.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Allow failed");
    } finally {
      setAllowing(null);
    }
  };

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}
      <div className="flex gap-1">
        {(["all", "pending", "expiring"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setKycFilter(f)}
            className={`px-3 py-1 rounded-lg text-xs font-medium ${kycFilter === f ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}
          >
            {f === "all" ? "All users" : f === "pending" ? "Pending KYC" : "KYC expiring/expired"}
          </button>
        ))}
      </div>
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500 bg-slate-50 uppercase tracking-wide"><tr><th className="text-left font-medium px-4 py-2.5">Email</th><th className="text-left font-medium px-4 py-2.5">Role</th><th className="text-left font-medium px-4 py-2.5">Use case</th><th className="text-left font-medium px-4 py-2.5">Status</th><th className="text-left font-medium px-4 py-2.5">KYC</th><th className="px-4 py-2.5 text-right font-medium">Actions</th></tr></thead>
          <tbody>
            {filteredRows.map((u) => (
              <Fragment key={u.id}>
                <tr className="border-t border-slate-100">
                  <td className="px-4 py-2">{u.email}</td>
                  <td className="px-4 py-2">{u.role}</td>
                  <td className="px-4 py-2 text-slate-500">{u.useCaseKey ?? "—"}</td>
                  <td className="px-4 py-2">
                    <Pill tone={u.active ? "ok" : "warn"}>{u.active ? "active" : "suspended"}</Pill>
                  </td>
                  <td className="px-4 py-2">
                    <span title={u.kyc?.legalName ? `${u.kyc.legalName}${u.kyc.country ? " · " + u.kyc.country : ""}` : ""}>
                      <Pill tone={u.kycStatus === "approved" ? "ok" : u.kycStatus === "rejected" ? "danger" : "warn"}>{u.kycStatus}</Pill>
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right space-x-3">
                    {identityIssuerEdge && manageable(u) && u.kycStatus === "pending" && <button onClick={() => setVerifying((v) => (v === u.id ? null : u.id))} className="text-xs text-brand-600 hover:text-brand-700 font-medium">Verify identity (DID/VC)</button>}
                    {isPlatformAdmin && manageable(u) && u.kycStatus === "pending" && <button onClick={() => setReviewingKyc((v) => (v === u.id ? null : u.id))} className="text-xs text-brand-600 hover:text-brand-700 font-medium">Review KYC</button>}
                    {canIssueKycRow(u) && <button onClick={() => setIssuingKyc((v) => (v === u.id ? null : u.id))} className="text-xs text-brand-600 hover:text-brand-700 font-medium">Issue KYC</button>}
                    {manageable(u) ? (
                      <>
                        {canAllowRow(u) && (
                          <button disabled={allowing === u.id} onClick={() => void allowEverywhere(u)} className="text-xs text-emerald-600 hover:text-emerald-700 font-medium disabled:opacity-40">
                            {allowing === u.id ? "Allowing…" : "Allow"}
                          </button>
                        )}
                        <button onClick={() => setEditing(u)} className="text-xs text-brand-600 hover:text-brand-700">Edit</button>
                        <button onClick={() => act(() => api.updateUser(token!, u.id, { active: !u.active }))} className="text-xs text-amber-600 hover:text-amber-700">{u.active ? "Suspend" : "Reactivate"}</button>
                        {identityIssuerEdge && u.kycStatus !== "rejected" && (
                          <button onClick={() => { const reason = window.prompt("Reason for revoking this user's identity?")?.trim(); if (reason) void act(() => api.revokeUserIdentity(token!, u.id, reason).then(() => setNotice("Revoke proposal submitted — pending approval."))); }}
                            className="text-xs text-red-500 hover:text-red-700">Revoke identity</button>
                        )}
                        <button onClick={() => act(() => api.deleteUser(token!, u.id))} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                      </>
                    ) : (
                      !canIssueKycRow(u) && <span className="text-xs text-slate-300">—</span>
                    )}
                  </td>
                </tr>
                {verifying === u.id && (
                  <tr className="border-t border-slate-100 bg-slate-50/60">
                    <td colSpan={6} className="px-4 py-3">
                      <VerifyIdentityPanel user={u} onClose={() => setVerifying(null)} onVerified={() => { setVerifying(null); onChanged(); }} />
                    </td>
                  </tr>
                )}
                {reviewingKyc === u.id && (
                  <tr className="border-t border-slate-100 bg-slate-50/60">
                    <td colSpan={6} className="px-4 py-3">
                      <KycReviewPanel user={u} onClose={() => setReviewingKyc(null)} onDecided={() => { setReviewingKyc(null); onChanged(); }} />
                    </td>
                  </tr>
                )}
                {issuingKyc === u.id && (
                  <tr className="border-t border-slate-100 bg-slate-50/60">
                    <td colSpan={6} className="px-4 py-3">
                      <IssueKycPanel user={u} onClose={() => setIssuingKyc(null)} onIssued={() => { setIssuingKyc(null); onChanged(); }} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <EditPasswordModal
          user={editing}
          onClose={() => setEditing(null)}
          onSave={async (pw) => { await act(() => api.updateUser(token!, editing.id, { password: pw })); setEditing(null); }}
        />
      )}
    </div>
  );
}

function VerifyIdentityPanel({ user, onClose, onVerified }: { user: Summary; onClose: () => void; onVerified: () => void }): JSX.Element {
  const { token } = useAuth();
  const [challenge, setChallenge] = useState<{ challenge: string; expiresAt: string } | null>(null);
  const [presentation, setPresentation] = useState("");
  const [result, setResult] = useState<IdentityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    api.identityChallenge(token!, user.id).then(setChallenge).catch((err) => {
      setError(err instanceof ApiError ? `${err.code ?? err.status}: ${err.message}` : "Failed to fetch challenge");
    });
  }, [token, user.id]);

  async function mintDemo(): Promise<void> {
    if (!challenge) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.identityMint(token!, { claims: { country: "IN", legalName: user.email }, challenge: challenge.challenge });
      setPresentation(r.presentation);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "dev minting disabled" : err instanceof ApiError ? `${err.code ?? err.status}: ${err.message}` : "Mint failed");
    } finally {
      setBusy(false);
    }
  }

  async function verify(): Promise<void> {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const r = await api.identityVerify(token!, user.id, presentation.trim());
      setResult(r);
      onVerified();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? err.status}: ${err.message}` : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Verify identity (DID/VC) · {user.email}</h3>
        <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
      </div>
      <p className="text-xs text-slate-500">
        {challenge ? (
          <>Challenge <span className="font-mono text-slate-700">{challenge.challenge.slice(0, 12)}…</span> · expires {new Date(challenge.expiresAt).toLocaleTimeString()}</>
        ) : (
          "Requesting challenge…"
        )}
      </p>
      <div>
        <label className="text-xs font-semibold text-slate-500 mb-1 block">Verifiable Presentation (VP-JWT)</label>
        <textarea
          className="input font-mono text-xs h-24 w-full resize-y"
          placeholder="Paste the investor's VP-JWT here"
          value={presentation}
          onChange={(e) => setPresentation(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => void mintDemo()}
          disabled={!challenge || busy}
          className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
        >
          Generate demo credential
        </button>
        <button
          onClick={() => void verify()}
          disabled={!presentation.trim() || busy}
          className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-xs font-medium hover:bg-brand-700 disabled:opacity-40"
        >
          Verify
        </button>
      </div>
      {result && (
        <p className="text-xs text-emerald-600 font-medium">
          Verified · country {String(result.claims.country ?? "—")} · issuer {result.issuer.slice(0, 16)}…
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** Platform Admin review of a self-submitted KYC (Task 3/6's My Profile flow):
 * shows the full field set plus both uploaded documents, and proposes an
 * approve/reject decision through Task 4's maker-checker endpoint — mirrors
 * VerifyIdentityPanel's inline-expand pattern above. */
function KycReviewPanel({ user, onClose, onDecided }: { user: Summary; onClose: () => void; onDecided: () => void }): JSX.Element {
  const { token } = useAuth();
  const [riskTier, setRiskTier] = useState<"low" | "medium" | "high">("low");
  const [rejectionReason, setRejectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approved" | "rejected"): Promise<void> {
    if (!token) return;
    if (decision === "rejected" && !rejectionReason.trim()) {
      setError("A rejection reason is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.proposeKycDecision(token, user.id, decision === "approved" ? { decision, riskTier } : { decision, rejectionReason: rejectionReason.trim() });
      onDecided();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not propose that decision");
    } finally {
      setBusy(false);
    }
  }

  const kyc = user.kyc;

  // A plain `<a href>` would not carry the Bearer token this codebase uses for
  // auth (there is no auth cookie), so the document read would 401. Fetch with
  // the token attached and open the result as a blob URL instead. `API_BASE`
  // (exported from api.ts) is the same versioned root every other call in this
  // file goes through — never hardcode `/api/v1` separately.
  async function openDocument(docId: string): Promise<void> {
    if (!token) return;
    // Opened SYNCHRONOUSLY, in the same tick as the click — a browser's popup
    // blocker allows window.open only while it can still see this as a direct
    // response to a user gesture, and that permission is gone by the time an
    // `await` resumes. Opening blank now and pointing it at the blob once the
    // fetch resolves keeps the tab inside the gesture instead of after it —
    // same pattern as CredentialSchemas.tsx's previewStored.
    const win = window.open("", "_blank");
    try {
      const res = await fetch(`${API_BASE}/users/me/kyc/documents/${docId}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) { win?.close(); setError("Could not load that document"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url; else window.open(url, "_blank");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      win?.close();
      setError("Could not load that document");
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Review KYC · {user.email}</h3>
        <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
        <div>Legal name: {kyc?.legalName ?? "—"}</div>
        <div>Country: {kyc?.country ?? "—"}</div>
        <div>ID: {kyc?.idType ?? "—"} {kyc?.idNumber ?? ""}</div>
        <div>Date of birth: {kyc?.dateOfBirth ?? "—"}</div>
        <div>Address: {kyc?.address ? `${kyc.address.street}, ${kyc.address.city} ${kyc.address.postalCode}` : "—"}</div>
        <div>Occupation: {kyc?.occupation ?? "—"}</div>
        <div>Source of funds: {kyc?.sourceOfFunds ?? "—"}</div>
        <div>PEP: {kyc?.pepDeclaration ? "Yes" : "No"}</div>
      </div>
      <div className="flex gap-3">
        {kyc?.idDocument && <button onClick={() => void openDocument(kyc.idDocument!.id)} className="text-xs text-brand-600 hover:text-brand-700 font-medium">View ID document ↗</button>}
        {kyc?.addressDocument && <button onClick={() => void openDocument(kyc.addressDocument!.id)} className="text-xs text-brand-600 hover:text-brand-700 font-medium">View address document ↗</button>}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex items-center gap-3 pt-2 border-t border-slate-100">
        <select className="rounded border border-slate-300 px-2 py-1 text-xs" value={riskTier} onChange={(e) => setRiskTier(e.target.value as "low" | "medium" | "high")}>
          <option value="low">Low risk</option>
          <option value="medium">Medium risk</option>
          <option value="high">High risk</option>
        </select>
        <button disabled={busy} onClick={() => void decide("approved")} className="text-xs rounded bg-emerald-600 text-white px-3 py-1.5 font-medium hover:bg-emerald-700 disabled:opacity-40">Propose approve</button>
        <input className="rounded border border-slate-300 px-2 py-1 text-xs flex-1" placeholder="Rejection reason" value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} />
        <button disabled={busy} onClick={() => void decide("rejected")} className="text-xs rounded border border-red-300 text-red-600 px-3 py-1.5 font-medium hover:bg-red-50 disabled:opacity-40">Propose reject</button>
      </div>
      <p className="text-[11px] text-slate-400">Proposing a decision requires a second Platform Admin to approve it in Approvals before it takes effect.</p>
    </div>
  );
}

/** Admin-issued counterpart of VerifyIdentityPanel: no presented credential
 * involved. Mints the user a DID (if they don't have one) and issues a
 * KycCredential directly — for the common case of a seeded operator/investor
 * with no organization onboarding, and no external credential to present. */
function IssueKycPanel({ user, onClose, onIssued }: { user: Summary; onClose: () => void; onIssued: () => void }): JSX.Element {
  const { token } = useAuth();
  const [legalName, setLegalName] = useState(user.kyc?.legalName ?? "");
  const [country, setCountry] = useState(user.kyc?.country ?? "");
  const [result, setResult] = useState<{ did: string; credentialId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function issue(): Promise<void> {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const r = await api.issueAdminKyc(token!, user.id, { legalName: legalName.trim(), country: country.trim().toUpperCase() });
      setResult(r);
      onIssued();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? err.status}: ${err.message}` : "Issuance failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Issue KYC directly · {user.email}</h3>
        <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
      </div>
      <p className="text-xs text-slate-500">
        Mints this user a decentralized identifier (if they don't already have one) and issues a KYC credential — no
        presented credential needed. Use this for a user with nothing external to present.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs font-semibold text-slate-500 mb-1 block">Legal name</span>
          <input className="input text-sm w-full" value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="e.g. Jane Doe" />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-slate-500 mb-1 block">Country (ISO 3166-1 alpha-2)</span>
          <input className="input text-sm w-full font-mono uppercase" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. IN" maxLength={2} />
        </label>
      </div>
      <button
        onClick={() => void issue()}
        disabled={!legalName.trim() || country.trim().length !== 2 || busy}
        className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-xs font-medium hover:bg-brand-700 disabled:opacity-40"
      >
        {busy ? "Issuing…" : "Issue KYC credential"}
      </button>
      {result && (
        <p className="text-xs text-emerald-600 font-medium">
          Issued · DID {result.did.slice(0, 16)}… · credential {result.credentialId.slice(0, 12)}…
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function EditPasswordModal({ user, onClose, onSave }: { user: Summary; onClose: () => void; onSave: (pw: string) => Promise<void> }): JSX.Element {
  const [pw, setPw] = useState("");
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-slate-900">Reset password</h3>
        <p className="text-xs text-slate-500">{user.email}</p>
        <input className="input" type="password" placeholder="new password (min 6)" value={pw} onChange={(e) => setPw(e.target.value)} />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm text-slate-500 px-3 py-1.5">Cancel</button>
          <button disabled={pw.length < 6} onClick={() => void onSave(pw)} className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-40">Save</button>
        </div>
      </div>
    </div>
  );
}
