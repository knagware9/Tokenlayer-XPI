/**
 * User-lifecycle proposal kinds: gated onboarding (create user + custodial DID
 * + KycCredential) and gated identity revocation (chain-first). USE-CASE scoped:
 * PlatformAdmin always; a UseCaseAdmin of the same use case otherwise.
 */
import { credentialTypeDef, didKeyFromSeed, orgRoleEnabled, type Actor, type LifecycleAction, type Role } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import { issueCredentialFor, revokeCredentialById } from "../identity/credential-issuance.js";
import { coded } from "./executors.js";
import type { TokenClaims } from "../http/support.js";
import { PLATFORM_ORG_NAME } from "./platform-org.js";
import { isSandboxUseCase } from "./sandbox.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "../persistence/types.js";

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
  /**
   * A DID this holder ALREADY HAS, minted by a separately-deployed Identity
   * service — link it instead of minting one.
   *
   * Without this the split topology cannot work at all: onboarding mints a
   * fresh custodial DID per deployment, so the same person onboarded on both
   * sides gets two, and `hasVerifiedIdentity` asks Identity about a DID it has
   * never seen. The answer is "no", forever, for every holder — a gate that
   * looks like policy and is really a plumbing mismatch.
   *
   * Null on every deployment that owns identity (there it mints, and the route
   * REFUSES a supplied DID — accepting one would let an operator point a wallet
   * at someone else's verified identity).
   */
  did: string | null;
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

/**
 * The full onboarding side effect for one row: re-check EMAIL_TAKEN, upsert
 * the account, create the user, mint the custodial DID, and (if `kyc` is
 * present) issue the KycCredential — with the same rollback-on-failure as
 * before. Extracted so `onboard-user-batch` can run the byte-same path per
 * row (M2); behavior-preserving for the single `onboard-user` kind below.
 */
