import type { FastifyReply, FastifyRequest } from "fastify";
import { PolicyError, type Actor, type AssetContext, type Role } from "@tokenlayer/core";
import type { AssetRecord, UserRepository } from "../persistence/types.js";

export interface TokenClaims {
  id: string;
  email: string;
  role: Role;
  useCaseKey: string | null;
}

export function actorOf(request: FastifyRequest): Actor {
  const user = request.user as TokenClaims;
  return { id: user.id, role: user.role };
}

export function contextOf(asset: AssetRecord): AssetContext {
  return { ref: { id: asset.id, chainId: asset.chainId, contractRef: asset.contractRef }, useCaseKey: asset.useCaseKey };
}

/**
 * Auth preHandler factory: verifies the JWT, then re-validates the principal
 * against the database every request. This revokes sessions for suspended or
 * deleted users (a valid signature is no longer sufficient) and refreshes
 * role/use-case from the source of truth, so a demoted or re-scoped user takes
 * effect immediately rather than persisting in a stale token.
 */
export function requireUser(deps: { users: UserRepository }) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "UNAUTHORIZED", message: "missing or invalid bearer token" });
      return;
    }
    const claims = request.user as TokenClaims;
    const user = await deps.users.findById(claims.id);
    if (!user || !user.active) {
      await reply.code(401).send({ error: "UNAUTHORIZED", message: "session is no longer valid" });
      return;
    }
    request.user = { id: user.id, email: user.email, role: user.role, useCaseKey: user.useCaseKey } satisfies TokenClaims;
  };
}

/** Convenience 404 in the standard envelope. */
export function notFound(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(404).send({ error: "NOT_FOUND", message });
}

/** HTTP status for a domain PolicyError code. */
function statusForPolicy(code: string): number {
  if (code === "FORBIDDEN") return 403;
  if (code === "UNKNOWN_USECASE") return 404;
  return 400;
}

/** Maps every error onto the uniform { error, message, details? } envelope. */
export function errorHandler(err: any, _req: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (err instanceof PolicyError) {
    return reply.code(statusForPolicy(err.code)).send({ error: err.code, message: err.message, details: err.details });
  }
  if (err?.validation) {
    return reply.code(400).send({ error: "VALIDATION_ERROR", message: err.message, details: { issues: err.validation } });
  }
  if (typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: err.code ?? "REQUEST_FAILED", message: err.message });
  }
  // Adapter/ledger reverts and unexpected errors: log internally, return a generic
  // message so raw RPC/contract/library internals are not disclosed to clients.
  console.error("[request-failed]", err);
  return reply.code(400).send({ error: "REQUEST_FAILED", message: "the request could not be completed" });
}

/** True if the caller may see/act on a resource governed by `useCaseKey`. */
export function scopedToCaller(claims: TokenClaims, useCaseKey: string): boolean {
  return claims.role === "PlatformAdmin" || claims.useCaseKey === useCaseKey;
}

/** True when `s` is a positive integer string (no sign, no decimals, > 0). */
export function isPositiveIntString(s: string): boolean {
  return /^\d+$/.test(s) && BigInt(s) > 0n;
}
