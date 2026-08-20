/**
 * THE CROSS-CUTTING ROUTE HELPERS, BUILT ONCE.
 *
 * Authentication, maker-checker proposal creation, org scoping. Every route
 * family needs them and none of them belongs to a
 * product, so they are built once here and handed to each register function
 * rather than closed over in one enormous scope.
 *
 * This is what made the split possible: with these in a context object, a
 * product's routes can live in their own file and still be the same closure's
 * worth of behaviour.
 */
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyRecord, AssetRecord, BrandingPatch, CashflowRecord, CompanyProfile, CredentialRecord, DocumentPurpose, KybDocumentRef, KycDetails, KycStatus, ListingRecord, OrganizationRecord, ProposalRecord, UserRecord, VerificationRequestRecord, WebhookEndpointRecord } from "../../persistence/types/index.js";
import { ListingConflictError } from "../../persistence/types/index.js";
import { assignableRoles, auditEntryHash, canCreateOrgMember, canCreateUser, canManageUsers, certificatePageSize, computeCashflowSchedule, CREDENTIAL_TEMPLATES, CREDENTIAL_TYPES, credentialTypeDef, credentialUseCaseType, decodeJwt, didKeyFromSeed, generateDidKey, holderPolicyAllows, instantiateTemplate, invoiceFingerprint, issueCredential, issuerBindingAllows, normalizeUseCaseDefinition, ORG_OPERATING_ROLES, orgDomainEnabled, orgRoleEnabled, PolicyError, presentCredential, presentCredentials, splitProRata, TEMPLATE_CATALOG, useCaseDomainOf, validateBrandAccent, validateCertificatePlacements, validateCredentialUseCase, validateEventTypes, validateMetadata, scopeAllows, validateOrgCapabilities, validateScopes, validateTemplate, verifierBindingAllows, verifyChain, verifyDidSignature, verifyPresentation, verifyPresentationCredentials, isDocumentSha256, type Actor, type ApiScope, type ChainEntry, type CredentialTypeSpec, type CredentialUseCaseDefinition, type LifecycleAction, type OrgOperatingRole, type OrgType, type Role, type UseCaseDefinition, type UseCaseTemplate, type CertificateFieldPlacement } from "@tokenlayer/core";
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
import { NO_USE_CASE, canAdministerUser, BCRYPT_ROUNDS, LOGIN_WINDOW_MS, MAX_DOC_BYTES, DOC_UPLOAD_BODY_LIMIT, ALLOWED_DOC_TYPES, storeUploadedDocument, orgOwnsDocument, decodeVcJti, devKeyFromSeed, orgView, orgCapabilityMissing } from "./common.js";

export type BrandLogoErrorCode =
  | "BACKGROUND_IS_BRAND_LOGO"
  | "CERTIFICATE_LOGO_IS_BRAND_LOGO"
  | "INVOICE_DOCUMENT_IS_BRAND_LOGO"
  | "KYB_DOCUMENT_IS_BRAND_LOGO";