async function onboardSingle(deps: AppDeps, proposer: Actor, pl: OnboardUserPayload, p: ProposalRecord): Promise<void> {
  // Re-check the email — it may have been taken since propose (race ⇒ failed proposal).
  if (await deps.users.findByEmail(pl.email)) throw coded(409, "EMAIL_TAKEN", "email already registered");
  let accountId: string | null = null;
  if (pl.walletAddress) accountId = (await deps.accounts.upsert(pl.walletAddress, pl.email)).id;
  const created = await deps.users.create({
    email: pl.email, passwordHash: pl.passwordHash, role: pl.role, useCaseKey: pl.useCaseKey,
    accountId, active: true, kycStatus: "pending", kyc: pl.kyc ?? null, kind: "human",
  });
  let issuedCredentialId: string | null = null;
  try {
    // LINK, or MINT. A supplied DID belongs to a separately-deployed Identity
    // service: this deployment records it and stores NO seed, because it does
    // not hold that key and must never be able to sign as the holder. It also
    // issues no KycCredential — that is the identity product's act, and the
    // route refuses `did` together with `kyc` so the two cannot be confused.
    // PLAIN IDENTIFIERS: this deployment's users are ordinary accounts. No
    // custodial seed is minted and no credential is issued, because there is no
    // subject DID to issue one to. The route refuses `did` and `kyc` up front,
    // so reaching here with either would be a bug rather than a request.
    if ((deps.subjectIdentifiers ?? "did") === "plain") {
      await deps.audit.append({
        actorId: proposer.id, action: "user-onboarded" as LifecycleAction,
        payload: { userId: created.id, email: pl.email, role: pl.role, did: null, kyc: null },
      });
      return;
    }
    let did: string;
    if (pl.did) {
      did = pl.did;
      await deps.users.update(created.id, { did });
    } else {
      // Mint the custodial DID (same custody as org members: encrypted Ed25519 seed).
      const seed = deps.keystore.newSeed();
      const didSeedEncrypted = deps.keystore.encryptSeed(seed);
      did = didKeyFromSeed(seed).did;
      await deps.users.update(created.id, { did, didSeedEncrypted });
    }
    if (pl.kyc) {
      const issuerOrg = await resolveIssuerOrg(deps, pl.useCaseKey);
      // EN-A (review fix): onboarding SIGNS a KycCredential with this org's DID
      // — the very act the Issuer capability governs. Mirrors the ninth gate in
      // credential-kinds.ts, platform exemption included (platform issuance —
      // the KYB ceremony and this fallback — signs as the platform itself).
      // In a BATCH this throws inside the per-row try, so onboardUserBatchKind
      // marks that ROW failed and the other rows still run: rows may target
      // different use cases, so one owner's envelope must not fail the batch.
      if (issuerOrg.name !== PLATFORM_ORG_NAME && !orgRoleEnabled(issuerOrg.capabilities, "Issuer")) {
        throw coded(403, "ORG_CAPABILITY_MISSING", `organization '${issuerOrg.name}' (${issuerOrg.id}) does not have the 'Issuer' capability`);
      }
      const cred = await issueCredentialFor(deps, {
        issuerOrg, subjectDid: did, type: "KycCredential",
        claims: { legalName: pl.kyc.legalName, country: pl.kyc.country },
        validityDays: credentialTypeDef("KycCredential").validityDays, proposalId: p.id,
        // EN-D2, AND THE CASE THAT PROVES `sandbox` COULD NOT HAVE BEEN DERIVED
        // FROM `credentialUseCaseKey`. This credential stores none — it belongs
        // to the closed catalog — yet the act it is part of is governed by
        // `pl.useCaseKey`, a TOKENIZATION use case, which may perfectly well be
        // a sandbox one. Onboarding a rehearsal user into a sandbox programme
        // must not anchor their KYC credential on a real chain.
        sandbox: await isSandboxUseCase(deps, pl.useCaseKey),
      });
      issuedCredentialId = cred.id;
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
    // DID mint / credential issuance / the post-issuance update / audit append
    // failed ⇒ no user row AND no live credential survives (mirrors the
    // org-member rollback). A credential may already be persisted (and
    // on-chain anchored) by this point, so revoke it chain-first before
    // dropping the user row — best-effort: a revoke failure here must not
    // mask the original error. Proposal becomes `failed`; the operator
    // re-proposes.
    if (issuedCredentialId) {
      await revokeCredentialById(deps, issuedCredentialId, {
        reason: "onboarding rolled back", by: proposer.id, at: new Date().toISOString(),
      }).catch(() => undefined);
    }
    await deps.users.remove(created.id).catch(() => undefined);
    throw err;
  }
}

export const onboardUserKind: ProposalKindHandler = {
  kind: "onboard-user",
  apiScope: "users:onboard",
  canView: userScopedView,
  canApprove: userScopedView,
  async execute(ctx, proposer, p) {
    const pl = p.payload as unknown as OnboardUserPayload;
    await onboardSingle(ctx.deps, proposer, pl, p);
  },
};

export interface OnboardUserBatchPayload {
  rows: OnboardUserPayload[];
}

/** Per-row batch report entry — kept minimal (index + email + outcome only; never echoes the row payload). */
interface BatchRowResult {
  index: number;
  email: string;
  status: "ok" | "failed";
  error?: string;
}

export const onboardUserBatchKind: ProposalKindHandler = {
  kind: "onboard-user-batch",
  apiScope: "users:onboard",
  canView: userScopedView,
  canApprove: userScopedView,
  async execute(ctx, proposer, p) {
    const deps = ctx.deps;
    const pl = p.payload as unknown as OnboardUserBatchPayload;
    const rows: BatchRowResult[] = [];
    for (let i = 0; i < pl.rows.length; i++) {
      const row = pl.rows[i]!;
      try {
        // Byte-same path as the single onboard-user kind — row-independent:
        // one row's failure never aborts the others.
        await onboardSingle(deps, proposer, row, p);
        rows.push({ index: i, email: row.email, status: "ok" });
      } catch (err) {
        rows.push({ index: i, email: row.email, status: "failed", error: (err as Error).message });
      }
    }
    await deps.proposals.setResult(p.id, {
      total: rows.length,
      succeeded: rows.filter((r) => r.status === "ok").length,
      failed: rows.filter((r) => r.status === "failed").length,
      rows,
    });
  },
};

export interface RevokeUserIdentityPayload {
  userId: string;
  reason: string;
}

export const revokeUserIdentityKind: ProposalKindHandler = {
  kind: "revoke-user-identity",
  // The coarse vocabulary has ONE user-write scope, and this is a user-lifecycle
  // write; it matches the gate on the route that drafts it
  // (POST /users/:id/revoke-identity). A separate `users:revoke` would be finer
  // but the spec deliberately chose coarse resource:action scopes.
  apiScope: "users:onboard",
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
