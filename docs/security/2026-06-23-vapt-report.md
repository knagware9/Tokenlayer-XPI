# VAPT Report — XI Tokenize (TokenLayer) Platform

**Date:** 2026-06-23
**Assessor:** Internal security assessment (authorized; owner-operated local instance)
**Target:** `apps/api` (Fastify REST API, `:4000`), `apps/web` (React dashboard, `:5173`), `packages/core` + `packages/adapters`
**Method:** Grey-box — static code review + live dynamic testing against the running API + dependency audit. Severity is rated for a **production** deployment.

---

## Executive summary

The platform's domain authorization is, in most respects, well built: every route is authenticated, use-case tenancy is consistently scoped (cross-tenant reads 404, actions 403), there is no SQL injection (Prisma) and no stored-XSS sink (React auto-escaping, no `dangerouslySetInnerHTML`), and user-provisioning privilege boundaries are correctly contained.

However, the assessment found **2 Critical** and **6 High** issues that would be catastrophic in production. The headline finding is a **complete authentication bypass**: the JWT signing secret falls back to a hard-coded public value and the app never loads its `.env`, so the live server runs on a known secret — I forged a `PlatformAdmin` token with no credentials and obtained full administrative access. A second Critical is a **business-logic flaw**: the `Trader`/Operator role can transfer or burn tokens from *any* holder account in a use case, with no holder-level authorization.

**Fix before any production exposure: C1, C2, and H1 — they compound.**

| # | Severity | Finding |
|---|----------|---------|
| C1 | **Critical** | Auth bypass — hard-coded JWT secret fallback + no dotenv load → forgeable PlatformAdmin tokens (**live-proven**) |
| C2 | **Critical** | Trader/Operator can transfer/burn ANY holder's balance (no holder-level authorization) |
| H1 | High | JWTs never expire **and** existing tokens survive suspension/deletion (no revocation) |
| H2 | High | Vulnerable dependencies — `fast-jwt 5.0.6` (+ vitest, undici, lodash, serialize-javascript): 14 critical/high advisories |
| H3 | High | Weak, predictable seed passwords (`admin123`, `<usecase>123`) created at every startup |
| H4 | High | CORS reflects any origin (`origin: true`) |
| H5 | High | JWT stored in `localStorage` (XSS → token theft; amplified by no-expiry) |
| H6 | High | Real-format EVM operator private key committed in `.env.example` (dangerous pattern) |
| M1 | Medium | No login rate-limiting / account lockout (brute-force / credential-stuffing) |
| M2 | Medium | No security headers (Helmet absent: no CSP/HSTS/X-Frame-Options/X-Content-Type-Options) |
| M3 | Medium | Error handler reflects raw adapter/ethers messages to clients (info disclosure) |
| M4 | Medium | Cross-tenant account enumeration — `/accounts` & `/assets/:id/accounts` list all platform accounts |
| M5 | Medium | Loose input validation — `additionalProperties:true`, no `maxLength`/email-`format`, no body size limit |
| L1 | Low | `/docs` + `/openapi.json` exposed unauthenticated (recon) |
| L2 | Low | bcrypt cost factor 10 on pure-JS `bcryptjs` |
| L3 | Low | Asset metadata tolerates arbitrary unmodeled fields |
| L4 | Low | JWT verify has no explicit `algorithms` allowlist (alg-confusion hardening) |

---

## Critical findings

### C1 — Authentication bypass: hard-coded JWT secret + no dotenv (LIVE-PROVEN)
**Severity: Critical** · `apps/api/src/env.ts:10`, `apps/api/src/app.ts:21`

```ts
jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",   // env.ts:10
```
The app contains **no `dotenv` loader** (nothing imports `dotenv/config`), so unless `JWT_SECRET` is exported into the shell, `process.env.JWT_SECRET` is undefined and the server signs/verifies JWTs with the literal string `"dev-secret-change-me"` — which is also committed in `.env.example`. The dev `.env` on disk holds the same value.

