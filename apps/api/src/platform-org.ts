/**
 * The "TokenLayer Platform" issuer organization — the default signer for
 * onboarding KycCredentials when a use case has no owner org. Seeded
 * idempotently at boot; its DID is registered on-chain when a registry is
 * present (best-effort — boot never fails on it).
 */
import { didKeyFromSeed } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { mintOrgMembership } from "./membership.js";
import type { OrganizationRecord } from "./persistence/types.js";

export const PLATFORM_ORG_NAME = "TokenLayer Platform";

type PlatformOrgDeps = Pick<AppDeps, "organizations" | "keystore" | "registry">;

export async function ensurePlatformIssuerOrg(deps: PlatformOrgDeps): Promise<OrganizationRecord> {
  const existing = await deps.organizations.findByName(PLATFORM_ORG_NAME);
  if (existing) {
    // Self-heal: if the first boot's best-effort registration failed (chain
    // briefly unreachable), the org exists but its DID is unregistered on-chain
    // — retry so verifiers trusting the DidRegistry stop rejecting it.
    if (deps.registry) await ensureDidRegistered(deps.registry, existing.did);
    return existing;
  }
  const seed = deps.keystore.newSeed();
  const didSeedEncrypted = deps.keystore.encryptSeed(seed);
  const did = didKeyFromSeed(seed).did;
  const org = await deps.organizations.create({
    name: PLATFORM_ORG_NAME,
    orgType: "verifier",
    registrationId: null,
    jurisdiction: null,
    did,
    didSeedEncrypted,
    status: "active",
    verified: true,
    verifiedAt: new Date().toISOString(),
    companyProfile: null,
  });
  if (deps.registry) await ensureDidRegistered(deps.registry, did);
  return org;
}

/**
 * Give the seeded Platform Admins a real identity: a custodial sub-DID plus an
 * OrganizationMembership credential issued by the platform org, so their
 * profile and credentials pages are populated like any other member. Idempotent
 * (skips a user who already holds a DID) and best-effort (a failure is logged,
 * never blocks boot). Leaves each admin's tenancy orgId null so global RBAC and
 * maker-checker onboarding stay exactly as before.
 */
export async function provisionPlatformOperatorIdentities(
  deps: Pick<AppDeps, "keystore" | "users" | "credentials">,
  org: OrganizationRecord,
): Promise<void> {
  const all = await deps.users.list();
  for (const user of all.filter((u) => u.role === "PlatformAdmin" && !u.did)) {
    try {
      await mintOrgMembership(deps, org, user, "PlatformAdmin", { linkOrgId: false });
    } catch (err) {
      console.warn(`[platform-org] identity provisioning for ${user.email} failed (skipped): ${(err as Error).message}`);
    }
  }
}

/**
 * Best-effort on-chain DID registration, used both on first seed and on later
 * boots to retry a registration that failed while the chain was unreachable.
 * Reads the same registration state GET /registry exposes and only writes when
 * unregistered. An unreachable chain (read OR write) must never block boot.
 */
async function ensureDidRegistered(registry: NonNullable<PlatformOrgDeps["registry"]>, did: string): Promise<void> {
  try {
    const { registered } = await registry.anchor.didRegistration(registry.didRegistry, did);
    if (registered) return;
    await registry.anchor.registerDid(registry.didRegistry, did);
  } catch (err) {
    console.warn(`[platform-org] on-chain DID registration failed (will remain unregistered): ${(err as Error).message}`);
  }
}
