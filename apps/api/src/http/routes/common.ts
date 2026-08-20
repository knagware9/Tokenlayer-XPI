/**
 * Helpers every route family needs, and that belong to none of them.
 *
 * These sat above `registerRoutes` in the 6,707-line routes.ts. They are here so
 * shared.ts, tokenization.ts and identity.ts can each import what they use
 * without importing one another — the same rule packages/core now follows.
 */
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyRecord, AssetRecord, BrandingPatch, CashflowRecord, CompanyProfile, CredentialRecord, DocumentPurpose, KybDocumentRef, KycDetails, KycStatus, ListingRecord, OrganizationRecord, ProposalRecord, UserRecord, VerificationRequestRecord, WebhookEndpointRecord } from "../../persistence/types/index.js";
import { ListingConflictError } from "../../persistence/types/index.js";
import { assignableRoles, auditEntryHash, canCreateOrgMember, canCreateUser, canManageUsers, certificatePageSize, computeCashflowSchedule, CREDENTIAL_TEMPLATES, CREDENTIAL_TYPES, credentialTypeDef, credentialUseCaseType, decodeJwt, didKeyFromSeed, generateDidKey, holderPolicyAllows, instantiateTemplate, invoiceFingerprint, issueCredential, issuerBindingAllows, normalizeUseCaseDefinition, ORG_OPERATING_ROLES, orgDomainEnabled, orgRoleEnabled, PolicyError, presentCredential, presentCredentials, splitProRata, TEMPLATE_CATALOG, useCaseDomainOf, validateBrandAccent, validateCertificatePlacements, validateCredentialUseCase, validateEventTypes, validateMetadata, scopeAllows, validateOrgCapabilities, validateScopes, validateTemplate, verifierBindingAllows, verifyChain, verifyDidSignature, verifyPresentation, verifyPresentationCredentials, isDocumentSha256, type Actor, type ApiScope, type ChainEntry, type CredentialTypeSpec, type CredentialUseCaseDefinition, type LifecycleAction, type OrgDomain, type OrgOperatingRole, type OrgType, type Role, type UseCaseDefinition, type UseCaseTemplate, type CertificateFieldPlacement } from "@tokenlayer/core";
import qrcode from "qrcode";
import type { AppDeps } from "../../context.js";
import { certificateStatusBanner, humanizeKey, renderCredentialCertificate } from "../../identity/certificate.js";
import { artworkDimensions, certificateDrawList, drawCertificate } from "../../identity/certificate-artwork.js";
import { certificateLogoDocumentId, resolveCertificateFields } from "../../identity/certificate-fields.js";
import { isSupportedCurrency } from "../../tokenization/currencies.js";
import { renderContractCode } from "../../tokenization/contract-code.js";
import { deployAndCreateUseCase } from "../../tokenization/use-cases.js";
import { computeAnalytics } from "../../tokenization/analytics.js";
import { computeIdentityDashboard } from "../../identity/identity-analytics.js";
import { issueCredentialFor, revokeCredentialById } from "../../identity/credential-issuance.js";
import { namespaceHolding } from "../../shared/usecase-namespace.js";
import { emitEvent, ownerOrgOfUseCase } from "../../shared/events.js";
import { mintOrgMembership } from "../../shared/membership.js";
import { ensurePlatformIssuerOrg, PLATFORM_ORG_NAME } from "../../shared/platform-org.js";
import { computeActivity, computePortfolio } from "../../tokenization/investor.js";
import { readErpInvoices, stageInvoice } from "../../tokenization/invoice-register.js";
import { assetBalancesOf, coded, CodedError, dropPayerShare, executeCashflowCore, executeIssueActivation, runGatedAction } from "../../shared/executors.js";
import { proposalKind } from "../../shared/proposal-kinds.js";
import type { OnboardUserPayload } from "../../shared/user-kinds.js";
import { resolveDid } from "../../identity/did-resolver.js";
import { checkUrl } from "../../webhooks/url-guard.js";
import { API_KEY_BCRYPT_ROUNDS, invalidateVerifiedPrefix, mintSecret } from "../../shared/api-keys.js";
import { BRAND_LOGO_PRUNE_GRACE_MS, pruneSupersededBrandLogos } from "../../shared/brand-logo-prune.js";
import { S } from "../schemas/index.js";
import { holdsValidCredential, IDENTITY_CREDENTIAL_TYPE } from "../../identity/identity-assertions.js";
import { actorOf, claimsOf, contextOf, isPositiveIntString, machinePrincipal, notFound, requirePrincipal, requireScope, scopedToCaller, type TokenClaims } from "../support.js";

