import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { AuditEntry, ChainInfo, UseCase } from "../../types.js";
import { Card, EmptyState, Pager, Skeleton } from "../shared/ui.js";
import { AssetDetail, ExplorerLink, short, summarize } from "./AssetDetail.js";

const PAGE_SIZE = 20;

interface Row extends AuditEntry {
  assetName: string;
  assetSymbol: string;
}

/**
 * A cross-asset activity feed for a scoped desk (UseCaseAdmin/Issuer/Auditor/
 * Trader) — the roles the org-wide AuditConsole is deliberately withheld from
 * (GET /events is ORG-grained; a desk operator would see every use case in
 * the org, including ones they cannot open). Dashboard's own "Recent activity"
 * card covers the same ground but caps at 8 rows with no history beyond that;
 * this is the full, searchable, paginated equivalent, scoped to one use case.
 *
 * Built the same way the Dashboard's Holders table is: fetch every asset in
 * the use case, then fetch each one's own audit trail and merge — no
 * dedicated server endpoint exists for "every event across a use case's
 * assets", so this reuses the per-asset GET /assets/:id/audit route already
 * proven for AssetDetail. Fine at demo scale; worth a real server-side
 * aggregation if a use case's asset catalog grows large.
 */
export function DeskActivity({ useCaseKey, useCases, chains }: { useCaseKey: string; useCases: UseCase[]; chains: ChainInfo[] }): JSX.Element {
  const { token } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [detailAssetId, setDetailAssetId] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !useCaseKey) return;
    let cancelled = false;
    setRows(null);
    setError(null);
    void (async () => {
      try {
        const assets = await api.assets(token, useCaseKey);
        const perAsset = await Promise.all(
          assets.map((a) => api.audit(token, a.id).then((entries) => entries.map((e) => ({ ...e, assetName: a.name, assetSymbol: a.symbol })))),
        );
        if (cancelled) return;
        const merged = perAsset.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setRows(merged);
      } catch {
        if (!cancelled) setError("Could not load activity");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, useCaseKey]);

  if (detailAssetId) {
    return <AssetDetail assetId={detailAssetId} useCases={useCases} chains={chains} onBack={() => setDetailAssetId(null)} onChanged={() => {}} />;
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!rows)
    return (
      <Card>
        <Skeleton lines={6} />
      </Card>
    );

  const filtered = query.trim()
    ? rows.filter((r) => `${r.action} ${r.assetName} ${r.assetSymbol} ${r.txHash ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    : rows;
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const chainOf = (id?: string) => chains.find((c) => c.id === id);

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <div className="text-sm font-semibold text-slate-900">Activity</div>
          <div className="text-xs text-slate-400">Every mint, transfer, buy, allow, freeze and burn across this use case's assets — newest first.</div>
        </div>
        <input
          className="input w-56 text-xs"
          placeholder="Search action, asset, tx…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1); }}
        />
      </div>
      {filtered.length === 0 ? (
        <EmptyState icon="spark" title="No activity yet" hint="Mint, transfer, or buy an asset to see it here." />
      ) : (
        <>
          <ol className="space-y-2">
            {paged.map((e) => (
              <li key={e.id} className="flex items-start gap-3 text-sm border-t border-slate-100 pt-2 first:border-0 first:pt-0">
                <span className="mt-0.5 inline-block w-20 shrink-0 text-[11px] font-semibold text-brand-600 uppercase">{e.action}</span>
                <button onClick={() => setDetailAssetId(e.assetId ?? null)} className="w-40 shrink-0 text-left text-slate-700 hover:text-brand-700 hover:underline truncate" title={e.assetName}>
                  {e.assetName} <span className="text-slate-400">{e.assetSymbol}</span>
                </button>
                <span className="flex-1 text-slate-600">
                  {summarize(e)}
                  {e.txHash && (
                    <span className="ml-2 font-mono text-[10px] text-slate-400">
                      <ExplorerLink chain={chainOf(e.chainId)} kind="tx" value={e.txHash}>{short(e.txHash)}</ExplorerLink>
                    </span>
                  )}
                </span>
                <span className="text-[11px] text-slate-400 shrink-0" title={new Date(e.createdAt).toLocaleString()}>{new Date(e.createdAt).toLocaleTimeString()}</span>
              </li>
            ))}
          </ol>
          <div className="mt-4">
            <Pager page={page} pageSize={PAGE_SIZE} total={filtered.length} onPage={setPage} />
          </div>
        </>
      )}
    </Card>
  );
}
