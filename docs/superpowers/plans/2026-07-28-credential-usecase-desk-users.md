# Credential Use-Case Desk Users (ID-F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a DID/VC (credential) use case scoped desk users — a `UseCaseAdmin` who runs one credential use case and onboards its `Issuer`/`Holder`/`Verifier` roster — mirroring tokenization desks.

**Architecture:** Add `Holder`+`Verifier` roles; resolve a `useCaseKey`'s domain (tokenization vs identity) dynamically with a cross-type key-uniqueness guard (no new column); widen credential issue/revoke/verify gates to admit scoped desk users; render the Identity-domain operator desk for a credential-scoped user in the web app.

**Tech Stack:** packages/core (TS, vitest), apps/api (Fastify + Prisma/SQLite, vitest), apps/web (React + Vite + Tailwind).

**Spec:** `docs/superpowers/specs/2026-07-28-credential-usecase-desk-users-design.md`

**Conventions:** run tests from repo root with `pnpm -s --filter @tokenlayer/core test`, `pnpm -s --filter @tokenlayer/api test`, `pnpm -s --filter @tokenlayer/web typecheck`. API routes are under `/api/v1`; tests use `buildTestApp`/`loginAs`/`auth`/`V1` from `apps/api/test/helpers.ts`. Commit after each task.

---

## File Structure

- `packages/core/src/types.ts` — add `Holder`, `Verifier` to `Role`/`ROLES`.
- `packages/core/src/rbac.ts` — MATRIX entries for the new roles.
- `packages/core/src/user-policy.ts` — org-internal roles, domain-aware `assignableRoles`, `canCreateUser` domain check.
- `packages/core/src/use-case-domain.ts` (new) — `UseCaseDomain` + `useCaseDomainOf` pure helper.
- `packages/core/src/index.ts` — export the new helper/types.
- `apps/api/src/http/routes.ts` — key-collision guards, `/me` `useCaseDomain`, onboarding role/domain gate, credential issue/revoke/eligible-holders operator gate, verification scoped-Verifier path.
- `apps/api/src/http/schemas.ts` — `me` response gains `useCaseDomain`.
- `apps/web/src/types.ts` — `Role` union + `AuthUser`/`me` `useCaseDomain`.
- `apps/web/src/rbac.ts` — MATRIX + domain-aware `assignableRoles`.
- `apps/web/src/domains.ts` — nav ids for the credential desk.
- `apps/web/src/api.ts` — `me` returns `useCaseDomain`; `credentialUseCases` reused.
- `apps/web/src/App.tsx` — operator console renders the identity desk for a credential-scoped user.
- `apps/web/src/components/UserManagement.tsx` — domain-aware role options + credential use-case picker.

---

## Task F1: Core — Holder/Verifier roles, RBAC, domain-aware user-policy, domain resolver

**Files:**
- Modify: `packages/core/src/types.ts:10-12`
- Modify: `packages/core/src/rbac.ts:10-18`
- Modify: `packages/core/src/user-policy.ts`
- Create: `packages/core/src/use-case-domain.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/user-policy.test.ts` (extend), `packages/core/test/use-case-domain.test.ts` (new)

- [ ] **Step 1: Write failing tests for the domain-aware policy + resolver**

Create `packages/core/test/use-case-domain.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { useCaseDomainOf, assignableRoles, canCreateUser } from "../src/index.js";

describe("useCaseDomainOf", () => {
  const known = { tokenizationKeys: ["generic-asset", "invoice-tokenization"], credentialKeys: ["invoicevc", "corp-trade-credentials"] };
  it("classifies each domain and returns undefined for unknown", () => {
    expect(useCaseDomainOf("generic-asset", known)).toBe("tokenization");
    expect(useCaseDomainOf("invoicevc", known)).toBe("identity");
    expect(useCaseDomainOf("nope", known)).toBeUndefined();
  });
});

describe("assignableRoles is domain-aware", () => {
  it("identity UseCaseAdmin assigns Issuer/Holder/Verifier", () => {
    expect(assignableRoles("UseCaseAdmin", "identity").sort()).toEqual(["Holder", "Issuer", "Verifier"]);
  });
  it("tokenization UseCaseAdmin keeps Issuer/Buyer/Auditor", () => {
    expect(assignableRoles("UseCaseAdmin", "tokenization").sort()).toEqual(["Auditor", "Buyer", "Issuer"]);
    expect(assignableRoles("UseCaseAdmin").sort()).toEqual(["Auditor", "Buyer", "Issuer"]); // default tokenization
  });
});

describe("canCreateUser enforces role/domain consistency", () => {
  it("lets an identity UseCaseAdmin create a Holder in their own use case", () => {
    expect(canCreateUser({ role: "UseCaseAdmin", useCaseKey: "invoicevc" }, "Holder", "invoicevc", "identity")).toBe(true);
  });
  it("rejects a Holder in a tokenization use case", () => {
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "Holder", "generic-asset", "tokenization")).toBe(false);
  });
  it("rejects a Buyer in an identity use case", () => {
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "Buyer", "invoicevc", "identity")).toBe(false);
  });
});
```

