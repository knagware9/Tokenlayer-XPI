/**
 * Credential proposal kinds: issuing and revoking a Verifiable Credential, both
 * gated by the credential type's own maker-checker depth. These are ORG scoped —
 * unlike token kinds, which are use-case scoped.
 */
import { credentialTypeDef, orgRoleEnabled } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import { coded } from "../shared/executors.js";
import { issueCredentialFor, revokeCredentialById } from "./credential-issuance.js";
import { PLATFORM_ORG_NAME } from "../shared/platform-org.js";
import type { TokenClaims } from "../http/support.js";
import type { ProposalKindHandler } from "../shared/proposal-kinds.js";
import type { ProposalRecord } from "../persistence/types/index.js";

/** PlatformAdmin, or an OrgAdmin of the proposal's own org. Never null-matches. */
const orgScopedView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  claims.role === "PlatformAdmin" || (claims.role === "OrgAdmin" && !!p.orgId && claims.orgId === p.orgId);

/**
 * `orgScopedView`, plus the proposer of THIS proposal — an Issuer who is not
 * an OrgAdmin still gets no seat at `canApprove` (SELF_APPROVAL blocks their
 * own proposal regardless, and they were never in `orgScopedView`'s audience
 * to begin with), but they can at least see the outcome of what they
 * proposed instead of a 404 that reads as "this proposal doesn't exist."
 * Deliberately NOT used for `canApprove` — widening that would let a maker
 * decide their own proposal, the exact thing maker-checker exists to prevent.
 */
const orgScopedOrOwnView = async (deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  claims.id === p.proposerId || orgScopedView(deps, claims, p);

export interface IssueCredentialPayload {
  type: string;
  subjectDid: string;
  subjectUserId: string;
  claims: Record<string, unknown>;
  issuerOrgId: string;
}

export const issueCredentialKind: ProposalKindHandler = {
  kind: "issue-credential",
  apiScope: "credentials:issue",
  // The proposer may always see their own proposal (orgScopedOrOwnView), but
  // deciding it is narrower: PlatformAdmin + the org's own OrgAdmins, with
  // SELF_APPROVAL blocking any of those who happen to be the proposer too.
  canView: orgScopedOrOwnView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as IssueCredentialPayload;
    const org = await ctx.deps.organizations.get(pl.issuerOrgId);
    if (!org) throw coded(404, "NOT_FOUND", "issuing organization missing");
    // EN-A execution-time re-check: the envelope may have been tightened
    // between propose and approve. The platform org is exempt — platform
    // issuance (KYB ceremony, onboarding KYC) signs as the platform itself.
    // (coded() carries no details object — orgId rides in the message.)
    if (org.name !== PLATFORM_ORG_NAME && !orgRoleEnabled(org.capabilities, "Issuer")) {
      throw coded(403, "ORG_CAPABILITY_MISSING", `organization '${org.name}' (${org.id}) does not have the 'Issuer' capability`);
    }
    await issueCredentialFor(ctx.deps, {
      issuerOrg: org, subjectDid: pl.subjectDid, type: pl.type, claims: pl.claims,
      validityDays: credentialTypeDef(pl.type).validityDays, proposalId: p.id,
    });
  },
};

export interface RevokeCredentialPayload {
  credentialId: string;
  reason: string;
}

export const revokeCredentialKind: ProposalKindHandler = {
  kind: "revoke-credential",
  apiScope: "credentials:revoke",
  canView: orgScopedOrOwnView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as RevokeCredentialPayload;
    await revokeCredentialById(ctx.deps, pl.credentialId, {
      reason: pl.reason, by: p.proposerId, at: new Date().toISOString(),
    });
  },
};
