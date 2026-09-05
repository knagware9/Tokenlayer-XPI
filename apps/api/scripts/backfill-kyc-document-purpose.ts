/**
 * One-time backfill: every Document referenced as a user's KYC id proof or
 * address proof gets its `purpose` retagged to `"kyc"`.
 *
 *   DATABASE_URL="file:./dev.db" pnpm --filter @tokenlayer/api exec tsx scripts/backfill-kyc-document-purpose.ts
 *
 * WHY THIS EXISTS: `GET /documents/:id` refuses a document outright when
 * `purpose === "kyc"` — the fix for a UseCaseAdmin/Issuer/Auditor being able
 * to read anyone's KYC ID scan or address proof through that pre-existing,
 * ownership-free route (it only ever checked role, never who uploaded the
 * document). But `POST /users/me/kyc/documents` did not stamp
 * `purpose: "kyc"` on upload until that same fix shipped. Any document
 * uploaded BEFORE then is already referenced by a user's `kyc.idDocument`/
 * `addressDocument`, but sits in the database with `purpose: null` — so the
 * new refusal never fires for it, and the original bypass still works
 * against exactly the documents most likely to still be live: the ones
 * submitted before anyone knew to protect them. This script closes that gap
 * for existing data; the route-level fix already covers everything uploaded
 * from here on.
 *
 * Idempotent — a document already tagged `"kyc"` is left alone, and a
 * referenced id that no longer resolves to a row is just counted, not an
 * error. Safe to re-run.
 *
 * Run once against every live database that has ever had a real KYC
 * submission before this fix shipped (any deployment's dev.db/
 * tokenization.db that has exercised `POST /users/me/kyc/submit`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠ KNOWN GAP: A DOCUMENT ORPHANED BY A RESUBMISSION BEFORE THIS RUNS STAYS
 *   UNPROTECTED, AND THERE IS NO SAFE WAY TO FIND IT AFTERWARD
 * ─────────────────────────────────────────────────────────────────────────
 * This script finds documents to retag by walking LIVE user records —
 * `kyc.idDocument`/`addressDocument` as they stand right now. A resubmission
 * (`POST /users/me/kyc/submit`) always points those fields at the NEWLY
 * uploaded pair, so a user's PREVIOUS id/address documents — from before
 * this fix shipped — become invisible to this script the moment they
 * resubmit, even once. Those old rows still sit in the database with
 * `purpose: null` and are still readable through the original
 * `GET /documents/:id` bypass forever, because nothing ever references them
 * again for this script to find.
 *
 * There is no honest broader fix: a `purpose: null` row is indistinguishable
 * from any other document nobody bothered to tag (this codebase already
 * treats a null `purpose`/`ownerOrgId` this way for brand-logo documents —
 * see the `Document.purpose` column's own comment in `prisma/schema.prisma`,
 * "there is no honest way to guess what a legacy row was for"). Retagging
 * every null-purpose document as `"kyc"` on the theory that most of them
 * probably were would silently misclassify whatever else stores documents
 * with no purpose today, and there is no reliable signal (size, content
 * type, uploader role) that distinguishes a KYC scan from those with any
 * real confidence.
 *
 * Run this BEFORE any real resubmission traffic hits a deployment carrying
 * pre-fix KYC data — the sooner it runs relative to the fix shipping, the
 * fewer users will have resubmitted out from under it. After that window,
 * closing the remaining gap for a specific known-orphaned document requires
 * a manual, case-by-case decision (confirm who uploaded it and why via
 * `uploadedBy`/`createdAt`, then tag or delete it by hand) rather than
 * another automated sweep.
 */
import { prisma, PrismaUserRepository } from "../src/persistence/prisma/index.js";
import { findKycDocumentIds } from "../src/shared/kyc-document-backfill.js";

const ids = await findKycDocumentIds({ users: new PrismaUserRepository() });

let tagged = 0;
let alreadyTagged = 0;
let missing = 0;
for (const id of ids) {
  const doc = await prisma.document.findUnique({ where: { id }, select: { purpose: true } });
  if (!doc) {
    missing++;
    continue;
  }
  if (doc.purpose === "kyc") {
    alreadyTagged++;
    continue;
  }
  await prisma.document.update({ where: { id }, data: { purpose: "kyc" } });
  tagged++;
}

console.log(`tagged ${tagged} document(s) as "kyc" (${alreadyTagged} already tagged, ${missing} referenced id(s) not found)`);
await prisma.$disconnect();
