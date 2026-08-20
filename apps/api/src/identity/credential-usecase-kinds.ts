/**
 * Config-driven credential issuance (ID-B). A bound issuer issues a configured
 * credential type to an eligible holder, through maker-checker. ORG scoped to
 * the issuer org (like the closed-catalog credential kinds), but the type's
 * claim schema + validity come from the CredentialUseCase config, not the
 * closed catalog.
 */
import { credentialUseCaseType, holderPolicyAllows, orgRoleEnabled } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import { coded } from "../shared/executors.js";
import { issueCredentialFor } from "./credential-issuance.js";
import type { TokenClaims } from "../http/support.js";
import type { ProposalKindHandler } from "../shared/proposal-kinds.js";
import type { ProposalRecord } from "../persistence/types/index.js";

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
  apiScope: "credentials:issue",
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
    // EN-A execution-time re-check (mirrors resolveIssuer's defense in depth):
    // the envelope may tighten between propose and approve. Only an org-bound
    // issuer is gated — platform-issuer use cases sign as the platform.
    // (coded() carries no details object — orgId rides in the message.)
    if (def.issuer.kind === "org" && !orgRoleEnabled(org.capabilities, "Issuer")) {
      throw coded(403, "ORG_CAPABILITY_MISSING", `organization '${org.name}' (${org.id}) does not have the 'Issuer' capability`);
    }
    await issueCredentialFor(ctx.deps, {
      issuerOrg: org, subjectDid: pl.subjectDid, type: spec.name, claims: pl.claims,
      validityDays: spec.validityDays, credentialUseCaseKey: def.key, proposalId: p.id,
      initialAcceptance: def.holderAcceptance ? "pending" : "accepted",
    });
  },
};

export interface IssueUsecaseCredentialBatchPayload {
  useCaseKey: string;
  credentialType: string;
  issuerOrgId: string;
  rows: { subjectEmail: string; claims: Record<string, unknown> }[];
}

/** Per-row batch report entry — index + subjectEmail + outcome; the issued credential's id on success. */
interface CredentialBatchRowResult {
  index: number;
  subjectEmail: string;
  status: "ok" | "failed";
  credentialId?: string;
  error?: string;
}

/**
 * Batch issuance for a configured credential type (M3). Same maker-checker
 * scoping as the single `issue-usecase-credential` kind (org-scoped view),
 * but subjects are resolved BY EMAIL AT EXECUTION TIME (not pre-resolved at
 * draft) since a batch row only carries `subjectEmail` — the holder may not
 * even exist yet at draft time, and the holder-policy check must be
 * re-applied per row here for the same reason. Row-independent: one row's
 * failure never aborts the others.
 */
export const issueUsecaseCredentialBatchKind: ProposalKindHandler = {
  kind: "issue-usecase-credential-batch",
  apiScope: "credentials:issue",
  canView: orgScopedView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const deps = ctx.deps;
    const pl = p.payload as unknown as IssueUsecaseCredentialBatchPayload;
    // Re-resolve fresh config at execution — never sign stale config.
    const def = await deps.credentialUseCases.get(pl.useCaseKey);
    if (!def) throw coded(404, "UNKNOWN_USECASE", `credential use case '${pl.useCaseKey}' missing`);
    const spec = credentialUseCaseType(def, pl.credentialType); // throws UNKNOWN_CREDENTIAL_TYPE
    const org = await deps.organizations.get(pl.issuerOrgId);
    if (!org) throw coded(404, "NOT_FOUND", "issuing organization missing");
    // EN-A execution-time re-check — CONFIG-level, thrown before the row loop:
    // a missing Issuer capability fails the WHOLE batch (it is not a per-row
    // subject problem), exactly like a vanished use case or unknown type above.
    if (def.issuer.kind === "org" && !orgRoleEnabled(org.capabilities, "Issuer")) {
      throw coded(403, "ORG_CAPABILITY_MISSING", `organization '${org.name}' (${org.id}) does not have the 'Issuer' capability`);
    }

    const rows: CredentialBatchRowResult[] = [];
    for (let i = 0; i < pl.rows.length; i++) {
      const row = pl.rows[i]!;
      try {
        const user = await deps.users.findByEmail(row.subjectEmail);
        if (!user?.did) throw coded(404, "HOLDER_NOT_FOUND", "holder not found");
        const holderOrg = user.orgId ? await deps.organizations.get(user.orgId).catch(() => null) : null;
        if (!holderPolicyAllows(def.holderPolicy, holderOrg ? { id: holderOrg.id, orgType: holderOrg.orgType } : null)) {
          throw coded(403, "HOLDER_NOT_ELIGIBLE", "the subject is not an eligible holder for this use case");
        }
        const cred = await issueCredentialFor(deps, {
          issuerOrg: org, subjectDid: user.did, type: spec.name, claims: row.claims,
          validityDays: spec.validityDays, credentialUseCaseKey: def.key, proposalId: p.id,
          initialAcceptance: def.holderAcceptance ? "pending" : "accepted",
        });
        rows.push({ index: i, subjectEmail: row.subjectEmail, status: "ok", credentialId: cred.id });
      } catch (err) {
        rows.push({ index: i, subjectEmail: row.subjectEmail, status: "failed", error: (err as Error).message });
      }
    }
    await deps.proposals.setResult(p.id, {
      total: rows.length,
      succeeded: rows.filter((r) => r.status === "ok").length,
      failed: rows.filter((r) => r.status === "failed").length,
      rows,
    });
  },
};
