/**
 * RECORDING WHAT WE ASKED THE CHAIN TO DO.
 *
 * One seam, called by every path that produces a TxReceipt, so that a chain
 * write is never a fact known only to a variable on the stack.
 *
 * The block number is the whole signal. An adapter that confirmed returns one;
 * an adapter that timed out returns a hash and nothing else. Treating the second
 * case as success is precisely the bug this exists to end.
 */
import type { TxReceipt } from "@tokenlayer/core";
import type { LedgerTransactionRecord, LedgerTransactionRepository, LedgerTxKind } from "../persistence/types/index.js";

export async function recordSubmission(
  deps: { ledgerTransactions: LedgerTransactionRepository },
  kind: LedgerTxKind,
  receipt: TxReceipt,
  refs: { assetId?: string | null; credentialId?: string | null; amount?: string | null } = {},
): Promise<LedgerTransactionRecord> {
  const rec = await deps.ledgerTransactions.record({
    chainId: receipt.chainId, txHash: receipt.txHash, kind, amount: refs.amount ?? null,
    assetId: refs.assetId ?? null, credentialId: refs.credentialId ?? null,
    submittedAt: receipt.timestamp,
  });
  if (receipt.blockNumber === undefined || rec.status !== "pending") return rec;
  return deps.ledgerTransactions.settle(rec.id, {
    status: "confirmed", blockNumber: receipt.blockNumber, confirmedAt: receipt.timestamp,
  });
}
