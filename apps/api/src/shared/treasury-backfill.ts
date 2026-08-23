import type { AppDeps } from "../context.js";
import { ensurePlatformIssuerOrg } from "./platform-org.js";
import { provisionTreasury } from "./wallets.js";

/**
 * One-time backfill for use cases created before org-owned treasuries
 * shipped: every use case missing an owner is stamped to the Platform org
 * (mirroring seedUseCases' own default for platform-seeded ones); every use
 * case missing a treasury gets one provisioned, exactly as a freshly
 * created use case would. Idempotent — re-running touches only rows still
 * missing either field.
 */
export async function backfillTreasuries(
  deps: Pick<AppDeps, "useCases" | "accounts" | "organizations" | "keystore" | "registry">,
): Promise<{ ownersAssigned: number; treasuriesAssigned: number }> {
  const platformOrg = await ensurePlatformIssuerOrg(deps);
  const all = await deps.useCases.list();
  let ownersAssigned = 0;
  let treasuriesAssigned = 0;
  for (const uc of all) {
    let ownerOrgId = uc.ownerOrgId;
    if (!ownerOrgId) {
      ownerOrgId = platformOrg.id;
      ownersAssigned++;
    }
    let treasuryAccountId = uc.treasuryAccountId;
    if (!treasuryAccountId) {
      treasuryAccountId = await provisionTreasury(deps, ownerOrgId, `${uc.name} treasury`);
      treasuriesAssigned++;
    }
    if (ownerOrgId !== uc.ownerOrgId || treasuryAccountId !== uc.treasuryAccountId) {
      await deps.useCases.update(uc.key, { ...uc, ownerOrgId, treasuryAccountId });
    }
  }
  return { ownersAssigned, treasuriesAssigned };
}
