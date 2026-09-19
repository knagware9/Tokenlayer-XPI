import { useCallback, useEffect, useState } from "react";
import { api, ApiError, describeApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { ActivityEvent, Asset, ChainInfo, Holding, Listing, Portfolio, UseCase } from "../../types.js";
import { Card, EmptyState, Skeleton, StatCard, TableShell } from "../shared/ui.js";
import { AssetDetail } from "./AssetDetail.js";

type Tab = "offerings" | "portfolio" | "activity";

const fmt = (s: string | null): string => { try { return BigInt(String(s)).toLocaleString("en-IN"); } catch { return s ?? "—"; } };
const money = (by: Record<string, string>): string => Object.entries(by).filter(([, v]) => v !== "0").map(([c, v]) => `${fmt(v)} ${c}`).join(" · ") || "—";
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Investor experience for role Buyer: Offerings · Portfolio · Activity.
 * When `tab` is supplied the tab is driven by the shell (its centered tab row
 * is hidden); otherwise it self-manages the tab with an internal row. */
export function InvestorPortal({ useCases, chains, tab: controlledTab, onTabChange }: { useCases: UseCase[]; chains: ChainInfo[]; tab?: Tab; onTabChange?: (tab: Tab) => void }): JSX.Element {
  const [internalTab, setInternalTab] = useState<Tab>("offerings");
  const tab = controlledTab ?? internalTab;
  const tabs: { id: Tab; label: string }[] = [
    { id: "offerings", label: "Marketplace" },
    { id: "portfolio", label: "My Portfolio" },
    { id: "activity", label: "Activity" },
  ];
  return (
    <div>
      {controlledTab === undefined && (
        <div className="flex gap-1 mb-5">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setInternalTab(t.id)} className={`rounded-full border px-3 py-1.5 text-xs font-medium ${tab === t.id ? "bg-primary text-white border-primary" : "bg-surface text-muted border-border hover:bg-elevated"}`}>{t.label}</button>
          ))}
        </div>
      )}
      {tab === "offerings" && <InvestorOfferings useCases={useCases} onSubscribed={() => { setInternalTab("portfolio"); onTabChange?.("portfolio"); }} />}
      {tab === "portfolio" && <InvestorPortfolio useCases={useCases} chains={chains} />}
      {tab === "activity" && <InvestorActivity useCases={useCases} />}
    </div>
  );
}

