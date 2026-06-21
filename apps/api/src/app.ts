import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { PolicyError, type Actor, type AssetContext, type Role, type UseCaseDefinition } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import type { AssetRecord } from "./persistence/types.js";

interface TokenClaims {
  id: string;
  email: string;
  role: Role;
}

function actorOf(request: FastifyRequest): Actor {
  const user = request.user as TokenClaims;
  return { id: user.id, role: user.role };
}

function contextOf(asset: AssetRecord): AssetContext {
  return { ref: { id: asset.id, chainId: asset.chainId, contractRef: asset.contractRef }, useCaseKey: asset.useCaseKey };
}

/**
 * Builds the HTTP surface over the platform's domain services. All dependencies
 * are injected so the same app can run over Prisma (production) or in-memory
 * repositories (tests/demo).
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: deps.jwtSecret });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof PolicyError) {
      const status = err.code === "FORBIDDEN" ? 403 : 400;
      return reply.code(status).send({ error: err.code, message: err.message, details: err.details });
    }
    // Adapter/ledger reverts and config errors surface as 400 with the message.
    return reply.code(400).send({ error: "REQUEST_FAILED", message: err.message });
  });

  // --- auth ---------------------------------------------------------------
  app.post("/auth/login", async (request, reply) => {
    const { email, password } = (request.body ?? {}) as { email?: string; password?: string };
    if (!email || !password) return reply.code(400).send({ error: "email and password required" });
    const user = await deps.users.findByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid credentials" });
    }
    const claims: TokenClaims = { id: user.id, email: user.email, role: user.role };
    return { token: app.jwt.sign(claims), user: claims };
  });

  app.get("/me", { preHandler: authenticate }, async (request) => actorOf(request));

  // --- catalog ------------------------------------------------------------
  app.get("/chains", { preHandler: authenticate }, async () => deps.chains.list());

  app.get("/use-cases", { preHandler: authenticate }, async () => deps.useCases.list());

  app.get("/use-cases/:key", { preHandler: authenticate }, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!(await deps.useCases.has(key))) return reply.code(404).send({ error: "unknown use case" });
    return deps.useCases.get(key);
  });

  // Low-code builder: create / edit use cases (Admin only).
  app.post("/use-cases", { preHandler: authenticate }, async (request, reply) => {
    if (actorOf(request).role !== "Admin") {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only Admin may create use cases" });
    }
    const created = await deps.useCases.create(request.body as UseCaseDefinition);
    return reply.code(201).send(created);
  });

  app.put("/use-cases/:key", { preHandler: authenticate }, async (request, reply) => {
    if (actorOf(request).role !== "Admin") {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only Admin may edit use cases" });
    }
    const { key } = request.params as { key: string };
    return deps.useCases.update(key, request.body as UseCaseDefinition);
  });

  app.get("/accounts", { preHandler: authenticate }, async () => deps.accounts.list());

  // --- assets -------------------------------------------------------------
  app.post("/assets", { preHandler: authenticate }, async (request, reply) => {
    const body = (request.body ?? {}) as {
      useCaseKey?: string;
      name?: string;
      symbol?: string;
      chainId?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.useCaseKey || !body.name || !body.symbol || !body.chainId) {
      return reply.code(400).send({ error: "useCaseKey, name, symbol and chainId are required" });
    }
    const id = randomUUID();
    const result = await deps.engine.issue(actorOf(request), {
      useCaseKey: body.useCaseKey,
      id,
      name: body.name,
      symbol: body.symbol,
      chainId: body.chainId,
      metadata: body.metadata ?? {},
    });
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
      createdBy: actorOf(request).id,
    });
    return reply.code(201).send({ asset, txHash: result.txHash });
  });

  app.get("/assets", { preHandler: authenticate }, async () => deps.assets.list());

  app.get("/assets/:id", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = await deps.assets.get(id);
    if (!asset) return reply.code(404).send({ error: "asset not found" });
    const actor = actorOf(request);
    const totalSupply = await deps.engine.totalSupply(actor, contextOf(asset)).catch(() => null);
    return { ...asset, totalSupply };
  });

  app.get("/assets/:id/accounts", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = await deps.assets.get(id);
    if (!asset) return reply.code(404).send({ error: "asset not found" });
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

  app.get("/assets/:id/tokens", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = await deps.assets.get(id);
    if (!asset) return reply.code(404).send({ error: "asset not found" });
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

  app.get("/assets/:id/audit", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = await deps.assets.get(id);
    if (!asset) return reply.code(404).send({ error: "asset not found" });
    return deps.audit.listByAsset(id);
  });

  // --- lifecycle actions --------------------------------------------------
  app.post("/assets/:id/actions/:action", { preHandler: authenticate }, async (request, reply) => {
    const { id, action } = request.params as { id: string; action: string };
    const asset = await deps.assets.get(id);
    if (!asset) return reply.code(404).send({ error: "asset not found" });
    const actor = actorOf(request);
    const ctx = contextOf(asset);
    const b = (request.body ?? {}) as Record<string, string>;
    const isNft = asset.tokenType === "nonfungible";

    let receipt;
    switch (action) {
      case "mint":
        receipt = isNft
          ? await deps.engine.mintToken(actor, ctx, b.to!, b.tokenId!, b.uri)
          : await deps.engine.mint(actor, ctx, b.to!, b.amount!);
        break;
      case "transfer":
        receipt = isNft
          ? await deps.engine.transferToken(actor, ctx, b.from!, b.to!, b.tokenId!)
          : await deps.engine.transfer(actor, ctx, b.from!, b.to!, b.amount!);
        break;
      case "burn":
        receipt = isNft
          ? await deps.engine.burnToken(actor, ctx, b.tokenId!)
          : await deps.engine.burn(actor, ctx, b.from!, b.amount!);
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
        return reply.code(400).send({ error: `unknown action '${action}'` });
    }
    return { receipt };
  });

  return app;
}
