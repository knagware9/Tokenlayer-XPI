/**
 * KYC decision proposal kind (maker-checker replacement for the old one-click
 * `PATCH /users/:id { kycStatus }`). PlatformAdmin-only on both sides — a KYC
 * decision is platform governance, not org- or use-case-scoped, so this
 * mirrors org-kinds.ts's orgCapabilityChangeKind exactly: no API-key approval
 * (a machine principal cannot decide someone's identity verification), and
 * `canApprove` narrower than a generic "who may see proposals" rule would give.
 */
import type { LifecycleAction } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import { coded } from "./executors.js";
import type { TokenClaims } from "../http/support.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "../persistence/types/index.js";
import { kycDecisionEmail } from "../mail/templates.js";

const platformOnlyView = async (_deps: AppDeps, claims: TokenClaims, _p: ProposalRecord): Promise<boolean> => claims.role === "PlatformAdmin";

export interface KycDecisionPayload {
  userId: string;
  decision: "approved" | "rejected";
  riskTier?: "low" | "medium" | "high";
  rejectionReason?: string;
}

const KYC_VALIDITY_DAYS = 365;

export const kycDecisionKind: ProposalKindHandler = {
  kind: "kyc-decision",
  apiScope: null,
  canView: platformOnlyView,
  canApprove: platformOnlyView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as KycDecisionPayload;
    const target = await ctx.deps.users.findById(pl.userId);
    if (!target) throw coded(404, "NOT_FOUND", "user missing");
    // Re-check at execution time: the submission may have been withdrawn or
    // re-submitted between propose and approve.
    if (target.kycStatus !== "pending") throw coded(409, "NOT_PENDING", `user's KYC is ${target.kycStatus}, not pending`);
    const kyc = target.kyc ?? {};
    if (pl.decision === "approved") {
      const expiresAt = new Date(Date.now() + KYC_VALIDITY_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await ctx.deps.users.update(target.id, { kycStatus: "approved", kyc: { ...kyc, riskTier: pl.riskTier ?? null, expiresAt, rejectionReason: null } });
    } else {
      await ctx.deps.users.update(target.id, { kycStatus: "rejected", kyc: { ...kyc, rejectionReason: pl.rejectionReason ?? null, riskTier: null, expiresAt: null } });
    }
    await ctx.deps.audit.append({ actorId: p.proposerId, action: "kyc-verified" as LifecycleAction, payload: { userId: target.id, decision: pl.decision, riskTier: pl.riskTier ?? null } });
    const notice = kycDecisionEmail({ decision: pl.decision, rejectionReason: pl.rejectionReason });
    await ctx.deps.mail.send(target.email, notice.subject, notice.text, notice.html).catch((err) => ctx.log.error({ err, userId: target.id }, "[mail] kyc-decision send failed"));
  },
};
