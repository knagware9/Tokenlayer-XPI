import type { DocumentRepository } from "./persistence/types.js";

/**
 * DELETE THE ORGANIZATION'S SUPERSEDED BRAND LOGOS.
 *
 * `POST /orgs/{id}/branding/logo` may store up to 5MB, and before this existed
 * every reconsidered pick left a row behind forever. There is no cap and no
 * scheduled sweep: each upload cleans up after the ones before it, so the steady
 * state is at most two rows per organization — the live mark and the one in
 * flight — with no threshold to tune and no cron to run.
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
 * BEST-EFFORT BY DESIGN. The upload has already succeeded when this runs; the
 * caller's bytes are stored and their intent is served. A repository failure
 * must not turn that into a 500, and what it leaves behind is one bounded row,
 * which the next upload collects. Returns the ids actually removed, for the
 * audit entry — empty when there was nothing to do or nothing could be done.
 *
 * CONCURRENCY. Two simultaneous uploads can each spare the other's row, and the
 * next upload collects both. The bound is "small", not "exactly two".
 */
export async function pruneSupersededBrandLogos(
  documents: DocumentRepository,
  orgId: string,
  keep: { justUploaded: string; pinned: string | null },
): Promise<string[]> {
  const removed: string[] = [];
  try {
    for (const row of await documents.listByOwnerPurpose(orgId, "brand-logo")) {
      if (row.id === keep.justUploaded || row.id === keep.pinned) continue;
      try {
        // The owner and purpose are passed again on the DELETE, not just the id:
        // the repository refuses a row that does not match both, so a bug here
        // cannot reach a KYB certificate or an invoice PDF.
        await documents.removeByOwnerPurpose(row.id, orgId, "brand-logo");
        removed.push(row.id);
      } catch {
        // One row that will not delete is not worth failing an upload over, and
        // it must not stop the rest of the sweep either.
      }
    }
  } catch {
    // Listing failed. The upload still stands; nothing was removed.
  }
  return removed;
}
