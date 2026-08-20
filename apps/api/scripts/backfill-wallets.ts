/**
 * One-time backfill: assign a wallet to every existing user in a role that
 * can hold tokens (Buyer/Trader/Issuer) but has none, matching the
 * auto-assignment new users get at creation. Idempotent — safe to re-run.
 *
 *   DATABASE_URL="file:./dev.db" pnpm --filter @tokenlayer/api exec tsx scripts/backfill-wallets.ts
 *
 * Run once against each live database (combined stack's dev.db, and the
 * tokenization split stack's tokenization.db — the identity split stack has
 * no Buyer/Trader/Issuer users, so it is a no-op there).
 *
 * The core logic lives in `src/shared/wallets.ts`'s `backfillWallets`, tested
 * against the memory repositories in `test/wallets.test.ts`; this file is
 * only the real-database wiring, mirroring `write-openapi-snapshot.ts`.
 */
import { prisma, PrismaAccountRepository, PrismaUserRepository } from "../src/persistence/prisma/index.js";
import { backfillWallets } from "../src/shared/wallets.js";

const result = await backfillWallets({
  users: new PrismaUserRepository(),
  accounts: new PrismaAccountRepository(),
});
console.log(`assigned ${result.assigned} wallet(s)`);
await prisma.$disconnect();
