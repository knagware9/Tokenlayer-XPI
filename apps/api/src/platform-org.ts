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
  if (existing) return existing;
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
  if (deps.registry) {
    // Best-effort: an unreachable chain must not block boot.
    await deps.registry.anchor.registerDid(deps.registry.didRegistry, did).catch((err) =>
      console.warn(`[platform-org] on-chain DID registration failed (will remain unregistered): ${(err as Error).message}`));
  }
  return org;
}