export function buildRouteContext(app: FastifyInstance, deps: AppDeps, sharedPrincipal?: ReturnType<typeof requirePrincipal>) {
  // ONE preHandler instance: it owns the per-key rate-limit and failed-attempt
  // counters, so every route must share it rather than build its own.
  const principal = sharedPrincipal ?? requirePrincipal(deps);

  const auth = { preHandler: principal };

  /**
   * `auth` plus an API-key scope gate. A JWT request passes the gate
   * unconditionally (see requireScope) — this ONLY narrows machine callers, so
   * composing it onto a route can never change human behaviour.
   *
   * READ THIS BEFORE ADDING A ROUTE. `...auth` alone means "ANY key with ANY
   * scope may call this" — the default is FAIL-OPEN by omission, and three real
   * holes (provisioning, the invoice register, maker-checker approval) were
   * found exactly that way. Choosing is not optional: `scope-coverage.test.ts`
   * fails the build for any new mutating route that is neither `authScoped(...)`
   * nor listed, with a reason, in that test's DELIBERATELY_UNSCOPED table.
   */
  const authScoped = (required: ApiScope) => ({ preHandler: [principal, requireScope(required)] });


  // Per-instance in-memory login throttle (per IP): bounds credential-stuffing / brute force.
  const loginMax = deps.loginRateLimitMax ?? 10;

  const loginHits = new Map<string, { count: number; resetAt: number }>();

  function loginThrottled(ip: string): boolean {
    const now = Date.now();
    const e = loginHits.get(ip);
    if (!e || now > e.resetAt) {
      loginHits.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return false;
    }
    e.count += 1;
    return e.count > loginMax;
  }


  // When the use case gates `op`, capture the operation as a pending Proposal
  // instead of executing it. Returns the proposal (→ 202) or null when ungated.
  // The caller must have already run every request-time validation for the op.
  async function proposeIfGated(
    request: FastifyRequest,
    useCase: UseCaseDefinition,
    op: string,
    assetId: string | null,
    payload: Record<string, unknown>,
  ): Promise<ProposalRecord | null> {
    const required = useCase.workflow?.approvals?.[op as keyof NonNullable<NonNullable<UseCaseDefinition["workflow"]>["approvals"]>];
    if (!required || required < 1) return null;
    const claims = request.user as TokenClaims;
    // Token proposals are use-case scoped, never org scoped.
    return deps.proposals.create({ useCaseKey: useCase.key, orgId: null, assetId, kind: op, payload, proposerId: claims.id, proposerLabel: claims.email, required });
  }


  // Org scope: PlatformAdmin acts on any org; an OrgAdmin only on their own.
  function orgScoped(claims: TokenClaims, orgId: string): boolean {
    return claims.role === "PlatformAdmin" || (claims.role === "OrgAdmin" && claims.orgId === orgId);
  }


  // Resolve a use-case key to its product domain the SAME way GET /me does —
  // shared by the login + QR-poll responses (which populate the web SessionUser)
  // and the /me handler, so the domain a session carries never drifts. Null when
  // the user has no use-case key (e.g. a PlatformAdmin) or the key names neither.
  async function resolveUseCaseDomain(useCaseKey: string | null): Promise<"tokenization" | "identity" | null> {
    if (!useCaseKey) return null;
    // Each catalogue is listed only where this deployment KEEPS it. This runs on
    // /auth/login, the QR poll and /me — all SHARED routes, present on every
    // deployment — so consulting a table this instance does not own would fail
    // sign-in itself on a single-product deployment. An absent catalogue
    // contributes no keys, which is the truth: those use cases live elsewhere.
    const [tks, cks] = await Promise.all([
      deps.enabledDomains.includes("tokenization") ? deps.useCases.list() : Promise.resolve([]),
      deps.enabledDomains.includes("identity") ? deps.credentialUseCases.list() : Promise.resolve([]),
    ]);
    return useCaseDomainOf(useCaseKey, {
      tokenizationKeys: tks.map((u) => u.key),
      credentialKeys: cks.map((u) => u.key),
    }) ?? null;
  }


  /**
   * Both use-case catalogues, each listed only where this deployment keeps it.
   * Same rule as `resolveUseCaseDomain`: these run on SHARED onboarding routes,
   * so consulting a table this instance does not own would fail them outright.
   */
  async function useCaseKeysByDomain(): Promise<{ tokenizationKeys: string[]; credentialKeys: string[] }> {
    const [tks, cks] = await Promise.all([
      deps.enabledDomains.includes("tokenization") ? deps.useCases.list() : Promise.resolve([]),
      deps.enabledDomains.includes("identity") ? deps.credentialUseCases.list() : Promise.resolve([]),
    ]);
    return { tokenizationKeys: tks.map((u) => u.key), credentialKeys: cks.map((u) => u.key) };
  }


  /**
   * The wallet behind a linked account id, or null — asked only where this
   * deployment keeps wallets.
   *
   * `Account` is tokenization's table but the two SIGN-IN surfaces that
   * decorate a session with `walletAddress` (POST /auth/login and the QR poll)
   * are shared, so on an identity-only deployment this asked for a table it
   * does not own and broke login for any user carrying an accountId — which is
   * every user in a database migrated from a combined deployment. Null is the
   * honest answer there: that deployment has no wallets to report.
   */
  async function linkedWallet(accountId: string | null): Promise<{ address: string } | null> {
    if (!accountId || !deps.enabledDomains.includes("tokenization")) return null;
    return deps.accounts.findById(accountId);
  }


  /**
   * EN-A member-add filter: an ENVELOPED org only takes on members whose role
   * and use-case domain fit its envelope. Returns the missing capability (an
   * operating role or a domain) or null when the add is in-envelope. A legacy
   * org (null envelope) is unrestricted; roles outside the three operating
   * roles (Trader/Buyer/UseCaseAdmin/...) gate on domain only; an unknown key
   * resolves to no domain and stays ungated here (unchanged legacy behavior).
   *
   * Shared by BOTH member-creating routes — POST /orgs/:id/users and the
   * `claims.orgId` branch of POST /users — so an org member cannot route
   * around the envelope by using the other door. Callers apply the
   * PlatformAdmin bypass themselves (platform override).
   */
  async function orgMemberCapabilityViolation(org: OrganizationRecord, role: Role, useCaseKey: string | null): Promise<string | null> {
    if (org.capabilities === null) return null;
    if ((ORG_OPERATING_ROLES as readonly string[]).includes(role) && !orgRoleEnabled(org.capabilities, role as OrgOperatingRole)) {
      return role;
    }
    if (useCaseKey) {
      const domain = await resolveUseCaseDomain(useCaseKey);
      if (domain && !orgDomainEnabled(org.capabilities, domain)) return domain;
    }
    return null;
  }


  /**
   * The artwork formats the renderer can actually DRAW, which is narrower than
   * "an image": `openArtwork` is pdfkit's `openImage`, and that reads PNG and
   * JPEG and nothing else. An `image/webp` background passes an `image/*` check,
   * stores with a 201, renders on the browser canvas — and then degrades to the
   * built-in layout on every real certificate, with nothing telling the customer
   * why their design vanished. The designer's file input offered webp, so this
   * was reachable by accident rather than by attack.
   */
  const RENDERABLE_ARTWORK_TYPES = new Set(["image/png", "image/jpeg"]);

  const isRenderableArtwork = (contentType: string): boolean =>
    RENDERABLE_ARTWORK_TYPES.has(contentType.toLowerCase().trim());


  /**
   * A BRAND LOGO IS AN ORGANIZATION'S MARK, AND NOTHING ELSE MAY POINT AT ONE.
   *
   * `POST /orgs/{id}/branding/logo` stamps `purpose = "brand-logo"`, and the
   * prune deletes such a row once a newer upload supersedes it. That is sound
   * only while `Organization.brandLogoDocumentId` is the ONLY reference that
   * can exist to one, which means every OTHER site that persists a
   * caller-supplied document id has to refuse these bytes.
   *
   * THE METHOD, WRITTEN DOWN SO IT CAN BE RE-RUN RATHER THAN TRUSTED. Building
   * this list by tracing the artwork pipeline forward finds every door THAT
   * feature reaches and no other — a narrower question than the one that
   * actually closes the set, asked in its place. The question that closes it
   * is the reverse one: for every Prisma model and every JSON blob column
   * (`companyProfile`, `credentialTypes`, `body`, `payload`, `metadata`,
   * `subjectClaims`, `kyc`, …) across `apps/api/prisma/schema.prisma`,
   * `apps/api/src` and `packages/core`, does ANY field hold a caller-supplied
   * id that is later handed to `deps.documents.get` — i.e. actually
   * dereferenced into bytes or an authoritative "this document IS the X"
   * binding — rather than stored as an inert opaque string nothing ever reads
   * back as a document id. Re-run that question, not this list, before adding
   * a new write site.
   *
   * TWO FIELDS CHECKED AND RULED OUT, for different reasons. `PropertySchema.
   * type === "document"` (`Asset.metadata`, `Credential.subjectClaims`) is a
   * same-origin reference into real bytes, not an inert string — `POST
   * /documents` returns `url: "/api/v1/documents/{id}"`, and `IssuePanel.tsx`
   * writes exactly that value in. It is safe for narrower reasons instead: the
   * upload button always mints a fresh `purpose: null` row, nothing in
   * `apps/web` renders the value as a followable link (`AssetDetail.tsx`
   * prints it as text; `InvestorPortal.tsx` links only `http`-prefixed
   * values), and the route behind it requires a bearer token regardless.
   * `KycDetails.documentRef` is the genuinely inert one: free text with no
   * upload path and no render site anywhere in `apps/web`.
   *
   * The doors that call this today: `certificate.background` (the artwork
   * pin, below), `certificate.logoDocumentId` (every door that can SET it —
   * not the same list as every door that WRITES a definition, since
   * `PATCH /credential-use-cases/{key}/certificate` writes one without
   * touching this field at all, via `checkCertificateLogoDocument`), a staged
   * invoice's `documentId`, and `company.documents.{cinCertificate,
   * gstinCertificate}` at `POST /orgs/register`.
   *
   * Refusing costs LITTLE legitimate use, not nothing. A certificate whose
   * bound issuer is an ORG (`issuer: { kind: "org" }`) gets the org's mark for
   * free regardless: `certificateLogoDocumentId` (see certificate-fields.ts)
   * falls back to `issuerOrg.brandLogoDocumentId`, the PINNED document the
   * prune always spares. A PLATFORM-issued type (`issuer: { kind: "platform"
   * }`) has no such org to fall back to, so one that genuinely wants a
   * specific tenant's mark must re-upload it through the general store
   * instead of naming the branding upload directly — the two-upload cost the
   * artwork door already accepts, paid here too.
   *
   * Takes the already-resolved document — `null` when there is none — rather
   * than an id, so it composes with whatever existence/ownership handling
   * each door already does instead of repeating it.
   */

  function brandLogoRefusal(
    doc: { purpose: DocumentPurpose | null } | null,
    errorCode: BrandLogoErrorCode,
    message: string,
  ): { error: BrandLogoErrorCode; message: string } | null {
    if (doc?.purpose !== "brand-logo") return null;
    return { error: errorCode, message };
  }


  // --- audit integrity (hash chain + on-ledger anchoring) -----------------
  // Rebuild an asset's seq-ascending ChainEntry list from its (chained) audit rows.
  async function assetChain(assetId: string): Promise<ChainEntry[]> {
    const { items } = await deps.audit.listByAsset(assetId, { limit: 100000 });
    return items
      .filter((e) => e.hash !== undefined)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((e) => ({ seq: e.seq!, prevHash: e.prevHash!, hash: e.hash!, fields: { assetId: e.assetId ?? "__none__", seq: e.seq!, actorId: e.actorId, action: e.action, payload: e.payload, txHash: e.txHash, chainId: e.chainId, createdAt: e.createdAt } }));
  }

  // Verify one asset's chain and compare the entry at the anchored seq to the
  // on-ledger anchor (catches a consistent full-chain rewrite up to that point).
  async function verifyAsset(assetId: string) {
    const chain = await assetChain(assetId);
    const base = verifyChain(assetId, chain);
    const anchor = await deps.auditAnchors.latest(assetId);
    // EVERY ANCHOR, not just the newest. Checking only the latest left a way
    // through: rewrite the chain consistently, perform one more real action so
    // the head advances, then anchor. The new anchor sits at a higher seq, the
    // old attestation is never consulted again, and the rewrite reads as clean
    // — while `verifyChain` is fooled by construction, since a full rewrite is
    // internally perfect. The anchors are the ONLY witnesses to what the chain
    // said before, so all of them must still agree with it.
    const anchors = await deps.auditAnchors.list(assetId);
    const anchorConsistent = anchors.every((a) => {
      const at = chain.find((e) => e.seq === a.seq);
      return !!at && auditEntryHash(at.prevHash, at.fields) === a.hash;
    });
    return { assetId, valid: base.valid, count: base.count, head: base.head, brokenAt: base.brokenAt, reason: base.reason ?? null, lastAnchor: anchor ? { seq: anchor.seq, hash: anchor.hash, txHash: anchor.txHash, chainId: anchor.chainId, at: anchor.createdAt } : null, anchorConsistent };
  }


  // Find-by-name-or-create an ACTIVE, verified org with a fresh custodial DID.
  // Extracted from POST /orgs (below) so the template provisioner can reuse the
  // EXACT create internals (seed → encrypt → on-chain register → persist →
  // audit). Idempotent on name: an existing org is returned untouched, which is
  // what makes provisioning re-runnable. Throws coded(502) on registry failure;
  // callers map that to the same 502 the direct route returned (the shared error
  // handler only maps 4xx CodedErrors, so a 502 must be caught explicitly).
  async function ensureOrg(
    name: string,
    orgType: OrgType,
    opts: { registrationId?: string | null; jurisdiction?: string | null; actorId?: string } = {},
  ): Promise<OrganizationRecord> {
    const existing = await deps.organizations.findByName(name);
    if (existing) {
      // THE CATCH-UP, and it is deliberately BEST-EFFORT: an org whose DID was
      // never registered on-chain (e.g. created before a registry was
      // configured) gets caught up here. Check-then-register for the same
      // reason `POST /orgs/:id/approve` does it — `registerDid` reverts
      // AlreadyRegistered — so for every already-registered org this is a
      // single read that changes nothing. A failure is LOGGED AND SWALLOWED
      // rather than turned into a 502: re-provisioning an existing org
      // succeeded before this line existed and must keep succeeding, or a
      // registry outage would start failing calls that never touched a chain.
      if (deps.registry) {
        try {
          const { registered } = await deps.registry.anchor.didRegistration(deps.registry.didRegistry, existing.did);
          if (!registered) {
            await deps.registry.anchor.registerDid(deps.registry.didRegistry, existing.did);
            await deps.audit.append({ actorId: opts.actorId ?? "provisioning", action: "org-did-registered" as LifecycleAction, payload: { orgId: existing.id, did: existing.did, reason: "deferred registration on re-provision" } });
          }
        } catch (err) {
          app.log.error({ err, orgId: existing.id }, "deferred org DID registration failed — continuing (the org is unchanged)");
        }
      }
      return existing;
    }
    const seed = deps.keystore.newSeed();
    const didSeedEncrypted = deps.keystore.encryptSeed(seed);
    const did = deps.keystore.keyOf(didSeedEncrypted).did;
    // Register on-chain BEFORE persisting, so a chain failure needs no rollback:
    // nothing has been written yet. (Contrast mintMembership, which must delete
    // the user row because the row precedes the VC.)
    if (deps.registry) {
      try {
        await deps.registry.anchor.registerDid(deps.registry.didRegistry, did);
      } catch (err) {
        app.log.error({ err }, "org DID registration failed");
        throw coded(502, "REGISTRY_UNAVAILABLE", "could not register the organization's DID on-chain — no organization was created");
      }
    }
    const org = await deps.organizations.create({
      name, orgType, registrationId: opts.registrationId ?? null, jurisdiction: opts.jurisdiction ?? null,
      did, didSeedEncrypted, status: "active", verified: true, verifiedAt: new Date().toISOString(), companyProfile: null,
      capabilities: null, // platform-created orgs stay unrestricted legacy until an envelope is set
      brandLogoDocumentId: null, brandAccent: null, // EN-E: a new org starts on the platform look
    });
    // `didRegistered` is in the trail because "this org's DID is not on the
    // registry" is otherwise invisible: nothing on the record says so, and a
    // reader looking at an unresolvable DID months later has no other way to
    // learn whether it was withheld on purpose or a registration failed.
    await deps.audit.append({ actorId: opts.actorId ?? "provisioning", action: "org-created" as LifecycleAction, payload: { orgId: org.id, name: org.name, did: org.did, didRegistered: true } });
    return org;
  }


  /** Enriched held-credential projection: adds the use case + the issuer org's
   *  name (memoised per call), shared by /me/credentials and the org wallet. */
  async function mapHeld(rows: CredentialRecord[]) {
    const names = new Map<string, Promise<string | null>>();
    const nameOf = (did: string): Promise<string | null> => {
      if (!names.has(did)) names.set(did, deps.organizations.findByDid(did).then((o) => o?.name ?? null));
      return names.get(did)!;
    };
    const ucs = new Map<string, Promise<CredentialUseCaseDefinition | null>>();
    const ucOf = (key: string): Promise<CredentialUseCaseDefinition | null> => {
      if (!ucs.has(key)) ucs.set(key, deps.credentialUseCases.get(key).catch(() => null));
      return ucs.get(key)!;
    };
    const certOk = async (c: CredentialRecord): Promise<boolean> => {
      if (c.acceptance !== "accepted") return false;
      if (!c.credentialUseCaseKey) return false;
      const def = await ucOf(c.credentialUseCaseKey);
      if (!def) return false;
      const typeNames = c.type.split(",");
      return def.credentialTypes.some((t) => typeNames.includes(t.name) && t.certificate?.enabled === true);
    };
    return Promise.all(rows.map(async (c) => ({
      id: c.id, type: c.type.split(","), credentialUseCaseKey: c.credentialUseCaseKey,
      issuerDid: c.issuerDid, issuerName: await nameOf(c.issuerDid), holderDid: c.holderDid,
      claims: c.subjectClaims, issuedAt: c.issuedAt, expiresAt: c.expiresAt,
      revoked: c.revoked, revokedAt: c.revokedAt, revokedReason: c.revokedReason, vcJwt: c.vcJwt,
      certificateAvailable: await certOk(c),
      acceptance: c.acceptance, acceptanceAt: c.acceptanceAt, acceptanceNote: c.acceptanceNote,
      anchorTxHash: c.anchorTxHash, anchorChainId: c.anchorChainId, revokeTxHash: c.revokeTxHash,
    })));
  }


  // --- identity (DID / Verifiable Credentials) ------------------------------

  // Loads the target user and enforces the SAME scope guard as PATCH /users/:id
  // — literally so: it calls `canAdministerUser`, the one predicate all four
  // administer-an-existing-account routes share. This was a FOURTH inline copy
  // of that expression (it carried the same PlatformAdmin-deletable hole) and
  // is deliberately no longer written out, so the next tightening cannot miss it.
  // 404 (via notFound) when missing; 403 when out of scope. Null ⇒ reply sent.
  async function manageableTarget(request: FastifyRequest, reply: FastifyReply): Promise<UserRecord | null> {
    const claims = request.user as TokenClaims;
    const target = await deps.users.findById((request.params as { id: string }).id);
    if (!target) {
      notFound(reply, "user not found");
      return null;
    }
    if (!canAdministerUser(claims, target)) {
      reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to manage that user" });
      return null;
    }
    return target;
  }


  // Run the finalized proposal's operation as the PROPOSER's identity (RBAC +
  // engine compliance re-apply to the proposer at execution time).
  /**
   * Credential material that must never leave the server, at ANY depth of a
   * proposal payload. `onboard-user` parks a bcrypt hash of the new human's
   * password in its payload (deliberately — plaintext must not enter the
   * proposal store), and `onboard-user-batch` parks one PER ROW. A hash is an
   * offline-crackable credential, and it is never evidence an approver needs, so
   * it is stripped from every projection — for humans as well as keys. The
   * executor reads the STORED record, not this view.
   */
  const REDACTED_PAYLOAD_KEYS = new Set(["passwordHash"]);

  function redactPayload(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactPayload);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([k]) => !REDACTED_PAYLOAD_KEYS.has(k))
          .map(([k, v]) => [k, redactPayload(v)]),
      );
    }
    return value;
  }


  /** The ONE projection of a proposal onto the wire. Every send site uses it. */
  function proposalView(p: ProposalRecord): ProposalRecord {
    return { ...p, payload: redactPayload(p.payload) as Record<string, unknown> };
  }


  return { principal, auth, authScoped, loginThrottled, proposeIfGated, orgScoped, resolveUseCaseDomain, useCaseKeysByDomain, linkedWallet, orgMemberCapabilityViolation, brandLogoRefusal, proposalView, ensureOrg, manageableTarget, mapHeld, isRenderableArtwork, RENDERABLE_ARTWORK_TYPES, assetChain, verifyAsset, redactPayload };
}

/** What every `register*Routes` receives. */
export type RouteContext = ReturnType<typeof buildRouteContext>;
