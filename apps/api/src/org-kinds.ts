/**
 * Organization proposal kinds (EN-A): an OrgAdmin requests a change to their
 * org's capability envelope; only a PLATFORM admin may grant it — the platform
 * is the granting authority, so unlike the credential kinds the approver set is
 * narrower than the viewer set (the org's own OrgAdmins may watch the request
 * but never decide it). ORG scoped, same no-runtime-cycle TYPE-only import
 * pattern as the other kind modules.
 */
import { validateOrgCapabilities, type LifecycleAction, type OrgCapabilities } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { coded } from "./executors.js";
import type { TokenClaims } from "./http/support.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "./persistence/types.js";

/** PlatformAdmin, or an OrgAdmin of the proposal's own org. Never null-matches. */
const orgScopedView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  claims.role === "PlatformAdmin" || (claims.role === "OrgAdmin" && !!p.orgId && claims.orgId === p.orgId);

export interface OrgCapabilityChangePayload {
  orgId: string;
  capabilities: OrgCapabilities;
}

export const orgCapabilityChangeKind: ProposalKindHandler = {
  kind: "org-capability-change",
  canView: orgScopedView,
  // Only the platform grants capabilities — a second OrgAdmin of the same org
  // may view the request but not approve it (SELF_APPROVAL already blocks the
  // proposer; this blocks every other org-side decider too).
  canApprove: async (_deps, claims) => claims.role === "PlatformAdmin",
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as OrgCapabilityChangePayload;
    // Never trust a stale payload: re-validate the envelope at execution time.
    const capabilities = validateOrgCapabilities(pl.capabilities);
    const org = await ctx.deps.organizations.get(pl.orgId);
    if (!org) throw coded(404, "NOT_FOUND", "organization missing");
    await ctx.deps.organizations.setCapabilities(org.id, capabilities);
    await ctx.deps.audit.append({
      actorId: p.proposerId, action: "org-capabilities-changed" as LifecycleAction,
      payload: { orgId: org.id, capabilities, proposalId: p.id },
    });
  },
};