**Proof of concept (run against the live server, no credentials):**
```js
const crypto = require("crypto");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const secret = "dev-secret-change-me";
const h = b64({ alg: "HS256", typ: "JWT" });
const p = b64({ id: "forged-attacker", email: "attacker@evil.test", role: "PlatformAdmin", useCaseKey: null });
const sig = crypto.createHmac("sha256", secret).update(h + "." + p).digest("base64url");
const token = `${h}.${p}.${sig}`;
// GET /api/v1/me      → 200 { role: "PlatformAdmin" }
// GET /api/v1/users   → 200 (all 16 users)
// GET /api/v1/use-cases → 200 (every use case)
```
Result observed: full PlatformAdmin access — list/create users, create/edit use cases, issue and operate assets across all tenants — with **zero credentials**.

**Remediation:** Remove the fallback; fail fast at boot if `JWT_SECRET` is unset or equals the dev value. Load secrets from a manager (or `dotenv` for local only), generate a ≥256-bit random secret per environment, rotate the leaked value, and consider asymmetric RS256/ES256 so the verifying side never holds a forging key.

### C2 — Trader/Operator can seize or destroy any holder's balance (no holder authorization)
**Severity: Critical** · `packages/core/src/lifecycle-engine.ts` (transfer/burn), `apps/api/src/http/routes.ts:173-178`, `packages/adapters/src/simulated-ledger.ts`, `evm-adapter.ts:209-219`

`transfer`/`burn` accept an attacker-controlled `from` address and the engine authorizes only the **role** (`rbac.authorize(actor, "transfer"|"burn")`) — never that the caller owns or is approved for `from`. `Actor` is `{ id, role }`; the holder address is never bound to the caller. On ERC-3643 the transfer is implemented via the privileged `forcedTransfer` and `burn` agent operations, which seize balances without the holder's signature.

**Impact:** Any `Trader` (or UseCaseAdmin/PlatformAdmin) can drain or burn the balance of *any* account in the use case — investors, treasury, other holders — i.e. unauthorized movement/destruction of tokenized assets.

**Remediation:** Bind holder addresses to the caller. Resolve the actor's own wallet (`UserRecord.accountId → accounts`) and require `from === actorAddress` for `transfer`/`burn`, reserving forced-transfer/recovery for an explicit privileged operator action that is clearly labeled and audited. Enforce this in the engine so it holds across all adapters.

---

## High findings (condensed)

- **H1 — No token expiry + no revocation** (`app.ts:21`, `routes.ts:45`, `support.ts:22-28`): `app.jwt.sign` sets no `expiresIn` and the decoded token has no `exp`; `authenticate` only verifies the signature and never re-loads the user. So **suspending or deleting a user does not invalidate their existing token**, and a leaked token is valid forever. *Fix:* short `expiresIn` + an `onRequest` hook that reloads the user by `claims.id`, rejecting if missing/`!active` and re-deriving role/useCaseKey from the DB.
- **H2 — Vulnerable dependencies**: `pnpm audit` reports 14 critical/high advisories — notably `fast-jwt@5.0.6` (via `@fastify/jwt@9.1.0`; advisory range includes it), plus `vitest`/`vite` (dev), `undici`, `lodash` (`_.template` injection), `serialize-javascript`, `tmp`. *Fix:* upgrade `@fastify/jwt`/`fast-jwt` and the rest; run `pnpm audit --fix` and re-verify. (The specific "empty HMAC secret" bypass needs a non-empty secret, which we have — but the package is out of date regardless.)
- **H3 — Predictable seed credentials** (`seed.ts:14-36,65`): `admin@tokenlayer.dev`/`admin123` and `<prefix>.<role>@tokenlayer.dev`/`<prefix>123` are seeded unconditionally at startup (`server.ts:25`). Guessable PlatformAdmin login independent of C1. *Fix:* gate seeding to non-production; randomize or force first-login reset.
- **H4 — CORS `origin: true`** (`app.ts:20`): reflects any `Origin` (verified live: `Access-Control-Allow-Origin: https://evil.example`). Partly mitigated today by header-based (not cookie) auth, but becomes a CSRF/data-theft vector if cookies are adopted. *Fix:* explicit per-env origin allowlist.
- **H5 — JWT in `localStorage`** (`auth.tsx:14,34`): readable by any in-origin JS; combined with H1 (no expiry) a single XSS or malicious dependency = permanent account takeover. *Fix:* httpOnly+Secure+SameSite cookie, or in-memory + short-lived token + refresh; add CSP.
- **H6 — Real-shaped operator key in `.env.example`** (`apps/api/.env.example:13`): the committed example carries the well-known Hardhat key, normalizing raw private keys in tracked config (the contract-owner key on a real chain). *Fix:* placeholders only; load operator keys from a KMS/HSM. (Credit: the live `.env` IS gitignored and untracked.)

