/**
 * THE TOKENIZATION PRODUCT.
 *
 * Use cases and their contracts, the asset ledger, the invoice register, the
 * secondary market, settlement and analytics. A deployment without
 * `tokenization` in ENABLED_DOMAINS still registers these, and the domain gate
 * turns each into a 404 — see applyDomainGate in route-domains.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyRecord, AssetRecord, BrandingPatch, CashflowRecord, CompanyProfile, CredentialRecord, DocumentPurpose, KybDocumentRef, KycDetails, KycStatus, ListingRecord, OrganizationRecord, ProposalRecord, UserRecord, VerificationRequestRecord, WebhookEndpointRecord } from "../../persistence/types/index.js";
import { ListingConflictError } from "../../persistence/types/index.js";
import { assignableRoles, auditEntryHash, canCreateOrgMember, canCreateUser, canManageUsers, certificatePageSize, computeCashflowSchedule, CREDENTIAL_TEMPLATES, CREDENTIAL_TYPES, credentialTypeDef, credentialUseCaseType, decodeJwt, didKeyFromSeed, generateDidKey, holderPolicyAllows, instantiateTemplate, invoiceFingerprint, issueCredential, issuerBindingAllows, normalizeUseCaseDefinition, ORG_OPERATING_ROLES, orgDomainEnabled, orgRoleEnabled, PolicyError, presentCredential, presentCredentials, splitProRata, TEMPLATE_CATALOG, useCaseDomainOf, validateBrandAccent, validateCertificatePlacements, validateCredentialUseCase, validateEventTypes, validateMetadata, scopeAllows, validateOrgCapabilities, validateScopes, validateTemplate, verifierBindingAllows, verifyChain, verifyDidSignature, verifyPresentation, verifyPresentationCredentials, isDocumentSha256, type Actor, type ApiScope, type ChainEntry, type CredentialTypeSpec, type CredentialUseCaseDefinition, type LifecycleAction, type OrgDomain, type OrgOperatingRole, type OrgType, type UseCaseDefinition, type UseCaseTemplate, type CertificateFieldPlacement } from "@tokenlayer/core";
import qrcode from "qrcode";
import type { AppDeps } from "../../context.js";
import { certificateStatusBanner, humanizeKey, renderCredentialCertificate } from "../../identity/certificate.js";
import { artworkDimensions, certificateDrawList, drawCertificate } from "../../identity/certificate-artwork.js";
import { certificateLogoDocumentId, resolveCertificateFields } from "../../identity/certificate-fields.js";
import { isSupportedCurrency } from "../../tokenization/currencies.js";
import { renderContractCode } from "../../tokenization/contract-code.js";
import { deployAndCreateUseCase } from "../../tokenization/use-cases.js";
import { computeAnalytics } from "../../tokenization/analytics.js";
import { reconcile } from "../../tokenization/reconciliation.js";
import { computeIdentityDashboard } from "../../identity/identity-analytics.js";
import { issueCredentialFor, revokeCredentialById } from "../../identity/credential-issuance.js";
import { namespaceHolding } from "../../shared/usecase-namespace.js";
import { emitEvent, ownerOrgOfUseCase } from "../../shared/events.js";
import { mintOrgMembership } from "../../shared/membership.js";
import { ensurePlatformIssuerOrg, PLATFORM_ORG_NAME } from "../../shared/platform-org.js";
import { provisionTreasury } from "../../shared/wallets.js";
import { computeActivity, computePortfolio } from "../../tokenization/investor.js";
import { readErpInvoices, stageInvoice } from "../../tokenization/invoice-register.js";
import { settlementStatus } from "../../tokenization/asset-settlement.js";
import { assetBalancesOf, assetRawBalancesOf, assetStateOf, balanceOfAddress, coded, CodedError, dropPayerShare, executeCashflowCore, executeIssueActivation, runGatedAction } from "../../shared/executors.js";
import { recordSubmission } from "../../shared/ledger-transactions.js";
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
import type { BrandLogoErrorCode, RouteContext } from "./context.js";

/**
 * ONE WORDING FOR ONE FACT. Issuance and `setPrice` refuse for the identical
 * reason — a use case with no registered treasury — and used to say it two
 * different ways, only one of which named the fix. An operator who hits this
 * needs the same instruction whichever door they came through.
 */
const MISSING_TREASURY_MESSAGE = "this use case has no registered treasury — run the treasury backfill";

