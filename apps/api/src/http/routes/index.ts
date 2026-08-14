/**
 * ROUTE REGISTRATION, ONE FILE PER PRODUCT.
 *
 * routes.ts was 6,707 lines with all three families interleaved: tokenization's
 * 37 routes spread over lines 743–6286, identity's 45 over 1061–6237. Finding
 * "the identity routes" meant reading the whole thing.
 *
 * ORDER IS PRESERVED but does not matter: Fastify matches on a radix tree, not
 * on registration order. What matters is that every route still gets the same
 * `onRoute` domain gate (app.ts) and the same schemas, which the OpenAPI
 * snapshot proves — it did not change by a line when this file was split.
 */
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyRecord, AssetRecord, BrandingPatch, CashflowRecord, CompanyProfile, CredentialRecord, DocumentPurpose, KybDocumentRef, KycDetails, KycStatus, ListingRecord, OrganizationRecord, ProposalRecord, UserRecord, VerificationRequestRecord, WebhookEndpointRecord } from "../../persistence/types.js";
import { ListingConflictError } from "../../persistence/types.js";
import { assignableRoles, auditEntryHash, canCreateOrgMember, canCreateUser, canManageUsers, certificatePageSize, computeCashflowSchedule, CREDENTIAL_TEMPLATES, CREDENTIAL_TYPES, credentialTypeDef, credentialUseCaseType, decodeJwt, didKeyFromSeed, generateDidKey, holderPolicyAllows, instantiateTemplate, invoiceFingerprint, issueCredential, issuerBindingAllows, modeAllows, normalizeUseCaseDefinition, ORG_OPERATING_ROLES, orgDomainEnabled, orgRoleEnabled, PolicyError, presentCredential, presentCredentials, SANDBOX_CHAIN_ID, sandboxChainsValid, splitProRata, TEMPLATE_CATALOG, useCaseDomainOf, validateBrandAccent, validateCertificatePlacements, validateCredentialUseCase, validateEventTypes, validateMetadata, scopeAllows, validateOrgCapabilities, validateScopes, validateTemplate, verifierBindingAllows, verifyChain, verifyDidSignature, verifyPresentation, verifyPresentationCredentials, isDocumentSha256, type Actor, type ApiScope, type ChainEntry, type CredentialTypeSpec, type CredentialUseCaseDefinition, type LifecycleAction, type OrgDomain, type OrgOperatingRole, type OrgType, type ResourceMode, type Role, type UseCaseDefinition, type UseCaseTemplate, type CertificateFieldPlacement } from "@tokenlayer/core";
import qrcode from "qrcode";
import type { AppDeps } from "../../context.js";
import { certificateStatusBanner, humanizeKey, renderCredentialCertificate } from "../../certificate.js";
import { artworkDimensions, certificateDrawList, drawCertificate } from "../../certificate-artwork.js";
import { certificateLogoDocumentId, resolveCertificateFields } from "../../certificate-fields.js";
import { isSupportedCurrency } from "../../currencies.js";
import { renderContractCode } from "../../contract-code.js";
import { deployAndCreateUseCase } from "../../use-cases.js";
import { computeAnalytics } from "../../analytics.js";
import { computeIdentityDashboard } from "../../identity-analytics.js";
import { issueCredentialFor, revokeCredentialById } from "../../credential-issuance.js";
import { namespaceHolding } from "../../usecase-namespace.js";
import { emitEvent, ownerOrgOfUseCase } from "../../events.js";
import { mintOrgMembership } from "../../membership.js";
import { ensurePlatformIssuerOrg, PLATFORM_ORG_NAME } from "../../platform-org.js";
import { computeActivity, computePortfolio } from "../../investor.js";
import { readErpInvoices, stageInvoice } from "../../invoice-register.js";
import { assetBalancesOf, coded, CodedError, dropPayerShare, executeCashflowCore, executeIssueActivation, runGatedAction } from "../../executors.js";
import { proposalKind } from "../../proposal-kinds.js";
import type { OnboardUserPayload } from "../../user-kinds.js";
import { resolveDid } from "../../did-resolver.js";
import { checkUrl } from "../../webhooks/url-guard.js";
import { API_KEY_BCRYPT_ROUNDS, invalidateVerifiedPrefix, mintSecret } from "../../api-keys.js";
import { BRAND_LOGO_PRUNE_GRACE_MS, pruneSupersededBrandLogos } from "../../brand-logo-prune.js";
import { S } from "../schemas/index.js";
import { holdsValidCredential, IDENTITY_CREDENTIAL_TYPE } from "../../identity-assertions.js";
import { actorOf, claimsOf, contextOf, isPositiveIntString, machinePrincipal, notFound, requirePrincipal, requireScope, scopedToCaller, type TokenClaims } from "../support.js";
import { buildRouteContext } from "./context.js";
import { registerSharedRoutes } from "./shared.js";
import { registerTokenizationRoutes } from "./tokenization.js";
import { registerIdentityRoutes } from "./identity.js";

export function registerRoutes(app: FastifyInstance, deps: AppDeps, sharedPrincipal?: ReturnType<typeof requirePrincipal>): void {
  const ctx = buildRouteContext(app, deps, sharedPrincipal);
  registerSharedRoutes(app, deps, ctx);
  registerTokenizationRoutes(app, deps, ctx);
  registerIdentityRoutes(app, deps, ctx);
}
