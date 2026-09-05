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
    // Concurrent, not sequential: N admins sequentially awaited could add real
    // latency to any of the 11 routes that create a proposal (worse now that
    // SmtpMailer carries real timeouts — up to ~10s per admin), and a single
    // admin's send throwing used to abort the loop, silently skipping every
    // admin still left in it. allSettled fires all sends at once and reports
    // each failure independently, so one bad address never costs the others
    // their notification.
    const results = await Promise.allSettled(admins.map((admin) => deps.mail.send(admin.email, notice.subject, notice.text, notice.html)));
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        log.error({ err: result.reason, proposalId: proposal.id, kind: proposal.kind, adminEmail: admins[i]!.email }, "[mail] proposal-awaiting-approval send failed");
      }
    }
  } catch (err) {
    log.error({ err, proposalId: proposal.id, kind: proposal.kind }, "[mail] proposal-awaiting-approval send failed");
  }
  return proposal;
}
