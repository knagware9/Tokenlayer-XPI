import { useState } from "react";
import { ApiError } from "../api.js";
import { useAuth } from "../auth.js";

const QUICK = [
  { role: "Admin", email: "admin@tokenlayer.dev", password: "admin123" },
  { role: "Issuer", email: "issuer@tokenlayer.dev", password: "issuer123" },
  { role: "Operator", email: "operator@tokenlayer.dev", password: "operator123" },
  { role: "Viewer", email: "viewer@tokenlayer.dev", password: "viewer123" },
];

export function Login(): JSX.Element {
  const { login } = useAuth();
  const [email, setEmail] = useState("admin@tokenlayer.dev");
  const [password, setPassword] = useState("admin123");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e?: React.FormEvent): Promise<void> {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">TokenLayer</h1>
          <p className="text-sm text-slate-500">One platform. Any asset. Any chain.</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
            <input
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Password</label>
            <input
              type="password"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-brand-600 text-white py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="mt-6">
          <p className="text-xs text-slate-400 mb-2">Quick login (demo)</p>
          <div className="grid grid-cols-2 gap-2">
            {QUICK.map((q) => (
              <button
                key={q.role}
                onClick={() => {
                  setEmail(q.email);
                  setPassword(q.password);
                }}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:border-brand-500 hover:text-brand-700"
              >
                {q.role}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
