/**
 * RESOLVES OUTSTANDING LEDGER TRANSACTIONS.
 *
 * A deliberate mirror of `webhooks/dispatcher.ts`: listDue → CAS claim → act →
 * settle or defer, plus reclaimStale for crash recovery. That shape is already
 * proven safe with two instances polling one table, and this file exists to
 * reuse it rather than invent a second one.
 *
 * THE CEILING LEADS TO `unknown`, NOT `failed`. After enough silent polls we
 * stop asking, but we have learned nothing about the outcome — and a mint
 * recorded as failed is a mint someone re-issues.
 */
import { randomUUID } from "node:crypto";
import type { LedgerTransactionRepository } from "../persistence/types/index.js";

const STALE_CLAIM_MS = 60_000;
const BASE_BACKOFF_MS = 5_000;

export interface ConfirmerOptions {
  workerId: string;
  now: string;
  /** Resolves a receipt, or null when the chain does not have one yet. */
  getReceipt: (chainId: string, txHash: string) => Promise<{ blockNumber?: number; status?: number } | null>;
  maxAttempts?: number;
  limit?: number;
}

export async function runConfirmerOnce(
  deps: { ledgerTransactions: LedgerTransactionRepository },
  opts: ConfirmerOptions,
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 10;
  const nowMs = new Date(opts.now).getTime();
  await deps.ledgerTransactions.reclaimStale(new Date(nowMs - STALE_CLAIM_MS).toISOString());

  for (const row of await deps.ledgerTransactions.listDue(opts.now, opts.limit ?? 25)) {
    const claimed = await deps.ledgerTransactions.claim(row.id, opts.workerId, opts.now);
    if (!claimed) continue; // another worker won the race

    let receipt: { blockNumber?: number; status?: number } | null = null;
    let error: string | undefined;
    try {
      receipt = await opts.getReceipt(claimed.chainId, claimed.txHash);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (receipt && receipt.status === 0) {
      await deps.ledgerTransactions.settle(claimed.id, { status: "failed", blockNumber: receipt.blockNumber, error: "reverted" });
      continue;
    }
    if (receipt) {
      await deps.ledgerTransactions.settle(claimed.id, { status: "confirmed", blockNumber: receipt.blockNumber, confirmedAt: opts.now });
      continue;
    }
    if (claimed.attempts + 1 >= maxAttempts) {
      await deps.ledgerTransactions.settle(claimed.id, { status: "unknown", error: error ?? `no receipt after ${maxAttempts} polls` });
      continue;
    }
    // GROWING DELAY, deliberately mirroring the dispatcher's exponential
    // BACKOFF_MS. A stalled chain must not be re-polled every tick for every
    // outstanding row forever — that hammers the RPC endpoint exactly the way
    // the dispatcher's backoff exists to prevent for a webhook endpoint. The
    // interval alone (`startConfirmer`'s `intervalMs`) is not a substitute: it
    // bounds the FLOOR between polls, not the growth of an individual row's
    // wait as it keeps coming up empty.
    const backoff = BASE_BACKOFF_MS * 2 ** claimed.attempts;
    await deps.ledgerTransactions.defer(claimed.id, new Date(nowMs + backoff).toISOString(), opts.now, error);
  }
}

/**
 * Polling loop. Returns a stop function, mirroring `startDispatcher`.
 *
 * `workerId` is NOT accepted from the caller — mirroring `startDispatcher`,
 * which mints its own per-process id internally (see dispatcher.ts). Callers
 * only ever supply `getReceipt` (and optional tuning); `runConfirmerOnce`
 * keeps `workerId` as an explicit option because the tests drive the CAS
 * claim directly and need to name the worker themselves.
 */
export function startConfirmer(
  deps: { ledgerTransactions: LedgerTransactionRepository },
  opts: Omit<ConfirmerOptions, "now" | "workerId"> & { intervalMs?: number },
): () => void {
  // Per-process, so `claimedBy` on a stuck row names which instance stranded it.
  const workerId = `ltx-${randomUUID()}`;
  const interval = setInterval(() => {
    void runConfirmerOnce(deps, { ...opts, workerId, now: new Date().toISOString() }).catch(() => {
      /* a poll failure must not kill the loop; the row stays due */
    });
  }, opts.intervalMs ?? 5_000);
  // The poller must not be the reason the process refuses to exit.
  interval.unref?.();
  return () => clearInterval(interval);
}
