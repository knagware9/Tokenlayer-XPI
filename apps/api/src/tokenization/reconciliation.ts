/**
 * BELIEVED STATE VERSUS CHAIN STATE.
 *
 * READ-ONLY, DELIBERATELY. A mismatch can mean an unmined transaction, a chain
 * that is merely unreachable, a re-genesis, or a genuine bug — and "fixing" the
 * database on a guess turns a reporting problem into a data-loss problem.
 *
 * FOUR REASONS, KEPT DISTINCT, because they need different actions:
 *   settlement-outstanding  transactions are still in flight; wait
 *   chain-unreadable        we could not ask; fix the connection, do not panic
 *   no-ledger-record        we never recorded this asset's transactions at all
 *   supply-mismatch         we asked, and the answer disagrees; investigate
 *
 * `no-ledger-record` exists because `believedSupply` cannot, on its own, tell
 * "zero mints" apart from "never recorded". An asset issued before this table
 * existed has no rows, so its derived supply is 0 against a real chain supply,
 * and calling that `supply-mismatch` would report every pre-existing asset as
 * drifted forever — the alarm that trains people to ignore alarms. The honest
 * statement is that we have no record, not that the chain is wrong.
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
  reason: "settlement-outstanding" | "chain-unreadable" | "no-ledger-record" | "supply-mismatch";
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
  // RULING R: `limit` is a PAGE size, not a cap on the report. A report that
  // says "checked: 500, drifted: 0" while 200 assets past the first page went
  // unexamined is a confident wrong answer — worse than no report, and exactly
  // the failure this branch exists to end. So this pages through every asset:
  // keep fetching with an advancing offset until `checked` has reached the
  // repository's own `total`, or a page comes back short (fewer than asked
  // for), which means there is nothing left even if `total` under-reports.
  const pageSize = opts.limit ?? 500;
  const drifted: ReconciliationRow[] = [];
  let checked = 0;
  let offset = 0;

  for (;;) {
    const { items, total } = await deps.assets.list({}, { limit: pageSize, offset });
    if (items.length === 0) break;

    for (const asset of items) {
      checked += 1;
      // Counts of EVERY status, not just the outstanding ones: the total is how
      // "we have no record of this asset" is told apart from "it has settled to
      // zero", and the two demand opposite responses.
      const counts = await deps.ledgerTransactions.countsByStatus(asset.id);
      const outstanding = counts.pending + counts.unknown;
      const recorded = outstanding + counts.confirmed + counts.failed;
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
        reason:
          outstanding > 0
            ? "settlement-outstanding"
            : unreadable
              ? "chain-unreadable"
              : // GATED ON THE BELIEF BEING VACUOUS, not on the row count alone.
                // The claim this reason makes is "believed supply reads 0 only
                // because nothing was ever recorded" — true when the belief is
                // 0, false when some other source asserted a number without a
                // row behind it, which is a genuine discrepancy to investigate.
                recorded === 0 && (believed === null || believed === "0")
                ? "no-ledger-record"
                : "supply-mismatch",
      });
    }

    offset += items.length;
    if (offset >= total || items.length < pageSize) break;
  }

  return { checked, drifted };
}
