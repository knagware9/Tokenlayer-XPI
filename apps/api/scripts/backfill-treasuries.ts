/**
 * One-time backfill: every use case missing an owning org or a registered
 * treasury gets both, matching what a freshly-created use case gets by
 * construction. Idempotent — safe to re-run.
 *
 *   DATABASE_URL="file:./dev.db" pnpm --filter @tokenlayer/api exec tsx scripts/backfill-treasuries.ts
 *
 * Run once against each live database (combined stack's dev.db, and both
 * split stacks' — every stack has UseCase rows that predate this feature).
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