Run: `pnpm -s --filter @tokenlayer/core test use-case-domain` → FAIL (missing exports).

- [ ] **Step 2: Add the roles**

`packages/core/src/types.ts` — replace the `Role`/`ROLES` lines:
```ts
export type Role = "PlatformAdmin" | "OrgAdmin" | "UseCaseAdmin" | "Issuer" | "Trader" | "Buyer" | "Auditor" | "Holder" | "Verifier";

export const ROLES: readonly Role[] = ["PlatformAdmin", "OrgAdmin", "UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor", "Holder", "Verifier"];
```

- [ ] **Step 3: RBAC entries**

`packages/core/src/rbac.ts` — add to `MATRIX` (after `Auditor`):
```ts
  Holder: new Set<LifecycleAction>(["read", "buy"]),      // holds/receives; may subscribe as an eligible holder
  Verifier: new Set<LifecycleAction>(["read"]),           // verification is gated at the route, not the lifecycle matrix
```
(The `Role` record type will now require both keys — TS enforces completeness.)

- [ ] **Step 4: Domain resolver**

Create `packages/core/src/use-case-domain.ts`:
```ts
/** A configurable use case belongs to exactly one product domain. */
export type UseCaseDomain = "tokenization" | "identity";

/**
 * Classify a use-case key by domain. Identity keys name a credential use case;
 * tokenization keys name an asset use case. Cross-type key collisions are
 * prevented at creation time, so a key resolves to at most one domain.
 * Returns undefined when the key names neither.
 */
export function useCaseDomainOf(
  key: string,
  known: { tokenizationKeys: Iterable<string>; credentialKeys: Iterable<string> },
): UseCaseDomain | undefined {
  for (const k of known.credentialKeys) if (k === key) return "identity";
  for (const k of known.tokenizationKeys) if (k === key) return "tokenization";
  return undefined;
}
```

- [ ] **Step 5: Domain-aware user-policy**

`packages/core/src/user-policy.ts`:
- Add the new roles to `ORG_INTERNAL_ROLES`:
```ts
const ORG_INTERNAL_ROLES: Role[] = ["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor", "Holder", "Verifier"];
```
- Import the domain type at top: `import type { UseCaseDomain } from "./use-case-domain.js";`
- Replace `assignableRoles` (PRESERVES tokenization behavior exactly — PlatformAdmin/OrgAdmin keep `UseCaseAdmin`+`Trader` — and adds the identity roster in parallel):
```ts
/** Which roles a given manager may assign to a new user in a use case of `domain`.
 *  PlatformAdmin/OrgAdmin may also mint a UseCaseAdmin; a UseCaseAdmin mints only
 *  the domain roster. Tokenization is unchanged; identity adds Holder/Verifier. */
export function assignableRoles(role: Role, domain: UseCaseDomain = "tokenization"): Role[] {
  const adminRoster: Role[] = domain === "identity" ? ["Issuer", "Holder", "Verifier"] : ["Issuer", "Trader", "Buyer", "Auditor"];
  const ucaRoster: Role[] = domain === "identity" ? ["Issuer", "Holder", "Verifier"] : ["Issuer", "Buyer", "Auditor"];
  if (role === "PlatformAdmin" || role === "OrgAdmin") return ["UseCaseAdmin", ...adminRoster];
  if (role === "UseCaseAdmin") return ucaRoster;
  return [];
}
```
- Replace `canCreateUser` to take `targetDomain` and check role/domain consistency:
```ts
export function canCreateUser(
  manager: ManagerRef,
  targetRole: Role,
  targetUseCaseKey: string | null,
  targetDomain: UseCaseDomain = "tokenization",
): boolean {
  if (!assignableRoles(manager.role, targetDomain).includes(targetRole)) return false;
  if (manager.role === "PlatformAdmin") return targetUseCaseKey !== null;
  if (manager.role === "UseCaseAdmin") return targetUseCaseKey !== null && targetUseCaseKey === manager.useCaseKey;
  return false;
}
```
Note: `assignableRoles` no longer returns `UseCaseAdmin` for PlatformAdmin/OrgAdmin — that was already only meaningful for the org path; `canCreateOrgMember` still governs `UseCaseAdmin` minting for the org route and is unchanged. If any existing test asserted a PlatformAdmin can `canCreateUser(..., "UseCaseAdmin", ...)`, add `UseCaseAdmin` to the `roster` for `PlatformAdmin`/`OrgAdmin` only — verify against the current suite in Step 7.

