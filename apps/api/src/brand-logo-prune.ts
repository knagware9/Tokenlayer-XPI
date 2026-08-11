import type { DocumentRepository, DocumentSummary } from "./persistence/types.js";

/** Minimal structured-error logger — the Fastify `request.log` shape, same
 *  contract as `executors.ts`'s `Logger` and `events.ts`'s `EmitLogger`. */
export interface Logger {
  error(obj: unknown, msg: string): void;
}

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
 * CRITICAL 1 (quality review): the earlier version listed rows AFTER storing
 * this call's own upload and deleted anything that wasn't its own row or the
 * pinned one, with no regard for timing — so two overlapping uploads would
 * each see the OTHER as an abandoned pick and delete it, and the symmetric
 * case lost both.
 *
 * The first fix attempt compared `createdAt` timestamps (skip anything at or
 * after this call's own instant). That is wrong in practice, not just in
 * theory: `createdAt` has millisecond resolution, and against an in-process
 * repository with no real I/O, two requests SEQUENTIAL ONLY BY AWAIT ORDER —
 * not concurrent at all — routinely land on the identical millisecond. Ties
 * were spared by design ("erring toward leaking"), so that fix made ordinary,
 * one-after-another uploads flaky: verified empirically, the pre-existing
 * "the pinned mark survives an upload" test failed about 1 run in 3 with pure
 * timestamp comparison, for a reason that had nothing to do with the bug it
 * was fixing.
 *
 * `candidates` fixes this without depending on clock resolution AT ALL. The
 * caller lists the org's existing brand-logo rows BEFORE storing this
 * request's own upload, and passes THAT list in — nothing else is ever a
 * deletion candidate. This is correct by construction, not by luck: in a
 * single-threaded process, a row cannot appear in a snapshot taken before it
 * was written. So:
 *
 *   - A row created by a genuinely concurrent request AFTER this snapshot was
 *     taken is simply invisible here — it cannot be pruned by this call no
 *     matter what happens afterward.
 *   - Two concurrent requests can each see the other in their OWN snapshot
 *     only if one request's whole store had already completed before the
 *     other's snapshot was taken — which is exactly a genuine happens-before
 *     relationship, not a race, and safe to treat as ordinary supersession.
 *   - The reverse — BOTH seeing each other — is structurally impossible: that
 *     would require each store to precede the other's snapshot, which cannot
 *     hold simultaneously in a single execution order. The symmetric
 *     mutual-deletion case Critical 1 named cannot happen with this shape.
 *
 * CRITICAL 2 (quality review): `keep.getPinned` is called FRESH, immediately
 * before each individual delete, not once for the whole sweep — a PATCH that
 * pins an older mark anywhere before that per-row read is correctly seen and
 * the row is spared. The gap between that read and the DELETE succeeding is a
 * real but much narrower window; `lostPinnedId` reports when it was hit
 * rather than pretending it cannot be.
 *
 * `getPinned` MUST THROW rather than return a guessed `null` when the pin
 * state cannot be determined (e.g. the organization itself cannot be
 * re-read) — treating "unknown" as "nothing pinned" is the null-as-allow
 * shape this program's reviews keep finding, and here it would delete the
 * org's live mark. A throw is caught per-row below and treated as "leave it".
 *
 * BEST-EFFORT BY DESIGN. The upload has already succeeded when this runs; the
 * caller's bytes are stored and their intent is served. A repository failure
 * must not turn that into a 500. If the caller's pre-store listing fails,
 * `candidates` is empty and EVERY superseded row is left behind, not just
 * one — there is no "the next upload collects it" here unless the failure
 * was transient. A failed DELETE leaves that one row. Both are the caller's
 * and this function's job to log, because otherwise the design's central
 * claim — storage bounded, no cap needed — quietly stops being true and
 * nothing says so.
 */
export async function pruneSupersededBrandLogos(
  documents: DocumentRepository,
  orgId: string,
  keep: {
    /** Rows known to exist BEFORE this request stored its own upload — see
     *  the Critical 1 discussion above for why this ordering, not a
     *  post-store listing compared by timestamp, is what actually prevents
     *  concurrent uploads from deleting each other. */
    candidates: DocumentSummary[];
    /** Resolves to the CURRENT pinned document id, or null when nothing is
     *  pinned. MUST THROW, never guess, when that cannot be determined. */
    getPinned: () => Promise<string | null>;
  },
  log?: Logger,
): Promise<BrandLogoPruneResult> {
  const removed: DocumentSummary[] = [];

  for (const row of keep.candidates) {
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
