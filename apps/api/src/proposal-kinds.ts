/**
 * Proposal kinds: the per-kind policy + side effects behind the generic
 * maker-checker machinery. The concurrency core (CAS claimDecided, optimistic
 * addApproval, the SELF_APPROVAL rule, execution under the proposer's identity)
 * stays in the routes and is kind-agnostic; everything that differs per kind
 * lives here.
 *
 * Scoping is a per-kind strategy: token kinds are use-case scoped, credential
 * kinds are org scoped. `canView` is a SECURITY boundary — never fall back to
 * scopedToCaller for a kind whose useCaseKey is null (null === null would match
 * every unscoped user).
 */
import type { Actor, ApiScope, LifecycleAction } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { issueCredentialKind, revokeCredentialKind } from "./credential-kinds.js";
import { issueUsecaseCredentialBatchKind, issueUsecaseCredentialKind } from "./credential-usecase-kinds.js";
import { coded, executeCashflowCore, executeIssueActivation, runGatedAction } from "./executors.js";
import type { TokenClaims } from "./http/support.js";
import { scopedToCaller } from "./http/support.js";
import type { ProposalRecord } from "./persistence/types.js";
import { orgCapabilityChangeKind } from "./org-kinds.js";
import { onboardUserBatchKind, onboardUserKind, revokeUserIdentityKind } from "./user-kinds.js";
import { createUseCaseKind } from "./usecase-kinds.js";

/** Minimal logger shape (a Fastify request.log). */
export interface KindLogger {
  error(obj: unknown, msg: string): void;
}

export interface KindContext {
  deps: AppDeps;
  log: KindLogger;
}

