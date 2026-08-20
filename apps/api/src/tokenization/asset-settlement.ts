import type { LedgerTransactionRepository } from "../persistence/types/index.js";

/**
 * What the REGISTER may claim about an asset, given what the CHAIN has settled.
 *
 * `unknown` maps to `pending`, not to `failed` and not to `active`: we do not
 * know, and both of the confident answers are wrong in a way that costs money —
 * `active` is the original bug (a mint that never mined, read back as live),
 * and `failed` would invite a re-issue that double-mints.
 *
 * `failed` IS REACHABLE, and reading FAILED rows is what makes it so. Nothing
 * sets `Asset.status = "failed"`, so an earlier version of this function — which
 * consulted only the asset row and the OUTSTANDING transactions — could never
 * return it. A reverted mint settles `failed`, `listByAsset` excludes `failed`,
 * and the asset read back `active`: the original bug exactly, reproduced for
 * reverts, and invisible to reconciliation too (believed 0, chain 0, no drift).
 *
 * PRECEDENCE: outstanding beats failed. An asset with one reverted mint and one
 * still in flight is `pending`, because the in-flight transaction may yet
 * succeed and calling the asset failed while the chain is still deciding is the
 * same over-claim in the other direction.
 */
export async function settlementStatus(
  deps: { ledgerTransactions: LedgerTransactionRepository },
  asset: { id: string; status: string },
): Promise<"active" | "pending" | "failed"> {
  const counts = await deps.ledgerTransactions.countsByStatus(asset.id);
  if (counts.pending + counts.unknown > 0) return "pending";
  if (counts.failed > 0) return "failed";
  return asset.status === "failed" ? "failed" : "active";
}
