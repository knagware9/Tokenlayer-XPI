import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { useRoute } from "../../router.js";
import type { AnalyticsSummary, Asset, ChainInfo, UseCase } from "../../types.js";
import { AreaChart } from "../charts/AreaChart.js";
import { BarChart } from "../charts/BarChart.js";
import { Donut, type DonutSlice } from "../charts/Donut.js";
import { Card, EmptyState, Pager, Pill, Skeleton, StatCard, TableShell, staggerClass, type IconName } from "../shared/ui.js";
import { AssetDetail } from "./AssetDetail.js";
import { availability } from "./AssetList.js";

const ASSET_PAGE_SIZE = 8;
const HOLDER_PAGE_SIZE = 8;
type AvailFilter = "all" | "available" | "sold-out" | "not-listed";

/** One holder's stake in one asset — the per-asset row `AssetDetail`'s own
 *  Holders table shows, pivoted here into "what does this ACCOUNT hold". */
interface Holding { assetId: string; assetName: string; assetSymbol: string; balance: string; frozen: boolean; allowed: boolean }
interface Holder { address: string; label: string; holdings: Holding[] }

function truncateAddr(v: string): string { return v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v; }

/** A small fixed palette so a given ledger keeps the same colour across charts. */
const LEDGER_COLORS: Record<string, string> = { besu: "#10b981", mst: "#6366f1", fabric: "#f59e0b", canton: "#8b5cf6" };
const colorFor = (chainId: string): string => LEDGER_COLORS[chainId] ?? "#64748b";

function fmtInt(s: string | number): string {
  try {
    return BigInt(String(s)).toLocaleString();
  } catch {
    return String(s);
  }
}

/** "INR 6,350,000 · USD 120,000" — no FX conversion, one entry per currency. */
function fmtMoney(byCurrency: Record<string, string>): string {
  const parts = Object.entries(byCurrency).filter(([, v]) => v !== "0");
  if (parts.length === 0) return "—";
  return parts.map(([cur, amt]) => `${fmtInt(amt)} ${cur}`).join(" · ");
}

