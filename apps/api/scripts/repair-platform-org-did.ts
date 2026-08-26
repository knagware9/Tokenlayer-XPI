/**
 * One-off repair: rotate the "TokenLayer Platform" org's DID seed IN PLACE
 * when it can no longer be decrypted under the current DID_MASTER_KEY (a key
 * rotation, or a row seeded under a different key entirely).
 *
 *   DID_MASTER_KEY=... pnpm --filter @tokenlayer/api exec tsx scripts/repair-platform-org-did.ts
 *
 * IN PLACE, NOT delete+recreate: the org keeps its existing `id`. Every
 * `ownerOrgId` column across the database (UseCase, Account, ...) references
 * that id, not the DID — a delete+recreate mints a NEW id and silently
 * orphans every one of those references. Preserving the id is what makes
 * this safe; `ensureNamedOrg`/`ensurePlatformIssuerOrg` cannot do this
 * themselves because they only self-heal a missing on-chain registration,
 * never an existing row's seed.
 *
 * Any credential the org already issued keeps its own signed `issuerDid`
 * from when it was issued — history doesn't change, only the org's signing
 * key GOING FORWARD does.
 */
import { didKeyFromSeed } from "@tokenlayer/core";
import { prisma, PrismaOrganizationRepository } from "../src/persistence/prisma/index.js";
import { createKeystore } from "../src/shared/keystore.js";
import { PLATFORM_ORG_NAME } from "../src/shared/platform-org.js";

const keystore = createKeystore(
  process.env.DID_MASTER_KEY ?? (() => { throw new Error("DID_MASTER_KEY is required — the seed is encrypted under it"); })(),
);
const organizations = new PrismaOrganizationRepository();

const existing = await organizations.findByName(PLATFORM_ORG_NAME);
if (!existing) throw new Error(`no organization named "${PLATFORM_ORG_NAME}" found — nothing to repair`);

// Confirm the failure this script exists to fix, rather than rotating a
// perfectly good seed because something else is wrong.
let brokenAsExpected = false;
try {
  keystore.keyOf(existing.didSeedEncrypted);
} catch {
  brokenAsExpected = true;
}
if (!brokenAsExpected) {
  console.log(`org ${existing.id}'s seed decrypts fine under the current key — nothing to repair. Exiting without changes.`);
  await prisma.$disconnect();
  process.exit(0);
}

const seed = keystore.newSeed();
const didSeedEncrypted = keystore.encryptSeed(seed);
const did = didKeyFromSeed(seed).did;

await prisma.organization.update({
  where: { id: existing.id },
  data: { did, didSeedEncrypted },
});

console.log(`repaired org ${existing.id}: ${existing.did} -> ${did} (id unchanged, every ownerOrgId reference stays valid)`);
await prisma.$disconnect();
