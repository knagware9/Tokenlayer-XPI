# Machine API Access — Org-Scoped API Keys (EN-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any external application authenticates with `Authorization: Bearer tl_live_…` and drives the REST API as an org-owned service principal — coarse-scoped, rate-limited, rotatable, revocable — with every existing gate (RBAC, maker-checker, and all nine EN-A envelope gates) applying unchanged.

**Architecture:** A key resolves to the SAME `TokenClaims` shape `requireUser` already produces, so authorization is untouched. `requireUser` becomes `requirePrincipal`: sniff the credential, resolve JWT **or** key, populate `request.user` identically (plus `request.apiKey` for key requests). Scopes narrow — never widen — via a `requireScope(...)` preHandler composed onto mutating routes. Keys bind to a **service user** (`UserRecord.kind`), minted through the existing org-member path so EN-A's filters apply at creation.

**Tech Stack:** apps/api (Fastify + Prisma/SQLite + memory repos, vitest), packages/core (scope vocabulary only), apps/web (Developers surface).

**Spec:** `docs/superpowers/specs/2026-08-08-machine-api-access-design.md` — read it first, especially "The seam" and the narrowing-only invariant.

**Branch:** create `feat/api-keys` off main before Task B1.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `packages/core/src/api-scopes.ts` | create | scope vocabulary + `scopeAllows` (pure) |
| `packages/core/src/index.ts` | modify | EXPLICIT export list (the standing ID-D lesson) |
| `apps/api/prisma/schema.prisma` | modify | `model ApiKey` + `User.kind` |
| `apps/api/src/persistence/types.ts` | modify | `ApiKeyRecord` + repo + `UserRecord.kind` |
| `apps/api/src/persistence/{memory,prisma}.ts` | modify | parity impls |
| `apps/api/src/api-keys.ts` | create | secret mint/parse/verify + the verified-prefix cache |
| `apps/api/src/http/support.ts` | modify | `requirePrincipal` (replaces `requireUser`) + `requireScope` |
| `apps/api/src/http/routes.ts` | modify | key CRUD routes, scope preHandlers, login service-account refusal, key-only binding re-check |
| `apps/api/src/http/schemas.ts` | modify | key schemas |
| `apps/api/src/context.ts` | modify | `AppDeps.apiKeys` + rate-limit config |
| `apps/api/test/api-keys.test.ts` | create | auth seam, scopes, envelope carry-forward, management |
| `apps/web/src/{types,api}.ts`, `components/Developers.tsx`, `domains.ts`, `App.tsx` | modify/create | Developers surface + nav |

**Standing hard rules:** never edit an existing behavioral test; persistence changes land in schema + types + BOTH repos + `prisma generate` in ONE commit; loose response schemas for new nested fields; normalize `""`→null at route edges; kill APIs by port; the secret is never logged, audited, or returned by a read route.

---

### Task B1: Core — scope vocabulary + `scopeAllows`

**Files:** create `packages/core/src/api-scopes.ts`, `packages/core/test/api-scopes.test.ts`; modify `packages/core/src/index.ts`.

- [ ] **Step 1: Failing tests.**

