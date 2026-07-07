import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import { can } from "../rbac.js";
import { computeFingerprint } from "./InvoiceImport.js";
import type { Asset, Financing, Role, TierChainNode, UseCase } from "../types.js";

// ============================================================================
// Financing panel — the operator desk's view of an invoice's financing
// lifecycle: finance / mark-repaid, extend-to-sub-supplier (deep-tier), and the
// tier chain. Rendered only for invoice-type NFT assets (see isInvoiceUseCase).
// ============================================================================

const INVOICE_FIELDS = ["invoiceHash", "invoiceNumber", "sellerGstin", "buyerGstin", "amountInr", "dueDate"];

/** True for a non-fungible use case whose schema carries the canonical invoice fields. */
export function isInvoiceUseCase(u: UseCase | undefined): u is UseCase {
  return !!u && u.tokenType === "nonfungible" && INVOICE_FIELDS.every((f) => f in (u.metadataSchema?.properties ?? {}));
}

/** Deep-tier child amount cap as a % of the parent face — the server enforces the real value. */
const DEEP_TIER_CAP_PCT = 80;

const inr = (v: unknown): string => `₹${Number(v).toLocaleString()}`;

function short(v: unknown): string {
  const s = String(v ?? "");
  return s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

function shortGstin(v: unknown): string {
  const s = String(v ?? "");
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-2)}` : s || "?";
}

/** floor(face × (1 − ratePct/100 × tenorDays/365)) — mirrors the server's integer discount. */
function discountedInr(face: number, ratePct: number, tenorDays: number): number {
  if (!Number.isFinite(face) || !Number.isFinite(ratePct) || !Number.isFinite(tenorDays)) return face;
  return Math.floor(face * (1 - (ratePct / 100) * (tenorDays / 365)));
}

function Pill({ tone, children }: { tone: "red" | "green" | "gray" | "amber" | "blue"; children: React.ReactNode }): JSX.Element {
  const tones = {
    red: "bg-red-100 text-red-700",
    green: "bg-emerald-100 text-emerald-700",
    gray: "bg-slate-100 text-slate-400",
    amber: "bg-amber-100 text-amber-700",
    blue: "bg-brand-50 text-brand-700",
  };
  return <span className={`inline-block mx-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function FinancingPanel({
  asset,
  role,
  onChanged,
}: {
  asset: Asset;
  role: Role;
  onChanged: () => void;
}): JSX.Element {
  const { token } = useAuth();
  const [financing, setFinancing] = useState<Financing | null>(null);
  const [chain, setChain] = useState<TierChainNode[]>([]);
  const [accounts, setAccounts] = useState<{ address: string; label: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canFinance = can(role, "issue");
  const face = Number(asset.metadata.amountInr ?? 0);
  const parentSellerGstin = String(asset.metadata.sellerGstin ?? "");
  const capAmount = Math.floor(face * (DEEP_TIER_CAP_PCT / 100));

  // Finance form
  const [financier, setFinancier] = useState("");
  const [ratePct, setRatePct] = useState("");
  const [tenorDays, setTenorDays] = useState("");

  // Deep-tier form
  const [dtSeller, setDtSeller] = useState("");
  const [dtInvoiceNumber, setDtInvoiceNumber] = useState("");
  const [dtAmount, setDtAmount] = useState("");
  const [dtDueDate, setDtDueDate] = useState("");
  const [dtDocUrl, setDtDocUrl] = useState("");
  const [dtMintTo, setDtMintTo] = useState("");
  const [dtNote, setDtNote] = useState<string | null>(null);

  const reloadFinancing = useCallback(async () => {
    if (!token) return;
    const [{ financing: f }, ch] = await Promise.all([
      api.financing(token, asset.id),
      api.tierChain(token, asset.id).catch(() => [] as TierChainNode[]),
    ]);
    setFinancing(f);
    setChain(ch);
  }, [token, asset.id]);

  useEffect(() => {
    void reloadFinancing();
  }, [reloadFinancing]);

  useEffect(() => {
    if (!token) return;
    void api.accounts(token).then(setAccounts).catch(() => {});
  }, [token]);

  const rate = Number(ratePct);
  const tenor = Number(tenorDays);
  const financePreview = useMemo(
    () => (ratePct && tenorDays && Number.isFinite(rate) && Number.isFinite(tenor) ? discountedInr(face, rate, tenor) : null),
    [ratePct, tenorDays, rate, tenor, face],
  );

  async function run<T>(fn: () => Promise<T>, after?: (r: T) => void): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      await reloadFinancing();
      onChanged();
      after?.(r);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  function doFinance(): void {
    void run(() => api.finance(token!, asset.id, { financier, ratePct, tenorDays: Number(tenorDays) }), () => {
      setFinancier("");
      setRatePct("");
      setTenorDays("");
    });
  }

  function doRepay(): void {
    void run(() => api.repay(token!, asset.id));
  }

  async function doDeepTier(): Promise<void> {
    if (!token) return;
    setDtNote(null);
    // The child's buyer is the parent's seller (the tier-1 supplier); hash covers that pairing.
    const invoiceHash = await computeFingerprint({
      invoiceNumber: dtInvoiceNumber,
      sellerGstin: dtSeller,
      buyerGstin: parentSellerGstin,
      amountInr: dtAmount,
      dueDate: dtDueDate,
    });
    await run(
      () =>
        api.deepTier(token, asset.id, {
          invoiceNumber: dtInvoiceNumber,
          sellerGstin: dtSeller,
          buyerGstin: parentSellerGstin,
          amountInr: Number(dtAmount),
          dueDate: dtDueDate,
          invoiceHash,
          ...(dtDocUrl ? { invoiceDocUrl: dtDocUrl } : {}),
          ...(dtMintTo ? { mintTo: dtMintTo } : {}),
        }),
      () => {
        setDtNote(`Sub-supplier invoice ${dtInvoiceNumber} extended (tier chain updated).`);
        setDtSeller("");
        setDtInvoiceNumber("");
        setDtAmount("");
        setDtDueDate("");
        setDtDocUrl("");
        setDtMintTo("");
      },
    );
  }

  const isFinanced = financing?.status === "financed";
  const isRepaid = financing?.status === "repaid";
  const financeReady = !!financier && ratePct !== "" && tenorDays !== "" && Number(tenorDays) > 0;
  const dtReady = !!dtSeller && !!dtInvoiceNumber && dtAmount !== "" && Number(dtAmount) > 0 && !!dtDueDate;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800">Financing</div>
        {financing && (
          <span>
            {isRepaid ? <Pill tone="gray">repaid</Pill> : <Pill tone="green">financed</Pill>}
          </span>
        )}
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}

      {/* Status / terms */}
      {!financing ? (
        <p className="text-sm text-slate-500">Not yet financed.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
          <Term label="Financier" value={short(financing.financier)} />
          <Term label="Rate" value={`${financing.ratePct}%`} />
          <Term label="Tenor" value={`${financing.tenorDays} days`} />
          <Term label="Face value" value={inr(financing.faceValueInr)} />
          <Term label="Discounted" value={inr(financing.discountedInr)} />
          <Term label="Maturity" value={financing.maturityDate} />
        </div>
      )}

      {/* Finance form */}
      {!financing && canFinance && (
        <div className="rounded-lg border border-slate-200 p-4 space-y-2.5">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Finance invoice</div>
          <div className="grid grid-cols-3 gap-3">
            <select className="select" value={financier} onChange={(e) => setFinancier(e.target.value)}>
              <option value="">Financier…</option>
              {accounts.map((a) => (
                <option key={a.address} value={a.address}>{a.label}</option>
              ))}
            </select>
            <input className="input" type="number" min="0" step="0.01" placeholder="Rate %" value={ratePct} onChange={(e) => setRatePct(e.target.value)} />
            <input className="input" type="number" min="1" step="1" placeholder="Tenor days" value={tenorDays} onChange={(e) => setTenorDays(e.target.value)} />
          </div>
          <div className="text-xs text-slate-500">
            Face: <strong className="text-slate-700">{inr(face)}</strong>
            {financePreview !== null && (
              <> · Discounted: <strong className="text-brand-700">{inr(financePreview)}</strong></>
            )}
          </div>
          <button
            disabled={busy || !financeReady}
            onClick={doFinance}
            className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
          >
            {busy ? "Working…" : "Finance invoice"}
          </button>
        </div>
      )}

      {/* Mark repaid */}
      {isFinanced && canFinance && (
        <button
          disabled={busy}
          onClick={doRepay}
          className="btn-sm border-slate-200 text-slate-600 hover:border-brand-500 disabled:opacity-40"
        >
          {busy ? "Working…" : "Mark repaid"}
        </button>
      )}

      {/* Deep-tier: extend to sub-supplier */}
      {isFinanced && canFinance && (
        <div className="rounded-lg border border-slate-200 p-4 space-y-2.5">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Extend to sub-supplier (deep-tier)</div>
          <p className="text-[11px] text-slate-400">
            Mints a linked child invoice under the anchor buyer's credit. Amount ≤ {DEEP_TIER_CAP_PCT}% of face = <strong className="text-slate-600">{inr(capAmount)}</strong>.
            The child's buyer is this invoice's seller (<span className="font-mono">{shortGstin(parentSellerGstin)}</span>).
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <input className="input" type="text" placeholder="Sub-supplier GSTIN" value={dtSeller} onChange={(e) => setDtSeller(e.target.value)} />
            <input className="input" type="text" placeholder="Invoice number" value={dtInvoiceNumber} onChange={(e) => setDtInvoiceNumber(e.target.value)} />
            <input className="input" type="number" min="1" step="1" placeholder="Amount (INR)" value={dtAmount} onChange={(e) => setDtAmount(e.target.value)} />
            <input className="input" type="date" placeholder="Due date" value={dtDueDate} onChange={(e) => setDtDueDate(e.target.value)} />
            <input className="input" type="text" placeholder="Doc URL (optional)" value={dtDocUrl} onChange={(e) => setDtDocUrl(e.target.value)} />
            <select className="select" value={dtMintTo} onChange={(e) => setDtMintTo(e.target.value)}>
              <option value="">Mint to (optional)…</option>
              {accounts.map((a) => (
                <option key={a.address} value={a.address}>{a.label}</option>
              ))}
            </select>
          </div>
          <button
            disabled={busy || !dtReady}
            onClick={() => void doDeepTier()}
            className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
          >
            {busy ? "Working…" : "Extend to sub-supplier"}
          </button>
          {dtNote && <p className="text-sm text-emerald-600">{dtNote}</p>}
        </div>
      )}

      {/* Tier chain */}
      {chain.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Tier chain</div>
          <ul className="space-y-1">
            {chain.map((n) => {
              const current = n.assetId === asset.id;
              return (
                <li
                  key={n.assetId}
                  style={{ marginLeft: `${(n.tier - 1) * 1.25}rem` }}
                  className={`flex items-center gap-2 text-xs rounded-lg px-2.5 py-1.5 border ${
                    current ? "border-brand-400 bg-brand-50" : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <span className="font-semibold text-slate-500">T{n.tier}</span>
                  <span className="font-medium text-slate-700">{n.invoiceNumber}</span>
                  <span className="text-slate-500">· {inr(n.amountInr)}</span>
                  <span className="font-mono text-[11px] text-slate-400">{shortGstin(n.sellerGstin)}→{shortGstin(n.buyerGstin)}</span>
                  {n.financing ? (
                    <Pill tone={n.financing.status === "repaid" ? "gray" : "blue"}>
                      {short(n.financing.financier)} · {n.financing.status}
                    </Pill>
                  ) : (
                    <Pill tone="amber">unfinanced</Pill>
                  )}
                  {current && <span className="text-[10px] text-brand-600 font-medium">(this invoice)</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Term({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
      <div className="text-slate-400 uppercase tracking-wide text-[10px]">{label}</div>
      <div className="text-slate-700 font-medium truncate" title={value}>{value}</div>
    </div>
  );
}
