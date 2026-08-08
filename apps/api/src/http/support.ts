import type { FastifyReply, FastifyRequest } from "fastify";
import { PolicyError, scopeAllows, type Actor, type ApiScope, type AssetContext, type Role } from "@tokenlayer/core";
import { cachedVerification, prefixOf, rememberVerification, secretMatches } from "../api-keys.js";
import type { ApiKeyRepository, AssetRecord, UserRecord, UserRepository } from "../persistence/types.js";

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

/**
 * The ONE place a session principal is built from a user row. Every gate in the
 * app — RBAC, maker-checker, the nine EN-A envelope checks — reads this shape
 * and nothing else, so a field that goes missing at one construction site is a
 * silent authorization difference between the paths. `satisfies TokenClaims`
 * does NOT catch that: the optional members make a partial object still assign.
 * Hence one function, used by both auth branches and every JWT-minting route.
 */
export function claimsOf(user: Pick<UserRecord, "id" | "email" | "role" | "useCaseKey" | "orgId" | "did">): TokenClaims {
  return { id: user.id, email: user.email, role: user.role, useCaseKey: user.useCaseKey, orgId: user.orgId ?? null, did: user.did ?? null };
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

/** Per-key request budget window, and the window failed verifications age out of. */
const RATE_WINDOW_MS = 60_000;
const FAILED_WINDOW_MS = 60_000;
/** Defaults; all three are overridable through AppDeps (tests dial them down). */
const DEFAULT_RATE_MAX = 600;
const DEFAULT_FAILED_MAX = 20;
/**
 * Even over its failure budget, a prefix gets ONE bcrypt attempt per this
 * interval. Without it the bound is a denial-of-service in its own right: an
 * attacker who knows the (public) prefix spends the budget every window and a
 * legitimate key that has gone cold can never re-verify. One attempt per 5s
 * costs an attacker-facing ~10ms/s of CPU per prefix (~1% of a core at
 * API_KEY_BCRYPT_ROUNDS) while capping a live integration's outage at one
 * retry interval.
 */
const DEFAULT_RESERVE_INTERVAL_MS = 5_000;

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
export function requirePrincipal(deps: {
  users: UserRepository;
  apiKeys: ApiKeyRepository;
  /** Per-key requests per minute (default 600). */
  apiKeyRateLimitMax?: number;
  /** Failed verifications per prefix per minute before the prefix is refused unhashed (default 20). */
  apiKeyFailedAttemptMax?: number;
  /** Minimum gap between bcrypt attempts for an over-budget prefix (default 5000ms). */
  apiKeyReserveIntervalMs?: number;
}) {
  const rateMax = deps.apiKeyRateLimitMax ?? DEFAULT_RATE_MAX;
  const failedMax = deps.apiKeyFailedAttemptMax ?? DEFAULT_FAILED_MAX;
  const reserveMs = deps.apiKeyReserveIntervalMs ?? DEFAULT_RESERVE_INTERVAL_MS;
  // Per-INSTANCE, in-process counters. Like `loginThrottled` they bound ONE
  // process, not a cluster — but unlike it they are bounded in SIZE too: an
  // entry is only ever allocated for a prefix that resolved to a live key row
  // (unknown, revoked and expired prefixes are rejected further up, before any
  // `bump`), so the key space here is the number of live keys. `loginThrottled`
  // keys on client IP, which an attacker chooses, and grows without bound.
  const rateHits = new Map<string, { count: number; resetAt: number }>();
  const failedHits = new Map<string, { count: number; resetAt: number }>();
  /** Last time we spent a bcrypt on this prefix — the reserve's clock. */
  const lastHashAt = new Map<string, number>();

  /**
   * Fixed-window counter shared by both budgets. Returns the running count.
   *
   * The two budgets read it with deliberately different shapes: the RATE limit
   * bumps first and trips on `count > max` (the request itself is one of the
   * allowance), while the FAILURE bound checks `count >= max` BEFORE deciding
   * whether to spend a bcrypt (the work is what we are rationing, so it must be
   * refused before it happens, not counted after).
   */
  function bump(store: Map<string, { count: number; resetAt: number }>, k: string, windowMs: number): { count: number; resetAt: number } {
    const now = Date.now();
    const e = store.get(k);
    if (!e || now > e.resetAt) {
      const fresh = { count: 1, resetAt: now + windowMs };
      store.set(k, fresh);
      return fresh;
    }
    e.count += 1;
    return e;
  }

  /** True when `k` has already spent `max` in the current (unexpired) window. */
  function overBudget(store: Map<string, { count: number; resetAt: number }>, k: string, max: number): boolean {
    if (max <= 0) return false;
    const e = store.get(k);
    return !!e && e.resetAt > Date.now() && e.count >= max;
  }

  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const raw = bearerOf(request.headers.authorization);
    const prefix = raw === null ? null : prefixOf(raw);

    // --- JWT path: unchanged from before EN-B ------------------------------
    // `prefix === null` already covers `raw === null`; the first disjunct is
    // redundant at runtime and kept only so TS narrows `raw` to string below.
    if (raw === null || prefix === null) {
      request.apiKey = undefined;
      try {
        await request.jwtVerify();
      } catch {
        await rejectUnauthenticated(reply);
        return;
      }
      const claims = request.user as TokenClaims;
      const user = await deps.users.findById(claims.id);
      if (!user || !user.active) {
        await reply.code(401).send({ error: "UNAUTHORIZED", message: "session is no longer valid" });
        return;
      }
      request.user = claimsOf(user);
      return;
    }

    // --- API-key path ------------------------------------------------------
    const key = await deps.apiKeys.findByPrefix(prefix);
    if (!key || key.revokedAt !== null || isExpired(key.expiresAt)) {
      await rejectUnauthenticated(reply);
      return;
    }
    // THE COST PROBLEM, AND ITS THREE ANSWERS.
    // A prefix is public by design (it is displayed in the UI), so anyone can
    // send `tl_live_<known-prefix>` + garbage and try to force a full bcrypt
    // compare per request. bcryptjs is pure JS and CPU-bound, so concurrency
    // does not help and the event loop is what suffers.
    //   1. API_KEY_BCRYPT_ROUNDS (10, not 12) — see api-keys.ts: the secret's
    //      ~131 bits, not the work factor, is what defeats an offline attack.
    //   2. The verified-prefix cache, consulted FIRST so a hot legitimate key
    //      never pays bcrypt and — deliberately — is never locked out by (3).
    //   3. A bound on FAILED verifications per prefix, below.
    // Order matters: cache hit → serve; else failure budget → refuse unhashed;
    // else hash. The reverse order would let an attacker knock a live key off
    // the air by burning its budget.
    const cached = cachedVerification(prefix, raw, key);
    if (!cached) {
      // THE BOUND, AND ITS OWN ESCAPE HATCH. Over budget, a prefix is refused
      // without hashing — including with the RIGHT secret, since we cannot tell
      // which is which without paying the bcrypt we are trying to avoid. That
      // alone would be a denial of service: prefixes are public, so an attacker
      // spending 20 failures a minute would keep a cold key off the air forever.
      // Hence the RESERVE — one attempt per `reserveMs` even when over budget,
      // so a legitimate key always recovers on retry while the attacker's
      // achievable CPU cost stays at one hash per interval per prefix.
      const since = Date.now() - (lastHashAt.get(prefix) ?? 0);
      if (overBudget(failedHits, prefix, failedMax) && since < reserveMs) {
        await rejectUnauthenticated(reply);
        return;
      }
      lastHashAt.set(prefix, Date.now());
      if (!(await secretMatches(raw, key.secretHash))) {
        bump(failedHits, prefix, FAILED_WINDOW_MS);
        await rejectUnauthenticated(reply);
        return;
      }
      rememberVerification(prefix, raw, key);
      // A real verification clears the prefix's failure history AND its reserve
      // clock, so an attack that resumes after a good request starts from zero.
      failedHits.delete(prefix);
      lastHashAt.delete(prefix);
    }
    const user = await deps.users.findById(key.userId);
    if (!user || !user.active) {
      await rejectUnauthenticated(reply);
      return;
    }
    // Per-key budget, counted only for CREDENTIALS THAT VERIFIED — an attacker
    // holding a prefix but not the secret must not be able to spend the real
    // integration's allowance. Per instance, like the login throttle.
    const budget = bump(rateHits, key.id, RATE_WINDOW_MS);
    if (rateMax > 0 && budget.count > rateMax) {
      await reply
        .code(429)
        .header("Retry-After", String(Math.max(1, Math.ceil((budget.resetAt - Date.now()) / 1000))))
        .send({ error: "RATE_LIMITED", message: "this API key has exceeded its request rate limit" });
      return;
    }
    request.user = claimsOf(user);
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

/**
 * Composed onto a route AFTER `requirePrincipal`, narrowing what a key may do.
 *
 * A JWT request carries no key, so it passes unconditionally: scopes are a
 * property of keys, not of people, and there is nothing to narrow. This is also
 * why `requireScope` can never WIDEN anything — it only ever subtracts from what
 * the bound service user's role and the org's EN-A envelope already allow, both
 * of which still run inside the route.
 */
export function requireScope(required: ApiScope) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const key = request.apiKey;
    if (!key) return;
    if (!scopeAllows(key.scopes, required)) {
      await reply.code(403).send({
        error: "INSUFFICIENT_SCOPE",
        message: `this API key lacks the '${required}' scope`,
        details: { required, granted: key.scopes },
      });
    }
  };
}

/**
 * Refuse a machine principal outright. Used where an API key could mint a
 * DURABLE human credential that outlives the key's own revocation — a device
 * login key, another API key, or a password on an existing account.
 * Gates on `request.apiKey` (the in-request machine signal), never on the bound
 * user's `kind`: TokenClaims deliberately carries no `kind`, and this is
 * strictly broader anyway, covering a key bound to a human user too.
 */
export function machinePrincipal(request: FastifyRequest): boolean {
  return request.apiKey !== undefined;
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