function InvestorOfferings({ useCases, onSubscribed }: { useCases: UseCase[]; onSubscribed: () => void }): JSX.Element {
  const { token } = useAuth();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [listings, setListings] = useState<(Listing & { assetId: string; assetName: string })[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    const all = await api.assets(token);
    const onSale = all.filter((a) => a.status === "active" && a.unitPrice && BigInt(a.unitPrice) > 0n);
    setAssets(onSale);
    const ls = await Promise.all(all.filter((a) => a.status === "active").map(async (a) =>
      (await api.listings(token, a.id).catch(() => [])).filter((l) => (l.status ?? "open") === "open").map((l) => ({ ...l, assetId: a.id, assetName: a.name }))));
    setListings(ls.flat());
  }, [token]);
  useEffect(() => { void reload(); }, [reload]);

  async function subscribe(): Promise<void> {
    if (!token || !selected || !qty) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.buy(token, selected.id, qty);
      setNotice(`Bought ${qty} units for ${fmt(r.paid.amount)} ${r.paid.currency}.`);
      setSelected(null); setQty("");
      await reload();
      onSubscribed();
    } catch (err) {
      setError(describeApiError(err, "Purchase failed"));
    } finally { setBusy(false); }
  }

  async function take(listingId: string, quantity: string): Promise<void> {
    if (!token) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.takeListing(token, listingId, quantity);
      setNotice(`Bought ${quantity} units from the secondary market.`);
      await reload();
      onSubscribed();
    } catch (err) {
      setError(describeApiError(err, "Purchase failed"));
    } finally { setBusy(false); }
  }

  const uc = (key: string) => useCases.find((u) => u.key === key);
  const feeBps = selected ? uc(selected.useCaseKey)?.fees?.marketplaceBps ?? 0 : 0;
  const cost = selected && /^\d+$/.test(qty) ? BigInt(qty) * BigInt(selected.unitPrice ?? "0") : null;

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg bg-danger/10 border border-danger/25 text-danger text-sm px-4 py-2">{error}</div>}
      {notice && <div className="rounded-lg bg-success/10 border border-success/25 text-success text-sm px-4 py-2">{notice}</div>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {assets.map((a) => (
          <button key={a.id} onClick={() => { setSelected(a); setQty(""); }} className={`text-left bg-surface rounded-xl border p-4 transition ${selected?.id === a.id ? "border-brand-500 shadow-sm" : "border-border hover:border-brand-500"}`}>
            <div className="font-medium text-fg">{a.name}</div>
            <div className="text-xs text-muted">{a.symbol} · {a.chainId}</div>
            <div className="mt-2 text-sm font-semibold text-fg">{fmt(a.unitPrice ?? null)} {a.currency}<span className="text-xs font-normal text-muted"> / unit</span></div>
            {a.availableSupply && <div className="text-[11px] text-muted">{fmt(a.availableSupply)} available</div>}
          </button>
        ))}
        {assets.length === 0 && (
          <div className="col-span-full">
            <Card>
              <EmptyState icon="coins" title="No open offerings right now" hint="New primary offerings appear here as soon as an issuer lists them." />
            </Card>
          </div>
        )}
      </div>

      {selected && (
        <div className="bg-surface rounded-2xl border border-border/80 shadow-sm p-5 max-w-xl space-y-3">
          <h3 className="font-semibold text-fg">Buy — {selected.name}</h3>
          <div className="text-xs text-muted space-y-0.5">
            {Object.entries(selected.metadata).slice(0, 5).map(([k, v]) => (
              <div key={k}><span className="text-muted">{k}:</span> {typeof v === "string" && v.startsWith("http") ? <a className="text-brand-600 hover:underline" href={v} target="_blank" rel="noreferrer">document</a> : String(v)}</div>
            ))}
          </div>
          <div className="flex items-end gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-muted mb-1">Quantity</span>
              <input className="input w-32" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
            <div className="text-sm text-muted pb-2">
              {cost !== null && <>Total <span className="font-semibold text-fg">{cost.toLocaleString("en-IN")} {selected.currency}</span>{feeBps > 0 && <span className="text-[11px] text-muted"> (incl. {feeBps / 100}% exchange fee)</span>}</>}
            </div>
            <button onClick={() => void subscribe()} disabled={busy || !qty} className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50">{busy ? "Buying…" : "Buy"}</button>
          </div>
        </div>
      )}

      {listings.length > 0 && (
        <div className="bg-surface rounded-2xl border border-border/80 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-border font-semibold text-fg text-sm">Secondary market</div>
          <TableShell>
            <tbody>
              {listings.map((l) => (
                <tr key={l.id}>
                  <td className="text-fg">{l.assetName}</td>
                  <td className="num">{fmt(l.quantity)} units @ {fmt(l.unitPrice)} {l.currency}</td>
                  <td className="text-right"><button onClick={() => void take(l.id, l.quantity)} disabled={busy} className="rounded-lg border border-brand-600 text-brand-700 px-3 py-1 text-xs font-medium hover:bg-brand-50 disabled:opacity-50">Buy all</button></td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </div>
      )}
    </div>
  );
}

function InvestorPortfolio({ useCases, chains }: { useCases: UseCase[]; chains: ChainInfo[] }): JSX.Element {
  const { token } = useAuth();
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selling, setSelling] = useState<Holding | null>(null);
  const [detailAssetId, setDetailAssetId] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!token) return;
    try {
      setPf(await api.mePortfolio(token));
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof ApiError && e.code === "NO_WALLET" ? "NO_WALLET" : "Could not load portfolio");
    }
  }, [token]);
  useEffect(() => { void reload(); }, [reload]);
  if (detailAssetId) {
    return <AssetDetail assetId={detailAssetId} useCases={useCases} chains={chains} onBack={() => setDetailAssetId(null)} onChanged={reload} />;
  }
  if (error === "NO_WALLET") return <NoWallet />;
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!pf)
    return (
      <Card>
        <Skeleton lines={4} />
      </Card>
    );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard icon="coins" label="Portfolio value" value={money(pf.totalByCurrency)} />
        {pf.cash.map((c) => <StatCard key={c.currency} icon="spark" label={`Cash · ${c.currency}`} value={fmt(c.amount)} />)}
      </div>
      <TableShell>
        <thead>
          <tr><th>Asset</th><th>Units</th><th>Value</th><th></th></tr>
        </thead>
        <tbody>
          {pf.holdings.map((h) => (
            <tr key={h.assetId} className="cursor-pointer" onClick={() => setDetailAssetId(h.assetId)}>
              <td className="font-medium text-fg">{h.name} <span className="text-muted font-normal">{h.symbol}</span></td>
              <td className="num">{fmt(h.units)}</td>
              <td className="num">{h.value ? `${fmt(h.value)} ${h.currency}` : "—"}</td>
              <td className="text-right">
                <div className="flex justify-end gap-3">
                  <button onClick={(e) => { e.stopPropagation(); setSelling(h); }} className="text-xs text-brand-600 hover:text-brand-700 font-medium">Sell</button>
                  <button onClick={(e) => { e.stopPropagation(); setDetailAssetId(h.assetId); }} className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:border-brand-400">View</button>
                </div>
              </td>
            </tr>
          ))}
          {pf.holdings.length === 0 && (
            <tr>
              <td colSpan={4}>
                <EmptyState icon="doc" title="No holdings yet" hint="Buy from the Marketplace to build your portfolio." />
              </td>
            </tr>
          )}
        </tbody>
      </TableShell>
      {selling && <SellPanel holding={selling} onDone={() => { setSelling(null); void reload(); }} onClose={() => setSelling(null)} />}
      <MyListings wallet={pf.wallet} holdings={pf.holdings} refreshKey={refreshKey} reload={() => void reload()} />
    </div>
  );
}