- [ ] **Step 6: Export from core**

`packages/core/src/index.ts` — add the new module to the explicit export list:
```ts
export { useCaseDomainOf, type UseCaseDomain } from "./use-case-domain.js";
```
(Confirm `assignableRoles`/`canCreateUser` are already exported; they are, via user-policy.)

- [ ] **Step 7: Run core suite**

Run: `pnpm -s --filter @tokenlayer/core test` → all pass. Fix any existing `user-policy`/RBAC test that assumed the old `assignableRoles(role)` arity or `UseCaseAdmin` in the roster (update to the domain-aware form). Run `pnpm -s --filter @tokenlayer/core typecheck`.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(core): Holder/Verifier roles + domain-aware user-policy + useCaseDomainOf"`

---

## Task F2: API — cross-type key guard + /me useCaseDomain

**Files:**
- Modify: `apps/api/src/http/routes.ts` (POST `/use-cases`, POST `/credential-use-cases`, GET `/me` / `actorOf`)
- Modify: `apps/api/src/http/schemas.ts` (`me` response)
- Test: `apps/api/test/credential-desk.test.ts` (new)

- [ ] **Step 1: Failing test — key collision + /me domain**

Create `apps/api/test/credential-desk.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

async function createCredUC(app, token, key) {
  return app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(token), payload: {
    key, name: key, description: "d",
    credentialTypes: [{ name: "T", title: "T", claimSchema: { type: "object", required: ["a"], properties: { a: { type: "string" } } }, requiredApprovals: 1 }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
  }});
}

describe("cross-type use-case key uniqueness", () => {
  it("rejects a credential use case whose key is an existing tokenization use case", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const r = await createCredUC(app, admin, "invoice-tokenization"); // seeded tokenization key
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("KEY_IN_USE");
  });
});

describe("GET /me reports useCaseDomain", () => {
  it("is 'tokenization' for a tokenization-scoped user and 'identity' for a credential-scoped one", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await createCredUC(app, admin, "cred-desk-uc");
    // (scoped-user creation is exercised in F3; here assert platform admin has no scope)
    const me = await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(admin) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toHaveProperty("useCaseDomain");
  });
});
```
Run: `pnpm -s --filter @tokenlayer/api test credential-desk` → FAIL.

- [ ] **Step 2: Key-collision guard on both create routes**

In `POST /credential-use-cases` (routes.ts ~416, before `deps.credentialUseCases.create`): after the existing validation, add:
```ts
if (await deps.useCases.get(def.key)) {
  return reply.code(409).send({ error: "KEY_IN_USE", message: `a tokenization use case already uses the key '${def.key}'` });
}
```
In `POST /use-cases` (the tokenization create path — find where a new use case is persisted): add the mirror:
```ts
if (await deps.credentialUseCases.get(<newKey>)) {
  return reply.code(409).send({ error: "KEY_IN_USE", message: `a credential use case already uses the key '${<newKey>}'` });
}
```
(Use the actual variable holding the incoming key. If `deps.useCases.get`/`credentialUseCases.get` return `null` for missing, this is correct.)

