/**
 * The "TokenLayer Platform" issuer organization — the default signer for
 * onboarding KycCredentials when a use case has no owner org. Seeded
 * idempotently at boot; its DID is registered on-chain when a registry is
 * present (best-effort — boot never fails on it).
 */
import { didKeyFromSeed, type OrgType } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { mintOrgMembership } from "./membership.js";
import type { OrganizationRecord } from "./persistence/types.js";

export const PLATFORM_ORG_NAME = "TokenLayer Platform";

type PlatformOrgDeps = Pick<AppDeps, "organizations" | "keystore" | "registry">;

/**
 * Idempotently seed an active, verified organization with a custodial DID,
 * registering its DID on-chain (best-effort) when a registry is present. Shared
 * by the platform issuer org and the demo desk organizations (e.g. M1xchange).
 */
export async function ensureNamedOrg(
  deps: PlatformOrgDeps,
  spec: { name: string; orgType: OrgType; jurisdiction?: string | null },
): Promise<OrganizationRecord> {
  const existing = await deps.organizations.findByName(spec.name);
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
    name: spec.name,
    orgType: spec.orgType,
    registrationId: null,
    jurisdiction: spec.jurisdiction ?? null,
    did,
    didSeedEncrypted,
    status: "active",
    verified: true,
    verifiedAt: new Date().toISOString(),
    companyProfile: null,
    capabilities: null, // platform boot org keeps the unrestricted legacy envelope
    brandLogoDocumentId: null, brandAccent: null, // EN-E: a new org starts on the platform look
  });
  if (deps.registry) await ensureDidRegistered(deps.registry, did);
  return org;
}

export async function ensurePlatformIssuerOrg(deps: PlatformOrgDeps): Promise<OrganizationRecord> {
  return ensureNamedOrg(deps, { name: PLATFORM_ORG_NAME, orgType: "verifier", jurisdiction: null });
}

/**
 * Give a set of seeded users (by email) a real identity under `org`: a custodial
 * sub-DID + an OrganizationMembership credential carrying their existing role, so
 * their profile and credentials pages are populated like any other member.
 * Idempotent (skips a user who already holds a DID) and best-effort (a failure is
 * logged, never blocks boot). Tenancy orgId stays null so global RBAC and
 * maker-checker onboarding are unchanged.
 */
export async function provisionOrgMemberIdentities(
  deps: Pick<AppDeps, "keystore" | "users" | "credentials">,
  org: OrganizationRecord,
  emails: readonly string[],
): Promise<void> {
  for (const email of emails) {
    try {
      const user = await deps.users.findByEmail(email);
      if (!user || user.did) continue;
      await mintOrgMembership(deps, org, user, user.role, { linkOrgId: false });
    } catch (err) {
      console.warn(`[platform-org] identity provisioning for ${email} failed (skipped): ${(err as Error).message}`);
    }
  }
}

/**
 * Link a demo operator to a wallet when it has none, so its profile shows a
 * wallet address. Idempotent; best-effort. Used for seeded desk operators (e.g.
 * the invoice issuer) that predate wallet linkage.
 */
export async function ensureUserWallet(
  deps: Pick<AppDeps, "users" | "accounts">,
  email: string,
  address: string,
  label: string,
): Promise<void> {
  try {
    const user = await deps.users.findByEmail(email);
    if (!user || user.accountId) return;
    const acct = await deps.accounts.upsert(address, label);
    await deps.users.update(user.id, { accountId: acct.id });
  } catch (err) {
    console.warn(`[platform-org] wallet linkage for ${email} failed (skipped): ${(err as Error).message}`);
  }
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
