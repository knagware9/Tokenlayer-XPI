/**
 * User-lifecycle proposal kinds: gated onboarding (create user + custodial DID
 * + KycCredential) and gated identity revocation (chain-first). USE-CASE scoped:
 * PlatformAdmin always; a UseCaseAdmin of the same use case otherwise.
 */
import { didKeyFromSeed, type LifecycleAction, type Role } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { issueCredentialFor, revokeCredentialById } from "./credential-issuance.js";
import { coded } from "./executors.js";
import type { TokenClaims } from "./http/support.js";
import { PLATFORM_ORG_NAME } from "./platform-org.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "./persistence/types.js";

/** PlatformAdmin always; a UseCaseAdmin of the SAME use case. Never null-matches. */
const userScopedView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  claims.role === "PlatformAdmin" ||
  (claims.role === "UseCaseAdmin" && p.useCaseKey !== null && claims.useCaseKey === p.useCaseKey);

export interface OnboardUserPayload {
  email: string;
  passwordHash: string;          // hashed at propose time — plaintext never stored
  role: Role;
  useCaseKey: string | null;
  walletAddress: string | null;
  kyc: { legalName: string; country: string; idType?: string; idNumber?: string; documentRef?: string } | null;
}

/** ownerOrg of the use case when present, else the platform issuer org. */
async function resolveIssuerOrg(deps: AppDeps, useCaseKey: string | null) {
  if (useCaseKey) {
    const uc = await deps.useCases.get(useCaseKey).catch(() => null);
    if (uc?.ownerOrgId) {
      const org = await deps.organizations.get(uc.ownerOrgId);
      if (org) return org;
    }
  }
  const platform = await deps.organizations.findByName(PLATFORM_ORG_NAME);
  if (!platform) throw coded(503, "PLATFORM_ISSUER_MISSING", "the platform issuer org is not seeded");
  return platform;
}

export const onboardUserKind: ProposalKindHandler = {
  kind: "onboard-user",
  canView: userScopedView,
  canApprove: userScopedView,
  async execute(ctx, proposer, p) {
    const deps = ctx.deps;
    const pl = p.payload as unknown as OnboardUserPayload;
    // Re-check the email — it may have been taken since propose (race ⇒ failed proposal).
    if (await deps.users.findByEmail(pl.email)) throw coded(409, "EMAIL_TAKEN", "email already registered");
    let accountId: string | null = null;
    if (pl.walletAddress) accountId = (await deps.accounts.upsert(pl.walletAddress, pl.email)).id;
    const created = await deps.users.create({
      email: pl.email, passwordHash: pl.passwordHash, role: pl.role, useCaseKey: pl.useCaseKey,
      accountId, active: true, kycStatus: "pending", kyc: pl.kyc ?? null,
    });
    try {
      // Mint the custodial DID (same custody as org members: encrypted Ed25519 seed).
      const seed = deps.keystore.newSeed();
      const didSeedEncrypted = deps.keystore.encryptSeed(seed);
      const did = didKeyFromSeed(seed).did;
      await deps.users.update(created.id, { did, didSeedEncrypted });
      if (pl.kyc) {
        const issuerOrg = await resolveIssuerOrg(deps, pl.useCaseKey);
        const cred = await issueCredentialFor(deps, {
          issuerOrg, subjectDid: did, type: "KycCredential",
          claims: { legalName: pl.kyc.legalName, country: pl.kyc.country },
          proposalId: p.id,
        });
        await deps.users.update(created.id, {
          kycStatus: "approved",
          kyc: { ...pl.kyc, issuerDid: issuerOrg.did, credentialId: cred.id, verifiedAt: new Date().toISOString() },
        });
      }
      await deps.audit.append({
        actorId: proposer.id, action: "user-onboarded" as LifecycleAction,
        payload: { userId: created.id, email: pl.email, role: pl.role, did, kyc: pl.kyc ? { country: pl.kyc.country } : null },
      });
    } catch (err) {
      // DID mint / credential issuance failed ⇒ no user row survives (mirrors the
      // org-member rollback). Proposal becomes `failed`; the operator re-proposes.
      await deps.users.remove(created.id).catch(() => undefined);
      throw err;
    }
  },
};

export interface RevokeUserIdentityPayload {
  userId: string;
  reason: string;
}

export const revokeUserIdentityKind: ProposalKindHandler = {
  kind: "revoke-user-identity",
  canView: userScopedView,
  canApprove: userScopedView,
  async execute(ctx, proposer, p) {
    const deps = ctx.deps;
    const pl = p.payload as unknown as RevokeUserIdentityPayload;
    const user = await deps.users.findById(pl.userId);
    if (!user) throw coded(404, "NOT_FOUND", "user missing");
    const at = new Date().toISOString();
    if (user.did) {
      // Chain-first per credential; any on-chain failure fails the proposal
      // BEFORE the DB flip — the DB is never "more revoked" than the chain.
      const held = (await deps.credentials.listByHolder(user.did)).filter((c) => !c.revoked);
      for (const c of held) {
        await revokeCredentialById(deps, c.id, { reason: pl.reason, by: p.proposerId, at });
      }
    }
    await deps.users.update(user.id, {
      kycStatus: "rejected",
      kyc: { ...(user.kyc ?? {}), revokedAt: at, revokeReason: pl.reason },
    });
    await deps.audit.append({
      actorId: proposer.id, action: "user-identity-revoked" as LifecycleAction,
      payload: { userId: user.id, reason: pl.reason },
    });
  },
};