```ts
import { describe, expect, it } from "vitest";
import { API_SCOPES, scopeAllows, validateScopes } from "../src/api-scopes.js";
import { PolicyError } from "../src/errors.js";

describe("scopeAllows", () => {
  it("null granted (a human session) allows everything — scopes are a key-only concept", () => {
    expect(scopeAllows(null, "credentials:issue")).toBe(true);
  });
  it("the wildcard allows everything", () => {
    expect(scopeAllows(["*"], "assets:transfer")).toBe(true);
  });
  it("an exact grant allows only that action", () => {
    expect(scopeAllows(["credentials:issue"], "credentials:issue")).toBe(true);
    expect(scopeAllows(["credentials:issue"], "credentials:revoke")).toBe(false);
  });
  it("a resource wildcard allows every action on that resource only", () => {
    expect(scopeAllows(["verifications:*"], "verifications:verify")).toBe(true);
    expect(scopeAllows(["verifications:*"], "credentials:issue")).toBe(false);
  });
  it("an empty grant list allows nothing", () => {
    expect(scopeAllows([], "credentials:read")).toBe(false);
  });
});

describe("validateScopes", () => {
  it("accepts known scopes, the wildcard, and resource wildcards", () => {
    expect(validateScopes(["*"])).toEqual(["*"]);
    expect(validateScopes(["credentials:issue", "verifications:*"])).toEqual(["credentials:issue", "verifications:*"]);
  });
  it("rejects unknown scopes, duplicates, non-arrays, and an empty list", () => {
    expect(() => validateScopes(["ledger:drop"])).toThrow(/unknown scope/);
    expect(() => validateScopes(["credentials:issue", "credentials:issue"])).toThrow(/duplicate/);
    expect(() => validateScopes("credentials:issue" as never)).toThrow(PolicyError);
    expect(() => validateScopes([])).toThrow(/at least one/);
  });
});

describe("API_SCOPES", () => {
  it("every scope is resource:action with a known resource", () => {
    for (const s of API_SCOPES) expect(s).toMatch(/^[a-z]+:[a-z]+$/);
  });
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement `packages/core/src/api-scopes.ts`:**

```ts
/**
 * Coarse API-key scopes (EN-B). A scope can only ever NARROW what the key's
 * bound service user could already do — authorization is
 * `roleAllows && envelopeAllows && scopeAllows`, so a scope never widens
 * authority and is safe to hand to an integrator.
 *
 * `granted === null` means "not a key request" (a human JWT session): scopes
 * are a property of keys only, so every check passes.
 */
import { PolicyError } from "./errors.js";

