/**
 * Shared credential side-effects: sign→anchor→persist issuance and chain-first
 * revocation. Used by the credential proposal kinds AND the onboarding /
 * identity-revoke kinds so the invariants live in exactly one place.
 */
import { randomUUID } from "node:crypto";
import type { AppDeps } from "./context.js";
import { coded } from "./executors.js";
import type { CredentialRecord, OrganizationRecord } from "./persistence/types.js";

export interface IssueCredentialArgs {
  issuerOrg: OrganizationRecord;
  subjectDid: string;
  type: string;
  claims: Record<string, unknown>;
  validityDays: number;
  credentialUseCaseKey?: string | null;
  proposalId: string | null;
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
  if (deps.registry) {
    await deps.registry.anchor.anchorCredential(deps.registry.vcRegistry, credentialId, vcJwt, now, expiresAt);
  }
  return deps.credentials.create({
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
  });
}

/** Chain FIRST, then the database — the DB is never "more revoked" than the chain. */
export async function revokeCredentialById(
  deps: AppDeps, credentialId: string, meta: { reason: string; by: string; at: string },
): Promise<void> {
  const cred = await deps.credentials.get(credentialId);
  if (!cred) throw coded(404, "NOT_FOUND", "credential missing");
  if (cred.revoked) throw coded(409, "ALREADY_REVOKED", "credential is already revoked");
  if (deps.registry) {
    await deps.registry.anchor.revokeCredential(deps.registry.vcRegistry, cred.id);
  }
  await deps.credentials.revoke(cred.id, meta);
}
