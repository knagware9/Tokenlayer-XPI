import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyRecord, AssetRecord, CashflowRecord, CompanyProfile, CredentialRecord, KybDocumentRef, KycDetails, KycStatus, ListingRecord, OrganizationRecord, ProposalRecord, UserRecord, VerificationRequestRecord, WebhookEndpointRecord } from "../persistence/types.js";
import { ListingConflictError } from "../persistence/types.js";
import { assignableRoles, auditEntryHash, canCreateOrgMember, canCreateUser, canManageUsers, computeCashflowSchedule, CREDENTIAL_TEMPLATES, CREDENTIAL_TYPES, credentialTypeDef, credentialUseCaseType, decodeJwt, didKeyFromSeed, generateDidKey, holderPolicyAllows, instantiateTemplate, invoiceFingerprint, issueCredential, issuerBindingAllows, normalizeUseCaseDefinition, ORG_OPERATING_ROLES, orgDomainEnabled, orgRoleEnabled, PolicyError, presentCredential, presentCredentials, splitProRata, TEMPLATE_CATALOG, useCaseDomainOf, validateCredentialUseCase, validateEventTypes, validateMetadata, scopeAllows, validateOrgCapabilities, validateScopes, validateTemplate, verifierBindingAllows, verifyChain, verifyDidSignature, verifyPresentation, verifyPresentationCredentials, type Actor, type ApiScope, type ChainEntry, type CredentialUseCaseDefinition, type LifecycleAction, type OrgDomain, type OrgOperatingRole, type OrgType, type Role, type UseCaseDefinition, type UseCaseTemplate } from "@tokenlayer/core";
import qrcode from "qrcode";
import type { AppDeps } from "../context.js";
import { renderCredentialCertificate } from "../certificate.js";
import { isSupportedCurrency } from "../currencies.js";
import { renderContractCode } from "../contract-code.js";
import { deployAndCreateUseCase } from "../use-cases.js";
import { computeAnalytics } from "../analytics.js";
import { computeIdentityDashboard } from "../identity-analytics.js";
import { issueCredentialFor, revokeCredentialById } from "../credential-issuance.js";
import { emitEvent, ownerOrgOfUseCase } from "../events.js";
import { mintOrgMembership } from "../membership.js";
import { ensurePlatformIssuerOrg, PLATFORM_ORG_NAME } from "../platform-org.js";
import { computeActivity, computePortfolio } from "../investor.js";
import { readErpInvoices, stageInvoice } from "../invoice-register.js";
import { assetBalancesOf, coded, CodedError, dropPayerShare, executeCashflowCore, executeIssueActivation, runGatedAction } from "../executors.js";
import { proposalKind } from "../proposal-kinds.js";
import type { OnboardUserPayload } from "../user-kinds.js";
import { resolveDid } from "../did-resolver.js";
import { checkUrl } from "../webhooks/url-guard.js";
import { API_KEY_BCRYPT_ROUNDS, invalidateVerifiedPrefix, mintSecret } from "../api-keys.js";
import { S } from "./schemas.js";
import { actorOf, claimsOf, contextOf, isPositiveIntString, machinePrincipal, notFound, requirePrincipal, requireScope, scopedToCaller, type TokenClaims } from "./support.js";

const NO_USE_CASE = "__none__"; // sentinel: a use-case key that matches no real use case (denies scoped users with no assigned use case)

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
function canAdministerUser(claims: TokenClaims, target: UserRecord): boolean {
  if (claims.role === "PlatformAdmin") return true;
  if (!canManageUsers(claims.role)) return false;
  if (target.role === "PlatformAdmin" || target.role === "OrgAdmin" || target.role === "UseCaseAdmin") return false;
  if ((target.useCaseKey ?? NO_USE_CASE) !== (claims.useCaseKey ?? NO_USE_CASE)) return false;
  if (claims.useCaseKey === null) return Boolean(claims.orgId) && (target.orgId ?? null) === claims.orgId;
  return true;
}

const BCRYPT_ROUNDS = 12;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const MAX_DOC_BYTES = 5 * 1024 * 1024;
// A 5MB document is ~6.8MB as base64 JSON — upload routes override the app-global
// 256KB bodyLimit with this (the decoded bytes are still capped at MAX_DOC_BYTES).
const DOC_UPLOAD_BODY_LIMIT = 8 * 1024 * 1024;
// Allowlisted document content types — stored bytes are served back later, so an
// arbitrary type (e.g. text/html) would enable stored XSS on the API origin.
const ALLOWED_DOC_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain"]);

/**
 * Validate and store one base64 document upload. Shared by the authenticated
 * store and the public KYB route so their error surface cannot drift. Throws
 * coded 415/400/413 (mapped by the global error handler).
 */
async function storeUploadedDocument(
  documents: AppDeps["documents"],
  body: { contentType: string; dataBase64: string },
): Promise<{ id: string; sha256: string; size: number }> {
  if (!ALLOWED_DOC_TYPES.has(body.contentType)) {
    throw coded(415, "UNSUPPORTED_DOCUMENT_TYPE", `contentType must be one of: ${[...ALLOWED_DOC_TYPES].join(", ")}`);
  }
  const bytes = Buffer.from(body.dataBase64, "base64");
  if (bytes.length === 0) throw coded(400, "BAD_DOCUMENT", "empty document");
  if (bytes.length > MAX_DOC_BYTES) throw coded(413, "DOCUMENT_TOO_LARGE", `max ${MAX_DOC_BYTES} bytes`);
  return documents.create({ contentType: body.contentType, bytes });
}

