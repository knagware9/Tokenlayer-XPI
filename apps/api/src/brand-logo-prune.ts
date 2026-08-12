import type { DocumentRepository, DocumentSummary } from "./persistence/types.js";

/** Minimal structured-error logger — the Fastify `request.log` shape, same
 *  contract as `executors.ts`'s `Logger` and `events.ts`'s `EmitLogger`. */
export interface Logger {
  error(obj: unknown, msg: string): void;
}

/**
 * Production default grace period (ms). A row must be at least this old
 * before it is eligible for pruning — see the design note below for why 60s.
 * Routes read this via `deps.brandLogoPruneGraceMs ?? BRAND_LOGO_PRUNE_GRACE_MS`;
 * tests override the dependency to a small value so pruning still happens
 * immediately in a fast, non-concurrent test, and separately construct one
 * app with THIS constant to prove the production value actually protects a
 * fresh sibling.
 */
export const BRAND_LOGO_PRUNE_GRACE_MS = 60_000;

export interface BrandLogoPruneResult {
  /** Rows actually deleted (full summaries, not bare ids — an id alone
   *  resolves to nothing once the row is gone, which is no help to an
   *  operator reading the audit trail later). */
  removed: DocumentSummary[];
  /**
   * Set when a removed row is independently found, immediately after the
   * sweep, to have become the pinned mark before this function returned. This
   * is the residual of the per-row pin re-read below: narrowed to one round
   * trip per row, not closed. Detected, not prevented — the caller logs and
   * audits it.
   */
  lostPinnedId: string | null;
}

/**
 * DELETE THE ORGANIZATION'S SUPERSEDED BRAND LOGOS.
 *
 * `POST /orgs/{id}/branding/logo` may store up to 5MB, and before this existed
 * every reconsidered pick left a row behind forever. There is no cap and no
 * scheduled sweep: each upload cleans up after the ones before it, so the
 * steady state is small — no threshold to tune and no cron to run.
 *
 * WHY DELETING IS SAFE HERE. Exactly one reference to a `purpose = "brand-logo"`
 * row can exist anywhere in the system:
 *
 *   1. Only the owning org can pin one. `PATCH /orgs/{id}/branding` requires
 *      `orgOwnsDocument(doc, id)`, so "is it pinned" is one organization's field,
 *      not a store-wide scan.
 *   2. Every other door that persists a caller-supplied document id refuses a
 *      brand-logo document — see `brandLogoRefusal` in `routes.ts`, which guards
 *      certificate backgrounds, `certificate.logoDocumentId`, the template save
 *      door, provision, staged invoices and KYB registration documents. Without
 *      those, a reference could live somewhere this function cannot see, and it
 *      would delete bytes something still draws.
 *
 * Change either and this function becomes unsafe.
 *
 * ---
 *
 * THE HISTORY OF GETTING THE CONCURRENCY GUARD RIGHT (two wrong attempts, kept
 * here because the reasons they failed are exactly what makes the real one
 * trustworthy).
 *
 * ATTEMPT 1 — compare `createdAt` directly (skip a row at-or-after this call's
 * own instant). Wrong in practice: `createdAt` has millisecond resolution, and
 * an in-process store with no real I/O makes ordinary SEQUENTIAL requests tie
 * on it constantly — this made an unrelated, pre-existing test ("the pinned
 * mark survives an upload") fail about 1 run in 3.
 *
 * ATTEMPT 2 — list the org's rows BEFORE storing this call's own upload, and
 * only ever consider THAT pre-store snapshot. The reasoning was "a row can't
 * appear in a snapshot taken before it was written, and two requests can't
 * both see each other in their own pre-store snapshot." Both claims are true
 * — and the second one doesn't matter, because MUTUAL visibility was never the
 * failure mode. Only ONE side needs to see the other:
 *
 *     A lists  -> snapshot SA = []
 *     A stores DA
 *     B lists  -> snapshot SB = [DA]      (after A's store, before B's own)
 *     B stores DB
 *     A prunes from SA -> deletes nothing
 *     B prunes from SB -> DA is not B's own upload, not pinned -> DELETED
 *
 * This is not a corner case: it is the ORDINARY outcome once two requests are
 * genuinely concurrent OS processes doing real database I/O, and it was
 * reproduced live — a real Fastify server over real TCP, `PrismaDocumentRepository`
 * over real SQLite, driven by separate `curl` processes — losing a live upload
 * in 3 of 30 trials, always the earlier-storing request's row. In-process
 * `vitest` tests using `app.inject()` cannot exhibit this at all: verified by
 * tracing, `light-my-request` fully serializes two "concurrent" injected
 * requests when nothing in the handler does real I/O, so the bug this
 * attempt was meant to fix was invisible to every test that could be written
 * against it. That is a property of the harness, not evidence the fix worked.
 *
 * THE ACTUAL FIX — an age floor. A row is only a deletion candidate once it
 * has existed for at least `keep.graceMs`. This targets the real distinguishing
 * fact the previous attempts missed: a genuinely concurrent sibling is only
 * ever MILLISECONDS old when another request's sweep runs, while a genuinely
 * abandoned pick is minutes, hours or days old. The guard no longer depends on
 * which request listed or stored first — DA above is spared by B regardless of
 * the SA/SB interleaving, because DA is not yet `graceMs` old no matter when B
 * looks at it. This also kills attempt 1's flakiness for a different reason:
 * the comparison is against `now - graceMs`, a multi-second-or-larger window,
 * not against "this exact instant", so millisecond ties stop being able to
 * flip the outcome.
 *
 * THE RESIDUAL THIS DOES NOT CLOSE: a request whose own processing (not just
 * its submission) takes longer than `graceMs` to actually persist its row —
 * extreme latency, not ordinary concurrency — can still have that row pruned
 * by a later sweep that runs after the grace window has elapsed relative to
 * the row's actual insert time. This is the SAME tradeoff the grace period
 * already makes for genuinely abandoned picks: past `graceMs`, this function
 * cannot tell "abandoned" from "still somehow in progress" apart, and treats
 * both the same, by design. A production value in the tens of seconds makes
 * this a pathological-latency scenario, not an ordinary-concurrency one.
 *
 * CRITICAL 2 (quality review, unrelated to the above): `keep.getPinned` is
 * called FRESH, immediately before each individual delete, not once for the
 * whole sweep — a PATCH that pins an older mark anywhere before that per-row
 * read is correctly seen and the row is spared. The gap between that read and
 * the DELETE succeeding is a real but much narrower window; `lostPinnedId`
 * reports when it was hit rather than pretending it cannot be — detection,
 * not prevention, is the right call there: the deletion has already happened
 * by the time this could notice.
 *
 * `getPinned` MUST THROW rather than return a guessed `null` when the pin
 * state cannot be determined (e.g. the organization itself cannot be
 * re-read) — treating "unknown" as "nothing pinned" is the null-as-allow
 * shape this program's reviews keep finding, and here it would delete the
 * org's live mark. A throw is caught per-row below and treated as "leave it".
 *
 * BEST-EFFORT BY DESIGN. The upload has already succeeded when this runs; the
 * caller's bytes are stored and their intent is served. A repository failure
 * must not turn that into a 500. A failed LISTING leaves EVERY superseded row
 * behind, not just one — there is no "the next upload collects it" here
 * unless the failure was transient. A failed DELETE leaves that one row.
 * Both are logged, because otherwise the design's central claim — storage
 * bounded, no cap needed — quietly stops being true and nothing says so.
 */
