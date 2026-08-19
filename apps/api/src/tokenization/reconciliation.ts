/**
 * BELIEVED STATE VERSUS CHAIN STATE.
 *
 * READ-ONLY, DELIBERATELY. A mismatch can mean an unmined transaction, a chain
 * that is merely unreachable, a re-genesis, or a genuine bug — and "fixing" the
 * database on a guess turns a reporting problem into a data-loss problem.
 *
 * THREE REASONS, KEPT DISTINCT, because they need different actions:
 *   settlement-outstanding  transactions are still in flight; wait
 *   chain-unreadable        we could not ask; fix the connection, do not panic
 *   supply-mismatch         we asked, and the answer disagrees; investigate
 */
import type { Actor } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import { contextOf } from "../http/support.js";

export interface ReconciliationRow {
  assetId: string;
  chainId: string;
  believedSupply: string | null;
  chainSupply: string | null;
  outstanding: number;
  reason: "settlement-outstanding" | "chain-unreadable" | "supply-mismatch";
}

export interface ReconciliationReport {
  checked: number;
  drifted: ReconciliationRow[];
}

export async function reconcile(
  deps: Pick<AppDeps, "assets" | "engine" | "ledgerTransactions">,
  actor: Actor,
  opts: { believedSupply: (assetId: string) => Promise<string | null>; limit?: number },
): Promise<ReconciliationReport> {
  const { items } = await deps.assets.list({}, { limit: opts.limit ?? 500, offset: 0 });
  const drifted: ReconciliationRow[] = [];

  for (const asset of items) {
    const outstanding = (await deps.ledgerTransactions.listByAsset(asset.id)).length;
    const believed = await opts.believedSupply(asset.id);

    let chainSupply: string | null = null;
    let unreadable = false;
    try {
      // contextOf builds { ref: { id, chainId, contractRef }, useCaseKey } —
      // the shape LifecycleEngine.totalSupply actually reads (ctx.ref.chainId).
      // A hand-built flat object here would make resolveAdapter(undefined)
      // throw for every asset, reporting the whole platform as unreachable.
      chainSupply = await deps.engine.totalSupply(actor, contextOf(asset));
    } catch {
      unreadable = true;
    }

    if (!unreadable && chainSupply === believed) continue;

    drifted.push({
      assetId: asset.id,
      chainId: asset.chainId,
      believedSupply: believed,
      chainSupply: unreadable ? null : chainSupply,
      outstanding,
      reason: outstanding > 0 ? "settlement-outstanding" : unreadable ? "chain-unreadable" : "supply-mismatch",
    });
  }

  return { checked: items.length, drifted };
}
