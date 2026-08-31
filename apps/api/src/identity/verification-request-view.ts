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
    // The verifier's own advisory ask — visible to both sides already via
    // requestedTypes, so there's nothing sensitive here. NOT `consentedDisclosures`:
    // that's the resolved, disclosed-or-not answer, and stays out of every general
    // listing for the same reason `verifierResult` does (see the file comment above).
    requestedFields: r.requestedFields,
    consentedAt: r.consentedAt, verifiedAt: r.verifiedAt, createdAt: r.createdAt, expiresAt: r.expiresAt,
    credentialUseCaseKey: r.credentialUseCaseKey,
  };
}
