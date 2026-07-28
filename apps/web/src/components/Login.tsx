import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import { useRoute } from "../router.js";
import { getOrCreateDeviceKey, hasDeviceKey } from "../lib/device-wallet.js";
import { Logo, LogoMark } from "./Logo.js";
import { Icon, type IconName } from "./ui.js";

const HIGHLIGHTS: { icon: IconName; title: string; text: string }[] = [
  { icon: "chain", title: "Any ledger", text: "Issue on EVM, Fabric & Canton from one console" },
  { icon: "shield", title: "Built-in controls", text: "Fail-closed compliance & maker-checker controls" },
  { icon: "doc", title: "Provable records", text: "Tamper-evident, on-ledger-anchored audit" },
];

export function Login(): JSX.Element {
  const { login, setSession } = useAuth();
  const { navigate } = useRoute();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Passwordless (QR / this-device) sign-in state.
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasKey = hasDeviceKey();

  const stopPolling = (): void => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Ensure the poll interval never leaks past unmount.
  useEffect(() => stopPolling, []);

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

  // Show a QR that an enrolled device scans + approves; poll until authenticated.
  async function startQr(): Promise<void> {
    stopPolling();
    setQrError(null);
    setQrSvg(null);
    setQrBusy(true);
    try {
      const { sessionId, qrSvg: svg } = await api.qrStart();
      setQrSvg(svg);
      pollRef.current = setInterval(() => {
        void api
          .qrPoll(sessionId)
          .then((res) => {
            if (res.status === "authenticated" && res.token && res.user) {
              stopPolling();
              setSession(res.token, res.user);
            } else if (res.status === "consumed" || res.status === "expired") {
              stopPolling();
              setQrError(res.status === "expired" ? "This sign-in request expired. Try again." : "This sign-in request was already used.");
            }
          })
          .catch((err) => {
            stopPolling();
            setQrError(err instanceof ApiError ? err.message : "Sign-in failed");
          });
      }, 2000);
    } catch (err) {
      setQrError(err instanceof ApiError ? err.message : "Could not start QR sign-in");
    } finally {
      setQrBusy(false);
    }
  }

  // Single-device passwordless: start a session and sign+authenticate it locally.
  async function useThisDevice(): Promise<void> {
    stopPolling();
    setQrError(null);
    setQrSvg(null);
    setQrBusy(true);
    try {
      const { sessionId, challenge } = await api.qrStart();
      const key = await getOrCreateDeviceKey();
      const signature = await key.sign(`qr-login:${sessionId}:${challenge}`);
      await api.qrAuthenticate(sessionId, { did: key.did, signature });
      const res = await api.qrPoll(sessionId);
      if (res.status === "authenticated" && res.token && res.user) {
        setSession(res.token, res.user);
      } else {
        setQrError("Sign-in could not be completed. Try again.");
      }
    } catch (err) {
      setQrError(err instanceof ApiError ? err.message : "Sign-in failed");
    } finally {
      setQrBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* Brand panel — hidden on small screens */}
      <div className="hidden lg:flex lg:w-1/2 xl:w-[46%] flex-col justify-between p-12 bg-gradient-to-br from-slate-900 via-[#0E2B26] to-[#0a5a4d] relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
          aria-hidden="true"
        />
        <div className="relative">
          <Logo onDark size={34} />
        </div>
        <div className="relative max-w-md">
          <h1 className="text-3xl xl:text-4xl font-bold tracking-tight text-white leading-tight">
            Institutional tokenization, on any ledger
          </h1>
          <ul className="mt-8 space-y-5">
            {HIGHLIGHTS.map((h) => (
              <li key={h.icon} className="flex items-start gap-3.5">
                <span className="shrink-0 w-9 h-9 rounded-lg bg-white/10 text-brand-400 flex items-center justify-center">
                  <Icon name={h.icon} className="w-5 h-5" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-white">{h.title}</span>
                  <span className="block text-sm text-slate-300 mt-0.5">{h.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-slate-400">
          Tokenize any asset. On any chain. Any standard.
        </p>
      </div>

      {/* Form panel */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="lg:hidden mb-6 flex justify-center">
            <Logo size={34} />
          </div>
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-xigreen via-brand-400 to-xiblue" />
            <div className="p-8">
              <div className="mb-6 flex items-start gap-3">
                <div className="hidden lg:flex shrink-0 w-11 h-11 rounded-xl bg-brand-50 items-center justify-center">
                  <LogoMark size={26} />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-tight text-slate-900">Sign in</h2>
                  <p className="text-sm text-slate-500 mt-0.5">Access your tokenization console</p>
                </div>
              </div>
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">Email</label>
                  <input
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username"
                    placeholder="you@institution.com"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">Password</label>
                  <input
                    type="password"
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    placeholder="••••••••"
                  />
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-lg bg-brand-600 text-white py-2.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 transition-colors"
                >
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>
              {/* Passwordless sign-in */}
              <div className="mt-6 pt-6 border-t border-slate-100">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void startQr()}
                    disabled={qrBusy}
                    className="flex-1 rounded-lg border border-slate-300 text-slate-700 py-2.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors"
                  >
                    Sign in with QR
                  </button>
                  {hasKey && (
                    <button
                      type="button"
                      onClick={() => void useThisDevice()}
                      disabled={qrBusy}
                      className="flex-1 rounded-lg border border-slate-300 text-slate-700 py-2.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors"
                    >
                      Use this device
                    </button>
                  )}
                </div>
                {qrError && <p className="mt-3 text-sm text-red-600">{qrError}</p>}
                {qrSvg && (
                  <div className="mt-4 flex flex-col items-center">
                    <div
                      className="w-44 h-44 [&>svg]:w-full [&>svg]:h-full"
                      dangerouslySetInnerHTML={{ __html: qrSvg }}
                    />
                    <p className="mt-2 text-xs text-slate-500">Scan with an enrolled device</p>
                  </div>
                )}
              </div>

              <p className="mt-5 text-center text-sm text-slate-500">
                New enterprise?{" "}
                <button
                  type="button"
                  onClick={() => navigate("/signup")}
                  className="font-medium text-brand-700 hover:text-brand-600"
                >
                  Register your company
                </button>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
