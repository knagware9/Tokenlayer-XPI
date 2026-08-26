import type { VerificationRequestRecord } from "../persistence/types/index.js";

/**
 * A public projection of a verification request — never leaks the challenge
 * (it's embedded in the VP) or the raw VP blob to a list view.
 *
 * Shared between identity.ts's verifier-facing routes and shared.ts's
 * `GET /me/verification-requests` (the holder's own inbox) — the latter is
 * classified "shared" in route-domains.ts precisely so a tokenization console
 * user who now has a DID can load "My identity" without it, so this view
 * cannot live inside either route file alone.
 */
export function vreqView(r: VerificationRequestRecord) {
  return {
    id: r.id, verifierOrgId: r.verifierOrgId, holderDid: r.holderDid, requestedTypes: r.requestedTypes,
    purpose: r.purpose, status: r.status, consentedCredentialIds: r.consentedCredentialIds,
    consentedAt: r.consentedAt, verifiedAt: r.verifiedAt, createdAt: r.createdAt, expiresAt: r.expiresAt,
    credentialUseCaseKey: r.credentialUseCaseKey,
  };
}