export const NO_USE_CASE = "__none__"; // sentinel: a use-case key that matches no real use case (denies scoped users with no assigned use case)

/**
 * May `claims` administer the EXISTING account `target` — suspend it, delete
 * it, or draft a revoke-identity proposal against it?
 *
 * ONE definition, shared by DELETE /users/:id, PATCH /users/:id and
 * POST /users/:id/revoke-identity. It used to be three copies of an inline
 * expression, and drift between copies is exactly how the hole below survived.
 *
 * Three rules, all load-bearing:
 *
 *  1. RANK. A manager below PlatformAdmin never reaches an account at or above
 *     the org tier. The old predicate excluded only `UseCaseAdmin`, so an
 *     OrgAdmin could suspend and permanently delete a PlatformAdmin — and,
 *     since EN-B binds an API key to an ordinary org member, so could a
 *     machine credential holding nothing but `users:onboard`. This mirrors
 *     `canCreateOrgMember`, which already refuses to CREATE an OrgAdmin or a
 *     PlatformAdmin: being unable to create one while being able to destroy one
 *     was never coherent.
 *
 *  2. SAME USE CASE, read through NO_USE_CASE for consistency with the rest of
 *     the file. Note what this does NOT do: `null` normalizes to the same
 *     sentinel on both sides, so two unscoped principals still match. The
 *     sentinel is presentational here — rule 3 is what closes that case.
 *
 *  3. THE UNSCOPED CASE. When the manager itself has no use case (an OrgAdmin
 *     always, a UseCaseAdmin never), use-case equality has proved nothing:
 *     every PlatformAdmin, every other org's OrgAdmin and every org's
 *     use-case-less members all carry `null` too. Fall back to the boundary
 *     that actually applies to an unscoped manager — the ORGANIZATION. An
 *     org-less unscoped manager matches nobody.
 *
 * Rules 1 and 3 are both TIGHTENINGS of behaviour inherited from `main`, and
 * they bite humans as well as keys: a human OrgAdmin could previously delete a
 * PlatformAdmin, and could manage a use-case-less member of a foreign org. EN-B
 * did not introduce either — it made both reachable by an unattended credential.
 */
export function canAdministerUser(claims: TokenClaims, target: UserRecord): boolean {
  if (claims.role === "PlatformAdmin") return true;
  if (!canManageUsers(claims.role)) return false;
  if (target.role === "PlatformAdmin" || target.role === "OrgAdmin" || target.role === "UseCaseAdmin") return false;
  if ((target.useCaseKey ?? NO_USE_CASE) !== (claims.useCaseKey ?? NO_USE_CASE)) return false;
  if (claims.useCaseKey === null) return Boolean(claims.orgId) && (target.orgId ?? null) === claims.orgId;
  return true;
}

export const BCRYPT_ROUNDS = 12;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export const MAX_DOC_BYTES = 5 * 1024 * 1024;
// A 5MB document is ~6.8MB as base64 JSON — upload routes override the app-global
// 256KB bodyLimit with this (the decoded bytes are still capped at MAX_DOC_BYTES).
export const DOC_UPLOAD_BODY_LIMIT = 8 * 1024 * 1024;
// Allowlisted document content types — stored bytes are served back later, so an
// arbitrary type (e.g. text/html) would enable stored XSS on the API origin.
export const ALLOWED_DOC_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain"]);

/**
 * Validate and store one base64 document upload. Shared by all four upload
 * doors (the general document store, certificate artwork, brand logo, and
 * the public KYB route) so their error surface cannot drift. Throws coded
 * 415/400/413 (mapped by the global error handler).
 */
export async function storeUploadedDocument(
  documents: AppDeps["documents"],
  body: { contentType: string; dataBase64: string },
  ownerOrgId: string | null,
  purpose: DocumentPurpose | null,
): Promise<{ id: string; sha256: string; size: number }> {
  if (!ALLOWED_DOC_TYPES.has(body.contentType)) {
    throw coded(415, "UNSUPPORTED_DOCUMENT_TYPE", `contentType must be one of: ${[...ALLOWED_DOC_TYPES].join(", ")}`);
  }
  const bytes = Buffer.from(body.dataBase64, "base64");
  if (bytes.length === 0) throw coded(400, "BAD_DOCUMENT", "empty document");
  if (bytes.length > MAX_DOC_BYTES) throw coded(413, "DOCUMENT_TOO_LARGE", `max ${MAX_DOC_BYTES} bytes`);
  return documents.create({ contentType: body.contentType, bytes, ownerOrgId, purpose });
}