export const API_SCOPES = [
  "credentials:read", "credentials:issue", "credentials:revoke",
  "verifications:read", "verifications:request", "verifications:verify",
  "assets:read", "assets:issue", "assets:transfer",
  "users:read", "users:onboard",
  "org:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** A grant is an exact scope, a `resource:*` wildcard, or the global `*`. */
export type ApiScopeGrant = ApiScope | "*" | `${string}:*`;

export function scopeAllows(granted: readonly string[] | null, required: ApiScope): boolean {
  if (granted === null) return true;
  if (granted.includes("*")) return true;
  if (granted.includes(required)) return true;
  const resource = required.slice(0, required.indexOf(":"));
  return granted.includes(`${resource}:*`);
}

export function validateScopes(input: unknown): string[] {
  if (!Array.isArray(input)) throw new PolicyError("INVALID_SCOPES", "scopes must be an array");
  if (input.length === 0) throw new PolicyError("INVALID_SCOPES", "provide at least one scope");
  const resources = new Set(API_SCOPES.map((s) => s.slice(0, s.indexOf(":"))));
  for (const s of input) {
    if (typeof s !== "string") throw new PolicyError("INVALID_SCOPES", "scopes must be strings");
    if (s === "*") continue;
    if (s.endsWith(":*")) {
      if (!resources.has(s.slice(0, -2))) throw new PolicyError("INVALID_SCOPES", `unknown scope resource '${s}'`);
      continue;
    }
    if (!(API_SCOPES as readonly string[]).includes(s)) throw new PolicyError("INVALID_SCOPES", `unknown scope '${s}'`);
  }
  if (new Set(input).size !== input.length) throw new PolicyError("INVALID_SCOPES", "scopes contain duplicates");
  return [...input] as string[];
}
```

Add `"INVALID_SCOPES"` to `PolicyErrorCode` if it is a closed union (read errors.ts — EN-A did the same for `INVALID_CAPABILITIES`).

- [ ] **Step 4: Export** all five names from `packages/core/src/index.ts`'s explicit list (values + `export type` for `ApiScope`/`ApiScopeGrant`).

- [ ] **Step 5: Green** — target file, full core suite (231 + new), core + api tsc.

- [ ] **Step 6: Commit** — `feat(core): API scope vocabulary — narrowing-only scopeAllows + validator`.

---

### Task B2: Persistence — `ApiKey` model, `User.kind`, parity

**Files:** `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/{types,memory,prisma}.ts`; test `apps/api/test/api-keys.test.ts` (created here).

- [ ] **Step 1: Failing test** — a memory-repo pin: create a key, `findByPrefix` returns it, `touchLastUsed` updates, `revoke` sets `revokedAt`, `listByOrg` excludes nothing (revoked rows still listed, they carry the audit trail). Read the org/credential repos first for the real create-input idiom.

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Schema** (then `pnpm --filter @tokenlayer/api exec prisma generate`):

```prisma
model ApiKey {
  id         String    @id @default(cuid())
  orgId      String?   // null = platform-owned key (PlatformAdmin-minted)
  userId     String    // the bound SERVICE user this key authenticates as
  name       String
  prefix     String    @unique // first 8 chars of the secret — safe to display/index
  secretHash String    // bcrypt of the full secret; the secret itself is never stored
  scopes     String    // JSON string[]
  expiresAt  DateTime?
  lastUsedAt DateTime?
  revokedAt  DateTime?
  revokedBy  String?
  createdBy  String
  createdAt  DateTime  @default(now())

  @@index([orgId])
}
```

And on `model User`: `kind String @default("human") // "human" | "service" (EN-B)`.

- [ ] **Step 4: Types + BOTH repos (same commit).** `ApiKeyRecord` mirroring the model (scopes as `string[]`, dates as ISO strings — match the file's conventions); `UserRecord.kind: "human" | "service"`; `ApiKeyRepository { create, findByPrefix, findById, listByOrg, touchLastUsed, revoke }`. Prisma mapper JSON-parses `scopes`; create stringifies. The widened `UserRecord` makes every `users.create(` site a compile error — grep and pass `kind: "human"` explicitly at each (expected: onboarding executor, org member route, `POST /users`, provisioning desk users, seed).

- [ ] **Step 5: Green** — target file + FULL api suite (426 + new; nothing breaks) + tsc.

- [ ] **Step 6: Commit** — `feat(api): ApiKey model + User.kind service accounts (memory/prisma parity)`.

---

### Task B3: API — secret mint/verify + the principal seam

**Files:** create `apps/api/src/api-keys.ts`; modify `apps/api/src/http/support.ts`, `apps/api/src/context.ts`, `apps/api/src/app.ts` (only if the preHandler is wired there); extend the test file.

- [ ] **Step 1: Failing tests** (describe "API key auth seam"):
1. A key authenticates and reaches a route its role allows (build the key directly through the repo + `mintSecret` so this task doesn't depend on B4's routes).
2. Revoked key → 401; expired key → 401; key whose service user is `active: false` → 401; garbage string → 401; a valid-format key with the wrong secret → 401. **All five must return the SAME body** (no oracle distinguishing unknown from revoked).
3. A JWT request is unaffected (assert an existing flow still works).
4. `POST /auth/login` as a service user → 403 `SERVICE_ACCOUNT`.
5. `request.apiKey` is populated for key requests and absent for JWT requests (assert indirectly via a scope-gated route in B4, or expose nothing and defer — prefer asserting through behavior, not internals).

- [ ] **Step 2: Implement `apps/api/src/api-keys.ts`:**

```ts
/**
 * API-key secrets (EN-B). The secret exists exactly once — in the create/rotate
 * response. We store a bcrypt hash plus an indexed public prefix, so a leaked
 * database yields no working credential (an unsalted-hash lookup would).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";

const PREFIX_LEN = 8;
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export interface MintedSecret { secret: string; prefix: string; hash: string }

export async function mintSecret(rounds: number): Promise<MintedSecret> {
  const body = Array.from(randomBytes(22), (b) => ALPHABET[b % ALPHABET.length]).join("");
  const secret = `tl_live_${body}`;
  return { secret, prefix: body.slice(0, PREFIX_LEN), hash: await bcrypt.hash(secret, rounds) };
}

/** The prefix a raw credential claims, or null when it isn't a key at all. */
export function prefixOf(raw: string): string | null {
  if (!raw.startsWith("tl_live_")) return null;
  const body = raw.slice("tl_live_".length);
  return body.length >= PREFIX_LEN ? body.slice(0, PREFIX_LEN) : null;
}

export async function secretMatches(raw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(raw, hash);
}
```

(Read how bcrypt is imported in routes.ts and match it. `timingSafeEqual` is imported only if you use it — drop the import otherwise; bcrypt.compare is already constant-time.)

- [ ] **Step 3: The seam.** In `support.ts`, rename `requireUser` → `requirePrincipal` (keep a `requireUser` alias export ONLY if grep shows external callers; otherwise rename outright and update the single `auth` binding in routes.ts). New signature takes `{ users, apiKeys }`. Flow:

```
read Authorization: Bearer <raw>
if prefixOf(raw) === null:   → existing jwtVerify path, request.apiKey = undefined
else:
  key = apiKeys.findByPrefix(prefix)
  reject(401 generic) if !key || key.revokedAt || (key.expiresAt && expiresAt < now)
  reject(401 generic) if !(await secretMatches(raw, key.secretHash))
  user = users.findById(key.userId); reject(401 generic) if !user || !user.active
  request.user = { id, email, role, useCaseKey, orgId, did }   // IDENTICAL shape
  request.apiKey = { id: key.id, scopes: key.scopes }
  touchLastUsed at most once per minute (compare key.lastUsedAt before writing)
```

Declare the `apiKey` property via Fastify module augmentation next to however `request.user` is typed. **Do not** add a verified-prefix cache in this task — correctness first; the spec's cache is a follow-up only if the walkthrough shows a problem (note it in your report).

- [ ] **Step 4: Login refusal** — in `POST /auth/login`, after the user loads: `if (user.kind === "service") return 403 SERVICE_ACCOUNT`. Place it beside the existing `!user.active` check.

- [ ] **Step 5: Wire** `AppDeps.apiKeys` at every construction site (grep the AppDeps shape — EN-A touched ~7 sites; the test helper `buildTestApp` is NOT an existing behavioral test, so it may be extended).

- [ ] **Step 6: Green** — full api suite; **every pre-existing test must pass untouched** (the JWT path is byte-identical).

- [ ] **Step 7: Commit** — `feat(api): API-key principal seam — key or JWT resolves to the same claims`.

---

### Task B4: API — scope enforcement, key management routes, key-only binding re-check

**Files:** `apps/api/src/http/{routes,schemas,support}.ts`; extend the test file.

- [ ] **Step 1: Failing tests:**
1. **Scopes:** a `credentials:issue` key issues; the same key gets 403 `INSUFFICIENT_SCOPE` (with `details.required`) on revoke; a `*` key does both; a `credentials:*` key does both.
2. **NARROWING PROVEN:** a key with `credentials:issue` bound to a service user whose ROLE cannot issue is refused by the ROLE gate (403 FORBIDDEN / the existing code) — not by the scope gate. Assert the error code to prove which gate fired.
3. **Envelope carry-forward:** a key in an org tightened to `roles: []` gets `ORG_CAPABILITY_MISSING` on issuance — no new code, the EN-A gate firing through the key path.
4. **Key-only binding re-check:** mint a key for a scoped Issuer desk; unbind the org from the use case (PATCH the use-case issuer to another org); the KEY now 403s while an equivalent HUMAN session still succeeds (today's deferred-retroactivity behavior preserved for humans).
5. **Management:** OrgAdmin creates a key (201, secret present, `tl_live_` prefixed) → list shows it WITHOUT the secret → rotate returns a new secret and the old one 401s → revoke and the new one 401s; a foreign OrgAdmin 403s on all four; PlatformAdmin may act on any org.
6. **Rate limit:** exceed the configured per-key ceiling → 429 `RATE_LIMITED` with `Retry-After` (set the ceiling low via `buildTestApp` config for the test).

- [ ] **Step 2: `requireScope`** in support.ts:

```ts
/** Composed onto mutating routes. A JWT request has no key ⇒ always allowed. */
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
```

Compose it as `{ preHandler: [auth.preHandler, requireScope("credentials:issue")] }` — read how `...auth` is spread today and keep every existing route's shape unchanged where no scope applies.

**Scope map** (apply to these routes; everything else stays unscoped, which for a key means role+envelope only):
`POST /credential-use-cases/:key/credentials` + `/batch` → `credentials:issue` · `POST /credentials/:id/revoke` and `/credentials/requests` → `credentials:revoke`/`credentials:issue` respectively · `GET /me/credentials`, `/orgs/:id/wallet`, `/credentials/:id/status` (authed variants) → `credentials:read` · `POST /verification-requests` → `verifications:request` · `GET …/verify` → `verifications:verify` · verification reads → `verifications:read` · `POST /use-cases/:key/assets` (issue) → `assets:issue` · transfer/buy actions → `assets:transfer` · asset reads → `assets:read` · `POST /users` + `/users/batch` → `users:onboard` · `GET /users` → `users:read` · `GET /orgs*` → `org:read`.

- [ ] **Step 3: Key management routes** (all `orgScoped`, OrgAdmin own-org / PlatformAdmin any):
- `POST /orgs/:id/api-keys` — `{name, role, useCaseKey?, scopes, expiresAt?}`. Validate scopes; **create the service user by calling the SAME helper the member route uses** so `canCreateOrgMember`, the EN-A envelope filter and the EN-A binding check all run (extract that block into a helper if it is inline — a behavior-preserving extraction, and say so in your report); mint the secret; create the key; audit `api-key-created` (id + name + scopes, NEVER the secret). 201 `{key: <view>, secret}`.
- `GET /orgs/:id/api-keys` — list; the view NEVER includes `secretHash`; include `prefix`, `scopes`, `lastUsedAt`, `expiresAt`, `revokedAt`, and the bound user's role.
- `POST /orgs/:id/api-keys/:keyId/rotate` — new secret+hash on the same row; audit; 200 `{key, secret}`.
- `DELETE /orgs/:id/api-keys/:keyId` — set `revokedAt`/`revokedBy`; when the bound service user has no remaining live keys, `users.update(userId, {active: false})`; audit; 200.

- [ ] **Step 4: Rate limit** — per-key token bucket in the same in-process style as `loginThrottled` (routes.ts ~102), ceiling from `deps.apiKeyRateLimitMax ?? 600` per minute. On trip: 429 `{error: "RATE_LIMITED"}` + `Retry-After` header. Apply inside `requirePrincipal`'s key branch (after successful verification, so an attacker can't consume another key's budget).

- [ ] **Step 5: Key-only binding re-check** — at `resolveIssuer`'s scoped-operator branch and the desk-verifier branch of `POST /verification-requests`: when `request.apiKey` is present AND the principal is a scoped desk operator, re-verify the org's current binding (`issuerBindingAllows` / `verifierBindingAllows` against the fresh def, or ownership). Human sessions skip it — that preserves EN-A's recorded non-retroactivity for interactive desks. Comment WHY at both sites (unattended keys outlive config changes).

- [ ] **Step 6: Schemas** — `createApiKey`/`listApiKeys`/`rotateApiKey`/`revokeApiKey`; loose 200/201 objects; `errs(400,401,403,404)`; the `Error#` component already carries loose `details` for `INSUFFICIENT_SCOPE`.

- [ ] **Step 7: Green** — full api suite, zero existing-test edits, tsc.

- [ ] **Step 8: Commit** — `feat(api): key scopes, management routes, per-key rate limit, key-only binding re-check`.

---

### Task B5: Web — Developers surface

**Files:** `apps/web/src/{types,api}.ts`, create `components/Developers.tsx`, modify `domains.ts`, `App.tsx`.

- [ ] **Step 1: Types + client** — `ApiKeyView`, `ApiScope` list mirroring core; `listApiKeys`, `createApiKey`, `rotateApiKey`, `revokeApiKey`.
- [ ] **Step 2: `Developers.tsx`** — key table (name, `tl_live_xxxxxxxx…` prefix, scope pills, bound role, last used, expiry, status pill incl. `revoked`/`expired`); Create dialog (name, role picker **filtered by the org envelope exactly like AddMember** — reuse `apps/web/src/lib/capabilities.ts`, scope checkboxes with one-line plain-language descriptions, optional expiry date); **one-time secret panel** — monospace, Copy button, an explicit "this is the only time you will see this" warning, and a required "I've stored it" acknowledgement before it can be dismissed; Rotate (confirm → shows the new secret in the same panel) and Revoke (confirm) actions; a short "Using your key" snippet showing a real `curl` with the `Authorization: Bearer` header.
- [ ] **Step 3: Nav** — `developers` id, `"shared"` in `NAV_DOMAIN` (it is tenant tooling, not a domain surface — the EN-A `organizations` lesson), shown to OrgAdmin + PlatformAdmin in the branches that already show `organizations`.
- [ ] **Step 4: Green** — web tsc + build; api tsc unchanged.
- [ ] **Step 5: Commit** — `feat(web): Developers surface — API key lifecycle with one-time secret`.

---

### Task B6: Verify — suites + live Besu walkthrough AS AN EXTERNAL CLIENT + review + finish

- [ ] **Step 1:** typechecks (core/adapters/api/web; contracts is known-broken on main — skip), core + api suites, web build.
- [ ] **Step 2: Live Besu walkthrough** (scratchpad script; standard boot recipe, throwaway `dev-bdemo.db`, kill by port, dev.db untouched). **The integration half of the script must hold NOTHING but the key string** — no JWT, no cookie:
1. Admin/OrgAdmin session: provision an identity program, mint a key with `credentials:issue` bound to an Issuer service user.
2. **Switch to a bare client** carrying only `Authorization: Bearer tl_live_…`: issue a credential end-to-end; approve as needed; assert it is anchored on Besu by `eth_call VcRegistry.statusOf` (the same independent proof used throughout this codebase).
3. Same key attempts a revoke → 403 `INSUFFICIENT_SCOPE`.
4. Tighten the org's envelope to `roles: []` → the key's next issuance 403s `ORG_CAPABILITY_MISSING` (the EN-A gate through the key path).
5. Rotate → the OLD secret 401s, the NEW one works.
6. Revoke → the new secret 401s; a garbage key and an expired key also 401 with the SAME body.
7. Rate limit: hammer past the configured ceiling → 429 with `Retry-After`.
8. Teardown; `dev.db` untouched.
Optional browser pass: mint and rotate a key in the Developers UI, confirming the one-time secret panel and that the secret never reappears in the list.
- [ ] **Step 3: Final whole-branch review** — instruct the reviewer to **hunt independently** (the EN-A lesson: the whole-branch pass found an escalation the per-task reviews missed). Focus: can a key ever exceed its service user (scope widening, role confusion, a route missing its scope)? Is the 401 truly non-oracular across all five rejection paths? Is the secret absent from every log/audit/response/error? Does the key path bypass ANY gate the JWT path enforces (diff the two branches of `requirePrincipal` line by line)? Rate-limit bypass via prefix collisions? `User.kind` default correct for every create site?
- [ ] **Step 4: Finish** — superpowers:finishing-a-development-branch, standing option 1: merge `feat/api-keys` → main, delete branch, update `enterprise-program.md` (EN-B merged; EN-C webhooks next).

---

## Self-review notes

- Spec coverage: scopes → B1; model/service user → B2; the seam + login refusal → B3; scope enforcement, management, rate limit, the EN-A-deferred binding re-check → B4; Developers UI → B5; external-client walkthrough + finish → B6.
- Deliberate deferral: the verified-prefix LRU cache from the spec is NOT in B3 (correctness first); B6 reports whether the walkthrough showed a latency problem worth adding it for.
- Known unknowns flagged for implementers rather than guessed: bcrypt import style, whether `requireUser` has external callers, the member-creation block's extractability, the exact `...auth` spread shape, and every route's current schema entry.
