/**
 * The "TokenLayer Platform" issuer organization — the default signer for
 * onboarding KycCredentials when a use case has no owner org. Seeded
 * idempotently at boot; its DID is registered on-chain when a registry is
 * present (best-effort — boot never fails on it).
 */
import { didKeyFromSeed } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
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
  });
  if (deps.registry) await ensureDidRegistered(deps.registry, did);
  return org;
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
