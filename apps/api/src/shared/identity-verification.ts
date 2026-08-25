/**
 * Admin-issued KYC identity for a tokenization-side user (Issuer/Buyer/Trader/…)
 * who has no organization onboarding to provision a DID for them. Mints a
 * custodial DID if the user doesn't already have one, then issues a
 * KycCredential — same issuer-resolution and DID-minting as onboardUserKind's
 * `pl.kyc` path (resolveIssuerOrg, keystore.newSeed/encryptSeed, didKeyFromSeed)
 * — and persists it in the local credential store, the exact predicate
 * ComplianceProvider.hasVerifiedIdentity checks (identity-assertions.ts's
 * local-store `holds`), so a use case with `compliance.requireVerifiedIdentity`
 * can actually be satisfied for them.
 *
 * Deliberately NOT the presentation-based `/users/:id/identity/verify` flow —
 * that verifies a credential the holder already proves possession of (an
 * external-issuer trust model) and never persists anything into the local
 * store, so it cannot alone satisfy a local-store deployment's compliance gate.
 */
import { credentialTypeDef, didKeyFromSeed, validateMetadata } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import type { UserRecord } from "../persistence/types/index.js";
import { issueCredentialFor } from "../identity/credential-issuance.js";
import { resolveIssuerOrg } from "./user-kinds.js";

export async function issueAdminKycCredential(
  deps: AppDeps,
  user: UserRecord,
  claims: { legalName: string; country: string },
): Promise<{ did: string; credentialId: string; issuerDid: string }> {
  const def = credentialTypeDef("KycCredential");
  validateMetadata(claims, def.claimSchema); // throws INVALID_METADATA → 400

  let did = user.did;
  if (!did) {
    const seed = deps.keystore.newSeed();
    const didSeedEncrypted = deps.keystore.encryptSeed(seed);
    did = didKeyFromSeed(seed).did;
    await deps.users.update(user.id, { did, didSeedEncrypted });
  }

  const issuerOrg = await resolveIssuerOrg(deps, user.useCaseKey);
  const credential = await issueCredentialFor(deps, {
    issuerOrg, subjectDid: did, type: "KycCredential", claims,
    validityDays: def.validityDays, proposalId: null,
  });
  return { did, credentialId: credential.id, issuerDid: issuerOrg.did };
}
