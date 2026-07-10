import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import type { ActivityEvent, Asset, Listing, Portfolio, UseCase } from "../types.js";

type Tab = "offerings" | "portfolio" | "activity";

const fmt = (s: string | null): string => { try { return BigInt(String(s)).toLocaleString("en-IN"); } catch { return s ?? "—"; } };
const money = (by: Record<string, string>): string => Object.entries(by).filter(([, v]) => v !== "0").map(([c, v]) => `${fmt(v)} ${c}`).join(" · ") || "—";
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Investor experience for role Buyer: Offerings · Portfolio · Activity. */
export function InvestorPortal({ useCases }: { useCases: UseCase[] }): JSX.Element {
  const [tab, setTab] = useState<Tab>("offerings");
  const tabs: { id: Tab; label: string }[] = [
    { id: "offerings", label: "Offerings" },
    { id: "portfolio", label: "Portfolio" },
    { id: "activity", label: "Activity" },
  ];
  return (
    <div>
      <div className="flex gap-1 mb-5">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === t.id ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}>{t.label}</button>
        ))}
      </div>
      {tab === "offerings" && <InvestorOfferings useCases={useCases} onSubscribed={() => setTab("portfolio")} />}
      {tab === "portfolio" && <InvestorPortfolio />}
      {tab === "activity" && <InvestorActivity />}
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
      setNotice(`Subscribed: ${qty} units for ${fmt(r.paid.amount)} ${r.paid.currency}.`);
      setSelected(null); setQty("");
      await reload();
      onSubscribed();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Subscription failed");
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
      setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Purchase failed");
    } finally { setBusy(false); }
  }

  const uc = (key: string) => useCases.find((u) => u.key === key);
  const feeBps = selected ? uc(selected.useCaseKey)?.fees?.marketplaceBps ?? 0 : 0;
  const cost = selected && /^\d+$/.test(qty) ? BigInt(qty) * BigInt(selected.unitPrice ?? "0") : null;

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}
      {notice && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-2">{notice}</div>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {assets.map((a) => (
          <button key={a.id} onClick={() => { setSelected(a); setQty(""); }} className={`text-left bg-white rounded-xl border p-4 transition ${selected?.id === a.id ? "border-brand-500 shadow-sm" : "border-slate-200 hover:border-brand-500"}`}>
            <div className="font-medium text-slate-800">{a.name}</div>
            <div className="text-xs text-slate-400">{a.symbol} · {a.chainId}</div>
            <div className="mt-2 text-sm font-semibold text-slate-900">{fmt(a.unitPrice ?? null)} {a.currency}<span className="text-xs font-normal text-slate-400"> / unit</span></div>
            {a.availableSupply && <div className="text-[11px] text-slate-400">{fmt(a.availableSupply)} available</div>}
          </button>
        ))}
        {assets.length === 0 && <p className="text-sm text-slate-400 col-span-full">No open offerings right now.</p>}
      </div>

      {selected && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 max-w-xl space-y-3">
          <h3 className="font-semibold text-slate-900">Subscribe — {selected.name}</h3>
          <div className="text-xs text-slate-500 space-y-0.5">
            {Object.entries(selected.metadata).slice(0, 5).map(([k, v]) => (
              <div key={k}><span className="text-slate-400">{k}:</span> {typeof v === "string" && v.startsWith("http") ? <a className="text-brand-600 hover:underline" href={v} target="_blank" rel="noreferrer">document</a> : String(v)}</div>
            ))}
          </div>
          <div className="flex items-end gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">Quantity</span>
              <input className="input w-32" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
            <div className="text-sm text-slate-600 pb-2">
              {cost !== null && <>Total <span className="font-semibold text-slate-900">{cost.toLocaleString("en-IN")} {selected.currency}</span>{feeBps > 0 && <span className="text-[11px] text-slate-400"> (incl. {feeBps / 100}% exchange fee)</span>}</>}
            </div>
            <button onClick={() => void subscribe()} disabled={busy || !qty} className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50">{busy ? "Subscribing…" : "Subscribe"}</button>
          </div>
        </div>
      )}

      {listings.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-800 text-sm">Secondary market</div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {listings.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-2.5 text-slate-800">{l.assetName}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{fmt(l.quantity)} units @ {fmt(l.unitPrice)} {l.currency}</td>
                  <td className="px-4 py-2.5 text-right"><button onClick={() => void take(l.id, l.quantity)} disabled={busy} className="rounded-lg border border-brand-600 text-brand-700 px-3 py-1 text-xs font-medium hover:bg-brand-50 disabled:opacity-50">Buy all</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function InvestorPortfolio(): JSX.Element {
  const { token } = useAuth();
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    api.mePortfolio(token).then(setPf).catch((e) => setError(e instanceof ApiError && e.code === "NO_WALLET" ? "NO_WALLET" : "Could not load portfolio"));
  }, [token]);
  if (error === "NO_WALLET") return <NoWallet />;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!pf) return <p className="text-sm text-slate-400">Loading portfolio…</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Portfolio value" value={money(pf.totalByCurrency)} />
        {pf.cash.map((c) => <Stat key={c.currency} label={`Cash · ${c.currency}`} value={fmt(c.amount)} />)}
      </div>
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
            <tr><th className="text-left font-medium px-4 py-2.5">Asset</th><th className="text-right font-medium px-4 py-2.5">Units</th><th className="text-right font-medium px-4 py-2.5">Value</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pf.holdings.map((h) => (
              <tr key={h.assetId}>
                <td className="px-4 py-2.5 font-medium text-slate-800">{h.name} <span className="text-slate-400 font-normal">{h.symbol}</span></td>
                <td className="px-4 py-2.5 text-right font-mono">{fmt(h.units)}</td>
                <td className="px-4 py-2.5 text-right font-mono">{h.value ? `${fmt(h.value)} ${h.currency}` : "—"}</td>
              </tr>
            ))}
            {pf.holdings.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-sm text-slate-400">No holdings yet — subscribe to an offering.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvestorActivity(): JSX.Element {
  const { token } = useAuth();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    api.meActivity(token).then(setEvents).catch((e) => setError(e instanceof ApiError && e.code === "NO_WALLET" ? "NO_WALLET" : "Could not load activity"));
  }, [token]);
  if (error === "NO_WALLET") return <NoWallet />;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!events) return <p className="text-sm text-slate-400">Loading activity…</p>;
  const tone: Record<ActivityEvent["kind"], string> = { subscribed: "bg-brand-50 text-brand-700", received: "bg-emerald-100 text-emerald-700", sent: "bg-slate-100 text-slate-600", coupon: "bg-amber-100 text-amber-700", redemption: "bg-violet-100 text-violet-700" };
  return (
    <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
      {events.map((e, i) => (
        <div key={`${e.at}-${i}`} className="flex items-center gap-3 px-4 py-3 text-sm">
          <span className={`text-xs px-2 py-0.5 rounded-full ${tone[e.kind]}`}>{e.kind}</span>
          <span className="flex-1 text-slate-700"><span className="font-medium text-slate-900">{e.assetName}</span>{e.units && <> · {fmt(e.units)} units</>}{e.amount && <> · {fmt(e.amount)} {e.currency}</>}</span>
          <span className="text-xs text-slate-400">{ago(e.at)}</span>
        </div>
      ))}
      {events.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-400">No activity yet.</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-lg font-bold text-slate-900 mt-0.5 break-words">{value}</div>
    </div>
  );
}

function NoWallet(): JSX.Element {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">
      Your account has no linked wallet yet — contact your desk administrator to link one.
    </div>
  );
}