export function Dashboard({ useCaseKey, useCases, chains }: { useCaseKey?: string; useCases: UseCase[]; chains: ChainInfo[] }): JSX.Element {
  const { token } = useAuth();
  const { navigate } = useRoute();
  const [data, setData] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [showAssets, setShowAssets] = useState(false);
  const [availFilter, setAvailFilter] = useState<AvailFilter>("all");
  const [assetQuery, setAssetQuery] = useState("");
  const [assetPage, setAssetPage] = useState(1);
  const [detailAssetId, setDetailAssetId] = useState<string | null>(null);
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [holdersLoading, setHoldersLoading] = useState(false);
  const [showHolders, setShowHolders] = useState(false);
  const [holderQuery, setHolderQuery] = useState("");
  const [holderPage, setHolderPage] = useState(1);
  const [detailHolderAddress, setDetailHolderAddress] = useState<string | null>(null);
  // A stat card's target section is often already fully in view on a short page —
  // scrollIntoView then produces no visible motion at all, and the click reads as
  // dead. The flash gives every click a visible result whether or not it scrolled.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const scrollTo = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlightedId(id);
    setTimeout(() => setHighlightedId((cur) => (cur === id ? null : cur)), 1400);
  };
  const flash = (id: string): string =>
    `scroll-mt-4 rounded-2xl transition-shadow duration-500 ${highlightedId === id ? "ring-2 ring-brand-400 shadow-lg" : "ring-2 ring-transparent"}`;

  useEffect(() => {
    if (!token) return;
    setData(null);
    setError(null);
    api
      .analytics(token, { ...(useCaseKey ? { useCaseKey } : {}) })
      .then(setData)
      .catch(() => setError("Could not load analytics"));
  }, [token, useCaseKey]);

  const reloadAssets = (): void => {
    if (!token) return;
    void api.assets(token, useCaseKey).then(setAssets).catch(() => setAssets([]));
  };
  useEffect(reloadAssets, [token, useCaseKey]);

  // Lazy: there is no single "holders of this use case" endpoint, only a
  // per-asset one — building the roster means one call per asset, so it only
  // runs once the Holders tile is actually opened, not on every dashboard load.
  useEffect(() => {
    if (!showHolders || !token || !assets || holders !== null) return;
    setHoldersLoading(true);
    void Promise.all(assets.map((a) =>
      api.assetAccounts(token, a.id)
        .then((accs) => accs
          .filter((acc) => { try { return BigInt(acc.balance || "0") > 0n; } catch { return acc.balance !== "0"; } })
          .map((acc) => ({ ...acc, assetId: a.id, assetName: a.name, assetSymbol: a.symbol })))
        .catch(() => []),
    )).then((perAsset) => {
      const byAddress = new Map<string, Holder>();
      for (const rows of perAsset) {
        for (const r of rows) {
          const holding: Holding = { assetId: r.assetId, assetName: r.assetName, assetSymbol: r.assetSymbol, balance: r.balance, frozen: r.frozen, allowed: r.allowed };
          const existing = byAddress.get(r.address);
          if (existing) existing.holdings.push(holding);
          else byAddress.set(r.address, { address: r.address, label: r.label, holdings: [holding] });
        }
      }
      setHolders([...byAddress.values()]);
      setHoldersLoading(false);
    });
  }, [showHolders, token, assets, holders]);

  if (detailAssetId) {
    return (
      <AssetDetail
        assetId={detailAssetId}
        useCases={useCases}
        chains={chains}
        onBack={() => setDetailAssetId(null)}
        onChanged={reloadAssets}
      />
    );
  }

  if (detailHolderAddress) {
    const h = holders?.find((x) => x.address === detailHolderAddress);
    if (!h) { setDetailHolderAddress(null); return <></>; }
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => setDetailHolderAddress(null)} className="text-sm text-muted hover:text-fg inline-flex items-center gap-1.5">
          ← Back to holders
        </button>
        <div>
          <h2 className="font-display text-lg font-bold text-fg">{h.label}</h2>
          <p className="text-xs font-mono text-muted break-all">{h.address}</p>
        </div>
        <Card title={`Holdings (${h.holdings.length})`}>
          <TableShell>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Balance</th>
                <th>Price</th>
                <th>Value</th>
                <th>Chain</th>
                <th>State</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {h.holdings.map((hold) => {
                const asset = (assets ?? []).find((a) => a.id === hold.assetId);
                const chain = chains.find((c) => c.id === asset?.chainId);
                // Not listed for sale ⇒ no price, so no value either — same
                // "—" the Assets table already shows for an unpriced asset,
                // never a fabricated 0.
                const priced = asset?.unitPrice && asset.currency;
                const value = priced ? Number(hold.balance) * Number(asset.unitPrice) : null;
                return (
                  <tr key={hold.assetId}>
                    <td>
                      <div className="font-medium text-fg">{hold.assetName}</div>
                      <div className="text-muted">{hold.assetSymbol}</div>
                    </td>
                    <td className="num text-fg">{fmtInt(hold.balance)}</td>
                    <td className="num text-muted">{priced ? `${asset.unitPrice} ${asset.currency}` : "—"}</td>
                    <td className="num text-fg">{value !== null && Number.isFinite(value) ? `${value.toLocaleString()} ${asset!.currency}` : "—"}</td>
                    <td className="text-muted">{chain?.label ?? asset?.chainId ?? "—"}</td>
                    <td>
                      {hold.frozen && <Pill tone="danger">frozen</Pill>}
                      {!hold.frozen && hold.allowed && <Pill tone="ok">allowed</Pill>}
                      {!hold.frozen && !hold.allowed && <span className="text-muted">—</span>}
                    </td>
                    <td className="text-right">
                      <button onClick={() => setDetailAssetId(hold.assetId)} className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:border-brand-400">
                        View asset
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        </Card>
      </div>
    );
  }

  if (error) return <Card><p className="text-sm text-danger">{error}</p></Card>;
  if (!data)
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i}><Skeleton lines={2} /></Card>
          ))}
        </div>
        <Card><Skeleton lines={4} /></Card>
      </div>
    );

  if (data.totals.assets === 0) {
    return (
      <div className="space-y-3">
        <Card>
          <EmptyState
            icon="coins"
            title="No assets yet"
            hint="Issue an asset to see cross-ledger analytics — supply, holders, value and trading activity."
          />
        </Card>
      </div>
    );
  }

  const t = data.totals;
  const ledgerSlices: DonutSlice[] = data.byLedger.map((l) => ({ label: l.chainId, value: Number(l.supply), color: colorFor(l.chainId) }));
  const activityPoints = data.activity.map((a) => ({ label: a.date, value: a.count }));

  const openAssets = (filter: AvailFilter): void => {
    setAvailFilter(filter);
    setAssetPage(1);
    setShowAssets(true);
    scrollTo("dash-assets");
  };
  const openHolders = (): void => {
    setHolderPage(1);
    setShowHolders(true);
    scrollTo("dash-holders");
  };

  const q = assetQuery.trim().toLowerCase();
  const filteredAssets = (assets ?? []).filter((a) =>
    (availFilter === "all" || availability(a) === availFilter) &&
    (!q || a.name.toLowerCase().includes(q) || a.symbol.toLowerCase().includes(q)));
  const pagedAssets = filteredAssets.slice((assetPage - 1) * ASSET_PAGE_SIZE, assetPage * ASSET_PAGE_SIZE);
  const chainOf = (id: string): ChainInfo | undefined => chains.find((c) => c.id === id);

  const hq = holderQuery.trim().toLowerCase();
  const filteredHolders = (holders ?? []).filter((h) =>
    !hq || h.label.toLowerCase().includes(hq) || h.address.toLowerCase().includes(hq));
  const pagedHolders = filteredHolders.slice((holderPage - 1) * HOLDER_PAGE_SIZE, holderPage * HOLDER_PAGE_SIZE);

  return (
    <div className="space-y-4">
      {/* headline cards — click to drill into the matching breakdown */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat icon="coins" label="Tokenized value" value={fmtMoney(t.valueByCurrency)} sub={`${t.assets} assets · ${t.useCases} use case${t.useCases === 1 ? "" : "s"}`} onClick={() => openAssets("all")} stagger={1} />
        <Stat icon="spark" label="Total supply" value={fmtInt(t.supply)} sub="minted − burned" onClick={() => openAssets("all")} stagger={2} primary />
        <Stat icon="users" label="Holders" value={String(t.holders)} sub="distinct accounts" onClick={openHolders} stagger={3} />
        <Stat icon="arrow" label={`Traded (${data.activity.length}d)`} value={fmtMoney(t.tradedByCurrency)} sub={`${t.trades} trade${t.trades === 1 ? "" : "s"}`} onClick={() => scrollTo("dash-recent")} stagger={4} />
      </div>

      {showAssets && (
        <div id="dash-assets" className={flash("dash-assets")}>
          <Card title="Assets">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <input
                value={assetQuery}
                onChange={(e) => { setAssetQuery(e.target.value); setAssetPage(1); }}
                placeholder="Search name or symbol…"
                className="rounded-lg border border-border bg-elevated/80 px-2.5 py-1 text-xs flex-1 min-w-[160px] focus:outline-none focus:border-primary focus:bg-surface focus:ring-4 focus:ring-primary/15"
              />
              {([
                ["all", "All"], ["available", "Listed"], ["sold-out", "Sold out"], ["not-listed", "Not listed"],
              ] as const).map(([key, label]) => (
                <button key={key} onClick={() => { setAvailFilter(key); setAssetPage(1); }}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium ${availFilter === key ? "bg-primary text-white border-primary" : "bg-surface text-muted border-border hover:bg-elevated"}`}>
                  {label}
                </button>
              ))}
            </div>
            {assets === null ? (
              <Skeleton lines={4} />
            ) : filteredAssets.length === 0 ? (
              <EmptyState icon="coins" title="No assets match" hint="Try a different filter or search term." />
            ) : (
              <>
                <TableShell>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Type</th>
                      <th>Price</th>
                      <th>Supply</th>
                      <th>Chain</th>
                      <th>Availability</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedAssets.map((a) => {
                      const avail = availability(a);
                      const chain = chainOf(a.chainId);
                      return (
                        <tr key={a.id}>
                          <td>
                            <div className="font-medium text-fg">{a.name}</div>
                            <div className="text-muted">{a.symbol}</div>
                          </td>
                          <td className="text-muted">{a.tokenType}</td>
                          <td className="num text-fg">{a.unitPrice ? `${a.unitPrice} ${a.currency}` : "—"}</td>
                          <td className="num text-fg">{a.totalSupply ? fmtInt(a.totalSupply) : "—"}</td>
                          <td>
                            <span title={a.contractRef}>
                              <Pill tone={chain?.mode === "real" ? "ok" : "muted"}>{chain?.label ?? a.chainId}</Pill>
                            </span>
                          </td>
                          <td>
                            {avail === "available" && <Pill tone="ok">Available</Pill>}
                            {avail === "sold-out" && <Pill tone="warn">Sold out</Pill>}
                            {avail === "not-listed" && <Pill tone="muted">Not listed</Pill>}
                          </td>
                          <td className="text-right">
                            <button onClick={() => setDetailAssetId(a.id)} className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:border-brand-400">
                              View
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableShell>
                <Pager page={assetPage} pageSize={ASSET_PAGE_SIZE} total={filteredAssets.length} onPage={setAssetPage} />
              </>
            )}
          </Card>
        </div>
      )}

      {showHolders && (
        <div id="dash-holders" className={flash("dash-holders")}>
          <Card title="Holders">
            <input
              value={holderQuery}
              onChange={(e) => { setHolderQuery(e.target.value); setHolderPage(1); }}
              placeholder="Search name or address…"
              className="rounded-lg border border-border bg-elevated/80 px-2.5 py-1 text-xs w-full mb-3 focus:outline-none focus:border-primary focus:bg-surface focus:ring-4 focus:ring-primary/15"
            />
            {holdersLoading || holders === null ? (
              <Skeleton lines={4} />
            ) : filteredHolders.length === 0 ? (
              <EmptyState icon="users" title="No holders match" hint="Try a different search term, or nobody holds a balance yet." />
            ) : (
              <>
                <TableShell>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Assets held</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedHolders.map((h) => (
                      <tr key={h.address}>
                        <td>
                          <div className="font-medium text-fg">{h.label}</div>
                          <div className="text-muted font-mono">{truncateAddr(h.address)}</div>
                        </td>
                        <td className="num text-fg">{h.holdings.length}</td>
                        <td className="text-right">
                          <button onClick={() => setDetailHolderAddress(h.address)} className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:border-brand-400">
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
                <Pager page={holderPage} pageSize={HOLDER_PAGE_SIZE} total={filteredHolders.length} onPage={setHolderPage} />
              </>
            )}
          </Card>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <div id="dash-ledger" className={flash("dash-ledger")}>
          <Card title="Supply by ledger">
            <Donut slices={ledgerSlices} />
          </Card>
        </div>
        <Card title={`Activity — transactions / day (${data.activity.length}d)`}>
          <AreaChart points={activityPoints} />
          <div className="flex justify-between text-[0.75rem] text-muted mt-1">
            <span>{data.activity[0]?.date}</span>
            <span>{data.activity[data.activity.length - 1]?.date}</span>
          </div>
        </Card>
      </div>

      {data.scope === "platform" && data.byUseCase.length > 0 && (
        <div id="dash-usecases" className={flash("dash-usecases")}>
          <Card title="By use case">
            <TableShell>
              <thead>
                <tr>
                  <th>Use case</th>
                  <th>Ledger</th>
                  <th>Supply</th>
                  <th>Holders</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {data.byUseCase.map((u) => (
                  <tr key={u.useCaseKey} onClick={() => navigate(`/${u.useCaseKey}`)} title={`Open ${u.name}`} className="cursor-pointer">
                    <td className="font-medium text-fg">
                      {u.name} <span className="font-normal text-muted">{u.symbol}</span>
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorFor(u.chainId) }} />
                        <span className="text-muted">{u.chainId}</span>
                      </span>
                    </td>
                    <td className="num text-fg">{fmtInt(u.supply)}</td>
                    <td className="num text-fg">{u.holders}</td>
                    <td className="num text-muted">{fmtMoney(u.valueByCurrency)}</td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </Card>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Supply by ledger (detail)">
          <BarChart bars={data.byLedger.map((l) => ({ label: `${l.chainId} · ${l.mode}`, value: Number(l.supply) }))} />
        </Card>
        <div id="dash-recent" className={flash("dash-recent")}>
          <Card title="Recent activity">
            <ol className="space-y-0 divide-y divide-border">
              {data.recent.slice(0, 8).map((e, i) => {
                const clickable = !!e.useCaseKey;
                const ACTION_COLORS: Record<string, string> = {
                  mint: "bg-success/10 text-success border-success/25",
                  burn: "bg-danger/10 text-danger border-danger/25",
                  transfer: "bg-sky-500/10 text-sky-600 border-sky-500/25",
                  issue: "bg-brand-50 text-brand-700 border-brand-200/70",
                };
                const actionStyle = ACTION_COLORS[e.action.toLowerCase()] ?? "bg-elevated text-muted border-border";
                return (
                  <li
                    key={`${e.at}-${e.assetId}-${i}`}
                    onClick={clickable ? () => navigate(`/${e.useCaseKey}`) : undefined}
                    title={clickable ? `Open ${e.assetName}` : undefined}
                    className={`flex items-center gap-3 py-2.5 first:pt-0 last:pb-0 text-xs ${clickable ? "cursor-pointer hover:bg-elevated/80 -mx-2 px-2 rounded-lg transition-colors" : ""}`}
                  >
                    <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[0.75rem] font-semibold ${actionStyle}`}>
                      {e.action}
                    </span>
                    <span className="flex-1 min-w-0 text-muted truncate">
                      <span className="font-semibold text-fg">{e.assetName}</span>
                      <span className="text-muted"> · </span>
                      {e.summary}
                    </span>
                    <span className="font-data text-[0.75rem] text-muted shrink-0">{new Date(e.at).toLocaleDateString()}</span>
                  </li>
                );
              })}
              {data.recent.length === 0 && (
                <li className="text-xs text-muted py-4 text-center">No activity yet.</li>
              )}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, sub, onClick, stagger, primary }: { icon: IconName; label: string; value: string; sub?: string; onClick?: () => void; stagger?: number; primary?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left w-full cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md rounded-2xl ${staggerClass(stagger)}`}
    >
      <StatCard icon={icon} label={label} value={value} sub={sub} emphasis={primary ? "primary" : "default"} />
    </button>
  );
}
