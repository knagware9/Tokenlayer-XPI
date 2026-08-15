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
  canView: orgScopedView,
  // Anyone who may view it may decide it (the routes already exclude the
  // proposer via SELF_APPROVAL). Viewing is limited to PlatformAdmin + the
  // org's own OrgAdmins, which is exactly the approver set.
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
      // EN-D2. The CLOSED CATALOG has no use case and therefore no sandbox
      // variant: this anchors on the platform's real registry, always. Both
      // doors are gated against `null` — `POST /credentials/requests` (draft)
      // and `modeGateProposal` (approve, which is where the work happens) — and
      // `modeGate` reads null as live, so a `tl_test_` key is refused at each.
      // BOTH gates are needed and this comment used to claim the first alone
      // sufficed while neither actually existed: the review found a test key
      // drafting AND approving a live issuance here. Stated rather than
      // defaulted — the whole point of the required field.
      sandbox: false,
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
  canView: orgScopedView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as RevokeCredentialPayload;
    await revokeCredentialById(ctx.deps, pl.credentialId, {
      reason: pl.reason, by: p.proposerId, at: new Date().toISOString(),
    });
  },
};
