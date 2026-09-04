/**
 * Every route that creates a Proposal calls THIS instead of `deps.proposals.
 * create` directly, so "email every PlatformAdmin that something needs their
 * approval" is one chokepoint instead of a dozen near-duplicate hooks. Mirrors
 * the "never let observing break acting" posture in `shared/events.ts` — a
 * mail failure never fails proposal creation.
 */
import type { AppDeps } from "../context.js";
import type { ProposalRecord, ProposalRepository } from "../persistence/types/index.js";
import { proposalAwaitingApprovalEmail } from "../mail/templates.js";

interface NotifyLogger {
  error(obj: unknown, msg?: string): void;
}

export async function createProposalAndNotify(
  deps: AppDeps,
  input: Parameters<ProposalRepository["create"]>[0],
  log: NotifyLogger = console,
): Promise<ProposalRecord> {
  const proposal = await deps.proposals.create(input);
  try {
    const admins = (await deps.users.list()).filter((u) => u.role === "PlatformAdmin" && u.active && u.kind === "human");
    const notice = proposalAwaitingApprovalEmail({
      kind: proposal.kind,
      proposerLabel: proposal.proposerLabel,
      approvalsUrl: `${deps.publicWebUrl}/approvals`,
    });
    for (const admin of admins) {
      await deps.mail.send(admin.email, notice.subject, notice.text, notice.html);
    }
  } catch (err) {
    log.error({ err, proposalId: proposal.id, kind: proposal.kind }, "[mail] proposal-awaiting-approval send failed");
  }
  return proposal;
}
