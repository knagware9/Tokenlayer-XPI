import type { FastifyReply, FastifyRequest } from "fastify";
import { PolicyError, type Actor, type AssetContext, type Role } from "@tokenlayer/core";
import type { AssetRecord } from "../persistence/types.js";

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

/** JWT preHandler that emits the standard error envelope on failure. */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ error: "UNAUTHORIZED", message: "missing or invalid bearer token" });
  }
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
  // Adapter/ledger reverts and unexpected errors surface as 400 with the message.
  return reply.code(400).send({ error: "REQUEST_FAILED", message: err?.message ?? "request failed" });
}

/** True if the caller may see/act on a resource governed by `useCaseKey`. */
export function scopedToCaller(claims: TokenClaims, useCaseKey: string): boolean {
  return claims.role === "PlatformAdmin" || claims.useCaseKey === useCaseKey;
}
