/**
 * One-time backfill: every use case missing an owning org or a registered
 * treasury gets both, matching what a freshly-created use case gets by
 * construction. Idempotent — safe to re-run.
 *
 *   DATABASE_URL="file:./dev.db" pnpm --filter @tokenlayer/api exec tsx scripts/backfill-treasuries.ts
 *
 * The API now runs this at boot (see server.ts, right after seedUseCases), so
 * an upgraded deployment backfills itself. This script remains the one-off /
 * fallback tool: use it to backfill a database no upgraded API has booted
 * against yet, or to see the counts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ DEPLOY SEQUENCING: SNAPSHOT `UseCase.ownerOrgId` BEFORE YOU PUSH THE SCHEMA
 * ─────────────────────────────────────────────────────────────────────────────
 * `UseCase.ownerOrgId` changed from nullable to `String NOT NULL DEFAULT ""`.
 * On SQLite, `prisma db push --accept-data-loss` for a nullable→required column
 * can report data loss and REBUILD the column — which resets every existing row
 * to the schema default, `""`. This backfill reads `""` as "needs an owner" and
 * assigns the Platform org. That is correct for a genuinely unowned legacy row
 * and CATASTROPHIC for a row that had a real org: it is a silent, unrecoverable
 * transfer of every customer's use cases to the platform, with nothing in the
 * output distinguishing the two cases.
 *
 * This sequence has only ever been exercised against an EMPTY database. Before
 * running `prisma db push --accept-data-loss` against ANY database that might
 * already hold `UseCase` rows with real `ownerOrgId` values:
 *
 *   1. SNAPSHOT FIRST — while the old schema is still live:
 *        sqlite3 dev.db 'SELECT key, ownerOrgId FROM UseCase;' > usecase-owners.txt
 *      (or the equivalent `SELECT key, ownerOrgId FROM "UseCase"` on your DB.)
 *   2. Run the push.
 *   3. DIFF the table against the snapshot BEFORE running this backfill (and
 *      before booting the upgraded API, which runs it automatically):
 *        sqlite3 dev.db 'SELECT key, ownerOrgId FROM UseCase;' | diff usecase-owners.txt -
 *   4. If ANY row's ownerOrgId came back empty that was not empty before: STOP.
 *      Restore those values from the snapshot. Do NOT let the backfill "fix"
 *      them — it will reassign them to the Platform org and the original owner
 *      is then unrecoverable from the database alone.
 *
 * Only when the diff is clean is it safe to run this (or to boot the API).
 */
import { prisma, PrismaAccountRepository, PrismaOrganizationRepository, PrismaUseCaseRepository } from "../src/persistence/prisma/index.js";
import { createKeystore } from "../src/shared/keystore.js";
import { backfillTreasuries } from "../src/shared/treasury-backfill.js";

const keystore = createKeystore(process.env.DID_MASTER_KEY ?? (() => { throw new Error("DID_MASTER_KEY is required — the platform org's DID seed is encrypted under it, same as every organization's"); })());
const result = await backfillTreasuries({
  useCases: new PrismaUseCaseRepository(),
  accounts: new PrismaAccountRepository(),
  organizations: new PrismaOrganizationRepository(),
  keystore,
  registry: undefined,
});
console.log(`owners assigned: ${result.ownersAssigned}, treasuries assigned: ${result.treasuriesAssigned}`);
await prisma.$disconnect();
