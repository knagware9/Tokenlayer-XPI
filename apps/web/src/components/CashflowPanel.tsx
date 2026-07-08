import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import { can } from "../rbac.js";
import type { Asset, Cashflow, CashflowPreview, Role, UseCase } from "../types.js";

const TONE: Record<Cashflow["status"], string> = {
  scheduled: "bg-slate-100 text-slate-500",
  due: "bg-amber-100 text-amber-700",
  overdue: "bg-red-100 text-red-700",
  executing: "bg-brand-50 text-brand-700",
  executed: "bg-emerald-100 text-emerald-700",
};

/**
 * Cashflows & Settlement card: the asset's materialized payment schedule
 * (coupons + maturity redemption), a "pay coupon" action once a coupon is
 * due, and a "record repayment & settle" helper that credits the buyer's
 * repayment into a payer account and executes the redemption in one go.
 * The API enforces due-dates, funding and escrow — the UI only gates by role.
 */
export function CashflowPanel({ asset, useCase, role, onChanged }: { asset: Asset; useCase: UseCase; role: Role; onChanged: () => void }): JSX.Element | null {
  const { token } = useAuth();
  const [rows, setRows] = useState<Cashflow[]>([]);
  const [preview, setPreview] = useState<CashflowPreview | null>(null);
  const [accounts, setAccounts] = useState<{ address: string; label: string }[]>([]);
  const [payer, setPayer] = useState("");
  const [repayAmount, setRepayAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    const r = await api.cashflows(token, asset.id);
    setRows(r.cashflows);
    setPreview(r.preview);
  }, [token, asset.id]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (token) void api.accounts(token).then(setAccounts).catch(() => {}); }, [token]);

  if (!useCase.terms || rows.length === 0) return null;
  const operator = can(role, "issue");
  const payable = (cf: Cashflow): boolean => cf.status !== "executed" && (cf.kind === "redemption" || cf.status === "due" || cf.status === "overdue");

  async function run(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fn();
      // Maker-checker: a gated settlement returns a pending proposal (202), not a payout.
      if (res && typeof res === "object" && "proposal" in res && (res as { proposal?: unknown }).proposal) {
        setInfo("Submitted for approval — pending in the Approvals tab.");
      }
      await reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
      <h3 className="text-sm font-semibold text-slate-800">Cashflows & settlement</h3>
      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}
      {info && <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-2">{info}</div>}
      <table className="w-full text-sm">
        <thead className="text-xs text-slate-500 uppercase tracking-wide">
          <tr><th className="text-left py-1.5">#</th><th className="text-left">Type</th><th className="text-left">Due</th><th className="text-right">Amount</th><th className="text-left pl-4">Status</th><th /></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((cf) => (
            <tr key={cf.id}>
              <td className="py-2 text-slate-500">{cf.seq}</td>
              <td className="capitalize text-slate-700">{cf.kind}</td>
              <td className="text-slate-600">{cf.dueDate}</td>
              <td className="text-right font-mono text-slate-700">₹{Number(cf.amount).toLocaleString("en-IN")}</td>
              <td className="pl-4"><span className={`text-xs px-2 py-0.5 rounded-full ${TONE[cf.status]}`}>{cf.status}</span></td>
              <td className="text-right">
                {operator && payable(cf) && cf.kind === "coupon" && (
                  <button disabled={busy} onClick={() => void run(() => api.executeCashflow(token!, asset.id, cf.id, payer || undefined))} className="text-xs rounded bg-brand-600 text-white px-2.5 py-1 hover:bg-brand-700 disabled:opacity-50">Pay coupon</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {operator && rows.some((cf) => cf.kind === "redemption" && cf.status !== "executed") && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2">
          <div className="text-xs font-medium text-slate-600">Record repayment & settle</div>
          <div className="grid grid-cols-3 gap-3">
            <select className="select" value={payer} onChange={(e) => setPayer(e.target.value)} disabled={busy}>
              <option value="">Payer account…</option>
              {accounts.map((a) => <option key={a.address} value={a.address}>{a.label}</option>)}
            </select>
            <input className="input" type="number" min="1" placeholder={`Repayment (default ₹${Number(rows.find((c) => c.kind === "redemption")?.amount ?? 0).toLocaleString("en-IN")})`} value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} disabled={busy} />
            <button
              disabled={busy || !payer}
              onClick={() => {
                const cf = rows.find((c) => c.kind === "redemption" && c.status !== "executed")!;
                void run(async () => {
                  // Credit only the SHORTFALL: a retry after a failed execute (or a
                  // pre-funded payer) must not double-credit the repayment.
                  const needed = BigInt(repayAmount || cf.amount);
                  const balances = await api.cashBalances(token!, payer);
                  const current = BigInt(balances.find((b) => b.currency === cf.currency)?.amount ?? "0");
                  const shortfall = needed > current ? needed - current : 0n;
                  if (shortfall > 0n) await api.creditCash(token!, payer, cf.currency, shortfall.toString());
                  return api.executeCashflow(token!, asset.id, cf.id, payer);
                });
              }}
              className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? "Settling…" : "Settle at maturity"}
            </button>
          </div>
          {preview && (
            <div className="text-[11px] text-slate-500">
              Payout preview: {preview.split.map((s) => `${s.address.slice(0, 6)}… ₹${Number(s.amount).toLocaleString("en-IN")}`).join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