---

## Medium findings (condensed)

- **M1 — No login rate-limiting / lockout** (verified live: 12 rapid bad logins all 401, no throttle). *Fix:* `@fastify/rate-limit` on `/auth/login` + progressive lockout.
- **M2 — No security headers** (`app.ts`, no `@fastify/helmet`): no CSP, HSTS, X-Frame-Options, X-Content-Type-Options. *Fix:* register Helmet with a tuned CSP; serve over TLS.
- **M3 — Error info disclosure** (`support.ts:50-54`): the `REQUEST_FAILED` branch reflects raw `err.message` (ethers reverts, RPC URLs, contract/nonce details) to clients. *Fix:* generic client message; log detail server-side only.
- **M4 — Cross-tenant account enumeration** (`routes.ts:52,111-148`): `/accounts` and `/assets/:id/accounts`/`/tokens` call `accounts.list()` (all platform accounts) — a scoped Auditor sees every tenant's account labels/addresses. *Fix:* scope account listings to the use case.
- **M5 — Loose input validation** (`schemas.ts`): `additionalProperties:true` on use-case/metadata bodies, no `maxLength` on strings, no `format:"email"`, no Fastify `bodyLimit`. *Fix:* tighten schemas + set a body size cap.

## Low findings

- **L1** `/docs` + `/openapi.json` unauthenticated (`app.ts:43,58`) — recon aid; disable/gate in prod.
- **L2** bcrypt cost 10 on pure-JS `bcryptjs` — raise to 12 or use native bcrypt/argon2id.
- **L3** asset metadata tolerates unknown fields (`validation.ts:103`) — reject unknown props if strictness desired.
- **L4** JWT verify has no explicit `algorithms` allowlist — pin `verify: { algorithms: ["HS256"] }` to prevent alg confusion.

---

## Controls verified correct (credit)

- Every route requires authentication; only `POST /auth/login` is public.
- Use-case tenancy is consistently enforced (`scopedAsset`/`scopedToCaller`): cross-tenant reads → 404 (existence-hiding), actions → 403 `WRONG_USE_CASE`; list endpoints fail-closed via a `__none__` sentinel.
- No SQL injection — all persistence via parameterized Prisma; no raw SQL.
- No stored XSS — zero `dangerouslySetInnerHTML`/`innerHTML`/`eval`; React escapes all user-controlled values.
- No mass-assignment escalation — `role`/`useCaseKey`/`createdBy`/`active` are server-controlled; `PATCH`/`DELETE /users` only touch password/active and can't target a UseCaseAdmin/PlatformAdmin; `canCreateUser` confines provisioning to allowed roles within the caller's tenant.
- Server-side metadata validation runs before persistence; the lifecycle `action` body uses strict `additionalProperties:false` + enum.
- `.env` is gitignored/untracked; operator keys are never logged or returned by any endpoint.

---

## Remediation roadmap (priority order)

1. **C1** — kill the hard-coded secret + fail-fast on weak/missing `JWT_SECRET`; load real secrets per-env; rotate. *(hours)*
2. **H1** — add JWT `expiresIn` + per-request user re-validation hook (also revokes suspended/deleted sessions and refreshes role/scope). *(hours)*
3. **C2** — add holder-ownership authorization to transfer/burn; gate forced-transfer behind an explicit privileged path. *(0.5–1 day)*
4. **H3** — disable default seeding in production / randomize. **H4** — CORS allowlist. **H6** — scrub `.env.example`. *(hours)*
5. **H2** — `pnpm audit --fix` + upgrade `@fastify/jwt`/`fast-jwt`, undici, lodash, etc. *(hours)*
6. **H5/M2** — httpOnly cookie or short-token+refresh; add Helmet + CSP. *(0.5 day)*
7. **M1/M3/M4/M5** + Lows — rate-limit login, sanitize error output, scope account listings, tighten schemas, gate docs, raise bcrypt cost, pin JWT alg. *(0.5–1 day)*
