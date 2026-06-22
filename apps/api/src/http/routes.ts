import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { canCreateUser, canManageUsers, type Role, type UseCaseDefinition } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import { S } from "./schemas.js";
import { actorOf, authenticate, contextOf, notFound, scopedToCaller, type TokenClaims } from "./support.js";

/** Registers every /api/v1 route on the given (prefixed) instance. */
export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const auth = { preHandler: authenticate };

  // Loads an asset and enforces use-case scope. Returns null after sending the
  // right error (404 for reads to hide existence; 403 for actions).
  async function scopedAsset(request: any, reply: any, mode: "read" | "act") {
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

  // --- auth ---------------------------------------------------------------
  app.post("/auth/login", { schema: S.login }, async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };
    const user = await deps.users.findByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "invalid credentials" });
    }
    const claims: TokenClaims = { id: user.id, email: user.email, role: user.role, useCaseKey: user.useCaseKey };
    const wallet = user.accountId ? await deps.accounts.findById(user.accountId) : null;
    return { token: app.jwt.sign(claims), user: { ...claims, walletAddress: wallet?.address ?? null } };
  });

  app.get("/me", { schema: S.me, ...auth }, async (request) => actorOf(request));

  // --- catalog ------------------------------------------------------------
  app.get("/chains", { schema: S.chains, ...auth }, async () => deps.chains.list());
  app.get("/accounts", { schema: S.accounts, ...auth }, async () => deps.accounts.list());

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
    return reply.code(201).send(await deps.useCases.create(request.body as UseCaseDefinition));
  });
  app.put("/use-cases/:key", { schema: S.updateUseCase, ...auth }, async (request, reply) => {
    if ((request.user as TokenClaims).role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may edit use cases" });
    const { key } = request.params as { key: string };
    return deps.useCases.update(key, request.body as UseCaseDefinition);
  });

  // --- assets -------------------------------------------------------------
  app.post("/assets", { schema: S.issueAsset, ...auth }, async (request, reply) => {
    const body = request.body as { useCaseKey: string; name: string; symbol: string; chainId: string; metadata?: Record<string, unknown> };
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin" && body.useCaseKey !== claims.useCaseKey) {
      return reply.code(403).send({ error: "WRONG_USE_CASE", message: "cannot issue into another use case" });
    }
    const actor = actorOf(request);
    const id = randomUUID();
    const result = await deps.engine.issue(actor, { ...body, id, metadata: body.metadata ?? {} });
    const useCase = await deps.useCases.get(body.useCaseKey);
    const asset = await deps.assets.create({
      id,
      useCaseKey: body.useCaseKey,
      name: body.name,
      symbol: body.symbol,
      chainId: body.chainId,
      contractRef: result.ref.contractRef,
      tokenType: result.tokenType,
      tokenStandard: useCase.tokenStandard,
      metadata: body.metadata ?? {},
      status: "active",
      createdBy: actor.id,
    });
    return reply.code(201).send({ asset, txHash: result.txHash });
  });

  app.get("/assets", { schema: S.listAssets, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    const q = request.query as { useCaseKey?: string; chainId?: string; status?: string; limit: number; offset: number };
    const useCaseKey = claims.role === "PlatformAdmin" ? q.useCaseKey : claims.useCaseKey ?? "__none__";
    const { items, total } = await deps.assets.list({ useCaseKey, chainId: q.chainId, status: q.status }, { limit: q.limit, offset: q.offset });
    return { data: items, pagination: { limit: q.limit, offset: q.offset, total } };
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
    const adapter = deps.chains.resolveAdapter(asset.chainId);
    const ref = contextOf(asset).ref;
    const accounts = await deps.accounts.list();
    return Promise.all(
      accounts.map(async (acct) => ({
        address: acct.address,
        label: acct.label,
        balance: await adapter.balanceOf(ref, acct.address).catch(() => "0"),
        frozen: await adapter.isFrozen(ref, acct.address).catch(() => false),
        allowed: await adapter.isAllowed(ref, acct.address).catch(() => false),
      })),
    );
  });

  app.get("/assets/:id/tokens", { schema: S.assetTokens, ...auth }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    if (asset.tokenType !== "nonfungible") return [];
    const adapter = deps.chains.resolveAdapter(asset.chainId);
    const ref = contextOf(asset).ref;
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
      case "allow":
        receipt = await deps.engine.setAllowed(actor, ctx, b.account!, true);
        break;
      case "disallow":
        receipt = await deps.engine.setAllowed(actor, ctx, b.account!, false);
        break;
      default:
        return reply.code(400).send({ error: "VALIDATION_ERROR", message: `unknown action '${action}'` });
    }
    return { receipt };
  });

  // --- users (scoped provisioning) ----------------------------------------
  app.get("/users", { schema: S.listUsers, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (!canManageUsers(claims.role)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to manage users" });
    const rows = await deps.users.list(claims.role === "PlatformAdmin" ? undefined : claims.useCaseKey ?? "__none__");
    return rows.map((u) => ({ id: u.id, email: u.email, role: u.role, useCaseKey: u.useCaseKey, accountId: u.accountId }));
  });

  app.post("/users", { schema: S.createUser, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string };
    const targetUseCaseKey = claims.role === "PlatformAdmin" ? (b.useCaseKey ?? null) : claims.useCaseKey;
    if (!canCreateUser({ role: claims.role, useCaseKey: claims.useCaseKey }, b.role, targetUseCaseKey)) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to create that user" });
    }
    if (await deps.users.findByEmail(b.email)) return reply.code(400).send({ error: "EMAIL_TAKEN", message: "email already registered" });
    let accountId: string | null = null;
    if (b.walletAddress) accountId = (await deps.accounts.upsert(b.walletAddress, b.email)).id;
    const created = await deps.users.create({
      email: b.email,
      passwordHash: bcrypt.hashSync(b.password, 10),
      role: b.role,
      useCaseKey: targetUseCaseKey,
      accountId,
    });
    return reply.code(201).send({ id: created.id, email: created.email, role: created.role, useCaseKey: created.useCaseKey, accountId: created.accountId });
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
}