- [ ] **Step 3: /me returns useCaseDomain**

Locate `actorOf(request)` (used by GET `/me`, routes.ts:164). Add a resolved `useCaseDomain` to the returned object. Since `actorOf` may be sync, resolve the domain where `/me` is handled:
```ts
app.get("/me", { schema: S.me, ...auth }, async (request) => {
  const base = actorOf(request);
  const claims = request.user as TokenClaims;
  let useCaseDomain: "tokenization" | "identity" | null = null;
  if (claims.useCaseKey) {
    const [tks, cks] = [await deps.useCases.list(), await deps.credentialUseCases.list()];
    useCaseDomain = useCaseDomainOf(claims.useCaseKey, {
      tokenizationKeys: tks.map((u) => u.key),
      credentialKeys: cks.map((u) => u.key),
    }) ?? null;
  }
  return { ...base, useCaseDomain };
});
```
Import `useCaseDomainOf` from `@tokenlayer/core` (add to the existing import list on line 6). Confirm `deps.useCases.list()` and `deps.credentialUseCases.list()` exist (they back the GET list routes); if a repo lacks `list`, use the existing listing method.

- [ ] **Step 4: schema**

`apps/api/src/http/schemas.ts` — the `me` response is loose (`additionalProperties: true`) in this codebase; if `me` has an explicit `properties`, add `useCaseDomain: { type: ["string", "null"] }`. Otherwise no change.

- [ ] **Step 5: Run + commit**

Run: `pnpm -s --filter @tokenlayer/api test credential-desk` → the collision + `/me` tests pass. Run the full api suite to confirm no regression. `git commit -m "feat(api): cross-type use-case key guard + /me useCaseDomain"`.

---

## Task F3: API — onboarding accepts credential use cases with role/domain gate

**Files:**
- Modify: `apps/api/src/http/routes.ts` (POST `/users` onboarding + its `canCreateUser` call)
- Test: `apps/api/test/credential-desk.test.ts` (extend)

- [ ] **Step 1: Failing test — onboard an identity UseCaseAdmin + role/domain mismatch**

Add to `credential-desk.test.ts`:
```ts
describe("onboarding credential-desk users", () => {
  it("onboards a UseCaseAdmin scoped to a credential use case (gated), who then reports identity domain", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await createCredUC(app, admin, "id-desk");
    const r = await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: "desk@id.dev", password: "desk1234", role: "UseCaseAdmin", useCaseKey: "id-desk" } });
    expect(r.statusCode).toBe(202);
    await app.inject({ method: "POST", url: `${V1}/proposals/${r.json().proposal.id}/approve`, headers: auth(admin2) });
    const desk = await loginAs(app, "desk@id.dev", "desk1234");
    const me = await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(desk) });
    expect(me.json().role).toBe("UseCaseAdmin");
    expect(me.json().useCaseDomain).toBe("identity");
  });
  it("rejects onboarding a Buyer into a credential use case (400 ROLE_DOMAIN_MISMATCH)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await createCredUC(app, admin, "id-desk2");
    const r = await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: "x@id.dev", password: "x1234567", role: "Buyer", useCaseKey: "id-desk2" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("ROLE_DOMAIN_MISMATCH");
  });
});
```
Run → FAIL.

- [ ] **Step 2: Resolve target domain + pass to canCreateUser**

In the `POST /users` handler, before the `canCreateUser(...)` check, resolve the target use case's domain and pass it:
```ts
const targetDomain = body.useCaseKey
  ? useCaseDomainOf(body.useCaseKey, {
      tokenizationKeys: (await deps.useCases.list()).map((u) => u.key),
      credentialKeys: (await deps.credentialUseCases.list()).map((u) => u.key),
    })
  : undefined;
if (body.useCaseKey && !targetDomain) return reply.code(404).send({ error: "USE_CASE_NOT_FOUND", message: `no use case '${body.useCaseKey}'` });
if (!canCreateUser({ role: claims.role, useCaseKey: claims.useCaseKey }, body.role, body.useCaseKey ?? null, targetDomain)) {
  return reply.code(400).send({ error: "ROLE_DOMAIN_MISMATCH", message: `role '${body.role}' is not assignable in use case '${body.useCaseKey}'` });
}
```
Keep the existing 403/permission errors for the non-domain reasons; the domain-consistency failure surfaces as `ROLE_DOMAIN_MISMATCH`. (If the current code distinguishes "not permitted" vs "bad role", preserve that; only add the domain argument and the mismatch branch.) The onboarding executor that mints the user is unchanged — `useCaseKey` is stored verbatim.

