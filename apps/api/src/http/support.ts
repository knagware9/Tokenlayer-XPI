import type { FastifyReply, FastifyRequest } from "fastify";
import { PolicyError, type Actor, type AssetContext, type Role } from "@tokenlayer/core";
import { prefixOf, secretMatches } from "../api-keys.js";
import type { ApiKeyRepository, AssetRecord, UserRepository } from "../persistence/types.js";

export interface TokenClaims {
  id: string;
  email: string;
  role: Role;
  useCaseKey: string | null;
  orgId?: string | null;
  did?: string | null;
}

/**
 * The key a request was authenticated by, when it was a key at all. ABSENT for
 * human (JWT) sessions — scopes are a property of keys, not of people, so a
 * scope check on a JWT request has nothing to narrow and passes.
 */
export interface ApiKeyPrincipal {
  id: string;
  scopes: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: ApiKeyPrincipal;
  }
}

export function actorOf(request: FastifyRequest): Actor {
  const user = request.user as TokenClaims;
  return { id: user.id, role: user.role };
}

export function contextOf(asset: AssetRecord): AssetContext {
  return { ref: { id: asset.id, chainId: asset.chainId, contractRef: asset.contractRef }, useCaseKey: asset.useCaseKey };
}

/**
 * `lastUsedAt` is written at most this often per key: a busy integration must
 * not turn every call into a database write.
 */
const LAST_USED_THROTTLE_MS = 60_000;

/** The raw credential from `Authorization: Bearer …`, or null when absent/malformed. */
function bearerOf(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || rest.length === 0) return null;
  const raw = rest.join(" ").trim();
  return raw.length > 0 ? raw : null;
}

/**
 * The ONE message every failed authentication returns, whatever went wrong.
 * Distinguishing "unknown key" from "revoked" from "expired" from "wrong
 * secret" from "deactivated service user" would hand an attacker an oracle.
 */
async function rejectUnauthenticated(reply: FastifyReply): Promise<void> {
  await reply.code(401).send({ error: "UNAUTHORIZED", message: "missing or invalid bearer token" });
}

/**
 * Fails CLOSED: an `expiresAt` we cannot parse counts as expired rather than as
 * "no expiry", so corrupt data can never keep a credential alive.
 */
function isExpired(expiresAt: string | null): boolean {
  if (expiresAt === null) return false;
  return !(Date.parse(expiresAt) > Date.now());
}

/**
 * Auth preHandler factory. Two ways to arrive at ONE principal:
 *
 *   Authorization: Bearer <jwt>       → verify the signature
 *   Authorization: Bearer tl_live_…   → verify the API key (EN-B)
 *
 * Both branches then re-read the principal from the database and rewrite
 * `request.user` into the SAME `TokenClaims` shape. That is the whole design:
 * every route, RBAC check, maker-checker gate and EN-A envelope gate reads that
 * one shape and nothing else, so keys are governed by the existing gates with
 * no per-route work and no chance of missing one.
 *
 * Re-reading every request also revokes sessions for suspended or deleted users
 * (a valid signature — or a live key — is no longer sufficient) and refreshes
 * role/use-case from the source of truth, so a demoted or re-scoped principal
 * takes effect immediately rather than persisting in a stale token.
 */
export function requirePrincipal(deps: { users: UserRepository; apiKeys: ApiKeyRepository }) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const raw = bearerOf(request.headers.authorization);
    const prefix = raw === null ? null : prefixOf(raw);

    // --- JWT path: unchanged from before EN-B ------------------------------
    // (`raw === null` is implied by `prefix === null`; naming it narrows the type.)
    if (raw === null || prefix === null) {
      request.apiKey = undefined;
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
      request.user = { id: user.id, email: user.email, role: user.role, useCaseKey: user.useCaseKey, orgId: user.orgId ?? null, did: user.did ?? null } satisfies TokenClaims;
      return;
    }

    // --- API-key path ------------------------------------------------------
    const key = await deps.apiKeys.findByPrefix(prefix);
    if (!key || key.revokedAt !== null || isExpired(key.expiresAt)) {
      await rejectUnauthenticated(reply);
      return;
    }
    if (!(await secretMatches(raw, key.secretHash))) {
      await rejectUnauthenticated(reply);
      return;
    }
    const user = await deps.users.findById(key.userId);
    if (!user || !user.active) {
      await rejectUnauthenticated(reply);
      return;
    }
    request.user = { id: user.id, email: user.email, role: user.role, useCaseKey: user.useCaseKey, orgId: user.orgId ?? null, did: user.did ?? null } satisfies TokenClaims;
    // Copy the scopes: the memory repo hands back its live array, and a route
    // must never be able to mutate what the store believes was granted.
    request.apiKey = { id: key.id, scopes: [...key.scopes] };

    // Compare-then-write, and only after the credential verified — a rejected
    // request must leave no trace that could be mistaken for legitimate use.
    const now = Date.now();
    if (key.lastUsedAt === null || now - Date.parse(key.lastUsedAt) >= LAST_USED_THROTTLE_MS) {
      await deps.apiKeys.touchLastUsed(key.id, new Date(now).toISOString());
    }
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