export function registerTokenizationRoutes(app: FastifyInstance, deps: AppDeps, ctx: RouteContext): void {
  const { principal, auth, authScoped, loginThrottled, proposeIfGated, orgScoped, resolveUseCaseDomain, useCaseKeysByDomain, linkedWallet, orgMemberCapabilityViolation, brandLogoRefusal, proposalView, ensureOrg, manageableTarget, mapHeld, isRenderableArtwork, RENDERABLE_ARTWORK_TYPES, assetChain, verifyAsset, redactPayload } = ctx;
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
  // the wallets linked to users in their own use case (no cross-tenant account enumeration),
  // plus their own use case's treasury — org-owned, so no User is ever linked to it, but an
  // Issuer/UseCaseAdmin still needs to see its address to fund and allow it in the first place.
  async function scopedAccounts(claims: TokenClaims) {
    const all = await deps.accounts.list();
    if (claims.role === "PlatformAdmin") return all;
    const users = await deps.users.list(claims.useCaseKey ?? NO_USE_CASE);
    const allowed = new Set(users.map((u) => u.accountId).filter((id): id is string => !!id));
    if (claims.useCaseKey) {
      const useCase = await deps.useCases.get(claims.useCaseKey).catch(() => null);
      if (useCase?.treasuryAccountId) allowed.add(useCase.treasuryAccountId);
    }
    return all.filter((a) => allowed.has(a.id));
  }


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
    if ((await namespaceHolding(deps, definition.key)) === "identity") {
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
    // PlatformAdmin may name an owning org explicitly in the body; absent one,
    // the use case belongs to the platform's own org — the same fallback
    // identity issuance already uses when a credential use case has no owner.
    //
    // THE SAME DUPLICATE-KEY CHECK THE ORGADMIN PATH ALREADY MAKES, and for a
    // sharper reason on this path: without it `deployAndCreateUseCase`
    // provisions a treasury Account and deploys a contract on every allowed
    // chain BEFORE `repo.create` throws on the existing key — real side
    // effects, an orphaned treasury, and a messier error than the 409 the
    // other door returns for the identical request.
    if (await deps.useCases.has(definition.key)) {
      return reply.code(409).send({ error: "USECASE_EXISTS", message: `use case '${definition.key}' already exists` });
    }
    // `||`, NOT `??`. An explicit `ownerOrgId: ""` in the body survived `??`,
    // and "" is the backfill's own sentinel for "needs an owner" — so the use
    // case would read as unowned, a later backfill run would silently reassign
    // it to the Platform org, and its already-provisioned treasury Account
    // would keep `ownerOrgId: ""` and never move with it. An empty string is
    // not an organization; it falls back like an absent one.
    const ownerOrgId = definition.ownerOrgId || (await ensurePlatformIssuerOrg(deps)).id;
    const available = new Set(deps.chains.list().map((c) => c.id));
    // Treasury provisioning happens INSIDE deployAndCreateUseCase, only after a
    // successful deploy — never on the NO_DEPLOYABLE_CHAIN path, so a failed
    // deploy can't leave an orphaned treasury Account behind.
    const created = await deployAndCreateUseCase(
      deps.useCases,
      { ...definition, ownerOrgId },
      available,
      (def, chainId) => deps.engine.deployUseCaseContract(def, chainId),
      (m) => request.log.warn(m),
      () => provisionTreasury(deps, ownerOrgId, `${definition.name} treasury`),
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
      // Preserve deployed contracts AND the registered treasury: never let an
      // update wipe either, whether the client's body omits the field (which
      // would otherwise silently null the treasury — every future mint/setPrice
      // then fails MISSING_TREASURY with no obvious cause) or sets it to some
      // other Account id (which, via the treasury's compliance exemption, would
      // covertly grant that account a permanent jurisdiction+identity bypass on
      // this use case). The treasury is provisioned once, at creation — it is
      // not a PUT-editable field.
      //
      // ownerOrgId rides the SAME preservation for a third reason. It is not
      // in the PUT schema at all, so a body that only edits a name arrives
      // with it `undefined`; `useCaseToData` then writes the column, which is
      // `String NOT NULL DEFAULT ""` — a Prisma validation error (500) on the
      // real database, and a silent null-out on the memory repo, which is
      // exactly why the branch's own (memory-backed) tests never saw it. Who
      // owns a use case is settled at creation and changed nowhere; an edit
      // must not be able to clear it either loudly or quietly.
      incoming = normalizeUseCaseDefinition({ ...(request.body as UseCaseDefinition), key, contracts: existingContracts, treasuryAccountId: existing.treasuryAccountId, ownerOrgId: existing.ownerOrgId });
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
    metadata?: Record<string, unknown>; initialSupply?: string;
    sale?: { unitPrice: string; currency: string };
  }): Promise<{ ok: true; status: number; body: unknown } | { ok: false; status: number; error: string; message: string }> {
    const { useCaseKey: bUseCaseKey, name, chainId, metadata, initialSupply, sale } = input;
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
    const wantsSupply = initialSupply !== undefined && initialSupply !== "" && initialSupply !== "0";
    if (wantsSupply && !/^\d+$/.test(initialSupply!)) {
      return { ok: false, status: 400, error: "INVALID_SUPPLY", message: "initialSupply must be a whole number" };
    }
    const actor = input.actor;
    const useCase = await deps.useCases.get(bUseCaseKey);
    // The treasury is the use case's own registered account — never client-
    // supplied. A use case created before this shipped and not yet backfilled
    // has no treasuryAccountId; that is the one case MISSING_TREASURY still
    // reaches, and the fix is running the backfill, not re-adding the field.
    const treasury = useCase.treasuryAccountId
      ? (await deps.accounts.findById(useCase.treasuryAccountId))?.address ?? null
      : null;
    // Sale terms are ALWAYS keyed to the treasury (setPrice enforces the same
    // rule — see its own MISSING_TREASURY check below) — a use case with no
    // treasury cannot be priced any more than it can be minted into.
    if ((wantsSupply || sale) && !treasury) {
      return { ok: false, status: 400, error: "MISSING_TREASURY", message: MISSING_TREASURY_MESSAGE };
    }
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
      // The engine reuses the use case contract's deploy tx as this asset's
      // issuance receipt (issue() registers within an already-deployed
      // contract, it does not itself deploy) — record() is idempotent on
      // (chainId, txHash), so every asset issued into the same contract shares
      // one row rather than fabricating a new "deploy" per asset. RULING L: the
      // deploy tx is a property of the USE-CASE CONTRACT, not of whichever
      // asset happened to be issued first — assetId: null, or the row would
      // permanently (and falsely) claim to belong to asset #1. An asset's own
      // outstanding state is carried by its own mint row, not this one.
      // GUARDED ON A NON-EMPTY HASH. An ERC-3643 issuance deploys a whole T-REX
      // suite over many transactions and reports no single hash (`txHash: ""`,
      // see EvmLedgerAdapter.deployAsset). Recording that would key one row on
      // (chainId, "") which every subsequent T-REX asset on the chain would
      // collide into — one unresolvable row standing for all of them. No row is
      // the honest outcome: we have no hash to be recoverable by.
      if (result.txHash) {
        await recordSubmission(deps, "deploy", { txHash: result.txHash, chainId, timestamp: new Date().toISOString() }, { assetId: null });
      }
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
        // `treasury` must be captured whenever EITHER a mint OR sale terms are
        // deferred — executeIssueActivation (run on approval) needs it to write
        // sale terms even when no initial supply was requested; omitting it here
        // used to mean gated issue-with-sale-only silently dropped the terms on
        // approval, with no error anywhere.
        const wantsTreasury = wantsSupply || !!sale;
        const proposal = await proposeIfGated(input.request, useCase, "issue", id, {
          ...(wantsSupply ? { initialSupply } : {}),
          ...(wantsTreasury ? { treasury } : {}),
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
    const b = request.body as { useCaseKey: string; name: string; chainId: string; metadata?: Record<string, unknown>; initialSupply?: string; sale?: { unitPrice: string; currency: string } };
    const r = await issueAssetCore({ claims: request.user as TokenClaims, actor: actorOf(request), request, ...b });
    return r.ok ? reply.code(r.status).send(r.body) : reply.code(r.status).send({ error: r.error, message: r.message });
  });


  // --- asset register (staging) --------------------------------------------
  // Staging area in front of the shared issuance path: rows (uploaded / pulled
  // from the ERP / keyed in) are validated + fingerprinted + de-duped, held as
  // StagedInvoice rows, then selectively tokenized through issueAssetCore.
  // Generic over every use case, not just the canonical invoice one — see
  // stageInvoice's fingerprint choice. Every route is gated on: use-case scope
  // (403 WRONG_USE_CASE), issue capability (403 FORBIDDEN), a known use case (404).
  async function invoiceGate(request: FastifyRequest, reply: FastifyReply): Promise<{ useCase: UseCaseDefinition; claims: TokenClaims; actor: Actor; actorId: string } | null> {
    const claims = request.user as TokenClaims;
    const actor = actorOf(request);
    const { key } = request.params as { key: string };
    if (claims.role !== "PlatformAdmin" && key !== claims.useCaseKey) {
      reply.code(403).send({ error: "WRONG_USE_CASE", message: "cannot manage a register in another use case" });
      return null;
    }
    if (!deps.rbac.can(actor.role, "issue")) {
      reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to manage the asset register" });
      return null;
    }
    const useCase = await deps.useCases.get(key).catch(() => null);
    if (!useCase) { notFound(reply, "use case not found"); return null; }
    return { useCase, claims, actor, actorId: actor.id };
  }

  /** A readable per-row label for a batch-tokenized asset: the canonical invoice
   * label for the invoice use case (unchanged), else the use case's own
   * `uniqueBy` field's value when present, else the first two required
   * metadata fields joined, else a use-case-name + row-id fallback that is
   * always available. */
  function stagedRowLabel(useCase: UseCaseDefinition, rec: { id: string; metadata: Record<string, unknown> }): string {
    if (useCase.derivedFields?.invoiceHash === "invoiceFingerprint") {
      return `${rec.metadata.invoiceNumber} · ${rec.metadata.buyerName}`;
    }
    if (useCase.uniqueBy && rec.metadata[useCase.uniqueBy] != null) {
      return String(rec.metadata[useCase.uniqueBy]);
    }
    const required = useCase.metadataSchema.required ?? [];
    const parts = required.slice(0, 2).map((f) => rec.metadata[f]).filter((v) => v != null).map(String);
    if (parts.length > 0) return parts.join(" · ");
    return `${useCase.name} ${rec.id.slice(-6)}`;
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
      // ANOTHER DOOR `brandLogoRefusal` closes: this route checks existence
      // only — no ownership, no purpose — so an org that uploaded its own
      // brand logo and never pinned it could otherwise attach those same bytes
      // as invoice evidence, a reference `Organization.brandLogoDocumentId`
      // cannot see and the prune would delete out from under.
      const brandLogo = brandLogoRefusal(d, "INVOICE_DOCUMENT_IS_BRAND_LOGO",
        `document '${documentId}' was uploaded as an organization brand logo and cannot be attached as invoice evidence`);
      if (brandLogo) return reply.code(400).send(brandLogo);
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
    // `parValue` fractionalizes the invoice use case's own `amount` field into
    // whole units (unchanged behavior). `initialSupply` is the general-purpose
    // override: every OTHER use case has no "amount to fractionalize" concept,
    // so the caller states the per-asset supply directly; absent, each row
    // mints exactly 1 unit — always valid, and right for a use case where one
    // staged row already IS one physical/legal unit (one credit, one bond).
    const { ids, chainId, parValue = 1000, initialSupply, sale } = request.body as {
      ids: string[]; chainId: string; parValue?: number; initialSupply?: string; sale?: { unitPrice: string; currency: string };
    };
    const isInvoice = gate.useCase.derivedFields?.invoiceHash === "invoiceFingerprint";
    const results: { id: string; status: string; assetId?: string; error?: string }[] = [];
    for (const id of ids) {
      const rec = await deps.stagedInvoices.get(id);
      if (!rec || rec.useCaseKey !== gate.useCase.key || rec.status !== "staged") { results.push({ id, status: "skipped" }); continue; }
      const supply = initialSupply ?? (isInvoice ? String(Math.max(1, Math.round(Number(rec.metadata.amount) / parValue))) : "1");
      const r = await issueAssetCore({
        claims: gate.claims, actor: gate.actor, request, useCaseKey: gate.useCase.key,
        name: stagedRowLabel(gate.useCase, rec), chainId,
        metadata: rec.metadata, initialSupply: supply,
        sale: sale ? { unitPrice: sale.unitPrice, currency: sale.currency } : undefined,
      });
      if (r.ok) {
        const assetId = (r.body as { asset: { id: string } }).asset.id;
        await deps.stagedInvoices.markTokenized(id, assetId, new Date().toISOString());
        // A gated use case (workflow.approvals.issue) defers the mint to a second
        // approval — issueAssetCore returns 202 with the asset already created but
        // still pending, not 201. Report that distinctly so a caller doesn't read
        // "tokenized" as "active with the supply it asked for".
        results.push({ id, status: r.status === 202 ? "pending_approval" : "tokenized", assetId });
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
    // Enrich each row with ITS OWN total supply and the treasury's remaining
    // sellable balance — folded from this asset's own audit stream, not a live
    // chain read (see assetStateOf: assets sharing a use case's contract also
    // share its raw on-chain supply/balance).
    const data = await Promise.all(
      items.map(async (a) => {
        const state = await assetStateOf(deps, a.id).catch(() => null);
        const totalSupply = state ? state.supply.toString() : null;
        const availableSupply = state && a.treasuryAccount ? balanceOfAddress(state.balances, a.treasuryAccount).toString() : null;
        const settlement = await settlementStatus(deps, a);
        return { ...a, totalSupply, availableSupply, settlement };
      }),
    );
    return { data, pagination: { limit: q.limit, offset: q.offset, total } };
  });


  app.get("/assets/:id", { schema: S.getAsset, ...authScoped("assets:read") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    // THIS asset's own supply, folded from its own audit stream — see
    // assetStateOf for why a live chain read pools across every asset sharing
    // the use case's contract.
    const state = await assetStateOf(deps, asset.id).catch(() => null);
    const totalSupply = state ? state.supply.toString() : null;
    const settlement = await settlementStatus(deps, asset);
    return { ...asset, totalSupply, settlement };
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
    // Balance is THIS asset's own literal on-chain figure, folded from its own
    // audit stream — never a live chain read (see assetRawBalancesOf; escrow
    // legs are included on purpose, unlike assetBalancesOf's economic-
    // ownership view, so this still matches what a listing/cancel/secondary-
    // buy actually did to the ledger). Frozen/allowed stay live chain reads:
    // those are compliance flags on the use case's shared contract, not an
    // amount, and are genuinely meant to apply to every asset that contract
    // issues, not one asset alone.
    const rawBalances = await assetRawBalancesOf(deps, asset.id).catch(() => new Map<string, bigint>());
    const rows = await Promise.all(
      all.map(async (acct) => ({
        id: acct.id,
        address: acct.address,
        label: acct.label,
        balance: balanceOfAddress(rawBalances, acct.address).toString(),
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


  app.get("/assets/:id/audit/verify", { schema: S.verifyAssetAudit, ...authScoped("assets:read") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    return verifyAsset(asset.id);
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
    const catalog = await deps.useCases.list();
    const { items: assets } = await deps.assets.list(
      { useCaseKey: useCaseKey ?? undefined },
      { limit: 1000 },
    );
    const { items: audit } = await deps.audit.listByAssetIds(assets.map((a) => a.id), { limit: 10000 });
    // The catalog stays WHOLE for the name/symbol/valuation lookup: it is a
    // display join over assets that have already been filtered, and narrowing
    // it too would only lose a label.
    const useCases = catalog.map((u) => ({ key: u.key, name: u.name, symbol: u.symbol, valuation: u.valuation }));
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

  app.get("/reconciliation", { schema: S.reconciliation, ...authScoped("assets:read") }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    // Reconciliation compares believed state against the chain across every use
    // case, so it is a whole-platform read: restrict it to the two roles whose
    // job that is, rather than letting any assets:read principal see everything.
    if (claims.role !== "PlatformAdmin" && claims.role !== "Auditor") return notFound(reply, "not found");
    return reconcile(deps, actorOf(request), {
      // DERIVED from confirmed transactions, not asserted by the register. An
      // asset row has no supply column, and inventing one would just move the
      // unchecked claim somewhere else.
      believedSupply: (assetId) => deps.ledgerTransactions.settledSupply(assetId),
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

    // The schema can only say `tokenId` is a string — whether it's REQUIRED
    // depends on this asset's own tokenType, which the schema never sees. An
    // empty string satisfies `type: "string"` and would otherwise reach
    // mintToken/transferToken/burnToken unchecked, minting a token with no id
    // (unrecoverable — nothing can address it afterward to fix it). Checked
    // before the maker-checker gate below so a bad proposal is never created
    // in the first place; the approver would have no way to correct it.
    if (asset.tokenType === "nonfungible" && (action === "mint" || action === "transfer" || action === "burn") && !b.tokenId?.trim()) {
      return reply.code(400).send({ error: "MISSING_TOKEN_ID", message: "tokenId is required for a non-fungible asset and must not be empty" });
    }

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
        await recordSubmission(deps, "allow", receipt, { assetId: asset.id });
        break;
      }
      case "disallow":
        receipt = await deps.engine.setAllowed(actor, ctx, b.account!, false);
        await recordSubmission(deps, "allow", receipt, { assetId: asset.id });
        break;
      case "setPrice": {
        deps.rbac.authorize(actor, "issue");
        if (!b.unitPrice || !b.currency) return reply.code(400).send({ error: "VALIDATION_ERROR", message: "setPrice requires unitPrice and currency" });
        if (!isSupportedCurrency(b.currency)) return reply.code(400).send({ error: "UNSUPPORTED_CURRENCY", message: `currency '${b.currency}' is not supported` });
        if (!isPositiveIntString(b.unitPrice)) return reply.code(400).send({ error: "INVALID_PRICE", message: "unitPrice must be a positive integer" });
        const uc = await deps.useCases.get(asset.useCaseKey);
        const treasuryAccount = uc.treasuryAccountId ? (await deps.accounts.findById(uc.treasuryAccountId))?.address ?? null : null;
        if (!treasuryAccount) return reply.code(400).send({ error: "MISSING_TREASURY", message: MISSING_TREASURY_MESSAGE });
        await deps.assets.setSaleTerms(asset.id, { unitPrice: b.unitPrice, currency: b.currency, treasuryAccount });
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
    // THIS asset's own remaining treasury balance, folded from its own audit
    // stream — not a live chain read. A sibling asset sharing the same
    // treasury address on the same simulated (or real, one-contract-per-use-
    // case) chain would otherwise mask an exhausted treasury with its own
    // unsold balance, or block a sale this asset's treasury could fulfil.
    const treasuryState = await assetStateOf(deps, asset.id).catch(() => null);
    if (!treasuryState || balanceOfAddress(treasuryState.balances, treasuryAccount) < BigInt(quantity)) {
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
      await recordSubmission(deps, "transfer", receipt, { assetId: asset.id, amount: quantity });
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
    // typed INSUFFICIENT_BALANCE beats an opaque ledger revert. THIS asset's own
    // LITERAL balance (not a live chain read, and not the economic-ownership
    // fold — a prior open listing already escrowed out of it): a sibling asset
    // sharing the same contract would otherwise let a seller list tokens they
    // hold of a DIFFERENT asset, or block a listing the raw transfer could
    // actually fulfil.
    const rawBalances = await assetRawBalancesOf(deps, asset.id).catch(() => new Map<string, bigint>());
    if (balanceOfAddress(rawBalances, seller) < BigInt(quantity)) {
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
        const allowReceipt = await deps.engine.setAllowed(allowActor, ctx, escrow, true);
        await recordSubmission(deps, "allow", allowReceipt, { assetId: asset.id });
      }
    }

    // Escrow the tokens (engine enforces RBAC, lifecycle.transfer, allowlist,
    // freeze, and the seller's lockup), then create the row. If the row create
    // fails, compensate by releasing the escrowed tokens back to the seller.
    const listReceipt = await deps.engine.escrowList(actor, ctx, seller, escrow, quantity);
    await recordSubmission(deps, "transfer", listReceipt, { assetId: asset.id, amount: quantity });
    let listing;
    try {
      listing = await deps.listings.create({ assetId: asset.id, seller, quantity, unitPrice, currency });
    } catch (err) {
      try {
        const releaseReceipt = await deps.engine.escrowRelease(actor, ctx, escrow, seller, quantity);
        await recordSubmission(deps, "transfer", releaseReceipt, { assetId: asset.id, amount: quantity });
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
        await recordSubmission(deps, "transfer", receipt, { assetId: asset.id, amount: quantity });
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
        const releaseReceipt = await deps.engine.escrowRelease(actorOf(request), contextOf(asset), escrow, listing.seller, cancelled.quantity);
        await recordSubmission(deps, "transfer", releaseReceipt, { assetId: asset.id, amount: cancelled.quantity });
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

}