- [ ] **Step 3: Run + commit**

Run the api suite → pass. `git commit -m "feat(api): onboard credential-desk users with role/domain gate"`.

---

## Task F4: API — credential issue / revoke / eligible-holders operator gate

**Files:**
- Modify: `apps/api/src/http/routes.ts` (POST `/credential-use-cases/:key/credentials`, GET `.../eligible-holders`, credential revoke)
- Test: `apps/api/test/credential-desk.test.ts` (extend)

- [ ] **Step 1: Failing test — scoped Issuer issues; cannot cross use cases**

Add:
```ts
describe("scoped desk issuance", () => {
  it("a credential-use-case Issuer issues its credentials but not another use case's", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await createCredUC(app, admin, "uc-a");
    await createCredUC(app, admin, "uc-b");
    // onboard an Issuer scoped to uc-a
    const on = await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: "iss@a.dev", password: "iss12345", role: "Issuer", useCaseKey: "uc-a" } });
    await app.inject({ method: "POST", url: `${V1}/proposals/${on.json().proposal.id}/approve`, headers: auth(admin2) });
    const iss = await loginAs(app, "iss@a.dev", "iss12345");
    // a holder to issue to
    const holders = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/uc-a/eligible-holders`, headers: auth(iss) });
    expect(holders.statusCode).toBe(200);
    const subject = holders.json()[0];
    const ok = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/uc-a/credentials`, headers: auth(iss), payload: { credentialType: "T", [subject.kind === "org" ? "subjectOrgId" : "subjectUserId"]: subject.id, claims: { a: "x" } } });
    expect(ok.statusCode).toBe(202);
    // cannot issue for uc-b
    const bad = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/uc-b/credentials`, headers: auth(iss), payload: { credentialType: "T", subjectUserId: subject.id, claims: { a: "x" } } });
    expect([403, 404]).toContain(bad.statusCode);
  });
});
```
Run → FAIL (scoped Issuer currently rejected by `issuerBindingAllows`).

- [ ] **Step 2: Widen the operator gate**

In `POST /credential-use-cases/:key/credentials` the current permission check resolves `issuerOrg` from the binding and calls `issuerBindingAllows(def.issuer, { callerOrgId: claims.orgId, isPlatformAdmin: claims.role === "PlatformAdmin" })`. Replace the boolean with an OR that also admits a scoped desk operator:
```ts
const scopedOperator = (claims.role === "UseCaseAdmin" || claims.role === "Issuer") && claims.useCaseKey === key;
const permitted = scopedOperator || issuerBindingAllows(def.issuer, { callerOrgId: claims.orgId, isPlatformAdmin: claims.role === "PlatformAdmin" });
if (!permitted) return reply.code(403).send({ error: "ISSUER_NOT_PERMITTED", message: "not permitted to issue for this use case" });
```
The `issuerOrg` used to build the proposal (`orgId: issuerOrg.id`, the signing DID) is still the **bound** issuer org — unchanged. For a `{kind:"platform"}` binding the platform issuer org is used as today.

- [ ] **Step 3: eligible-holders + revoke gates**

`GET /credential-use-cases/:key/eligible-holders`: allow any desk role scoped to the use case (`claims.useCaseKey === key`) in addition to the current allowed callers.
Credential revoke (`POST /credentials/:id/revoke`): the credential row carries its `credentialUseCaseKey` (from the issue payload) — admit a scoped `UseCaseAdmin`/`Issuer` whose `useCaseKey` matches, alongside the existing org/platform path.

- [ ] **Step 4: Run + commit** — api suite green → `git commit -m "feat(api): admit scoped desk users to credential issue/revoke/holders"`.

---

## Task F5: API — verification scoped-Verifier path

**Files:**
- Modify: `apps/api/src/http/routes.ts` (verification request/verify routes, VP-*)
- Test: `apps/api/test/credential-desk.test.ts` (extend)

- [ ] **Step 1: Failing test — scoped Verifier runs a verification for the use case**

Add a test that: creates a credential use case, onboards a `Verifier` scoped to it, issues+approves a credential to a holder, then the Verifier creates a verification request for that use case's credential type and it is accepted (status 200/201/202 per the current request contract). Assert an unscoped `Verifier` for a *different* use case is rejected (403/404). (Model the request/verify calls on `apps/api/test/verification*.test.ts` — reuse its request→consent→verify shape.)

Run → FAIL.

- [ ] **Step 2: Admit the scoped Verifier**

In the verification **request** route (currently gated to a verifier org via `verifierBindingAllows`/verifier-org check), add: a caller with `role === "Verifier"` and `claims.useCaseKey === <the request's target credential use case key>` may create the request, scoped to that use case's credential types. Thread the use-case key on the request payload (add a `credentialUseCaseKey` field to the request body/schema if not already present) so the verify step can bind the accepted credential types to the use case. The consent + verify machinery is otherwise unchanged.

