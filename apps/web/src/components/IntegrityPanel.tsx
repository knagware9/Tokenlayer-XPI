import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import { can } from "../rbac.js";
import type { Asset, AuditVerify } from "../types.js";

/** Relative "n ago" for an ISO timestamp. */
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * Audit Integrity: verifies each asset's tamper-evident hash chain (and its
 * on-ledger anchor) live, and lets a desk operator anchor the current heads.
 * A green "verified" means the chain recomputes correctly AND matches its
 * anchor; a red pill pinpoints the first tampered entry (or an anchor mismatch).
 */
export function IntegrityPanel({ useCaseKey }: { useCaseKey?: string }): JSX.Element {
  const { token, user } = useAuth();
  const role = user?.role ?? "Auditor";
  const [rows, setRows] = useState<{ asset: Asset; v: AuditVerify }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const assets = await api.assets(token, useCaseKey);
      const verified = await Promise.all(assets.map(async (asset) => ({ asset, v: await api.verifyAudit(token, asset.id) })));
      setRows(verified);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Could not load integrity status");
    }
  }, [token, useCaseKey]);
  useEffect(() => { void reload(); }, [reload]);

  async function anchorNow(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.anchorAudit(token);
      setNotice(`Anchored ${res.anchored.length} asset chain head(s) on-ledger.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Anchor failed");
    } finally {
      setBusy(false);
    }
  }

  const canAnchor = can(role, "issue") || role === "Auditor";
  const tampered = rows.filter((r) => !r.v.valid || !r.v.anchorConsistent).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Audit integrity</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Every audit entry is hash-chained to the previous one and periodically anchored on-ledger.
            {tampered > 0 ? <span className="text-red-600 font-medium"> {tampered} chain(s) show tampering.</span> : <span className="text-emerald-700 font-medium"> All chains verified.</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void reload()} disabled={busy} className="rounded-lg border border-slate-300 text-slate-600 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">Verify now</button>
          {canAnchor && <button onClick={() => void anchorNow()} disabled={busy} className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50">{busy ? "Anchoring…" : "Anchor now"}</button>}
        </div>
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}
      {notice && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-2">{notice}</div>}

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Asset</th>
              <th className="text-left font-medium px-4 py-2.5">Chain status</th>
              <th className="text-right font-medium px-4 py-2.5">Entries</th>
              <th className="text-left font-medium px-4 py-2.5">Last anchor</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(({ asset, v }) => {
              const good = v.valid && v.anchorConsistent;
              const label = !v.valid ? `tampered @#${v.brokenAt} (${v.reason})` : !v.anchorConsistent ? "anchor mismatch" : "verified";
              return (
                <tr key={asset.id}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{asset.name} <span className="text-slate-400 font-normal">{asset.symbol}</span></td>
                  <td className="px-4 py-2.5"><span className={`text-xs px-2 py-0.5 rounded-full ${good ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>{good ? "✓ " : "✕ "}{label}</span></td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-600">{v.count}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">
                    {v.lastAnchor ? <span className="font-mono">#{v.lastAnchor.seq} · {v.lastAnchor.txHash.slice(0, 12)}… · {ago(v.lastAnchor.at)}</span> : <span className="text-slate-300">not anchored</span>}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-slate-400">No assets to verify.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
