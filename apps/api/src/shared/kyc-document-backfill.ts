import type { AppDeps } from "../context.js";

/**
 * Every document id referenced by any user's `kyc.idDocument`/
 * `addressDocument`, deduplicated.
 *
 * Exists for `scripts/backfill-kyc-document-purpose.ts`: `GET /documents/:id`
 * refuses a document outright when `purpose === "kyc"`, but that refusal only
 * ever applied going forward — `POST /users/me/kyc/documents` did not stamp
 * `purpose: "kyc"` until that fix shipped, so a document uploaded before then
 * still reads `purpose: null` and is not protected by the refusal, even
 * though a user's `kyc` object already references it. This function finds
 * every such id so the script can retag them; the retagging itself is plain
 * Prisma (there is no repository method to update a document after
 * creation — `purpose` is deliberately write-once through the normal
 * interface, so this one-time correction goes around it rather than adding a
 * permanent update path).
 */
export async function findKycDocumentIds(deps: Pick<AppDeps, "users">): Promise<string[]> {
  const all = await deps.users.list();
  const ids = new Set<string>();
  for (const u of all) {
    const idDoc = u.kyc?.idDocument?.id;
    const addressDoc = u.kyc?.addressDocument?.id;
    if (idDoc) ids.add(idDoc);
    if (addressDoc) ids.add(addressDoc);
  }
  return [...ids];
}
