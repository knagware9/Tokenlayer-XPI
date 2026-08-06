/**
 * Config-driven credential issuance (ID-B). A bound issuer issues a configured
 * credential type to an eligible holder, through maker-checker. ORG scoped to
 * the issuer org (like the closed-catalog credential kinds), but the type's
 * claim schema + validity come from the CredentialUseCase config, not the
 * closed catalog.
 */
import { credentialUseCaseType } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { coded } from "./executors.js";
import { issueCredentialFor } from "./credential-issuance.js";
import type { TokenClaims } from "./http/support.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "./persistence/types.js";

const orgScopedView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  claims.role === "PlatformAdmin" || (claims.role === "OrgAdmin" && !!p.orgId && claims.orgId === p.orgId);

export interface IssueUsecaseCredentialPayload {
  credentialUseCaseKey: string;
  credentialType: string;
  subjectDid: string;
  subjectUserId?: string;
  subjectOrgId?: string;
  claims: Record<string, unknown>;
  issuerOrgId: string;
}

export const issueUsecaseCredentialKind: ProposalKindHandler = {
  kind: "issue-usecase-credential",
  canView: orgScopedView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as IssueUsecaseCredentialPayload;
    // Re-resolve fresh config at execution — never sign stale config.
    const def = await ctx.deps.credentialUseCases.get(pl.credentialUseCaseKey);
    if (!def) throw coded(404, "UNKNOWN_USECASE", `credential use case '${pl.credentialUseCaseKey}' missing`);
    const spec = credentialUseCaseType(def, pl.credentialType); // throws UNKNOWN_CREDENTIAL_TYPE
    const org = await ctx.deps.organizations.get(pl.issuerOrgId);
    if (!org) throw coded(404, "NOT_FOUND", "issuing organization missing");
    await issueCredentialFor(ctx.deps, {
      issuerOrg: org, subjectDid: pl.subjectDid, type: spec.name, claims: pl.claims,
      validityDays: spec.validityDays, credentialUseCaseKey: def.key, proposalId: p.id,
      initialAcceptance: def.holderAcceptance ? "pending" : "accepted",
    });
  },
};
