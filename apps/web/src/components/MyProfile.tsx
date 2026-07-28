import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import { getOrCreateDeviceKey } from "../lib/device-wallet.js";
import type { LoginKeyInfo } from "../types.js";
import { Card, SectionHeader } from "./ui.js";

/** A read-only snapshot of the signed-in user's account and identity. */
export function MyProfile({ onSelect }: { onSelect: (id: string) => void }): JSX.Element {
  const { token, user } = useAuth();
  const [copied, setCopied] = useState(false);
  // The organization name comes from the user's OrganizationMembership credential
  // (operators hold one without a tenancy orgId), falling back to any orgId.
  const [orgName, setOrgName] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !user?.did) return;
    void api.myCredentials(token).then((creds) => {
      const membership = creds.find((c) => c.type.includes("OrganizationMembership"));
      const org = membership?.claims.organization;
      if (typeof org === "string" && org) setOrgName(org);
    }).catch(() => { /* profile still renders without the org name */ });
  }, [token, user?.did]);

  // Passwordless login: this device's self-custody key + the caller's enrolled keys.
  const [deviceDid, setDeviceDid] = useState<string | null>(null);
  const [loginKeys, setLoginKeys] = useState<LoginKeyInfo[] | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const refreshLoginKeys = (): void => {
    if (!token) return;
    void api.loginKeys(token).then(setLoginKeys).catch(() => setLoginKeys([]));
  };

  useEffect(() => {
    if (!token) return;
    void getOrCreateDeviceKey().then((k) => setDeviceDid(k.did)).catch(() => { /* wallet unavailable */ });
    refreshLoginKeys();
  }, [token]);

  const enrollDevice = async (): Promise<void> => {
    if (!token) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const key = await getOrCreateDeviceKey();
      setDeviceDid(key.did);
      const label = navigator.userAgent.slice(0, 60);
      await api.enrollLoginKey(token, { did: key.did, label });
      refreshLoginKeys();
    } catch (e) {
      setKeyError(e instanceof ApiError ? e.message : "Could not set up passwordless login on this device.");
    } finally {
      setKeyBusy(false);
    }
  };

  const revokeKey = async (id: string): Promise<void> => {
    if (!token) return;
    setKeyError(null);
    try {
      await api.removeLoginKey(token, id);
      refreshLoginKeys();
    } catch (e) {
      setKeyError(e instanceof ApiError ? e.message : "Could not revoke this device key.");
    }
  };

  const shortDid = (d: string): string => `${d.slice(0, 16)}…${d.slice(-6)}`;
  const thisDeviceEnrolled = !!deviceDid && !!loginKeys?.some((k) => k.did === deviceDid);

  const did = user?.did ?? null;
  const didShort = did ? `${did.slice(0, 18)}…${did.slice(-6)}` : "Not issued yet";
  const copyDid = (): void => {
    if (!did) return;
    void navigator.clipboard.writeText(did).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: "Email", value: user?.email ?? "—" },
    { label: "Role", value: user?.role ?? "—" },
    { label: "Use case", value: user?.useCaseKey ?? "Platform-wide" },
    { label: "Organization", value: orgName ?? user?.orgId ?? "Not affiliated", mono: !orgName && !!user?.orgId },
    { label: "Wallet", value: user?.walletAddress ?? "Not linked", mono: !!user?.walletAddress },
  ];

  return (
    <div>
      <SectionHeader title="My profile" description="Your account and identity at a glance." />
      <Card>
        <dl className="divide-y divide-slate-100">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{r.label}</dt>
              <dd className={`text-sm text-slate-900 truncate text-right ${r.mono ? "font-mono text-xs" : ""}`}>{r.value}</dd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-4 py-3 last:pb-0">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">DID</dt>
            <dd className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-mono text-slate-900 truncate">{didShort}</span>
              {did && (
                <button
                  onClick={copyDid}
                  className="shrink-0 text-[11px] font-medium text-brand-600 hover:text-brand-700"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              )}
            </dd>
          </div>
        </dl>
        <div className="mt-5 pt-4 border-t border-slate-100">
          <button
            onClick={() => onSelect("credentials")}
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            View my credentials →
          </button>
        </div>
      </Card>

      <div className="mt-6">
        <Card
          title="Passwordless login"
          description="Register this device's self-custody key to sign in without a password. The private key stays in this browser."
        >
          {keyError && (
            <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
              {keyError}
            </div>
          )}
          <button
            onClick={() => void enrollDevice()}
            disabled={keyBusy || thisDeviceEnrolled}
            className="inline-flex items-center rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {thisDeviceEnrolled ? "This device is set up" : keyBusy ? "Setting up…" : "Set up passwordless login on this device"}
          </button>

          <div className="mt-5">
            {loginKeys === null ? (
              <p className="text-xs text-slate-500">Loading device keys…</p>
            ) : loginKeys.length === 0 ? (
              <p className="text-xs text-slate-500">No devices enrolled yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {loginKeys.map((k) => (
                  <li key={k.id} className="flex items-center justify-between gap-4 py-3 first:pt-0">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-900 truncate">{k.label || "Device"}</span>
                        {deviceDid === k.did && (
                          <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-600">
                            this device
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs font-mono text-slate-500 truncate">{shortDid(k.did)}</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        Added {new Date(k.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      onClick={() => void revokeKey(k.id)}
                      className="shrink-0 text-xs font-medium text-red-600 hover:text-red-700"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
