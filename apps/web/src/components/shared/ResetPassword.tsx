import { useState } from "react";
import { api, ApiError } from "../../api.js";
import { Logo } from "./Logo.js";

function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

export function ResetPassword(): JSX.Element {
  const [token] = useState(tokenFromUrl);
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e?: React.FormEvent): Promise<void> {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, newPassword);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset your password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo size={34} />
        </div>
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-8">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900 mb-1">Set a new password</h2>
          {!token ? (
            <p className="text-sm text-red-600 mt-4">This reset link is missing its token. Request a new one from the sign-in page.</p>
          ) : done ? (
            <p className="text-sm text-slate-600 mt-4">
              Your password has been reset.{" "}
              <a href="/login" className="font-medium text-brand-700 hover:text-brand-600">
                Sign in
              </a>
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-4 mt-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">New password</label>
                <input
                  type="password"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-brand-600 text-white py-2.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Set password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