- [ ] **Step 3: Run + commit** — api suite green → `git commit -m "feat(api): scoped Verifier user path in verification flow"`.

---

## Task F6: Web — roles, rbac, domains, client types

**Files:**
- Modify: `apps/web/src/types.ts` (Role union; `me`/AuthUser `useCaseDomain`)
- Modify: `apps/web/src/rbac.ts` (MATRIX + domain-aware `assignableRoles`)
- Modify: `apps/web/src/domains.ts` (nav ids for the credential desk)
- Modify: `apps/web/src/api.ts` (me returns `useCaseDomain`)

- [ ] **Step 1: types** — add `"Holder"`/`"Verifier"` to the web `Role` union; add `useCaseDomain?: "tokenization" | "identity" | null` to the `me`/auth user type.

- [ ] **Step 2: rbac** — add `Holder`/`Verifier` to `MATRIX` (mirror core: `Holder: ["read","buy"]`, `Verifier: ["read"]`); make `assignableRoles` domain-aware, mirroring core exactly (note the web copy currently returns `["UseCaseAdmin"]` for PlatformAdmin — preserve that a PlatformAdmin/OrgAdmin can pick UseCaseAdmin):
```ts
export function assignableRoles(role: Role, domain: "tokenization" | "identity" = "tokenization"): Role[] {
  const adminRoster: Role[] = domain === "identity" ? ["Issuer", "Holder", "Verifier"] : ["Issuer", "Trader", "Buyer", "Auditor"];
  const ucaRoster: Role[] = domain === "identity" ? ["Issuer", "Holder", "Verifier"] : ["Issuer", "Buyer", "Auditor"];
  if (role === "PlatformAdmin" || role === "OrgAdmin") return ["UseCaseAdmin", ...adminRoster];
  if (role === "UseCaseAdmin") return ucaRoster;
  return [];
}
```
(The current web `assignableRoles("PlatformAdmin")` returns only `["UseCaseAdmin"]`; this widens it to the full picker, which is fine since the server re-checks. Confirm no web caller depends on the old narrow list.)

- [ ] **Step 3: domains** — add credential-desk nav ids to `NAV_DOMAIN` as `"identity"`: `"issue-credentials": "identity"`, and reuse existing `"verify"`, `"credentials"` (already identity/shared). Ensure `credentials` (My Credentials) stays `"shared"`.

- [ ] **Step 4: api.ts** — `me` already returns the raw object; extend its return type to include `useCaseDomain`. No URL change.

- [ ] **Step 5: typecheck + commit** — `pnpm -s --filter @tokenlayer/web typecheck` → clean → `git commit -m "feat(web): Holder/Verifier roles, domain-aware assignableRoles, me.useCaseDomain"`.

---

## Task F7: Web — operator console identity desk + domain-aware Add-User

