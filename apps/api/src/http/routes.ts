import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AssetRecord, KycDetails, KycStatus, ListingRecord } from "../persistence/types.js";
import { ListingConflictError } from "../persistence/types.js";
import { canCreateUser, canManageUsers, invoiceFingerprint, normalizeUseCaseDefinition, PolicyError, type Role, type UseCaseDefinition } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import { isSupportedCurrency } from "../currencies.js";
import { deployUseCaseContracts } from "../use-cases.js";
import { computeAnalytics } from "../analytics.js";
import { S } from "./schemas.js";
import { actorOf, contextOf, isPositiveIntString, notFound, requireUser, scopedToCaller, type TokenClaims } from "./support.js";

const NO_USE_CASE = "__none__"; // sentinel: a use-case key that matches no real use case (denies scoped users with no assigned use case)

const BCRYPT_ROUNDS = 12;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Registers every /api/v1 route on the given (prefixed) instance. */
export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const auth = { preHandler: requireUser(deps) };

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
    const claims: TokenClaims = { id: user.id, email: user.email, role: user.role, useCaseKey: user.useCaseKey };
    const wallet = user.accountId ? await deps.accounts.findById(user.accountId) : null;
    return { token: app.jwt.sign(claims), user: { ...claims, walletAddress: wallet?.address ?? null } };
  });

  app.get("/me", { schema: S.me, ...auth }, async (request) => actorOf(request));

  // --- catalog ------------------------------------------------------------
  app.get("/chains", { schema: S.chains, ...auth }, async () => deps.chains.list());
  app.get("/currencies", { schema: S.currencies, ...auth }, async () => deps.currencies);
  app.get("/accounts", { schema: S.accounts, ...auth }, async (request) => scopedAccounts(request.user as TokenClaims));

  app.get("/use-cases", { schema: S.listUseCases, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    const all = await deps.useCases.list();
    return claims.role === "PlatformAdmin" ? all : all.filter((u) => u.key === claims.useCaseKey);
  });
  app.get("/use-cases/:key", { schema: S.getUseCase, ...auth }, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!scopedToCaller(request.user as TokenClaims, key)) return notFound(reply, `unknown use case '${key}'`);
    if (!(await deps.useCases.has(key))) return notFound(reply, `unknown use case '${key}'`);
    return deps.useCases.get(key);
  });
  app.post("/use-cases", { schema: S.createUseCase, ...auth }, async (request, reply) => {
    if ((request.user as TokenClaims).role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may create use cases" });
    // Normalise (validates shape + fills tokenType) before deploying so an invalid
    // definition fails fast without deploying any contract.
    let definition: UseCaseDefinition;
    try {
      definition = normalizeUseCaseDefinition(request.body as UseCaseDefinition);
    } catch (err) {
      if (err instanceof PolicyError) return reply.code(400).send({ error: err.code, message: err.message });
      throw err;
    }
    // Deploy the use case's contract on each allowed chain that is available in the
    // registry (fabric is always available in the simulated stack). Best-effort per
    // chain: a failure leaves that chain pending; we require at least one success.
    const available = new Set(deps.chains.list().map((c) => c.id));
    const contracts = await deployUseCaseContracts(
      definition,
      available,
      (def, chainId) => deps.engine.deployUseCaseContract(def, chainId),
      (m) => request.log.warn(m),
    );
    if (Object.keys(contracts).length === 0) {
      return reply.code(400).send({
        error: "NO_DEPLOYABLE_CHAIN",
        message: `no allowed chain is available to deploy '${definition.key}'; configure at least one of: ${definition.allowedChainIds.join(", ")}`,
      });
    }
    return reply.code(201).send(await deps.useCases.create({ ...definition, contracts }));
  });

  app.post("/use-cases/:key/deploy", { schema: S.deployUseCase, ...auth }, async (request, reply) => {
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

  app.put("/use-cases/:key", { schema: S.updateUseCase, ...auth }, async (request, reply) => {
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

  // --- assets -------------------------------------------------------------
  app.post("/assets", { schema: S.issueAsset, ...auth }, async (request, reply) => {
    const { useCaseKey: bUseCaseKey, name, chainId, metadata, treasuryAccount, initialSupply, sale } =
      request.body as { useCaseKey: string; name: string; chainId: string; metadata?: Record<string, unknown>; treasuryAccount?: string; initialSupply?: string; sale?: { unitPrice: string; currency: string; treasuryAccount: string } };
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin" && bUseCaseKey !== claims.useCaseKey) {
      return reply.code(403).send({ error: "WRONG_USE_CASE", message: "cannot issue into another use case" });
    }
    // Validate sale terms if provided
    if (sale) {
      if (!isSupportedCurrency(sale.currency)) {
        return reply.code(400).send({ error: "UNSUPPORTED_CURRENCY", message: `currency '${sale.currency}' is not supported` });
      }
      if (!isPositiveIntString(sale.unitPrice)) {
        return reply.code(400).send({ error: "INVALID_PRICE", message: "unitPrice must be a positive integer" });
      }
    }
    // The treasury holds the initial supply and is the seller for the marketplace.
    const treasury = treasuryAccount ?? sale?.treasuryAccount;
    const wantsSupply = initialSupply !== undefined && initialSupply !== "" && initialSupply !== "0";
    if (wantsSupply) {
      if (!/^\d+$/.test(initialSupply!)) {
        return reply.code(400).send({ error: "INVALID_SUPPLY", message: "initialSupply must be a whole number" });
      }
      if (!treasury) {
        return reply.code(400).send({ error: "MISSING_TREASURY", message: "a treasury account is required to mint initial supply" });
      }
    }
    const actor = actorOf(request);
    const useCase = await deps.useCases.get(bUseCaseKey);
    // Initial supply is fungible-only — reject up front, before charging any fee.
    if (wantsSupply && useCase.tokenType !== "fungible") {
      return reply.code(400).send({ error: "SUPPLY_UNSUPPORTED", message: "initial supply is only supported for fungible assets" });
    }

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
    if (useCase.uniqueBy) {
      const existing = await deps.assets.findByMetadata(useCase.key, useCase.uniqueBy, meta[useCase.uniqueBy]);
      if (existing) return reply.code(409).send({ error: "DUPLICATE_INVOICE", message: "an invoice with this fingerprint is already tokenized" });
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
          return reply.code(400).send({ error: "NO_WALLET", message: "your account has no linked wallet to pay the issuance fee" });
        }
        if (BigInt(await deps.cash.balanceOf(feeCurrency, feePayer)) < BigInt(issuanceFlat)) {
          return reply.code(400).send({ error: "INSUFFICIENT_FUNDS", message: `you need ${issuanceFlat} ${feeCurrency} to cover the issuance fee` });
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
        status: "active",
        createdBy: actor.id,
        unitPrice: null,
        currency: null,
        treasuryAccount: null,
      });
      if (sale) {
        await deps.assets.setSaleTerms(id, sale);
      }
      // Auto-allowlist the treasury and mint the requested initial supply into it,
      // so the asset is immediately funded and (if priced) available to buy.
      if (wantsSupply) {
        const created = await deps.assets.get(id);
        const ctx = contextOf(created!);
        if (useCase.compliance.allowlist) {
          await deps.engine.setAllowed(actor, ctx, treasury!, true);
        }
        await deps.engine.mint(actor, ctx, treasury!, initialSupply!);
      }
    } catch (err) {
      // Issuance failed after the fee moved — refund it so the issuer isn't charged
      // for an asset that was never created (mirrors the buy path's compensation).
      if (issuanceFeeCharged && feePayer && feeAccount) {
        await deps.cash.transfer(issuanceFeeCharged.currency, feeAccount, feePayer, issuanceFeeCharged.amount).catch(() => {});
      }
      throw err;
    }
    const finalAsset = await deps.assets.get(id);
    return reply.code(201).send({ asset: finalAsset, txHash: result.txHash, ...(issuanceFeeCharged ? { issuanceFee: issuanceFeeCharged } : {}) });
  });

  app.get("/assets", { schema: S.listAssets, ...auth }, async (request) => {
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

  app.get("/assets/:id", { schema: S.getAsset, ...auth }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    const totalSupply = await deps.engine.totalSupply(actorOf(request), contextOf(asset)).catch(() => null);
    return { ...asset, totalSupply };
  });

  app.get("/assets/:id/accounts", { schema: S.assetAccounts, ...auth }, async (request, reply) => {
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

  app.get("/assets/:id/tokens", { schema: S.assetTokens, ...auth }, async (request, reply) => {
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

  app.get("/assets/:id/audit", { schema: S.assetAudit, ...auth }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    const q = request.query as { limit: number; offset: number };
    const { items, total } = await deps.audit.listByAsset(asset.id, { limit: q.limit, offset: q.offset });
    return { data: items, pagination: { limit: q.limit, offset: q.offset, total } };
  });

  // --- analytics ----------------------------------------------------------
  app.get("/analytics", { schema: S.analytics, ...auth }, async (request) => {
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

  // --- lifecycle actions --------------------------------------------------
  app.post("/assets/:id/actions/:action", { schema: S.action, ...auth }, async (request, reply) => {
    const { action } = request.params as { action: string };
    const asset = await scopedAsset(request, reply, "act");
    if (!asset) return reply;
    const actor = actorOf(request);
    const ctx = contextOf(asset);
    const b = (request.body ?? {}) as Record<string, string>;
    const isNft = asset.tokenType === "nonfungible";

    let receipt;
    switch (action) {
      case "mint":
        receipt = isNft ? await deps.engine.mintToken(actor, ctx, b.to!, b.tokenId!, b.uri) : await deps.engine.mint(actor, ctx, b.to!, b.amount!);
        break;
      case "transfer":
        receipt = isNft ? await deps.engine.transferToken(actor, ctx, b.from!, b.to!, b.tokenId!) : await deps.engine.transfer(actor, ctx, b.from!, b.to!, b.amount!);
        break;
      case "burn":
        receipt = isNft ? await deps.engine.burnToken(actor, ctx, b.tokenId!) : await deps.engine.burn(actor, ctx, b.from!, b.amount!);
        break;
      case "freeze":
        receipt = await deps.engine.setFrozen(actor, ctx, b.account!, true);
        break;
      case "unfreeze":
        receipt = await deps.engine.setFrozen(actor, ctx, b.account!, false);
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
  app.post("/assets/:id/buy", { schema: S.buy, ...auth }, async (request, reply) => {
    const asset = await deps.assets.get((request.params as { id: string }).id);
    if (!asset) return notFound(reply, "asset not found");
    if (!scopedToCaller(request.user as TokenClaims, asset.useCaseKey)) return notFound(reply, "asset not found");
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

  app.post("/assets/:id/listings", { schema: S.createListing, ...auth }, async (request, reply) => {
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

  app.get("/assets/:id/listings", { schema: S.listListings, ...auth }, async (request, reply) => {
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

  app.post("/listings/:id/take", { schema: S.takeListing, ...auth }, async (request, reply) => {
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

  app.delete("/listings/:id", { schema: S.cancelListing, ...auth }, async (request, reply) => {
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

  app.get("/assets/:id/trades", { schema: S.assetTrades, ...auth }, async (request, reply) => {
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
  app.post("/cash/credit", { schema: S.creditCash, ...auth }, async (request, reply) => {
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

  app.get("/cash/balances", { schema: S.cashBalances, ...auth }, async (request, reply) => {
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
  app.get("/users", { schema: S.listUsers, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (!canManageUsers(claims.role)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to manage users" });
    const rows = await deps.users.list(claims.role === "PlatformAdmin" ? undefined : claims.useCaseKey ?? NO_USE_CASE);
    return rows.map((u) => ({ id: u.id, email: u.email, role: u.role, useCaseKey: u.useCaseKey, accountId: u.accountId, active: u.active, kycStatus: u.kycStatus, kyc: u.kyc }));
  });

  app.post("/users", { schema: S.createUser, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; kyc?: KycDetails };
    const targetUseCaseKey = claims.role === "PlatformAdmin" ? (b.useCaseKey ?? null) : claims.useCaseKey;
    if (!canCreateUser({ role: claims.role, useCaseKey: claims.useCaseKey }, b.role, targetUseCaseKey)) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to create that user" });
    }
    if (await deps.users.findByEmail(b.email)) return reply.code(400).send({ error: "EMAIL_TAKEN", message: "email already registered" });
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
    });
    return reply.code(201).send({ id: created.id, email: created.email, role: created.role, useCaseKey: created.useCaseKey, accountId: created.accountId, kycStatus: created.kycStatus });
  });

  app.delete("/users/:id", { schema: S.deleteUser, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const target = await deps.users.findById(id);
    if (!target) return notFound(reply, "user not found");
    const sameScope = claims.role === "PlatformAdmin" || (canManageUsers(claims.role) && target.useCaseKey === claims.useCaseKey && target.role !== "UseCaseAdmin");
    if (!sameScope) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to remove that user" });
    await deps.users.remove(id);
    return reply.code(204).send();
  });

  app.patch("/users/:id", { schema: S.updateUser, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const b = request.body as { password?: string; active?: boolean; kycStatus?: "approved" | "rejected" };
    const target = await deps.users.findById(id);
    if (!target) return notFound(reply, "user not found");
    const sameScope = claims.role === "PlatformAdmin" || (canManageUsers(claims.role) && target.useCaseKey === claims.useCaseKey && target.role !== "UseCaseAdmin");
    if (!sameScope) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to edit that user" });
    const patch: { passwordHash?: string; active?: boolean; kycStatus?: KycStatus } = {};
    if (typeof b.password === "string") patch.passwordHash = bcrypt.hashSync(b.password, BCRYPT_ROUNDS);
    if (typeof b.active === "boolean") patch.active = b.active;
    if (b.kycStatus === "approved" || b.kycStatus === "rejected") patch.kycStatus = b.kycStatus;
    const updated = await deps.users.update(id, patch);
    return { id: updated.id, email: updated.email, role: updated.role, useCaseKey: updated.useCaseKey, accountId: updated.accountId, active: updated.active, kycStatus: updated.kycStatus };
  });

  // --- documents ----------------------------------------------------------
  // A small document store so the dashboard can upload a file (e.g. an invoice
  // PDF) and reference it from asset metadata by URL + sha256.
  const MAX_DOC_BYTES = 5 * 1024 * 1024;
  app.post("/documents", { schema: S.uploadDocument, ...auth }, async (request, reply) => {
    const actor = actorOf(request);
    if (!deps.rbac.can(actor.role, "issue")) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to upload documents" });
    const { contentType, dataBase64 } = request.body as { contentType: string; dataBase64: string };
    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.length === 0) return reply.code(400).send({ error: "BAD_DOCUMENT", message: "empty document" });
    if (bytes.length > MAX_DOC_BYTES) return reply.code(413).send({ error: "DOCUMENT_TOO_LARGE", message: `max ${MAX_DOC_BYTES} bytes` });
    const doc = await deps.documents.create({ contentType, bytes });
    return reply.code(201).send({ id: doc.id, url: `/api/v1/documents/${doc.id}`, sha256: doc.sha256, size: doc.size });
  });
  app.get("/documents/:id", { schema: S.getDocument, ...auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const doc = await deps.documents.get(id);
    if (!doc) return notFound(reply, "document not found");
    return reply.header("content-type", doc.contentType).send(doc.bytes);
  });
}
