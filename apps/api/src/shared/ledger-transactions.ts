/**
 * RECORDING WHAT WE ASKED THE CHAIN TO DO.
 *
 * One seam, called by every path that produces a TxReceipt, so that a chain
 * write is never a fact known only to a variable on the stack.
 *
 * TWO SIGNALS, NOT ONE.
 *
 * The block number says "this chain has already mined it". But a chain whose
 * adapter cannot be POLLED — no `getReceipt` — never produces one, and it never
 * will: Fabric's gateway and Canton's JSON API return once the transaction is
 * committed, and there is no later fact to wait for. Recording those as
 * `pending` made every Fabric/Canton asset defer ten times into `unknown` and
 * sit outstanding forever, which is how `/reconciliation` came to call every one
 * of them drifted. So the second signal is the adapter's SHAPE: a chain we
 * cannot ask about a transaction afterwards has already told us everything it
 * is ever going to, and its submission is confirmed on return.
 *
 * NOTE WHAT IS *NOT* DONE HERE: no block number is invented for those chains.
 * The row is confirmed with `blockNumber: null`, because the absence of one is
 * the truth — a fabricated height would be exactly the kind of claim the
 * database is not allowed to make.
 */
import type { TxReceipt } from "@tokenlayer/core";
import type { ChainRegistry } from "./chains.js";
import type { LedgerTransactionRecord, LedgerTransactionRepository, LedgerTxKind } from "../persistence/types/index.js";

/** What `recordSubmission` needs: the durable record, and the chains it can ask about. */
export interface LedgerRecordingDeps {
  ledgerTransactions: LedgerTransactionRepository;
  chains: Pick<ChainRegistry, "resolveAdapter">;
}

export async function recordSubmission(
  deps: LedgerRecordingDeps,
  kind: LedgerTxKind,
  receipt: TxReceipt,
  refs: { assetId?: string | null; credentialId?: string | null; amount?: string | null } = {},
): Promise<LedgerTransactionRecord> {
  const rec = await deps.ledgerTransactions.record({
    chainId: receipt.chainId, txHash: receipt.txHash, kind, amount: refs.amount ?? null,
    assetId: refs.assetId ?? null, credentialId: refs.credentialId ?? null,
    submittedAt: receipt.timestamp,
  });
  if (rec.status !== "pending") return rec;
  if (receipt.blockNumber === undefined && !finalisesOnReturn(deps.chains, receipt.chainId)) return rec;
  return deps.ledgerTransactions.settle(rec.id, {
    status: "confirmed",
    // Spread, not `?? undefined`: an absent height must stay absent.
    ...(receipt.blockNumber === undefined ? {} : { blockNumber: receipt.blockNumber }),
    confirmedAt: receipt.timestamp,
  });
}

/**
 * Can this chain be ASKED about a transaction after the fact?
 *
 * `getReceipt` is optional on `LedgerAdapter` and is the confirmer's only way
 * to resolve a row. An adapter without it will never answer, so leaving its rows
 * `pending` schedules polls that can only ever end in `unknown`.
 *
 * AN ABSENT CHAIN IS TREATED AS POLLABLE. `resolveAdapter` throws for a chain
 * that is not configured right now (CHAIN_STRICT=0, an RPC being restarted).
 * That is ignorance, not finality — the honest record is `pending`, which the
 * confirmer resolves once the chain is back, rather than a `confirmed` we have
 * no evidence for.
 */
function finalisesOnReturn(chains: Pick<ChainRegistry, "resolveAdapter">, chainId: string): boolean {
  try {
    return typeof chains.resolveAdapter(chainId).getReceipt !== "function";
  } catch {
    return false;
  }
}