/**
 * MAY THIS ORGANIZATION REFERENCE THESE BYTES?
 *
 * The rule the certificate-artwork review had to invent, because the branch it
 * reviewed had none. Its predecessor was "the caller must supply the document's
 * sha256, which proves they have seen the file" — and that was false the moment
 * the digest was stored, because `GET /credential-use-cases` is open to any
 * authenticated user and serialises the whole certificate block. Org B read org
 * A's `{documentId, sha256}` off that route, pinned it onto a use case B owned,
 * and fetched A's letterhead byte for byte.
 *
 * A DIGEST IS AN INTEGRITY CHECK, NOT A CAPABILITY. It answers "are these the
 * bytes I meant", never "am I allowed to have them". Ownership has to be
 * recorded, so it is — on the row.
 *
 * `null` on either side fails. A null-owned document (platform upload, pre-org
 * KYB registration, or a row written before the column existed) is referenceable
 * only by a PlatformAdmin, who bypasses this check at the call sites because
 * they may already read every document through `GET /documents/:id`.
 */
export function orgOwnsDocument(doc: { ownerOrgId: string | null }, orgId: string | null | undefined): boolean {
  const mine = typeof orgId === "string" ? orgId.trim() : "";
  return mine !== "" && doc.ownerOrgId === mine;
}

// Extract the inner VC's `jti` (credential id) from a VP-JWT, or null on any
// malformed input. Used to record the verified credential's id on the user.
export function decodeVcJti(vpJwt: string): string | null {
  try {
    const vp = JSON.parse(Buffer.from(vpJwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { vp?: { verifiableCredential?: string[] } };
    const vc = vp.vp?.verifiableCredential?.[0];
    if (!vc) return null;
    return String((JSON.parse(Buffer.from(vc.split(".")[1] ?? "", "base64url").toString("utf8")) as { jti?: string }).jti ?? "");
  } catch {
    return null;
  }
}

// Derive a deterministic did:key from an arbitrary string seed. The seed is
// hashed with SHA-256 to a stable 32-byte Ed25519 seed so the same string
// always yields the same DID (dev/demo issuer + holder reproducibility).
export function devKeyFromSeed(seed: string) {
  return didKeyFromSeed(createHash("sha256").update(seed).digest());
}

// Public projection of an org — NEVER includes didSeedEncrypted.
export function orgView(o: OrganizationRecord) {
  return { id: o.id, name: o.name, orgType: o.orgType, registrationId: o.registrationId, jurisdiction: o.jurisdiction, did: o.did, verified: o.verified, status: o.status, companyProfile: o.companyProfile, capabilities: o.capabilities, brandLogoDocumentId: o.brandLogoDocumentId, brandAccent: o.brandAccent, createdAt: o.createdAt };
}

// EN-A: uniform 403 for an act outside an org's capability envelope. `missing`
// names the absent capability — a domain ("tokenization"/"identity") or an
// operating role ("Issuer"/"Holder"/"Verifier"). Only ever sent for an org with
// an EXPLICIT envelope: the null (legacy) envelope passes every predicate.
export function orgCapabilityMissing(reply: FastifyReply, org: OrganizationRecord, missing: string) {
  return reply.code(403).send({
    error: "ORG_CAPABILITY_MISSING",
    message: `organization '${org.name}' does not have the '${missing}' capability`,
    details: { orgId: org.id, missing },
  });
}

/**
 * Registers every /api/v1 route on the given (prefixed) instance.
 *
 * `sharedPrincipal` is the app-wide auth preHandler. It is a PARAMETER rather
 * than something built here because EN-D1's production docs gate needs the very
 * same instance: that preHandler owns the per-key rate-limit and failed-attempt
 * counters, and a second instance would be a second, independently-refilling
 * budget for the same key. It stays optional so a caller that only wants routes
 * (tests, tooling) still gets a correct — if separately counted — app.
 */