// Extract the inner VC's `jti` (credential id) from a VP-JWT, or null on any
// malformed input. Used to record the verified credential's id on the user.
function decodeVcJti(vpJwt: string): string | null {
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
function devKeyFromSeed(seed: string) {
  return didKeyFromSeed(createHash("sha256").update(seed).digest());
}

// Public projection of an org — NEVER includes didSeedEncrypted.
function orgView(o: OrganizationRecord) {
  return { id: o.id, name: o.name, orgType: o.orgType, registrationId: o.registrationId, jurisdiction: o.jurisdiction, did: o.did, verified: o.verified, status: o.status, companyProfile: o.companyProfile, capabilities: o.capabilities, createdAt: o.createdAt };
}

// EN-A: uniform 403 for an act outside an org's capability envelope. `missing`
// names the absent capability — a domain ("tokenization"/"identity") or an
// operating role ("Issuer"/"Holder"/"Verifier"). Only ever sent for an org with
// an EXPLICIT envelope: the null (legacy) envelope passes every predicate.
function orgCapabilityMissing(reply: FastifyReply, org: OrganizationRecord, missing: string) {
  return reply.code(403).send({
    error: "ORG_CAPABILITY_MISSING",
    message: `organization '${org.name}' does not have the '${missing}' capability`,
    details: { orgId: org.id, missing },
  });
}

/** Registers every /api/v1 route on the given (prefixed) instance. */
export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  // ONE preHandler instance: it owns the per-key rate-limit and failed-attempt
  // counters, so every route must share it rather than build its own.
  const principal = requirePrincipal(deps);
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

  // Loads an asset and enforces use-case scope. Returns null after sending the
  // right error (404 for reads to hide existence; 403 for actions).
  async function scopedAsset(request: FastifyRequest, reply: FastifyReply, mode: "read" | "act"): Promise<AssetRecord | null> {
    const { id } = request.params as { id: string };
    const asset = await deps.assets.get(id);
    if (!asset) {
      notFound(reply, "asset not found");
      return null;
    }
    if (!scopedToCaller(request.user as TokenClaims, asset.useCaseKey)) {
      if (mode === "read") notFound(reply, "asset not found");
      else reply.code(403).send({ error: "WRONG_USE_CASE", message: "asset belongs to another use case" });
      return null;
    }
    return asset;
  }

  // Accounts visible to the caller: a PlatformAdmin sees all; a scoped user sees only
  // the wallets linked to users in their own use case (no cross-tenant account enumeration).
  async function scopedAccounts(claims: TokenClaims) {
    const all = await deps.accounts.list();
    if (claims.role === "PlatformAdmin") return all;
    const users = await deps.users.list(claims.useCaseKey ?? NO_USE_CASE);
    const allowed = new Set(users.map((u) => u.accountId).filter((id): id is string => !!id));
    return all.filter((a) => allowed.has(a.id));
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

  // A verification request is driveable by its verifier ORG (the existing path)
  // OR by a use-case-scoped Verifier desk user whose useCaseKey matches the
  // request's credential use case (the additive F5 path). The scoped verifier
  // owns no org, so a request they raised carries verifierOrgId "" and is bound
  // to the use case via credentialUseCaseKey.
  function verifierScoped(claims: TokenClaims, r: VerificationRequestRecord): boolean {
    return orgScoped(claims, r.verifierOrgId)
      || (claims.role === "Verifier" && !!r.credentialUseCaseKey && claims.useCaseKey === r.credentialUseCaseKey);
  }

  // Resolve a use-case key to its product domain the SAME way GET /me does —
  // shared by the login + QR-poll responses (which populate the web SessionUser)
  // and the /me handler, so the domain a session carries never drifts. Null when
  // the user has no use-case key (e.g. a PlatformAdmin) or the key names neither.
  async function resolveUseCaseDomain(useCaseKey: string | null): Promise<"tokenization" | "identity" | null> {
    if (!useCaseKey) return null;
    const [tks, cks] = await Promise.all([deps.useCases.list(), deps.credentialUseCases.list()]);
    return useCaseDomainOf(useCaseKey, {
      tokenizationKeys: tks.map((u) => u.key),
      credentialKeys: cks.map((u) => u.key),
    }) ?? null;
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

  // --- auth ---------------------------------------------------------------
  app.post("/auth/login", { schema: S.login }, async (request, reply) => {
    if (loginThrottled(request.ip)) {
      return reply.code(429).send({ error: "TOO_MANY_REQUESTS", message: "too many login attempts; try again later" });
    }
    const { email, password } = request.body as { email: string; password: string };
    const user = await deps.users.findByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "invalid credentials" });
    }
    if (!user.active) {
      return reply.code(401).send({ error: "ACCOUNT_SUSPENDED", message: "this account is suspended" });
    }
    // A service user exists only to back an API key: it must never be drivable
    // interactively, so its (random, unguessable) password hash is not a way in.
    if (user.kind === "service") {
      return reply.code(403).send({ error: "SERVICE_ACCOUNT", message: "this is a service account; authenticate with its API key" });
    }
    const claims: TokenClaims = claimsOf(user);
    const wallet = user.accountId ? await deps.accounts.findById(user.accountId) : null;
    const useCaseDomain = await resolveUseCaseDomain(user.useCaseKey);
    // The org's capability envelope rides the session (like useCaseDomain): the
    // web builds its SessionUser from login/qr-poll, never /me.
    const org = user.orgId ? await deps.organizations.get(user.orgId) : null;
    return { token: app.jwt.sign(claims), user: { ...claims, walletAddress: wallet?.address ?? null, useCaseDomain, orgCapabilities: org?.capabilities ?? null } };
  });

  app.get("/me", { schema: S.me, ...auth }, async (request) => {
    const base = actorOf(request);
    const claims = request.user as TokenClaims;
    const useCaseDomain = await resolveUseCaseDomain(claims.useCaseKey);
    const org = claims.orgId ? await deps.organizations.get(claims.orgId) : null;
    // useCaseKey mirrors the login response so a scoped desk operator's session
    // principal is self-describing (role + scope + domain) from /me alone.
    return { ...base, useCaseKey: claims.useCaseKey ?? null, useCaseDomain, orgCapabilities: org?.capabilities ?? null };
  });

  app.get("/config", { schema: S.config, ...auth }, async () => ({ domains: deps.enabledDomains }));

  // --- passwordless device login keys -------------------------------------
  app.post("/me/login-keys", { schema: S.enrollLoginKey, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { did: string; label: string };
    // A machine principal has no device to enrol, and enrolment would leave a
    // durable artifact the org never sees: a LoginKey row holding a private key
    // the caller alone controls, surviving revocation of the API key and absent
    // from the Developers surface (which lists API keys, not login keys). Gate
    // on request.apiKey — the in-request machine signal — NOT on the user's
    // kind: TokenClaims deliberately carries no `kind`, and this is strictly
    // broader anyway, also covering a key bound to a human user.
    if (request.apiKey !== undefined) {
      return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key cannot enrol a device login key" });
    }
    if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(b.did)) return reply.code(400).send({ error: "BAD_DID", message: "expected a did:key ed25519" });
    if (await deps.loginKeys.getByDid(b.did)) return reply.code(409).send({ error: "KEY_ENROLLED", message: "this device key is already enrolled" });
    const rec = await deps.loginKeys.create({ userId: claims.id, did: b.did, label: b.label });
    return reply.code(201).send({ id: rec.id, did: rec.did, label: rec.label, createdAt: rec.createdAt });
  });

  app.get("/me/login-keys", { schema: S.listLoginKeys, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    return (await deps.loginKeys.listByUser(claims.id)).map((k) => ({ id: k.id, did: k.did, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt }));
  });

  app.delete("/me/login-keys/:id", { schema: S.removeLoginKey, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const rec = await deps.loginKeys.get(id);
    if (!rec || rec.userId !== claims.id) return notFound(reply, "login key not found");
    await deps.loginKeys.remove(id);
    return reply.code(204).send();
  });

  // --- passwordless QR login (public) -------------------------------------
  app.post("/auth/qr/start", { schema: S.qrStart }, async () => {
    const sess = deps.qrLogin.start();
    const signUrl = `${deps.publicWebUrl}/qr-sign?session=${sess.id}&challenge=${encodeURIComponent(sess.challenge)}`;
    const qrSvg = await qrcode.toString(signUrl, { type: "svg", margin: 1, width: 240 });
    return { sessionId: sess.id, challenge: sess.challenge, signUrl, qrSvg, expiresAt: sess.expiresAt };
  });

  app.get("/auth/qr/:id", { schema: S.qrPoll }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const sess = deps.qrLogin.get(id);
    if (!sess) return notFound(reply, "login session not found");
    if (sess.status === "authenticated") {
      const done = deps.qrLogin.consume(id); // release the token exactly once
      if (done?.token && done.userId) {
        const user = await deps.users.findById(done.userId);
        const wallet = user?.accountId ? await deps.accounts.findById(user.accountId) : null;
        const claims: TokenClaims | null = user ? claimsOf(user) : null;
        const useCaseDomain = user ? await resolveUseCaseDomain(user.useCaseKey) : null;
        const org = user?.orgId ? await deps.organizations.get(user.orgId) : null;
        return { status: "authenticated", token: done.token, user: claims ? { ...claims, walletAddress: wallet?.address ?? null, useCaseDomain, orgCapabilities: org?.capabilities ?? null } : null };
      }
    }
    return { status: sess.status };
  });

  app.post("/auth/qr/:id/authenticate", { schema: S.qrAuthenticate }, async (request, reply) => {
    if (loginThrottled(request.ip)) return reply.code(429).send({ error: "TOO_MANY_REQUESTS", message: "too many attempts; try again later" });
    const { id } = request.params as { id: string };
    const b = request.body as { did: string; signature: string };
    const sess = deps.qrLogin.get(id);
    if (!sess) return notFound(reply, "login session not found");
    if (sess.status !== "pending") return reply.code(410).send({ error: "SESSION_EXPIRED", message: `session is ${sess.status}` });
    const key = await deps.loginKeys.getByDid(b.did);
    if (!key) return reply.code(401).send({ error: "UNKNOWN_KEY", message: "device key is not enrolled" });
    if (!verifyDidSignature(b.did, `qr-login:${sess.id}:${sess.challenge}`, b.signature)) {
      return reply.code(401).send({ error: "BAD_SIGNATURE", message: "signature does not verify" });
    }
    const user = await deps.users.findById(key.userId);
    if (!user || !user.active) return reply.code(401).send({ error: "ACCOUNT_SUSPENDED", message: "account unavailable" });
    // The SAME refusal as POST /auth/login, because this is the API's OTHER
    // JWT-minting path. Without it a key holder could enrol a device key for its
    // own service user and trade the key for a durable human session that
    // outlives revocation of the key — an escalation, not a convenience.
    if (user.kind === "service") {
      return reply.code(403).send({ error: "SERVICE_ACCOUNT", message: "this is a service account; authenticate with its API key" });
    }
    const claims: TokenClaims = claimsOf(user);
    const token = app.jwt.sign(claims);
    if (!deps.qrLogin.authenticate(id, { userId: user.id, token })) return reply.code(410).send({ error: "SESSION_EXPIRED", message: "session no longer pending" });
    await deps.loginKeys.touch(key.id, new Date().toISOString());
    return { ok: true };
  });

  // --- catalog ------------------------------------------------------------
  app.get("/chains", { schema: S.chains, ...auth }, async () => deps.chains.list());
  app.get("/chains/:id/status", { schema: S.chainStatus, ...auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // probe() only throws for an unknown/absent chain (no adapter) — an
    // unreachable network is a 200 with { reachable: false, error }.
    try {
      return await deps.chains.probe(id);
    } catch (err) {
      return notFound(reply, (err as Error).message);
    }
  });
  app.get("/currencies", { schema: S.currencies, ...auth }, async () => deps.currencies);
  app.get("/accounts", { schema: S.accounts, ...authScoped("assets:read") }, async (request) => scopedAccounts(request.user as TokenClaims));

  app.get("/use-cases", { schema: S.listUseCases, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    const all = await deps.useCases.list();
    if (claims.role === "PlatformAdmin") return all;
    if (claims.role === "OrgAdmin") return all.filter((u) => u.ownerOrgId != null && u.ownerOrgId === claims.orgId);
    return all.filter((u) => u.key === claims.useCaseKey);
  });
  app.get("/use-cases/:key", { schema: S.getUseCase, ...auth }, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!scopedToCaller(request.user as TokenClaims, key)) return notFound(reply, `unknown use case '${key}'`);
    if (!(await deps.useCases.has(key))) return notFound(reply, `unknown use case '${key}'`);
    return deps.useCases.get(key);
  });
  app.post("/use-cases", { schema: S.createUseCase, ...authScoped("usecases:provision") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    // A PlatformAdmin creates directly (201); an active OrgAdmin proposes an
    // org-owned use case for a PlatformAdmin to approve (maker-checker, 202).
    if (claims.role !== "PlatformAdmin" && !(claims.role === "OrgAdmin" && claims.orgId)) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin or an Org Admin may create use cases" });
    }
    // Normalise (validates shape + fills tokenType) before deploying so an invalid
    // definition fails fast without deploying any contract.
    let definition: UseCaseDefinition;
    try {
      definition = normalizeUseCaseDefinition(request.body as UseCaseDefinition);
    } catch (err) {
      if (err instanceof PolicyError) return reply.code(400).send({ error: err.code, message: err.message });
      throw err;
    }
    // A slug is unique across BOTH domains: reject a key already taken by a
    // credential use case (the credential-side route symmetrically checks this
    // repo too). Applies to both the OrgAdmin proposal and PlatformAdmin paths.
    if (await deps.credentialUseCases.has(definition.key)) {
      return reply.code(409).send({ error: "KEY_TAKEN", message: `use-case key '${definition.key}' already exists` });
    }
    // OrgAdmin: gated. Stamp ownerOrgId from the caller's own claims (never the
    // client body) AFTER normalising, and park a create-use-case proposal for a
    // PlatformAdmin to approve — the deploy happens on approval, not here.
    if (claims.role === "OrgAdmin") {
      if (await deps.useCases.has(definition.key)) return reply.code(409).send({ error: "USECASE_EXISTS", message: `use case '${definition.key}' already exists` });
      // EN-A friendly early gate: OWNING a tokenization use case requires the
      // tokenization domain. The create-use-case executor re-checks at approval
      // time (the envelope may tighten while the proposal is pending).
      const ownOrg = await deps.organizations.get(claims.orgId as string).catch(() => null);
      if (ownOrg && !orgDomainEnabled(ownOrg.capabilities, "tokenization")) {
        return orgCapabilityMissing(reply, ownOrg, "tokenization");
      }
      const owned = { ...definition, ownerOrgId: claims.orgId as string };
      const proposal = await deps.proposals.create({
        useCaseKey: null, orgId: claims.orgId as string, assetId: null, kind: "create-use-case",
        payload: owned as unknown as Record<string, unknown>,
        proposerId: claims.id, proposerLabel: claims.email, required: 1,
      });
      return reply.code(202).send({ proposal: proposalView(proposal) });
    }
    // PlatformAdmin: deploy the use case's contract on each allowed chain that is
    // available in the registry (fabric is always available in the simulated stack)
    // and persist it. Best-effort per chain: a failure leaves that chain pending;
    // at least one success is required (NO_DEPLOYABLE_CHAIN via the shared helper,
    // mapped to 400 by the global error handler). Same path the proposal executes.
    const available = new Set(deps.chains.list().map((c) => c.id));
    const created = await deployAndCreateUseCase(
      deps.useCases,
      definition,
      available,
      (def, chainId) => deps.engine.deployUseCaseContract(def, chainId),
      (m) => request.log.warn(m),
    );
    return reply.code(201).send(created);
  });

  // The contract code that backs a use case on one allowed chain — the real
  // Solidity source for EVM families, a truthful contract model for the
  // simulated ones. Same visibility as GET /use-cases/:key (scoped read).
  app.get("/use-cases/:key/code", { schema: S.useCaseCode, ...auth }, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!scopedToCaller(request.user as TokenClaims, key)) return notFound(reply, `unknown use case '${key}'`);
    if (!(await deps.useCases.has(key))) return notFound(reply, `unknown use case '${key}'`);
    const useCase = await deps.useCases.get(key);
    const { chainId } = request.query as { chainId: string };
    if (!useCase.allowedChainIds.includes(chainId)) {
      return reply.code(400).send({ error: "CHAIN_NOT_ALLOWED", message: `chain '${chainId}' is not in the allowed chains for '${key}'` });
    }
    // Family/mode come from the catalog: an absent-but-known chain (configured:false)
    // still renders — the code shows what WILL deploy once the chain is online.
    const info = deps.chains.list().find((c) => c.id === chainId);
    if (!info) return notFound(reply, `unknown chain '${chainId}'`);
    const code = renderContractCode({
      tokenStandard: useCase.tokenStandard, symbol: useCase.symbol, name: useCase.name,
      allowlist: useCase.compliance.allowlist, chainFamily: info.family, mode: info.mode,
    });
    const deployed = useCase.contracts?.[chainId];
    return { chainId, family: info.family, mode: info.mode, ...code, ...(deployed ? { deployed } : {}) };
  });

  // Same renderer, pre-create (the wizard's Review step) — nothing is persisted.
  app.post("/use-cases/preview-code", { schema: S.previewUseCaseCode, ...auth }, async (request, reply) => {
    const { tokenStandard, symbol, name, allowlist, chainId } =
      request.body as { tokenStandard: string; symbol: string; name: string; allowlist?: boolean; chainId: string };
    const info = deps.chains.list().find((c) => c.id === chainId);
    if (!info) return reply.code(400).send({ error: "CHAIN_NOT_ALLOWED", message: `unknown chain '${chainId}' — not in the chain catalog` });
    const code = renderContractCode({ tokenStandard, symbol, name, allowlist: allowlist ?? true, chainFamily: info.family, mode: info.mode });
    return { chainId, family: info.family, mode: info.mode, ...code };
  });

  app.post("/use-cases/:key/deploy", { schema: S.deployUseCase, ...authScoped("usecases:provision") }, async (request, reply) => {
    if ((request.user as TokenClaims).role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may deploy use-case contracts" });
    const { key } = request.params as { key: string };
    if (!(await deps.useCases.has(key))) return notFound(reply, `unknown use case '${key}'`);
    const useCase = await deps.useCases.get(key);
    const { chainId } = request.body as { chainId: string };
    if (!useCase.allowedChainIds.includes(chainId)) {
      return reply.code(400).send({ error: "CHAIN_NOT_ALLOWED", message: `chain '${chainId}' is not in the allowed chains for '${key}'` });
    }
    if (useCase.contracts?.[chainId]) {
      return reply.code(400).send({ error: "ALREADY_DEPLOYED", message: `'${key}' already has a contract deployed on chain '${chainId}'` });
    }
    let contract;
    try {
      contract = await deps.engine.deployUseCaseContract(useCase, chainId);
    } catch (err) {
      return reply.code(502).send({ error: "DEPLOY_FAILED", message: `deploy of '${key}' on chain '${chainId}' failed: ${(err as Error).message}` });
    }
    const merged = { ...useCase, contracts: { ...(useCase.contracts ?? {}), [chainId]: contract } };
    return deps.useCases.update(key, merged);
  });

  app.put("/use-cases/:key", { schema: S.updateUseCase, ...authScoped("usecases:provision") }, async (request, reply) => {
    if ((request.user as TokenClaims).role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may edit use cases" });
    const { key } = request.params as { key: string };
    if (!(await deps.useCases.has(key))) return notFound(reply, `unknown use case '${key}'`);
    const existing = await deps.useCases.get(key);
    const existingContracts = existing.contracts ?? {};
    const hasDeployed = Object.keys(existingContracts).length > 0;

    let incoming: UseCaseDefinition;
    try {
      // Preserve deployed contracts: never let an update wipe them.
      incoming = normalizeUseCaseDefinition({ ...(request.body as UseCaseDefinition), key, contracts: existingContracts });
    } catch (err) {
      if (err instanceof PolicyError) return reply.code(400).send({ error: err.code, message: err.message });
      throw err;
    }
    // Once any contract is deployed, the contract-defining fields are immutable.
    if (hasDeployed) {
      if (incoming.tokenStandard !== existing.tokenStandard || incoming.symbol !== existing.symbol) {
        return reply.code(400).send({ error: "IMMUTABLE_FIELD", message: "tokenStandard and symbol cannot change once a contract is deployed" });
      }
      // Cannot remove an allowedChainId that has a deployed contract.
      const removed = Object.keys(existingContracts).filter((c) => !incoming.allowedChainIds.includes(c));
      if (removed.length > 0) {
        return reply.code(400).send({ error: "IMMUTABLE_FIELD", message: `cannot remove chain(s) with a deployed contract: ${removed.join(", ")}` });
      }
    }
    return deps.useCases.update(key, incoming);
  });

  // --- credential use cases (Identity domain) -----------------------------
  // The DID/VC parallel of token use cases: configurable custom credential types
  // + Issuer/Holder/Verifier bindings. Reads are open to authed users; authoring
  // is PlatformAdmin-only. A slug is either a token or a credential use case.
  app.get("/credential-templates", { schema: S.credentialTemplates, ...auth }, async () => CREDENTIAL_TEMPLATES);

  app.get("/credential-use-cases", { schema: S.listCredentialUseCases, ...auth }, async () => deps.credentialUseCases.list());

  app.get("/credential-use-cases/:key", { schema: S.getCredentialUseCase, ...auth }, async (request, reply) => {
    const cuc = await deps.credentialUseCases.get((request.params as { key: string }).key);
    if (!cuc) return notFound(reply, "credential use case not found");
    return cuc;
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
    if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only a platform admin may author credential use cases" });
    const def = request.body as CredentialUseCaseDefinition;
    if (await deps.credentialUseCases.has(def.key) || await deps.useCases.has(def.key)) {
      return reply.code(409).send({ error: "KEY_TAKEN", message: `use-case key '${def.key}' already exists` });
    }
    // Resolve org existence up-front (validator is sync).
    const known = await referencedOrgs(def);
    try {
      validateCredentialUseCase(def, { orgExists: (id) => known.has(id) });
    } catch (err) {
      return reply.code(400).send({ error: "INVALID_CREDENTIAL_USECASE", message: (err as Error).message });
    }
    const violation = await credentialUseCaseCapabilityViolation(def, known);
    if (violation) return orgCapabilityMissing(reply, violation.org, violation.missing);
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
    const def = { ...(request.body as CredentialUseCaseDefinition), key };
    const known = await referencedOrgs(def);
    try {
      validateCredentialUseCase(def, { orgExists: (id) => known.has(id) });
    } catch (err) {
      return reply.code(400).send({ error: "INVALID_CREDENTIAL_USECASE", message: (err as Error).message });
    }
    const ownerOrgId = def.ownerOrgId ?? existing.ownerOrgId ?? null;
    const violation = await credentialUseCaseCapabilityViolation({ ...def, ownerOrgId }, known);
    if (violation) return orgCapabilityMissing(reply, violation.org, violation.missing);
    const updated = await deps.credentialUseCases.update(key, { ...def, ownerOrgId });
    await deps.audit.append({ actorId: claims.id, action: "credential-usecase-updated" as LifecycleAction, payload: { key } });
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

  // Validate + create a credential use case from a fully-bound definition, reusing
  // the SAME checks as POST /credential-use-cases (referenced-org existence,
  // cross-type KEY_TAKEN guard). Throws coded errors the provisioner maps to HTTP.
  async function createCredentialUseCaseFromDef(def: CredentialUseCaseDefinition, ownerOrgId: string, actorId: string) {
    if (await deps.credentialUseCases.has(def.key) || await deps.useCases.has(def.key)) {
      throw coded(409, "KEY_TAKEN", `use-case key '${def.key}' already exists`);
    }
    const known = await referencedOrgs(def);
    try {
      validateCredentialUseCase(def, { orgExists: (id) => known.has(id) });
    } catch (err) {
      throw coded(400, "INVALID_CREDENTIAL_USECASE", (err as Error).message);
    }
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
    const users = await deps.users.list();
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

  // --- assets -------------------------------------------------------------
  // Core issuance logic shared by POST /assets and the invoice-register tokenize
  // endpoint: validation → derive invoiceFingerprint → unique guard → cashflow
  // schedule → issuance fee → engine mint → persist asset + sale terms + cashflows
  // → gated-proposal path → audit. Returns a discriminated result the route maps
  // to reply codes; `input.request` is threaded through solely for proposeIfGated.
  async function issueAssetCore(input: {
    claims: TokenClaims;
    actor: Actor;
    request: FastifyRequest;
    useCaseKey: string; name: string; chainId: string;
    metadata?: Record<string, unknown>; treasuryAccount?: string; initialSupply?: string;
    sale?: { unitPrice: string; currency: string; treasuryAccount: string };
  }): Promise<{ ok: true; status: number; body: unknown } | { ok: false; status: number; error: string; message: string }> {
    const { useCaseKey: bUseCaseKey, name, chainId, metadata, treasuryAccount, initialSupply, sale } = input;
    const claims = input.claims;
    if (claims.role !== "PlatformAdmin" && bUseCaseKey !== claims.useCaseKey) {
      return { ok: false, status: 403, error: "WRONG_USE_CASE", message: "cannot issue into another use case" };
    }
    // Validate sale terms if provided
    if (sale) {
      if (!isSupportedCurrency(sale.currency)) {
        return { ok: false, status: 400, error: "UNSUPPORTED_CURRENCY", message: `currency '${sale.currency}' is not supported` };
      }
      if (!isPositiveIntString(sale.unitPrice)) {
        return { ok: false, status: 400, error: "INVALID_PRICE", message: "unitPrice must be a positive integer" };
      }
    }
    // The treasury holds the initial supply and is the seller for the marketplace.
    const treasury = treasuryAccount ?? sale?.treasuryAccount;
    const wantsSupply = initialSupply !== undefined && initialSupply !== "" && initialSupply !== "0";
    if (wantsSupply) {
      if (!/^\d+$/.test(initialSupply!)) {
        return { ok: false, status: 400, error: "INVALID_SUPPLY", message: "initialSupply must be a whole number" };
      }
      if (!treasury) {
        return { ok: false, status: 400, error: "MISSING_TREASURY", message: "a treasury account is required to mint initial supply" };
      }
    }
    const actor = input.actor;
    const useCase = await deps.useCases.get(bUseCaseKey);
    // Initial supply is fungible-only — reject up front, before charging any fee.
    if (wantsSupply && useCase.tokenType !== "fungible") {
      return { ok: false, status: 400, error: "SUPPLY_UNSUPPORTED", message: "initial supply is only supported for fungible assets" };
    }
    // Gated issuance: the asset is created `pending_approval` (frozen to actions/
    // buy/listings) and its supply mint + sale terms are deferred to approval.
    const gatedIssue = !!useCase.workflow?.approvals?.issue;

    // Resolve issuance metadata: compute any server-derived fields (e.g. the
    // invoice fingerprint) from their source fields, overwriting any client value,
    // then enforce the use case's uniqueness guard. Runs BEFORE the issuance fee so
    // a duplicate is rejected without charging anything.
    const meta: Record<string, unknown> = { ...(metadata ?? {}) };
    if (useCase.derivedFields) {
      for (const [field, gen] of Object.entries(useCase.derivedFields)) {
        if (gen === "invoiceFingerprint") meta[field] = invoiceFingerprint(meta as unknown as Parameters<typeof invoiceFingerprint>[0]);
      }
    }
    // The (useCaseKey, uniqueKey) DB constraint is the authoritative backstop; the
    // pre-check here just avoids ledger side-effects on the common duplicate case.
    const uniqueKey = useCase.uniqueBy ? String(meta[useCase.uniqueBy]) : null;
    if (useCase.uniqueBy) {
      const existing = await deps.assets.findByMetadata(useCase.key, useCase.uniqueBy, meta[useCase.uniqueBy]);
      if (existing) return { ok: false, status: 409, error: "DUPLICATE_ASSET", message: `an asset with this ${useCase.uniqueBy} is already tokenized` };
    }

    // Compute the financial-terms schedule (coupons + redemption) BEFORE the fee
    // charge and the ledger issue: invalid terms metadata must reject the request
    // outright — no fee moves and no ghost asset row is created. Empty when terms
    // are inapplicable for this asset's metadata.
    let schedule: ReturnType<typeof computeCashflowSchedule> = [];
    if (useCase.terms) {
      try {
        schedule = computeCashflowSchedule(useCase.terms, meta, new Date().toISOString());
      } catch (err) {
        if (err instanceof PolicyError) return { ok: false, status: 400, error: err.code, message: err.message };
        throw err;
      }
    }

    // Issuance fee: a flat CBDC amount charged from the issuer's linked cash
    // account to the platform fee account. Applies only when: a fee account is
    // configured, fees.issuanceFlat > 0, and a fee currency is determinable (sale
    // currency, else saleTermsDefault). If no fee currency is determinable, the
    // fee is skipped (issuance proceeds). The fee is REFUNDED if issuance then fails.
    const feeAccount = deps.platformFeeAccount;
    const issuanceFlat = useCase.fees?.issuanceFlat;
    let issuanceFeeCharged: { amount: string; currency: string } | null = null;
    let feePayer: string | undefined;
    if (feeAccount && issuanceFlat && BigInt(issuanceFlat) > 0n) {
      const feeCurrency = sale?.currency ?? useCase.saleTermsDefault?.currency;
      if (feeCurrency && isSupportedCurrency(feeCurrency)) {
        const me = await deps.users.findById(claims.id);
        feePayer = me?.accountId ? (await deps.accounts.findById(me.accountId))?.address : undefined;
        if (!feePayer) {
          return { ok: false, status: 400, error: "NO_WALLET", message: "your account has no linked wallet to pay the issuance fee" };
        }
        if (BigInt(await deps.cash.balanceOf(feeCurrency, feePayer)) < BigInt(issuanceFlat)) {
          return { ok: false, status: 400, error: "INSUFFICIENT_FUNDS", message: `you need ${issuanceFlat} ${feeCurrency} to cover the issuance fee` };
        }
        await deps.cash.transfer(feeCurrency, feePayer, feeAccount, issuanceFlat);
        issuanceFeeCharged = { amount: issuanceFlat, currency: feeCurrency };
      }
    }

    const id = randomUUID();
    let result: Awaited<ReturnType<typeof deps.engine.issue>>;
    try {
      result = await deps.engine.issue(actor, { useCaseKey: bUseCaseKey, chainId, id, metadata: meta });
      await deps.assets.create({
        id,
        useCaseKey: bUseCaseKey,
        name,
        symbol: useCase.symbol,
        chainId,
        contractRef: result.ref.contractRef,
        tokenType: result.tokenType,
        tokenStandard: useCase.tokenStandard,
        metadata: meta,
        status: gatedIssue ? "pending_approval" : "active",
        createdBy: actor.id,
        unitPrice: null,
        currency: null,
        treasuryAccount: null,
        uniqueKey,
      });
      // Materialize the pre-computed financial-terms schedule so the asset
      // carries its cashflow ledger from birth.
      if (schedule.length) await deps.cashflows.createMany(id, useCase.terms!.currency, schedule);

      if (gatedIssue) {
        // Defer supply mint + sale terms to approval; capture them in the proposal.
        const proposal = await proposeIfGated(input.request, useCase, "issue", id, {
          ...(wantsSupply ? { initialSupply, treasury } : {}),
          ...(sale ? { sale } : {}),
          ...(issuanceFeeCharged ? { issuanceFee: { ...issuanceFeeCharged, payer: feePayer } } : {}),
        });
        // `gatedIssue` already established this use case gates "issue", so
        // proposeIfGated cannot have returned null here.
        return { ok: true, status: 202, body: { proposal: proposal ? proposalView(proposal) : null, asset: await deps.assets.get(id) } };
      }
      // Ungated: activate immediately — sale terms + allowlist treasury + mint supply.
      const created = await deps.assets.get(id);
      await executeIssueActivation(deps, actor, created!, {
        initialSupply: wantsSupply ? initialSupply : undefined,
        treasury,
        sale,
      });
    } catch (err) {
      // Issuance failed after the fee moved — refund it so the issuer isn't charged
      // for an asset that was never created (mirrors the buy path's compensation).
      if (issuanceFeeCharged && feePayer && feeAccount) {
        await deps.cash.transfer(issuanceFeeCharged.currency, feeAccount, feePayer, issuanceFeeCharged.amount).catch(() => {});
      }
      // A concurrent issue of the same invoice lost the (useCaseKey, uniqueKey)
      // race: the DB constraint rejected it (Prisma P2002 / memory-repo mirror).
      // Surface the same 409 as the pre-check rather than a generic 500.
      if ((err as { code?: string }).code === "P2002") {
        return { ok: false, status: 409, error: "DUPLICATE_ASSET", message: `an asset with this ${useCase.uniqueBy} is already tokenized` };
      }
      throw err;
    }
    const finalAsset = await deps.assets.get(id);
    // EN-C. Only on the UNGATED path — the gated branch above returned 202 with
    // the asset `pending_approval` and its mint DEFERRED, so nothing has been
    // issued yet and claiming otherwise would be a lie an integrator acts on.
    // The gated issuance surfaces as `proposal.executed` on approval.
    // NOTE `metadata` is deliberately absent: for an invoice use case it is the
    // commercial detail (debtor, amount, terms) and is not the event's business.
    await emitEvent(deps, {
      type: "asset.issued",
      orgId: useCase.ownerOrgId ?? null,
      useCaseKey: bUseCaseKey,
      subjectId: id,
      data: {
        assetId: id, name, useCaseKey: bUseCaseKey, chainId,
        tokenType: result.tokenType, tokenStandard: useCase.tokenStandard,
        symbol: useCase.symbol, contractRef: result.ref.contractRef,
        status: finalAsset?.status ?? null, txHash: result.txHash,
        initialSupply: wantsSupply ? initialSupply : null,
      },
    }, input.request.log);
    return { ok: true, status: 201, body: { asset: finalAsset, txHash: result.txHash, ...(issuanceFeeCharged ? { issuanceFee: issuanceFeeCharged } : {}) } };
  }

  app.post("/assets", { schema: S.issueAsset, ...authScoped("assets:issue") }, async (request, reply) => {
    const b = request.body as { useCaseKey: string; name: string; chainId: string; metadata?: Record<string, unknown>; treasuryAccount?: string; initialSupply?: string; sale?: { unitPrice: string; currency: string; treasuryAccount: string } };
    const r = await issueAssetCore({ claims: request.user as TokenClaims, actor: actorOf(request), request, ...b });
    return r.ok ? reply.code(r.status).send(r.body) : reply.code(r.status).send({ error: r.error, message: r.message });
  });

  // --- invoice register ---------------------------------------------------
  // Staging area in front of the shared issuance path: rows (uploaded / pulled
  // from the ERP / keyed in) are validated + fingerprinted + de-duped, held as
  // StagedInvoice rows, then selectively tokenized through issueAssetCore.
  // Every route is gated on: use-case scope (403 WRONG_USE_CASE), issue
  // capability (403 FORBIDDEN), a known use case (404), and its being an invoice
  // use case (400 NOT_INVOICE_USECASE).
  async function invoiceGate(request: FastifyRequest, reply: FastifyReply): Promise<{ useCase: UseCaseDefinition; claims: TokenClaims; actor: Actor; actorId: string } | null> {
    const claims = request.user as TokenClaims;
    const actor = actorOf(request);
    const { key } = request.params as { key: string };
    if (claims.role !== "PlatformAdmin" && key !== claims.useCaseKey) {
      reply.code(403).send({ error: "WRONG_USE_CASE", message: "cannot manage invoices in another use case" });
      return null;
    }
    if (!deps.rbac.can(actor.role, "issue")) {
      reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to manage invoices" });
      return null;
    }
    const useCase = await deps.useCases.get(key).catch(() => null);
    if (!useCase) { notFound(reply, "use case not found"); return null; }
    if (useCase.derivedFields?.invoiceHash !== "invoiceFingerprint") {
      reply.code(400).send({ error: "NOT_INVOICE_USECASE", message: "this use case does not tokenize invoices" });
      return null;
    }
    return { useCase, claims, actor, actorId: actor.id };
  }

  app.post("/use-cases/:key/invoices/import", { schema: S.importInvoices, ...authScoped("assets:issue") }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const { rows } = request.body as { rows: Record<string, unknown>[] };
    const results: { index: number; status: string; id?: string; error?: string }[] = [];
    for (const [i, meta] of rows.entries()) {
      const r = await stageInvoice(deps, gate.useCase, gate.actorId, "upload", meta, null);
      results.push(r.status === "staged" ? { index: i, status: "staged", id: r.record.id } : { index: i, status: r.status, error: r.error });
    }
    return reply.code(200).send({ staged: results.filter((r) => r.status === "staged").length, results });
  });

  app.post("/use-cases/:key/invoices/pull-erp", { schema: S.pullErp, ...authScoped("assets:issue") }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const rows = readErpInvoices();
    const results: { index: number; status: string; id?: string; error?: string }[] = [];
    for (const [i, meta] of rows.entries()) {
      const r = await stageInvoice(deps, gate.useCase, gate.actorId, "erp", meta, null);
      results.push(r.status === "staged" ? { index: i, status: "staged", id: r.record.id } : { index: i, status: r.status, error: r.error });
    }
    return reply.code(200).send({ staged: results.filter((r) => r.status === "staged").length, results });
  });

  app.post("/use-cases/:key/invoices", { schema: S.addInvoice, ...authScoped("assets:issue") }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const { metadata, documentId } = request.body as { metadata: Record<string, unknown>; documentId?: string };
    let doc: { id: string; sha256: string } | null = null;
    if (documentId) {
      const d = await deps.documents.get(documentId);
      if (!d) return reply.code(400).send({ error: "DOCUMENT_NOT_FOUND", message: "document upload not found" });
      doc = { id: d.id, sha256: d.sha256 };
    }
    const r = await stageInvoice(deps, gate.useCase, gate.actorId, "manual", metadata, doc);
    if (r.status === "staged") return reply.code(201).send(r.record);
    if (r.status === "invalid") return reply.code(400).send({ error: "INVALID_INVOICE", message: r.error });
    return reply.code(409).send({ error: "DUPLICATE_INVOICE", message: r.error });
  });

  app.get("/use-cases/:key/invoices", { schema: S.listInvoices, ...authScoped("assets:read") }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const { status } = request.query as { status?: "staged" | "tokenized" };
    return deps.stagedInvoices.listByUseCase(gate.useCase.key, status);
  });

  app.delete("/use-cases/:key/invoices/:id", { schema: S.deleteInvoice, ...authScoped("assets:issue") }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const { id } = request.params as { key: string; id: string };
    const rec = await deps.stagedInvoices.get(id);
    if (!rec || rec.useCaseKey !== gate.useCase.key) return notFound(reply, "invoice not found");
    if (rec.status !== "staged") return reply.code(409).send({ error: "ALREADY_TOKENIZED", message: "cannot delete a tokenized invoice" });
    await deps.stagedInvoices.remove(id);
    return reply.code(200).send({ id, deleted: true });
  });

  app.post("/use-cases/:key/invoices/tokenize", { schema: S.tokenizeInvoices, ...authScoped("assets:issue") }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const { ids, chainId, treasuryAccount, parValue = 1000, sale } = request.body as { ids: string[]; chainId: string; treasuryAccount: string; parValue?: number; sale?: { unitPrice: string; currency: string } };
    const results: { id: string; status: string; assetId?: string; error?: string }[] = [];
    for (const id of ids) {
      const rec = await deps.stagedInvoices.get(id);
      if (!rec || rec.useCaseKey !== gate.useCase.key || rec.status !== "staged") { results.push({ id, status: "skipped" }); continue; }
      const supply = Math.max(1, Math.round(Number(rec.metadata.amount) / parValue));
      const r = await issueAssetCore({
        claims: gate.claims, actor: gate.actor, request, useCaseKey: gate.useCase.key,
        name: `${rec.metadata.invoiceNumber} · ${rec.metadata.buyerName}`, chainId,
        metadata: rec.metadata, initialSupply: String(supply), treasuryAccount,
        sale: sale ? { unitPrice: sale.unitPrice, currency: sale.currency, treasuryAccount } : undefined,
      });
      if (r.ok) {
        const assetId = (r.body as { asset: { id: string } }).asset.id;
        await deps.stagedInvoices.markTokenized(id, assetId, new Date().toISOString());
        results.push({ id, status: "tokenized", assetId });
      } else {
        results.push({ id, status: "failed", error: r.error });
      }
    }
    return reply.code(200).send({ results });
  });

  app.get("/assets", { schema: S.listAssets, ...authScoped("assets:read") }, async (request) => {
    const claims = request.user as TokenClaims;
    const q = request.query as { useCaseKey?: string; chainId?: string; status?: string; limit: number; offset: number };
    const useCaseKey = claims.role === "PlatformAdmin" ? q.useCaseKey : claims.useCaseKey ?? NO_USE_CASE;
    const { items, total } = await deps.assets.list({ useCaseKey, chainId: q.chainId, status: q.status }, { limit: q.limit, offset: q.offset });
    // Enrich each row with on-chain total supply and the treasury's remaining
    // sellable balance, so the marketplace can show supply + availability.
    const actor = actorOf(request);
    const data = await Promise.all(
      items.map(async (a) => {
        const ctx = contextOf(a);
        const totalSupply = await deps.engine.totalSupply(actor, ctx).catch(() => null);
        const availableSupply = a.treasuryAccount
          ? await deps.engine.balanceOf(actor, ctx, a.treasuryAccount).catch(() => null)
          : null;
        return { ...a, totalSupply, availableSupply };
      }),
    );
    return { data, pagination: { limit: q.limit, offset: q.offset, total } };
  });

  app.get("/assets/:id", { schema: S.getAsset, ...authScoped("assets:read") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    const totalSupply = await deps.engine.totalSupply(actorOf(request), contextOf(asset)).catch(() => null);
    return { ...asset, totalSupply };
  });

  app.get("/assets/:id/accounts", { schema: S.assetAccounts, ...authScoped("assets:read") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    const claims = request.user as TokenClaims;
    const adapter = deps.chains.resolveAdapter(asset.chainId);
    const ref = contextOf(asset).ref;
    // Accounts linked to this use case's users (null = PlatformAdmin sees all).
    const linked = claims.role === "PlatformAdmin" ? null : new Set((await scopedAccounts(claims)).map((a) => a.id));
    const all = await deps.accounts.list();
    const rows = await Promise.all(
      all.map(async (acct) => ({
        id: acct.id,
        address: acct.address,
        label: acct.label,
        balance: await adapter.balanceOf(ref, acct.address).catch(() => "0"),
        frozen: await adapter.isFrozen(ref, acct.address).catch(() => false),
        allowed: await adapter.isAllowed(ref, acct.address).catch(() => false),
      })),
    );
    // Show accounts in the caller's use case, plus any account genuinely related to
    // this asset (a holder, allowlisted, or frozen) — never the full cross-tenant roster.
    return rows
      .filter((r) => linked === null || linked.has(r.id) || r.allowed || r.frozen || r.balance !== "0")
      .map(({ id, ...rest }) => rest);
  });

  app.get("/assets/:id/tokens", { schema: S.assetTokens, ...authScoped("assets:read") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    if (asset.tokenType !== "nonfungible") return [];
    const adapter = deps.chains.resolveAdapter(asset.chainId);
    const ref = contextOf(asset).ref;
    // Only actual token owners are emitted below, so the full account list is safe here.
    const accounts = await deps.accounts.list();
    const tokens: { tokenId: string; owner: string; ownerLabel: string; frozen: boolean }[] = [];
    for (const acct of accounts) {
      const owned = await adapter.tokensOf(ref, acct.address).catch(() => []);
      const frozen = await adapter.isFrozen(ref, acct.address).catch(() => false);
      for (const tokenId of owned) tokens.push({ tokenId, owner: acct.address, ownerLabel: acct.label, frozen });
    }
    return tokens.sort((a, b) => a.tokenId.localeCompare(b.tokenId, undefined, { numeric: true }));
  });

  app.get("/assets/:id/audit", { schema: S.assetAudit, ...authScoped("assets:read") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    const q = request.query as { limit: number; offset: number };
    const { items, total } = await deps.audit.listByAsset(asset.id, { limit: q.limit, offset: q.offset });
    return { data: items, pagination: { limit: q.limit, offset: q.offset, total } };
  });

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
    let anchorConsistent = true;
    if (anchor) {
      const at = chain.find((e) => e.seq === anchor.seq);
      anchorConsistent = !!at && auditEntryHash(at.prevHash, at.fields) === anchor.hash;
    }
    return { assetId, valid: base.valid, count: base.count, head: base.head, brokenAt: base.brokenAt, reason: base.reason ?? null, lastAnchor: anchor ? { seq: anchor.seq, hash: anchor.hash, txHash: anchor.txHash, chainId: anchor.chainId, at: anchor.createdAt } : null, anchorConsistent };
  }

  app.get("/assets/:id/audit/verify", { schema: S.verifyAssetAudit, ...authScoped("assets:read") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    return verifyAsset(asset.id);
  });

  app.get("/audit/verify", { schema: S.verifyAuditSummary, ...authScoped("assets:read") }, async (request) => {
    const claims = request.user as TokenClaims;
    const useCaseKey = claims.role === "PlatformAdmin" ? undefined : claims.useCaseKey ?? NO_USE_CASE;
    const { items } = await deps.assets.list({ useCaseKey }, { limit: 1000 });
    const results = await Promise.all(items.map((a) => verifyAsset(a.id)));
    const tampered = results.filter((r) => !r.valid || !r.anchorConsistent).map((r) => ({ assetId: r.assetId, brokenAt: r.brokenAt, reason: r.anchorConsistent ? r.reason : "anchor-mismatch" }));
    return { assets: results.length, verified: results.filter((r) => r.valid && r.anchorConsistent).length, tampered, anchoredAssets: results.filter((r) => r.lastAnchor).length };
  });

  // EN-B: DELIBERATELY UNSCOPED. Anchoring writes the audit head on-chain but
  // creates no authority and discloses nothing — it is an integrity operation
  // whose only cost is gas, already bounded by the role gate below and the
  // per-key rate limit. No scope in the vocabulary describes it honestly, and
  // inventing one to cover "spends gas" would not be the resource:action shape
  // the rest of the map uses.
  app.post("/audit/anchor", { schema: S.anchorAudit, ...auth }, async (request, reply) => {
    const actor = actorOf(request);
    if (!(deps.rbac.can(actor.role, "issue") || actor.role === "Auditor")) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to anchor the audit trail" });
    }
    const claims = request.user as TokenClaims;
    const useCaseKey = claims.role === "PlatformAdmin" ? undefined : claims.useCaseKey ?? NO_USE_CASE;
    const { items } = await deps.assets.list({ useCaseKey }, { limit: 1000 });
    const anchored: { assetId: string; seq: number; txHash: string }[] = [];
    for (const a of items) {
      const chain = await assetChain(a.id);
      if (chain.length === 0) continue;
      const head = chain[chain.length - 1]!;
      try {
        const receipt = await deps.chains.resolveAdapter(a.chainId).anchor({ id: a.id, chainId: a.chainId, contractRef: a.contractRef }, head.hash);
        const rec = await deps.auditAnchors.create({ assetId: a.id, seq: head.seq, hash: head.hash, txHash: receipt.txHash, chainId: a.chainId });
        anchored.push({ assetId: a.id, seq: rec.seq, txHash: rec.txHash });
      } catch (err) {
        request.log.error({ err, assetId: a.id }, "audit anchor failed for asset — skipped (best-effort)");
      }
    }
    return { anchored };
  });

  // --- analytics ----------------------------------------------------------
  app.get("/analytics", { schema: S.analytics, ...authScoped("assets:read") }, async (request) => {
    const claims = request.user as TokenClaims;
    const q = request.query as { useCaseKey?: string; days?: number };
    // Determine scope like /assets: PlatformAdmin sees the platform unless a
    // useCaseKey is given (then that use case); a scoped user is clamped to their
    // own use case and can never point the query at another tenant.
    let scope: "platform" | "use-case";
    let useCaseKey: string | null;
    if (claims.role === "PlatformAdmin") {
      if (q.useCaseKey) {
        scope = "use-case";
        useCaseKey = q.useCaseKey;
      } else {
        scope = "platform";
        useCaseKey = null;
      }
    } else {
      scope = "use-case";
      useCaseKey = claims.useCaseKey ?? NO_USE_CASE;
    }

    const days = Math.min(90, Math.max(1, Math.trunc(q.days ?? 30)));
    const { items: assets } = await deps.assets.list({ useCaseKey: useCaseKey ?? undefined }, { limit: 1000 });
    const { items: audit } = await deps.audit.listByAssetIds(assets.map((a) => a.id), { limit: 10000 });
    const useCases = (await deps.useCases.list()).map((u) => ({ key: u.key, name: u.name, symbol: u.symbol, valuation: u.valuation }));
    const chains = deps.chains.list().map((c) => ({ id: c.id, mode: c.mode }));

    return computeAnalytics({
      scope,
      useCaseKey,
      assets,
      audit,
      useCases,
      chains,
      now: new Date().toISOString(),
      days,
    });
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

  // --- lifecycle actions --------------------------------------------------
  app.post("/assets/:id/actions/:action", { schema: S.action, ...authScoped("assets:transfer") }, async (request, reply) => {
    const { action } = request.params as { action: string };
    const asset = await scopedAsset(request, reply, "act");
    if (!asset) return reply;
    // Every action on this route mutates state — none may touch a matured/retired asset.
    if (asset.status !== "active") {
      return reply.code(409).send({ error: "ASSET_NOT_ACTIVE", message: `asset is ${asset.status}` });
    }
    const actor = actorOf(request);
    const ctx = contextOf(asset);
    const b = (request.body ?? {}) as Record<string, string>;

    // Maker-checker: gate mint/transfer/burn/freeze/unfreeze when configured. The
    // proposer must hold the capability up front (so they can't propose what they
    // couldn't do), then the operation is captured as a pending proposal.
    if (["mint", "transfer", "burn", "freeze", "unfreeze"].includes(action)) {
      try {
        deps.rbac.authorize(actor, action as LifecycleAction);
      } catch (err) {
        if (err instanceof PolicyError) return reply.code(403).send({ error: err.code, message: err.message });
        throw err;
      }
      const useCase = await deps.useCases.get(asset.useCaseKey);
      const proposal = await proposeIfGated(request, useCase, action, asset.id, { action, body: b });
      if (proposal) return reply.code(202).send({ proposal: proposalView(proposal) });
    }

    let receipt;
    switch (action) {
      case "mint":
      case "transfer":
      case "burn":
      case "freeze":
      case "unfreeze":
        // Shared with the maker-checker approval path (executed as the proposer there).
        receipt = await runGatedAction(deps, actor, asset, action, b);
        break;
      case "allow": {
        const acct = (await deps.accounts.list()).find((a) => a.address === b.account);
        if (acct) {
          const owner = (await deps.users.list()).find((u) => u.accountId === acct.id);
          if (owner && owner.kycStatus !== "approved") {
            return reply.code(400).send({ error: "KYC_NOT_APPROVED", message: "the wallet owner has not completed KYC approval" });
          }
        }
        receipt = await deps.engine.setAllowed(actor, ctx, b.account!, true);
        break;
      }
      case "disallow":
        receipt = await deps.engine.setAllowed(actor, ctx, b.account!, false);
        break;
      case "setPrice": {
        deps.rbac.authorize(actor, "issue");
        if (!b.unitPrice || !b.currency || !b.treasuryAccount) return reply.code(400).send({ error: "VALIDATION_ERROR", message: "setPrice requires unitPrice, currency, and treasuryAccount" });
        if (!isSupportedCurrency(b.currency)) return reply.code(400).send({ error: "UNSUPPORTED_CURRENCY", message: `currency '${b.currency}' is not supported` });
        if (!isPositiveIntString(b.unitPrice)) return reply.code(400).send({ error: "INVALID_PRICE", message: "unitPrice must be a positive integer" });
        await deps.assets.setSaleTerms(asset.id, { unitPrice: b.unitPrice, currency: b.currency, treasuryAccount: b.treasuryAccount });
        return reply.code(200).send({ ok: true });
      }
      default:
        return reply.code(400).send({ error: "VALIDATION_ERROR", message: `unknown action '${action}'` });
    }
    return { receipt };
  });

  // --- marketplace: buy (DvP) ---------------------------------------------
  app.post("/assets/:id/buy", { schema: S.buy, ...authScoped("assets:transfer") }, async (request, reply) => {
    const asset = await deps.assets.get((request.params as { id: string }).id);
    if (!asset) return notFound(reply, "asset not found");
    if (!scopedToCaller(request.user as TokenClaims, asset.useCaseKey)) return notFound(reply, "asset not found");
    if (asset.status !== "active") {
      return reply.code(409).send({ error: "ASSET_NOT_ACTIVE", message: `asset is ${asset.status}` });
    }
    if (!asset.unitPrice || !asset.currency || !asset.treasuryAccount) {
      return reply.code(400).send({ error: "NO_SALE_TERMS", message: "this asset is not listed for sale" });
    }
    if (BigInt(asset.unitPrice) <= 0n) {
      return reply.code(400).send({ error: "NO_SALE_TERMS", message: "this asset is not listed for sale" });
    }
    const claims = request.user as TokenClaims;
    const actor = actorOf(request);
    // Find buyer's linked wallet
    const me = await deps.users.findById(claims.id);
    const wallet = me?.accountId ? (await deps.accounts.findById(me.accountId))?.address : undefined;
    if (!wallet) return reply.code(400).send({ error: "NO_WALLET", message: "your account has no linked wallet to receive tokens" });

    const { unitPrice, currency, treasuryAccount } = asset;
    const quantity = (request.body as { quantity: string }).quantity;
    if (!isPositiveIntString(quantity)) return reply.code(400).send({ error: "INVALID_QUANTITY", message: "quantity must be a positive integer" });
    const cost = (BigInt(unitPrice) * BigInt(quantity)).toString();
    const ctx = contextOf(asset);
    const adapter = deps.chains.resolveAdapter(asset.chainId);

    // Marketplace fee: a slice of the payment goes to the platform fee account,
    // the remainder to the treasury. Disabled (fee = 0) unless the use case sets
    // marketplaceBps > 0 AND a platform fee account is configured.
    const useCase = await deps.useCases.get(asset.useCaseKey);
    const feeAccount = deps.platformFeeAccount;
    const bps = feeAccount ? (useCase.fees?.marketplaceBps ?? 0) : 0;
    const fee = ((BigInt(cost) * BigInt(bps)) / 10000n).toString();
    const toTreasury = (BigInt(cost) - BigInt(fee)).toString();

    // Pre-checks (no state change yet)
    if (BigInt(await deps.cash.balanceOf(currency, wallet)) < BigInt(cost)) {
      return reply.code(400).send({ error: "INSUFFICIENT_FUNDS", message: `you need ${cost} ${currency}` });
    }
    if (BigInt(await adapter.balanceOf(ctx.ref, treasuryAccount).catch(() => "0")) < BigInt(quantity)) {
      return reply.code(400).send({ error: "INSUFFICIENT_TREASURY", message: "the treasury does not hold enough tokens" });
    }

    // Payment-first with compensation. Split the payment into (treasury, fee)
    // legs; the buyer needs `cost` total either way. If either leg or delivery
    // fails, refund the FULL cost to the buyer.
    await deps.cash.transfer(currency, wallet, treasuryAccount, toTreasury);
    if (BigInt(fee) > 0n && feeAccount) {
      try {
        await deps.cash.transfer(currency, wallet, feeAccount, fee);
      } catch (feeErr) {
        // Undo the treasury leg so the buyer is made whole, then surface.
        try {
          await deps.cash.transfer(currency, treasuryAccount, wallet, toTreasury);
        } catch (refundErr) {
          request.log.error({ feeErr, refundErr, wallet, treasuryAccount, currency, toTreasury }, "buy fee leg failed AND treasury refund failed — manual reconciliation required");
          throw refundErr;
        }
        throw feeErr;
      }
    }
    try {
      // Record the fee split in the buy audit metadata. The engine spreads this
      // object into the audit payload; the extra keys carry the fee accounting.
      const buyMeta = { unitPrice, currency, cost, ...(fee !== "0" ? { fee, feeAccount } : {}) };
      const receipt = await deps.engine.buy(actor, ctx, treasuryAccount, wallet, quantity, buyMeta);
      return reply.code(200).send({ receipt, paid: { amount: cost, currency }, delivered: { amount: quantity, to: wallet }, fee: { amount: fee, account: fee !== "0" ? feeAccount ?? null : null } });
    } catch (err) {
      // Refund the FULL cost: reverse the treasury leg, and the fee leg if it ran.
      try {
        await deps.cash.transfer(currency, treasuryAccount, wallet, toTreasury);
        if (BigInt(fee) > 0n && feeAccount) await deps.cash.transfer(currency, feeAccount, wallet, fee);
      } catch (refundErr) {
        request.log.error({ err, refundErr, wallet, treasuryAccount, feeAccount, currency, cost }, "buy delivery failed AND cash refund failed — manual reconciliation required");
        throw refundErr;
      }
      throw err; // delivery failed but cash was refunded — surface the real cause
    }
  });

  // --- secondary market: escrowed sell-listings -----------------------------

  // The market runs only when an escrow account is configured. When absent,
  // every market endpoint answers 503 so clients can distinguish "disabled"
  // from "not found" / "bad request".
  function marketDisabled(reply: FastifyReply): FastifyReply | null {
    if (deps.marketEscrowAccount) return null;
    return reply.code(503).send({ error: "MARKET_DISABLED", message: "the secondary market is not configured (MARKET_ESCROW_ACCOUNT is unset)" });
  }

  // The caller's linked wallet address (seller on list, buyer on take), or null.
  async function walletOf(claims: TokenClaims): Promise<string | null> {
    const me = await deps.users.findById(claims.id);
    if (!me?.accountId) return null;
    return (await deps.accounts.findById(me.accountId))?.address ?? null;
  }

  // --- investor portal (read-only, describes the CALLER) ---------------------

  // The caller's wallet + use-case scope, or a 400 when no wallet is linked.
  async function investorScope(request: FastifyRequest, reply: FastifyReply): Promise<{ wallet: string; useCaseKey?: string } | null> {
    const claims = request.user as TokenClaims;
    const wallet = await walletOf(claims);
    if (!wallet) {
      reply.code(400).send({ error: "NO_WALLET", message: "your account has no linked wallet" });
      return null;
    }
    return { wallet, useCaseKey: claims.role === "PlatformAdmin" ? undefined : claims.useCaseKey ?? NO_USE_CASE };
  }

  app.get("/me/portfolio", { schema: S.mePortfolio, ...authScoped("assets:read") }, async (request, reply) => {
    const scope = await investorScope(request, reply);
    if (!scope) return reply;
    return computePortfolio(deps, scope.wallet, scope.useCaseKey);
  });

  app.get("/me/activity", { schema: S.meActivity, ...authScoped("assets:read") }, async (request, reply) => {
    const scope = await investorScope(request, reply);
    if (!scope) return reply;
    return computeActivity(deps, scope.wallet, scope.useCaseKey);
  });

  // Loads a listing and its asset, enforcing use-case scope through the asset.
  // Out-of-scope callers get the same 404 as a missing listing (hides existence).
  async function scopedListing(request: FastifyRequest, reply: FastifyReply): Promise<{ listing: ListingRecord; asset: AssetRecord } | null> {
    const { id } = request.params as { id: string };
    const listing = await deps.listings.get(id);
    const asset = listing ? await deps.assets.get(listing.assetId) : null;
    if (!listing || !asset || !scopedToCaller(request.user as TokenClaims, asset.useCaseKey)) {
      notFound(reply, "listing not found");
      return null;
    }
    return { listing, asset };
  }

  app.post("/assets/:id/listings", { schema: S.createListing, ...authScoped("assets:transfer") }, async (request, reply) => {
    if (marketDisabled(reply)) return reply;
    const escrow = deps.marketEscrowAccount!;
    const asset = await scopedAsset(request, reply, "read"); // 404 pattern, like /buy
    if (!asset) return reply;
    if (asset.tokenType !== "fungible") {
      return reply.code(400).send({ error: "WRONG_TOKEN_TYPE", message: "only fungible assets can be listed on the market" });
    }
    if (asset.status !== "active") {
      return reply.code(400).send({ error: "ASSET_NOT_ACTIVE", message: "this asset is not active" });
    }
    const { quantity, unitPrice, currency } = request.body as { quantity: string; unitPrice: string; currency: string };
    if (!isPositiveIntString(quantity)) return reply.code(400).send({ error: "INVALID_QUANTITY", message: "quantity must be a positive integer" });
    if (!isPositiveIntString(unitPrice)) return reply.code(400).send({ error: "INVALID_PRICE", message: "unitPrice must be a positive integer" });
    if (!isSupportedCurrency(currency)) return reply.code(400).send({ error: "UNSUPPORTED_CURRENCY", message: `currency '${currency}' is not supported` });

    const claims = request.user as TokenClaims;
    const actor = actorOf(request);
    const seller = await walletOf(claims);
    if (!seller) return reply.code(400).send({ error: "NO_WALLET", message: "your account has no linked wallet to sell from" });

    const ctx = contextOf(asset);
    // Clean pre-check: the engine would reject the escrow transfer anyway, but a
    // typed INSUFFICIENT_BALANCE beats an opaque ledger revert.
    if (BigInt(await deps.engine.balanceOf(actor, ctx, seller).catch(() => "0")) < BigInt(quantity)) {
      return reply.code(400).send({ error: "INSUFFICIENT_BALANCE", message: `you hold fewer than ${quantity} tokens of this asset` });
    }

    // Auto-allowlist the escrow on this asset on first use (mirrors the issue
    // route's treasury auto-allowlisting). Listing callers (Buyer/Trader) lack
    // the "allow" RBAC right, so when the caller cannot allow we act as the
    // platform operator — the audit entry records the operator actor.
    const useCase = await deps.useCases.get(asset.useCaseKey);
    if (useCase.compliance.allowlist) {
      const adapter = deps.chains.resolveAdapter(asset.chainId);
      if (!(await adapter.isAllowed(ctx.ref, escrow).catch(() => false))) {
        const allowActor = deps.rbac.can(actor.role, "allow") ? actor : { id: "platform-operator", role: "PlatformAdmin" as const };
        await deps.engine.setAllowed(allowActor, ctx, escrow, true);
      }
    }

    // Escrow the tokens (engine enforces RBAC, lifecycle.transfer, allowlist,
    // freeze, and the seller's lockup), then create the row. If the row create
    // fails, compensate by releasing the escrowed tokens back to the seller.
    await deps.engine.escrowList(actor, ctx, seller, escrow, quantity);
    let listing;
    try {
      listing = await deps.listings.create({ assetId: asset.id, seller, quantity, unitPrice, currency });
    } catch (err) {
      try {
        await deps.engine.escrowRelease(actor, ctx, escrow, seller, quantity);
      } catch (releaseErr) {
        request.log.error({ err, releaseErr, seller, escrow, quantity, assetId: asset.id }, "listing row create failed AND escrow release failed — manual reconciliation required");
        throw releaseErr;
      }
      throw err;
    }
    return reply.code(201).send(listing);
  });

  app.get("/assets/:id/listings", { schema: S.listListings, ...authScoped("assets:read") }, async (request, reply) => {
    if (marketDisabled(reply)) return reply;
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    const open = await deps.listings.listByAsset(asset.id, "open");
    return open
      .sort((a, b) => {
        const byPrice = BigInt(a.unitPrice) < BigInt(b.unitPrice) ? -1 : BigInt(a.unitPrice) > BigInt(b.unitPrice) ? 1 : 0;
        return byPrice !== 0 ? byPrice : a.createdAt.localeCompare(b.createdAt);
      })
      .map((l) => ({ id: l.id, seller: l.seller, quantity: l.quantity, unitPrice: l.unitPrice, currency: l.currency, createdAt: l.createdAt }));
  });

  app.post("/listings/:id/take", { schema: S.takeListing, ...authScoped("assets:transfer") }, async (request, reply) => {
    if (marketDisabled(reply)) return reply;
    const escrow = deps.marketEscrowAccount!;
    const scoped = await scopedListing(request, reply);
    if (!scoped) return reply;
    const { listing, asset } = scoped;

    // Guards, in order: open → wallet → not own listing → quantity → funds.
    if (listing.status !== "open") {
      return reply.code(400).send({ error: "LISTING_NOT_OPEN", message: `this listing is ${listing.status}` });
    }
    const claims = request.user as TokenClaims;
    const buyerWallet = await walletOf(claims);
    if (!buyerWallet) return reply.code(400).send({ error: "NO_WALLET", message: "your account has no linked wallet to receive tokens" });
    if (buyerWallet === listing.seller) {
      return reply.code(400).send({ error: "OWN_LISTING", message: "you cannot take your own listing" });
    }
    const quantity = (request.body as { quantity: string }).quantity;
    if (!isPositiveIntString(quantity)) return reply.code(400).send({ error: "INVALID_QUANTITY", message: "quantity must be a positive integer" });
    if (BigInt(quantity) > BigInt(listing.quantity)) {
      return reply.code(400).send({ error: "TAKE_EXCEEDS_REMAINING", message: `only ${listing.quantity} remain on this listing` });
    }
    const { unitPrice, currency, seller } = listing;
    const cost = (BigInt(unitPrice) * BigInt(quantity)).toString();
    if (BigInt(await deps.cash.balanceOf(currency, buyerWallet)) < BigInt(cost)) {
      return reply.code(400).send({ error: "INSUFFICIENT_FUNDS", message: `you need ${cost} ${currency}` });
    }

    // Marketplace fee — same rules as the primary /buy: a bps slice of the
    // payment goes to the platform fee account, the remainder to the SELLER.
    const useCase = await deps.useCases.get(asset.useCaseKey);
    const feeAccount = deps.platformFeeAccount;
    const bps = feeAccount ? (useCase.fees?.marketplaceBps ?? 0) : 0;
    const fee = ((BigInt(cost) * BigInt(bps)) / 10000n).toString();
    const toSeller = (BigInt(cost) - BigInt(fee)).toString();

    // ATOMIC RESERVE — the guards above are read-only prechecks; this is the
    // real defence. The escrow account is POOLED across every listing of the
    // asset, so a settle can "succeed" against another seller's escrowed tokens
    // — the listing row's remaining quantity is the only per-listing ledger.
    // Reserving it atomically BEFORE any value moves means two concurrent takes
    // can never both draw on the same remainder.
    let updated: ListingRecord;
    try {
      updated = await deps.listings.reserve(listing.id, quantity);
    } catch (err) {
      if (err instanceof ListingConflictError) {
        return reply.code(err.code === "LISTING_CONFLICT" ? 409 : 400).send({ error: err.code, message: err.message });
      }
      throw err;
    }

    const actor = actorOf(request);
    const ctx = contextOf(asset);
    let receipt;
    try {
      // Payment-first with compensation: fee leg, then seller leg; if the seller
      // leg fails, refund the fee leg so the buyer is made whole.
      if (BigInt(fee) > 0n && feeAccount) {
        await deps.cash.transfer(currency, buyerWallet, feeAccount, fee);
      }
      try {
        await deps.cash.transfer(currency, buyerWallet, seller, toSeller);
      } catch (err) {
        if (BigInt(fee) > 0n && feeAccount) {
          try {
            await deps.cash.transfer(currency, feeAccount, buyerWallet, fee);
          } catch (refundErr) {
            request.log.error({ err, refundErr, buyerWallet, feeAccount, currency, fee }, "take seller leg failed AND fee refund failed — manual reconciliation required");
            throw refundErr;
          }
        }
        throw err;
      }

      try {
        // Delivery leg: escrow → buyer. The engine enforces buyer-side compliance
        // (allowlist, freeze, jurisdiction, holder-limit) and audits as a
        // secondary "buy" with the price + fee metadata. `seller` rides along so
        // audit folds debit the SELLER (the economic sender), not the pooled escrow.
        const meta = { unitPrice, currency, cost, seller, ...(fee !== "0" ? { fee, feeAccount } : {}) };
        receipt = await deps.engine.settleFromEscrow(actor, ctx, escrow, buyerWallet, quantity, meta);
      } catch (err) {
        // Delivery failed — reverse BOTH cash legs, then surface the real cause.
        try {
          await deps.cash.transfer(currency, seller, buyerWallet, toSeller);
          if (BigInt(fee) > 0n && feeAccount) await deps.cash.transfer(currency, feeAccount, buyerWallet, fee);
        } catch (refundErr) {
          request.log.error({ err, refundErr, buyerWallet, seller, feeAccount, currency, cost }, "take delivery failed AND cash refund failed — manual reconciliation required");
          throw refundErr;
        }
        throw err;
      }
    } catch (err) {
      // Anything failed after the reserve — give the reserved quantity back so
      // other buyers can take it (the cash legs were compensated above).
      await deps.listings.restore(listing.id, quantity).catch((restoreErr) => {
        request.log.error({ err, restoreErr, listingId: listing.id, quantity }, "take failed AFTER reserve AND listing restore failed — listing under-counts remaining, manual reconciliation required");
      });
      throw err;
    }

    return reply.code(200).send({ listing: updated, txHash: receipt.txHash, ...(BigInt(fee) > 0n && feeAccount ? { fee: { amount: fee, account: feeAccount } } : {}) });
  });

  app.delete("/listings/:id", { schema: S.cancelListing, ...authScoped("assets:transfer") }, async (request, reply) => {
    if (marketDisabled(reply)) return reply;
    const escrow = deps.marketEscrowAccount!;
    const scoped = await scopedListing(request, reply);
    if (!scoped) return reply;
    const { listing, asset } = scoped;
    const claims = request.user as TokenClaims;

    // Only the seller (own listing) or an admin may cancel.
    const isAdmin = claims.role === "UseCaseAdmin" || claims.role === "PlatformAdmin";
    if (!isAdmin && (await walletOf(claims)) !== listing.seller) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only the seller or an admin may cancel this listing" });
    }
    if (listing.status !== "open") {
      return reply.code(400).send({ error: "LISTING_NOT_OPEN", message: `this listing is ${listing.status}` });
    }

    // Flip the status FIRST (atomic CAS): once the row is "cancelled" no
    // concurrent take can reserve from it and no concurrent cancel can pass the
    // CAS, so the escrow can only be released once — and only for the remaining
    // quantity as of the flip (a racing partial take re-runs the CAS read).
    let cancelled: ListingRecord;
    try {
      cancelled = await deps.listings.cancel(listing.id);
    } catch (err) {
      if (err instanceof ListingConflictError) {
        return reply.code(err.code === "LISTING_CONFLICT" ? 409 : 400).send({ error: err.code, message: err.message });
      }
      throw err;
    }
    if (BigInt(cancelled.quantity) > 0n) {
      try {
        await deps.engine.escrowRelease(actorOf(request), contextOf(asset), escrow, listing.seller, cancelled.quantity);
      } catch (err) {
        // Release failed — re-open the listing so it never sits "cancelled"
        // while the escrow still holds the seller's tokens.
        await deps.listings.reopen(listing.id).catch((reopenErr) => {
          request.log.error({ err, reopenErr, listingId: listing.id, quantity: cancelled.quantity }, "cancel escrow release failed AND listing reopen failed — cancelled listing still holds escrow, manual reconciliation required");
        });
        request.log.error({ err, listingId: listing.id, seller: listing.seller, quantity: cancelled.quantity }, "cancel escrow release failed — listing re-opened");
        throw err;
      }
    }
    return reply.code(204).send();
  });

  app.get("/assets/:id/trades", { schema: S.assetTrades, ...authScoped("assets:read") }, async (request, reply) => {
    if (marketDisabled(reply)) return reply;
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    // Trades = the asset's audit "buy" entries (primary + secondary), newest
    // first. Fetch a generous page then filter, since buys interleave with
    // other lifecycle entries. Older entries may lack price fields — tolerated.
    // TODO: the 1000-entry window means very active assets can push old buys
    // out of the feed before 50 trades are collected — replace with an
    // action-filtered repository query (paged on buys, not on all entries).
    const { items } = await deps.audit.listByAsset(asset.id, { limit: 1000 });
    return items
      .filter((e) => e.action === "buy")
      .slice(0, 50)
      .map((e) => {
        const p = e.payload as Record<string, unknown>;
        // Secondary buys record `from = escrow` but carry the seller in the
        // payload — surface the seller so trades read seller→buyer.
        const from = typeof p.seller === "string" ? p.seller : typeof p.from === "string" ? p.from : null;
        return {
          at: e.createdAt,
          amount: typeof p.amount === "string" ? p.amount : null,
          unitPrice: typeof p.unitPrice === "string" ? p.unitPrice : null,
          currency: typeof p.currency === "string" ? p.currency : null,
          from,
          to: typeof p.to === "string" ? p.to : null,
          secondary: p.secondary === true,
        };
      });
  });

  // --- cash (CBDC) --------------------------------------------------------
  app.post("/cash/credit", { schema: S.creditCash, ...authScoped("assets:transfer") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (!["Issuer", "UseCaseAdmin", "PlatformAdmin"].includes(claims.role)) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "you may not fund accounts" });
    }
    const bdy = request.body as { account: string; currency: string; amount: string };
    if (!isSupportedCurrency(bdy.currency)) return reply.code(400).send({ error: "UNSUPPORTED_CURRENCY", message: `currency '${bdy.currency}' is not supported` });
    if (!/^\d+$/.test(bdy.amount) || BigInt(bdy.amount) <= 0n) return reply.code(400).send({ error: "INVALID_AMOUNT", message: "amount must be a positive integer" });
    if (claims.role !== "PlatformAdmin") {
      const scoped = await scopedAccounts(claims);
      if (!scoped.some((a) => a.address === bdy.account)) {
        return reply.code(403).send({ error: "OUT_OF_SCOPE", message: "that account is not in your use case" });
      }
    }
    await deps.cash.credit(bdy.currency, bdy.account, bdy.amount);
    return reply.code(200).send({ ok: true, balance: await deps.cash.balanceOf(bdy.currency, bdy.account) });
  });

  app.get("/cash/balances", { schema: S.cashBalances, ...authScoped("assets:read") }, async (request, reply) => {
    const address = (request.query as { address?: string }).address;
    if (!address) return [];
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin") {
      const scoped = await scopedAccounts(claims);
      if (!scoped.some((a) => a.address === address)) {
        return reply.code(403).send({ error: "OUT_OF_SCOPE", message: "that account is not in your use case" });
      }
    }
    return deps.cash.balancesOf(address);
  });

  // --- users (scoped provisioning) ----------------------------------------
  app.get("/users", { schema: S.listUsers, ...authScoped("users:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (!canManageUsers(claims.role)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to manage users" });
    const rows = await deps.users.list(claims.role === "PlatformAdmin" ? undefined : claims.useCaseKey ?? NO_USE_CASE);
    return rows.map((u) => ({ id: u.id, email: u.email, role: u.role, useCaseKey: u.useCaseKey, accountId: u.accountId, active: u.active, kycStatus: u.kycStatus, kyc: u.kyc }));
  });

  app.post("/users", { schema: S.createUser, ...authScoped("users:onboard") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; kyc?: KycDetails };
    const targetUseCaseKey = claims.role === "PlatformAdmin" ? (b.useCaseKey || null) : claims.useCaseKey;
    const targetDomain = targetUseCaseKey
      ? useCaseDomainOf(targetUseCaseKey, {
          tokenizationKeys: (await deps.useCases.list()).map((u) => u.key),
          credentialKeys: (await deps.credentialUseCases.list()).map((u) => u.key),
        })
      : undefined;
    if (targetUseCaseKey && !targetDomain) {
      return reply.code(404).send({ error: "USE_CASE_NOT_FOUND", message: `no use case '${targetUseCaseKey}'` });
    }
    // Domain mismatch means the role doesn't exist in this domain AT ALL (e.g. a
    // tokenization-only "Buyer" targeting an identity use case) — use the broadest
    // (PlatformAdmin) roster for the domain so this check stays independent of the
    // CALLER's own rank. A role that exists in the domain but is above the caller's
    // rank (e.g. a UseCaseAdmin trying to mint another UseCaseAdmin) is an
    // escalation, not a domain mismatch, and falls through to canCreateUser's 403.
    if (targetDomain && !assignableRoles("PlatformAdmin", targetDomain).includes(b.role)) {
      return reply.code(400).send({ error: "ROLE_DOMAIN_MISMATCH", message: `role '${b.role}' is not valid for a ${targetDomain} use case` });
    }
    if (!canCreateUser({ role: claims.role, useCaseKey: claims.useCaseKey }, b.role, targetUseCaseKey, targetDomain ?? "tokenization")) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to create that user" });
    }
    if (await deps.users.findByEmail(b.email)) return reply.code(400).send({ error: "EMAIL_TAKEN", message: "email already registered" });

    // If the creator belongs to an org, the new user joins it DIRECTLY with a
    // sub-DID + membership VC (mirrors POST /orgs/:id/users) — org-member
    // onboarding stays direct.
    if (claims.orgId) {
      const org = await deps.organizations.get(claims.orgId);
      // EN-A review fix: this door creates an org member (sub-DID + membership
      // VC) exactly like POST /orgs/:id/users, so it must run the SAME
      // member-add envelope filter — otherwise an org-member UseCaseAdmin could
      // mint out-of-envelope members here. Same PlatformAdmin bypass; a legacy
      // (null-envelope) org still passes untouched. No binding check is needed
      // for a Verifier target: a non-PlatformAdmin caller's target key is
      // pinned to their OWN `claims.useCaseKey`, never attacker-chosen.
      if (org && claims.role !== "PlatformAdmin") {
        const missing = await orgMemberCapabilityViolation(org, b.role, targetUseCaseKey);
        if (missing) return orgCapabilityMissing(reply, org, missing);
      }
      let accountId: string | null = null;
      if (b.walletAddress) accountId = (await deps.accounts.upsert(b.walletAddress, b.email)).id;
      const created = await deps.users.create({
        email: b.email,
        passwordHash: await bcrypt.hash(b.password, BCRYPT_ROUNDS),
        role: b.role,
        useCaseKey: targetUseCaseKey,
        accountId,
        active: true,
        kycStatus: "pending",
        kyc: b.kyc ?? null,
        kind: "human",
      });
      let mintedDid: string | null = null;
      if (org) {
        try {
          mintedDid = await mintMembership(org, created, b.role);
        } catch (err) {
          await deps.users.remove(created.id);
          throw err;
        }
      }
      return reply.code(201).send({ id: created.id, email: created.email, role: created.role, useCaseKey: created.useCaseKey, accountId: created.accountId, kycStatus: created.kycStatus, orgId: claims.orgId ?? null, did: mintedDid });
    }

    // Use-case user management is maker-checker: hash the password NOW (plaintext
    // never enters the proposal store) and park everything in an onboard-user
    // proposal for a second user-manager to approve.
    const kyc = b.kyc && b.kyc.legalName && b.kyc.country ? b.kyc : null;
    const proposal = await deps.proposals.create({
      useCaseKey: targetUseCaseKey, orgId: null, assetId: null, kind: "onboard-user",
      payload: {
        email: b.email, passwordHash: await bcrypt.hash(b.password, BCRYPT_ROUNDS),
        role: b.role, useCaseKey: targetUseCaseKey, walletAddress: b.walletAddress ?? null, kyc,
      },
      proposerId: claims.id, proposerLabel: claims.email, required: 1,
    });
    return reply.code(202).send({ proposal: proposalView(proposal) });
  });

  // Batch onboarding from parsed CSV rows: ONE maker-checker proposal covering
  // every row. Draft-time validation is all-or-nothing (any row problem ⇒ 400,
  // no proposal at all); execution is row-independent (one row's failure
  // never aborts the others — see onboardUserBatchKind).
  app.post("/users/batch", { schema: S.createUsersBatch, ...authScoped("users:onboard") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { rows } = request.body as { rows: { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; kyc?: KycDetails }[] };
    const tokKeys = (await deps.useCases.list()).map((u) => u.key);
    const credKeys = (await deps.credentialUseCases.list()).map((u) => u.key);
    const problems: { index: number; error: string }[] = [];
    const seen = new Set<string>();
    const prepared: OnboardUserPayload[] = [];
    const targetKeys = new Set<string | null>();
    for (let i = 0; i < rows.length; i++) {
      const b = rows[i]!;
      // Mirrors POST /users' target-key + domain + role-domain-mismatch + escalation checks, exactly, per row.
      const targetUseCaseKey = claims.role === "PlatformAdmin" ? (b.useCaseKey || null) : claims.useCaseKey;
      const targetDomain = targetUseCaseKey
        ? useCaseDomainOf(targetUseCaseKey, { tokenizationKeys: tokKeys, credentialKeys: credKeys })
        : undefined;
      if (targetUseCaseKey && !targetDomain) { problems.push({ index: i, error: `no use case '${targetUseCaseKey}'` }); continue; }
      if (targetDomain && !assignableRoles("PlatformAdmin", targetDomain).includes(b.role)) {
        problems.push({ index: i, error: `role '${b.role}' is not valid for a ${targetDomain} use case` });
        continue;
      }
      if (!canCreateUser({ role: claims.role, useCaseKey: claims.useCaseKey }, b.role, targetUseCaseKey, targetDomain ?? "tokenization")) {
        problems.push({ index: i, error: "not allowed to create that user" });
        continue;
      }
      if (!b.email?.includes("@")) { problems.push({ index: i, error: "invalid email" }); continue; }
      if (seen.has(b.email)) { problems.push({ index: i, error: "duplicate email within batch" }); continue; }
      seen.add(b.email);
      if (await deps.users.findByEmail(b.email)) { problems.push({ index: i, error: "email already registered" }); continue; }
      const kyc: OnboardUserPayload["kyc"] = b.kyc && b.kyc.legalName && b.kyc.country
        ? { legalName: b.kyc.legalName, country: b.kyc.country, idType: b.kyc.idType, idNumber: b.kyc.idNumber, documentRef: b.kyc.documentRef }
        : null;
      prepared.push({
        email: b.email, passwordHash: await bcrypt.hash(b.password, BCRYPT_ROUNDS),
        role: b.role, useCaseKey: targetUseCaseKey, walletAddress: b.walletAddress ?? null, kyc,
      });
      targetKeys.add(targetUseCaseKey);
    }
    if (problems.length) {
      return reply.code(400).send({ error: "BATCH_INVALID", message: `${problems.length} row(s) failed validation`, problems });
    }
    // Stamp the proposal's useCaseKey with the batch's shared target when every
    // row agrees (so a scoped UseCaseAdmin can see/approve it, same as a single
    // onboard-user proposal). A MIXED batch — different use cases per row, only
    // reachable by a PlatformAdmin caller since non-PlatformAdmin callers are
    // pinned to their own useCaseKey — gets useCaseKey: null; userScopedView
    // only matches null-scope proposals for a PlatformAdmin, so approving a
    // mixed batch is PlatformAdmin-only (acceptable — documented divergence).
    const uniformUseCaseKey = targetKeys.size === 1 ? [...targetKeys][0]! : null;
    // DIVERGENCE from the single POST /users route: the org-member direct-create
    // branch (`claims.orgId`) is NOT replicated here — a batch ALWAYS drafts a
    // proposal, even for an org-scoped caller, so every batch runs through the
    // same maker-checker executor path (one onboardSingle call per row).
    const proposal = await deps.proposals.create({
      useCaseKey: uniformUseCaseKey, orgId: null, assetId: null, kind: "onboard-user-batch",
      payload: { rows: prepared },
      proposerId: claims.id, proposerLabel: claims.email, required: 1,
    });
    await deps.audit.append({
      actorId: claims.id, action: "user-batch-proposed" as LifecycleAction,
      payload: { proposalId: proposal.id, total: prepared.length },
    });
    return reply.code(202).send({ proposal: proposalView(proposal) });
  });

  app.delete("/users/:id", { schema: S.deleteUser, ...authScoped("users:onboard") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const target = await deps.users.findById(id);
    if (!target) return notFound(reply, "user not found");
    if (!canAdministerUser(claims, target)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to remove that user" });
    await deps.users.remove(id);
    return reply.code(204).send();
  });

  app.patch("/users/:id", { schema: S.updateUser, ...authScoped("users:onboard") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const b = request.body as { password?: string; active?: boolean; kycStatus?: "approved" | "rejected" };
    const target = await deps.users.findById(id);
    if (!target) return notFound(reply, "user not found");
    if (!canAdministerUser(claims, target)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to edit that user" });
    const patch: { passwordHash?: string; active?: boolean; kycStatus?: KycStatus } = {};
    // A machine principal may not set a password on an EXISTING account: that is
    // takeover of a human who already exists and whose credential the key had no
    // part in choosing. Creating a NEW user with a caller-supplied password
    // (POST /orgs/:id/users, scope `users:onboard`) stays allowed and IS
    // deliberate — the integrator brings a secret it already owns for a person it
    // already manages, which is delegable; seizing one it does not own is not.
    // Yes, the created human can then log in and outlive the key. That is the
    // accepted consequence of delegating onboarding at all: the same is true of
    // any human an OrgAdmin onboards, the scope must be granted explicitly, and
    // canCreateOrgMember still caps the new member's role below the caller's.
    if (typeof b.password === "string" && machinePrincipal(request)) {
      return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key cannot set a user's password" });
    }
    if (typeof b.password === "string") patch.passwordHash = bcrypt.hashSync(b.password, BCRYPT_ROUNDS);
    if (typeof b.active === "boolean") patch.active = b.active;
    if (b.kycStatus === "approved" || b.kycStatus === "rejected") patch.kycStatus = b.kycStatus;
    const updated = await deps.users.update(id, patch);
    return { id: updated.id, email: updated.email, role: updated.role, useCaseKey: updated.useCaseKey, accountId: updated.accountId, active: updated.active, kycStatus: updated.kycStatus };
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

  // --- organizations -------------------------------------------------------
  // Public: a registrant uploads a statutory certificate BEFORE registering. Same
  // limits as the authenticated store; throttled like /orgs/register. The caller
  // cannot read the document back — only authenticated reviewers can.
  app.post("/orgs/register/documents", { schema: S.uploadKybDocument, bodyLimit: DOC_UPLOAD_BODY_LIMIT }, async (request, reply) => {
    if (loginThrottled(request.ip)) return reply.code(429).send({ error: "TOO_MANY_REQUESTS", message: "too many attempts; try again later" });
    const doc = await storeUploadedDocument(deps.documents, request.body as { contentType: string; dataBase64: string });
    return reply.code(201).send({ id: doc.id, sha256: doc.sha256, size: doc.size });
  });

  app.post("/orgs/register", { schema: S.registerOrg }, async (request, reply) => {
    if (loginThrottled(request.ip)) return reply.code(429).send({ error: "TOO_MANY_REQUESTS", message: "too many attempts; try again later" });
    if (!deps.didMasterConfigured && deps.isProduction) return reply.code(503).send({ error: "DID_KEYSTORE_UNCONFIGURED", message: "DID_MASTER_KEY must be set" });
    const b = request.body as {
      company: {
        name: string; orgType: "bank" | "corporate" | "msme" | "government";
        cin: string; pan: string; gstin?: string; state: string; pincode: string;
        dateOfIncorporation: string; category: CompanyProfile["category"]; companyStatus: "active" | "inactive";
        documents: { cinCertificate: { id: string }; gstinCertificate?: { id: string } };
      };
      admin: { name: string; email: string; password: string };
      capabilities?: unknown;
    };
    // Validate the requested capability envelope FIRST — throws
    // PolicyError("INVALID_CAPABILITIES") → 400 via the shared error handler
    // (same pattern as validateMetadata). Absent ⇒ null: unrestricted legacy.
    const capabilities = b.capabilities !== undefined ? validateOrgCapabilities(b.capabilities) : null;
    if (await deps.organizations.findByName(b.company.name)) return reply.code(409).send({ error: "NAME_TAKEN", message: "an organization with that name already exists" });
    // The CIN is the statutory registration number — dedupe on it.
    if (await deps.organizations.findByRegistrationId(b.company.cin)) return reply.code(409).send({ error: "REGISTRATION_TAKEN", message: "an organization with that CIN already exists" });
    if (await deps.users.findByEmail(b.admin.email)) return reply.code(409).send({ error: "EMAIL_TAKEN", message: "email already registered" });

    // Resolve document refs SERVER-side: the persisted sha256 comes from OUR
    // stored record, never from the client's claim.
    const cinDoc = await deps.documents.get(b.company.documents.cinCertificate.id);
    if (!cinDoc) return reply.code(400).send({ error: "DOCUMENT_NOT_FOUND", message: "CIN certificate upload not found" });
    let gstinRef: KybDocumentRef | null = null;
    if (b.company.documents.gstinCertificate) {
      const g = await deps.documents.get(b.company.documents.gstinCertificate.id);
      if (!g) return reply.code(400).send({ error: "DOCUMENT_NOT_FOUND", message: "GSTIN certificate upload not found" });
      gstinRef = { id: g.id, sha256: g.sha256 };
    }

    const companyProfile: CompanyProfile = {
      cin: b.company.cin, pan: b.company.pan, gstin: b.company.gstin?.trim() || null,
      state: b.company.state, pincode: b.company.pincode, dateOfIncorporation: b.company.dateOfIncorporation,
      category: b.company.category, companyStatus: b.company.companyStatus,
      documents: { cinCertificate: { id: cinDoc.id, sha256: cinDoc.sha256 }, gstinCertificate: gstinRef },
    };
    // Mint the org DID now, but DO NOT register it on-chain and DO NOT activate —
    // a pending org's DID is trusted nowhere (verifier trust keys off the registry).
    const seed = deps.keystore.newSeed();
    const didSeedEncrypted = deps.keystore.encryptSeed(seed);
    const did = deps.keystore.keyOf(didSeedEncrypted).did;
    const org = await deps.organizations.create({
      name: b.company.name, orgType: b.company.orgType, registrationId: b.company.cin,
      jurisdiction: "IN", did, didSeedEncrypted,
      status: "pending", verified: false, verifiedAt: null, companyProfile,
      capabilities, // the validated requested envelope — part of what the reviewer approves
    });
    try {
      await deps.users.create({
        email: b.admin.email, passwordHash: await bcrypt.hash(b.admin.password, BCRYPT_ROUNDS),
        role: "OrgAdmin", useCaseKey: null, accountId: null, active: false,
        kycStatus: "pending", kyc: { legalName: b.admin.name }, orgId: org.id, kind: "human",
      });
    } catch (err) {
      await deps.organizations.remove(org.id).catch(() => undefined); // roll back the orphaned pending org
      throw err;
    }
    await deps.audit.append({ actorId: "self-registration", action: "org-registered" as LifecycleAction, payload: { orgId: org.id, name: org.name } });
    return reply.code(202).send({ organizationId: org.id, status: org.status });
  });

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
    if (existing) return existing;
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
    });
    await deps.audit.append({ actorId: opts.actorId ?? "provisioning", action: "org-created" as LifecycleAction, payload: { orgId: org.id, name: org.name, did: org.did } });
    return org;
  }

  app.post("/orgs", { schema: S.createOrg, ...authScoped("usecases:provision") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may create organizations" });
    if (!deps.didMasterConfigured && deps.isProduction) return reply.code(503).send({ error: "DID_KEYSTORE_UNCONFIGURED", message: "DID_MASTER_KEY must be set to create organizations" });
    const b = request.body as { name: string; orgType: "bank" | "corporate" | "msme" | "government" | "verifier"; registrationId?: string; jurisdiction?: string };
    // POST /orgs keeps its explicit name-taken guard (a duplicate is a 409 here,
    // whereas ensureOrg deliberately RETURNS the existing org for the idempotent
    // provisioner). After this guard the name is free, so ensureOrg always creates.
    if (await deps.organizations.findByName(b.name)) return reply.code(409).send({ error: "NAME_TAKEN", message: "an organization with that name already exists" });
    if (b.registrationId && (await deps.organizations.findByRegistrationId(b.registrationId))) return reply.code(409).send({ error: "REGISTRATION_TAKEN", message: "an organization with that registration id already exists" });
    let org: OrganizationRecord;
    try {
      org = await ensureOrg(b.name, b.orgType, { registrationId: b.registrationId ?? null, jurisdiction: b.jurisdiction ?? null, actorId: claims.id });
    } catch (err) {
      if (err instanceof CodedError && err.code === "REGISTRY_UNAVAILABLE") return reply.code(502).send({ error: err.code, message: err.message });
      throw err;
    }
    return reply.code(201).send({ id: org.id, name: org.name, did: org.did, orgType: org.orgType, registrationId: org.registrationId, jurisdiction: org.jurisdiction, verified: org.verified, status: org.status });
  });

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

  /** orgView + the credentials HELD by the org's parent DID (issuance attribution). */
  async function orgViewWithCreds(o: OrganizationRecord) {
    const held = await deps.credentials.listByHolder(o.did);
    return { ...orgView(o), credentials: held.map((c) => ({ id: c.id, type: c.type, issuerDid: c.issuerDid, issuedAt: c.issuedAt, revoked: c.revoked })) };
  }

  app.get("/orgs", { schema: S.listOrgs, ...authScoped("org:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    let rows;
    if (claims.role === "PlatformAdmin") {
      const status = (request.query as { status?: string }).status;
      rows = (await deps.organizations.list()).filter((o) => !status || o.status === status);
    }
    else if (claims.role === "OrgAdmin" && claims.orgId) { const o = await deps.organizations.get(claims.orgId); rows = o ? [o] : []; }
    else return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to list organizations" });
    return Promise.all(rows.map(orgViewWithCreds));
  });

  app.get("/orgs/:id", { schema: S.getOrg, ...authScoped("org:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    if (!orgScoped(claims, id)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to view that organization" });
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    return orgViewWithCreds(org);
  });

  /**
   * Platform governance: admitting a tenant and setting the EN-A envelope that
   * bounds it. NO KEY, EVER — the same call the `org-capability-change` proposal
   * kind makes with `apiScope: null`, and for the same reason: an envelope is
   * the ceiling on what every key in that org may do, so a machine principal
   * must never be able to raise it (nor to admit the org it would apply to).
   * Refusing the proposal path while leaving the DIRECT patch open would have
   * been the whole gate, bypassed.
   */
  function platformGovernanceRefused(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!machinePrincipal(request)) return false;
    reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key may not perform platform governance on organizations" });
    return true;
  }

  app.post("/orgs/:id/approve", { schema: S.approveOrg, ...auth }, async (request, reply) => {
    if (platformGovernanceRefused(request, reply)) return reply;
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may approve organizations" });
    const { id } = request.params as { id: string };
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    if (org.status !== "pending") return reply.code(409).send({ error: "NOT_PENDING", message: `organization is ${org.status}` });
    if (deps.registry) {
      try {
        // Check-then-register: a RETRIED approve (after a post-registration
        // rollback, e.g. a transient anchor failure) finds the DID already on
        // the DidRegistry, whose registerDid reverts AlreadyRegistered.
        const { registered } = await deps.registry.anchor.didRegistration(deps.registry.didRegistry, org.did);
        if (!registered) await deps.registry.anchor.registerDid(deps.registry.didRegistry, org.did);
      } catch (err) {
        request.log.error({ err }, "org DID registration failed");
        return reply.code(502).send({ error: "REGISTRY_UNAVAILABLE", message: "could not register the organization's DID on-chain — nothing was changed" });
      }
    }
    const active = await deps.organizations.setStatus(org.id, "active");
    await deps.organizations.setVerified(org.id, true, new Date().toISOString());
    const admin = (await deps.users.listByOrg(org.id)).find((u) => u.role === "OrgAdmin");
    let issuerDid: string | null = null;
    let orgCredentialId: string | null = null;
    if (admin) {
      // Snapshot the pre-mint identity BEFORE mintMembership runs — the in-memory
      // repo mutates the same object in place, so reading admin.did in the catch
      // would otherwise see the freshly-minted DID instead of the original.
      const priorDid = admin.did;
      const priorSeed = admin.didSeedEncrypted;
      try {
        await mintMembership(active, admin, "OrgAdmin");
        await deps.users.update(admin.id, { active: true });
        // The issuance ceremony: the PLATFORM org attests the corporate's KYB
        // facts with a signed, anchored OrganizationCredential. Deliberately
        // LAST: issueCredentialFor persists nothing on a throw, so a failure
        // here needs only the rollback below — no credential compensation.
        const platformOrg = await ensurePlatformIssuerOrg(deps);
        const p = org.companyProfile;
        // Named kybClaims (not `claims`) — the handler's `claims` is the caller's
        // TokenClaims, and shadowing it here would be a trap for future edits.
        const kybClaims: Record<string, unknown> = {
          name: org.name, orgType: org.orgType,
          ...(p ? {
            cin: p.cin, pan: p.pan, state: p.state, pincode: p.pincode,
            dateOfIncorporation: p.dateOfIncorporation, category: p.category,
            ...(p.gstin ? { gstin: p.gstin } : {}),
          } : {}),
        };
        const cred = await issueCredentialFor(deps, { issuerOrg: platformOrg, subjectDid: org.did, type: "OrganizationCredential", claims: kybClaims, validityDays: credentialTypeDef("OrganizationCredential").validityDays, proposalId: null });
        issuerDid = platformOrg.did;
        orgCredentialId = cred.id;
      } catch (err) {
        // Roll back to pending AND undo any sub-DID mintMembership stamped on the
        // admin row before it threw — a dangling did on an inactive admin is
        // otherwise reachable via POST /credentials/requests. Restore the row to
        // its pre-approval state (no sub-DID, still inactive).
        await deps.users.update(admin.id, { did: priorDid, didSeedEncrypted: priorSeed, active: false });
        await deps.organizations.setStatus(org.id, "pending");
        await deps.organizations.setVerified(org.id, false, null);
        request.log.error({ err }, "org admin activation failed");
        return reply.code(502).send({ error: "ADMIN_ACTIVATION_FAILED", message: "could not complete the issuance ceremony — reverted to pending" });
      }
    }
    await deps.audit.append({ actorId: claims.id, action: "org-approved" as LifecycleAction, payload: { orgId: org.id, did: org.did, orgCredentialId, issuerDid } });
    return reply.code(200).send({ id: active.id, name: active.name, did: active.did, orgType: active.orgType, status: "active", verified: true, issuerDid, orgCredentialId });
  });

  app.post("/orgs/:id/reject", { schema: S.rejectOrg, ...auth }, async (request, reply) => {
    if (platformGovernanceRefused(request, reply)) return reply;
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may reject organizations" });
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason: string };
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    if (org.status !== "pending") return reply.code(409).send({ error: "NOT_PENDING", message: `organization is ${org.status}` });
    const rejected = await deps.organizations.setStatus(org.id, "rejected");
    await deps.audit.append({ actorId: claims.id, action: "org-rejected" as LifecycleAction, payload: { orgId: org.id, reason } });
    return reply.code(200).send({ id: rejected.id, status: "rejected" });
  });

  // Direct capability grant (EN-A): the platform is the granting authority and
  // needs no second approver. `capabilities: null` clears an org back to the
  // unrestricted legacy envelope — PlatformAdmin only, deliberate.
  app.patch("/orgs/:id/capabilities", { schema: S.patchOrgCapabilities, ...auth }, async (request, reply) => {
    if (platformGovernanceRefused(request, reply)) return reply;
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may set organization capabilities" });
    const { id } = request.params as { id: string };
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    const b = request.body as { capabilities: unknown };
    // Throws PolicyError("INVALID_CAPABILITIES") → 400 via the shared handler.
    const caps = b.capabilities === null ? null : validateOrgCapabilities(b.capabilities);
    const updated = await deps.organizations.setCapabilities(org.id, caps);
    await deps.audit.append({ actorId: claims.id, action: "org-capabilities-set" as LifecycleAction, payload: { orgId: org.id, capabilities: caps } });
    return orgView(updated);
  });

  // Org-requested capability change (EN-A): the org's own OrgAdmin proposes a
  // new envelope; only a PlatformAdmin approval applies it (see org-kinds.ts).
  app.post("/orgs/:id/capabilities/request", { schema: S.requestOrgCapabilities, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    if (!orgScoped(claims, id)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to request capabilities for that organization" });
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    const b = request.body as { capabilities: unknown };
    const capabilities = validateOrgCapabilities(b.capabilities); // 400 INVALID_CAPABILITIES on bad input
    const proposal = await deps.proposals.create({
      useCaseKey: null, orgId: org.id, assetId: null, kind: "org-capability-change",
      payload: { orgId: org.id, capabilities },
      proposerId: claims.id, proposerLabel: claims.email, required: 1,
    });
    return reply.code(202).send({ proposal: proposalView(proposal) });
  });

  // Mint a sub-DID + OrganizationMembership VC for `user` under `org` (links the
  // user's tenancy orgId). Shared logic lives in mintOrgMembership.
  async function mintMembership(org: OrganizationRecord, user: UserRecord, role: Role): Promise<string> {
    return mintOrgMembership(deps, org, user, role, { linkOrgId: true });
  }

  interface OrgMemberInput { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; kyc?: KycDetails }

  /**
   * Create an org member: every gate (org scope, `canCreateOrgMember`, the EN-A
   * envelope filter, the EN-A Verifier binding check), then the user row, then
   * the sub-DID + membership VC, then the audit entry. Returns null once the
   * error reply has been sent.
   *
   * `kind` is a PARAMETER, not a constant. An API key's service user is minted
   * through exactly this path so all of the above applies to it — and if the
   * kind were hardcoded to "human" here, every service user would be a human
   * account and the `SERVICE_ACCOUNT` login refusal would be a silent no-op: a
   * guard that looks present and does nothing. `api-keys.test.ts` proves the
   * minted user is actually refused at /auth/login.
   */
  async function createOrgMember(
    reply: FastifyReply, claims: TokenClaims, id: string, b: OrgMemberInput, kind: UserRecord["kind"],
  ): Promise<{ org: OrganizationRecord; user: UserRecord; did: string } | null> {
    if (!orgScoped(claims, id)) { reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to add members to that organization" }); return null; }
    if (!canCreateOrgMember(claims.role, b.role)) { reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to create that member role" }); return null; }
    const org = await deps.organizations.get(id);
    if (!org) { notFound(reply, "organization not found"); return null; }
    // "" is normalized to null ONCE, before any gate reads it, so an empty-string
    // key can never slip past a truthiness-guarded check downstream (the standing
    // ""-vs-null gate-bypass lesson); every use below reads `memberUseCaseKey`.
    const memberUseCaseKey = b.useCaseKey || null;
    // EN-A member-add filter (shared with POST /users). A PlatformAdmin bypasses
    // entirely (platform override).
    if (claims.role !== "PlatformAdmin") {
      const missing = await orgMemberCapabilityViolation(org, b.role, memberUseCaseKey);
      if (missing) { orgCapabilityMissing(reply, org, missing); return null; }
    }
    // USE-CASE BINDING. The key below is stored VERBATIM on the member, and a
    // member is authorized downstream by `role + useCaseKey` alone, so this is
    // where a cross-org escalation is either stopped or created.
    //
    // The comment that used to sit here reasoned only about Verifier and Holder
    // and concluded "A TOKENIZATION key is likewise harmless". That was FALSE
    // for every other role, and the review proved it: a foreign org's OrgAdmin
    // minted `{ role: "Trader", useCaseKey: "<a tokenization key it does not
    // own>" }`, got a 201, and read the victim tenant's whole asset register.
    // The reason is `scopedToCaller`, which authorizes on `claims.useCaseKey`
    // ALONE — it never consults the member's org. So the key written here IS
    // the authorization, for UseCaseAdmin/Issuer/Trader/Buyer/Auditor just as
    // much as for Verifier. Nothing about the tokenization catalog made it safe;
    // only the absence of a check made it look that way.
    //
    // The rule now, by domain — and deliberately NOT symmetric, because the two
    // catalogs express org attachment differently:
    //
    //   TOKENIZATION — the org must OWN the use case. There is no binding
    //     concept in this catalog at all: `ownerOrgId` is the only relationship
    //     it can express, and org self-service stamps it from the creator's own
    //     claims (see POST /use-cases). A platform-seeded use case (ownerOrgId
    //     null) is owned by no org and so is off-limits through the ORG route —
    //     a PlatformAdmin, exempt here, still assigns members to those through
    //     the sibling POST /users. `Holder` stays ungated: no route authorizes
    //     on `role === "Holder"` (holder eligibility is decided by the use
    //     case's holderPolicy at issuance time), so the key grants nothing.
    //
    //   IDENTITY — UNCHANGED, on purpose. Only the Verifier check EN-A already
    //     had. This catalog has explicit OPEN bindings (`issuer: {kind:
    //     "platform"}`, `verifier: {kind: "any"}`) that deliberately let an org
    //     operate a desk on a use case nobody owns; that is a product decision
    //     EN-A made with its eyes open, and narrowing it is a separate design
    //     question this fix has no mandate for. The demonstrated leak was
    //     tokenization, and `verifierBindingAllows` already covers the identity
    //     case the same review closed earlier in EN-A.
    //
    // Separately, an unknown key now fails closed for EVERY role rather than
    // only Verifier/Holder. It used to be stored verbatim: name a key that does
    // not exist yet, wait for someone else to create it, and the member
    // silently acquires a use case nobody ever granted them.
    if (memberUseCaseKey) {
      const domain = await resolveUseCaseDomain(memberUseCaseKey);
      // Same code the sibling POST /users route uses for an unknown key.
      if (!domain) { reply.code(404).send({ error: "USE_CASE_NOT_FOUND", message: `no use case '${memberUseCaseKey}'` }); return null; }
      // A BINDING failure, not a capability one — distinct error, and it bites
      // for a legacy (null-envelope) org too.
      const notBound = (message: string) => {
        reply.code(403).send({ error: "ORG_NOT_BOUND", message, details: { orgId: org.id, useCaseKey: memberUseCaseKey } });
        return null;
      };
      if (claims.role !== "PlatformAdmin" && b.role !== "Holder") {
        if (domain === "identity") {
          if (b.role === "Verifier") {
            const def = await deps.credentialUseCases.get(memberUseCaseKey);
            // A vanished def (TOCTOU against resolveUseCaseDomain's listing) fails
            // CLOSED rather than open — the key named a use case that no longer exists.
            if (!def) { reply.code(404).send({ error: "USE_CASE_NOT_FOUND", message: `no use case '${memberUseCaseKey}'` }); return null; }
            if (def.ownerOrgId !== org.id && !verifierBindingAllows(def.verifier, org.id)) {
              return notBound(`organization '${org.name}' is neither the owner nor a bound verifier of credential use case '${memberUseCaseKey}'`);
            }
          }
        } else {
          const def = await deps.useCases.get(memberUseCaseKey).catch(() => null);
          // Same fail-closed TOCTOU reading as the identity branch above.
          if (!def) { reply.code(404).send({ error: "USE_CASE_NOT_FOUND", message: `no use case '${memberUseCaseKey}'` }); return null; }
          if ((def.ownerOrgId ?? null) !== org.id) {
            return notBound(`organization '${org.name}' does not own use case '${memberUseCaseKey}'`);
          }
        }
      }
    }
    if (await deps.users.findByEmail(b.email)) { reply.code(400).send({ error: "EMAIL_TAKEN", message: "email already registered" }); return null; }
    let accountId: string | null = null;
    if (b.walletAddress) accountId = (await deps.accounts.upsert(b.walletAddress, b.email)).id;
    const created = await deps.users.create({
      email: b.email, passwordHash: await bcrypt.hash(b.password, BCRYPT_ROUNDS), role: b.role,
      useCaseKey: memberUseCaseKey, accountId, active: true, kycStatus: "pending", kyc: b.kyc ?? null, orgId: id, kind,
    });
    let did: string;
    try {
      did = await mintMembership(org, created, b.role);
    } catch (err) {
      await deps.users.remove(created.id); // no orphan user without a DID/VC
      throw err;
    }
    await deps.audit.append({ actorId: claims.id, action: "member-added" as LifecycleAction, payload: { orgId: id, userId: created.id, did, role: b.role, kind } });
    return { org, user: created, did };
  }

  app.post("/orgs/:id/users", { schema: S.createMember, ...authScoped("users:onboard") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const b = request.body as OrgMemberInput;
    const made = await createOrgMember(reply, claims, id, b, "human");
    if (!made) return;
    return reply.code(201).send({ id: made.user.id, email: made.user.email, role: made.user.role, useCaseKey: made.user.useCaseKey, orgId: id, did: made.did, membershipVc: true });
  });

  app.get("/orgs/:id/members", { schema: S.listMembers, ...authScoped("org:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    if (!orgScoped(claims, id)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to view that organization's members" });
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    const members = await deps.users.listByOrg(id);
    return members.map((u) => ({ id: u.id, email: u.email, role: u.role, useCaseKey: u.useCaseKey, did: u.did ?? null, active: u.active, kycStatus: u.kycStatus }));
  });

  // --- API keys (EN-B) ----------------------------------------------------
  // Machine credentials for an org. Every route here is org-scoped (OrgAdmin on
  // their own org, PlatformAdmin anywhere) and refuses a MACHINE principal — see
  // the guard's comment for why a key must never mint or rotate another key.

  /** Public projection. NEVER carries `secretHash`, and never the secret. */
  function apiKeyView(k: ApiKeyRecord, boundUser: UserRecord | null) {
    // Same fail-closed reading of `expiresAt` the auth path uses: an unparseable
    // stamp shows as expired rather than as "no expiry".
    const expired = k.expiresAt !== null && !(Date.parse(k.expiresAt) > Date.now());
    return {
      id: k.id, orgId: k.orgId, userId: k.userId, name: k.name, prefix: k.prefix, scopes: k.scopes,
      role: boundUser?.role ?? null, useCaseKey: boundUser?.useCaseKey ?? null,
      status: k.revokedAt !== null ? "revoked" : expired ? "expired" : "active",
      lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt, revokedAt: k.revokedAt, revokedBy: k.revokedBy,
      createdBy: k.createdBy, createdAt: k.createdAt,
    };
  }

  const viewKey = async (k: ApiKeyRecord) => apiKeyView(k, await deps.users.findById(k.userId));

  /**
   * Common guard for the four key routes: refuse machine principals, then apply
   * org scope. Returns the org, or null once the reply has been sent.
   *
   * A KEY MAY NOT MANAGE KEYS. Scopes are supposed to only ever narrow, but an
   * OrgAdmin-roled key could mint a SECOND key with `*` and so hand itself
   * grants its own scope list withheld — the one path by which a key's scopes
   * could widen. It would also produce a credential outliving the revocation of
   * the key that made it. Key lifecycle stays a human act (same reasoning as the
   * device-login-key refusal on POST /me/login-keys).
   */
  async function apiKeyScope(request: FastifyRequest, reply: FastifyReply, id: string): Promise<OrganizationRecord | null> {
    if (machinePrincipal(request)) {
      reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key cannot manage API keys" });
      return null;
    }
    const claims = request.user as TokenClaims;
    if (!orgScoped(claims, id)) {
      reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to manage that organization's API keys" });
      return null;
    }
    const org = await deps.organizations.get(id);
    if (!org) { notFound(reply, "organization not found"); return null; }
    return org;
  }

  /** Load a key that genuinely belongs to `orgId` (404 otherwise — no cross-org probing). */
  async function orgKey(reply: FastifyReply, orgId: string, keyId: string): Promise<ApiKeyRecord | null> {
    const k = await deps.apiKeys.findById(keyId);
    if (!k || k.orgId !== orgId) { notFound(reply, "api key not found"); return null; }
    return k;
  }

  app.post("/orgs/:id/api-keys", { schema: S.createApiKey, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const b = request.body as { name: string; role: Role; useCaseKey?: string; scopes: unknown; expiresAt?: string };
    if (!(await apiKeyScope(request, reply, id))) return;
    const scopes = validateScopes(b.scopes); // 400 INVALID_SCOPES on anything unknown
    const expiresAt = b.expiresAt ?? null;
    if (expiresAt !== null && !(Date.parse(expiresAt) > Date.now())) {
      return reply.code(400).send({ error: "INVALID_EXPIRY", message: "expiresAt must be a future timestamp" });
    }
    // The bound principal is an ordinary org member minted through the ordinary
    // member path — so canCreateOrgMember, the EN-A envelope filter and the EN-A
    // binding check all judge this key's authority at creation, and a key can
    // never be stronger than a member its creator could have added by hand.
    // `kind: "service"` is what makes it unable to log in interactively.
    const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 24) || "key";
    const made = await createOrgMember(reply, claims, id, {
      email: `svc-${slug}-${randomUUID().slice(0, 8)}@service.tokenlayer.local`,
      // A service account has no usable password: this value is random, never
      // returned, and /auth/login refuses `kind === "service"` regardless.
      password: `${randomUUID()}${randomUUID()}`,
      role: b.role, useCaseKey: b.useCaseKey,
    }, "service");
    if (!made) return;

    const minted = await mintSecret(API_KEY_BCRYPT_ROUNDS);
    let key: ApiKeyRecord;
    try {
      key = await deps.apiKeys.create({
        orgId: id, userId: made.user.id, name: b.name, prefix: minted.prefix, secretHash: minted.hash,
        scopes, expiresAt, createdBy: claims.id,
      });
    } catch (err) {
      // Partial rollback, and deliberately partial. Removing the user is what
      // matters: without it a service account would linger that nothing can ever
      // authenticate as. Its membership VC and the `member-added` audit entry
      // are LEFT BEHIND — this is NOT the same as the DID-mint rollback inside
      // createOrgMember, which runs before either exists. Deleting them would be
      // worse: the audit log is hash-chained (auditEntryHash/prevHash), so
      // removing an entry breaks verification of every entry after it, and an
      // issued credential is append-only by design. Reachable only if the key
      // insert fails — realistically a prefix collision at ~2^-47.
      await deps.users.remove(made.user.id);
      throw err;
    }
    // id + name + scopes are the audit trail. The SECRET is never audited,
    // logged, or returned by any read route — this response is its only life.
    await deps.audit.append({
      actorId: claims.id, action: "api-key-created" as LifecycleAction,
      payload: { orgId: id, keyId: key.id, name: key.name, scopes: key.scopes, userId: made.user.id, role: b.role },
    });
    return reply.code(201).send({ key: apiKeyView(key, made.user), secret: minted.secret });
  });

  app.get("/orgs/:id/api-keys", { schema: S.listApiKeys, ...auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await apiKeyScope(request, reply, id))) return;
    return Promise.all((await deps.apiKeys.listByOrg(id)).map(viewKey));
  });

  app.post("/orgs/:id/api-keys/:keyId/rotate", { schema: S.rotateApiKey, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id, keyId } = request.params as { id: string; keyId: string };
    if (!(await apiKeyScope(request, reply, id))) return;
    const key = await orgKey(reply, id, keyId);
    if (!key) return;
    if (key.revokedAt !== null) return reply.code(409).send({ error: "KEY_REVOKED", message: "a revoked key cannot be rotated" });

    const minted = await mintSecret(API_KEY_BCRYPT_ROUNDS);
    const rotated = await deps.apiKeys.rotate(key.id, { prefix: minted.prefix, secretHash: minted.hash });
    // The cache is keyed to the row's secretHash, so the old entry could never
    // match the rotated row anyway; dropping BOTH prefixes is belt and braces.
    invalidateVerifiedPrefix(key.prefix);
    invalidateVerifiedPrefix(minted.prefix);
    await deps.audit.append({
      actorId: claims.id, action: "api-key-rotated" as LifecycleAction,
      payload: { orgId: id, keyId: key.id, name: key.name, scopes: key.scopes },
    });
    return reply.code(200).send({ key: await viewKey(rotated), secret: minted.secret });
  });

  app.delete("/orgs/:id/api-keys/:keyId", { schema: S.revokeApiKey, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id, keyId } = request.params as { id: string; keyId: string };
    if (!(await apiKeyScope(request, reply, id))) return;
    const key = await orgKey(reply, id, keyId);
    if (!key) return;
    if (key.revokedAt !== null) return reply.code(200).send({ key: await viewKey(key) }); // idempotent

    const revoked = await deps.apiKeys.revoke(key.id, { by: claims.id, at: new Date().toISOString() });
    invalidateVerifiedPrefix(key.prefix);
    // A service user exists only to back keys: once its last live key is gone it
    // must not remain a usable principal (the auth path rejects inactive users).
    const live = (await deps.apiKeys.listByOrg(id)).filter(
      (k) => k.userId === key.userId && k.revokedAt === null && !(k.expiresAt !== null && !(Date.parse(k.expiresAt) > Date.now())),
    );
    const boundUser = await deps.users.findById(key.userId);
    if (live.length === 0 && boundUser && boundUser.kind === "service" && boundUser.active) {
      await deps.users.update(key.userId, { active: false });
    }
    await deps.audit.append({
      actorId: claims.id, action: "api-key-revoked" as LifecycleAction,
      payload: { orgId: id, keyId: key.id, name: key.name, deactivatedUser: live.length === 0 ? key.userId : null },
    });
    return reply.code(200).send({ key: await viewKey(revoked) });
  });

  // ═══ EN-C: webhook endpoints, deliveries and the event cursor ═════════════

  /** Cursor page sizes. A caller may ask for less; nobody may ask for more. */
  const EVENT_PAGE_DEFAULT = 100;
  const EVENT_PAGE_MAX = 500;
  const DELIVERY_PAGE_DEFAULT = 100;
  const DELIVERY_PAGE_MAX = 500;

  /**
   * THE public projection of an endpoint — used by EVERY read route, including
   * the ones that just wrote the row.
   *
   * It exists for exactly one reason: `secretEncrypted` is a field on the
   * record, and returning the record is the natural thing to write. An endpoint
   * signing secret is not a hash — it is the live key with which an attacker
   * FORGES deliveries the integrator's verifier accepts as genuine — so the
   * ciphertext must never leave the process either. Constructing the response by
   * NAMING its fields (rather than deleting one from a spread) is what makes a
   * newly added secret-bearing column fail closed: it is simply not in this list.
   *
   * The plaintext secret appears in a response body exactly TWICE in the whole
   * system: the 201 from create and the 200 from rotate. Neither goes through
   * here — they add `secret` alongside this view, explicitly, at those two sites.
   */
  function webhookView(e: WebhookEndpointRecord) {
    return {
      id: e.id, orgId: e.orgId, url: e.url, description: e.description, eventTypes: e.eventTypes,
      useCaseKey: e.useCaseKey, status: e.status, disabledReason: e.disabledReason, disabledAt: e.disabledAt,
      consecutiveFailures: e.consecutiveFailures, consecutiveGuardFailures: e.consecutiveGuardFailures,
      failingSince: e.failingSince, deletedAt: e.deletedAt, createdBy: e.createdBy, createdAt: e.createdAt,
      lastDeliveryAt: e.lastDeliveryAt,
    };
  }

  /**
   * Which product domain an event type belongs to, for the EN-A envelope check
   * at SUBSCRIBE time. `null` means domain-neutral — `*` (which is a request for
   * whatever the org is entitled to, not a claim on any particular domain) and
   * `proposal.executed` (maker-checker governance, which both domains use).
   */
  function eventTypeDomain(t: string): OrgDomain | null {
    if (t.startsWith("asset.")) return "tokenization";
    if (t.startsWith("credential.") || t.startsWith("verification.")) return "identity";
    return null;
  }

  /**
   * EN-A GATES SUBSCRIBING, NOT RECEIVING — and the asymmetry is deliberate.
   *
   * An org with no `tokenization` capability may not ASK for `asset.*`: that is
   * a request to be told about a class of act the envelope says it does not
   * perform, and honouring it would let a tightened envelope be worked around by
   * a fresh registration. But an org that subscribed while permitted KEEPS
   * receiving after its envelope narrows. EN-A governs what an org may DO, not
   * what it may observe about acts it has already performed, and it has been
   * non-retroactive since it shipped — a capability change does not un-issue a
   * credential or un-mint a token, so it must not silently blind an integrator
   * to the ones that already exist. Making it retroactive here would ALSO be a
   * new failure mode: an operator narrowing an envelope would silently break a
   * customer's production integration with no error anyone could see.
   *
   * Both directions are pinned by webhooks-routes.test.ts.
   *
   * Returns the missing domain, or null when the whole subscription is in
   * envelope. A legacy (null) envelope passes everything — `orgDomainEnabled`.
   */
  function subscriptionOutsideEnvelope(org: OrganizationRecord, types: string[]): OrgDomain | null {
    for (const t of types) {
      const domain = eventTypeDomain(t);
      if (domain !== null && !orgDomainEnabled(org.capabilities, domain)) return domain;
    }
    return null;
  }

  /**
   * Org scope for the eight endpoint routes. Deliberately NOT `apiKeyScope`:
   * that one refuses machine principals outright, because a key minting a key is
   * the one path by which a key's own scopes could widen. A webhook endpoint
   * confers no authority — it only ever receives events its org can already read
   * through `GET /events` — so an integrator managing its own delivery
   * destinations with its own key is exactly the point of EN-C. What narrows a
   * key here is the `webhooks:read`/`webhooks:write` scope on the route.
   */
  async function webhookOrg(request: FastifyRequest, reply: FastifyReply, id: string): Promise<OrganizationRecord | null> {
    const claims = request.user as TokenClaims;
    if (!orgScoped(claims, id)) {
      reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to manage that organization's webhooks" });
      return null;
    }
    const org = await deps.organizations.get(id);
    if (!org) { notFound(reply, "organization not found"); return null; }
    return org;
  }

  /**
   * Load an endpoint that genuinely belongs to `orgId`. 404 — never 403 — for
   * another org's endpoint, and for a soft-deleted one, mirroring `scopedAsset`
   * and `orgKey`: a 403 would be an EXISTENCE ORACLE, letting one org confirm
   * which endpoint ids another org holds by reading status codes. The whole
   * point of the no-oracle rule is that "not yours" and "not there" are
   * indistinguishable from outside.
   */
  async function orgEndpoint(reply: FastifyReply, orgId: string, whId: string): Promise<WebhookEndpointRecord | null> {
    const e = await deps.webhookEndpoints.findById(whId);
    if (!e || e.orgId !== orgId || e.deletedAt !== null) { notFound(reply, "webhook endpoint not found"); return null; }
    return e;
  }

  /**
   * SSRF guard at registration. Returns false once the 400 has been sent.
   * `checkUrl` returns a verdict rather than throwing, so what reaches the
   * client is our own reason string — never a raw DNS/resolver error, which
   * would turn the guard into a network-probing oracle for the caller.
   */
  async function checkWebhookUrl(reply: FastifyReply, url: string): Promise<boolean> {
    const verdict = await checkUrl(url, { allowInsecureLoopback: deps.webhooksAllowInsecure });
    if (verdict.ok) return true;
    reply.code(400).send({ error: "INVALID_WEBHOOK_URL", message: verdict.reason });
    return false;
  }

  /** Clamp a caller-supplied page size; anything unparseable falls back to the default. */
  function pageLimit(raw: string | undefined, def: number, max: number): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(Math.floor(n), max);
  }

  app.post("/orgs/:id/webhooks", { schema: S.createWebhook, ...authScoped("webhooks:write") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const b = request.body as { url: string; description?: string; eventTypes: unknown; useCaseKey?: string };
    const org = await webhookOrg(request, reply, id);
    if (!org) return;

    // ORDER MATTERS. Vocabulary (400) before entitlement (403) before
    // reachability (400): a typo'd event type must not be reported as a missing
    // capability, and neither must be reported as a bad URL.
    const eventTypes = validateEventTypes(b.eventTypes); // 400 UNKNOWN_EVENT_TYPE / INVALID_EVENT_TYPES
    const missing = subscriptionOutsideEnvelope(org, eventTypes);
    if (missing) return orgCapabilityMissing(reply, org, missing);
    if (!(await checkWebhookUrl(reply, b.url))) return;

    const secret = deps.secretBox.mint();
    const endpoint = await deps.webhookEndpoints.create({
      orgId: id,
      url: b.url,
      description: b.description ?? null,
      eventTypes,
      // `|| null`: "" is not a use-case filter, it is an empty string, and
      // storing it would make it a MATCHABLE value in `endpointMatches` — the
      // ""-vs-null gate bypass this codebase has been bitten by twice.
      useCaseKey: b.useCaseKey || null,
      secretEncrypted: deps.secretBox.seal(secret),
      createdBy: claims.id,
    });
    // The ENDPOINT ID and what it subscribed to are the audit trail. The SECRET
    // is never audited, logged, or returned by any read route — the 201 below is
    // its only life, exactly as with an API key.
    await deps.audit.append({
      actorId: claims.id, action: "webhook-created" as LifecycleAction,
      payload: { orgId: id, endpointId: endpoint.id, url: endpoint.url, eventTypes: endpoint.eventTypes, useCaseKey: endpoint.useCaseKey },
    });
    return reply.code(201).send({ endpoint: webhookView(endpoint), secret });
  });

  app.get("/orgs/:id/webhooks", { schema: S.listWebhooks, ...authScoped("webhooks:read") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await webhookOrg(request, reply, id))) return;
    return { endpoints: (await deps.webhookEndpoints.listByOrg(id)).map(webhookView) };
  });

  app.patch("/orgs/:id/webhooks/:whId", { schema: S.updateWebhook, ...authScoped("webhooks:write") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id, whId } = request.params as { id: string; whId: string };
    const b = request.body as {
      url?: string; description?: string | null; eventTypes?: unknown;
      useCaseKey?: string | null; status?: "active" | "disabled";
    };
    const org = await webhookOrg(request, reply, id);
    if (!org) return;
    const endpoint = await orgEndpoint(reply, id, whId);
    if (!endpoint) return;

    const patch: Parameters<typeof deps.webhookEndpoints.update>[1] = {};
    if (b.eventTypes !== undefined) {
      const eventTypes = validateEventTypes(b.eventTypes);
      // The envelope is re-checked HERE as well as at create: otherwise an org
      // registers `*` while entitled and then PATCHes to `asset.issued` after its
      // envelope narrows, and the create-time gate has governed nothing.
      const missing = subscriptionOutsideEnvelope(org, eventTypes);
      if (missing) return orgCapabilityMissing(reply, org, missing);
      patch.eventTypes = eventTypes;
    }
    if (b.url !== undefined) {
      // RE-RUN THE GUARD ON EVERY URL CHANGE. Validating only at registration
      // would make PATCH the way around it: register a public URL, then move the
      // endpoint to 169.254.169.254 with a second request.
      if (!(await checkWebhookUrl(reply, b.url))) return;
      patch.url = b.url;
    }
    if (b.description !== undefined) patch.description = b.description || null;
    if (b.useCaseKey !== undefined) patch.useCaseKey = b.useCaseKey || null;

    if (b.status !== undefined && b.status !== endpoint.status) {
      patch.status = b.status;
      if (b.status === "active") {
        // RE-ENABLING MUST RESET THE BOOKKEEPING, all five fields together. The
        // dispatcher auto-disables on `consecutiveFailures >= AUTO_DISABLE_AFTER`
        // AND a failure run older than AUTO_DISABLE_MIN_AGE_MS — both of which
        // are still satisfied by the values that caused the disable. Flipping
        // `status` alone re-disables the endpoint on its very next failed
        // attempt, which to the integrator looks like the re-enable silently
        // doing nothing. `failingSince` matters most: leave it and the run's age
        // keeps growing from the ORIGINAL outage forever.
        patch.disabledReason = null;
        patch.disabledAt = null;
        patch.consecutiveFailures = 0;
        patch.consecutiveGuardFailures = 0;
        patch.failingSince = null;
      } else {
        patch.disabledReason = "disabled by an administrator";
        patch.disabledAt = new Date().toISOString();
      }
    }

    const updated = await deps.webhookEndpoints.update(endpoint.id, patch);
    await deps.audit.append({
      actorId: claims.id, action: "webhook-updated" as LifecycleAction,
      payload: { orgId: id, endpointId: endpoint.id, changed: Object.keys(patch) },
    });
    return reply.code(200).send({ endpoint: webhookView(updated) });
  });

  app.post("/orgs/:id/webhooks/:whId/rotate", { schema: S.rotateWebhookSecret, ...authScoped("webhooks:write") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id, whId } = request.params as { id: string; whId: string };
    if (!(await webhookOrg(request, reply, id))) return;
    const endpoint = await orgEndpoint(reply, id, whId);
    if (!endpoint) return;

    // NO OVERLAP WINDOW, deliberately: the moment this returns, deliveries are
    // signed with the new secret and the old one verifies nothing. A grace period
    // would mean a leaked secret stays valid for exactly as long as the window,
    // which is the opposite of what rotation is for. The cost is that an
    // integrator must deploy the new secret promptly — the same contract API-key
    // rotation already has.
    const secret = deps.secretBox.mint();
    const updated = await deps.webhookEndpoints.update(endpoint.id, { secretEncrypted: deps.secretBox.seal(secret) });
    await deps.audit.append({
      actorId: claims.id, action: "webhook-secret-rotated" as LifecycleAction,
      payload: { orgId: id, endpointId: endpoint.id, url: endpoint.url },
    });
    return reply.code(200).send({ endpoint: webhookView(updated), secret });
  });

  app.delete("/orgs/:id/webhooks/:whId", { schema: S.deleteWebhook, ...authScoped("webhooks:write") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id, whId } = request.params as { id: string; whId: string };
    if (!(await webhookOrg(request, reply, id))) return;
    const endpoint = await orgEndpoint(reply, id, whId);
    if (!endpoint) return;

    // SOFT delete: the row stays so its delivery history keeps a destination to
    // point at. `endpointMatches` and `listActive` both already exclude a row
    // with `deletedAt` set, so fan-out stops on the next event; the dispatcher
    // dead-letters anything already queued. `status` goes with it so an operator
    // reading the row sees one consistent answer rather than "active, deleted".
    const now = new Date().toISOString();
    const deleted = await deps.webhookEndpoints.update(endpoint.id, {
      deletedAt: now, status: "disabled", disabledReason: "deleted", disabledAt: now,
    });
    await deps.audit.append({
      actorId: claims.id, action: "webhook-deleted" as LifecycleAction,
      payload: { orgId: id, endpointId: endpoint.id, url: endpoint.url },
    });
    return reply.code(200).send({ endpoint: webhookView(deleted) });
  });

  /**
   * A synthetic ping, so an integrator can prove signature verification, TLS and
   * their handler BEFORE the first real business event arrives.
   *
   * THREE DECISIONS, and the first is why the other two exist.
   *
   * 1. `ping` IS NOT IN `EVENT_TYPES` AND MUST NOT BE. C1's catalog is a closed
   *    set of REAL PLATFORM FACTS — things that happened to an asset, a
   *    credential or a proposal. A test ping is a fact about this API call, not
   *    about the business. Adding it to the catalog would make it subscribable,
   *    which is meaningless (nobody wants a feed of other people's tests), and
   *    would put a non-fact into the one vocabulary the web console renders and
   *    integrators switch on.
   *
   * 2. IT IS STILL A REAL ROW IN THE OUTBOX. The dispatcher resolves
   *    `events.findById(delivery.eventId)` and dead-letters when it cannot, so a
   *    delivery with no event is a delivery that never sends. Writing the row is
   *    also honest: "an operator tested this endpoint at 14:02" IS a durable
   *    fact, it is scoped to the org that asked for it, and it shows up in that
   *    org's own `GET /events` where a confused integrator will look for it.
   *    `EventRecord.type` is a plain `string`, so this costs the catalog nothing.
   *
   * 3. NO SUBSCRIPTION MATCHING — the delivery is enqueued for THIS ENDPOINT
   *    ONLY, bypassing `endpointMatches`. Matching would make the route useless
   *    in exactly the case it is for: an endpoint subscribed to
   *    `["asset.issued"]` matches no `ping`, so testing it would silently do
   *    nothing. Going the other way and calling `emitEvent` would be worse — a
   *    `["*"]` endpoint DOES match `ping`, so testing one endpoint would spray a
   *    ping at every wildcard endpoint in the org. A ping is addressed, by the
   *    operator, to the one endpoint they named. Note the direction of the two
   *    mistakes: matching under-delivers to the intended endpoint, `emitEvent`
   *    over-delivers to unintended ones. Neither can happen here — the only
   *    endpoint id this route can ever enqueue against is one `orgEndpoint`
   *    already proved belongs to the caller's org.
   */
  app.post("/orgs/:id/webhooks/:whId/test", { schema: S.testWebhook, ...authScoped("webhooks:write") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id, whId } = request.params as { id: string; whId: string };
    if (!(await webhookOrg(request, reply, id))) return;
    const endpoint = await orgEndpoint(reply, id, whId);
    if (!endpoint) return;
    // A disabled endpoint's delivery is dead on arrival (the dispatcher settles
    // it `dead` without sending), so queueing one would report success for
    // something guaranteed not to happen. Say so instead.
    if (endpoint.status !== "active") {
      return reply.code(409).send({ error: "ENDPOINT_DISABLED", message: "re-enable the endpoint before testing it" });
    }

    const event = await deps.events.append({
      type: "ping",
      orgId: endpoint.orgId,
      useCaseKey: endpoint.useCaseKey,
      subjectId: endpoint.id,
      data: { endpointId: endpoint.id, requestedBy: claims.id, message: "This is a test delivery from TokenLayer." },
    });
    const delivery = await deps.webhookDeliveries.enqueue({ endpointId: endpoint.id, eventId: event.id, eventSeq: event.seq });
    await deps.audit.append({
      actorId: claims.id, action: "webhook-tested" as LifecycleAction,
      payload: { orgId: id, endpointId: endpoint.id, eventId: event.id, deliveryId: delivery.id },
    });
    // 202: queued, not delivered. The dispatcher is what sends, on its own poll.
    return reply.code(202).send({ delivery, event: { id: event.id, seq: event.seq, type: event.type, occurredAt: event.occurredAt } });
  });

  app.get("/orgs/:id/webhooks/:whId/deliveries", { schema: S.listWebhookDeliveries, ...authScoped("webhooks:read") }, async (request, reply) => {
    const { id, whId } = request.params as { id: string; whId: string };
    const q = request.query as { limit?: string };
    if (!(await webhookOrg(request, reply, id))) return;
    const endpoint = await orgEndpoint(reply, id, whId);
    if (!endpoint) return;
    // A delivery row carries no payload — ids, status, attempt counts and the
    // endpoint's own HTTP answer. The event body is read from GET /events, which
    // applies its own org scope.
    return { deliveries: await deps.webhookDeliveries.listByEndpoint(endpoint.id, pageLimit(q.limit, DELIVERY_PAGE_DEFAULT, DELIVERY_PAGE_MAX)) };
  });

  app.post("/orgs/:id/webhooks/:whId/deliveries/:dId/replay", { schema: S.replayWebhookDelivery, ...authScoped("webhooks:write") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id, whId, dId } = request.params as { id: string; whId: string; dId: string };
    if (!(await webhookOrg(request, reply, id))) return;
    const endpoint = await orgEndpoint(reply, id, whId);
    if (!endpoint) return;
    const delivery = await deps.webhookDeliveries.findById(dId);
    // 404, NOT 403, for a delivery belonging to another org — and the check is
    // `endpointId !== endpoint.id`, where `endpoint` has ALREADY been proved to
    // belong to the caller's org. So a foreign delivery id and a nonexistent one
    // are indistinguishable from outside: no existence oracle, same rule as
    // `scopedProposal` and `orgKey`.
    if (!delivery || delivery.endpointId !== endpoint.id) return notFound(reply, "delivery not found");
    // An inflight row is claimed by a running dispatcher pass. Resetting it here
    // would let a second worker claim it while the first is mid-POST — a
    // double-send, and the settle that follows would clobber the reset anyway.
    if (delivery.status === "inflight") {
      return reply.code(409).send({ error: "DELIVERY_INFLIGHT", message: "this delivery is being attempted right now" });
    }

    const replayed = await deps.webhookDeliveries.update(delivery.id, {
      status: "pending",
      // Back to zero, so a replayed delivery gets the FULL retry schedule rather
      // than dying on its next attempt because the original run exhausted it.
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
      claimedAt: null,
      claimedBy: null,
    });
    await deps.audit.append({
      actorId: claims.id, action: "webhook-delivery-replayed" as LifecycleAction,
      payload: { orgId: id, endpointId: endpoint.id, deliveryId: delivery.id, eventId: delivery.eventId },
    });
    return reply.code(200).send({ delivery: replayed });
  });

  /**
   * The cursor API — the documented catch-up path for an integrator that was
   * offline, and the reason the emit path is allowed to fan out only to
   * endpoints that existed at the time.
   *
   * ORG SCOPE IS THE WHOLE SECURITY PROPERTY HERE. A PlatformAdmin reads every
   * org's log; ANYONE ELSE reads exactly their own, and `claims.orgId ?? null`
   * is what the repo filters on — `null` selects platform-scope rows only, never
   * "all rows" (that is `undefined`, and only the PlatformAdmin branch produces
   * it). The two are one keystroke apart and mean opposite things, which is why
   * the branch is spelled out rather than folded into a ternary on the value.
   *
   * `after` is EXCLUSIVE (`seq > after`), so the documented loop —
   * `after = nextAfter` — never re-reads and never skips. An empty page returns
   * the caller's own cursor back, so polling a quiet log is idempotent.
   *
   * TWO THINGS THIS SCOPE DELIBERATELY DOES NOT DO, both worth knowing before
   * anyone treats it as airtight:
   *
   *  - IT IS ORG-GRAINED, NOT USE-CASE-GRAINED. A use-case-scoped member of org
   *    A (a UseCaseAdmin, an Issuer desk) reads ALL of org A's events, including
   *    those of use cases they cannot otherwise see — every other read route in
   *    this file narrows through `scopedToCaller`, and this one does not.
   *    Webhook ENDPOINTS can narrow by `useCaseKey`; the cursor cannot. This is
   *    the granularity EN-C specifies, and it is a widening WITHIN an org only —
   *    but it is the line to change if per-desk isolation is ever required.
   *  - `seq` IS A GLOBAL COUNTER, so the gaps between an org's own rows disclose
   *    how many events the rest of the platform produced in between. Volume
   *    only — no ids, types, orgs or payloads cross the boundary. That is
   *    inherent to C2's single globally ordered log (the property that makes one
   *    cursor work at all); a per-org sequence would close it and would change
   *    the log's shape.
   */
  app.get("/events", { schema: S.listEvents, ...authScoped("webhooks:read") }, async (request) => {
    const claims = request.user as TokenClaims;
    const q = request.query as { after?: string; type?: string; limit?: string };
    const raw = Number(q.after);
    const after = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    const limit = pageLimit(q.limit, EVENT_PAGE_DEFAULT, EVENT_PAGE_MAX);
    const events = await deps.events.listAfter(after, {
      // `{}` OMITS the key: the repos read `orgId === undefined` as "every org".
      ...(claims.role === "PlatformAdmin" ? {} : { orgId: claims.orgId ?? null }),
      ...(q.type ? { type: q.type } : {}),
      limit,
    });
    return { events, nextAfter: events.length > 0 ? events[events.length - 1]!.seq : after };
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

  app.get("/dids/:did/document", { schema: S.didDocument, ...auth }, async (request, reply) => {
    const { did } = request.params as { did: string };
    const res = await resolveDid(did, {
      registry: deps.registry,
      onChainError: (err) => request.log.error({ err, did }, "on-chain DID registration read failed"),
    });
    if (res.didResolutionMetadata.error || !res.didDocument) {
      return reply.code(400).send({ error: "UNSUPPORTED_DID", message: "only did:key ed25519 can be resolved" });
    }
    const m = res.didDocumentMetadata;
    const registration = m.source === "chain"
      ? { registered: m.registered, active: m.active, chainId: m.chainId, registry: m.registry }
      : null;
    return { ...res.didDocument, registration };
  });

  app.get("/me/credentials", { schema: S.myCredentials, ...authScoped("credentials:read") }, async (request) => {
    const claims = request.user as TokenClaims;
    if (!claims.did) return [];
    return mapHeld(await deps.credentials.listByHolder(claims.did));
  });

  /** Load a credential owned by the caller — either their own personal DID, or
   *  (for an ORG-held credential, e.g. issued via subjectOrgId) their org's DID
   *  when they are that org's OrgAdmin — currently in one of `from` states.
   *  Null ⇒ reply sent. */
  async function holderCredentialInState(
    request: FastifyRequest, reply: FastifyReply, from: CredentialRecord["acceptance"][],
  ): Promise<CredentialRecord | null> {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const cred = await deps.credentials.get(id);
    const isOwnDid = !!cred && !!claims.did && cred.holderDid === claims.did;
    const isOrgAdminOfHolder = !!cred && claims.role === "OrgAdmin" && !!claims.orgId
      && (await deps.organizations.get(claims.orgId).catch(() => null))?.did === cred.holderDid;
    if (!cred || (!isOwnDid && !isOrgAdminOfHolder)) { notFound(reply, "credential not found"); return null; }
    if (!from.includes(cred.acceptance)) {
      reply.code(409).send({ error: "INVALID_ACCEPTANCE_STATE", message: `credential is '${cred.acceptance}'` });
      return null;
    }
    return cred;
  }

  /**
   * EN-C tenancy key for the credential lifecycle events. The owning org of a
   * credential is the org that SIGNED it, resolved from its issuer DID — not the
   * acting principal's org, which on these routes is the HOLDER's. Null (⇒
   * platform-scope) only if that org has vanished; never throws, because it
   * feeds an emit that must not fail the route.
   */
  const issuerOrgIdOf = async (cred: CredentialRecord): Promise<string | null> =>
    (await deps.organizations.findByDid(cred.issuerDid).catch(() => null))?.id ?? null;

  // EN-B: the three holder-lifecycle routes below are DELIBERATELY UNSCOPED.
  // They act only on a credential the caller ALREADY holds and confer no
  // authority over anyone else: accepting/rejecting/asking-for-changes changes
  // the caller's own acceptance state. Contrast POST /verification-requests/:id/
  // consent, which is scoped `credentials:read` because it DISCLOSES those
  // credentials to a third-party verifier.
  app.post("/me/credentials/:id/accept", { schema: S.acceptCredential, ...auth }, async (request, reply) => {
    const cred = await holderCredentialInState(request, reply, ["pending", "changes_requested"]);
    if (!cred) return reply;
    const updated = await deps.credentials.setAcceptance(cred.id, { acceptance: "accepted", at: new Date().toISOString(), note: null });
    await deps.audit.append({ actorId: (request.user as TokenClaims).id, action: "credential-accepted" as LifecycleAction, payload: { credentialId: cred.id } });
    // EN-C: the ISSUER is the party waiting on this answer, so the event is
    // theirs — a holder does not register webhook endpoints.
    await emitEvent(deps, {
      type: "credential.accepted",
      orgId: await issuerOrgIdOf(cred),
      useCaseKey: cred.credentialUseCaseKey,
      subjectId: cred.id,
      data: {
        credentialId: cred.id, credentialType: cred.type, subjectDid: cred.holderDid,
        issuerDid: cred.issuerDid, credentialUseCaseKey: cred.credentialUseCaseKey,
        acceptance: updated.acceptance, acceptedAt: updated.acceptanceAt,
      },
    }, request.log);
    return { id: updated.id, acceptance: updated.acceptance, acceptanceAt: updated.acceptanceAt };
  });

  app.post("/me/credentials/:id/reject", { schema: S.rejectHeldCredential, ...auth }, async (request, reply) => {
    const cred = await holderCredentialInState(request, reply, ["pending", "changes_requested"]);
    if (!cred) return reply;
    const claims = request.user as TokenClaims;
    const note = (request.body as { note?: string })?.note ?? null;
    // Chain-first revoke; a throw leaves the credential in its prior state (never DB-revoked/chain-valid).
    await revokeCredentialById(deps, cred.id, { reason: note ? `holder rejected: ${note}` : "holder rejected", by: claims.id, at: new Date().toISOString() });
    const updated = await deps.credentials.setAcceptance(cred.id, { acceptance: "rejected", at: new Date().toISOString(), note });
    await deps.audit.append({ actorId: claims.id, action: "credential-rejected" as LifecycleAction, payload: { credentialId: cred.id, note } });
    // EN-C: a holder rejection legitimately produces TWO events — the
    // `credential.revoked` that revokeCredentialById above already emitted (the
    // credential is now dead on-chain) and this one, which says WHY. Both facts
    // are true and an integrator subscribed to either should see it.
    await emitEvent(deps, {
      type: "credential.rejected",
      orgId: await issuerOrgIdOf(cred),
      useCaseKey: cred.credentialUseCaseKey,
      subjectId: cred.id,
      data: {
        credentialId: cred.id, credentialType: cred.type, subjectDid: cred.holderDid,
        issuerDid: cred.issuerDid, credentialUseCaseKey: cred.credentialUseCaseKey,
        acceptance: updated.acceptance, rejectedAt: updated.acceptanceAt, note, revoked: true,
      },
    }, request.log);
    return { id: updated.id, acceptance: updated.acceptance, revoked: true };
  });

  app.post("/me/credentials/:id/request-changes", { schema: S.requestCredentialChanges, ...auth }, async (request, reply) => {
    const cred = await holderCredentialInState(request, reply, ["pending"]);
    if (!cred) return reply;
    const { note } = request.body as { note: string };
    const updated = await deps.credentials.setAcceptance(cred.id, { acceptance: "changes_requested", at: new Date().toISOString(), note });
    await deps.audit.append({ actorId: (request.user as TokenClaims).id, action: "credential-changes-requested" as LifecycleAction, payload: { credentialId: cred.id, note } });
    return { id: updated.id, acceptance: updated.acceptance, acceptanceNote: updated.acceptanceNote };
  });

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

    const issuerName = (await deps.organizations.findByDid(cred.issuerDid))?.name ?? null;
    const statusUrl = `${deps.publicApiUrl}/credentials/${cred.id}/status`;
    let status = { revoked: cred.revoked, revokedAt: cred.revokedAt, revokedReason: cred.revokedReason };
    if (deps.registry) {
      try {
        const onChain = await deps.registry.anchor.credentialStatusOf(deps.registry.vcRegistry, cred.id);
        if (onChain.exists) status = { revoked: onChain.revoked, revokedAt: onChain.revokedAt ? new Date(onChain.revokedAt * 1000).toISOString() : null, revokedReason: cred.revokedReason };
      } catch (err) { request.log.error({ err }, "cert on-chain status read failed"); }
    }
    let logoBytes: Buffer | null = null;
    if (spec.certificate?.logoDocumentId) { try { logoBytes = (await deps.documents.get(spec.certificate.logoDocumentId))?.bytes ?? null; } catch { logoBytes = null; } }

    const pdf = await renderCredentialCertificate({ credential: cred, spec, issuerName, statusUrl, status, logoBytes, nowMs: Date.now() });
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
  // A public projection — never leaks the challenge (it's embedded in the VP) or
  // the raw VP blob to a list view.
  function vreqView(r: VerificationRequestRecord) {
    return {
      id: r.id, verifierOrgId: r.verifierOrgId, holderDid: r.holderDid, requestedTypes: r.requestedTypes,
      purpose: r.purpose, status: r.status, consentedCredentialIds: r.consentedCredentialIds,
      consentedAt: r.consentedAt, verifiedAt: r.verifiedAt, createdAt: r.createdAt, expiresAt: r.expiresAt,
      credentialUseCaseKey: r.credentialUseCaseKey,
    };
  }

  app.post("/verification-requests", { schema: S.createVerificationRequest, ...authScoped("verifications:request") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { holderDid: string; requestedTypes: string[]; purpose: string; credentialUseCaseKey?: string };

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
      const rec = await deps.verificationRequests.create({
        verifierOrgId: "", holderDid: b.holderDid, requestedTypes: b.requestedTypes, purpose: b.purpose,
        credentialUseCaseKey: key,
        challenge: randomUUID(), status: "pending", presentationVpJwt: null, consentedAt: null,
        consentedCredentialIds: null, verifierResult: null, verifiedAt: null,
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
    } else if (org.orgType !== "verifier") {
      // Legacy generic flow: still requires a verifier org-type.
      return reply.code(403).send({ error: "NOT_A_VERIFIER", message: "your organization is not a verifier" });
    }

    // EN-A: verifying is an identity-domain act requiring the Verifier role —
    // checked after the binding/orgType gates on BOTH paths (a legacy null
    // envelope passes both predicates untouched).
    if (!orgRoleEnabled(org.capabilities, "Verifier")) return orgCapabilityMissing(reply, org, "Verifier");
    if (!orgDomainEnabled(org.capabilities, "identity")) return orgCapabilityMissing(reply, org, "identity");

    const rec = await deps.verificationRequests.create({
      verifierOrgId: org.id, holderDid: b.holderDid, requestedTypes: b.requestedTypes, purpose: b.purpose,
      credentialUseCaseKey: b.credentialUseCaseKey ?? null,
      challenge: randomUUID(), status: "pending", presentationVpJwt: null, consentedAt: null,
      consentedCredentialIds: null, verifierResult: null, verifiedAt: null,
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

  app.get("/me/verification-requests", { schema: S.myVerificationRequests, ...authScoped("verifications:read") }, async (request) => {
    const claims = request.user as TokenClaims;
    if (!claims.did) return [];
    const rows = await deps.verificationRequests.listByHolder(claims.did);
    const mine = await deps.credentials.listByHolder(claims.did);
    return rows.map((r) => ({
      ...vreqView(r),
      eligibleCredentials: mine
        .filter((c) => !c.revoked && c.acceptance === "accepted" && r.requestedTypes.includes(c.type))
        .map((c) => ({ id: c.id, type: c.type, issuerDid: c.issuerDid, issuedAt: c.issuedAt })),
    }));
  });

  app.get("/verification-requests/:id", { schema: S.getVerificationRequest, ...authScoped("verifications:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const r = await deps.verificationRequests.get(id);
    const isHolder = !!claims.did && claims.did === r?.holderDid;
    const isVerifier = !!r && verifierScoped(claims, r);
    if (!r || (!isHolder && !isVerifier)) return notFound(reply, "verification request not found");
    return vreqView(r);
  });

  app.post("/verification-requests/:id/consent", { schema: S.consentVerificationRequest, ...authScoped("credentials:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const { credentialIds } = request.body as { credentialIds: string[] };
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
    const updated = await deps.verificationRequests.setConsented(r.id, { vpJwt, credentialIds, at: new Date().toISOString() });
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
    if (!r || !verifierScoped(claims, r)) return notFound(reply, "verification request not found");
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
      return {
        id: jti, type, issuer: issuerDid, claims: c.credential?.claims ?? null,
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
    // Asset-less audit entry: "kyc-verified" is not a LifecycleAction, so cast at
    // the append boundary (analytics/holders folds only match specific actions and
    // never see this row anyway — it carries no assetId).
    await deps.audit.append({ actorId: actorOf(request).id, action: "kyc-verified" as LifecycleAction, payload: { userId: target.id, did: result.holderDid, issuer: result.credential!.issuer, country: vcClaims.country ?? null } });
    return { status: "approved", did: result.holderDid, claims: result.credential!.claims, issuer: result.credential!.issuer };
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

  // --- cashflows (financial terms servicing) --------------------------------

  // Derived read-time status — "due"/"overdue" flow from the date; the stored
  // "executing" (an in-flight execute claim) surfaces as-is.
  function cashflowStatus(cf: CashflowRecord, today: string): "scheduled" | "due" | "overdue" | "executing" | "executed" {
    if (cf.status === "executed") return "executed";
    if (cf.status === "executing") return "executing";
    if (cf.dueDate < today) return "overdue";
    if (cf.dueDate === today) return "due";
    return "scheduled";
  }

  app.get("/assets/:id/cashflows", { schema: S.listCashflows, ...authScoped("assets:read") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    const today = new Date().toISOString().slice(0, 10);
    const rows = (await deps.cashflows.listByAsset(asset.id)).map((cf) => ({ ...cf, status: cashflowStatus(cf, today) }));
    // Preview the next payable row (redemption is payable any time; coupons once due).
    const next = rows.find((cf) => cf.status !== "executed" && (cf.kind === "redemption" || cf.status !== "scheduled"));
    let preview: { cashflowId: string; split: { address: string; amount: string }[] } | null = null;
    if (next) {
      const split = splitProRata(BigInt(next.amount), await assetBalancesOf(deps, asset.id));
      // Mirror the execute route: the default payer (the treasury) keeps its own share.
      if (asset.treasuryAccount) dropPayerShare(split, asset.treasuryAccount);
      preview = { cashflowId: next.id, split: [...split].map(([address, amount]) => ({ address, amount: amount.toString() })) };
    }
    return { cashflows: rows, preview };
  });

  // Execute a cashflow: pay every holder its pro-rata share of the amount from
  // the payer's cash account; a redemption additionally burns all remaining
  // balances and matures the asset. Redemption is gated on the `burn`
  // capability up front, so an Issuer (no burn) is rejected before any money
  // moves; coupons work for an Issuer.
  app.post("/assets/:id/cashflows/:cfId/execute", { schema: S.executeCashflow, ...authScoped("assets:transfer") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "act");
    if (!asset) return reply;
    const actor = actorOf(request);
    if (!deps.rbac.can(actor.role, "issue")) {
      return reply.code(403).send({ error: "FORBIDDEN", message: `role '${actor.role}' may not execute cashflows` });
    }
    const { cfId } = request.params as { id: string; cfId: string };
    const cf = await deps.cashflows.get(cfId);
    if (!cf || cf.assetId !== asset.id) return notFound(reply, "cashflow not found");
    // A redemption burns balances at the end — require the capability BEFORE any
    // money moves, or an Issuer would pay holders and then fail mid-burn.
    if (cf.kind === "redemption" && !deps.rbac.can(actor.role, "burn")) {
      return reply.code(403).send({ error: "FORBIDDEN", message: `role '${actor.role}' lacks the 'burn' capability required to settle a redemption` });
    }
    // Friendly pre-check; the atomic claim below is the authoritative guard.
    if (cf.status === "executed") return reply.code(409).send({ error: "ALREADY_EXECUTED", message: "this cashflow was already executed" });

    const today = new Date().toISOString().slice(0, 10);
    // Coupons pay only once due; redemption may settle early (early repayment).
    if (cf.kind === "coupon" && cf.dueDate > today) {
      return reply.code(400).send({ error: "NOT_DUE", message: `coupon is due ${cf.dueDate}` });
    }
    // Settling the redemption marks the asset matured and burns balances, which
    // would silently forfeit any earlier coupon that was never paid out.
    if (cf.kind === "redemption") {
      const siblings = await deps.cashflows.listByAsset(asset.id);
      if (siblings.some((s) => s.seq < cf.seq && s.status !== "executed")) {
        return reply.code(409).send({ error: "COUPONS_OUTSTANDING", message: "execute all coupons before settling the redemption" });
      }
      // Early open-listings check for good error ordering (before the funds
      // check tells the desk to record a repayment). The authoritative re-check
      // still runs post-claim to close the create-listing race window.
      const openEarly = await deps.listings.listByAsset(asset.id, "open");
      if (openEarly.length > 0) {
        return reply.code(409).send({ error: "OPEN_LISTINGS_BLOCK_SETTLEMENT", message: "cancel open listings before settling — escrowed tokens cannot be redeemed" });
      }
    }

    const payer = (request.body as { from?: string } | null)?.from ?? asset.treasuryAccount ?? null;
    if (!payer) return reply.code(400).send({ error: "NO_PAYER", message: "supply 'from' (the funded payer account) — this asset has no treasury account" });
    // Payer authorization: the asset's own treasury is always a valid payer;
    // any other account must be within the caller's use-case scope (mirrors
    // /cash/credit). PlatformAdmin is unrestricted via scopedAccounts.
    const claims = request.user as TokenClaims;
    const isTreasuryPayer = asset.treasuryAccount !== null && asset.treasuryAccount.toLowerCase() === payer.toLowerCase();
    if (!isTreasuryPayer && claims.role !== "PlatformAdmin") {
      const scoped = await scopedAccounts(claims);
      if (!scoped.some((a) => a.address === payer)) {
        return reply.code(403).send({ error: "OUT_OF_SCOPE", message: "that payer account is not in your use case" });
      }
    }

    // Maker-checker: when settlement is gated, capture it (all validations above
    // have already passed) as a pending proposal instead of paying out now.
    const useCase = await deps.useCases.get(asset.useCaseKey);
    const proposal = await proposeIfGated(request, useCase, "cashflow-execute", asset.id, { cfId: cf.id, from: payer });
    if (proposal) return reply.code(202).send({ proposal: proposalView(proposal) });

    // Pro-rata payout + (redemption) burn/mature + markExecuted + audit — shared
    // with the maker-checker approval path (executed as the proposer there).
    try {
      const executed = await executeCashflowCore(deps, actor, asset, cf, payer, request.log);
      return { cashflow: { ...executed, status: "executed" } };
    } catch (err) {
      if (err instanceof CodedError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // --- maker-checker proposals --------------------------------------------
  async function scopedProposal(request: FastifyRequest, reply: FastifyReply): Promise<ProposalRecord | null> {
    const { id } = request.params as { id: string };
    const p = await deps.proposals.get(id);
    // Visibility is per-kind: token kinds are use-case scoped, credential kinds
    // org scoped. Never scopedToCaller here — a null useCaseKey would match every
    // unscoped user (null === null) and leak across orgs.
    if (!p || !(await proposalKind(p.kind).canView(deps, request.user as TokenClaims, p))) {
      notFound(reply, "proposal not found");
      return null;
    }
    return p;
  }

  app.get("/proposals", { schema: S.listProposals, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    const q = request.query as { status?: string; useCaseKey?: string };
    const rows = claims.role === "PlatformAdmin"
      ? await deps.proposals.list(q.useCaseKey, q.status)
      // A caller sees their use-case proposals AND their org's proposals. Both are
      // indexed; the __none__ sentinel keeps an unscoped user from matching every
      // null-useCaseKey (credential) proposal.
      : await (async () => {
        const byUseCase = await deps.proposals.list(claims.useCaseKey ?? NO_USE_CASE, q.status);
        const byOrg = claims.orgId ? await deps.proposals.listByOrg(claims.orgId, q.status) : [];
        const seen = new Set(byUseCase.map((p) => p.id));
        return [...byUseCase, ...byOrg.filter((p) => !seen.has(p.id))];
      })();
    return rows.filter((p) => decidableByPrincipal(request, p.kind)).map(proposalView);
  });

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

  /**
   * May this principal DECIDE a proposal of `kind`? For a human: always (their
   * role and the kind's own `canApprove` decide). For a key: only when its
   * scopes cover the kind's declared `apiScope`.
   *
   * Used both to gate `decide()` and to FILTER the listing — a key that could
   * never act on a proposal has no business reading its payload either. That
   * link matters: the payload of an `onboard-user` proposal describes a human
   * being (email, role, KYC country), and the listing is scoped by tenancy, not
   * by kind, so without this any key with any scope read all of them.
   */
  function decidableByPrincipal(request: FastifyRequest, kind: string): boolean {
    const key = request.apiKey;
    if (!key) return true;
    const required = proposalKind(kind).apiScope;
    // `== null` catches undefined too. `apiScope` is a REQUIRED field, so an
    // unanswered kind cannot compile — but types are not a runtime guard, and
    // the stated intent is that an unanswered kind fails CLOSED. Make the
    // runtime say the same thing.
    if (required == null) return false;
    return scopeAllows(key.scopes, required);
  }

  async function executeProposal(request: FastifyRequest, p: ProposalRecord, proposer: Actor): Promise<void> {
    await proposalKind(p.kind).execute({ deps, log: request.log }, proposer, p);
  }

  async function decide(request: FastifyRequest, reply: FastifyReply, verdict: "approve" | "reject") {
    const p = await scopedProposal(request, reply);
    if (!p) return reply;
    const claims = request.user as TokenClaims;
    // EN-B: THE OTHER HALF OF THE SCOPE MAP.
    // Every scoped mutating route on this platform returns 202 + a proposal —
    // the operation itself happens HERE, on final approval. Gating only the
    // routes that DRAFT would therefore gate nothing: a key with any scope at
    // all could approve an issuance it was refused permission to request.
    // So the required scope is derived from the proposal's KIND (declared on the
    // handler, a required field so a future kind cannot be added without an
    // answer) and enforced before any state changes — no approval is recorded,
    // nothing is executed, and an under-scoped key learns nothing about the
    // proposal beyond what `scopedProposal` already let it see.
    // This applies to REJECT too: rejecting runs compensation (fee refunds,
    // asset state changes), which is just as much a decision.
    const machineKey = request.apiKey;
    if (machineKey && !decidableByPrincipal(request, p.kind)) {
      const required = proposalKind(p.kind).apiScope;
      // `== null` (not `=== null`): an unanswered kind is refused outright, the
      // same fail-closed reading `decidableByPrincipal` uses.
      if (required == null) {
        return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: `an API key may not decide '${p.kind}' proposals` });
      }
      return reply.code(403).send({
        error: "INSUFFICIENT_SCOPE",
        message: `this API key lacks the '${required}' scope required to decide a '${p.kind}' proposal`,
        details: { required, granted: machineKey.scopes },
      });
    }
    if (p.status !== "pending") return reply.code(409).send({ error: "PROPOSAL_NOT_PENDING", message: `proposal is ${p.status}` });
    if (claims.id === p.proposerId) return reply.code(403).send({ error: "SELF_APPROVAL", message: "the proposer may not decide their own proposal" });
    if (!(await proposalKind(p.kind).canApprove(deps, claims, p))) {
      return reply.code(403).send({ error: "NOT_ELIGIBLE", message: `role '${claims.role}' may not decide '${p.kind}' proposals` });
    }

    if (verdict === "reject") {
      // CAS pending → rejected FIRST, so a lost race yields 409 and a won race
      // never strands the proposal in a non-terminal state if a later step throws.
      if (!(await deps.proposals.claimDecided(p.id, "rejected"))) return reply.code(409).send({ error: "PROPOSAL_NOT_PENDING", message: "already decided" });
      const rejected = await deps.proposals.setStatus(p.id, "rejected");
      await proposalKind(p.kind).compensate?.({ deps, log: request.log }, p, "rejected");
      return { proposal: proposalView(rejected) };
    }

    let withApproval: ProposalRecord;
    try {
      withApproval = await deps.proposals.addApproval(p.id, { userId: claims.id, email: claims.email, at: new Date().toISOString() });
    } catch (err) {
      if ((err as { code?: string }).code === "ALREADY_APPROVED") {
        return reply.code(409).send({ error: "ALREADY_APPROVED_BY_YOU", message: "you already approved this proposal" });
      }
      throw err;
    }
    if (withApproval.approvals.length < withApproval.required) return { proposal: proposalView(withApproval) };

    // Threshold reached — CAS pending → approved so exactly one approval executes.
    if (!(await deps.proposals.claimDecided(p.id, "approved"))) {
      return reply.code(409).send({ error: "PROPOSAL_NOT_PENDING", message: "another approval already finalized this proposal" });
    }
    const proposerUser = await deps.users.findById(p.proposerId);
    if (!proposerUser || !proposerUser.active) {
      // The captured issuance never activates — refund its fee (parity with reject).
      await proposalKind(p.kind).compensate?.({ deps, log: request.log }, p, "failed");
      return { proposal: proposalView(await deps.proposals.setStatus(p.id, "failed", "PROPOSER_INACTIVE")) };
    }
    try {
      await executeProposal(request, p, { id: proposerUser.id, role: proposerUser.role });
      const executed = await deps.proposals.setStatus(p.id, "executed");
      // EN-C. AFTER executeProposal returns, so the event means "it happened",
      // not "it was approved" — the catch below turns a failed execution into a
      // `failed` proposal and emits nothing.
      // `p.orgId` is null for token kinds (they carry useCaseKey instead), so
      // fall back to the OWNING ORG OF THE USE CASE rather than letting a
      // tokenization proposal degrade to platform-scope and reach nobody.
      // The payload is NOT `p.payload`: proposal payloads are internal command
      // arguments and have already been found to carry a bcrypt passwordHash
      // (EN-B final review). Kind + ids only.
      await emitEvent(deps, {
        type: "proposal.executed",
        orgId: p.orgId || (p.useCaseKey ? await ownerOrgOfUseCase(deps, p.useCaseKey) : null),
        useCaseKey: p.useCaseKey,
        subjectId: p.id,
        data: {
          proposalId: p.id, kind: p.kind, orgId: p.orgId, useCaseKey: p.useCaseKey,
          assetId: p.assetId, status: executed.status,
          proposerId: p.proposerId, approvals: executed.approvals.length,
          required: executed.required, decidedAt: executed.decidedAt,
        },
      }, request.log);
      return { proposal: proposalView(executed) };
    } catch (err) {
      const code = err instanceof CodedError ? err.code : err instanceof PolicyError ? err.code : "EXECUTION_FAILED";
      // A gated issuance that fails to activate keeps no fee (parity with reject).
      await proposalKind(p.kind).compensate?.({ deps, log: request.log }, p, "failed");
      return { proposal: proposalView(await deps.proposals.setStatus(p.id, "failed", `${code}: ${(err as Error).message}`)) };
    }
  }

  app.post("/proposals/:id/approve", { schema: S.decideProposal, ...auth }, (req, rep) => decide(req, rep, "approve"));
  app.post("/proposals/:id/reject", { schema: S.decideProposal, ...auth }, (req, rep) => decide(req, rep, "reject"));

  // --- documents ----------------------------------------------------------
  // A small document store so the dashboard can upload a file (e.g. an invoice
  // PDF) and reference it from asset metadata by URL + sha256.
  // Only desk operators (issue-capable) and auditors may read stored documents —
  // these hold sensitive off-ledger invoice evidence, not public assets.
  const canReadDoc = (role: Role): boolean => deps.rbac.can(role, "issue") || role === "Auditor";
  // EN-B: DELIBERATELY UNSCOPED. An upload stores opaque bytes readable only by
  // issue-capable roles and an Auditor; it grants nothing on its own, and every
  // act that USES a document (staging an invoice, issuing against it) is scoped.
  // Body size is already capped, so an unscoped key cannot use it to grow.
  app.post("/documents", { schema: S.uploadDocument, bodyLimit: DOC_UPLOAD_BODY_LIMIT, ...auth }, async (request, reply) => {
    const actor = actorOf(request);
    if (!deps.rbac.can(actor.role, "issue")) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to upload documents" });
    const doc = await storeUploadedDocument(deps.documents, request.body as { contentType: string; dataBase64: string });
    return reply.code(201).send({ id: doc.id, url: `/api/v1/documents/${doc.id}`, sha256: doc.sha256, size: doc.size });
  });
  app.get("/documents/:id", { schema: S.getDocument, ...authScoped("assets:read") }, async (request, reply) => {
    const actor = actorOf(request);
    if (!canReadDoc(actor.role)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to read documents" });
    const { id } = request.params as { id: string };
    const doc = await deps.documents.get(id);
    if (!doc) return notFound(reply, "document not found");
    // Never let the browser sniff/execute stored bytes as the API origin: pin the
    // stored (allowlisted) type, forbid sniffing, and force download.
    return reply
      .header("content-type", doc.contentType)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename="document-${id}"`)
      .send(doc.bytes);
  });
}
