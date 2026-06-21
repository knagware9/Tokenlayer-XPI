import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { UseCaseDefinition } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import { S } from "./schemas.js";
import { actorOf, authenticate, contextOf, notFound, type TokenClaims } from "./support.js";

/** Registers every /api/v1 route on the given (prefixed) instance. */
export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const auth = { preHandler: authenticate };

  // --- auth ---------------------------------------------------------------
  app.post("/auth/login", { schema: S.login }, async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };
    const user = await deps.users.findByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "invalid credentials" });
    }
    const claims: TokenClaims = { id: user.id, email: user.email, role: user.role };
    return { token: app.jwt.sign(claims), user: claims };
  });

  app.get("/me", { schema: S.me, ...auth }, async (request) => actorOf(request));

  // --- catalog ------------------------------------------------------------
  app.get("/chains", { schema: S.chains, ...auth }, async () => deps.chains.list());
  app.get("/accounts", { schema: S.accounts, ...auth }, async () => deps.accounts.list());

  app.get("/use-cases", { schema: S.listUseCases, ...auth }, async () => deps.useCases.list());
  app.get("/use-cases/:key", { schema: S.getUseCase, ...auth }, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!(await deps.useCases.has(key))) return notFound(reply, `unknown use case '${key}'`);
    return deps.useCases.get(key);
  });
  app.post("/use-cases", { schema: S.createUseCase, ...auth }, async (request, reply) => {
    if (actorOf(request).role !== "Admin") return reply.code(403).send({ error: "FORBIDDEN", message: "only Admin may create use cases" });
    return reply.code(201).send(await deps.useCases.create(request.body as UseCaseDefinition));
  });
  app.put("/use-cases/:key", { schema: S.updateUseCase, ...auth }, async (request, reply) => {
    if (actorOf(request).role !== "Admin") return reply.code(403).send({ error: "FORBIDDEN", message: "only Admin may edit use cases" });
    const { key } = request.params as { key: string };
    return deps.useCases.update(key, request.body as UseCaseDefinition);
  });

  // --- assets -------------------------------------------------------------
  app.post("/assets", { schema: S.issueAsset, ...auth }, async (request, reply) => {
    const body = request.body as { useCaseKey: string; name: string; symbol: string; chainId: string; metadata?: Record<string, unknown> };
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
    const q = request.query as { useCaseKey?: string; chainId?: string; status?: string; limit: number; offset: number };
    const { items, total } = await deps.assets.list(
      { useCaseKey: q.useCaseKey, chainId: q.chainId, status: q.status },
      { limit: q.limit, offset: q.offset },
    );
    return { data: items, pagination: { limit: q.limit, offset: q.offset, total } };
  });

  app.get("/assets/:id", { schema: S.getAsset, ...auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = await deps.assets.get(id);
    if (!asset) return notFound(reply, "asset not found");
    const totalSupply = await deps.engine.totalSupply(actorOf(request), contextOf(asset)).catch(() => null);
    return { ...asset, totalSupply };
  });

  app.get("/assets/:id/accounts", { schema: S.assetAccounts, ...auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = await deps.assets.get(id);
    if (!asset) return notFound(reply, "asset not found");
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
    const { id } = request.params as { id: string };
    const asset = await deps.assets.get(id);
    if (!asset) return notFound(reply, "asset not found");
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
    const { id } = request.params as { id: string };
    const asset = await deps.assets.get(id);
    if (!asset) return notFound(reply, "asset not found");
    const q = request.query as { limit: number; offset: number };
    const { items, total } = await deps.audit.listByAsset(id, { limit: q.limit, offset: q.offset });
    return { data: items, pagination: { limit: q.limit, offset: q.offset, total } };
  });

  // --- lifecycle actions --------------------------------------------------
  app.post("/assets/:id/actions/:action", { schema: S.action, ...auth }, async (request, reply) => {
    const { id, action } = request.params as { id: string; action: string };
    const asset = await deps.assets.get(id);
    if (!asset) return notFound(reply, "asset not found");
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
}
