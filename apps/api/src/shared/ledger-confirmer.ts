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
    // NO GROWING DELAY HERE — deliberately, unlike the dispatcher's exponential
    // BACKOFF_MS. That backoff exists to protect a THIRD PARTY'S server from a
    // retry storm; a receipt poll hits our own chain RPC, and the throttle that
    // matters is already `startConfirmer`'s poll interval (`intervalMs`, default
    // 5s) — the row becomes due again on the very next tick, not sooner. Adding
    // a second, independently-growing delay on top would only fight the
    // interval's own pacing, and — because each tick's `now` is the wall-clock
    // instant it fires — could not be expressed as a plain unit test at all
    // without a fake clock.
    await deps.ledgerTransactions.defer(claimed.id, opts.now, opts.now, error);
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