export interface ProposalKindHandler {
  kind: string;
  /**
   * EN-B: the API scope a KEY principal must hold to DECIDE this kind, or
   * `null` for "no key may ever decide this" (governance kinds that could
   * widen the authority a key is bound by).
   *
   * REQUIRED, and deliberately not optional: approving a proposal EXECUTES the
   * operation, so the scope map on the routes that merely DRAFT one is only half
   * the gate. Making this a mandatory field means a new kind cannot be
   * registered without its author deciding — the compiler asks the question, and
   * a kind that is never asked would otherwise fall through open.
   */
  apiScope: ApiScope | null;
  /** May this caller SEE this proposal? Security boundary. */
  canView(deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean>;
  /** May this caller decide it? (Already known to not be the proposer.) */
  canApprove(deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean>;
  /** Side effect once the approval threshold is reached. Runs as `proposer`. */
  execute(ctx: KindContext, proposer: Actor, p: ProposalRecord): Promise<void>;
  /** Undo/compensate when the proposal will never execute. */
  compensate?(ctx: KindContext, p: ProposalRecord, reason: "rejected" | "failed"): Promise<void>;
}

// Maker-checker capability an approver must hold for each gated token op. Every
// op maps to itself except cashflow-execute, which mirrors its route gate (issue).
const CAPABILITY_FOR: Record<string, LifecycleAction> = {
  issue: "issue", mint: "mint", transfer: "transfer", burn: "burn",
  freeze: "freeze", unfreeze: "unfreeze", "cashflow-execute": "issue",
};

const tokenCanView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  p.useCaseKey !== null && scopedToCaller(claims, p.useCaseKey);

const tokenCanApprove = async (deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> => {
  const capability = CAPABILITY_FOR[p.kind];
  return !!capability && deps.rbac.can(claims.role, capability);
};

/**
 * Refund an issuance fee captured at propose time (best-effort). Shared by
 * rejection and failed activation so a gated issue never keeps a fee for an
 * asset that never activated.
 */
async function refundIssuanceFee(ctx: KindContext, p: ProposalRecord): Promise<void> {
  const fee = p.payload.issuanceFee as { amount: string; currency: string; payer?: string } | undefined;
  if (fee?.payer && ctx.deps.platformFeeAccount) {
    await ctx.deps.cash.transfer(fee.currency, ctx.deps.platformFeeAccount, fee.payer, fee.amount).catch((refundErr) =>
      ctx.log.error({ refundErr, proposalId: p.id }, "issuance fee refund failed — manual reconciliation required"));
  }
}

/** Load the proposal's asset, or throw the same coded errors the old dispatch did. */
async function assetOf(ctx: KindContext, p: ProposalRecord, missing: string) {
  const asset = p.assetId ? await ctx.deps.assets.get(p.assetId) : null;
  if (!asset) throw coded(404, "NOT_FOUND", missing);
  return asset;
}

const issueKind: ProposalKindHandler = {
  kind: "issue",
  // Approving activates the asset — the same act POST /assets drafts.
  apiScope: "assets:issue",
  canView: tokenCanView,
  canApprove: tokenCanApprove,
  async execute(ctx, proposer, p) {
    const asset = await assetOf(ctx, p, "pending asset missing");
    // Re-assert the asset is still awaiting approval (not rejected/decided elsewhere).
    if (asset.status !== "pending_approval") throw coded(409, "ASSET_NOT_ACTIVE", `asset is ${asset.status}`);
    await executeIssueActivation(ctx.deps, proposer, asset, p.payload as Parameters<typeof executeIssueActivation>[3]);
  },
  async compensate(ctx, p, reason) {
    if (reason === "rejected" && p.assetId) await ctx.deps.assets.setStatus(p.assetId, "rejected");
    await refundIssuanceFee(ctx, p);
  },
};

const cashflowKind: ProposalKindHandler = {
  kind: "cashflow-execute",
  // Settling a cashflow moves value between holders.
  apiScope: "assets:transfer",
  canView: tokenCanView,
  canApprove: tokenCanApprove,
  async execute(ctx, proposer, p) {
    const asset = await assetOf(ctx, p, "asset missing");
    // Re-check the asset is live at approval time — it may have matured/frozen since propose.
    if (asset.status !== "active") throw coded(409, "ASSET_NOT_ACTIVE", `asset is ${asset.status}`);
    const cf = await ctx.deps.cashflows.get(String(p.payload.cfId));
    if (!cf || cf.assetId !== asset.id) throw coded(404, "NOT_FOUND", "cashflow missing");
    await executeCashflowCore(ctx.deps, proposer, asset, cf, String(p.payload.from), ctx.log);
  },
};

/** mint | transfer | burn | freeze | unfreeze — the five direct lifecycle actions. */
const actionKind = (kind: string): ProposalKindHandler => ({
  kind,
  // mint/transfer/burn/freeze/unfreeze all arrive through
  // POST /assets/:id/actions/:action, which the scope map gates as
  // `assets:transfer` — propose and execute must agree.
  apiScope: "assets:transfer",
  canView: tokenCanView,
  canApprove: tokenCanApprove,
  async execute(ctx, proposer, p) {
    const asset = await assetOf(ctx, p, "asset missing");
    // The direct action route rejects non-active assets before gating; the
    // approval path must re-assert it (the asset may have matured/frozen since
    // propose), or a gated mint/transfer could mutate a redeemed instrument.
    if (asset.status !== "active") throw coded(409, "ASSET_NOT_ACTIVE", `asset is ${asset.status}`);
    await runGatedAction(ctx.deps, proposer, asset, p.kind, (p.payload.body ?? {}) as Record<string, string>);
  },
});

const HANDLERS = new Map<string, ProposalKindHandler>();
export function registerProposalKind(h: ProposalKindHandler): void {
  HANDLERS.set(h.kind, h);
}
for (const h of [issueKind, cashflowKind, ...["mint", "transfer", "burn", "freeze", "unfreeze"].map(actionKind)]) {
  registerProposalKind(h);
}

/** The handler for `kind`. Throws (rather than falling through to a token branch) on an unknown kind. */
export function proposalKind(kind: string): ProposalKindHandler {
  const h = HANDLERS.get(kind);
  if (!h) throw coded(400, "UNKNOWN_PROPOSAL_KIND", `unknown proposal kind '${kind}'`);
  return h;
}

/** Every registered kind — used by GET /proposals to filter by visibility. */
export function allProposalKinds(): ProposalKindHandler[] {
  return [...HANDLERS.values()];
}

// Org-scoped credential kinds. Defined in their own module (which imports only
// the `ProposalKindHandler` TYPE from here, so no runtime cycle) and registered
// through the same registry as the token kinds above.
registerProposalKind(issueCredentialKind);
registerProposalKind(revokeCredentialKind);
registerProposalKind(issueUsecaseCredentialKind);
registerProposalKind(issueUsecaseCredentialBatchKind);

// Use-case-scoped user-lifecycle kinds. Same registry, same no-runtime-cycle
// TYPE-only import pattern as the credential kinds above.
registerProposalKind(onboardUserKind);
registerProposalKind(onboardUserBatchKind);
registerProposalKind(revokeUserIdentityKind);

// Org-scoped use-case configuration kind: an OrgAdmin proposes a new org-owned
// use case; a PlatformAdmin approval creates + deploys it. Same registry, same
// no-runtime-cycle TYPE-only import pattern as the kinds above.
registerProposalKind(createUseCaseKind);

// Org-scoped capability-change kind (EN-A): an OrgAdmin requests a new envelope;
// only a PlatformAdmin may approve. Same registry, same TYPE-only import pattern.
registerProposalKind(orgCapabilityChangeKind);