function SellPanel({ holding, onDone, onClose }: { holding: Holding; onDone: () => void; onClose: () => void }): JSX.Element {
  const { token } = useAuth();
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState(holding.unitPrice ?? "");
  const [currency, setCurrency] = useState(holding.currency ?? "CBDC-INR");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function sell(): Promise<void> {
    setError(null); setBusy(true);
    try { await api.createListing(token!, holding.assetId, { quantity, unitPrice, currency }); onDone(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Listing failed"); }
    finally { setBusy(false); }
  }
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-fg">Sell — {holding.name}</h3>
        <button onClick={onClose} className="text-xs text-muted hover:text-fg">Close</button>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <input className="input" type="number" placeholder={`quantity (≤ ${holding.units})`} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <input className="input" type="number" placeholder="unit price" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
        <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {["CBDC-INR", "USDC", "e-GBP"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {error && <p className="text-xs text-danger mt-2">{error}</p>}
      <button onClick={() => void sell()} disabled={busy || !quantity || !unitPrice}
        className="mt-3 rounded-lg bg-brand-600 text-white px-4 py-1.5 text-xs font-medium hover:bg-brand-700 disabled:opacity-40">List for sale</button>
    </Card>
  );
}

function MyListings({ wallet, holdings, refreshKey, reload }: { wallet: string; holdings: Holding[]; refreshKey: number; reload: () => void }): JSX.Element | null {
  const { token } = useAuth();
  const [mine, setMine] = useState<Array<Listing & { assetName: string; assetId: string }>>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  // NOTE: We only know asset ids from the current holdings, so this iterates pf.holdings.
  // Edge case: selling ALL units of an asset escrows them out of the seller's balance, so the
  // asset can drop out of pf.holdings and its open listing would then stop showing here. Partial
  // sells (the common case) keep the holding visible. Accepted limitation for this task — there is
  // no "my open listings" endpoint to enumerate listings independent of current holdings.
  useEffect(() => {
    if (!token) return;
    void Promise.all(holdings.map(async (h) => (await api.listings(token, h.assetId).catch(() => []))
      .filter((l) => l.seller.toLowerCase() === wallet.toLowerCase() && (l.status ?? "open") === "open")
      .map((l) => ({ ...l, assetName: h.name, assetId: h.assetId }))))
      .then((groups) => setMine(groups.flat()));
  }, [token, wallet, holdings, refreshKey]);
  if (mine.length === 0) return null;
  return (
    <Card>
      <h3 className="text-sm font-semibold text-fg mb-2">My listings</h3>
      {mine.map((l) => {
        const h = holdings.find((x) => x.assetId === l.assetId);
        return (
          <div key={l.id} className="py-1.5 border-t border-border text-sm">
            <div className="flex items-center justify-between">
              <span>{l.assetName} · {l.quantity} @ {l.unitPrice} {l.currency}</span>
              <div className="flex items-center gap-3">
                <button onClick={() => setExpanded((cur) => (cur === l.id ? null : l.id))} className="text-xs text-brand-600 hover:text-brand-700">
                  {expanded === l.id ? "Hide" : "View"}
                </button>
                <button onClick={() => void api.cancelListing(token!, l.id).then(() => { setMine((m) => m.filter((x) => x.id !== l.id)); reload(); })}
                  className="text-xs text-danger hover:opacity-70">Cancel</button>
              </div>
            </div>
            {expanded === l.id && (
              <div className="mt-2 mb-1 rounded-lg bg-elevated border border-border px-3 py-2 text-xs text-muted grid grid-cols-2 gap-1.5">
                <div><span className="text-muted">Symbol:</span> {h?.symbol ?? "—"}</div>
                <div><span className="text-muted">Chain:</span> {h?.chainId ?? "—"}</div>
                <div><span className="text-muted">Use case:</span> {h?.useCaseKey ?? "—"}</div>
                <div><span className="text-muted">Listing ID:</span> <span className="font-mono">{l.id}</span></div>
                <div><span className="text-muted">Seller:</span> <span className="font-mono">{l.seller}</span></div>
                <div><span className="text-muted">Status:</span> {l.status ?? "open"}</div>
                <div><span className="text-muted">Created:</span> {new Date(l.createdAt).toLocaleString()}</div>
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

const short = (v: string | null): string => (v ? `${v.slice(0, 8)}…${v.slice(-4)}` : "—");

function InvestorActivity({ useCases }: { useCases: UseCase[] }): JSX.Element {
  const { token } = useAuth();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    api.meActivity(token).then(setEvents).catch((e) => setError(e instanceof ApiError && e.code === "NO_WALLET" ? "NO_WALLET" : "Could not load activity"));
  }, [token]);
  if (error === "NO_WALLET") return <NoWallet />;
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!events)
    return (
      <Card>
        <Skeleton lines={4} />
      </Card>
    );
  if (events.length === 0)
    return (
      <div className="bg-surface rounded-2xl border border-border/80 shadow-sm">
        <EmptyState icon="spark" title="No activity yet" hint="Purchases, transfers and coupon payments show up here." />
      </div>
    );
  const tone: Record<ActivityEvent["kind"], string> = { subscribed: "bg-brand-50 text-brand-700", received: "bg-success/10 text-success", sent: "bg-elevated text-muted", coupon: "bg-warning/10 text-warning", redemption: "bg-violet-100 text-violet-700", listed: "bg-sky-100 text-sky-700", sold: "bg-success/10 text-success" };
  const projectOf = (key: string): string => useCases.find((u) => u.key === key)?.name ?? key;
  return (
    <div className="bg-surface rounded-2xl border border-border/80 shadow-sm">
      <TableShell>
        <thead>
          <tr>
            <th>Type</th>
            <th>Transaction ID</th>
            <th>Asset</th>
            <th>Project</th>
            <th>Token ID</th>
            <th>Seller</th>
            <th>Buyer</th>
            <th>Amount</th>
            <th>Blockchain tx</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={`${e.id}-${i}`}>
              <td><span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${tone[e.kind]}`}>{e.kind}</span></td>
              <td className="font-mono text-xs text-muted" title={e.id}>{short(e.id)}</td>
              <td className="font-medium text-fg">{e.assetName}{e.units && <span className="text-muted font-normal"> · {fmt(e.units)}</span>}</td>
              <td className="text-muted">{projectOf(e.useCaseKey)}</td>
              <td className="font-mono text-xs text-muted">{e.tokenId ?? "—"}</td>
              <td className="font-mono text-xs text-muted" title={e.from ?? undefined}>{short(e.from)}</td>
              <td className="font-mono text-xs text-muted" title={e.to ?? undefined}>{short(e.to)}</td>
              <td className="num text-fg">{e.amount ? `${fmt(e.amount)} ${e.currency}` : "—"}</td>
              <td className="font-mono text-xs text-muted" title={e.txHash ?? undefined}>{short(e.txHash)}</td>
              <td className="text-right text-xs text-muted" title={new Date(e.at).toLocaleString()}>{ago(e.at)}</td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  );
}

function NoWallet(): JSX.Element {
  return (
    <Card>
      <EmptyState
        icon="users"
        title="No linked wallet yet"
        hint="Contact your desk administrator to link a wallet to your account."
      />
    </Card>
  );
}
