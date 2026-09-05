import { useEffect, useState } from "react";
import { api, ApiError, describeApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import { getOrCreateDeviceKey } from "../../lib/shared/device-wallet.js";
import { isExpiringOrExpired } from "../../lib/shared/kyc-expiry.js";
import type { LoginKeyInfo } from "../../types.js";
import { KycSubmissionPanel } from "./KycSubmissionPanel.js";
import { Card, SectionHeader } from "./ui.js";

const DEMO_CURRENCIES = ["CBDC-INR", "USDC", "e-GBP"];

/** Mirrors the backend's WALLET_ELIGIBLE_ROLES (apps/api/src/shared/wallets.ts)
 *  — the only roles PATCH /me/wallet will ever accept. Kept inline, not a
 *  shared constant: the backend is the enforcement, this is only a UI gate to
 *  avoid showing a control that would always 400. */
const WALLET_ELIGIBLE_ROLES = new Set(["Buyer", "Trader", "Issuer"]);

/** A read-only snapshot of the signed-in user's account and identity. */
export function MyProfile({ onSelect }: { onSelect: (id: string) => void }): JSX.Element {
  const { token, user, setSession, refreshSession } = useAuth();
  const [copied, setCopied] = useState(false);

  const walletEligible = !!user?.role && WALLET_ELIGIBLE_ROLES.has(user.role);
  const [walletInput, setWalletInput] = useState("");
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const linkWallet = async (): Promise<void> => {
    if (!token || !user || !walletInput.trim()) return;
    setWalletBusy(true);
    setWalletError(null);
    try {
      const result = await api.updateMyWallet(token, walletInput.trim());
      // PATCH /me/wallet returns the new address directly — GET /me does not
      // (see refreshSession's own comment), so merge it in here rather than
      // refreshing the session.
      setSession(token, { ...user, walletAddress: result.walletAddress });
      setWalletInput("");
    } catch (e) {
      setWalletError(e instanceof ApiError ? e.message : "Could not link that wallet address.");
    } finally {
      setWalletBusy(false);
    }
  };
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

  // Self-funding: Buyer and Issuer top up their OWN linked wallet only — the
  // server enforces this (`/cash/credit` rejects any other account for a
  // Buyer caller), this UI never offers a way to pick a different one.
  const [fundAmount, setFundAmount] = useState("");
  const [fundCurrency, setFundCurrency] = useState<string>(DEMO_CURRENCIES[0]!);
  const [fundBusy, setFundBusy] = useState(false);
  const [fundError, setFundError] = useState<string | null>(null);
  const [fundNotice, setFundNotice] = useState<string | null>(null);
  const fundAccount = async (): Promise<void> => {
    if (!token || !user?.walletAddress || !fundAmount) return;
    setFundBusy(true);
    setFundError(null);
    setFundNotice(null);
    try {
      const r = await api.creditCash(token, user.walletAddress, fundCurrency, fundAmount);
      setFundNotice(`Balance now ${BigInt(r.balance).toLocaleString("en-IN")} ${fundCurrency}.`);
      setFundAmount("");
    } catch (e) {
      setFundError(describeApiError(e, "Top-up failed"));
    } finally {
      setFundBusy(false);
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

      {(user?.kycStatus === "pending" || user?.kycStatus === "rejected" ||
        (user?.kycStatus === "approved" && isExpiringOrExpired(user?.kycExpiresAt))) && (
        <div className="mt-6">
          {/* The panel shows its own post-submit confirmation and keeps that
           *  local state, so we only need to refresh the session's kycStatus
           *  in the background here — no reload, which would wipe the panel's
           *  state and re-mount a blank form right after a successful submit. */}
          <KycSubmissionPanel onSubmitted={() => void refreshSession()} />
        </div>
      )}

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

      {walletEligible && (
        <div className="mt-6">
          <Card
            title="Wallet"
            description="Link the address you actually hold, replacing the one assigned when your account was created."
          >
            {walletError && (
              <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
                {walletError}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={walletInput}
                onChange={(e) => setWalletInput(e.target.value)}
                placeholder={user?.walletAddress ?? "0x…"}
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono text-slate-900 focus:border-brand-500 focus:outline-none"
              />
              <button
                onClick={() => void linkWallet()}
                disabled={walletBusy || !walletInput.trim()}
                className="shrink-0 inline-flex items-center rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {walletBusy ? "Linking…" : "Link"}
              </button>
            </div>
          </Card>
        </div>
      )}

      {walletEligible && user?.walletAddress && (
        <div className="mt-6">
          <Card
            title="Fund my account"
            description="Top up your own wallet with demo settlement currency."
          >
            {fundError && (
              <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
                {fundError}
              </div>
            )}
            {fundNotice && (
              <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
                {fundNotice}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                value={fundAmount}
                onChange={(e) => setFundAmount(e.target.value)}
                placeholder="amount"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none"
              />
              <select
                value={fundCurrency}
                onChange={(e) => setFundCurrency(e.target.value)}
                className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none"
              >
                {DEMO_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <button
                onClick={() => void fundAccount()}
                disabled={fundBusy || !fundAmount}
                className="shrink-0 inline-flex items-center rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {fundBusy ? "Funding…" : "Fund"}
              </button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
