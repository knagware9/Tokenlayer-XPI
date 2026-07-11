import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import { can } from "../rbac.js";
import { CashflowPanel } from "./CashflowPanel.js";
import type { AccountState, Asset, AuditEntry, ChainInfo, Listing, Role, TokenInfo, Trade, UseCase } from "../types.js";
import { Pill as UIPill, Skeleton } from "./ui.js";

interface Props {
  assetId: string;
  useCases: UseCase[];
  chains: ChainInfo[];
  onBack: () => void;
  onChanged: () => void;
}

export function AssetDetail({ assetId, useCases, chains, onBack, onChanged }: Props): JSX.Element {
  const { token, user } = useAuth();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [accounts, setAccounts] = useState<AccountState[]>([]);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Buy panel state
  const [buyQty, setBuyQty] = useState("");
  const [buyBusy, setBuyBusy] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [myBalance, setMyBalance] = useState<string | null>(null);

  // Fund CBDC state
  const [fundAccount, setFundAccount] = useState("");
  const [fundCurrency, setFundCurrency] = useState("");
  const [fundAmount, setFundAmount] = useState("");
  const [fundBusy, setFundBusy] = useState(false);
  const [fundError, setFundError] = useState<string | null>(null);
  const [fundSuccess, setFundSuccess] = useState<string | null>(null);
  const [availCurrencies, setAvailCurrencies] = useState<{ code: string; label: string }[]>([]);

  const reload = useCallback(async () => {
    if (!token) return;
    const a = await api.asset(token, assetId);
    setAsset(a);
    const [acc, log] = await Promise.all([api.assetAccounts(token, assetId), api.audit(token, assetId)]);
    setAccounts(acc);
    setAudit(log);
    if (a.tokenType === "nonfungible") setTokens(await api.assetTokens(token, assetId));
  }, [token, assetId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Load buyer's cash balance when asset has sale terms
  const refreshBalance = useCallback(async () => {
    if (!token || !asset?.currency || !user?.walletAddress) return;
    try {
      const balances = await api.cashBalances(token, user.walletAddress);
      const b = balances.find((b) => b.currency === asset.currency);
      setMyBalance(b?.amount ?? "0");
    } catch {
      setMyBalance(null);
    }
  }, [token, asset?.currency, user?.walletAddress]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  // Load available currencies for Fund CBDC
  useEffect(() => {
    if (!token) return;
    void api.currencies(token).then(setAvailCurrencies).catch(() => {});
  }, [token]);

  const useCase = asset ? useCases.find((u) => u.key === asset.useCaseKey) : undefined;
  const role = user?.role ?? "Auditor";
  const chain = asset ? chains.find((c) => c.id === asset.chainId) : undefined;

  async function run(action: string, body: Record<string, string>): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api.action(token, assetId, action, body);
      await reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function doBuy(): Promise<void> {
    if (!token || !safeQty) return;
    setBuyBusy(true);
    setBuyError(null);
    try {
      await api.buy(token, assetId, safeQty);
      setBuyQty("");
      await reload();
      onChanged();
      await refreshBalance();
    } catch (err) {
      setBuyError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Buy failed");
    } finally {
      setBuyBusy(false);
    }
  }

  async function doFund(): Promise<void> {
    if (!token || !fundAccount || !fundCurrency || !fundAmount) return;
    if (!/^\d+$/.test(fundAmount)) {
      setFundError("Amount must be a whole number");
      return;
    }
    setFundBusy(true);
    setFundError(null);
    setFundSuccess(null);
    try {
      const res = await api.creditCash(token, fundAccount, fundCurrency, fundAmount);
      setFundSuccess(`Funded. New balance: ${res.balance} ${fundCurrency}`);
      setFundAmount("");
    } catch (err) {
      setFundError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Fund failed");
    } finally {
      setFundBusy(false);
    }
  }

  if (!asset || !useCase)
    return (
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
        <Skeleton lines={5} />
      </div>
    );

  const isNft = asset.tokenType === "nonfungible";
  const canAllow = useCase.compliance.allowlist && can(role, "allow");
  const canFreeze = useCase.lifecycle.freeze && can(role, "freeze");
  const safeQty = /^\d+$/.test(buyQty) ? buyQty : null;

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-800">
        ← Back to assets
      </button>

      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-900">
              {asset.name} <span className="text-slate-400 font-normal">{asset.symbol}</span>
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="px-1.5 py-0.5 rounded bg-brand-600 text-white font-semibold">{asset.tokenStandard}</span>
              <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 font-medium">{asset.tokenType}</span>
              <ChainPill chain={chain} />
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-slate-900">{asset.totalSupply ?? "—"}</div>
            <div className="text-[11px] text-slate-400 uppercase tracking-wide">{isNft ? "Tokens" : "Total supply"}</div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
          {Object.entries(asset.metadata).map(([k, v]) => (
            <div key={k} className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
              <div className="text-slate-400 uppercase tracking-wide text-[10px]">{k}</div>
              <div className="text-slate-700 font-medium truncate">{String(v)}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {chain?.mode === "real" ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
              ⛓ Verified on-chain{chain ? ` · ${chain.label}` : ""}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">
              🧪 Simulated ledger{chain ? ` · ${chain.label}` : ""}
            </span>
          )}
          <span className="text-[11px] text-slate-400 font-mono break-all">
            ref: <ExplorerLink chain={chain} kind="address" value={asset.contractRef}>{asset.contractRef}</ExplorerLink>
          </span>
        </div>
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}

      {asset.status === "pending_approval" && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-2">
          ⏳ Pending approval — supply mints and the asset activates once approved in the Approvals tab.
        </div>
      )}
      {asset.status === "rejected" && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">
          ✕ Issuance rejected — this asset was never activated.
        </div>
      )}

      {useCase.terms && <CashflowPanel asset={asset} useCase={useCase} role={role} onChanged={() => { void reload(); onChanged(); }} />}

      {asset.unitPrice && asset.currency && can(role, "buy") && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-3">
          <div className="text-sm font-semibold text-slate-800">Buy tokens</div>
          <div className="text-sm text-slate-600">
            Price: <strong>{asset.unitPrice} {asset.currency}</strong> per token
            {myBalance !== null && (
              <span className="ml-3 text-slate-400">Your {asset.currency} balance: <strong>{myBalance}</strong></span>
            )}
          </div>
          {safeQty && BigInt(asset.unitPrice) > 0n && (
            <div className="text-xs text-slate-500">
              Total: {(BigInt(asset.unitPrice) * BigInt(safeQty)).toString()} {asset.currency}
            </div>
          )}
          <div className="flex gap-2">
            <input
              className="input w-32"
              type="number"
              min="1"
              step="1"
              placeholder="Quantity"
              value={buyQty}
              onChange={(e) => setBuyQty(e.target.value)}
            />
            <button
              disabled={buyBusy || !safeQty}
              onClick={() => void doBuy()}
              className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
            >
              {buyBusy ? "Buying…" : "Buy"}
            </button>
          </div>
          {buyError && <p className="text-sm text-red-600">{buyError}</p>}
        </div>
      )}

      {!isNft && (
        <Market
          asset={asset}
          role={role}
          currencies={availCurrencies}
          onTraded={async () => {
            await reload();
            onChanged();
            await refreshBalance();
          }}
        />
      )}

      <Operations role={role} useCase={useCase} isNft={isNft} accounts={accounts} busy={busy} onRun={run} />

      {isNft && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 text-xs font-semibold text-slate-500 uppercase tracking-wide">Tokens</div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-400 text-[11px] uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-2">Token ID</th>
                <th className="text-left font-medium px-4 py-2">Owner</th>
                <th className="text-center font-medium px-4 py-2">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tokens.map((t) => (
                <tr key={t.tokenId}>
                  <td className="px-4 py-2.5 font-mono text-slate-700">#{t.tokenId}</td>
                  <td className="px-4 py-2.5 text-slate-600">{t.ownerLabel}</td>
                  <td className="px-4 py-2.5 text-center">{t.frozen ? <Pill tone="red">frozen</Pill> : <span className="text-slate-300 text-xs">—</span>}</td>
                </tr>
              ))}
              {tokens.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-4 text-center text-sm text-slate-400">No tokens minted yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-100 text-xs font-semibold text-slate-500 uppercase tracking-wide">Holders</div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-400 text-[11px] uppercase">
            <tr>
              <th className="text-left font-medium px-4 py-2">Account</th>
              <th className="text-right font-medium px-4 py-2">{isNft ? "Tokens" : "Balance"}</th>
              <th className="text-center font-medium px-4 py-2">State</th>
              <th className="text-right font-medium px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {accounts.map((acc) => (
              <tr key={acc.address}>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-slate-700">{acc.label}</div>
                  <div className="text-[10px] text-slate-400 font-mono">{acc.address.slice(0, 10)}…{acc.address.slice(-4)}</div>
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-slate-700">{acc.balance}</td>
                <td className="px-4 py-2.5 text-center">
                  {acc.frozen && <Pill tone="red">frozen</Pill>}
                  {useCase.compliance.allowlist && (acc.allowed ? <Pill tone="green">allowed</Pill> : <Pill tone="gray">not listed</Pill>)}
                  {!acc.frozen && !useCase.compliance.allowlist && <span className="text-slate-300 text-xs">—</span>}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-end gap-1.5">
                    {canAllow && (
                      <button disabled={busy} onClick={() => run(acc.allowed ? "disallow" : "allow", { account: acc.address })} className="btn-sm border-slate-200 text-slate-600 hover:border-brand-500">
                        {acc.allowed ? "Disallow" : "Allow"}
                      </button>
                    )}
                    {canFreeze && (
                      <button disabled={busy} onClick={() => run(acc.frozen ? "unfreeze" : "freeze", { account: acc.address })} className="btn-sm border-slate-200 text-slate-600 hover:border-red-400">
                        {acc.frozen ? "Unfreeze" : "Freeze"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Audit trail</div>
        <ol className="space-y-2">
          {audit.map((e) => (
            <li key={e.id} className="flex items-start gap-3 text-sm">
              <span className="mt-0.5 inline-block w-20 shrink-0 text-[11px] font-semibold text-brand-600 uppercase">{e.action}</span>
              <span className="flex-1 text-slate-600">
                {summarize(e)}
                {e.txHash && (
                  <span className="ml-2 font-mono text-[10px] text-slate-400">
                    <ExplorerLink chain={chain} kind="tx" value={e.txHash}>{e.txHash.slice(0, 14)}…</ExplorerLink>
                  </span>
                )}
              </span>
              <span className="text-[11px] text-slate-400">{new Date(e.createdAt).toLocaleTimeString()}</span>
            </li>
          ))}
          {audit.length === 0 && <li className="text-sm text-slate-400">No activity yet.</li>}
        </ol>
      </div>

      {(["Issuer", "UseCaseAdmin", "PlatformAdmin"] as string[]).includes(role) && accounts.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-3">
          <div className="text-sm font-semibold text-slate-800">Fund CBDC</div>
          <div className="grid grid-cols-3 gap-3">
            <select className="select" value={fundAccount} onChange={(e) => setFundAccount(e.target.value)}>
              <option value="">Account…</option>
              {accounts.map((a) => <option key={a.address} value={a.address}>{a.label}</option>)}
            </select>
            <select className="select" value={fundCurrency} onChange={(e) => setFundCurrency(e.target.value)}>
              <option value="">Currency…</option>
              {availCurrencies.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
            <input className="input" type="number" min="1" placeholder="Amount" value={fundAmount} onChange={(e) => setFundAmount(e.target.value)} />
          </div>
          <button
            disabled={fundBusy || !fundAccount || !fundCurrency || !fundAmount || !/^\d+$/.test(fundAmount)}
            onClick={() => void doFund()}
            className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
          >
            {fundBusy ? "Funding…" : "Fund account"}
          </button>
          {fundError && <p className="text-sm text-red-600">{fundError}</p>}
          {fundSuccess && <p className="text-sm text-emerald-600">{fundSuccess}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Secondary market card for fungible assets: open asks (takeable), a sell
 * form, the caller's own listings (cancellable), and recent trades. The API
 * enforces balance/compliance/funds — the UI only gates by role and wallet.
 */
function Market({
  asset,
  role,
  currencies,
  onTraded,
}: {
  asset: Asset;
  role: Role;
  currencies: { code: string; label: string }[];
  onTraded: () => Promise<void>;
}): JSX.Element | null {
  const { token, user } = useAuth();
  const [listings, setListings] = useState<Listing[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [takeQty, setTakeQty] = useState<Record<string, string>>({});

  // Sell form state
  const [sellQty, setSellQty] = useState("");
  const [sellPrice, setSellPrice] = useState("");
  const [sellCurrency, setSellCurrency] = useState("");

  const wallet = user?.walletAddress?.toLowerCase() ?? null;

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [ls, ts] = await Promise.all([api.listings(token, asset.id), api.trades(token, asset.id)]);
      setListings(ls);
      setTrades(ts);
      setDisabled(false);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 503 || err.code === "MARKET_DISABLED")) {
        setDisabled(true);
      } else {
        setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Failed to load market");
      }
    } finally {
      setLoaded(true);
    }
  }, [token, asset.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<void>, fallback: string): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      await onTraded();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : fallback);
    } finally {
      setBusy(false);
    }
  }

  const doTake = (l: Listing): Promise<void> =>
    act(async () => {
      const qty = takeQty[l.id];
      if (!qty || !/^\d+$/.test(qty) || BigInt(qty) === 0n) throw new ApiError("Quantity must be a positive whole number", 400, "INVALID_QUANTITY");
      await api.takeListing(token!, l.id, qty);
      setTakeQty((s) => ({ ...s, [l.id]: "" }));
    }, "Take failed");

  const doSell = (): Promise<void> =>
    act(async () => {
      await api.createListing(token!, asset.id, { quantity: sellQty, unitPrice: sellPrice, currency: sellCurrency });
      setSellQty("");
      setSellPrice("");
    }, "Listing failed");

  const doCancel = (id: string): Promise<void> =>
    act(async () => {
      await api.cancelListing(token!, id);
    }, "Cancel failed");

  if (!loaded) return null;

  const canBuy = can(role, "buy");
  const canList = can(role, "list");
  const canCancelListing = can(role, "cancel-listing");
  const posInt = (s: string): boolean => /^\d+$/.test(s) && BigInt(s) > 0n;
  const myListings = wallet ? listings.filter((l) => l.seller.toLowerCase() === wallet) : [];
  const sellReady = posInt(sellQty) && posInt(sellPrice) && sellCurrency !== "";

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-4">
      <div className="text-sm font-semibold text-slate-800">Market</div>
      {disabled ? (
        <p className="text-sm text-slate-500">Market is not enabled on this deployment.</p>
      ) : (
        <>
          {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}

          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Open asks</div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-400 text-[11px] uppercase">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Seller</th>
                  <th className="text-right font-medium px-3 py-2">Remaining</th>
                  <th className="text-right font-medium px-3 py-2">Unit price</th>
                  {canBuy && <th className="text-right font-medium px-3 py-2">Take</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {listings.map((l) => {
                  const own = wallet !== null && l.seller.toLowerCase() === wallet;
                  return (
                    <tr key={l.id}>
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{short(l.seller)}{own && <Pill tone="gray">you</Pill>}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700">{l.quantity}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{l.unitPrice} {l.currency}</td>
                      {canBuy && (
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1.5">
                            <input
                              className="input w-20 text-xs"
                              type="number"
                              min="1"
                              step="1"
                              placeholder="Qty"
                              disabled={own}
                              value={takeQty[l.id] ?? ""}
                              onChange={(e) => setTakeQty((s) => ({ ...s, [l.id]: e.target.value }))}
                            />
                            <button
                              disabled={busy || own || !posInt(takeQty[l.id] ?? "")}
                              title={own ? "your listing" : undefined}
                              onClick={() => void doTake(l)}
                              className="btn-sm border-slate-200 text-slate-600 hover:border-brand-500 disabled:opacity-40"
                            >
                              Take
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {listings.length === 0 && (
                  <tr>
                    <td colSpan={canBuy ? 4 : 3} className="px-3 py-3 text-center text-sm text-slate-400">No open asks.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {canList && user?.walletAddress && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Sell tokens</div>
              <div className="grid grid-cols-3 gap-3">
                <input className="input" type="number" min="1" step="1" placeholder="Quantity" value={sellQty} onChange={(e) => setSellQty(e.target.value)} />
                <input className="input" type="number" min="1" step="1" placeholder="Unit price" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} />
                <select className="select" value={sellCurrency} onChange={(e) => setSellCurrency(e.target.value)}>
                  <option value="">Currency…</option>
                  {currencies.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
              </div>
              <button
                disabled={busy || !sellReady}
                onClick={() => void doSell()}
                className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
              >
                {busy ? "Working…" : "List for sale"}
              </button>
            </div>
          )}

          {myListings.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">My listings</div>
              <ul className="space-y-1.5">
                {myListings.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 text-sm text-slate-600">
                    <span className="font-mono">{l.quantity}</span>
                    <span>@ {l.unitPrice} {l.currency}</span>
                    <span className="text-[11px] text-slate-400">{new Date(l.createdAt).toLocaleString()}</span>
                    {canCancelListing && (
                      <button
                        disabled={busy}
                        onClick={() => void doCancel(l.id)}
                        className="ml-auto btn-sm border-slate-200 text-slate-600 hover:border-red-400 disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Recent trades</div>
            <ol className="space-y-1.5">
              {trades.map((t, i) => (
                <li key={i} className="flex items-center gap-2 text-xs text-slate-600">
                  <span className="font-mono">{t.amount ?? "?"} @ {t.unitPrice ?? "?"} {t.currency ?? ""}</span>
                  <span className="text-slate-400">{short(t.from)} → {short(t.to)}</span>
                  {t.secondary && <Pill tone="green">secondary</Pill>}
                  <span className="ml-auto text-[11px] text-slate-400">{new Date(t.at).toLocaleString()}</span>
                </li>
              ))}
              {trades.length === 0 && <li className="text-xs text-slate-400">No trades yet.</li>}
            </ol>
          </div>
        </>
      )}
    </div>
  );
}

type OpField = { name: string; kind: "account" | "number" | "text"; optional?: boolean };

function Operations({
  role,
  useCase,
  isNft,
  accounts,
  busy,
  onRun,
}: {
  role: string;
  useCase: UseCase;
  isNft: boolean;
  accounts: AccountState[];
  busy: boolean;
  onRun: (action: string, body: Record<string, string>) => void;
}): JSX.Element | null {
  const showMint = useCase.lifecycle.mint && can(role as never, "mint");
  const showTransfer = useCase.lifecycle.transfer && can(role as never, "transfer");
  const showBurn = useCase.lifecycle.burn && can(role as never, "burn");
  if (!showMint && !showTransfer && !showBurn) return null;

  const fungible = {
    mint: [{ name: "to", kind: "account" }, { name: "amount", kind: "number" }] as OpField[],
    transfer: [{ name: "from", kind: "account" }, { name: "to", kind: "account" }, { name: "amount", kind: "number" }] as OpField[],
    burn: [{ name: "from", kind: "account" }, { name: "amount", kind: "number" }] as OpField[],
  };
  const nft = {
    mint: [{ name: "to", kind: "account" }, { name: "tokenId", kind: "text" }, { name: "uri", kind: "text", optional: true }] as OpField[],
    transfer: [{ name: "from", kind: "account" }, { name: "to", kind: "account" }, { name: "tokenId", kind: "text" }] as OpField[],
    burn: [{ name: "tokenId", kind: "text" }] as OpField[],
  };
  const fields = isNft ? nft : fungible;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {showMint && <OpForm title="Mint" fields={fields.mint} accounts={accounts} busy={busy} onSubmit={(b) => onRun("mint", b)} />}
      {showTransfer && <OpForm title="Transfer" fields={fields.transfer} accounts={accounts} busy={busy} onSubmit={(b) => onRun("transfer", b)} />}
      {showBurn && <OpForm title="Burn" fields={fields.burn} accounts={accounts} busy={busy} onSubmit={(b) => onRun("burn", b)} />}
    </div>
  );
}

function OpForm({
  title,
  fields,
  accounts,
  busy,
  onSubmit,
}: {
  title: string;
  fields: OpField[];
  accounts: AccountState[];
  busy: boolean;
  onSubmit: (body: Record<string, string>) => void;
}): JSX.Element {
  const [state, setState] = useState<Record<string, string>>({});
  const set = (k: string, v: string): void => setState((s) => ({ ...s, [k]: v }));
  const ready = fields.every((f) => f.optional || state[f.name]);

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 space-y-2.5">
      <div className="text-sm font-semibold text-slate-800">{title}</div>
      {fields.map((f) =>
        f.kind === "account" ? (
          <select key={f.name} className="select" value={state[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)}>
            <option value="">{f.name}…</option>
            {accounts.map((a) => (
              <option key={a.address} value={a.address}>
                {a.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            key={f.name}
            className="input"
            type={f.kind === "number" ? "number" : "text"}
            placeholder={f.optional ? `${f.name} (optional)` : f.name}
            value={state[f.name] ?? ""}
            onChange={(e) => set(f.name, e.target.value)}
          />
        ),
      )}
      <button disabled={busy || !ready} onClick={() => onSubmit(state)} className="w-full rounded-lg bg-brand-600 text-white py-1.5 text-xs font-medium hover:bg-brand-700 disabled:opacity-40">
        {title}
      </button>
    </div>
  );
}

/**
 * Renders `value` as a link to the chain's block explorer (address or tx page)
 * when the chain exposes one; otherwise renders it as plain text. Simulated
 * chains have no explorer, so their refs/hashes stay non-clickable.
 */
function ExplorerLink({
  chain,
  kind,
  value,
  children,
}: {
  chain?: ChainInfo;
  kind: "address" | "tx";
  value: string;
  children: React.ReactNode;
}): JSX.Element {
  // Only link genuine on-chain hex refs — never interpolate an untrusted value into an href.
  if (!chain?.explorerUrl || !/^0x[0-9a-fA-F]+$/.test(value)) return <>{children}</>;
  const href = `${chain.explorerUrl.replace(/\/$/, "")}/${kind}/${value}`;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline" title={`View on ${chain.label} explorer`}>
      {children}
    </a>
  );
}

function ChainPill({ chain }: { chain?: ChainInfo }): JSX.Element {
  const real = chain?.mode === "real";
  const tone = real ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600";
  return (
    <span className={`px-1.5 py-0.5 rounded font-medium ${tone}`}>
      {chain?.label ?? "unknown chain"}
      <span className="ml-1 opacity-70">{real ? "· on-chain" : "· simulated"}</span>
    </span>
  );
}

function Pill({ tone, children }: { tone: "red" | "green" | "gray"; children: React.ReactNode }): JSX.Element {
  const map = { red: "danger", green: "ok", gray: "muted" } as const;
  return (
    <span className="inline-block mx-0.5">
      <UIPill tone={map[tone]}>{children}</UIPill>
    </span>
  );
}

function summarize(e: AuditEntry): string {
  const p = e.payload;
  if (e.action === "issue") return `${String(p.name ?? "")} (${String(p.tokenStandard ?? p.useCaseKey ?? "")})`;
  if (e.action === "mint") return p.tokenId ? `#${String(p.tokenId)} → ${short(p.to)}` : `${String(p.amount)} → ${short(p.to)}`;
  if (e.action === "transfer") return p.tokenId ? `#${String(p.tokenId)} ${short(p.from)} → ${short(p.to)}` : `${String(p.amount)} ${short(p.from)} → ${short(p.to)}`;
  if (e.action === "burn") return p.tokenId ? `#${String(p.tokenId)}` : `${String(p.amount)} from ${short(p.from)}`;
  if (e.action === "freeze" || e.action === "unfreeze" || e.action === "allow" || e.action === "disallow") return short(p.account);
  if (e.action === "buy") return `${String(p.amount)} → ${short(p.to)} @ ${String(p.unitPrice)} ${String(p.currency)}`;
  return "";
}

function short(v: unknown): string {
  const s = String(v ?? "");
  return s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}
