/**
 * THE PLATFORM BOTH PRODUCTS STAND ON.
 *
 * Sessions, organizations, the roster, maker-checker proposals, the audit chain,
 * documents, webhooks, events and the chain catalogue. Every deployment serves
 * these whichever products it sells — see route-domains.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { mintResetToken, resetTokenMatches } from "../../mail/reset-tokens.js";
import { kycDecisionEmail, orgApprovedEmail, passwordResetEmail, welcomeCredentialsEmail } from "../../mail/templates.js";
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
import { issueAdminKycCredential } from "../../shared/identity-verification.js";
import { vreqView } from "../../identity/verification-request-view.js";
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
import { refuseIfOrgOwned, resolveAccountId, WALLET_ELIGIBLE_ROLES } from "../../shared/wallets.js";
import { S } from "../schemas/index.js";
import { holdsValidCredential, IDENTITY_CREDENTIAL_TYPE } from "../../identity/identity-assertions.js";
import { actorOf, claimsOf, contextOf, isPositiveIntString, machinePrincipal, notFound, requirePrincipal, requireScope, scopedToCaller, type TokenClaims } from "../support.js";
import { NO_USE_CASE, canAdministerUser, BCRYPT_ROUNDS, LOGIN_WINDOW_MS, MAX_DOC_BYTES, DOC_UPLOAD_BODY_LIMIT, ALLOWED_DOC_TYPES, storeUploadedDocument, orgOwnsDocument, decodeVcJti, devKeyFromSeed, orgView, orgCapabilityMissing } from "./common.js";
import type { BrandLogoErrorCode, RouteContext } from "./context.js";

export function registerSharedRoutes(app: FastifyInstance, deps: AppDeps, ctx: RouteContext): void {
  const { principal, auth, authScoped, loginThrottled, proposeIfGated, orgScoped, resolveUseCaseDomain, useCaseKeysByDomain, linkedWallet, orgMemberCapabilityViolation, brandLogoRefusal, proposalView, ensureOrg, manageableTarget, mapHeld, issuerNameResolver, isRenderableArtwork, RENDERABLE_ARTWORK_TYPES, assetChain, verifyAsset, redactPayload } = ctx;
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
    const wallet = await linkedWallet(user.accountId);
    const useCaseDomain = await resolveUseCaseDomain(user.useCaseKey);
    // The org's capability envelope rides the session (like useCaseDomain): the
    // web builds its SessionUser from login/qr-poll, never /me.
    const org = user.orgId ? await deps.organizations.get(user.orgId) : null;
    // EN-E, Task 6b: the BRAND rides it for the same reason, off the SAME org
    // record already loaded above. Without this the shell painted the platform
    // palette on every sign-in and every reload of a branded org until a
    // follow-up /me landed — and /me's own comment ("the shell needs the brand
    // on first paint") was describing a promise this route did not keep.
    return {
      token: app.jwt.sign(claims),
      user: {
        ...claims, walletAddress: wallet?.address ?? null, useCaseDomain,
        orgCapabilities: org?.capabilities ?? null,
        brandLogoDocumentId: org?.brandLogoDocumentId ?? null,
        brandAccent: org?.brandAccent ?? null,
      },
    };
  });

  app.post("/auth/forgot-password", { schema: S.forgotPassword }, async (request, reply) => {
    if (loginThrottled(request.ip)) return reply.code(429).send({ error: "TOO_MANY_REQUESTS", message: "too many attempts; try again later" });
    const { email } = request.body as { email: string };
    const user = await deps.users.findByEmail(email);
    // Same response whether or not the account exists — no enumeration.
    if (user && user.kind === "human" && user.active) {
      await deps.passwordResetTokens.invalidateAllForUser(user.id);
      const minted = await mintResetToken();
      await deps.passwordResetTokens.create({
        userId: user.id, tokenPrefix: minted.prefix, tokenHash: minted.hash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      const resetUrl = `${deps.publicWebUrl}/reset-password?token=${minted.token}`;
      const email_ = passwordResetEmail({ resetUrl });
      // Fire-and-forget: do NOT await the send. Awaiting here would make this
      // branch's response time depend on a real SMTP round-trip while the
      // "no such user" branch returns instantly, letting an attacker
      // distinguish real accounts from non-existent ones by response timing —
      // defeating the uniform-202 anti-enumeration design of this endpoint.
      void deps.mail.send(user.email, email_.subject, email_.text, email_.html).catch((err) => request.log.error({ err }, "[mail] forgot-password send failed"));
    }
    return reply.code(202).send({});
  });

  app.post("/auth/reset-password", { schema: S.resetPassword }, async (request, reply) => {
    const { token, newPassword } = request.body as { token: string; newPassword: string };
    const prefix = token.slice(0, 8);
    const row = await deps.passwordResetTokens.findByPrefix(prefix);
    const invalid = () => reply.code(400).send({ error: "INVALID_TOKEN", message: "this reset link is invalid or has expired" });
    if (!row || row.usedAt || new Date(row.expiresAt) < new Date()) return invalid();
    if (!(await resetTokenMatches(token, row.tokenHash))) return invalid();
    await deps.users.update(row.userId, { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) });
    await deps.passwordResetTokens.markUsed(row.id);
    await deps.passwordResetTokens.invalidateAllForUser(row.userId);
    await deps.audit.append({ actorId: row.userId, action: "password-reset" as LifecycleAction, payload: { userId: row.userId } });
    return reply.code(200).send({ status: "ok" });
  });


  app.get("/me", { schema: S.me, ...auth }, async (request) => {
    const base = actorOf(request);
    const claims = request.user as TokenClaims;
    const useCaseDomain = await resolveUseCaseDomain(claims.useCaseKey);
    const org = claims.orgId ? await deps.organizations.get(claims.orgId) : null;
    // useCaseKey mirrors the login response so a scoped desk operator's session
    // principal is self-describing (role + scope + domain) from /me alone.
    // EN-E rides the SAME org record already loaded above: the shell needs the
    // brand on first paint, and a second fetch would be a second round-trip
    // before it could avoid a flash of the platform palette.
    return {
      ...base, useCaseKey: claims.useCaseKey ?? null, useCaseDomain, orgCapabilities: org?.capabilities ?? null,
      brandLogoDocumentId: org?.brandLogoDocumentId ?? null,
      brandAccent: org?.brandAccent ?? null,
    };
  });


  app.patch("/me/wallet", { schema: S.updateMyWallet, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { walletAddress: string };
    if (!WALLET_ELIGIBLE_ROLES.has(claims.role)) {
      return reply.code(400).send({ error: "ROLE_CANNOT_HOLD_WALLET", message: `role '${claims.role}' cannot hold tokens` });
    }
    // Checked BEFORE upsert, which is deliberately deep: `accounts.upsert`
    // OVERWRITES the label of an existing row at that address, so upserting
    // first and checking after would silently relabel another user's account
    // with this caller's email before the conflict was ever detected.
    // AN UNLINKED ADDRESS IS NOT A FREE ADDRESS. The check below asks "is
    // someone else already on it?", and a use case's auto-provisioned treasury
    // answers "no" — it has no linked user, by construction. It is also
    // published: `Asset.treasuryAccount` rides every asset read, so any Buyer
    // or Trader in the use case can read it and claim it here. Claiming it
    // would link a person to the one account `isUseCaseTreasury` exempts from
    // `requireJurisdiction`/`requireVerifiedIdentity`, turning this branch's
    // compliance exemption into a compliance bypass. Ownership is the
    // discriminator, not linkage — shared with `resolveAccountId`, the other
    // door into wallet linkage, so both refuse the same address.
    const orgOwned = await refuseIfOrgOwned(deps, b.walletAddress);
    if (orgOwned) return reply.code(409).send(orgOwned);
    const existing = await deps.accounts.findByAddress(b.walletAddress);
    if (existing) {
      const owner = await deps.users.findByAccountId(existing.id);
      if (owner && owner.id !== claims.id) {
        return reply.code(409).send({ error: "ADDRESS_IN_USE", message: "this address is already linked to another user" });
      }
    }
    const account = await deps.accounts.upsert(b.walletAddress, claims.email);
    await deps.users.update(claims.id, { accountId: account.id });
    return { accountId: account.id, walletAddress: account.address };
  });


  app.get("/config", { schema: S.config, ...auth }, async () => ({
    domains: deps.enabledDomains,
    // The console hides its DID and credential surfaces when there are none —
    // ADDITIVE, and declared in the response schema or fast-json-stringify would
    // drop it on the way out.
    subjectIdentifiers: deps.subjectIdentifiers ?? "did",
  }));


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
        const wallet = await linkedWallet(user?.accountId ?? null);
        const claims: TokenClaims | null = user ? claimsOf(user) : null;
        const useCaseDomain = user ? await resolveUseCaseDomain(user.useCaseKey) : null;
        const org = user?.orgId ? await deps.organizations.get(user.orgId) : null;
        // The brand rides here for the SAME reason it rides POST /auth/login
        // (EN-E, Task 6b): this is the OTHER site the web builds a SessionUser
        // from, and a QR sign-in must not paint a different shell than a
        // password sign-in. Same org record already loaded for orgCapabilities.
        return {
          status: "authenticated", token: done.token,
          user: claims
            ? {
              ...claims, walletAddress: wallet?.address ?? null, useCaseDomain,
              orgCapabilities: org?.capabilities ?? null,
              brandLogoDocumentId: org?.brandLogoDocumentId ?? null,
              brandAccent: org?.brandAccent ?? null,
            }
            : null,
        };
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
    const unchanged: { assetId: string; seq: number }[] = [];
    const refused: { assetId: string; seq: number; reason: string }[] = [];
    for (const a of items) {
      const chain = await assetChain(a.id);
      if (chain.length === 0) continue;
      const head = chain[chain.length - 1]!;
      // ANCHORING AT AN ALREADY-ANCHORED SEQ IS NOT A ROUTINE RE-ANCHOR.
      // Every call used to append a row unconditionally, so an unchanged head
      // accumulated duplicate anchors — and if the head at that seq had CHANGED,
      // the new row was a fresh on-chain attestation that the rewritten history
      // was genuine. Anchoring is the one thing that catches a fully consistent
      // rewrite; it must not be usable to bless one.
      const existing = (await deps.auditAnchors.list(a.id)).filter((x) => x.seq === head.seq);
      if (existing.length > 0) {
        if (existing.every((x) => x.hash === head.hash)) {
          unchanged.push({ assetId: a.id, seq: head.seq });   // nothing moved: no tx, no row, no gas
        } else {
          // The head at an anchored seq differs from what was attested. That is
          // the tamper signal itself — report it, never overwrite it.
          refused.push({ assetId: a.id, seq: head.seq, reason: "ANCHOR_MISMATCH" });
          request.log.warn({ assetId: a.id, seq: head.seq }, "refusing to re-anchor: head differs from the existing anchor at this seq");
        }
        continue;
      }
      try {
        const receipt = await deps.chains.resolveAdapter(a.chainId).anchor({ id: a.id, chainId: a.chainId, contractRef: a.contractRef }, head.hash);
        const rec = await deps.auditAnchors.create({ assetId: a.id, seq: head.seq, hash: head.hash, txHash: receipt.txHash, chainId: a.chainId });
        anchored.push({ assetId: a.id, seq: rec.seq, txHash: rec.txHash });
      } catch (err) {
        request.log.error({ err, assetId: a.id }, "audit anchor failed for asset — skipped (best-effort)");
      }
    }
    return { anchored, unchanged, refused };
  });


  // --- users (scoped provisioning) ----------------------------------------
  app.get("/users", { schema: S.listUsers, ...authScoped("users:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (!canManageUsers(claims.role)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to manage users" });
    const rows = await deps.users.list(claims.role === "PlatformAdmin" ? undefined : claims.useCaseKey ?? NO_USE_CASE);
    return rows.map((u) => ({ id: u.id, email: u.email, role: u.role, useCaseKey: u.useCaseKey, accountId: u.accountId, active: u.active, kycStatus: u.kycStatus, kyc: u.kyc, did: u.did ?? null }));
  });


  app.post("/users", { schema: S.createUser, ...authScoped("users:onboard") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; did?: string; kyc?: KycDetails };
    // A DID MINTED SOMEWHERE ELSE is accepted only by a deployment that does not
    // run the identity product — there it is the ONLY way a holder's tokenization
    // record can carry the DID the Identity service knows them by, and without it
    // `requireVerifiedIdentity` can never pass on a split topology: onboarding
    // mints a fresh DID per deployment, so the same person ends up with two and
    // the assertion asks about one Identity has never seen. Where this deployment
    // DOES own identity it mints its own, and accepting a caller's would be a way
    // to point a wallet at someone else's verified identity.
    // PLAIN IDENTIFIERS. Both fields ask this deployment to do something with a
    // subject DID, and there are none here. Refusing is the difference between a
    // named 400 and a user who looks KYC-approved while holding nothing.
    if ((deps.subjectIdentifiers ?? "did") === "plain" && (b.did || b.kyc)) {
      return reply.code(400).send({
        error: "SUBJECT_IDENTIFIERS_PLAIN",
        message: "this deployment runs users as ordinary accounts (SUBJECT_IDENTIFIERS=plain) — " +
          "it issues no DIDs and no credentials, so 'did' and 'kyc' cannot be honoured",
      });
    }
    if (b.did && deps.enabledDomains.includes("identity")) {
      return reply.code(400).send({
        error: "DID_NOT_ACCEPTED",
        message: "this deployment issues its own DIDs — omit 'did' (it is for a deployment that delegates identity)",
      });
    }
    // The two are alternatives, not a pair: `kyc` asks THIS deployment to issue a
    // KycCredential, which is exactly the act a delegated deployment does not
    // perform. Refusing is the difference between a clear 400 and a holder who
    // looks onboarded and is quietly unverifiable.
    if (b.did && b.kyc) {
      return reply.code(400).send({
        error: "DID_NOT_ACCEPTED",
        message: "'did' links an identity issued elsewhere; 'kyc' asks this deployment to issue one — send one or the other",
      });
    }
    const targetUseCaseKey = claims.role === "PlatformAdmin" ? (b.useCaseKey || null) : claims.useCaseKey;
    const targetDomain = targetUseCaseKey ? useCaseDomainOf(targetUseCaseKey, await useCaseKeysByDomain()) : undefined;
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
      const accountId = await resolveAccountId(deps, b.role, b.walletAddress, b.email);
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
      let kycStatus = created.kycStatus;
      if (b.did) {
        // Linked, not minted — see the refusal above. No membership VC either:
        // this deployment holds no key for this subject and cannot sign as them.
        // kycStatus: same reasoning as the gated onboarding path in
        // user-kinds.ts — a linked DID was already vouched for by the
        // deployment that issued it, and there is no local `kyc` claim to
        // separately review (did/kyc are mutually exclusive).
        await deps.users.update(created.id, { did: b.did, kycStatus: "approved" });
        mintedDid = b.did;
        kycStatus = "approved";
      } else if (org) {
        try {
          mintedDid = await mintMembership(org, created, b.role);
        } catch (err) {
          await deps.users.remove(created.id);
          throw err;
        }
      }
      return reply.code(201).send({ id: created.id, email: created.email, role: created.role, useCaseKey: created.useCaseKey, accountId: created.accountId, kycStatus, orgId: claims.orgId ?? null, did: mintedDid });
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
        did: b.did ?? null,
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
    const { tokenizationKeys: tokKeys, credentialKeys: credKeys } = await useCaseKeysByDomain();
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
        did: null, // CSV batch carries no DID column; linking is the single-user door
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
    // Narrowed once, into its own variable: `patch.kycStatus` is declared as
    // the full KycStatus union (it also accepts "pending" elsewhere), so
    // TypeScript can't carry this block's narrowing across the assignment —
    // reading `patch.kycStatus` back out below would widen right back.
    const kycDecision = b.kycStatus === "approved" || b.kycStatus === "rejected" ? b.kycStatus : undefined;
    if (kycDecision) patch.kycStatus = kycDecision;
    const updated = await deps.users.update(id, patch);
    if (kycDecision) {
      const notice = kycDecisionEmail({ decision: kycDecision });
      await deps.mail.send(updated.email, notice.subject, notice.text, notice.html).catch((err) => request.log.error({ err }, "[mail] kyc-decision send failed"));
    }
    return { id: updated.id, email: updated.email, role: updated.role, useCaseKey: updated.useCaseKey, accountId: updated.accountId, active: updated.active, kycStatus: updated.kycStatus };
  });


  // Admin-issued counterpart of identity.ts's presentation-based
  // `/users/:id/identity/verify`: for a user with no external credential to
  // present (the common case for a seeded operator/investor with no
  // organization onboarding behind them), an admin attests KYC directly. Kept
  // in shared.ts, not identity.ts, because route-domains.ts classifies it
  // "shared" — see the note there for why.
  app.post("/users/:id/identity/issue-kyc", { schema: S.issueAdminKyc, ...authScoped("users:onboard") }, async (request, reply) => {
    const target = await manageableTarget(request, reply);
    if (!target) return reply;
    const { legalName, country } = request.body as { legalName: string; country: string };
    const { did, credentialId, issuerDid } = await issueAdminKycCredential(deps, target, { legalName, country });
    await deps.users.update(target.id, {
      kycStatus: "approved",
      kyc: { ...(target.kyc ?? {}), country, legalName, issuerDid, credentialId, verifiedAt: new Date().toISOString() },
    });
    await deps.audit.append({ actorId: actorOf(request).id, action: "kyc-verified" as LifecycleAction, payload: { userId: target.id, did, issuer: issuerDid, country } });
    return { status: "approved", did, credentialId };
  });


  // The rest of "My identity" — the resolved DID document, the caller's own
  // held credentials, and their accept/reject/request-changes on those — moved
  // here from identity.ts alongside issue-kyc: route-domains.ts classifies all
  // of them "shared" so the panel loads on any console for a roster member who
  // now has a DID, tokenization included. /dids/:did/resolve (public) and the
  // dev issuer stay in identity.ts; only the authenticated per-DID document
  // lookup moved.
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


  // The holder's own inbox — the other half of "My identity" issue-kyc now
  // needs answering on every console. Verifier-side listing/consent/verify
  // stay in identity.ts; this is only the caller's own view of requests
  // addressed to their own DID.
  app.get("/me/verification-requests", { schema: S.myVerificationRequests, ...authScoped("verifications:read") }, async (request) => {
    const claims = request.user as TokenClaims;
    if (!claims.did) return [];
    const rows = await deps.verificationRequests.listByHolder(claims.did);
    const mine = await deps.credentials.listByHolder(claims.did);
    // The holder needs the issuer's name to tell apart same-type credentials
    // from different issuers when picking which one to present.
    const nameOf = issuerNameResolver();
    // `claims` on each eligible credential is full credential content — the
    // same thing GET /me/credentials returns, and THAT route is gated on the
    // DIFFERENT scope `credentials:read` (see just above). This route is
    // gated on `verifications:read` alone, so a scoped machine principal
    // holding only that scope must not receive it here — that would let
    // `verifications:read` read what only `credentials:read` is supposed to
    // grant. A human session carries no API key at all (`request.apiKey` is
    // undefined) and is unrestricted the same way `requireScope` always is
    // for a JWT caller — same pattern as `decidableByPrincipal` above.
    const key = request.apiKey;
    const canSeeClaims = !key || scopeAllows(key.scopes, "credentials:read");
    return Promise.all(rows.map(async (r) => ({
      ...vreqView(r),
      eligibleCredentials: await Promise.all(
        mine
          .filter((c) => !c.revoked && c.acceptance === "accepted" && r.requestedTypes.includes(c.type))
          .map(async (c) => ({
            id: c.id, type: c.type, issuerDid: c.issuerDid, issuerName: await nameOf(c.issuerDid),
            issuedAt: c.issuedAt, expiresAt: c.expiresAt,
            // So the holder's own consent UI can render one row per field
            // without a second round-trip, when the caller is allowed to see it.
            ...(canSeeClaims ? { claims: c.subjectClaims } : {}),
          })),
      ),
    })));
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
  // consent, which needs `credentials:present` because it signs AS the holder
  // and DISCLOSES those credentials to a third-party verifier, irreversibly.
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


  // --- organizations -------------------------------------------------------
  // Public: a registrant uploads a statutory certificate BEFORE registering. Same
  // limits as the authenticated store; throttled like /orgs/register. The caller
  // cannot read the document back — only authenticated reviewers can.
  app.post("/orgs/register/documents", { schema: S.uploadKybDocument, bodyLimit: DOC_UPLOAD_BODY_LIMIT }, async (request, reply) => {
    if (loginThrottled(request.ip)) return reply.code(429).send({ error: "TOO_MANY_REQUESTS", message: "too many attempts; try again later" });
    // Unowned by definition: this runs BEFORE the organization exists. Nothing
    // can later claim these bytes on ownership grounds, which is right — a KYB
    // certificate is reviewed by the platform, never re-served to a tenant.
    const doc = await storeUploadedDocument(deps.documents, request.body as { contentType: string; dataBase64: string }, null, null, null);
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
    // ANOTHER DOOR `brandLogoRefusal` closes (see its comment for the question
    // that finds these). `companyProfile.documents` is a caller-supplied
    // document reference persisted into `Organization.companyProfile` JSON at
    // create below, exactly the same shape as `StagedInvoice.documentId`: this
    // route checks only that the id exists, no ownership (there is no owning
    // org yet — registration is what creates one), no purpose. Reachable by
    // execution: upload a logo through `POST /orgs/{id}/branding/logo`, pass
    // its id as `company.documents.cinCertificate.id` here, and it is stored as
    // the statutory certificate — a reference no "is this still pinned" query
    // can see, and the reviewer's `DocLink` has no re-upload path once the
    // registration is submitted.
    const cinBrandLogo = brandLogoRefusal(cinDoc, "KYB_DOCUMENT_IS_BRAND_LOGO",
      `document '${b.company.documents.cinCertificate.id}' was uploaded as an organization brand logo and cannot be used as a KYB certificate`);
    if (cinBrandLogo) return reply.code(400).send(cinBrandLogo);
    let gstinRef: KybDocumentRef | null = null;
    if (b.company.documents.gstinCertificate) {
      const g = await deps.documents.get(b.company.documents.gstinCertificate.id);
      if (!g) return reply.code(400).send({ error: "DOCUMENT_NOT_FOUND", message: "GSTIN certificate upload not found" });
      const gstinBrandLogo = brandLogoRefusal(g, "KYB_DOCUMENT_IS_BRAND_LOGO",
        `document '${b.company.documents.gstinCertificate.id}' was uploaded as an organization brand logo and cannot be used as a KYB certificate`);
      if (gstinBrandLogo) return reply.code(400).send(gstinBrandLogo);
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
      brandLogoDocumentId: null, brandAccent: null, // EN-E: a new org starts on the platform look
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


  app.post("/orgs", { schema: S.createOrg, ...authScoped("usecases:provision") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may create organizations" });
    if (!deps.didMasterConfigured && deps.isProduction) return reply.code(503).send({ error: "DID_KEYSTORE_UNCONFIGURED", message: "DID_MASTER_KEY must be set to create organizations" });
    const b = request.body as {
      name: string; orgType: "bank" | "corporate" | "msme" | "government" | "verifier"; registrationId?: string; jurisdiction?: string;
      admin?: { name: string; email: string; password: string };
    };
    // POST /orgs keeps its explicit name-taken guard (a duplicate is a 409 here,
    // whereas ensureOrg deliberately RETURNS the existing org for the idempotent
    // provisioner). After this guard the name is free, so ensureOrg always creates.
    if (await deps.organizations.findByName(b.name)) return reply.code(409).send({ error: "NAME_TAKEN", message: "an organization with that name already exists" });
    if (b.registrationId && (await deps.organizations.findByRegistrationId(b.registrationId))) return reply.code(409).send({ error: "REGISTRATION_TAKEN", message: "an organization with that registration id already exists" });
    if (b.admin && (await deps.users.findByEmail(b.admin.email))) return reply.code(409).send({ error: "EMAIL_TAKEN", message: "email already registered" });
    let org: OrganizationRecord;
    try {
      org = await ensureOrg(b.name, b.orgType, { registrationId: b.registrationId ?? null, jurisdiction: b.jurisdiction ?? null, actorId: claims.id });
    } catch (err) {
      if (err instanceof CodedError && err.code === "REGISTRY_UNAVAILABLE") return reply.code(502).send({ error: err.code, message: err.message });
      throw err;
    }
    let issuerDid: string | null = null;
    let orgCredentialId: string | null = null;
    if (b.admin) {
      // active:false until the ceremony below succeeds — the same shape
      // self-service registration uses, just completed inline instead of at a
      // later /orgs/:id/approve. kycStatus "approved": there is no KYB queue
      // gating this admin's KYC the way self-service's is.
      const adminUser = await deps.users.create({
        email: b.admin.email, passwordHash: await bcrypt.hash(b.admin.password, BCRYPT_ROUNDS),
        role: "OrgAdmin", useCaseKey: null, accountId: null, active: false,
        kycStatus: "approved", kyc: { legalName: b.admin.name }, orgId: org.id, kind: "human",
      });
      try {
        const ceremony = await activateOrgAdmin(org, adminUser);
        issuerDid = ceremony.issuerDid;
        orgCredentialId = ceremony.orgCredentialId;
        const welcome = welcomeCredentialsEmail({ email: adminUser.email, password: b.admin.password, loginUrl: `${deps.publicWebUrl}/login` });
        await deps.mail.send(adminUser.email, welcome.subject, welcome.text, welcome.html).catch((err) => request.log.error({ err }, "[mail] welcome send failed"));
      } catch (err) {
        // The org itself is already active and on-chain (ensureOrg has no
        // "pending" to fall back to, unlike approve) — keep it, and remove
        // only the admin login this call tried and failed to activate, so a
        // retry via a fresh POST /orgs/:id/users doesn't collide on email.
        await deps.users.remove(adminUser.id).catch(() => undefined);
        request.log.error({ err }, "org admin activation failed during direct org creation");
        return reply.code(502).send({ error: "ADMIN_ACTIVATION_FAILED", message: "the organization was created, but its admin login could not be activated — retry by adding the admin separately" });
      }
    }
    return reply.code(201).send({
      id: org.id, name: org.name, did: org.did, orgType: org.orgType, registrationId: org.registrationId,
      jurisdiction: org.jurisdiction, verified: org.verified, status: org.status,
      adminEmail: b.admin?.email ?? null, issuerDid, orgCredentialId,
    });
  });


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
      try {
        // The KYB approval ceremony is platform governance on a REAL
        // organization — it is refused to machine principals entirely
        // (`platformGovernanceRefused`), so its OrganizationCredential
        // anchors exactly as before.
        const ceremony = await activateOrgAdmin(active, admin);
        issuerDid = ceremony.issuerDid;
        orgCredentialId = ceremony.orgCredentialId;
      } catch (err) {
        // activateOrgAdmin already restored the admin row to its pre-approval
        // state (no sub-DID, still inactive) — roll the ORG back to pending too.
        await deps.organizations.setStatus(org.id, "pending");
        await deps.organizations.setVerified(org.id, false, null);
        request.log.error({ err }, "org admin activation failed");
        return reply.code(502).send({ error: "ADMIN_ACTIVATION_FAILED", message: "could not complete the issuance ceremony — reverted to pending" });
      }
    }
    await deps.audit.append({ actorId: claims.id, action: "org-approved" as LifecycleAction, payload: { orgId: org.id, did: org.did, orgCredentialId, issuerDid } });
    if (admin) {
      const notice = orgApprovedEmail({ orgName: active.name, loginUrl: `${deps.publicWebUrl}/login` });
      await deps.mail.send(admin.email, notice.subject, notice.text, notice.html).catch((err) => request.log.error({ err }, "[mail] org-approved send failed"));
    }
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


  // EN-E: an org's own logo and accent colour.
  app.patch("/orgs/:id/branding", { schema: S.updateOrgBranding, ...auth }, async (request, reply) => {
    // MEASURED, not assumed: without this line a key bound to any OrgAdmin or
    // PlatformAdmin service user rewrote the brand with an EMPTY scope list —
    // the role predicate below reads the bound user's role and cannot tell the
    // two credentials apart. Omitting `authScoped` withholds a scope; it does
    // not withhold the route. So the refusal has to be stated here, or both the
    // OpenAPI description and the DELIBERATELY_UNSCOPED entry are false.
    if (machinePrincipal(request)) {
      return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key may not set an organization's branding" });
    }
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    // AN EXPLICIT ROLE PREDICATE, and an org-ownership check beside it.
    // `authScoped` would be no gate at all here: `requireScope` returns early
    // for a human session, so a scope narrows API keys and nothing else. And
    // without the ownership half, one organization could rebrand another —
    // the cross-tenant shape this program's reviews keep finding.
    const isOwnOrgAdmin = claims.role === "OrgAdmin" && !!claims.orgId && claims.orgId === id;
    if (claims.role !== "PlatformAdmin" && !isOwnOrgAdmin) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only this organization's admin or a platform admin may set its branding" });
    }
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");

    const b = request.body as { brandLogoDocumentId?: string | null; brandAccent?: string | null };
    const patch: BrandingPatch = {};
    if ("brandAccent" in b) {
      // Throws INVALID_BRAND_ACCENT -> 400. Normalizes to lowercase.
      patch.brandAccent = b.brandAccent === null ? null : validateBrandAccent(b.brandAccent);
    }
    if ("brandLogoDocumentId" in b) {
      // `in` is the test, not truthiness — an omitted key leaves the column
      // alone. `?? null` only narrows the type: JSON cannot deliver `undefined`
      // for a key that is present, so the optional-ness is a TypeScript artefact.
      const logoId: string | null = b.brandLogoDocumentId ?? null;
      if (logoId === null) patch.brandLogoDocumentId = null;
      else {
        const doc = await deps.documents.get(logoId);
        // THE ARTWORK REVIEW'S RULE, ON THIS DOOR TOO. Existence is not
        // entitlement: `GET /orgs/:id/branding/logo` serves whatever this
        // column names to every MEMBER of the org, so pinning a document
        // another org owns would republish their mark to this org's roster.
        //
        // ONE ANSWER FOR "GONE" AND "NOT YOURS", matching
        // `checkBackgroundDocument` — telling a caller which of the two it is
        // makes this route an existence oracle over the whole document store.
        //
        // NO PLATFORM-ADMIN EXEMPTION, and the first draft's reasoning for one
        // was wrong on both halves. It claimed the exemption was needed for the
        // platform-uploads-on-an-org's-behalf path: it is not, because
        // `POST /orgs/:id/branding/logo` stamps `ownerOrgId = id`, so a
        // PlatformAdmin's own upload already passes this check. And it claimed
        // refusing would forbid nothing since a PlatformAdmin may read every
        // document anyway: reading bytes and GRANTING a different org's roster
        // access to them are not the same power. `ownerOrgId === null` (a
        // pre-org KYB upload, or a row written before the column existed) fails
        // too — such a document is nobody's mark to publish.
        if (!doc || !orgOwnsDocument(doc, id)) {
          return reply.code(400).send({ error: "BRAND_LOGO_NOT_FOUND", message: "no such document" });
        }
        // Not "is it an image" — "can the renderer DRAW it". `image/webp` is a
        // perfectly good image that pdfkit cannot read, and the certificate
        // renderer swallows the throw, so an org that uploaded one would see
        // its mark in the console and never on a certificate, with nothing
        // saying why. Same predicate, same reason, as the artwork door.
        if (!isRenderableArtwork(doc.contentType)) {
          return reply.code(400).send({ error: "BRAND_LOGO_NOT_AN_IMAGE", message: `document is ${doc.contentType}; a brand logo must be image/png or image/jpeg — the renderer can draw nothing else` });
        }
        patch.brandLogoDocumentId = logoId;
      }
    }
    const updated = await deps.organizations.setBranding(id, patch);
    await deps.audit.append({ actorId: claims.id, action: "org-branding-set" as LifecycleAction, payload: { orgId: id, ...patch } });
    return orgView(updated);
  });


  // EN-E, Task 3b: a dedicated upload door for an org's own logo. `POST
  // /documents` gates on `rbac.can(role, "issue")` and MATRIX.OrgAdmin is
  // ["read"] alone — an OrgAdmin gets 403 there, so without this route the
  // brand editor would have no working upload path for the exact role it is
  // built for. Widening the general store was rejected: it also serves KYB
  // documents, certificate artwork and asset attachments, a much larger blast
  // radius than a logo needs. Gated IDENTICALLY to PATCH /orgs/:id/branding —
  // same machine-principal refusal, same PlatformAdmin-or-own-OrgAdmin check —
  // because uploading the mark is the same console act as setting the colour.
  app.post("/orgs/:id/branding/logo", { schema: S.uploadOrgBrandLogo, bodyLimit: DOC_UPLOAD_BODY_LIMIT, ...auth }, async (request, reply) => {
    // See the identical comment on PATCH /orgs/:id/branding: omitting this
    // withholds a scope, not the route, and a zero-scope key is the widest
    // hole of all because scopes are never consulted for a route with no
    // `authScoped(...)`.
    if (machinePrincipal(request)) {
      return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key may not upload an organization's brand logo" });
    }
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const isOwnOrgAdmin = claims.role === "OrgAdmin" && !!claims.orgId && claims.orgId === id;
    if (claims.role !== "PlatformAdmin" && !isOwnOrgAdmin) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only this organization's admin or a platform admin may upload its brand logo" });
    }
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");

    const b = request.body as { contentType: string; dataBase64: string };
    // Narrower than the shared allowlist ON PURPOSE, and narrower still than
    // "is it an image". This route exists so an OrgAdmin can upload a MARK, and
    // the only thing that ever draws one is pdfkit, which reads PNG and JPEG.
    // `image/webp` would store, display in the console, and then silently fail
    // to appear on every certificate — the renderer's throw is swallowed. Refuse
    // it here, where the person who picked the file is still on the screen.
    if (!isRenderableArtwork(b.contentType)) {
      return reply.code(415).send({ error: "UNSUPPORTED_DOCUMENT_TYPE", message: "a brand logo must be image/png or image/jpeg — the renderer can draw nothing else" });
    }
    // OWNED BY THE ORG BEING BRANDED, not by the caller. A PlatformAdmin
    // uploading a mark on an org's behalf is acting for that org, and their own
    // `claims.orgId` (the platform org, or none) would record the wrong owner —
    // which the artwork review established is an authorization fact, not a
    // label. `id` is already proven to be a real org two lines up.
    const doc = await storeUploadedDocument(deps.documents, b, id, "brand-logo", (request.user as TokenClaims).id);

    // THE PRUNE RUNS AFTER THE STORE, NEVER BEFORE. The old mark is not dropped
    // until the new bytes are safely written — a prune-first ordering would, on
    // a failed upload, leave the org with no logo at all.
    //
    // `getPinned` is called FRESH by the prune, immediately before each
    // candidate delete, not once up front — a PATCH that pins an older mark
    // anywhere before that per-row read is correctly seen and the row is
    // spared. That shrinks the window to one round trip per row; it does NOT
    // make "a mark pinned meanwhile survives" a guarantee — see `lostPinnedId`
    // below for the residual, and what is lost when it is hit: that row's
    // bytes, plus a `brandLogoDocumentId` left pointing at nothing.
    //
    // THROWS rather than returning a guessed null when the org cannot be
    // re-read (`organizations.remove` exists and is called at :3791, so a
    // vanished org is reachable, not just theoretical) — treating "unknown"
    // as "nothing pinned" would let this delete the org's live mark. The
    // throw is caught per-row inside the prune and treated as "leave it",
    // which is also what makes this best-effort: it cannot 500 the request
    // after the upload has already succeeded.
    const getPinned = async (): Promise<string | null> => {
      const fresh = await deps.organizations.get(id);
      if (!fresh) throw new Error(`brand-logo prune: organization ${id} could not be re-read`);
      return fresh.brandLogoDocumentId;
    };

    // THE ACTUAL CONCURRENCY GUARD IS THE AGE FLOOR, NOT LISTING ORDER. A
    // pre-store snapshot was tried and found insufficient — reproduced on a
    // real server over real TCP against real SQLite: it only takes ONE side
    // of two concurrent uploads to list AFTER the other's store lands, and
    // that side deletes the other's row. `graceMs` sidesteps the ordering
    // question entirely by asking a different one ("how old is this row?"),
    // which is what actually tells a concurrent sibling apart from an
    // abandoned pick. See the long comment in `brand-logo-prune.ts`.
    const graceMs = deps.brandLogoPruneGraceMs ?? BRAND_LOGO_PRUNE_GRACE_MS;
    const { removed, lostPinnedId } = await pruneSupersededBrandLogos(deps.documents, id, { justUploaded: doc.id, getPinned, graceMs }, request.log);

    // Only when something actually went, so the log records deletions rather
    // than every upload. `audit.append` itself is NOT best-effort here — it
    // matches every other call site in this file, and on this path the
    // deletion has already happened, so a 500 here means the caller retries
    // and the retry adds one more (bounded, later-collected) row, not that
    // anything unsafe repeats.
    if (removed.length) {
      const pinnedForAudit = await getPinned().catch(() => null);
      await deps.audit.append({
        actorId: claims.id,
        action: "brand-logo-pruned" as LifecycleAction,
        payload: {
          orgId: id, removed, kept: doc.id, pinned: pinnedForAudit,
          ...(lostPinnedId ? { lostPinnedId } : {}),
        },
      });
    }
    return reply.code(201).send(doc);
  });


  // EN-E, Task 6b: THE READ HALF OF THE SAME DOOR. Task 3b opened the upload and
  // nobody measured the way back: `GET /documents/:id` gates on
  // `rbac.can(role, "issue") || role === "Auditor"`, so an OrgAdmin was refused
  // the very bytes they had just successfully uploaded, and the sidebar mark was
  // invisible to every non-desk member (Trader, Buyer, Holder, Verifier) too.
  // Widening that route was rejected for the same reason as on the write side:
  // the store also holds off-ledger invoice evidence and KYB certificates, so
  // relaxing its read gate for a logo relaxes it for all of them.
  //
  // THE URL CARRIES NO DOCUMENT ID, and that is the containment. The route reads
  // `org.brandLogoDocumentId` itself, so a member can fetch their own org's mark
  // and nothing else — this cannot become a second way to enumerate the store.
  app.get("/orgs/:id/branding/logo", { schema: S.getOrgBrandLogo, ...auth }, async (request, reply) => {
    // See the identical comment on PATCH /orgs/:id/branding: omitting
    // `authScoped` withholds a SCOPE, not the ROUTE, and a zero-scope key is the
    // widest hole of all because scopes are never consulted for a route that
    // declares none. Unless the refusal is stated here, both the OpenAPI
    // description and the DELIBERATELY_UNSCOPED row are false.
    if (machinePrincipal(request)) {
      return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key may not read an organization's brand logo" });
    }
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    // DELIBERATELY WIDER THAN ITS TWO SIBLINGS, and the difference is intended:
    // SETTING the brand is an OrgAdmin act, but SEEING it is every member's
    // shell — a Trader, Buyer, Holder or Verifier of this org renders the same
    // sidebar. So the predicate is membership, not rank. A reader diffing this
    // against the PATCH gate is looking at a decision, not a missing role check.
    // The org-ownership half is unchanged, and it is what keeps a member of one
    // tenant out of another's brand.
    if (claims.role !== "PlatformAdmin" && (!claims.orgId || claims.orgId !== id)) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to read that organization's brand logo" });
    }
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    // An unbranded org and a brand whose document has since been deleted are the
    // same answer to a caller drawing chrome: there is no mark. Distinguishing
    // them would only tell the caller a document id once existed.
    if (!org.brandLogoDocumentId) return notFound(reply, "organization has no brand logo");
    const doc = await deps.documents.get(org.brandLogoDocumentId);
    if (!doc) return notFound(reply, "organization has no brand logo");
    // The SAME hardening as GET /documents/:id: pin the stored type, forbid
    // sniffing, force download — never let the browser execute stored bytes as
    // the API origin. The web fetches this into a Blob and makes an object URL,
    // so `attachment` costs the caller nothing and keeps the two doors in parity.
    return reply
      .header("content-type", doc.contentType)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename="brand-logo-${id}"`)
      .send(doc.bytes);
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


  /**
   * THE ISSUANCE CEREMONY for one org's admin: mint the admin's sub-DID +
   * membership VC, activate the user, and have the platform sign an
   * OrganizationCredential over the org's KYB facts (empty beyond
   * name/orgType when the org has no companyProfile — a directly-created org
   * never collected one). Extracted from `/orgs/:id/approve` so `POST /orgs`
   * can run the identical ceremony for an admin it provisions inline, instead
   * of going through the pending-approval queue.
   *
   * On failure, undoes exactly what this function did to `admin` (restores
   * its prior DID fields and `active: false`) and rethrows — the CALLER
   * decides what to do with the org itself (approve rolls it back to
   * "pending"; a fresh direct-create instead removes the admin user it just
   * made, since there is no "pending" state to fall back to).
   */
  async function activateOrgAdmin(org: OrganizationRecord, admin: UserRecord): Promise<{ issuerDid: string; orgCredentialId: string }> {
    const priorDid = admin.did;
    const priorSeed = admin.didSeedEncrypted;
    try {
      await mintMembership(org, admin, "OrgAdmin");
      await deps.users.update(admin.id, { active: true });
      const platformOrg = await ensurePlatformIssuerOrg(deps);
      const p = org.companyProfile;
      // Named kybClaims (not `claims`) — a handler's `claims` is the caller's
      // TokenClaims, and shadowing it here would be a trap for future edits.
      const kybClaims: Record<string, unknown> = {
        name: org.name, orgType: org.orgType,
        ...(p ? {
          cin: p.cin, pan: p.pan, state: p.state, pincode: p.pincode,
          dateOfIncorporation: p.dateOfIncorporation, category: p.category,
          ...(p.gstin ? { gstin: p.gstin } : {}),
        } : {}),
      };
      const cred = await issueCredentialFor(deps, {
        issuerOrg: platformOrg, subjectDid: org.did, type: "OrganizationCredential",
        claims: kybClaims, validityDays: credentialTypeDef("OrganizationCredential").validityDays, proposalId: null,
      });
      return { issuerDid: platformOrg.did, orgCredentialId: cred.id };
    } catch (err) {
      await deps.users.update(admin.id, { did: priorDid, didSeedEncrypted: priorSeed, active: false });
      throw err;
    }
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
    const accountId = await resolveAccountId(deps, b.role, b.walletAddress, b.email);
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
   *
   * THE ONE DOOR TO A SINGLE ENDPOINT — every per-endpoint route (patch, rotate,
   * delete, ping, deliveries, redeliver) goes through it.
   */
  async function orgEndpoint(reply: FastifyReply, orgId: string, whId: string): Promise<WebhookEndpointRecord | null> {
    const e = await deps.webhookEndpoints.findById(whId);
    if (!e || e.orgId !== orgId || e.deletedAt !== null) {
      notFound(reply, "webhook endpoint not found");
      return null;
    }
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
    const endpoints = await deps.webhookEndpoints.listByOrg(id);
    return { endpoints: endpoints.map(webhookView) };
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
    // An inflight row is claimed by a running dispatcher pass, and resetting it
    // would let a second worker claim it while the first is mid-POST — a
    // double-send, whose settle would clobber the reset anyway.
    //
    // THE CHECK IS IN THE WRITE, not in the read above. `repo.requeue` carries
    // the `status !== "inflight"` predicate into the UPDATE itself, so a claim
    // landing between this route's read and its write loses instead of being
    // silently undone. `attempts` goes back to zero inside the same statement,
    // so a replayed delivery gets the FULL retry schedule rather than dying on
    // its next attempt because the original run exhausted it.
    const replayed = await deps.webhookDeliveries.requeue(delivery.id, new Date().toISOString());
    if (!replayed) {
      return reply.code(409).send({ error: "DELIVERY_INFLIGHT", message: "this delivery is being attempted right now" });
    }
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
   * org's log; ANYONE ELSE reads exactly their own org's, and NOBODY ELSE reads
   * the platform-scope bucket. `undefined` (every org) and `null` (the
   * platform-scope rows) are one keystroke apart and mean opposite things, so
   * both branches are spelled out rather than folded into a ternary on a value.
   *
   * THE ORG-LESS PRINCIPAL READS NOTHING, and that guard is the fix for a real
   * cross-tenant leak rather than a defensive flourish. `requireScope` only
   * narrows API KEYS, so a JWT session carries `webhooks:read` unconditionally
   * and this route has no role check of its own; before the guard below, every
   * principal whose `orgId` is null — a seeded user, a holder, an org-less
   * Verifier desk operator — selected exactly the `orgId: null` rows. That is
   * not an empty bucket, because resolution failures land in it: an asset event
   * whose use case has no `ownerOrgId` (every seeded/legacy tokenization use
   * case), a credential whose holder DID no longer resolves, a verification
   * raised at an org-less desk. A gold-loan buyer could read a carbon asset's
   * `asset.issued` payload it gets a 404 for on `GET /assets/:id`, and a third
   * party's `holderDid` and requested credential types out of
   * `verification.requested`.
   *
   * Nothing legitimate needs the null branch: a PlatformAdmin already reads every
   * row including the platform-scope ones through the `{}` branch, and no route
   * can create an endpoint whose `orgId` is null, so no org-less principal has
   * anything of its own in this log to read.
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
    // An ABSENT `orgId` key is what the repos read as "every org", so the
    // PlatformAdmin branch is the one that leaves `scope` empty — and the only
    // one. A non-admin either narrows to a real org id or reads nothing at all:
    // it can never reach the query with `orgId: null`, which would have selected
    // the platform-scope bucket (see the note above). Written as a block rather
    // than a spread ternary so the narrowing is the compiler's job too — `scope`
    // cannot hold a null or undefined `orgId` in any branch.
    const scope: { orgId?: string } = {};
    if (claims.role !== "PlatformAdmin") {
      // The caller's own cursor comes back, so the documented polling loop is
      // unaffected — it simply never advances.
      if (!claims.orgId) return { events: [], nextAfter: after };
      scope.orgId = claims.orgId;
    }
    const events = await deps.events.listAfter(after, {
      ...scope,
      ...(q.type ? { type: q.type } : {}),
      limit,
    });
    return { events, nextAfter: events.length > 0 ? events[events.length - 1]!.seq : after };
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
      // A caller sees their use-case proposals, their org's proposals, AND
      // proposals they raised themselves. All three are indexed; the
      // __none__ sentinel keeps an unscoped user from matching every
      // null-useCaseKey (credential) proposal. The third source exists for
      // orgScopedOrOwnView (credential-kinds.ts / credential-usecase-kinds.ts):
      // a use-case-scoped desk user (e.g. a scoped Issuer) proposing against a
      // DIFFERENT org's credential use case has neither that org's id nor a
      // matching useCaseKey on the proposal (it's org-scoped, useCaseKey
      // null) — without listByProposer, canView being widened to admit the
      // proposer has nothing to filter, because the index above excludes the
      // row before canView is ever consulted.
      : await (async () => {
        const byUseCase = await deps.proposals.list(claims.useCaseKey ?? NO_USE_CASE, q.status);
        const byOrg = claims.orgId ? await deps.proposals.listByOrg(claims.orgId, q.status) : [];
        const byProposer = await deps.proposals.listByProposer(claims.id, q.status);
        const seen = new Set(byUseCase.map((p) => p.id));
        const merged = [...byUseCase, ...byOrg.filter((p) => !seen.has(p.id))];
        for (const p of byOrg) seen.add(p.id);
        return [...merged, ...byProposer.filter((p) => !seen.has(p.id))];
      })();
    // THE SAME `canView` THE FETCH-ONE PATH USES. The index narrowing above is a
    // query optimisation, not the boundary: `deps.proposals.list(useCaseKey)`
    // returns EVERY proposal at that desk, and `listByOrg(orgId)` every proposal
    // of that org, while each kind admits a far narrower audience — `onboard-user`
    // only a UseCaseAdmin of the desk, the credential and governance kinds only an
    // OrgAdmin of the org. Without this the listing handed an Issuer, Trader,
    // Auditor or Holder rows whose `payload` carries the subject's KYC (legalName,
    // country, idType, idNumber) and whose approval answers 404 — a listing that
    // shows you what you may not read and offers you a decision you may not make.
    // `scopedProposal` has always enforced it one route away; this is that gate.
    // Two filters, two separate questions, neither subsuming the other:
    // `decidableByPrincipal` is the KEY's scope, `canView` is the KIND's audience.
    const decidable = rows.filter((p) => decidableByPrincipal(request, p.kind));
    const viewable = await Promise.all(decidable.map((p) => proposalKind(p.kind).canView(deps, claims, p)));
    return decidable.filter((_, i) => viewable[i]).map(proposalView);
  });


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
  //
  // `role !== "OrgAdmin"` is deliberate, not incidental: OrgAdmin now carries
  // "issue" too (it runs every use case its org owns), but that grant is
  // scoped to tokenization actions — it says nothing about this UNSCOPED,
  // platform-wide document store, which also serves KYB certificates and
  // other orgs' invoice evidence. OrgAdmin reaches its OWN org's documents
  // only through purpose-built, ownership-checked doors (branding logo, KYB
  // certificate refs) — never this raw one. Carve it out explicitly so it
  // stays excluded regardless of what future operator right "issue" grows to
  // cover, rather than leaving that guarantee resting on today's role list.
  const canReadDoc = (role: Role): boolean => (deps.rbac.can(role, "issue") && role !== "OrgAdmin") || role === "Auditor";

  // EN-B: DELIBERATELY UNSCOPED. An upload stores opaque bytes readable only by
  // issue-capable roles and an Auditor; it grants nothing on its own, and every
  // act that USES a document (staging an invoice, issuing against it) is scoped.
  // Body size is already capped, so an unscoped key cannot use it to grow.
  app.post("/documents", { schema: S.uploadDocument, bodyLimit: DOC_UPLOAD_BODY_LIMIT, ...auth }, async (request, reply) => {
    const actor = actorOf(request);
    // Same OrgAdmin carve-out as canReadDoc above, and for the same reason.
    if (!deps.rbac.can(actor.role, "issue") || actor.role === "OrgAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to upload documents" });
    // The uploader's own org, or null for a desk operator who belongs to none.
    // Null here is not a loophole: every ownership gate requires a non-null
    // match, so an unowned document is referenceable only by a PlatformAdmin.
    const doc = await storeUploadedDocument(deps.documents, request.body as { contentType: string; dataBase64: string }, (request.user as TokenClaims).orgId ?? null, null, (request.user as TokenClaims).id);
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
