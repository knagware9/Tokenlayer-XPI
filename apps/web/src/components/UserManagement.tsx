import { Fragment, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import { assignableRoles } from "../rbac.js";
import type { CredentialUseCase, IdentityResult, Role, UseCase } from "../types.js";
import type { DomainKey } from "../domains.js";
import { Pill } from "./ui.js";

type Summary = { id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null; active: boolean; kycStatus: "pending" | "approved" | "rejected"; kyc: { legalName?: string; country?: string; idType?: string; idNumber?: string; documentRef?: string } | null };
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
        <AddUser useCaseKey={useCaseKey} useCases={useCases} />
      ) : (
        <ManageUsers rows={rows} me={user?.email} onChanged={reload} />
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

function ManageUsers({ rows, me, onChanged }: { rows: Summary[]; me?: string; onChanged: () => void }): JSX.Element {
  const { token } = useAuth();
  const [editing, setEditing] = useState<Summary | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    setNotice(null);
    try { await fn(); onChanged(); } catch (err) { setError(err instanceof ApiError ? err.message : "Action failed"); }
  };
  const manageable = (u: Summary): boolean => u.email !== me && u.role !== "PlatformAdmin";

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500 bg-slate-50 uppercase tracking-wide"><tr><th className="text-left font-medium px-4 py-2.5">Email</th><th className="text-left font-medium px-4 py-2.5">Role</th><th className="text-left font-medium px-4 py-2.5">Use case</th><th className="text-left font-medium px-4 py-2.5">Status</th><th className="text-left font-medium px-4 py-2.5">KYC</th><th className="px-4 py-2.5 text-right font-medium">Actions</th></tr></thead>
          <tbody>
            {rows.map((u) => (
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
                    {manageable(u) ? (
                      <>
                        {u.kycStatus === "pending" && <button onClick={() => setVerifying((v) => (v === u.id ? null : u.id))} className="text-xs text-brand-600 hover:text-brand-700 font-medium">Verify identity (DID/VC)</button>}
                        <button onClick={() => setEditing(u)} className="text-xs text-brand-600 hover:text-brand-700">Edit</button>
                        <button onClick={() => act(() => api.updateUser(token!, u.id, { active: !u.active }))} className="text-xs text-amber-600 hover:text-amber-700">{u.active ? "Suspend" : "Reactivate"}</button>
                        {u.kycStatus !== "rejected" && (
                          <button onClick={() => { const reason = window.prompt("Reason for revoking this user's identity?")?.trim(); if (reason) void act(() => api.revokeUserIdentity(token!, u.id, reason).then(() => setNotice("Revoke proposal submitted — pending approval."))); }}
                            className="text-xs text-red-500 hover:text-red-700">Revoke identity</button>
                        )}
                        <button onClick={() => act(() => api.deleteUser(token!, u.id))} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                      </>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
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
