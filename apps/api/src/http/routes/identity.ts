/**
 * THE IDENTITY PRODUCT.
 *
 * Credential use cases and their templates, issuance and revocation, the
 * presentation exchange, DID resolution and the on-chain registry. Gated the
 * same way as tokenization's: registered always, 404 when the product is off.
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
import { issueCredentialFor } from "../../identity/credential-issuance.js";
import { vreqView } from "../../identity/verification-request-view.js";
import { namespaceHolding } from "../../shared/usecase-namespace.js";
import { emitEvent, ownerOrgOfUseCase } from "../../shared/events.js";
import { mintOrgMembership } from "../../shared/membership.js";
import { PLATFORM_ORG_NAME } from "../../shared/platform-org.js";
import { computeActivity, computePortfolio } from "../../tokenization/investor.js";
import { readErpInvoices, stageInvoice } from "../../tokenization/invoice-register.js";
import { assetBalancesOf, coded, CodedError, dropPayerShare, executeCashflowCore, executeIssueActivation, runGatedAction } from "../../shared/executors.js";
import { proposalKind } from "../../shared/proposal-kinds.js";
import type { OnboardUserPayload } from "../../shared/user-kinds.js";
import { kycDecisionEmail, welcomeCredentialsEmail } from "../../mail/templates.js";
import { resolveDid } from "../../identity/did-resolver.js";
import { checkUrl } from "../../webhooks/url-guard.js";
import { API_KEY_BCRYPT_ROUNDS, invalidateVerifiedPrefix, mintSecret } from "../../shared/api-keys.js";
import { BRAND_LOGO_PRUNE_GRACE_MS, pruneSupersededBrandLogos } from "../../shared/brand-logo-prune.js";
import { S } from "../schemas/index.js";
import { holdsValidCredential, IDENTITY_CREDENTIAL_TYPE } from "../../identity/identity-assertions.js";
import { redactClaims, resolveDisclosures, validateRequestedFields, type DisclosureChoice, type FieldRequest } from "../../identity/selective-disclosure.js";
import { actorOf, claimsOf, contextOf, isPositiveIntString, machinePrincipal, notFound, requirePrincipal, requireScope, scopedToCaller, type TokenClaims } from "../support.js";
import { NO_USE_CASE, canAdministerUser, BCRYPT_ROUNDS, LOGIN_WINDOW_MS, MAX_DOC_BYTES, DOC_UPLOAD_BODY_LIMIT, ALLOWED_DOC_TYPES, storeUploadedDocument, orgOwnsDocument, decodeVcJti, devKeyFromSeed, orgView, orgCapabilityMissing } from "./common.js";
import type { BrandLogoErrorCode, RouteContext } from "./context.js";

export function registerIdentityRoutes(app: FastifyInstance, deps: AppDeps, ctx: RouteContext): void {
  const { principal, auth, authScoped, loginThrottled, proposeIfGated, orgScoped, resolveUseCaseDomain, useCaseKeysByDomain, linkedWallet, orgMemberCapabilityViolation, brandLogoRefusal, proposalView, ensureOrg, manageableTarget, mapHeld, isRenderableArtwork, RENDERABLE_ARTWORK_TYPES, assetChain, verifyAsset, redactPayload } = ctx;
  // A verification request is driveable by its verifier ORG (the existing path)
  // OR by a use-case-scoped Verifier desk user whose useCaseKey matches the
  // request's credential use case (the additive F5 path). The scoped verifier
  // owns no org, so a request they raised carries verifierOrgId "" and is bound
  // to the use case via credentialUseCaseKey.
  function verifierScoped(claims: TokenClaims, r: VerificationRequestRecord): boolean {
    return orgScoped(claims, r.verifierOrgId)
      || (claims.role === "Verifier" && !!r.credentialUseCaseKey && claims.useCaseKey === r.credentialUseCaseKey);
  }


  // --- credential use cases (Identity domain) -----------------------------
  // The DID/VC parallel of token use cases: configurable custom credential types
  // + Issuer/Holder/Verifier bindings. Reads are open to authed users; authoring
  // is PlatformAdmin-only. A slug is either a token or a credential use case.
  app.get("/credential-templates", { schema: S.credentialTemplates, ...auth }, async () => CREDENTIAL_TEMPLATES);


  // Same D2-6 narrowing as the tokenization catalog above, and for the same reason.
  /**
   * A credential use case as a NON-OWNER may see it: the same record with every
   * DOCUMENT REFERENCE removed from its certificate design.
   *
   * These two routes are `...auth` — any authenticated principal of any role in
   * any organization, which is deliberate, because the catalog is what a holder
   * or verifier consults to know what a programme issues. What is NOT part of
   * that answer is which stored bytes render its certificate.
   *
   * This was proved, not theorised. The artwork branch added `background.sha256`
   * to the stored config as a capability — "you must have seen the file" — and
   * this route published it to everyone, `credentialTypes: { type: "array" }`
   * having no item schema to strip it. Org B read org A's `{documentId,
   * sha256}` here, pinned it onto a use case B owned, and fetched A's letterhead
   * byte for byte. `logoDocumentId` rode the same route with no pin at all and
   * still feeds the preview renderer.
   *
   * Ownership on the document row (see `orgOwnsDocument`) is what actually
   * closes that; this is the other half — do not hand out the identifiers in
   * the first place. Owners and PlatformAdmins see the design in full, because
   * the designer has to load it.
   */
  function certificateDesignVisible(request: FastifyRequest, cuc: CredentialUseCaseDefinition): CredentialUseCaseDefinition {
    const claims = request.user as TokenClaims;
    const orgId = typeof claims.orgId === "string" ? claims.orgId.trim() : "";
    if (claims.role === "PlatformAdmin") return cuc;
    if (orgId !== "" && cuc.ownerOrgId === orgId) return cuc;
    if (!cuc.credentialTypes?.some((t) => t.certificate?.background || t.certificate?.logoDocumentId)) return cuc;
    return {
      ...cuc,
      credentialTypes: cuc.credentialTypes.map((t) => {
        if (!t.certificate) return t;
        const { background, logoDocumentId, ...rest } = t.certificate;
        void background; void logoDocumentId;
        return { ...t, certificate: rest };
      }),
    };
  }


  app.get("/credential-use-cases", { schema: S.listCredentialUseCases, ...auth }, async (request) =>
    (await deps.credentialUseCases.list()).map((c) => certificateDesignVisible(request, c)));


  app.get("/credential-use-cases/:key", { schema: S.getCredentialUseCase, ...auth }, async (request, reply) => {
    const cuc = await deps.credentialUseCases.get((request.params as { key: string }).key);
    if (!cuc) return notFound(reply, "credential use case not found");
    return certificateDesignVisible(request, cuc);
  });


  // Load every org a credential-use-case definition references (bound issuer,
  // specific holders, listed verifiers) — the RECORDS, not just ids, so the same
  // fetch serves existence validation and the EN-A envelope checks below.
  async function referencedOrgs(def: CredentialUseCaseDefinition): Promise<Map<string, OrganizationRecord>> {
    const ids = new Set<string>();
    if (def.issuer.kind === "org") ids.add(def.issuer.orgId);
    if (def.holderPolicy.who === "specific") def.holderPolicy.orgIds.forEach((i) => ids.add(i));
    if (def.verifier.kind === "orgs") def.verifier.orgIds.forEach((i) => ids.add(i));
    const out = new Map<string, OrganizationRecord>();
    for (const id of ids) {
      const o = await deps.organizations.get(id).catch(() => null);
      if (o) out.set(id, o);
    }
    return out;
  }


  /**
   * What a `certificate.background` may name, checked at the WRITE.
   *
   * `documentId` was bound to nothing: validation asked only for a non-empty
   * string, and both renderers read whatever id they were handed with no
   * content-type check. This is the write-time half of that; the render keeps
   * its fallback, because a document can be deleted long after a config was
   * written and a missing one must not turn every certificate of that type into
   * an error.
   *
   * `requirePin` is the difference between the two kinds of door. The
   * org-scoped design route sets it: `documentId` alone is a guessable
   * reference, and a pin is what proves the caller has actually seen the file.
   * The three pre-existing PlatformAdmin doors leave it false, so a bare
   * documentId — including one naming nothing — keeps working exactly as it did
   * before, which is what `certificate-artwork.test.ts` pins.
   *
   * Returns null when there is nothing to refuse; otherwise the coded 400 the
   * caller sends. Never replies itself: three of its four call sites are inside
   * loops over credential types, where a helper that had already answered would
   * be a second reply on the same request.
   */
  async function checkBackgroundDocument(
    background: { documentId?: unknown; sha256?: unknown } | null | undefined,
    opts: { requirePin: boolean; owner?: { orgId: string | null | undefined; bypass: boolean; uploadedBy?: string } },
  ): Promise<{ error: string; message: string } | null> {
    if (!background || typeof background.documentId !== "string") return null;
    const documentId = background.documentId;
    // A pin in the wrong SHAPE is a caller error, not an absent pin. Answering
    // "you must supply a pin" to someone who just did sends them looking in the
    // wrong place — and on the preview door, where no definition validator runs
    // first, a malformed pin would otherwise skip verification entirely.
    if (background.sha256 !== undefined && !isDocumentSha256(background.sha256)) {
      return { error: "BACKGROUND_PIN_MALFORMED", message: `certificate background sha256 must be a 0x-prefixed 64-character lowercase hex digest, as POST /credential-use-cases/{key}/certificate/artwork returns it` };
    }
    const pin = isDocumentSha256(background.sha256) ? background.sha256 : null;
    if (opts.requirePin && !pin) {
      return { error: "BACKGROUND_PIN_REQUIRED", message: `certificate background must carry the artwork's sha256 alongside documentId '${documentId}'` };
    }
    // NO `.catch(() => null)` — `DocumentRepository.get` resolves "no such
    // row" to `null` without throwing in both implementations, so a catch here
    // could only swallow a REAL repository failure, making an UNREADABLE
    // document indistinguishable from an ABSENT one. On the
    // `checkDefinitionBackgrounds` path (no `owner`, no `requirePin`), absent
    // means ALLOWED, so a swallowed failure would write a brand-logo
    // background into a definition permanently. Absent is a documented pass;
    // unreadable must not borrow its answer — let it propagate.
    const doc = await deps.documents.get(documentId);
    if (!doc) {
      if (!opts.requirePin && !opts.owner) return null; // the render-time fallback is the guard on those doors
      return { error: "BACKGROUND_DOCUMENT_NOT_FOUND", message: `certificate background document '${documentId}' not found` };
    }
    // OWNERSHIP BEFORE ANY OTHER FACT ABOUT THE DOCUMENT, and answering exactly
    // as if it did not exist.
    //
    // The three refusals below are an oracle over the whole document store if
    // they run first: "not found" / "is application/pdf" / "wrong digest" tell
    // an unauthorised caller whether an id exists and what type it is, from a
    // principal `canReadDoc` refuses outright — and the content type was in the
    // message. A caller who may not use these bytes learns nothing about them
    // beyond the id they already had.
    // An org-less desk operator (no `orgId` at all) can never satisfy
    // `orgOwnsDocument` — it fails closed on a null/empty orgId by design (see
    // its own comment). `uploadedBy` is the narrow escape hatch: it grants
    // exactly "the exact person who uploaded these exact bytes", never
    // "anyone in roughly the right role" — the arbitrary-document-disclosure
    // shape this route's own history (above) already warns about, so it is
    // checked as an OR against ownership, never a replacement for it.
    const uploadedByCaller = !!opts.owner?.uploadedBy && doc.uploadedBy === opts.owner.uploadedBy;
    if (opts.owner && !opts.owner.bypass && !uploadedByCaller && !orgOwnsDocument(doc, opts.owner.orgId)) {
      return { error: "BACKGROUND_DOCUMENT_NOT_FOUND", message: `certificate background document '${documentId}' not found` };
    }
    // A MARK IS NOT ARTWORK — see `brandLogoRefusal` above for why this rule
    // exists and what it costs. This is the certificate ARTWORK door.
    //
    // AFTER the ownership check, but that check is CONDITIONAL
    // (`if (opts.owner && !opts.owner.bypass && ...)`), so two shapes reach
    // this line without a per-caller ownership match: (a) `opts.owner` is set
    // and either passed or bypassed by a PlatformAdmin; (b) `opts.owner` is
    // absent, which is how `checkDefinitionBackgrounds` calls in — from
    // `POST`/`PATCH /credential-use-cases`, `POST /credential-use-cases/provision`,
    // and `createCredentialUseCaseFromDef` (provision's create branch a second
    // time). Each is harmless for its OWN reason:
    // `POST` and `PATCH` restrict the ROLE to PlatformAdmin;
    // provisioning admits an OrgAdmin too but is safe by SHAPE —
    // `instantiateTemplate` builds `certificate` with no `background` key at
    // all, so this function returns at the `typeof documentId !== "string"`
    // guard long before reaching here. Either way, the caller here is always
    // the document's own org or a PlatformAdmin, never arbitrary — the same
    // reasoning that puts `BACKGROUND_NOT_AN_IMAGE` below the ownership check
    // rather than above it.
    //
    // The cost: an org whose mark IS its letterhead uploads the file twice,
    // once at each door — cheap, for a provable invariant.
    const brandLogo = brandLogoRefusal(doc, "BACKGROUND_IS_BRAND_LOGO",
      `document '${documentId}' was uploaded as an organization brand logo and cannot be used as certificate artwork; upload it through POST /credential-use-cases/{key}/certificate/artwork instead`);
    if (brandLogo) return brandLogo;
    if (!isRenderableArtwork(doc.contentType)) {
      return { error: "BACKGROUND_NOT_AN_IMAGE", message: `certificate background document '${documentId}' is ${doc.contentType}; artwork must be image/png or image/jpeg — the renderer can draw nothing else` };
    }
    if (pin && pin !== doc.sha256) {
      return { error: "BACKGROUND_DOCUMENT_MISMATCH", message: `certificate background document '${documentId}' does not match the supplied sha256` };
    }
    return null;
  }


  /**
   * What `certificate.logoDocumentId` may name — a narrower check than
   * `checkBackgroundDocument`, built on the same `brandLogoRefusal` predicate.
   *
   * `logoDocumentId` is the same kind of caller-supplied document reference as
   * `background` — a different field of the same JSON blob — but it carries no
   * pin and no ownership check today, and never has: `validateCredentialUseCase`
   * (packages/core) asks only that it be a string. This checks the ONE thing
   * that matters for the prune — is the named document a brand logo — and
   * leaves the rest of that pre-existing gap exactly as it was; widening it
   * further is a separate task, not this one.
   *
   * WHAT THAT COSTS, STATED RATHER THAN GLOSSED. Because there is no ownership
   * check to sit behind, this refusal is a one-bit oracle: naming an id here
   * and getting `CERTIFICATE_LOGO_IS_BRAND_LOGO` back tells the caller that id
   * is some organization's mark, and an OrgAdmin can reach this door. That is
   * accepted, not overlooked. Document ids are cuids, so the oracle answers
   * only for ids a caller already holds, and the one bit it yields — "this is a
   * brand logo" — is strictly less than the bytes `GET /documents/:id` already
   * refuses them. Ordering it behind an ownership check, as
   * `checkBackgroundDocument` does, would be strictly better and belongs with
   * the rest of the pre-existing gap when someone closes it.
   */
  async function checkCertificateLogoDocument(logoDocumentId: unknown): Promise<{ error: BrandLogoErrorCode; message: string } | null> {
    if (typeof logoDocumentId !== "string" || !logoDocumentId.trim()) return null;
    // NO `.catch(() => null)` here either — same reasoning as
    // `checkBackgroundDocument`'s comment above: an unreadable document must
    // not be treated as an absent one, especially on a WRITE nothing later
    // revalidates. Let it propagate.
    const doc = await deps.documents.get(logoDocumentId);
    return brandLogoRefusal(doc, "CERTIFICATE_LOGO_IS_BRAND_LOGO",
      `document '${logoDocumentId}' was uploaded as an organization brand logo and cannot be set as certificate.logoDocumentId — the issuing organization's brand logo is already used automatically as the fallback when a credential type names none of its own`);
  }


  /** `checkBackgroundDocument` and `checkCertificateLogoDocument` across every
   *  credential type of a definition. */
  async function checkDefinitionBackgrounds(
    def: { credentialTypes?: Array<{ certificate?: { background?: { documentId?: unknown; sha256?: unknown } | null; logoDocumentId?: unknown } }> },
  ): Promise<{ error: string; message: string } | null> {
    for (const ct of def.credentialTypes ?? []) {
      const problem = await checkBackgroundDocument(ct.certificate?.background, { requirePin: false });
      if (problem) return problem;
      const logoProblem = await checkCertificateLogoDocument(ct.certificate?.logoDocumentId);
      if (logoProblem) return logoProblem;
    }
    return null;
  }


  // EN-A config-time envelope gates for a credential-use-case definition: a
  // bound issuer org must be an identity-domain Issuer, every LISTED verifier
  // org a Verifier, and an owner org identity-domained. Null envelopes (legacy
  // orgs) pass every predicate. Returns the first violation, or null when the
  // definition fits every referenced org's envelope.
  async function credentialUseCaseCapabilityViolation(
    def: CredentialUseCaseDefinition, orgs: Map<string, OrganizationRecord>,
  ): Promise<{ org: OrganizationRecord; missing: string } | null> {
    if (def.issuer.kind === "org") {
      const issuer = orgs.get(def.issuer.orgId);
      if (issuer && !orgRoleEnabled(issuer.capabilities, "Issuer")) return { org: issuer, missing: "Issuer" };
      if (issuer && !orgDomainEnabled(issuer.capabilities, "identity")) return { org: issuer, missing: "identity" };
    }
    if (def.verifier.kind === "orgs") {
      for (const id of def.verifier.orgIds) {
        const verifier = orgs.get(id);
        if (verifier && !orgRoleEnabled(verifier.capabilities, "Verifier")) return { org: verifier, missing: "Verifier" };
      }
    }
    if (def.ownerOrgId) {
      // The owner is not part of the validator's referenced-id set (ownership is
      // not existence-checked today) — fetch it only for the envelope check.
      const owner = orgs.get(def.ownerOrgId) ?? (await deps.organizations.get(def.ownerOrgId).catch(() => null));
      if (owner && !orgDomainEnabled(owner.capabilities, "identity")) return { org: owner, missing: "identity" };
    }
    return null;
  }


  app.post("/credential-use-cases", { schema: S.createCredentialUseCase, ...authScoped("usecases:provision") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    // A PlatformAdmin authors directly (201); an active OrgAdmin proposes an
    // org-owned use case for a PlatformAdmin to approve (maker-checker, 202) —
    // mirrors POST /use-cases on the tokenization side exactly.
    if (claims.role !== "PlatformAdmin" && !(claims.role === "OrgAdmin" && claims.orgId)) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only a platform admin or an org admin may author credential use cases" });
    }
    let def = request.body as CredentialUseCaseDefinition;
    if (claims.role === "OrgAdmin") {
      // Stamp ownership AND the issuer binding from the caller's own claims,
      // never the client body — an OrgAdmin may only create a use case IT
      // issues for, never bind an arbitrary org (or the platform) as issuer.
      def = { ...def, ownerOrgId: claims.orgId, issuer: { kind: "org", orgId: claims.orgId as string } };
    }
    if (await namespaceHolding(deps, def.key)) {
      return reply.code(409).send({ error: "KEY_TAKEN", message: `use-case key '${def.key}' already exists` });
    }
    // Resolve org existence up-front (validator is sync).
    const known = await referencedOrgs(def);
    try {
      validateCredentialUseCase(def, { orgExists: (id) => known.has(id) });
    } catch (err) {
      return reply.code(400).send({ error: "INVALID_CREDENTIAL_USECASE", message: (err as Error).message });
    }
    const badBackground = await checkDefinitionBackgrounds(def);
    if (badBackground) return reply.code(400).send(badBackground);
    const violation = await credentialUseCaseCapabilityViolation(def, known);
    if (violation) return orgCapabilityMissing(reply, violation.org, violation.missing);
    if (claims.role === "OrgAdmin") {
      const proposal = await deps.proposals.create({
        useCaseKey: null, orgId: claims.orgId as string, assetId: null, kind: "create-credential-use-case",
        payload: def as unknown as Record<string, unknown>,
        proposerId: claims.id, proposerLabel: claims.email, required: 1,
      });
      return reply.code(202).send({ proposal: proposalView(proposal) });
    }
    const created = await deps.credentialUseCases.create({ ...def, ownerOrgId: def.ownerOrgId ?? null });
    await deps.audit.append({ actorId: claims.id, action: "credential-usecase-created" as LifecycleAction, payload: { key: def.key } });
    return reply.code(201).send(created);
  });


  app.patch("/credential-use-cases/:key", { schema: S.updateCredentialUseCase, ...authScoped("usecases:provision") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only a platform admin may edit credential use cases" });
    const key = (request.params as { key: string }).key;
    const existing = await deps.credentialUseCases.get(key);
    if (!existing) return notFound(reply, "credential use case not found");
    const body = request.body as CredentialUseCaseDefinition;
    const def = { ...body, key };
    const known = await referencedOrgs(def);
    try {
      validateCredentialUseCase(def, { orgExists: (id) => known.has(id) });
    } catch (err) {
      return reply.code(400).send({ error: "INVALID_CREDENTIAL_USECASE", message: (err as Error).message });
    }
    const badBackground = await checkDefinitionBackgrounds(def);
    if (badBackground) return reply.code(400).send(badBackground);
    const ownerOrgId = def.ownerOrgId ?? existing.ownerOrgId ?? null;
    const violation = await credentialUseCaseCapabilityViolation({ ...def, ownerOrgId }, known);
    if (violation) return orgCapabilityMissing(reply, violation.org, violation.missing);
    const updated = await deps.credentialUseCases.update(key, { ...def, ownerOrgId });
    await deps.audit.append({ actorId: claims.id, action: "credential-usecase-updated" as LifecycleAction, payload: { key } });
    return reply.code(200).send(updated);
  });


  // Additive counterpart to the PATCH above: a use case's OWN UseCaseAdmin can
  // append one new credential type without the authority (or the blast radius)
  // of a full-definition replace — they can neither rebind the issuer/holder/
  // verifier nor touch an existing type. PlatformAdmin already has full-replace
  // PATCH for everything else, so this route is deliberately narrower than that,
  // not an alternative path to it.
  app.post("/credential-use-cases/:key/credential-types", { schema: S.addCredentialType, ...authScoped("usecases:provision") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const key = (request.params as { key: string }).key;
    if (!(claims.role === "UseCaseAdmin" && claims.useCaseKey === key)) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only this use case's UseCaseAdmin may add a credential type" });
    }
    const existing = await deps.credentialUseCases.get(key);
    if (!existing) return notFound(reply, "credential use case not found");
    const newType = request.body as CredentialTypeSpec;
    if (existing.credentialTypes.some((t) => t.name === newType.name)) {
      return reply.code(409).send({ error: "TYPE_EXISTS", message: `credential type '${newType.name}' already exists on this use case` });
    }
    const def = { ...existing, credentialTypes: [...existing.credentialTypes, newType] };
    const known = await referencedOrgs(def);
    try {
      validateCredentialUseCase(def, { orgExists: (id) => known.has(id) });
    } catch (err) {
      return reply.code(400).send({ error: "INVALID_CREDENTIAL_USECASE", message: (err as Error).message });
    }
    const badBackground = await checkDefinitionBackgrounds(def);
    if (badBackground) return reply.code(400).send(badBackground);
    const violation = await credentialUseCaseCapabilityViolation(def, known);
    if (violation) return orgCapabilityMissing(reply, violation.org, violation.missing);
    const updated = await deps.credentialUseCases.update(key, def);
    await deps.audit.append({ actorId: claims.id, action: "credential-usecase-updated" as LifecycleAction, payload: { key, addedCredentialType: newType.name } });
    return reply.code(200).send(updated);
  });



  // --- credential use-case TEMPLATE catalog (ID-G) ------------------------
  // Declarative, parameterized starting points for authoring a credential use
  // case (distinct from the raw per-credential-type CREDENTIAL_TEMPLATES above
  // at GET /credential-templates — that route is pre-existing and unrelated).
  // Built-ins live in core (TEMPLATE_CATALOG); saved custom templates persist
  // via deps.credentialTemplates. Reads are open to any authed user; saving is
  // PlatformAdmin/OrgAdmin-only.
  app.get("/credential-use-case-templates", { schema: S.listUseCaseTemplates, ...auth }, async () => {
    const saved = await deps.credentialTemplates.list();
    const all = [...TEMPLATE_CATALOG, ...saved];
    return { templates: all.map(({ body, ...meta }) => meta) };
  });


  app.get("/credential-use-case-templates/:key", { schema: S.getUseCaseTemplate, ...auth }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const builtIn = TEMPLATE_CATALOG.find((t) => t.key === key);
    const t = builtIn ?? (await deps.credentialTemplates.get(key));
    if (!t) return notFound(reply, `template '${key}' not found`);
    return t;
  });


  app.post("/credential-use-case-templates", { schema: S.createUseCaseTemplate, ...authScoped("usecases:provision") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin" && claims.role !== "OrgAdmin") {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only a platform admin or org admin may save a credential-use-case template" });
    }
    const t = request.body as UseCaseTemplate;
    try {
      validateTemplate(t);
    } catch (e) {
      return reply.code(400).send({ error: "INVALID_TEMPLATE", message: (e as Error).message });
    }
    if (TEMPLATE_CATALOG.some((x) => x.key === t.key) || (await deps.credentialTemplates.get(t.key))) {
      return reply.code(409).send({ error: "TEMPLATE_KEY_TAKEN", message: `template key '${t.key}' already exists` });
    }
    t.builtIn = false;
    // EN-F: STRIP THE ARTWORK BEFORE IT IS STORED, not when it is instantiated.
    //
    // `instantiateTemplate` already drops `certificate.background`, and that was
    // believed to be enough. It is not: the STORED RECORD still carries the
    // document id, `GET /credential-use-case-templates/:key` is `...auth` — any
    // authenticated user — and the web builder's "save as template" copies the
    // certificate block verbatim. The final review proved the chain end to end:
    // Org A saves its design, an unrelated tokenization Buyer reads the template
    // and lifts `background.documentId`, and renders Org A's letterhead. The
    // whole reason the design refuses to let artwork travel with a template was
    // to prevent exactly that, and the defence was one layer too late.
    //
    // Stripped rather than refused because a design saved from a working use
    // case legitimately HAS artwork; the author is not making a mistake, and
    // failing their save would be the wrong lesson. What travels is the
    // layout, which is the reusable part.
    //
    // `logoDocumentId` is deliberately NOT stripped here: it has travelled with
    // templates since ID-I, `instantiate()` still copies it onto the definition,
    // and changing that is a behaviour change to a shipped feature rather than
    // part of EN-F. Recorded as a known inconsistency, not fixed by stealth.
    //
    // It IS refused when it names a brand logo — REFUSED, not stripped, unlike
    // `background` above. The reasoning that makes silent stripping right for
    // `background` (a working design legitimately has artwork; failing the save
    // would be the wrong lesson) does not apply here: a template naming its
    // own org's brand-logo document gains nothing by it (the fallback in
    // `certificateLogoDocumentId` already applies the org's mark for free), so
    // there is no legitimate case to protect — only a caller who reaches for
    // the wrong id, still on screen to fix it.
    for (const ct of t.body?.credentialTypes ?? []) {
      const logoProblem = await checkCertificateLogoDocument(ct.certificate?.logoDocumentId);
      if (logoProblem) return reply.code(400).send(logoProblem);
      if (ct.certificate?.background !== undefined) delete ct.certificate.background;
    }
    const created = await deps.credentialTemplates.create(t);
    return reply.code(201).send(created);
  });


  app.post("/credential-use-case-templates/:key/preview", { schema: S.previewUseCaseTemplate, ...auth }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const builtIn = TEMPLATE_CATALOG.find((t) => t.key === key);
    const t = builtIn ?? (await deps.credentialTemplates.get(key));
    if (!t) return notFound(reply, `template '${key}' not found`);
    const b = request.body as { params?: Record<string, unknown> };
    try {
      return { definition: instantiateTemplate(t, b.params ?? {}) };
    } catch (e) {
      if (e instanceof PolicyError && e.code === "INVALID_TEMPLATE_PARAMS") {
        return reply.code(400).send({ error: e.code, message: e.message, problems: (e.details as { problems?: string[] })?.problems ?? [] });
      }
      throw e;
    }
  });


  /**
   * EN-F: render a DRAFT certificate design, before the use case exists.
   *
   * The designer posts a credential type it has not saved, so nothing here is
   * read from storage except the one artwork document the draft names — there
   * is no key, no definition and no credential to look up.
   *
   * THE RULE THIS ROUTE EXISTS TO KEEP: every artwork preview is stamped
   * SAMPLE — NOT A CREDENTIAL. It renders arbitrary caller-supplied claims
   * through the same code that renders real certificates, over the customer's
   * own artwork; without the stamp it is a certificate generator for made-up
   * facts. `sample: true` below is unconditional for exactly that reason.
   */
  /**
   * The SAMPLE-stamped rendering core shared by both preview routes below.
   * Takes no document-ownership decision itself — that is each CALLER's job,
   * because the two callers differ on exactly that point: the draft route's
   * `spec` is caller-supplied and its background id must be ownership-checked
   * before this runs; the stored-type route's `spec` came out of a use case
   * definition already in the database, so the id was never attacker-chosen
   * and there is nothing to check.
   */
  async function renderSampleCertificatePdf(
    spec: CredentialTypeSpec, sampleClaims: Record<string, unknown> | undefined, log: FastifyRequest["log"],
  ): Promise<Buffer> {
    // A fabricated credential: every value is visibly sample data, and the id is
    // not a real one, so the QR resolves to a status route that answers 404.
    const claims: Record<string, unknown> = {};
    for (const key of Object.keys(spec.claimSchema.properties)) {
      // A missing sample value falls back to the humanized key rather than to
      // nothing: an absent field is SKIPPED by the draw list, and a designer
      // who cannot see the chip they just dropped cannot place it.
      claims[key] = sampleClaims?.[key] ?? humanizeKey(key);
    }
    const now = new Date();
    const sample: CredentialRecord = {
      id: "cred_sample", holderDid: "did:key:zSample", issuerDid: "did:key:zSampleIssuer",
      type: spec.name, vcJwt: "", subjectClaims: claims,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (Number(spec.validityDays) || 0) * 86_400_000).toISOString(),
      revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
      proposalId: null, credentialUseCaseKey: null,
      acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
      anchorTxHash: null, anchorChainId: null, revokeTxHash: null,
    };
    const statusUrl = `${deps.publicApiUrl}/credentials/${sample.id}/status`;

    let pdf: Buffer | null = null;
    const bgId = spec.certificate?.background?.documentId;
    if (bgId) {
      try {
        const bytes = (await deps.documents.get(bgId))?.bytes;
        if (!bytes) throw new Error(`background document '${bgId}' not found`);
        // The page comes from a REAL measurement, never a hand-built object:
        // the draw list trusts the page it is handed, so a degenerate one would
        // yield a QR of size 0 — rule 1 satisfied structurally and vacuous in
        // fact. `artworkDimensions` throws rather than returning one.
        const measured = artworkDimensions(bytes);
        const page = certificatePageSize(measured.width, measured.height);
        const ops = certificateDrawList({
          placements: spec.certificate?.placements ?? [],
          values: resolveCertificateFields({ credential: sample, spec, issuerName: "Sample Issuer" }),
          page, statusUrl,
          // A draft has no status: it is not a credential and cannot be revoked.
          banner: null,
          sample: true, // RULE 3 — always, on both these routes
        });
        pdf = await drawCertificate(ops, bytes, page);
      } catch (err) {
        // Artwork the designer just uploaded may be anything at all, and a
        // truncated or unreadable file must not 500 the editor mid-keystroke.
        log.error({ err, backgroundDocumentId: bgId }, "preview artwork unusable; previewing the built-in layout");
        pdf = null;
      }
    }
    if (!pdf) {
      // No artwork (or unusable): preview the built-in layout, which is exactly
      // what this config would produce.
      //
      // KNOWN GAP, DELIBERATE: this path is NOT stamped SAMPLE, because
      // `renderCredentialCertificate` takes no such parameter and EN-F does not
      // change that renderer. It prints a certificate for the fabricated id
      // `cred_sample`, whose QR resolves to a status route answering 404 —
      // visibly not a real credential — so the risk is materially lower than in
      // artwork mode, where the design is the customer's own and would look
      // genuine. Recorded rather than silently accepted.
      pdf = await renderCredentialCertificate({
        credential: sample, spec, issuerName: "Sample Issuer", statusUrl,
        status: { revoked: false, revokedAt: null, revokedReason: null },
        logoBytes: null, nowMs: Date.now(),
      });
    }
    return pdf;
  }


  app.post("/credential-use-cases/preview-certificate", {
    schema: S.previewCertificate,
    bodyLimit: 256 * 1024, // JSON config, not artwork — the artwork is already stored and referenced by id
    ...authScoped("usecases:provision"),
  }, async (request, reply) => {
    const actor = request.user as TokenClaims;
    // THE ROLE GATE, WITHOUT WHICH `authScoped` GATES NOTHING HERE.
    //
    // `requireScope` short-circuits on `if (!key) return` — scopes are a
    // property of API KEYS, so for a human JWT session it passes
    // unconditionally. Every sibling authoring route therefore pairs the scope
    // with an explicit role predicate; this one did not, and the final review
    // proved the consequence with a seeded tokenization Buyer: 403 from
    // `GET /documents/:id`, then 200 from this route naming the SAME document
    // id, with those bytes embedded full-bleed in the returned PDF. A
    // document-read escalation past both `assets:read` and `canReadDoc`, plus
    // an unstamped built-in-layout certificate for caller-chosen facts.
    //
    // The mutating-route coverage oracle asks "is it authScoped?" and the
    // answer was confidently yes. The question was wrong — the same shape as
    // EN-B's decide-time scope hole and EN-D2's null-as-allow.
    //
    // UseCaseAdmin joined this gate later, deliberately narrower than the
    // other two: a UseCaseAdmin role is BY CONSTRUCTION scoped to exactly one
    // use case (`actor.useCaseKey`), so this can only ever preview a design
    // for their own desk — never an arbitrary programme the way an unscoped
    // OrgAdmin/PlatformAdmin call can. The ownership check just below is what
    // actually decides which BACKGROUND DOCUMENT they may reference; this is
    // only "may this role reach the route at all".
    const isScopedUseCaseAdmin = actor.role === "UseCaseAdmin" && !!actor.useCaseKey;
    if (actor.role !== "PlatformAdmin" && actor.role !== "OrgAdmin" && !isScopedUseCaseAdmin) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only a platform admin, org admin, or a use case's own admin may preview a certificate design" });
    }
    const b = request.body as { credentialType: CredentialTypeSpec; sampleClaims?: Record<string, unknown> };
    const spec = b.credentialType;
    if (!spec?.claimSchema?.properties) return reply.code(400).send({ error: "BAD_REQUEST", message: "credentialType.claimSchema is required" });
    // Validate the DRAFT exactly as saving would, so a design that previews
    // cannot fail to save. Throws INVALID_CERTIFICATE_PLACEMENT → 400.
    validateCertificatePlacements(spec.certificate?.placements, Object.keys(spec.claimSchema.properties), spec.name || "credential type");
    // THE OWNERSHIP CHECK BELONGS HERE MOST OF ALL. This route renders whatever
    // document the draft names into a PDF it hands back — so without it, any
    // OrgAdmin reads any stored PNG or JPEG in the system, while
    // `GET /documents/:id` answers 403 for the same session. EN-F's review
    // closed that for a tokenization Buyer with the role gate above and left it
    // open for every OrgAdmin; a pin does not close it either, because this
    // door never required one.
    const badBackground = await checkBackgroundDocument(spec.certificate?.background, {
      requirePin: false,
      owner: { orgId: actor.orgId, bypass: actor.role === "PlatformAdmin", uploadedBy: actor.id },
    });
    // ARTWORK YOU MAY NOT USE IS TREATED EXACTLY AS ARTWORK THAT IS NOT THERE.
    //
    // Two properties have to hold at once here, and refusing outright breaks the
    // second. EN-F pinned that a background naming a missing document FALLS BACK
    // to the built-in layout rather than erroring, because the editor must not
    // 400 mid-keystroke over a file the designer just deleted. But if a foreign
    // document 400'd while a nonexistent one rendered, the difference between
    // the two answers would itself disclose which ids exist — the oracle this
    // change exists to remove. So both produce the same preview: our layout,
    // none of those bytes, no statement about whether the id is real.
    if (badBackground?.error === "BACKGROUND_DOCUMENT_NOT_FOUND") {
      if (spec.certificate) spec.certificate = { ...spec.certificate, background: undefined };
    } else if (badBackground) {
      return reply.code(400).send(badBackground);
    }

    const pdf = await renderSampleCertificatePdf(spec, b.sampleClaims, request.log);
    return reply
      .header("content-type", "application/pdf")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", 'inline; filename="certificate-preview.pdf"')
      .send(pdf);
  });


  /**
   * Preview an ALREADY-SAVED credential type's certificate design — the
   * stored-config counterpart to the draft route above. Deliberately a
   * DIFFERENT shape, not a widened role check on that one: this route takes no
   * `credentialType` body at all. The type comes from `deps.credentialUseCases`
   * by key + name, so the background document id it renders is never
   * attacker-supplied — there is no ownership check to get wrong because there
   * is no caller-chosen id to check. That is what lets this be open to the
   * use case's own desk, not just PlatformAdmin/OrgAdmin.
   */
  app.get("/credential-use-cases/:key/credential-types/:name/certificate-preview", {
    schema: S.previewStoredCertificate,
    ...authScoped("usecases:provision"),
  }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { key, name } = request.params as { key: string; name: string };
    const def = await deps.credentialUseCases.get(key);
    if (!def) return notFound(reply, "credential use case not found");
    const spec = def.credentialTypes.find((t) => t.name === name);
    if (!spec) return notFound(reply, `credential type '${name}' not found on this use case`);

    // Same audience as issuing for this use case: PlatformAdmin always, the
    // owning OrgAdmin, or a desk operator scoped to THIS exact useCaseKey.
    const isPlatformAdmin = claims.role === "PlatformAdmin";
    const scopedOperator = (claims.role === "UseCaseAdmin" || claims.role === "Issuer") && claims.useCaseKey === key;
    if (!isPlatformAdmin && !scopedOperator) {
      const ownsIt = claims.role === "OrgAdmin" && !!claims.orgId &&
        (def.ownerOrgId === claims.orgId || issuerBindingAllows(def.issuer, { callerOrgId: claims.orgId, isPlatformAdmin: false }));
      if (!ownsIt) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "only this use case's desk, or a Platform/Org Admin, may preview its certificate design" });
      }
    }

    const pdf = await renderSampleCertificatePdf(spec, undefined, request.log);
    return reply
      .header("content-type", "application/pdf")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", 'inline; filename="certificate-preview.pdf"')
      .send(pdf);
  });


  /**
   * The credential use case a caller may DESIGN CERTIFICATES for, or null when
   * it has already been refused (this helper replies, so a caller that forgets
   * to act on the null cannot leak a second reply).
   *
   * TWO CHECKS, AND EACH ONE HAS BEEN THE MISSING ONE SOMEWHERE IN THIS FILE.
   *
   * 1. THE ROLE. `authScoped` composes `requireScope`, which short-circuits on
   *    `if (!key) return` — scopes are a property of API KEYS, so a human JWT
   *    session passes it unconditionally. Without an explicit role predicate
   *    these routes would be open to every authenticated user, which is exactly
   *    what the EN-F final review proved on `preview-certificate` by walking a
   *    seeded tokenization Buyer through it.
   *
   * 2. THE OWNER, guarded on `claims.orgId` FIRST. A legacy or platform-owned
   *    record carries `ownerOrgId: null` and a caller without an org carries
   *    `orgId: undefined`/`null`; written as a bare `===` those two answer
   *    "owned by me" for a use case nobody owns. Null-as-allow is the shape
   *    EN-B and EN-F each produced once, so the emptiness check comes
   *    before the comparison rather than being implied by it.
   */
  async function ownedCredentialUseCase(
    request: FastifyRequest, reply: FastifyReply, key: string,
  ): Promise<CredentialUseCaseDefinition | null> {
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin" && claims.role !== "OrgAdmin") {
      await reply.code(403).send({ error: "FORBIDDEN", message: "only a platform admin or org admin may design certificates" });
      return null;
    }
    const existing = await deps.credentialUseCases.get(key);
    if (!existing) { notFound(reply, "credential use case not found"); return null; }
    if (claims.role !== "PlatformAdmin") {
      const orgId = typeof claims.orgId === "string" ? claims.orgId.trim() : "";
      if (!orgId || existing.ownerOrgId !== orgId) {
        await reply.code(403).send({ error: "FORBIDDEN", message: `credential use case '${key}' is owned by another organization` });
        return null;
      }
    }
    return existing;
  }


  /**
   * EN-F follow-up: THE ORG'S OWN DOOR ONTO ITS OWN CERTIFICATE DESIGN.
   *
   * EN-F shipped the designer and left `background` writable only through
   * `POST`/`PATCH /credential-use-cases`, both PlatformAdmin-only — while the
   * org self-service path (`provision`) instantiates a template, which drops
   * artwork on purpose. So "let an issuing organization upload their own
   * certificate artwork" was delivered as "the platform operator does it for
   * them". This is the missing door, and it is deliberately NOT the definition
   * PATCH opened up: issuer binding, holder policy and claim schemas stay
   * platform-governed.
   *
   * THE DEFINITION WRITTEN IS THE STORED ONE. Only
   * `credentialTypes[i].certificate.{background,placements}` is taken from the
   * body; `key`, `ownerOrgId` and every other field are read back from
   * storage, so an extra field in the request is inert rather than trusted.
   *
   * Absent means UNCHANGED and explicit means CLEAR — `background: null` drops
   * the artwork (reverting to the built-in layout) and `placements: []` empties
   * the layout. Without the distinction there is no way to remove artwork here,
   * and reverting is a thing an org legitimately wants.
   */
  app.patch("/credential-use-cases/:key/certificate", { schema: S.updateCertificateDesign, ...authScoped("usecases:provision") }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const existing = await ownedCredentialUseCase(request, reply, key);
    if (!existing) return reply;
    const b = request.body as {
      credentialType: string;
      background?: { documentId: string; sha256?: string } | null;
      placements?: unknown;
    };
    const index = existing.credentialTypes.findIndex((t) => t.name === b.credentialType);
    if (index < 0) return notFound(reply, `unknown credential type '${b.credentialType}' in use case '${key}'`);
    const type = existing.credentialTypes[index] as CredentialTypeSpec;

    if (b.placements !== undefined) {
      // The same validator both existing doors call, so a design that saves
      // here cannot be one the definition PATCH would have refused.
      try {
        validateCertificatePlacements(b.placements, Object.keys(type.claimSchema.properties ?? {}), type.name);
      } catch (err) {
        return reply.code(400).send({ error: "INVALID_CERTIFICATE_PLACEMENT", message: (err as Error).message });
      }
    }
    if (b.background) {
      // Owned by THE USE CASE'S org, not by the caller's — a PlatformAdmin
      // acting for an org has no `orgId` of their own, and the artwork belongs
      // to the programme either way. `bypass` is theirs because they can
      // already read every document through `GET /documents/:id`.
      const problem = await checkBackgroundDocument(b.background, {
        requirePin: true,
        owner: { orgId: existing.ownerOrgId, bypass: (request.user as TokenClaims).role === "PlatformAdmin" },
      });
      if (problem) return reply.code(400).send(problem);
    }

    // `enabled` is preserved when a block exists and is NEVER toggled here.
    //
    // With no block at all, one is created only when the caller ASKS, with
    // `enabled: true`. The first version created one implicitly, on the
    // reasoning that an OrgAdmin has no other way to switch certificates on and
    // refusing would rebuild the dead end this route exists to remove. What that
    // reasoning missed is the OTHER end: `GET /credentials/{id}/certificate.pdf`
    // is PUBLIC and UNAUTHENTICATED, and it answers 404 until
    // `certificate.enabled` is true. So designing a layout for a type that had
    // no certificate block silently turned every already-issued credential of
    // that type into a downloadable PDF of its subject's claims — proved by
    // execution: 404 before, 200 with the claims after, no one having asked for
    // publication. Switching that on is a decision, so it must be written down.
    const current = type.certificate;
    if (!current && (request.body as { enabled?: unknown }).enabled !== true) {
      return reply.code(400).send({
        error: "CERTIFICATE_NOT_ENABLED",
        message: `credential type '${type.name}' has no certificate configured, and enabling one publishes a PUBLIC, unauthenticated PDF of every already-issued credential's claims at /credentials/{id}/certificate.pdf. Send 'enabled: true' to confirm that is intended.`,
      });
    }
    const certificate = {
      ...(current ?? { enabled: true }),
      ...(b.background === undefined ? {} : b.background === null ? { background: undefined } : { background: b.background }),
      ...(b.placements === undefined ? {} : { placements: b.placements as CertificateFieldPlacement[] }),
    };
    if (certificate.background === undefined) delete (certificate as { background?: unknown }).background;

    const credentialTypes = existing.credentialTypes.map((t, i) => (i === index ? { ...t, certificate } : t));
    const def: CredentialUseCaseDefinition = { ...existing, credentialTypes };
    // The second door, unchanged: a narrow route that skipped the whole-
    // definition validator would be a cheaper way into the store than the front
    // one. Defence in depth today — everything this route can change is already
    // checked above — so no test pins it, and that is deliberate rather than a
    // coverage gap. It earns its place the first time a stored definition is
    // legacy-shaped.
    const known = await referencedOrgs(def);
    try {
      validateCredentialUseCase(def, { orgExists: (id) => known.has(id) });
    } catch (err) {
      return reply.code(400).send({ error: "INVALID_CREDENTIAL_USECASE", message: (err as Error).message });
    }
    // No capability check: that gate exists for BINDINGS (issuer, verifier,
    // owner domain), and this route changes none of them. The envelope was
    // already satisfied when the use case was created.
    const updated = await deps.credentialUseCases.update(key, def);
    await deps.audit.append({
      actorId: (request.user as TokenClaims).id,
      action: "credential-usecase-updated" as LifecycleAction,
      payload: { key, credentialType: type.name, certificateDesign: true },
    });
    return reply.code(200).send(updated);
  });


  /**
   * ARTWORK UPLOAD, SCOPED BY THE USE CASE IT IS FOR.
   *
   * `RbacPolicy` grants `OrgAdmin` exactly one action — `read` — so
   * `POST /documents` (gated on `issue`) and `GET /documents/:id` (gated on
   * `canReadDoc`) are both closed to the very role this feature is for.
   * Organizations reach the store today only through
   * `POST /orgs/register/documents`, which is public because it runs before the
   * org exists.
   *
   * WIDENING `canReadDoc` WAS THE WRONG FIX: it is what keeps stored off-ledger
   * invoice evidence away from tenants. So the capability is bounded by the use
   * case instead — you may upload artwork for a programme you own, and the
   * upload allowlist here is narrower than the store's (images only), because
   * this door exists for artwork and nothing else.
   */
  app.post("/credential-use-cases/:key/certificate/artwork", {
    schema: S.uploadCertificateArtwork,
    bodyLimit: DOC_UPLOAD_BODY_LIMIT,
    ...authScoped("usecases:provision"),
  }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const existing = await ownedCredentialUseCase(request, reply, key);
    if (!existing) return reply;
    const b = request.body as { contentType: string; dataBase64: string };
    // The RENDERABLE set, not `image/*`: pdfkit draws PNG and JPEG only, and
    // accepting a webp here would store artwork that silently never prints.
    if (!b?.contentType || !isRenderableArtwork(b.contentType)) {
      return reply.code(415).send({ error: "UNSUPPORTED_DOCUMENT_TYPE", message: "certificate artwork must be image/png or image/jpeg" });
    }
    // Reuses the shared storer, so size caps, the empty-body refusal and the
    // store's own allowlist cannot drift from the general upload route.
    //
    // OWNED BY THE PROGRAMME'S ORG, not by the uploader: a PlatformAdmin
    // uploading artwork for a tenant is acting for that tenant, and the design
    // route checks the same org, so the two agree by construction.
    const doc = await storeUploadedDocument(deps.documents, b, existing.ownerOrgId ?? null, null, (request.user as TokenClaims).id);
    return reply.code(201).send({ documentId: doc.id, sha256: doc.sha256, size: doc.size });
  });


  /**
   * The artwork back, for the designer canvas when a saved design is reopened.
   *
   * IT ACCEPTS NO DOCUMENT ID. The caller names a credential type, and what is
   * served is whatever that type's `background` currently points at — so the
   * use case you own is the whole capability, and a stored document that no
   * design references is unreachable through this route. Handing it an id
   * instead would rebuild, behind an ownership check, the same
   * "any id, no ownership" read that made `background.documentId` worth pinning.
   *
   * A just-uploaded file needs no round trip: the browser still holds the
   * `File` and can render it from a local object URL.
   */
  app.get("/credential-use-cases/:key/certificate/artwork", { schema: S.getCertificateArtwork, ...authScoped("usecases:provision") }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const existing = await ownedCredentialUseCase(request, reply, key);
    if (!existing) return reply;
    const typeName = (request.query as { credentialType?: string }).credentialType ?? "";
    const type = existing.credentialTypes.find((t) => t.name === typeName);
    if (!type) return notFound(reply, `unknown credential type '${typeName}' in use case '${key}'`);
    const documentId = type.certificate?.background?.documentId;
    if (!documentId) return notFound(reply, `credential type '${typeName}' has no certificate artwork`);
    const doc = await deps.documents.get(documentId).catch(() => null);
    if (!doc) return notFound(reply, "certificate artwork document not found");
    // Same headers `GET /documents/:id` sends: pin the stored (allowlisted)
    // type and forbid sniffing, so stored bytes can never execute as the API
    // origin. Served INLINE rather than as an attachment — this one is meant to
    // be rendered into an <img>.
    return reply
      .header("content-type", doc.contentType)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `inline; filename="artwork-${documentId}"`)
      .send(doc.bytes);
  });


  // Validate + create a credential use case from a fully-bound definition, reusing
  // the SAME checks as POST /credential-use-cases (referenced-org existence,
  // cross-type KEY_TAKEN guard, and — same order as that route —
  // `checkDefinitionBackgrounds`). Throws coded errors the provisioner maps to
  // HTTP — the check belongs here, once, rather than repeated at every caller
  // that reaches this function.
  async function createCredentialUseCaseFromDef(def: CredentialUseCaseDefinition, ownerOrgId: string | null, actorId: string) {
    if (await namespaceHolding(deps, def.key)) {
      throw coded(409, "KEY_TAKEN", `use-case key '${def.key}' already exists`);
    }
    const known = await referencedOrgs(def);
    try {
      validateCredentialUseCase(def, { orgExists: (id) => known.has(id) });
    } catch (err) {
      throw coded(400, "INVALID_CREDENTIAL_USECASE", (err as Error).message);
    }
    const badBackground = await checkDefinitionBackgrounds(def);
    if (badBackground) throw coded(400, badBackground.error, badBackground.message);
    const violation = await credentialUseCaseCapabilityViolation({ ...def, ownerOrgId }, known);
    if (violation) throw coded(403, "ORG_CAPABILITY_MISSING", `organization '${violation.org.name}' (${violation.org.id}) does not have the '${violation.missing}' capability`);
    const created = await deps.credentialUseCases.create({ ...def, ownerOrgId });
    await deps.audit.append({ actorId, action: "credential-usecase-created" as LifecycleAction, payload: { key: def.key } });
    return created;
  }


  // Create ONE scoped desk user (ID-F model: useCaseKey = the credential use
  // case key, role ∈ {Issuer,Holder,Verifier}, identity domain). Provisioning is
  // a single PlatformAdmin/OrgAdmin action, so rather than the two-party
  // maker-checker HTTP dance we create the onboard-user proposal and immediately
  // run its executor in-process (auto-approve): the underlying user-mint logic —
  // password hash (done here), custodial DID mint, user row — is REUSED verbatim
  // from onboardUserKind.execute, never duplicated. The plaintext password is
  // generated here and returned to the caller exactly once.
  async function provisionDeskUser(
    email: string, role: Role, useCaseKey: string, actor: { id: string; role: Role; email: string }, log: FastifyRequest["log"],
  ): Promise<{ email: string; password: string; role: Role }> {
    const password = randomUUID().replace(/-/g, ""); // 32-hex one-time credential
    const proposal = await deps.proposals.create({
      useCaseKey, orgId: null, assetId: null, kind: "onboard-user",
      payload: {
        email, passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role, useCaseKey, walletAddress: null, kyc: null,
        // The plaintext password is already in hand here (generated just above)
        // and this function sends its own welcomeCredentialsEmail right after
        // execute() returns — skip onboardSingle's set-password-link email so
        // the desk user isn't sent two contradictory welcome emails.
        skipWelcomeEmail: true,
      },
      proposerId: actor.id, proposerLabel: actor.email, required: 1,
    });
    try {
      await proposalKind("onboard-user").execute({ deps, log }, { id: actor.id, role: actor.role }, proposal);
    } catch (err) {
      // A mid-provision executor failure must not strand a `pending` proposal in
      // the store (it would otherwise be re-approvable out of band). Mark it
      // failed, then re-throw so the caller sees the real error.
      await deps.proposals.setStatus(proposal.id, "failed", (err as Error).message).catch(() => undefined);
      throw err;
    }
    await deps.proposals.setStatus(proposal.id, "executed");
    const welcome = welcomeCredentialsEmail({ email, password, loginUrl: `${deps.publicWebUrl}/login` });
    await deps.mail.send(email, welcome.subject, welcome.text, welcome.html).catch((err) => log.error({ err }, "[mail] welcome send failed"));
    return { email, password, role };
  }


  // One-step enterprise provisioning from a template (ID-G G4): ensure the issuer
  // org exists → instantiate the credential use case bound to that org → optionally
  // create scoped Issuer/Holder/Verifier desk users. Idempotent. The bound issuer
  // org stays the VC signer — provisioning only REBINDS def.issuer to the org.
  app.post("/credential-use-cases/provision", { schema: S.provisionUseCase, ...authScoped("usecases:provision") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin" && claims.role !== "OrgAdmin") {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only a platform admin or org admin may provision a credential use case" });
    }
    if (!deps.didMasterConfigured && deps.isProduction) return reply.code(503).send({ error: "DID_KEYSTORE_UNCONFIGURED", message: "DID_MASTER_KEY must be set to provision" });
    const b = request.body as {
      templateKey: string;
      params?: Record<string, unknown>;
      provisioning?: {
        issuerOrgName?: string; issuerOrgType?: OrgType;
        createDeskUsers?: boolean; deskEmailDomain?: string; failIfExists?: boolean;
      };
    };
    const params = b.params ?? {};
    const prov = b.provisioning ?? {};
    // A MACHINE PRINCIPAL MUST NEVER ASK FOR DESK USERS. Step 5 below creates
    // three brand-new HUMAN accounts and returns their SERVER-GENERATED plaintext
    // passwords in the response body. Refused HERE, before any org or use case is
    // created, so a rejected call provisions nothing at all.
    //
    // WHY THIS DIFFERS FROM POST /orgs/:id/users, which a key holding
    // `users:onboard` MAY use to create a human with a password:
    //   1. THE PASSWORD'S ORIGIN. There the integrator SUPPLIES a password it
    //      already chose for a human it already manages — it learns nothing it
    //      did not bring. Here the SERVER mints credentials and discloses them to
    //      whoever called; the key ends up holding secrets it never chose and
    //      would otherwise never see. That is credential disclosure, not
    //      delegated account creation.
    //   2. INTENT. There, creating an account IS the request, behind a scope
    //      whose name says exactly that, granted deliberately. Here three staffed
    //      desks arrive as a SIDE EFFECT of asking for a use case — a key granted
    //      `usecases:provision` is asking for configuration, and its org never
    //      agreed to let it mint people.
    // Both routes still audit, and both bind the new member to the org; the
    // difference is who chose the secret and whether the org consented to it.
    if (prov.createDeskUsers && machinePrincipal(request)) {
      return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key cannot create desk users; provision them from a human session" });
    }

    // 1. Resolve the template (built-in catalog first, then saved custom).
    const t = TEMPLATE_CATALOG.find((x) => x.key === b.templateKey) ?? (await deps.credentialTemplates.get(b.templateKey));
    if (!t) return notFound(reply, `template '${b.templateKey}' not found`);

    // 2. Instantiate the definition (throws INVALID_TEMPLATE_PARAMS with problems).
    let def: CredentialUseCaseDefinition;
    try {
      def = instantiateTemplate(t, params);
    } catch (e) {
      if (e instanceof PolicyError && e.code === "INVALID_TEMPLATE_PARAMS") {
        return reply.code(400).send({ error: e.code, message: e.message, problems: (e.details as { problems?: string[] })?.problems ?? [] });
      }
      throw e;
    }
    // THE TEMPLATE DOOR REFUSES a brand-logo `logoDocumentId` at save time now,
    // but a template saved BEFORE that refusal existed can still carry one —
    // this route reads templates straight from storage, with no revalidation —
    // and `instantiateTemplate` copies `logoDocumentId` verbatim onto `def`
    // (unlike `background`, which it always strips; see the comment there).
    // So the template door alone does not close this path; checked here too,
    // and checked BEFORE any org is created or use case persisted, so a
    // refused provision leaves nothing behind — the same reasoning the
    // `createDeskUsers` + machine-principal refusal above already applies.
    const badBackground = await checkDefinitionBackgrounds(def);
    if (badBackground) return reply.code(400).send(badBackground);

    // 3. Ensure the issuer org, then REBIND the definition's issuer to it.
    const orgName = prov.issuerOrgName ?? (params.issuerOrgName as string | undefined);
    if (!orgName) return reply.code(400).send({ error: "MISSING_ISSUER_ORG", message: "issuerOrgName is required (in params or provisioning)" });
    let org: OrganizationRecord;
    if (claims.role === "OrgAdmin") {
      // An OrgAdmin may only provision for their OWN org — never create a new one
      // (org creation is PlatformAdmin-only) and never bind to a foreign org.
      const own = claims.orgId ? await deps.organizations.get(claims.orgId) : null;
      if (!own || own.name !== orgName) {
        return reply.code(403).send({ error: "FORBIDDEN", message: "an org admin may only provision for their own organization" });
      }
      org = own;
    } else {
      try {
        org = await ensureOrg(orgName, prov.issuerOrgType ?? "verifier", { actorId: claims.id });
      } catch (err) {
        if (err instanceof CodedError && err.code === "REGISTRY_UNAVAILABLE") return reply.code(502).send({ error: err.code, message: err.message });
        throw err;
      }
    }
    def = { ...def, issuer: { kind: "org", orgId: org.id } };

    // EN-A: provisioning makes `org` BOTH the owner and the bound issuer of an
    // IDENTITY use case — its envelope needs the Issuer role and the identity
    // domain (checked in that order, matching credentialUseCaseCapabilityViolation,
    // so an org missing both always sees the same capability named). Checked here
    // (org record already in hand) so the rebind path below is covered too, not
    // just fresh creates.
    if (!orgRoleEnabled(org.capabilities, "Issuer")) return orgCapabilityMissing(reply, org, "Issuer");
    if (!orgDomainEnabled(org.capabilities, "identity")) return orgCapabilityMissing(reply, org, "identity");

    // 4. Create the use case, or rebind an existing one (idempotent unless failIfExists).
    let useCase;
    let created = false;
    const existing = await deps.credentialUseCases.get(def.key);
    if (existing) {
      // A re-provision may only rebind a use case the caller legitimately owns:
      // a PlatformAdmin may re-provision any; an OrgAdmin only one already owned by
      // their org. Otherwise an OrgAdmin could HIJACK a foreign-owned use case via
      // a slug collision (def.key is a non-injective org-name slug) and become its
      // VC signer. A null ownerOrgId (e.g. a legacy platform-owned record) also
      // fails `!== org.id`, correctly 403ing any non-platform caller.
      if (claims.role !== "PlatformAdmin" && existing.ownerOrgId !== org.id) {
        return reply.code(403).send({ error: "FORBIDDEN", message: `credential use-case '${def.key}' is owned by another organization` });
      }
      if (prov.failIfExists) return reply.code(409).send({ error: "KEY_TAKEN", message: `credential use-case '${def.key}' already exists` });
      // Rebind the issuer (and owner) to the resolved org — the rest of the def is
      // deterministic from the template + params, so a re-provision is a no-op.
      try {
        validateCredentialUseCase(def, { orgExists: (id) => id === org.id });
      } catch (err) {
        return reply.code(400).send({ error: "INVALID_CREDENTIAL_USECASE", message: (err as Error).message });
      }
      useCase = await deps.credentialUseCases.update(def.key, { ...def, ownerOrgId: org.id });
    } else {
      try {
        useCase = await createCredentialUseCaseFromDef(def, org.id, claims.id);
        created = true;
      } catch (err) {
        if (err instanceof CodedError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        throw err;
      }
    }

    // 5. Optionally create scoped desk users (idempotent: pre-existing emails are
    // skipped and omitted from the response — only NEWLY-created users carry a
    // one-time plaintext password back).
    const deskUsers: Array<{ email: string; password: string; role: Role }> = [];
    if (prov.createDeskUsers) {
      const domain = prov.deskEmailDomain;
      if (!domain) return reply.code(400).send({ error: "MISSING_DESK_EMAIL_DOMAIN", message: "deskEmailDomain is required when createDeskUsers is true" });
      for (const role of ["Issuer", "Holder", "Verifier"] as const) {
        const email = `${role.toLowerCase()}@${domain}`;
        if (await deps.users.findByEmail(email)) continue; // idempotent: already provisioned
        deskUsers.push(await provisionDeskUser(email, role, def.key, { id: claims.id, role: claims.role, email: claims.email }, request.log));
      }
    }

    return reply.code(created ? 201 : 200).send({
      org: { id: org.id, name: org.name, did: org.did },
      useCase,
      deskUsers,
    });
  });


  // A shared issuer-authorization helper: resolve the bound issuer org + confirm
  // the caller may act as it. Returns { issuerOrg } or sends an error + null.
  //
  // Two independent ways in: (1) the classic org/platform path — PlatformAdmin,
  // or the OrgAdmin of the use case's bound issuer org, via issuerBindingAllows;
  // (2) a credential-use-case-SCOPED desk operator (UseCaseAdmin/Issuer whose
  // claims.useCaseKey matches this use case's key) — they operate issuance for
  // the use case WITHOUT being the cryptographic issuer; the VC is still signed
  // by the use case's bound issuer org (issuerOrg resolution below is unchanged).
  async function resolveIssuer(request: FastifyRequest, reply: FastifyReply, def: Awaited<ReturnType<typeof deps.credentialUseCases.get>>, key: string) {
    const claims = request.user as TokenClaims;
    const isPlatformAdmin = claims.role === "PlatformAdmin";
    const scopedOperator = (claims.role === "UseCaseAdmin" || claims.role === "Issuer") && claims.useCaseKey === key;
    // EN-B use-time binding re-check, FOR MACHINE PRINCIPALS ONLY.
    // A scoped desk operator is authorized by role + useCaseKey alone, so EN-A
    // deliberately left an already-minted desk working after its use case's
    // issuer binding was later edited (recorded non-retroactivity: an
    // interactive operator would otherwise be locked out mid-session with no
    // explanation, and a human is watched by their org). A KEY runs unattended
    // for months, so the same staleness becomes an org still issuing through a
    // binding that was moved away from it. Hence: re-verify against the CURRENT
    // config when the caller is a key, and leave human sessions exactly as they
    // were. An org-less desk operator has no binding to re-check and is skipped.
    if (scopedOperator && machinePrincipal(request) && claims.orgId) {
      const bound = def!.ownerOrgId === claims.orgId
        || issuerBindingAllows(def!.issuer, { callerOrgId: claims.orgId, isPlatformAdmin });
      if (!bound) {
        reply.code(403).send({ error: "ISSUER_NOT_PERMITTED", message: "your organization is no longer bound to this use case's issuer" });
        return null;
      }
    }
    if (!scopedOperator) {
      if (claims.role !== "PlatformAdmin" && claims.role !== "OrgAdmin") {
        reply.code(403).send({ error: "FORBIDDEN", message: "only a Platform Admin or an Org Admin may issue credentials" });
        return null;
      }
      if (!issuerBindingAllows(def!.issuer, { callerOrgId: claims.orgId ?? null, isPlatformAdmin })) {
        reply.code(403).send({ error: "ISSUER_NOT_PERMITTED", message: "you may not issue for this use case's configured issuer" });
        return null;
      }
    }
    const issuerOrg = def!.issuer.kind === "platform"
      ? await deps.organizations.findByName(PLATFORM_ORG_NAME)
      : await deps.organizations.get(def!.issuer.orgId);
    if (!issuerOrg) {
      reply.code(400).send({ error: "ISSUER_ORG_MISSING", message: "the configured issuer organization does not exist" });
      return null;
    }
    // EN-A defense in depth: the org binding may predate a capability
    // tightening, so re-check the envelope at issue time, every time.
    // (Platform-issuer use cases are exempt — the platform org is the signer.)
    if (def!.issuer.kind === "org" && !orgRoleEnabled(issuerOrg.capabilities, "Issuer")) {
      orgCapabilityMissing(reply, issuerOrg, "Issuer");
      return null;
    }
    return { issuerOrg };
  }


  app.get("/credential-use-cases/:key/eligible-holders", { schema: S.eligibleHolders, ...authScoped("users:read") }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const def = await deps.credentialUseCases.get(key);
    if (!def) return notFound(reply, `credential use case '${key}' not found`);
    const resolved = await resolveIssuer(request, reply, def, key); // same gate as issuing
    if (!resolved) return;
    const out: { kind: "user" | "org"; id: string; label: string; did: string; subLabel: string | null }[] = [];
    // Scoped to holders onboarded UNDER THIS use case (u.useCaseKey === key) —
    // "any-onboarded" means "any org type is fine", never "show every DID on the
    // platform". An org-kind holder is a platform-wide entity, not onboarded per
    // use case, so the org loop below is unaffected and keeps its own scoping via
    // holderPolicyAllows.
    const users = await deps.users.list(key);
    for (const u of users) {
      if (!u.did) continue;
      const org = u.orgId ? await deps.organizations.get(u.orgId) : null;
      if (holderPolicyAllows(def.holderPolicy, org ? { id: org.id, orgType: org.orgType } : null)) {
        out.push({ kind: "user", id: u.id, label: u.email, did: u.did, subLabel: org?.name ?? null });
      }
    }
    const orgs = await deps.organizations.list();
    for (const o of orgs) {
      if (!o.did) continue;
      // EN-A: the picker must not offer an org that issuance would then 403 —
      // holding a credential needs the Holder role (same check as the
      // subjectOrgId branch below). A legacy null envelope passes.
      if (!orgRoleEnabled(o.capabilities, "Holder")) continue;
      if (holderPolicyAllows(def.holderPolicy, { id: o.id, orgType: o.orgType })) {
        out.push({ kind: "org", id: o.id, label: o.name, did: o.did, subLabel: o.orgType });
      }
    }
    return out;
  });


  app.post("/credential-use-cases/:key/credentials", { schema: S.issueUsecaseCredential, ...authScoped("credentials:issue") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { key } = request.params as { key: string };
    const b = request.body as { credentialType: string; subjectUserId?: string; subjectOrgId?: string; claims: Record<string, unknown> };
    const def = await deps.credentialUseCases.get(key);
    if (!def) return notFound(reply, `credential use case '${key}' not found`);
    const resolved = await resolveIssuer(request, reply, def, key);
    if (!resolved) return;
    const { issuerOrg } = resolved;

    let spec;
    try { spec = credentialUseCaseType(def, b.credentialType); }
    catch (err) { return reply.code(400).send({ error: "UNKNOWN_CREDENTIAL_TYPE", message: (err as Error).message }); }

    // Subject is EXACTLY ONE of a user or an org.
    if ((!b.subjectUserId) === (!b.subjectOrgId)) {
      return reply.code(400).send({ error: "SUBJECT_REQUIRED", message: "provide exactly one of subjectUserId or subjectOrgId" });
    }
    let subjectDid: string;
    let holderOrg: { id: string; orgType: OrgType } | null;
    const subjectRef: { subjectUserId?: string; subjectOrgId?: string } = {};
    if (b.subjectUserId) {
      const subject = await deps.users.findById(b.subjectUserId);
      if (!subject) return notFound(reply, "subject user not found");
      if (!subject.did) return reply.code(400).send({ error: "SUBJECT_HAS_NO_DID", message: "the subject has no decentralized identifier" });
      const org = subject.orgId ? await deps.organizations.get(subject.orgId) : null;
      subjectDid = subject.did; holderOrg = org ? { id: org.id, orgType: org.orgType } : null; subjectRef.subjectUserId = subject.id;
    } else {
      const org = await deps.organizations.get(b.subjectOrgId!);
      if (!org) return notFound(reply, "subject organization not found");
      if (!org.did) return reply.code(400).send({ error: "SUBJECT_HAS_NO_DID", message: "the subject organization has no DID" });
      // EN-A: an enveloped org may only HOLD credentials with the Holder role.
      if (!orgRoleEnabled(org.capabilities, "Holder")) return orgCapabilityMissing(reply, org, "Holder");
      subjectDid = org.did; holderOrg = { id: org.id, orgType: org.orgType }; subjectRef.subjectOrgId = org.id;
    }
    if (!holderPolicyAllows(def.holderPolicy, holderOrg)) {
      return reply.code(403).send({ error: "HOLDER_NOT_ELIGIBLE", message: "the subject is not an eligible holder for this use case" });
    }
    validateMetadata(b.claims, spec.claimSchema); // throws INVALID_METADATA → 400

    const proposal = await deps.proposals.create({
      useCaseKey: null, orgId: issuerOrg.id, assetId: null, kind: "issue-usecase-credential",
      payload: { credentialUseCaseKey: key, credentialType: spec.name, subjectDid, ...subjectRef, claims: b.claims, issuerOrgId: issuerOrg.id },
      proposerId: claims.id, proposerLabel: claims.email, required: spec.requiredApprovals,
    });
    return reply.code(202).send({ proposal: proposalView(proposal) });
  });


  // Batch credential issuance from parsed CSV rows: ONE maker-checker proposal
  // covering every row. Draft-time validation is all-or-nothing (any row
  // problem ⇒ 400, no proposal at all); execution is row-independent (one
  // row's failure never aborts the others — see issueUsecaseCredentialBatchKind).
  // Subjects are addressed by EMAIL (not subjectUserId/subjectOrgId as the
  // single route allows) and are resolved at EXECUTION time, so a not-yet-
  // onboarded holder fails only its own row instead of the whole batch.
  app.post("/credential-use-cases/:key/credentials/batch", { schema: S.issueUsecaseCredentialsBatch, ...authScoped("credentials:issue") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { key } = request.params as { key: string };
    const b = request.body as { credentialType: string; rows: { subjectEmail: string; claims: Record<string, unknown> }[] };
    const def = await deps.credentialUseCases.get(key);
    if (!def) return notFound(reply, `credential use case '${key}' not found`);
    const resolved = await resolveIssuer(request, reply, def, key); // same gate as the single route
    if (!resolved) return;
    const { issuerOrg } = resolved;

    let spec;
    try { spec = credentialUseCaseType(def, b.credentialType); }
    catch (err) { return reply.code(400).send({ error: "UNKNOWN_CREDENTIAL_TYPE", message: (err as Error).message }); }

    const problems: { index: number; error: string }[] = [];
    for (let i = 0; i < b.rows.length; i++) {
      const row = b.rows[i]!;
      if (!row.subjectEmail?.includes("@")) { problems.push({ index: i, error: "invalid subjectEmail" }); continue; }
      try { validateMetadata(row.claims, spec.claimSchema); }
      catch (err) { problems.push({ index: i, error: (err as Error).message }); }
    }
    if (problems.length) {
      return reply.code(400).send({ error: "BATCH_INVALID", message: `${problems.length} row(s) failed validation`, problems });
    }

    const proposal = await deps.proposals.create({
      useCaseKey: null, orgId: issuerOrg.id, assetId: null, kind: "issue-usecase-credential-batch",
      payload: { useCaseKey: key, credentialType: spec.name, issuerOrgId: issuerOrg.id, rows: b.rows },
      proposerId: claims.id, proposerLabel: claims.email, required: spec.requiredApprovals,
    });
    await deps.audit.append({
      actorId: claims.id, action: "credential-batch-proposed" as LifecycleAction,
      payload: { proposalId: proposal.id, useCaseKey: key, credentialType: spec.name, total: b.rows.length },
    });
    return reply.code(202).send({ proposal: proposalView(proposal) });
  });


  // ID-N: scoped identity operations dashboard. Read-only aggregation — scope is
  // resolved here, all counting lives in the pure fold. No chain reads: revocation
  // comes from the DB flag exactly like every list projection.
  app.get("/identity/dashboard", { schema: S.identityDashboard, ...authScoped("credentials:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const all = await deps.credentialUseCases.list();
    let scoped: typeof all;
    if (claims.role === "PlatformAdmin") {
      scoped = all;
    } else if (claims.role === "OrgAdmin" && claims.orgId) {
      scoped = all.filter((u) => u.issuer.kind === "org" && u.issuer.orgId === claims.orgId);
    } else if (
      (claims.role === "UseCaseAdmin" || claims.role === "Issuer") &&
      claims.useCaseKey && all.some((u) => u.key === claims.useCaseKey)
    ) {
      scoped = all.filter((u) => u.key === claims.useCaseKey);
    } else {
      return reply.code(403).send({ error: "FORBIDDEN", message: "no identity dashboard for this role" });
    }

    const keys = new Set(scoped.map((u) => u.key));
    const credentials = (await deps.credentials.list())
      .filter((c) => c.credentialUseCaseKey !== null && keys.has(c.credentialUseCaseKey));
    const verifications = (await deps.verificationRequests.list())
      .filter((v) => v.credentialUseCaseKey !== null && keys.has(v.credentialUseCaseKey));

    const holderLabels = new Map<string, string>();
    for (const u of await deps.users.list()) if (u.did) holderLabels.set(u.did, u.email);
    for (const o of await deps.organizations.list()) if (o.did) holderLabels.set(o.did, o.name);

    return computeIdentityDashboard({
      useCases: scoped, credentials, verifications, holderLabels,
      now: new Date().toISOString(), days: 30,
    });
  });


  app.post("/users/:id/revoke-identity", { schema: S.revokeUserIdentity, ...authScoped("users:onboard") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason: string };
    const target = await deps.users.findById(id);
    if (!target) return notFound(reply, "user not found");
    if (!canAdministerUser(claims, target)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to revoke that user's identity" });
    // null useCaseKey → scans all pending; the userId match below still scopes it.
    const pending = await deps.proposals.list(target.useCaseKey ?? undefined, "pending");
    if (pending.some((p) => p.kind === "revoke-user-identity" && (p.payload as { userId: string }).userId === id)) {
      return reply.code(409).send({ error: "ALREADY_PENDING", message: "a revoke proposal for this user is already pending" });
    }
    const proposal = await deps.proposals.create({
      useCaseKey: target.useCaseKey, orgId: null, assetId: null, kind: "revoke-user-identity",
      payload: { userId: id, reason },
      proposerId: claims.id, proposerLabel: claims.email, required: 1,
    });
    return reply.code(202).send({ proposal: proposalView(proposal) });
  });


  // PUBLIC W3C DID resolution — a DID document is public key material; same
  // public posture as /credentials/:id/status. Third-party verifiers resolve
  // an issuer DID against the on-chain DidRegistry with no platform account.
  app.get("/dids/:did/resolve", { schema: S.didResolve }, async (request) => {
    const { did } = request.params as { did: string };
    return resolveDid(did, {
      registry: deps.registry,
      onChainError: (err) => request.log.error({ err, did }, "on-chain DID registration read failed"),
    });
  });


  // GET /dids/:did/document, GET /me/credentials, and the three holder
  // accept/reject/request-changes routes live in shared.ts: route-domains.ts
  // classifies all of them "shared" so a tokenization console still answers
  // "My identity" for a roster member issue-kyc gave a DID to.


  // --- credentials ---------------------------------------------------------
  app.get("/credential-types", { schema: S.credentialTypes, ...auth }, async () =>
    Object.values(CREDENTIAL_TYPES).map((d) => ({
      type: d.type, description: d.description, allowedIssuerOrgTypes: d.allowedIssuerOrgTypes,
      requiredApprovals: d.requiredApprovals, validityDays: d.validityDays,
      selfIssuedOnly: !!d.selfIssuedOnly, claimSchema: d.claimSchema,
    })));


  app.post("/credentials/requests", { schema: S.requestCredential, ...authScoped("credentials:issue") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { type: string; subjectUserId: string; claims: Record<string, unknown>; issuerOrgId?: string };
    if (claims.role !== "PlatformAdmin" && claims.role !== "OrgAdmin") {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only a Platform Admin or an Org Admin may request credentials" });
    }
    // An OrgAdmin may only ever issue as their OWN org — any issuerOrgId in the
    // body is ignored, never honoured (it would be a privilege escalation).
    const issuerOrgId = claims.role === "OrgAdmin" ? claims.orgId : b.issuerOrgId;
    if (!issuerOrgId) return reply.code(400).send({ error: "ISSUER_ORG_REQUIRED", message: "issuerOrgId is required" });
    const org = await deps.organizations.get(issuerOrgId);
    if (!org) return notFound(reply, "issuing organization not found");

    const def = credentialTypeDef(b.type); // throws UNKNOWN_CREDENTIAL_TYPE → 400
    if (!def.allowedIssuerOrgTypes.includes(org.orgType)) {
      return reply.code(403).send({ error: "ISSUER_NOT_PERMITTED", message: `an org of type '${org.orgType}' may not issue '${def.type}'` });
    }
    // EN-A (ninth gate): closed-catalog issuance is an Issuer act like any
    // other. ROLE check only — the catalog predates the domain split and its
    // types (KYC, AccreditedInvestor, …) serve tokenization flows too, so no
    // domain is required. Null (legacy) envelopes pass untouched.
    if (!orgRoleEnabled(org.capabilities, "Issuer")) return orgCapabilityMissing(reply, org, "Issuer");
    const subject = await deps.users.findById(b.subjectUserId);
    if (!subject) return notFound(reply, "subject user not found");
    if (def.selfIssuedOnly && subject.orgId !== org.id) {
      return reply.code(403).send({ error: "SELF_ISSUED_ONLY", message: `'${def.type}' may only be issued to the issuing org's own members` });
    }
    if (!subject.did) return reply.code(400).send({ error: "SUBJECT_HAS_NO_DID", message: "the subject has no decentralized identifier" });
    validateMetadata(b.claims, def.claimSchema); // throws INVALID_METADATA → 400

    const proposal = await deps.proposals.create({
      useCaseKey: null, orgId: org.id, assetId: null, kind: "issue-credential",
      payload: { type: def.type, subjectDid: subject.did, subjectUserId: subject.id, claims: b.claims, issuerOrgId: org.id },
      proposerId: claims.id, proposerLabel: claims.email, required: def.requiredApprovals,
    });
    return reply.code(202).send({ proposal: proposalView(proposal) });
  });


  app.post("/credentials/:id/revoke", { schema: S.revokeCredential, ...authScoped("credentials:revoke") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason: string };
    const cred = await deps.credentials.get(id);
    if (!cred) return notFound(reply, "credential not found");
    if (cred.revoked) return reply.code(409).send({ error: "ALREADY_REVOKED", message: "credential is already revoked" });
    // Only the ISSUING org may revoke: find the org whose parent DID signed it.
    const issuer = await deps.organizations.findByDid(cred.issuerDid);
    if (!issuer) return notFound(reply, "issuing organization not found");
    // A credential-use-case-SCOPED desk operator (UseCaseAdmin/Issuer whose
    // claims.useCaseKey matches the credential's own use case) may also revoke,
    // without being the signing org — mirrors the issue-side scopedOperator gate.
    const scopedOperator = (claims.role === "UseCaseAdmin" || claims.role === "Issuer")
      && cred.credentialUseCaseKey !== null && claims.useCaseKey === cred.credentialUseCaseKey;
    if (!scopedOperator && !orgScoped(claims, issuer.id)) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only the issuing organization may revoke this credential" });
    }
    // Depth comes from the credential's OWN type — revoking an AuthorizedSignatory
    // costs the same approvals that issuing it did. A use-case credential resolves
    // against its use case; a closed-catalog credential against the catalog.
    let required = 1;
    if (cred.credentialUseCaseKey) {
      const uc = await deps.credentialUseCases.get(cred.credentialUseCaseKey);
      try {
        required = uc ? credentialUseCaseType(uc, cred.type).requiredApprovals : 1;
      } catch { required = 1; } // config drift (type removed/renamed) must not block revocation
    } else {
      required = credentialTypeDef(cred.type).requiredApprovals;
    }
    const proposal = await deps.proposals.create({
      useCaseKey: null, orgId: issuer.id, assetId: null, kind: "revoke-credential",
      payload: { credentialId: cred.id, reason },
      proposerId: claims.id, proposerLabel: claims.email, required,
    });
    return reply.code(202).send({ proposal: proposalView(proposal) });
  });


  // PUBLIC — a verifier holding only the VC must be able to resolve its status.
  // Returns revocation state ONLY: no claims, no holder, no VC.
  //
  // THREE-WAY resolution. The middle case is the one that matters:
  //   1. no registry             -> database answer, anchored: false
  //   2. registry AND exists     -> CHAIN answer, anchored: true
  //   3. registry but NOT exists -> the credential predates the registry (or its
  //      anchor never landed) -> database answer, anchored: false.
  // Case 3 must NEVER be read as "the chain says not-revoked": an absent record
  // is not a negative revocation. Doing so is exactly the fail-open bug this
  // whole sub-project exists to avoid.
  app.get("/credentials/:id/status", { schema: S.credentialStatus }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const cred = await deps.credentials.get(id);
    if (!cred) return notFound(reply, "credential not found");
    // acceptance is omitted for the untouched, born-accepted default (acceptanceAt
    // never set) so pre-acceptance-ceremony status responses stay byte-identical —
    // it only appears once a credential has actually gone through the ceremony
    // (born pending, or explicitly accepted/rejected/changes-requested).
    const fromDb = {
      id: cred.id, revoked: cred.revoked, revokedAt: cred.revokedAt, reason: cred.revokedReason,
      ...(cred.acceptance !== "accepted" || cred.acceptanceAt !== null ? { acceptance: cred.acceptance } : {}),
    };
    if (!deps.registry) return { ...fromDb, anchored: false, source: "database" };
    let onChain;
    try {
      onChain = await deps.registry.anchor.credentialStatusOf(deps.registry.vcRegistry, cred.id);
    } catch (err) {
      request.log.error({ err }, "on-chain status read failed");
      return { ...fromDb, anchored: false, source: "database" };
    }
    if (!onChain.exists) return { ...fromDb, anchored: false, source: "database" };
    // The tx pointers (ID-O) ride the CHAIN answer only: database-source
    // responses are shape-pinned byte-identical by pre-ID-O tests (and a
    // database fallback carrying chain tx hashes would be exactly the
    // dressed-up provenance those tests forbid).
    return {
      ...fromDb,
      revoked: onChain.revoked,
      revokedAt: onChain.revokedAt ? new Date(onChain.revokedAt * 1000).toISOString() : null,
      anchored: true,
      source: "chain",
      chainId: deps.registry.chainId,
      registry: deps.registry.vcRegistry,
      vcHash: onChain.vcHash,
      anchorTxHash: cred.anchorTxHash,
      anchorChainId: cred.anchorChainId,
      revokeTxHash: cred.revokeTxHash,
    };
  });


  // PUBLIC capability URL, same posture as /status: a QR a verifier's phone
  // camera can scan with no account, encoding the public verification portal's
  // link — never the certificate.pdf/status routes directly, so scanning always
  // lands on the human-readable page rather than raw JSON or a PDF download.
  app.get("/credentials/:id/qr.svg", { schema: S.credentialQr }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const cred = await deps.credentials.get(id);
    if (!cred) return notFound(reply, "credential not found");
    const verifyUrl = `${deps.publicWebUrl}/verify?id=${encodeURIComponent(id)}`;
    const svg = await qrcode.toString(verifyUrl, { type: "svg", margin: 1, width: 240 });
    reply.type("image/svg+xml");
    return svg;
  });


  // PUBLIC capability URL (the unguessable credential id is the token, same
  // posture as /status). Renders a human-readable PDF certificate on the fly
  // when the credential's type has certificate.enabled. Reflects live status.
  app.get("/credentials/:id/certificate.pdf", { schema: S.credentialCertificate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const cred = await deps.credentials.get(id);
    if (!cred) return notFound(reply, "credential not found");
    if (!cred.credentialUseCaseKey) return notFound(reply, "no certificate for this credential");
    const def = await deps.credentialUseCases.get(cred.credentialUseCaseKey).catch(() => null);
    const typeNames = cred.type.split(",");
    const spec = def?.credentialTypes.find((t) => typeNames.includes(t.name) && t.certificate?.enabled === true);
    if (!def || !spec) return notFound(reply, "no certificate for this credential");
    if (cred.acceptance !== "accepted") return notFound(reply, "no certificate for this credential");

    // Loaded once and reused for both the printed issuer name AND the EN-E
    // brand-logo fallback below — a second fetch here would be the same
    // organization asked twice for one request.
    const issuerOrg = await deps.organizations.findByDid(cred.issuerDid);
    const issuerName = issuerOrg?.name ?? null;
    const statusUrl = `${deps.publicApiUrl}/credentials/${cred.id}/status`;
    let status = { revoked: cred.revoked, revokedAt: cred.revokedAt, revokedReason: cred.revokedReason };
    if (deps.registry) {
      try {
        const onChain = await deps.registry.anchor.credentialStatusOf(deps.registry.vcRegistry, cred.id);
        if (onChain.exists) status = { revoked: onChain.revoked, revokedAt: onChain.revokedAt ? new Date(onChain.revokedAt * 1000).toISOString() : null, revokedReason: cred.revokedReason };
      } catch (err) { request.log.error({ err }, "cert on-chain status read failed"); }
    }
    const nowMs = Date.now();

    // EN-F: the PRESENCE of artwork selects the renderer. With it the built-in
    // layout is replaced entirely and only `placements` print; without it,
    // nothing below this block changes.
    let pdf: Buffer | null = null;
    const background = spec.certificate?.background;
    if (background) {
      try {
        const bytes = (await deps.documents.get(background.documentId))?.bytes;
        if (!bytes) throw new Error(`certificate background document '${background.documentId}' not found`);
        // The page comes from a REAL measurement, never a hand-built object:
        // `certificateDrawList` resolves every coordinate against the page it is
        // handed and trusts it, so a zero or non-finite edge would silently
        // produce a QR of size 0 — a certificate that satisfies "a QR is always
        // drawn" and is still unverifiable. `certificatePageSize` is where the
        // degenerate cases are guarded, and `artworkDimensions` throws rather
        // than returning one.
        const measured = artworkDimensions(bytes);
        const page = certificatePageSize(measured.width, measured.height);
        const ops = certificateDrawList({
          placements: spec.certificate?.placements ?? [],
          values: resolveCertificateFields({ credential: cred, spec, issuerName }),
          page,
          statusUrl,
          banner: certificateStatusBanner({ status, expiresAt: cred.expiresAt, nowMs }),
        });
        pdf = await drawCertificate(ops, bytes, page);
      } catch (err) {
        // Deleting a document must not turn every certificate of that type into
        // an error, so this degrades to the built-in layout. At `error` and with
        // both ids, because it means a live config now names a document that is
        // gone or unreadable — a thing to fix, not a routine miss.
        request.log.error({ err, credentialId: cred.id, documentId: background.documentId }, "certificate artwork unusable; falling back to the built-in layout");
      }
    }

    if (!pdf) {
      let logoBytes: Buffer | null = null;
      // EN-E: the type's own logo still wins (MOST-SPECIFIC-WINS); only a type
      // with none of its own falls back to the issuing org's brand. The
      // deleted-document catch below covers BOTH sources — it wraps the fetch,
      // not either lookup individually, so an org's brand document going
      // missing degrades the same way a type's own always has: no logo, not a 500.
      const logoDocId = certificateLogoDocumentId(spec, issuerOrg);
      if (logoDocId) { try { logoBytes = (await deps.documents.get(logoDocId))?.bytes ?? null; } catch { logoBytes = null; } }
      pdf = await renderCredentialCertificate({ credential: cred, spec, issuerName, statusUrl, status, logoBytes, nowMs });
    }
    const fname = `${(spec.name || "credential").replace(/[^a-zA-Z0-9._-]/g, "_")}-${cred.id}.pdf`;
    return reply
      .header("content-type", "application/pdf")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename="${fname}"`)
      .send(pdf);
  });


  app.get("/registry", { schema: S.identityRegistry, ...auth }, async () => {
    if (!deps.registry) return null;
    return {
      chainId: deps.registry.chainId,
      didRegistry: deps.registry.didRegistry,
      vcRegistry: deps.registry.vcRegistry,
      deployTxHash: deps.registry.deployTxHash,
    };
  });


  app.get("/orgs/:id/credentials", { schema: S.orgCredentials, ...authScoped("credentials:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    if (!orgScoped(claims, id)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to view that organization's credentials" });
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    return (await deps.credentials.listByIssuer(org.did)).map((c) => ({
      id: c.id, type: c.type, holderDid: c.holderDid, claims: c.subjectClaims,
      issuedAt: c.issuedAt, expiresAt: c.expiresAt, revoked: c.revoked, revokedAt: c.revokedAt, revokedReason: c.revokedReason,
      // WHICH PROGRAMME THIS BELONGS TO, and whether the holder took it up.
      // Both were on the row and neither reached the caller, which made this an
      // undifferentiated pile: an issuer running several credential use cases
      // could not tell which one a credential came from, so nothing could be
      // counted, filtered or reconciled per programme. `acceptance` is the same
      // omission one step on — "issued" and "in force" are different facts, and
      // an issuer's own register is exactly where that difference matters.
      credentialUseCaseKey: c.credentialUseCaseKey,
      acceptance: c.acceptance,
    }));
  });


  app.get("/orgs/:id/wallet", { schema: S.orgWallet, ...authScoped("credentials:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    if (!orgScoped(claims, id)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to view that organization's wallet" });
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    return mapHeld(await deps.credentials.listByHolder(org.did));
  });


  // --- verification (verifier-request → holder-consent → verify) -----------
  app.post("/verification-requests", { schema: S.createVerificationRequest, ...authScoped("verifications:request") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { holderDid: string; requestedTypes: string[]; purpose: string; credentialUseCaseKey?: string; requestedFields?: Record<string, Record<string, FieldRequest>> };

    // F5 — a use-case-scoped Verifier desk user (no org). Authorized purely by
    // role + useCaseKey: they may only verify their OWN credential use case, and
    // the request is bound to it (credentialUseCaseKey) so verify() only ever
    // accepts that use case's credential types. Additive — the org path below is
    // untouched.
    if (claims.role === "Verifier") {
      const key = b.credentialUseCaseKey ?? claims.useCaseKey ?? undefined;
      if (!key || key !== claims.useCaseKey) {
        return reply.code(403).send({ error: "VERIFIER_NOT_PERMITTED", message: "you may only verify your own credential use case" });
      }
      const def = await deps.credentialUseCases.get(key);
      if (!def) return notFound(reply, `credential use case '${key}' not found`);
      // EN-B use-time binding re-check, FOR MACHINE PRINCIPALS ONLY — the mirror
      // of the one in resolveIssuer, and for the same reason: a Verifier desk is
      // authorized by role + useCaseKey alone, and EN-A deliberately kept an
      // already-minted desk working after its use case's verifier binding
      // changed. An unattended key must not outlive that config change; an
      // interactive desk keeps today's behaviour. An org-less desk operator has
      // no binding to re-check and is skipped.
      if (machinePrincipal(request) && claims.orgId) {
        const bound = def.ownerOrgId === claims.orgId || verifierBindingAllows(def.verifier, claims.orgId);
        if (!bound) {
          return reply.code(403).send({ error: "VERIFIER_NOT_PERMITTED", message: "your organization is no longer bound to this use case's verifier" });
        }
      }
      const names = new Set(def.credentialTypes.map((t) => t.name));
      if (!b.requestedTypes.every((t) => names.has(t))) {
        return reply.code(400).send({ error: "TYPES_NOT_IN_USECASE", message: "a requested type is not part of this use case" });
      }
      const schemasByType = new Map<string, { properties: Record<string, { type: string }> }>(def.credentialTypes.map((t) => [t.name, t.claimSchema]));
      const fieldErr = validateRequestedFields(b.requestedFields, schemasByType);
      if (fieldErr) return reply.code(400).send(fieldErr);
      const rec = await deps.verificationRequests.create({
        verifierOrgId: "", holderDid: b.holderDid, requestedTypes: b.requestedTypes, purpose: b.purpose,
        credentialUseCaseKey: key,
        challenge: randomUUID(), status: "pending", presentationVpJwt: null, consentedAt: null,
        consentedCredentialIds: null, requestedFields: b.requestedFields ?? null, consentedDisclosures: null,
        verifierResult: null, verifiedAt: null,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
      await deps.audit.append({ actorId: claims.id, action: "verification-requested" as LifecycleAction, payload: { requestId: rec.id, verifierUserId: claims.id, holderDid: b.holderDid, types: b.requestedTypes, credentialUseCaseKey: rec.credentialUseCaseKey } });
      // EN-C. `verifierOrgId || null`, not `?? null`: an ORG-LESS desk operator
      // stores "" here (see the `verifierScoped` comment), and "" is not an org —
      // it must degrade to platform-scope, or `endpointMatches` would hand this
      // request to any endpoint whose orgId happened to be "".
      await emitEvent(deps, {
        type: "verification.requested",
        orgId: rec.verifierOrgId || null,
        useCaseKey: rec.credentialUseCaseKey,
        subjectId: rec.id,
        data: {
          requestId: rec.id, verifierOrgId: rec.verifierOrgId || null, holderDid: rec.holderDid,
          requestedTypes: rec.requestedTypes, purpose: rec.purpose,
          credentialUseCaseKey: rec.credentialUseCaseKey, status: rec.status,
          expiresAt: rec.expiresAt,
        },
      }, request.log);
      return reply.code(201).send(vreqView(rec));
    }

    if (claims.role !== "OrgAdmin" || !claims.orgId) {
      return reply.code(403).send({ error: "NOT_A_VERIFIER", message: "only an organization admin may request a presentation" });
    }
    const org = await deps.organizations.get(claims.orgId);
    if (!org) return reply.code(403).send({ error: "NOT_A_VERIFIER", message: "your organization is not found" });

    let requestSchemasByType: Map<string, { properties: Record<string, { type: string }> }>;
    if (b.credentialUseCaseKey) {
      // Use-case-aware: gate by the Verifier binding (replaces the org-type gate)
      // and require every requested type to belong to the use case.
      const def = await deps.credentialUseCases.get(b.credentialUseCaseKey);
      if (!def) return notFound(reply, `credential use case '${b.credentialUseCaseKey}' not found`);
      if (!verifierBindingAllows(def.verifier, org.id)) {
        return reply.code(403).send({ error: "VERIFIER_NOT_PERMITTED", message: "your organization may not verify this use case" });
      }
      const names = new Set(def.credentialTypes.map((t) => t.name));
      if (!b.requestedTypes.every((t) => names.has(t))) {
        return reply.code(400).send({ error: "TYPES_NOT_IN_USECASE", message: "a requested type is not part of this use case" });
      }
      requestSchemasByType = new Map<string, { properties: Record<string, { type: string }> }>(def.credentialTypes.map((t) => [t.name, t.claimSchema]));
    } else if (org.orgType !== "verifier") {
      // Legacy generic flow: still requires a verifier org-type.
      return reply.code(403).send({ error: "NOT_A_VERIFIER", message: "your organization is not a verifier" });
    } else {
      requestSchemasByType = new Map<string, { properties: Record<string, { type: string }> }>(Object.values(CREDENTIAL_TYPES).map((t) => [t.type, t.claimSchema]));
    }

    // EN-A: verifying is an identity-domain act requiring the Verifier role —
    // checked after the binding/orgType gates on BOTH paths (a legacy null
    // envelope passes both predicates untouched), and deliberately BEFORE
    // `validateRequestedFields` below: authorization must precede input
    // validation, so a caller who may not use this route at all gets 403
    // rather than a 400 that discloses something about the use case's field
    // shape before its own authorization was even checked.
    if (!orgRoleEnabled(org.capabilities, "Verifier")) return orgCapabilityMissing(reply, org, "Verifier");
    if (!orgDomainEnabled(org.capabilities, "identity")) return orgCapabilityMissing(reply, org, "identity");

    const orgFieldErr = validateRequestedFields(b.requestedFields, requestSchemasByType);
    if (orgFieldErr) return reply.code(400).send(orgFieldErr);

    const rec = await deps.verificationRequests.create({
      verifierOrgId: org.id, holderDid: b.holderDid, requestedTypes: b.requestedTypes, purpose: b.purpose,
      credentialUseCaseKey: b.credentialUseCaseKey ?? null,
      challenge: randomUUID(), status: "pending", presentationVpJwt: null, consentedAt: null,
      consentedCredentialIds: null, requestedFields: b.requestedFields ?? null, consentedDisclosures: null,
      verifierResult: null, verifiedAt: null,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    await deps.audit.append({ actorId: claims.id, action: "verification-requested" as LifecycleAction, payload: { requestId: rec.id, verifierOrgId: org.id, holderDid: b.holderDid, types: b.requestedTypes, credentialUseCaseKey: rec.credentialUseCaseKey } });
    // EN-C — the OrgAdmin path of the same route (see the desk-operator branch
    // above for why this is `|| null`).
    await emitEvent(deps, {
      type: "verification.requested",
      orgId: rec.verifierOrgId || null,
      useCaseKey: rec.credentialUseCaseKey,
      subjectId: rec.id,
      data: {
        requestId: rec.id, verifierOrgId: rec.verifierOrgId || null, holderDid: rec.holderDid,
        requestedTypes: rec.requestedTypes, purpose: rec.purpose,
        credentialUseCaseKey: rec.credentialUseCaseKey, status: rec.status,
        expiresAt: rec.expiresAt,
      },
    }, request.log);
    return reply.code(201).send(vreqView(rec));
  });

  // The holder's own inbox (GET /me/verification-requests) lives in shared.ts:
  // route-domains.ts classifies it "shared" so it still answers on a
  // tokenization console for a roster member issue-kyc gave a DID to.


  /**
   * THE VERIFIER'S SIDE OF `GET /me/verification-requests`.
   *
   * The holder has had an inbox since VP-3; the verifier never did, and the id
   * of a request lived only in the browser tab that created it. Reload the desk
   * and a pending request became unreachable — still open, still consentable by
   * the holder, but with no way back to `/verify`. This is that list.
   *
   * The scoping is `verifierScoped` itself, applied as a FILTER rather than
   * re-derived as a query. Re-deriving it is how a list and its detail route
   * drift apart into two different answers to the same question; here they
   * cannot, because there is only one predicate. The cheap query below is a
   * pre-narrowing, never the authorization:
   *
   *   · OrgAdmin  → their org's rows (the filter is then a no-op, by construction)
   *   · Verifier desk (org-less, verifierOrgId "") → matched on credentialUseCaseKey
   *   · PlatformAdmin → everything, exactly as `orgScoped` already grants per-id
   *   · anyone else → the empty list, not a 403: nothing exists FOR THEM.
   *
   * Machine principals are admitted deliberately, on the same
   * `verifications:read` scope as the holder inbox: polling one's own
   * outstanding requests is the unattended half of this flow, and a key inherits
   * its service user's role and org, so nothing widens.
   *
   * `vreqView` is shared with every other verification route, which is what
   * keeps `verifierResult` out of this response: reading the verdict still costs
   * `verifications:verify`.
   */
  app.get("/verification-requests", { schema: S.listVerificationRequests, ...authScoped("verifications:read") }, async (request) => {
    const claims = request.user as TokenClaims;
    const candidates = claims.role === "OrgAdmin" && claims.orgId
      ? await deps.verificationRequests.listByVerifierOrg(claims.orgId)
      : await deps.verificationRequests.list();
    return candidates
      .filter((r) => verifierScoped(claims, r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(vreqView);
  });


  app.get("/verification-requests/:id", { schema: S.getVerificationRequest, ...authScoped("verifications:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const r = await deps.verificationRequests.get(id);
    const isHolder = !!claims.did && claims.did === r?.holderDid;
    const isVerifier = !!r && verifierScoped(claims, r);
    if (!r || (!isHolder && !isVerifier)) {
      return notFound(reply, "verification request not found");
    }
    return vreqView(r);
  });


  app.post("/verification-requests/:id/consent", { schema: S.consentVerificationRequest, ...authScoped("credentials:present") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const { credentialIds, disclosures } = request.body as { credentialIds: string[]; disclosures?: Record<string, Record<string, DisclosureChoice>> };
    const r = await deps.verificationRequests.get(id);
    if (!r) return notFound(reply, "verification request not found");
    // Holder ONLY — one person authorizing disclosure of their OWN credentials.
    if (!claims.did || claims.did !== r.holderDid) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only the holder may consent to this request" });
    }
    if (r.status !== "pending") return reply.code(409).send({ error: "REQUEST_NOT_PENDING", message: `request is ${r.status}` });
    if (new Date(r.expiresAt).getTime() < Date.now()) {
      await deps.verificationRequests.setStatus(r.id, "expired");
      return reply.code(410).send({ error: "REQUEST_EXPIRED", message: "this verification request has expired" });
    }
    // Every chosen credential must be the holder's own, of a requested type, unrevoked.
    const mine = await deps.credentials.listByHolder(claims.did);
    const byId = new Map(mine.map((c) => [c.id, c]));
    const chosen = credentialIds.map((cid) => byId.get(cid));
    for (let i = 0; i < credentialIds.length; i++) {
      const c = chosen[i];
      if (!c || c.revoked || c.acceptance !== "accepted" || !r.requestedTypes.includes(c.type)) {
        return reply.code(400).send({ error: "CREDENTIAL_NOT_ELIGIBLE", message: `credential '${credentialIds[i]}' is not an eligible, unrevoked, accepted, requested-type credential you hold` });
      }
    }
    const claimsByCredentialId = new Map<string, Record<string, unknown>>(chosen.map((c, i) => [credentialIds[i]!, c!.subjectClaims]));
    const disclosureResult = resolveDisclosures(disclosures, claimsByCredentialId);
    if (!disclosureResult.ok) return reply.code(400).send({ error: disclosureResult.error, message: disclosureResult.message });
    // Custodial VP signing: the caller IS the holder, so resolve their own seed.
    const holderUser = await deps.users.findById(claims.id);
    if (!holderUser?.didSeedEncrypted) {
      return reply.code(409).send({ error: "HOLDER_KEY_UNAVAILABLE", message: "no custodial key is available for your DID" });
    }
    const holderKey = deps.keystore.keyOf(holderUser.didSeedEncrypted);
    const vpJwt = presentCredentials({
      holderDid: r.holderDid, holderKey: holderKey.privateKey,
      vcJwts: chosen.map((c) => c!.vcJwt), challenge: r.challenge, now: Math.floor(Date.now() / 1000),
    });
    const updated = await deps.verificationRequests.setConsented(r.id, { vpJwt, credentialIds, at: new Date().toISOString(), disclosures: disclosureResult.resolved });
    await deps.audit.append({ actorId: claims.id, action: "verification-consented" as LifecycleAction, payload: { requestId: r.id, verifierOrgId: r.verifierOrgId, credentialIds } });
    return vreqView(updated);
  });


  app.post("/verification-requests/:id/reject", { schema: S.rejectVerificationRequest, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const r = await deps.verificationRequests.get(id);
    if (!r) return notFound(reply, "verification request not found");
    if (!claims.did || claims.did !== r.holderDid) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only the holder may reject this request" });
    }
    if (r.status !== "pending") return reply.code(409).send({ error: "REQUEST_NOT_PENDING", message: `request is ${r.status}` });
    const updated = await deps.verificationRequests.setStatus(r.id, "rejected");
    await deps.audit.append({ actorId: claims.id, action: "verification-rejected" as LifecycleAction, payload: { requestId: r.id, verifierOrgId: r.verifierOrgId } });
    return vreqView(updated);
  });


  app.get("/verification-requests/:id/verify", { schema: S.verifyVerificationRequest, ...authScoped("verifications:verify") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const r = await deps.verificationRequests.get(id);
    if (!r || !verifierScoped(claims, r)) {
      return notFound(reply, "verification request not found");
    }
    if (r.status !== "consented" || !r.presentationVpJwt) {
      return reply.code(409).send({ error: "NOT_CONSENTED", message: `request is ${r.status}; nothing to verify` });
    }
    const vpJwt = r.presentationVpJwt;
    const nowSec = Math.floor(Date.now() / 1000);

    // STEP 1 — compute the trusted-issuer list (this is HOW core's trust check is
    // fed, not a second check). Collect each inner VC's issuer DID, then decide
    // trust: on-chain (registered && active) when a registry is configured, else
    // the static allowlist. The subset that passes becomes trustedIssuers.
    const issuerDids = new Set<string>();
    try {
      const vp = decodeJwt(vpJwt);
      for (const raw of ((vp.payload.vp as { verifiableCredential?: unknown[] })?.verifiableCredential ?? [])) {
        if (typeof raw === "string") { try { issuerDids.add(String(decodeJwt(raw).payload.iss ?? "")); } catch { /* skip */ } }
      }
    } catch { /* malformed → core fails it below */ }
    const resolutions = new Map<string, Awaited<ReturnType<typeof resolveDid>>>();
    for (const did of issuerDids) {
      if (!did) continue;
      resolutions.set(did, await resolveDid(did, {
        registry: deps.registry,
        onChainError: (err) => request.log.error({ err, did }, "on-chain issuer-trust read failed"),
      }));
    }
    const trusted: string[] = [];
    for (const [did, res] of resolutions) {
      const m = res.didDocumentMetadata;
      if (m.source === "chain") {
        if (m.registered && m.active) trusted.push(did);
      } else if (!deps.registry && (deps.trustedKycIssuers ?? []).includes(did)) {
        trusted.push(did);
      }
    }

    // STEP 2 — pure crypto verification against that trust list.
    const core = verifyPresentationCredentials({ vpJwt, challenge: r.challenge, trustedIssuers: trusted, now: nowSec });

    // STEP 3 — per-credential chain-backed revocation. core doesn't surface each
    // VC's jti, so re-decode the presented VCs aligned BY INDEX to recover jti
    // (our VCs set jti === Credential.id) and resolve revocation from it.
    const presentedJtis: (string | null)[] = [];
    try {
      const vp = decodeJwt(vpJwt);
      for (const raw of ((vp.payload.vp as { verifiableCredential?: unknown[] })?.verifiableCredential ?? [])) {
        presentedJtis.push(typeof raw === "string" ? (() => { try { return String(decodeJwt(raw).payload.jti ?? "") || null; } catch { return null; } })() : null);
      }
    } catch { /* handled by core */ }

    const credentials = await Promise.all(core.credentials.map(async (c, i) => {
      const jti = presentedJtis[i] ?? null;
      let revoked: boolean | "unknown" = "unknown";
      let type: string | null = null;
      let stored: CredentialRecord | null = null;
      if (jti) {
        stored = await deps.credentials.get(jti);
        type = stored?.type ?? null;
        if (deps.registry) {
          try {
            const st = await deps.registry.anchor.credentialStatusOf(deps.registry.vcRegistry, jti);
            revoked = st.exists ? st.revoked : (stored ? stored.revoked : "unknown");
          } catch (err) { request.log.error({ err }, "on-chain revocation read failed"); revoked = stored ? stored.revoked : "unknown"; }
        } else {
          revoked = stored ? stored.revoked : "unknown";
        }
      }
      const notRevoked = revoked === false;
      const checks = {
        signature: c.reason !== "BAD_ISSUER_SIGNATURE" && c.reason !== "MALFORMED_PRESENTATION",
        trusted: c.reason !== "UNTRUSTED_ISSUER",
        notExpired: c.reason !== "CREDENTIAL_EXPIRED",
        subjectBound: c.reason !== "SUBJECT_MISMATCH",
        notRevoked,
      };
      const issuerDid = c.credential?.issuer ?? null;
      const resMeta = issuerDid ? resolutions.get(issuerDid)?.didDocumentMetadata : undefined;
      const resolvedForThisCredential = jti ? r.consentedDisclosures?.[jti] : undefined;
      return {
        id: jti, type, issuer: issuerDid, claims: redactClaims(c.credential?.claims ?? null, resolvedForThisCredential),
        reason: c.reason ?? null, checks, valid: c.valid && notRevoked,
        issuerResolution: resMeta && resMeta.source === "chain"
          ? { registered: resMeta.registered, active: resMeta.active, chainId: resMeta.chainId }
          : null,
        anchorTxHash: stored?.anchorTxHash ?? null,
        anchorChainId: stored?.anchorChainId ?? null,
        revokeTxHash: stored?.revokeTxHash ?? null,
      };
    }));

    const requestedCovered = r.requestedTypes.every((t) => credentials.some((c) => c.type === t && c.valid));
    const result = { valid: core.valid && requestedCovered, holderDid: core.holderDid ?? null, reason: core.reason ?? null, purpose: r.purpose, credentials, verifiedAt: new Date().toISOString() };
    await deps.verificationRequests.setVerifierResult(r.id, { result, at: result.verifiedAt });
    await deps.audit.append({ actorId: claims.id, action: "verification-verified" as LifecycleAction, payload: { requestId: r.id, valid: result.valid, holderDid: core.holderDid ?? null } });
    // EN-C. The VERDICT ONLY. `result` carries each presented credential's
    // decoded `claims` — the private content the holder consented to disclose to
    // ONE verifier, for ONE purpose. Publishing that to a webhook would re-share
    // it with every endpoint the org has registered, outside the consent the
    // holder actually gave. So: ids, types, per-credential valid flags, nothing
    // else. Same reason `vreqView` never exposes verifierResult.
    await emitEvent(deps, {
      type: "verification.completed",
      orgId: r.verifierOrgId || null,
      useCaseKey: r.credentialUseCaseKey,
      subjectId: r.id,
      data: {
        requestId: r.id, verifierOrgId: r.verifierOrgId || null, holderDid: result.holderDid,
        credentialUseCaseKey: r.credentialUseCaseKey, purpose: r.purpose,
        valid: result.valid, reason: result.reason, verifiedAt: result.verifiedAt,
        credentials: credentials.map((c) => ({ id: c.id, type: c.type, valid: c.valid, reason: c.reason })),
      },
    }, request.log);
    return result; // 200 even when valid:false
  });


  app.post("/users/:id/identity/challenge", { schema: S.identityChallenge, ...authScoped("users:onboard") }, async (request, reply) => {
    const target = await manageableTarget(request, reply);
    if (!target) return reply;
    return deps.challenges.issue(target.id);
  });


  app.post("/users/:id/identity/verify", { schema: S.identityVerify, ...authScoped("users:onboard") }, async (request, reply) => {
    const target = await manageableTarget(request, reply);
    if (!target) return reply;
    const { presentation } = request.body as { presentation: string };
    // Recover the challenge (nonce) from the VP and consume it (single-use, unexpired).
    let nonce = "";
    try {
      nonce = String((JSON.parse(Buffer.from(presentation.split(".")[1] ?? "", "base64url").toString("utf8")) as { nonce?: string }).nonce ?? "");
    } catch { /* malformed → handled by the guard below */ }
    if (!nonce || !deps.challenges.consume(target.id, nonce)) {
      return reply.code(400).send({ error: "CHALLENGE_EXPIRED", message: "no matching unexpired challenge — request a new one" });
    }
    const result = verifyPresentation({ vpJwt: presentation, challenge: nonce, trustedIssuers: deps.trustedKycIssuers ?? [], now: Math.floor(Date.now() / 1000) });
    if (!result.valid) return reply.code(400).send({ error: result.reason, message: `presentation rejected: ${result.reason}` });
    const vcClaims = result.credential!.claims as { country?: string; legalName?: string };
    await deps.users.update(target.id, {
      kycStatus: "approved",
      did: result.holderDid,
      kyc: { ...(target.kyc ?? {}), country: vcClaims.country, legalName: vcClaims.legalName ?? target.kyc?.legalName, issuerDid: result.credential!.issuer, credentialId: String(decodeVcJti(presentation) ?? ""), verifiedAt: new Date().toISOString() },
    });
    {
      const notice = kycDecisionEmail({ decision: "approved" });
      await deps.mail.send(target.email, notice.subject, notice.text, notice.html).catch((err) => request.log.error({ err }, "[mail] kyc-decision send failed"));
    }
    // Asset-less audit entry: "kyc-verified" is not a LifecycleAction, so cast at
    // the append boundary (analytics/holders folds only match specific actions and
    // never see this row anyway — it carries no assetId).
    await deps.audit.append({ actorId: actorOf(request).id, action: "kyc-verified" as LifecycleAction, payload: { userId: target.id, did: result.holderDid, issuer: result.credential!.issuer, country: vcClaims.country ?? null } });
    return { status: "approved", did: result.holderDid, claims: result.credential!.claims, issuer: result.credential!.issuer };
  });

  // The admin-issued counterpart of the route above (mint a DID + KycCredential
  // directly, no presentation) now lives in shared.ts: route-domains.ts
  // classifies it "shared" — a tokenization use case's
  // compliance.requireVerifiedIdentity gate needs it satisfiable for a roster
  // member with no organization onboarding behind them, so it must answer on a
  // tokenization-only deployment too — and route-file-domains.test.ts requires
  // a route's file to agree with its classification.


  /**
   * SERVICE-TO-SERVICE: does this subject hold a valid credential of this type?
   *
   * The one question Tokenization must ask Identity once the two are deployed
   * apart. In a single deployment the LifecycleEngine asks it in-process
   * through `ComplianceProvider.hasVerifiedIdentity`; both paths run
   * `holdsValidCredential`, so the answer cannot depend on the topology. That
   * shared predicate is the point — two implementations would mean splitting
   * the deployment silently changes who may hold a token.
   *
   * MACHINE-ONLY, and this is the subtle part. `requireScope` short-circuits
   * for a human session (`granted === null` ⇒ every check passes), because
   * scopes are a property of API keys. So `authScoped` ALONE would leave this
   * route open to every signed-in user — a Buyer could sit and enumerate which
   * DIDs are KYC'd. The scope narrows machines; the explicit refusal below is
   * what keeps humans out. Both halves, or the gate answers the wrong question.
   *
   * The response is a boolean. Claims, issuer and credential id stay behind the
   * holder's consent in the presentation exchange — see the scope's own note.
   */
  app.post("/identity/assertions", { schema: S.identityAssert, ...authScoped("identity:assert") }, async (request, reply) => {
    if (!machinePrincipal(request)) {
      return reply.code(403).send({
        error: "SESSION_PRINCIPAL",
        message: "this is a service-to-service route; present an API key with the 'identity:assert' scope",
      });
    }
    const b = request.body as { subject: string; credentialType?: string };
    const subject = b.subject.trim();
    const credentialType = (b.credentialType ?? IDENTITY_CREDENTIAL_TYPE).trim();
    if (!subject || !credentialType) {
      return reply.code(400).send({ error: "INVALID_ASSERTION", message: "subject and credentialType must be non-empty" });
    }
    const holds = await holdsValidCredential(deps.credentials, subject, credentialType);
    // Audited every time, answer included. A key with this scope may ask about
    // ANY subject — there is no tenant boundary on "is this DID KYC'd" when the
    // caller is a peer platform rather than a customer — so the compensating
    // control is that asking is never silent.
    await deps.audit.append({
      actorId: (request.user as TokenClaims).id,
      action: "identity-asserted" as LifecycleAction,
      payload: { subject, credentialType, holds },
    });
    return reply.code(200).send({ subject, credentialType, holds, checkedAt: new Date().toISOString() });
  });


  // Demo-only: mint a demo issuer-signed VC wrapped in a holder-signed VP over a
  // challenge. Present ONLY when DEV_KYC_ISSUER_SEED is configured — that env var
  // is the explicit switch (absent in a real deployment ⇒ 404), same real-or-absent
  // pattern as chains/fees. A production operator must never set the dev seed.
  app.post("/identity/mint", { schema: S.identityMint, ...auth }, async (request, reply) => {
    if (!deps.devIssuerSeed) return reply.code(404).send({ error: "NOT_FOUND", message: "not available" });
    // Any desk operator (user-manager) may use the demo minter — it's the same role
    // that runs verification, and the endpoint is dev-only (seed-gated, absent in prod).
    if (!canManageUsers((request.user as TokenClaims).role)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to mint demo credentials" });
    const { subjectDid, holderSeed, claims, challenge } = request.body as { subjectDid?: string; holderSeed?: string; claims: Record<string, unknown>; challenge: string };
    const issuer = devKeyFromSeed(deps.devIssuerSeed);       // deterministic issuer (its did must be in TRUSTED_KYC_ISSUERS)
    const holder = holderSeed ? devKeyFromSeed(holderSeed) : generateDidKey();
    const subject = subjectDid ?? holder.did;
    const now = Math.floor(Date.now() / 1000);
    const vc = issueCredential({ issuerDid: issuer.did, issuerKey: issuer.privateKey, subjectDid: subject, claims, expiresAt: now + 86400, now });
    const vp = presentCredential({ holderDid: holder.did, holderKey: holder.privateKey, vcJwt: vc, challenge, now });
    return { presentation: vp, holderDid: holder.did, issuerDid: issuer.did };
  });

}
