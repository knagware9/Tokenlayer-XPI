/**
 * Use-case configuration proposal kind: an active OrgAdmin proposes a new
 * (org-owned) use case; a PlatformAdmin approves it, at which point the use case
 * is created and its contract deployed on every allowed+available chain. ORG
 * scoped — like the credential kinds — so an OrgAdmin sees only their own org's
 * proposals; a second OrgAdmin cannot exist without PlatformAdmin action, so
 * approval is effectively platform-gated (the sole proposer is blocked by SoD).
 */
import { orgDomainEnabled, type UseCaseDefinition } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { coded } from "./executors.js";
import type { TokenClaims } from "./http/support.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "./persistence/types.js";
import { deployAndCreateUseCase } from "./use-cases.js";
import { namespaceHolding } from "./usecase-namespace.js";

/** PlatformAdmin, or an OrgAdmin of the proposal's own org. Never null-matches. */
const orgScopedView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  claims.role === "PlatformAdmin" || (claims.role === "OrgAdmin" && !!p.orgId && claims.orgId === p.orgId);

export const createUseCaseKind: ProposalKindHandler = {
  kind: "create-use-case",
  // Creating + deploying a use case is configuration authoring.
  apiScope: "usecases:provision",
  canView: orgScopedView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const def = p.payload as unknown as UseCaseDefinition;
    // Re-check the key — it may have been taken since propose (race ⇒ failed
    // proposal), in EITHER domain (a slug is unique across use cases and
    // credential use cases alike).
    if (await ctx.deps.useCases.has(def.key)) throw coded(409, "USECASE_EXISTS", `use case '${def.key}' already exists`);
    // The credential namespace is only consulted where this deployment KEEPS
    // one. On a tokenization-only instance the two namespaces live in different
    // databases, so they cannot collide and there is nothing to ask; asking
    // anyway would fail the proposal on a refusal from the repository guard.
    if ((await namespaceHolding(ctx.deps, def.key)) === "identity") {
      throw coded(409, "KEY_TAKEN", `use-case key '${def.key}' already exists`);
    }
    // EN-A: the owning org must STILL have the tokenization domain — its
    // envelope may have been tightened between propose and approve (the drafting
    // route's friendly 403 is only a snapshot). A null (legacy) envelope passes;
    // a vanished org fails nothing new here (ownership is not existence-checked).
    if (def.ownerOrgId) {
      const owner = await ctx.deps.organizations.get(def.ownerOrgId).catch(() => null);
      if (owner && !orgDomainEnabled(owner.capabilities, "tokenization")) {
        // coded() carries no details object — orgId rides in the message.
        throw coded(403, "ORG_CAPABILITY_MISSING", `organization '${owner.name}' (${owner.id}) does not have the 'tokenization' capability`);
      }
    }
    const available = new Set(ctx.deps.chains.list().map((c) => c.id));
    // Deploy + persist via the shared helper so the NO_DEPLOYABLE_CHAIN surface
    // stays identical to the PlatformAdmin direct-create path.
    await deployAndCreateUseCase(
      ctx.deps.useCases,
      def,
      available,
      (d, chainId) => ctx.deps.engine.deployUseCaseContract(d, chainId),
      (m) => ctx.log.error({ err: m }, "use-case contract deploy skipped"),
    );
  },
};
