import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import { can } from "../../rbac.js";
import type { Asset, AuditVerify } from "../../types.js";
import { Pill, TableShell } from "./ui.js";

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
          <h2 className="text-lg font-bold text-fg">Audit integrity</h2>
          <p className="text-xs text-muted mt-0.5 prose-measure">
            Every audit entry is hash-chained to the previous one and periodically anchored on-ledger.
            {tampered > 0 ? <span className="text-danger font-medium"> {tampered} chain(s) show tampering.</span> : <span className="text-success font-medium"> All chains verified.</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void reload()} disabled={busy} className="rounded-lg border border-border text-muted px-3 py-1.5 text-sm font-medium hover:bg-elevated disabled:opacity-50">Verify now</button>
          {canAnchor && <button onClick={() => void anchorNow()} disabled={busy} className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50">{busy ? "Anchoring…" : "Anchor now"}</button>}
        </div>
      </div>

      {error && <div className="rounded-lg bg-danger/10 border border-danger/20 text-danger text-sm px-4 py-2">{error}</div>}
      {notice && <div className="rounded-lg bg-success/10 border border-success/20 text-success text-sm px-4 py-2">{notice}</div>}

      <TableShell>
        <thead>
          <tr>
            <th>Asset</th>
            <th>Chain status</th>
            <th className="text-right">Entries</th>
            <th>Last anchor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ asset, v }) => {
            const good = v.valid && v.anchorConsistent;
            const label = !v.valid ? `tampered @#${v.brokenAt} (${v.reason})` : !v.anchorConsistent ? "anchor mismatch" : "verified";
            return (
              <tr key={asset.id}>
                <td className="font-medium text-fg">{asset.name} <span className="text-muted font-normal">{asset.symbol}</span></td>
                <td><Pill tone={good ? "ok" : "danger"}>{good ? "✓ " : "✕ "}{label}</Pill></td>
                <td className="num text-muted">{v.count}</td>
                <td className="text-xs text-muted">
                  {v.lastAnchor ? <span className="font-mono">#{v.lastAnchor.seq} · {v.lastAnchor.txHash.slice(0, 12)}… · {ago(v.lastAnchor.at)}</span> : <span className="text-muted">not anchored</span>}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={4} className="text-center text-sm text-muted !py-6">No assets to verify.</td></tr>}
        </tbody>
      </TableShell>
    </div>
  );
}
