import { useEffect, useState } from "react";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import type { Role, UseCase } from "../types.js";

type Summary = { id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null };

const ROLE_OPTIONS: Record<string, Role[]> = {
  PlatformAdmin: ["UseCaseAdmin"],
  UseCaseAdmin: ["Issuer", "Trader", "Buyer", "Auditor"],
};

export function UsersAdmin({ useCases }: { useCases: UseCase[] }): JSX.Element {
  const { token, user } = useAuth();
  const [rows, setRows] = useState<Summary[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const roleOptions = ROLE_OPTIONS[user?.role ?? ""] ?? [];
  const [role, setRole] = useState<Role>(roleOptions[0] ?? "Issuer");
  const [useCaseKey, setUseCaseKey] = useState(useCases[0]?.key ?? "");
  const [walletAddress, setWalletAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = (): void => { if (token) void api.users(token).then(setRows); };
  useEffect(reload, [token]);

  const isPlatform = user?.role === "PlatformAdmin";
  const needsWallet = role === "Buyer" || role === "Trader";

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await api.createUser(token!, { email, password, role, useCaseKey: isPlatform ? useCaseKey : undefined, walletAddress: needsWallet ? walletAddress : undefined });
      setEmail(""); setPassword(""); setWalletAddress("");
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Create failed");
    }
  }

  async function remove(id: string): Promise<void> {
    await api.deleteUser(token!, id);
    reload();
  }

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="bg-white rounded-xl border border-slate-200 p-6 space-y-4 max-w-2xl">
        <h2 className="font-semibold text-slate-900">{isPlatform ? "Create a Use-Case Admin" : "Add a user to this use case"}</h2>
        <div className="grid grid-cols-2 gap-4">
          <input className="input" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" type="password" placeholder="password (min 6)" value={password} onChange={(e) => setPassword(e.target.value)} />
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {isPlatform && (
            <select className="select" value={useCaseKey} onChange={(e) => setUseCaseKey(e.target.value)}>
              {useCases.map((u) => <option key={u.key} value={u.key}>{u.name}</option>)}
            </select>
          )}
          {needsWallet && <input className="input" placeholder="wallet address 0x…" value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} />}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700">Create user</button>
      </form>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500 bg-slate-50"><tr><th className="text-left px-4 py-2">Email</th><th className="text-left px-4 py-2">Role</th><th className="text-left px-4 py-2">Use case</th><th className="px-4 py-2"></th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2">{u.role}</td>
                <td className="px-4 py-2 text-slate-500">{u.useCaseKey ?? "—"}</td>
                <td className="px-4 py-2 text-right">
                  {u.role !== "PlatformAdmin" && u.role !== "UseCaseAdmin" && (
                    <button onClick={() => remove(u.id)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