export async function pruneSupersededBrandLogos(
  documents: DocumentRepository,
  orgId: string,
  keep: {
    justUploaded: string;
    /** Resolves to the CURRENT pinned document id, or null when nothing is
     *  pinned. MUST THROW, never guess, when that cannot be determined. */
    getPinned: () => Promise<string | null>;
    /** Minimum age (ms) a row must have before it is eligible for deletion —
     *  see the module doc for why this, not timestamp comparison or listing
     *  order, is the actual concurrency guard. */
    graceMs: number;
  },
  log?: Logger,
): Promise<BrandLogoPruneResult> {
  const nothing: BrandLogoPruneResult = { removed: [], lostPinnedId: null };

  let rows: DocumentSummary[];
  try {
    rows = await documents.listByOwnerPurpose(orgId, "brand-logo");
  } catch (err) {
    log?.error({ err, orgId }, "brand-logo-prune: listing failed — every superseded row is left behind, not just one");
    return nothing;
  }

  const now = Date.now();
  const removed: DocumentSummary[] = [];
  for (const row of rows) {
    if (row.id === keep.justUploaded) continue;
    const ageMs = now - Date.parse(row.createdAt);
    // Too young to safely call "abandoned" — it may be a concurrent sibling
    // upload whose own request started around the same time as this one.
    // This is the actual concurrency guard; see the module doc.
    if (!(ageMs >= keep.graceMs)) continue;

    let pinnedNow: string | null;
    try {
      pinnedNow = await keep.getPinned();
    } catch (err) {
      log?.error({ err, orgId, documentId: row.id }, "brand-logo-prune: could not confirm this row is unpinned — leaving it in place");
      continue;
    }
    if (row.id === pinnedNow) continue;

    try {
      // The owner and purpose are passed again on the DELETE, not just the
      // id: the repository refuses a row that does not match both, so a bug
      // here cannot reach a KYB certificate or an invoice PDF.
      await documents.removeByOwnerPurpose(row.id, orgId, "brand-logo");
      removed.push(row);
    } catch (err) {
      log?.error({ err, orgId, documentId: row.id }, "brand-logo-prune: could not delete a superseded row — left in place");
    }
  }

  // THE RESIDUAL WINDOW: a PATCH pinning a row strictly between that row's
  // getPinned() read above and its DELETE succeeding. Detect it rather than
  // pretend it cannot happen. Best-effort — this is reporting, not a gate;
  // the deletion has already happened by the time this runs.
  let lostPinnedId: string | null = null;
  if (removed.length) {
    const pinnedAfter = await keep.getPinned().catch(() => null);
    const lost = removed.find((r) => r.id === pinnedAfter);
    if (lost) {
      lostPinnedId = lost.id;
      log?.error({ orgId, documentId: lost.id }, "brand-logo-prune: deleted a row that became the pinned mark during the sweep");
    }
  }

  return { removed, lostPinnedId };
}
