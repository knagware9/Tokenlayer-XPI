import { useState } from "react";
import { api, ApiError } from "../api.js";
import { getOrCreateDeviceKey, hasDeviceKey } from "../lib/device-wallet.js";
import { Logo } from "./Logo.js";
import { Icon } from "./ui.js";

/**
 * Standalone approval page reached by opening a QR's signUrl on an enrolled
 * device. It does NOT require an app session: the device signs the login
 * challenge with its self-custody key and posts it back to the pending session.
 */
export function QrSign(): JSX.Element {
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session");
  const challenge = params.get("challenge");

  const enrolled = hasDeviceKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function approve(): Promise<void> {
    if (!session || !challenge) return;
    setBusy(true);
    setError(null);
    try {
      const key = await getOrCreateDeviceKey();
      const signature = await key.sign(`qr-login:${session}:${challenge}`);
      await api.qrAuthenticate(session, { did: key.did, signature });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Approval failed");
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
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-xigreen via-brand-400 to-xiblue" />
          <div className="p-8">
            {!session || !challenge ? (
              <div className="text-center">
                <div className="mx-auto w-11 h-11 rounded-xl bg-red-50 text-red-600 flex items-center justify-center">
                  <Icon name="warn" className="w-6 h-6" />
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight text-slate-900">Invalid sign-in link</h2>
                <p className="mt-1.5 text-sm text-slate-500">
                  This link is missing its session details. Start again from your other device.
                </p>
              </div>
            ) : !enrolled ? (
              <div className="text-center">
                <div className="mx-auto w-11 h-11 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
                  <Icon name="shield" className="w-6 h-6" />
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight text-slate-900">This device isn't enrolled</h2>
                <p className="mt-1.5 text-sm text-slate-500">
                  To approve sign-ins from here, first{" "}
                  <a href="/login" className="font-medium text-brand-700 hover:text-brand-600">
                    sign in and enroll this device
                  </a>
                  .
                </p>
              </div>
            ) : done ? (
              <div className="text-center">
                <div className="mx-auto w-11 h-11 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
                  <Icon name="check" className="w-6 h-6" />
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight text-slate-900">Approved</h2>
                <p className="mt-1.5 text-sm text-slate-500">Return to your other device to continue.</p>
              </div>
            ) : (
              <div className="text-center">
                <div className="mx-auto w-11 h-11 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
                  <Icon name="shield" className="w-6 h-6" />
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight text-slate-900">
                  Approve sign-in on your other device?
                </h2>
                <p className="mt-1.5 text-sm text-slate-500">
                  You're about to authorize a sign-in that was started elsewhere.
                </p>
                {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
                <button
                  type="button"
                  onClick={() => void approve()}
                  disabled={busy}
                  className="mt-6 w-full rounded-lg bg-brand-600 text-white py-2.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 transition-colors"
                >
                  {busy ? "Approving…" : "Approve"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
