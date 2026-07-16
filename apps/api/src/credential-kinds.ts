/**
 * Credential proposal kinds: issuing and revoking a Verifiable Credential, both
 * gated by the credential type's own maker-checker depth. These are ORG scoped —
 * unlike token kinds, which are use-case scoped.
 */
import { randomUUID } from "node:crypto";
import { credentialTypeDef } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { coded } from "./executors.js";
import type { TokenClaims } from "./http/support.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "./persistence/types.js";

/** PlatformAdmin, or an OrgAdmin of the proposal's own org. Never null-matches. */
const orgScopedView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  claims.role === "PlatformAdmin" || (claims.role === "OrgAdmin" && !!p.orgId && claims.orgId === p.orgId);

export interface IssueCredentialPayload {
  type: string;
  subjectDid: string;
  subjectUserId: string;
  claims: Record<string, unknown>;
  issuerOrgId: string;
}

export const issueCredentialKind: ProposalKindHandler = {
  kind: "issue-credential",
  canView: orgScopedView,
  // Anyone who may view it may decide it (the routes already exclude the
  // proposer via SELF_APPROVAL). Viewing is limited to PlatformAdmin + the
  // org's own OrgAdmins, which is exactly the approver set.
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as IssueCredentialPayload;
    const def = credentialTypeDef(pl.type);
    const org = await ctx.deps.organizations.get(pl.issuerOrgId);
    if (!org) throw coded(404, "NOT_FOUND", "issuing organization missing");

    // The id is generated BEFORE signing: the VC embeds it in jti + credentialStatus.
    const credentialId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const statusUrl = `${ctx.deps.publicApiUrl}/credentials/${credentialId}/status`;
    const { vcJwt, expiresAt } = ctx.deps.keystore.issueOrgCredential({
      orgEncSeed: org.didSeedEncrypted, orgDid: org.did, subjectDid: pl.subjectDid,
      type: pl.type, claims: pl.claims, credentialId, statusUrl, validityDays: def.validityDays, now,
    });
    await ctx.deps.credentials.create({
      id: credentialId,
      holderDid: pl.subjectDid,
      issuerDid: org.did,
      type: pl.type,
      vcJwt,
      subjectClaims: { id: pl.subjectDid, ...pl.claims },
      issuedAt: new Date(now * 1000).toISOString(),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
      proposalId: p.id,
    });
  },
};

export interface RevokeCredentialPayload {
  credentialId: string;
  reason: string;
}

export const revokeCredentialKind: ProposalKindHandler = {
  kind: "revoke-credential",
  canView: orgScopedView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as RevokeCredentialPayload;
    const cred = await ctx.deps.credentials.get(pl.credentialId);
    if (!cred) throw coded(404, "NOT_FOUND", "credential missing");
    if (cred.revoked) throw coded(409, "ALREADY_REVOKED", "credential is already revoked");
    await ctx.deps.credentials.revoke(cred.id, { reason: pl.reason, by: p.proposerId, at: new Date().toISOString() });
  },
};