**Files:**
- Modify: `apps/web/src/App.tsx` (operator/non-platform branch)
- Modify: `apps/web/src/components/UserManagement.tsx`
- (Reuse: `IssueUsecaseCredential`, `VerificationRequests`, `MyIdentity`, `ApprovalsPanel`)

- [ ] **Step 1: App.tsx — render the identity desk for a credential-scoped user**

In the operator console branch (App.tsx:149-216), compute the desk user's effective domain from `user.useCaseDomain` (now on the auth user). When it is `"identity"`, build the identity nav instead of the tokenization nav:
```ts
const deskDomain = user.useCaseDomain ?? "tokenization";
```
When `deskDomain === "identity"`, `items` becomes (role-filtered):
```ts
const items: NavItem[] = [
  ...(can(user.role, "issue") ? [{ id: "issue-credentials", label: "Issue Credentials", icon: "shield" as const }] : []),
  ...(user.role === "Verifier" || user.role === "UseCaseAdmin" ? [{ id: "verify", label: "Verification", icon: "shield" as const }] : []),
  { id: "approvals", label: "Approvals", icon: "check" },
  ...(canManageUsers(user.role) ? [{ id: "users", label: "User Management", icon: "users" as const }] : []),
  ...pinned,
];
```
Panels: `issue-credentials` → a small wrapper that loads the desk's own credential use case (`api.credentialUseCase(token, user.useCaseKey)`) and renders `<IssueUsecaseCredential useCase={uc} onIssued={...} />` plus an issued-credentials list; `verify` → `<VerificationRequests />`; `approvals` → `<ApprovalsPanel />`; `users` → `<UserManagement useCaseKey={user.useCaseKey} .../>`; `credentials` → `<MyIdentity />`. Keep the existing tokenization branch untouched for `deskDomain === "tokenization"`.

- [ ] **Step 2: UserManagement — domain-aware roles + credential use-case picker**

Replace the static `ROLE_OPTIONS` with `assignableRoles(user.role, pickedDomain)` where `pickedDomain` is derived from the selected use case. Pass both tokenization `useCases` and credential use cases into the picker (fetch credential use cases via `api.credentialUseCases(token)`), labeling each option with its domain. When the manager is a `UseCaseAdmin`, lock the picker to their own use case (as today) and derive its domain from `user.useCaseDomain`.

- [ ] **Step 3: typecheck + commit** — `pnpm -s --filter @tokenlayer/web typecheck` → clean → `git commit -m "feat(web): identity-domain operator desk + domain-aware Add-User"`.

---

## Task F8: Verify — full suites, live walkthrough, finish branch

- [ ] **Step 1** — `pnpm -s typecheck` across all packages; `pnpm -s --filter @tokenlayer/core test`; `pnpm -s --filter @tokenlayer/api test`; `pnpm -s --filter @tokenlayer/web build`. All green.

- [ ] **Step 2: Live walkthrough** (fast-boot: throwaway DB, `CHAIN_STRICT=0`, no chain env — see the ID-E recipe): as PlatformAdmin create a credential use case; onboard a `UseCaseAdmin` scoped to it (maker-checker); log in as that desk → confirm the Identity nav (Issue Credentials / Verification / Approvals / User Management); onboard an `Issuer` and a `Holder` under it; the Issuer issues a credential (type-correct claims); approve it; log in as the Holder → the credential shows under My Credentials. Capture screenshots.

- [ ] **Step 3: Final review** — dispatch a whole-implementation code review (spec compliance + quality); fix findings.

- [ ] **Step 4: Finish** — use `superpowers:finishing-a-development-branch` (merge `feat/credential-usecase-desk-users` to main per the user's choice).

---

## Notes / risks

- **`assignableRoles` arity change** touches core + web + any caller; F1 Step 7 and F6 must reconcile existing tests/callers.
- **Verification scoped path (F5)** is the largest new surface; if the `VerificationRequest` model has no place for a `credentialUseCaseKey`, add it to the payload (not necessarily a schema column) so verify can bind the accepted types. Keep the verifier-org path byte-for-byte unchanged.
- **Domain resolution** does two small `list()` calls in `/me` and onboarding — acceptable; if hot, memoize per request.
- Every gate keeps the **VC signed by the bound issuer DID** — the scoped user is only the operator.
