import { useState } from "react";
import { ApiError, api } from "../api.js";
import { useRoute } from "../router.js";
import type { OrgType } from "../types.js";
import { Logo } from "./Logo.js";
import { Icon } from "./ui.js";

// Public self-registration is limited to issuing/holding org types — a verifier
// is provisioned by the platform, not self-served.
const ORG_TYPES: { value: OrgType; label: string }[] = [
  { value: "corporate", label: "Corporate" },
  { value: "bank", label: "Bank" },
  { value: "msme", label: "MSME" },
  { value: "government", label: "Government" },
];

export function Signup(): JSX.Element {
  const { navigate } = useRoute();
  const [name, setName] = useState("");
  const [orgType, setOrgType] = useState<OrgType>("corporate");
  const [jurisdiction, setJurisdiction] = useState("");
  const [registrationId, setRegistrationId] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Company legal name is required"); return; }
    if (!adminName.trim()) { setError("Administrator name is required"); return; }
    if (!adminEmail.trim()) { setError("Administrator email is required"); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    setBusy(true);
    try {
      await api.registerOrg({
        company: {
          name: name.trim(),
          orgType,
          registrationId: registrationId.trim() || undefined,
          jurisdiction: jurisdiction.trim() || undefined,
        },
        admin: { name: adminName.trim(), email: adminEmail.trim(), password },
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#EFF8F4] flex flex-col">
      <header className="border-b border-slate-200/70 bg-white/70 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <button onClick={() => navigate("/")} className="cursor-pointer">
            <Logo size={30} />
          </button>
          <button
            onClick={() => navigate("/login")}
            className="rounded-lg border border-slate-200 text-slate-700 px-4 py-2 text-sm font-medium hover:bg-slate-50 transition-colors"
          >
            Login
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-2xl">
          {done ? (
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-xigreen via-brand-400 to-xiblue" />
              <div className="p-8 text-center">
                <div className="mx-auto w-12 h-12 rounded-full bg-brand-50 text-brand-600 flex items-center justify-center">
                  <Icon name="check" className="w-7 h-7" />
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight text-slate-900">Registration submitted</h2>
                <p className="mt-2 text-sm text-slate-500 max-w-md mx-auto">
                  A platform administrator will review your company. You can log in once your
                  organization is approved.
                </p>
                <button
                  onClick={() => navigate("/")}
                  className="mt-6 rounded-lg bg-brand-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-brand-700 transition-colors"
                >
                  Back to home
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-xigreen via-brand-400 to-xiblue" />
              <div className="p-8">
                <h2 className="text-lg font-semibold tracking-tight text-slate-900">Register your company</h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  Tell us about your organization. A platform administrator reviews every registration before access is granted.
                </p>
                <form onSubmit={submit} className="mt-6 space-y-5">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">Company</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-slate-600 mb-1.5">Company legal name</label>
                        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Holdings Ltd." />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1.5">Organization type</label>
                        <select className="select" value={orgType} onChange={(e) => setOrgType(e.target.value as OrgType)}>
                          {ORG_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1.5">Jurisdiction</label>
                        <input className="input" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="e.g. IN" />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-slate-600 mb-1.5">Registration ID <span className="text-slate-400 font-normal">(optional)</span></label>
                        <input className="input" value={registrationId} onChange={(e) => setRegistrationId(e.target.value)} placeholder="Company / incorporation number" />
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">Administrator</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-slate-600 mb-1.5">Full name</label>
                        <input className="input" value={adminName} onChange={(e) => setAdminName(e.target.value)} autoComplete="name" placeholder="Jane Doe" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1.5">Email</label>
                        <input className="input" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} autoComplete="email" placeholder="jane@acme.com" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1.5">Password</label>
                        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" />
                      </div>
                    </div>
                  </div>

                  {error && <p className="text-sm text-red-600">{error}</p>}

                  <div className="flex items-center gap-3">
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded-lg bg-brand-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors"
                    >
                      {busy ? "Submitting…" : "Submit registration"}
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate("/")}
                      className="text-sm font-medium text-slate-500 hover:text-slate-800"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
