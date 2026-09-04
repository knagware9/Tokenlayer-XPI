/**
 * Shared credential side-effects: sign→anchor→persist issuance and chain-first
 * revocation. Used by the credential proposal kinds AND the onboarding /
 * identity-revoke kinds so the invariants live in exactly one place.
 *
 * Every credential now anchors unconditionally: this file is where the EN-D2
 * sandbox-withholding logic used to live (the mode-removal refactor deleted it
 * along with `sandbox.ts`), and it is also where the defect the live
 * walkthrough found actually was — every issuing path in the platform funnels
 * through `issueCredentialFor`, and it reads `deps.registry` directly.
 */
import { randomUUID } from "node:crypto";
import type { AppDeps } from "../context.js";
import { emitEvent } from "../shared/events.js";
import { coded } from "../shared/executors.js";
import type { CredentialRecord, OrganizationRecord } from "../persistence/types/index.js";
import { credentialIssuedEmail, credentialRevokedEmail } from "../mail/templates.js";

/**
 * The email to notify for a credential concerning `subjectDid` — the holder's
 * own address if it belongs to a user, else that org's OrgAdmin if it belongs
 * to an organization, else null (nothing to notify, e.g. a DID this deployment
 * has never onboarded). No `findByDid` on `UserRepository` today, so this
 * scans — acceptable at pilot scale; revisit if the roster grows large.
 */
async function resolveCredentialRecipientEmail(deps: AppDeps, subjectDid: string): Promise<string | null> {
  const user = (await deps.users.list()).find((u) => u.did === subjectDid);
  if (user) return user.email;
  const org = await deps.organizations.findByDid(subjectDid).catch(() => null);
  if (!org) return null;
  const admin = (await deps.users.listByOrg(org.id)).find((u) => u.role === "OrgAdmin");
  return admin?.email ?? null;
}

export interface IssueCredentialArgs {
  issuerOrg: OrganizationRecord;
  subjectDid: string;
  type: string;
  claims: Record<string, unknown>;
  validityDays: number;
  credentialUseCaseKey?: string | null;
  proposalId: string | null;
  /** Only the use-case executor ever passes "pending" (ID-L). Defaults to "accepted". */
  initialAcceptance?: CredentialRecord["acceptance"];
}

/** Sign → anchor (when a registry is present) → persist. Throws ⇒ nothing persisted. */
export async function issueCredentialFor(deps: AppDeps, a: IssueCredentialArgs): Promise<CredentialRecord> {
  // The id is generated BEFORE signing: the VC embeds it in jti + credentialStatus.
  const credentialId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const statusUrl = `${deps.publicApiUrl}/credentials/${credentialId}/status`;
  const { vcJwt, expiresAt } = deps.keystore.issueOrgCredential({
    orgEncSeed: a.issuerOrg.didSeedEncrypted, orgDid: a.issuerOrg.did, subjectDid: a.subjectDid,
    type: a.type, claims: a.claims, credentialId, statusUrl, validityDays: a.validityDays, now,
  });
  // Anchor BEFORE persisting: a throw here fails the caller and no row exists.
  // Keep the receipt — the tx hash is the credential's public on-chain pointer (ID-O).
  //
  // `deps.registry` is `undefined` only when no chain hosts a registry at all
  // (an unconfigured deployment) — every credential anchors unconditionally now.
  const registry = deps.registry;
  let anchorReceipt: { txHash: string; chainId: string } | null = null;
  if (registry) {
    anchorReceipt = await registry.anchor.anchorCredential(registry.vcRegistry, credentialId, vcJwt, now, expiresAt);
  }
  const credential = await deps.credentials.create({
    id: credentialId,
    holderDid: a.subjectDid,
    issuerDid: a.issuerOrg.did,
    type: a.type,
    vcJwt,
    subjectClaims: { id: a.subjectDid, ...a.claims },
    issuedAt: new Date(now * 1000).toISOString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
    proposalId: a.proposalId,
    credentialUseCaseKey: a.credentialUseCaseKey ?? null,
    acceptance: a.initialAcceptance ?? "accepted", acceptanceAt: null, acceptanceNote: null,
    anchorTxHash: anchorReceipt?.txHash ?? null,
    // `null` here means only one thing now: the anchor attempt failed (or no
    // registry was configured) — `/status` reports `anchored: false` and
    // revocation knows there is nothing on-chain to revoke.
    anchorChainId: anchorReceipt?.chainId ?? null,
    revokeTxHash: null,
  });
  // EN-C. Emitted HERE rather than at each route because this is the single
  // chokepoint every issuance path goes through (closed catalog, use-case desk,
  // onboarding, CSV batch) — a new issuing path gets the event for free.
  // NOTE the payload: ids, type, timestamps, acceptance state, tx hash. Never
  // `vcJwt` and never `subjectClaims` — the claims are the private content the
  // credential exists to protect, and an integrator entitled to them fetches the
  // credential with their API key, which re-runs every authorization gate.
  await emitEvent(deps, {
    type: "credential.issued",
    orgId: a.issuerOrg.id,
    useCaseKey: a.credentialUseCaseKey ?? null,
    subjectId: credential.id,
    data: {
      credentialId: credential.id,
      credentialType: credential.type,
      subjectDid: credential.holderDid,
      issuerOrgId: a.issuerOrg.id,
      issuerDid: credential.issuerDid,
      credentialUseCaseKey: credential.credentialUseCaseKey,
      acceptance: credential.acceptance,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
      txHash: credential.anchorTxHash,
      chainId: credential.anchorChainId,
    },
  });
  try {
    const to = await resolveCredentialRecipientEmail(deps, credential.holderDid);
    if (to) {
      const notice = credentialIssuedEmail({ credentialType: credential.type, issuerName: a.issuerOrg.name });
      await deps.mail.send(to, notice.subject, notice.text, notice.html);
    }
  } catch (err) {
    console.error({ err, credentialId: credential.id }, "[mail] credential-issued send failed");
  }
  return credential;
}

