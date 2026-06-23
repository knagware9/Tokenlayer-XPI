import { useEffect, useState } from "react";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import type { Role, UseCase } from "../types.js";

type Summary = { id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null; active: boolean };
type Sub = "add" | "manage";

const ROLE_OPTIONS: Record<string, Role[]> = {
  PlatformAdmin: ["UseCaseAdmin"],
  UseCaseAdmin: ["Issuer", "Trader", "Buyer", "Auditor"],
};

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
        <AddUser useCaseKey={useCaseKey} useCases={useCases} onAdded={() => { reload(); setSub("manage"); }} />
      ) : (
        <ManageUsers rows={rows} me={user?.email} onChanged={reload} />
      )}
    </div>
  );
}

function AddUser({ useCaseKey, useCases, onAdded }: { useCaseKey: string; useCases: UseCase[]; onAdded: () => void }): JSX.Element {
  const { token, user } = useAuth();
  const isPlatform = user?.role === "PlatformAdmin";
  const roleOptions = ROLE_OPTIONS[user?.role ?? ""] ?? [];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>(roleOptions[0] ?? "Issuer");
  const [selUseCase, setSelUseCase] = useState(useCaseKey || useCases[0]?.key || "");
  const [walletAddress, setWalletAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsWallet = role === "Buyer" || role === "Trader";

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    try {
      await api.createUser(token!, { email, password, role, useCaseKey: isPlatform ? selUseCase : undefined, walletAddress: needsWallet ? walletAddress : undefined });
      setEmail(""); setPassword(""); setWalletAddress("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Create failed");
    }
  }

  return (
    <form onSubmit={create} className="bg-white rounded-xl border border-slate-200 p-6 space-y-4 max-w-2xl">
      <h2 className="font-semibold text-slate-900">{isPlatform ? "Create a Use-Case Admin" : "Add a user to this use case"}</h2>
      <div className="grid grid-cols-2 gap-4">
        <input className="input" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" placeholder="password (min 6)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {isPlatform && (
          <select className="select" value={selUseCase} onChange={(e) => setSelUseCase(e.target.value)}>
            {useCases.map((u) => <option key={u.key} value={u.key}>{u.name}</option>)}
          </select>
        )}
        {needsWallet && <input className="input" placeholder="wallet address 0x…" value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} />}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700">Create user</button>
    </form>
  );
}

function ManageUsers({ rows, me, onChanged }: { rows: Summary[]; me?: string; onChanged: () => void }): JSX.Element {
  const { token } = useAuth();
  const [editing, setEditing] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try { await fn(); onChanged(); } catch (err) { setError(err instanceof ApiError ? err.message : "Action failed"); }
  };
  const manageable = (u: Summary): boolean => u.email !== me && u.role !== "PlatformAdmin";

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500 bg-slate-50"><tr><th className="text-left px-4 py-2">Email</th><th className="text-left px-4 py-2">Role</th><th className="text-left px-4 py-2">Use case</th><th className="text-left px-4 py-2">Status</th><th className="px-4 py-2 text-right">Actions</th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2">{u.role}</td>
                <td className="px-4 py-2 text-slate-500">{u.useCaseKey ?? "—"}</td>
                <td className="px-4 py-2">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${u.active ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{u.active ? "active" : "suspended"}</span>
                </td>
                <td className="px-4 py-2 text-right space-x-3">
                  {manageable(u) ? (
                    <>
                      <button onClick={() => setEditing(u)} className="text-xs text-brand-600 hover:text-brand-700">Edit</button>
                      <button onClick={() => act(() => api.updateUser(token!, u.id, { active: !u.active }))} className="text-xs text-amber-600 hover:text-amber-700">{u.active ? "Revoke" : "Reactivate"}</button>
                      <button onClick={() => act(() => api.deleteUser(token!, u.id))} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                    </>
                  ) : (
                    <span className="text-xs text-slate-300">—</span>
                  )}
                </td>
              </tr>
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
