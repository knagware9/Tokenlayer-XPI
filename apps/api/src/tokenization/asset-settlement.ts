import type { LedgerTransactionRepository } from "../persistence/types/index.js";

/**
 * What the REGISTER may claim about an asset, given what the CHAIN has settled.
 *
 * `unknown` maps to `pending`, not to `failed` and not to `active`: we do not
 * know, and both of the confident answers are wrong in a way that costs money —
 * `active` is the original bug (a mint that never mined, read back as live),
 * and `failed` would invite a re-issue that double-mints.
 */
export async function settlementStatus(
  deps: { ledgerTransactions: LedgerTransactionRepository },
  asset: { id: string; status: string },
): Promise<"active" | "pending" | "failed"> {
  const outstanding = await deps.ledgerTransactions.listByAsset(asset.id);
  if (outstanding.length > 0) return "pending";
  return asset.status === "failed" ? "failed" : "active";
}