/** Chain FIRST, then the database — the DB is never "more revoked" than the chain. */
export async function revokeCredentialById(
  deps: AppDeps, credentialId: string, meta: { reason: string; by: string; at: string },
): Promise<void> {
  const cred = await deps.credentials.get(credentialId);
  if (!cred) throw coded(404, "NOT_FOUND", "credential missing");
  if (cred.revoked) throw coded(409, "ALREADY_REVOKED", "credential is already revoked");
  // Revocation is a chain WRITE, same as issuance, and reads `deps.registry`
  // directly for the same reason — it anchors unconditionally now.
  const registry = deps.registry;
  let revokeReceipt: { txHash: string } | null = null;
  if (registry) {
    revokeReceipt = await registry.anchor.revokeCredential(registry.vcRegistry, cred.id);
  }
  await deps.credentials.revoke(cred.id, { ...meta, txHash: revokeReceipt?.txHash ?? null });
  // EN-C. Same reasoning as issuance: POST /credentials/:id/revoke returns 202 +
  // a proposal, so the revocation itself happens on approval, in the proposal
  // executor — and the holder-reject and offboarding paths reach it too. This
  // helper is where the chain-first revocation actually succeeds, so it is the
  // only place the event can be emitted once and be true everywhere.
  // The owning org is the SIGNING org, resolved from the credential's issuer DID
  // (the acting user may be a use-case-scoped desk operator in another org).
  const issuerOrg = await deps.organizations.findByDid(cred.issuerDid).catch(() => null);
  await emitEvent(deps, {
    type: "credential.revoked",
    orgId: issuerOrg?.id ?? null,
    useCaseKey: cred.credentialUseCaseKey,
    subjectId: cred.id,
    data: {
      credentialId: cred.id,
      credentialType: cred.type,
      subjectDid: cred.holderDid,
      issuerOrgId: issuerOrg?.id ?? null,
      issuerDid: cred.issuerDid,
      credentialUseCaseKey: cred.credentialUseCaseKey,
      reason: meta.reason,
      revokedAt: meta.at,
      txHash: revokeReceipt?.txHash ?? null,
    },
  });
  try {
    const to = await resolveCredentialRecipientEmail(deps, cred.holderDid);
    if (to) {
      const notice = credentialRevokedEmail({ credentialType: cred.type, reason: meta.reason });
      await deps.mail.send(to, notice.subject, notice.text, notice.html);
    }
  } catch (err) {
    console.error({ err, credentialId: cred.id }, "[mail] credential-revoked send failed");
  }
}
