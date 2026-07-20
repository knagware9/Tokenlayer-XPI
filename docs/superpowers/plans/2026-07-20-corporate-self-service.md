# Corporate Self-Service Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A corporate registers itself from a public homepage, a PlatformAdmin approves it (establishing its on-chain DID + the admin's membership VC + login), and the corporate then configures its own use cases under a PlatformAdmin approval gate — then tokenizes.

**Architecture:** Three subsystems on existing machinery: public web routes + `POST /orgs/register` (pending org, DID minted but NOT on-chain, pending OrgAdmin with no login); a direct PlatformAdmin org-approval queue that reuses the existing `mintMembership` + on-chain `registerDid`; and a `create-use-case` proposal kind on the maker-checker registry. No nullability migration — a pending org holds a DID that is simply not registered on-chain (verifier trust keys off the registry) until approval.

**Tech Stack:** Fastify + Prisma/SQLite (apps/api), vitest, React+Vite SPA (apps/web), existing keystore + on-chain registry adapters + proposal-kind registry.

**Spec:** `docs/superpowers/specs/2026-07-20-corporate-self-service-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `apps/api/src/persistence/types.ts` (modify) | `OrgStatus` gains `pending`/`rejected` |
| `apps/api/src/http/routes.ts` (modify) | `POST /orgs/register` (public), `GET /orgs?status`, `POST /orgs/:id/approve`+`/reject`, `POST /use-cases` OrgAdmin branch |
| `apps/api/src/http/schemas.ts` (modify) | registerOrg, listOrgs status, approveOrg, rejectOrg schemas |
| `apps/api/src/usecase-kinds.ts` (create) | `create-use-case` proposal kind |
| `apps/api/src/proposal-kinds.ts` (modify) | register the kind |
| `apps/api/test/corporate.test.ts` (create) | the behavioural suite |
| `apps/web/src/api.ts`, `types.ts` (modify) | registerOrg/pendingOrgs/approveOrg/rejectOrg; createUseCase → 202 |
| `apps/web/src/components/Home.tsx` (create) | public marketing homepage |
| `apps/web/src/components/Signup.tsx` (create) | public corporate signup |
| `apps/web/src/App.tsx` (modify) | public routing (Home/Signup vs app) |
| `apps/web/src/components/Login.tsx` (modify) | "Register your company" link |
| `apps/web/src/components/Organizations.tsx` (modify) | pending-orgs approval queue |
| `apps/web/src/components/UseCaseBuilder.tsx` (modify) | handle 202 proposal for OrgAdmin |
| `apps/web/src/components/ApprovalsPanel.tsx` (modify) | create-use-case summary |
| `scripts/corporate-e2e.mjs` (create) | live Besu E2E |

Conventions (verified in the codebase):
- Org DID mint idiom: `const seed = deps.keystore.newSeed(); const enc = deps.keystore.encryptSeed(seed); const did = deps.keystore.keyOf(enc).did;`
- On-chain register: `await deps.registry?.anchor.registerDid(deps.registry.didRegistry, did)` (optional; wrap in try/catch → 502 like `POST /orgs`).
- `mintMembership(org, user, role)` is a nested function in the routes closure (routes.ts:1264) — the approval route is in the same closure and calls it directly; it sets the user's sub-DID + issues the OrganizationMembership VC.
- Org repo: `create(Omit<OrganizationRecord,"id"|"createdAt">)`, `setStatus(id, status)`, `setVerified(id, verified, verifiedAt)`, `findByName`, `findByRegistrationId`, `get`, `list`.
- Login already refuses `!user.active` (401 ACCOUNT_SUSPENDED) — pending admins can't log in without extra work.
- Proposal create: `deps.proposals.create({ useCaseKey, orgId, assetId, kind, payload, proposerId, proposerLabel, required })` → `202 { proposal }`.
- Use-case deploy: `deployUseCaseContracts(def, availableChainIdsSet, (d,chainId)=>deps.engine.deployUseCaseContract(d,chainId), log)` then `deps.useCases.create({ ...def, contracts })`.
- Login throttle helper `loginThrottled(request.ip)` exists (routes.ts:117) — reuse for the register endpoint.

---

### Task 1: Persistence — OrgStatus gains `pending` and `rejected`

**Files:**
- Modify: `apps/api/src/persistence/types.ts:322`
- Test: covered by Task 2/3 behavioural tests (this is a type-only widening); still run the suite.

- [ ] **Step 1: Widen the type.** In `apps/api/src/persistence/types.ts` change:

```ts
export type OrgStatus = "pending" | "active" | "suspended" | "rejected";
```

- [ ] **Step 2: Prisma column.** Open `apps/api/prisma/schema.prisma`, find the `Organization` model's `status` field. It's a `String` (SQLite has no enums) with a default — confirm the default is `"active"` for the existing direct-create path and leave it. No migration column change is needed (String already stores the new values). Run `pnpm --filter @tokenlayer/api exec prisma generate` if the schema has any doc-comment change; otherwise nothing to generate.

- [ ] **Step 3: Grep for exhaustiveness.** `grep -rn "OrgStatus\|status ===" apps/api/src apps/web/src | grep -i org` — confirm no `switch`/exhaustive check breaks on the new members. The web `Organizations.tsx` renders status as a Pill tone; verify it has a default tone (it maps `verified`/`active`; add `pending`→"warn", `rejected`→"danger" in Task 7). No code change here beyond the type.

- [ ] **Step 4: Typecheck.** `pnpm --filter @tokenlayer/api exec tsc --noEmit` → clean.

- [ ] **Step 5: Commit** — `git commit -am "feat(api): OrgStatus gains pending + rejected"`

---

### Task 2: API — public `POST /orgs/register`

**Files:**
- Modify: `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/corporate.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `apps/api/test/corporate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTestApp, V1 } from "./helpers.js";

const registerBody = {
  company: { name: "Globex Trade Pvt Ltd", orgType: "corporate", registrationId: "U12345", jurisdiction: "IN" },
  admin: { name: "Rhea Kapoor", email: "rhea@globex.dev", password: "corp-secret-1" },
};

describe("corporate self-registration", () => {
  it("creates a pending org (DID minted, not on-chain) + a pending admin who cannot log in", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
    const orgId = res.json().organizationId;
    expect(typeof orgId).toBe("string");
    // The pending admin cannot authenticate yet.
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } });
    expect(login.statusCode).toBe(401);
  });
  it("rejects a verifier orgType and duplicate name/registration/email", async () => {
    const app = await buildTestApp();
    const verifier = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, company: { ...registerBody.company, orgType: "verifier" } } });
    expect(verifier.statusCode).toBe(400);
    await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody });
    const dupName = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, admin: { ...registerBody.admin, email: "other@x.dev" } } });
    expect(dupName.statusCode).toBe(409);
    const dupEmail = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, company: { ...registerBody.company, name: "Different Co", registrationId: "U999" } } });
    expect(dupEmail.statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run → FAIL** (route 404). `pnpm --filter @tokenlayer/api exec vitest run test/corporate.test.ts`

- [ ] **Step 3: Add the schema** in `apps/api/src/http/schemas.ts` (place near `createOrg`):

```ts
registerOrg: {
  tags: ["Organizations"], summary: "Public corporate self-registration (pending platform approval)",
  body: {
    type: "object", additionalProperties: false, required: ["company", "admin"],
    properties: {
      company: {
        type: "object", additionalProperties: false, required: ["name", "orgType"],
        properties: {
          name: { type: "string", minLength: 1 },
          orgType: { type: "string", enum: ["bank", "corporate", "msme", "government"] },
          registrationId: { type: "string" },
          jurisdiction: { type: "string" },
        },
      },
      admin: {
        type: "object", additionalProperties: false, required: ["name", "email", "password"],
        properties: { name: { type: "string", minLength: 1 }, email: { type: "string" }, password: { type: "string", minLength: 8 } },
      },
    },
  },
  response: { 202: { type: "object", additionalProperties: true }, ...errs(400, 409, 429) },
},
```

(The `enum` already excludes `verifier`, so a `verifier` body 400s at schema validation — the test's 400 expectation holds.)

- [ ] **Step 4: Add the route** in `apps/api/src/http/routes.ts` (NO `...auth` — it's public; place it right before `app.post("/orgs", ...)`):

```ts
app.post("/orgs/register", { schema: S.registerOrg }, async (request, reply) => {
  if (loginThrottled(request.ip)) return reply.code(429).send({ error: "TOO_MANY_REQUESTS", message: "too many attempts; try again later" });
  if (!deps.didMasterConfigured && deps.isProduction) return reply.code(503).send({ error: "DID_KEYSTORE_UNCONFIGURED", message: "DID_MASTER_KEY must be set" });
  const b = request.body as { company: { name: string; orgType: "bank" | "corporate" | "msme" | "government"; registrationId?: string; jurisdiction?: string }; admin: { name: string; email: string; password: string } };
  if (await deps.organizations.findByName(b.company.name)) return reply.code(409).send({ error: "NAME_TAKEN", message: "an organization with that name already exists" });
  if (b.company.registrationId && (await deps.organizations.findByRegistrationId(b.company.registrationId))) return reply.code(409).send({ error: "REGISTRATION_TAKEN", message: "an organization with that registration id already exists" });
  if (await deps.users.findByEmail(b.admin.email)) return reply.code(409).send({ error: "EMAIL_TAKEN", message: "email already registered" });

  // Mint the org DID now, but DO NOT register it on-chain and DO NOT activate —
  // a pending org's DID is trusted nowhere (verifier trust keys off the registry).
  const seed = deps.keystore.newSeed();
  const didSeedEncrypted = deps.keystore.encryptSeed(seed);
  const did = deps.keystore.keyOf(didSeedEncrypted).did;
  const org = await deps.organizations.create({
    name: b.company.name, orgType: b.company.orgType, registrationId: b.company.registrationId ?? null,
    jurisdiction: b.company.jurisdiction ?? null, did, didSeedEncrypted,
    status: "pending", verified: false, verifiedAt: null,
  });
  // The OrgAdmin exists but cannot log in (active:false) and has no sub-DID yet.
  await deps.users.create({
    email: b.admin.email, passwordHash: await bcrypt.hash(b.admin.password, BCRYPT_ROUNDS),
    role: "OrgAdmin", useCaseKey: null, accountId: null, active: false,
    kycStatus: "pending", kyc: { legalName: b.admin.name }, orgId: org.id,
  });
  await deps.audit.append({ actorId: "self-registration", action: "org-registered" as LifecycleAction, payload: { orgId: org.id, name: org.name } });
  return reply.code(202).send({ organizationId: org.id, status: org.status });
});
```

Confirm `bcrypt`, `BCRYPT_ROUNDS`, `loginThrottled`, `LifecycleAction` are already imported/in scope in routes.ts (they are — used by adjacent routes).

- [ ] **Step 5: Run the test → PASS**, then the full api suite → green. `pnpm --filter @tokenlayer/api test`

- [ ] **Step 6: Commit** — `git commit -am "feat(api): public POST /orgs/register — pending org + pending OrgAdmin"`

---

### Task 3: API — org approval queue (approve / reject)

**Files:**
- Modify: `apps/api/src/http/routes.ts` (extend `GET /orgs`; add approve/reject), `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/corporate.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `corporate.test.ts`:

```ts
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";
import { loginAs } from "./helpers.js";

async function registerAndId(app: import("fastify").FastifyInstance) {
  const res = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody });
  return res.json().organizationId as string;
}

describe("org approval", () => {
  it("approve → org active+verified, DID on-chain, admin gets a membership VC + can log in", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgId = await registerAndId(app);
    const appr = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.statusCode).toBe(200);
    expect(appr.json().status).toBe("active");
    expect(appr.json().verified).toBe(true);
    // The org DID is now registered on-chain (in the fake).
    const orgDid = appr.json().did;
    expect((await anchor.didRegistration("0xdid", orgDid)).registered).toBe(true);
    // The admin can now log in and holds an OrganizationMembership VC.
    const adminTok = (await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } })).json().token;
    expect(typeof adminTok).toBe("string");
    const creds = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: { authorization: `Bearer ${adminTok}` } })).json();
    expect(creds.some((c: { type: string }) => c.type === "OrganizationMembership")).toBe(true);
  });
  it("chain-first: a registerDid failure leaves the org pending and the admin locked out", async () => {
    const anchor = new FakeAnchor(); anchor.failNext = "registerDid";
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgId = await registerAndId(app);
    const appr = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.statusCode).toBe(502);
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } });
    expect(login.statusCode).toBe(401);
  });
  it("reject → org rejected, admin still cannot log in", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgId = await registerAndId(app);
    const rej = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/reject`, headers: { authorization: `Bearer ${platform}` }, payload: { reason: "incomplete" } });
    expect(rej.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } });
    expect(login.statusCode).toBe(401);
  });
  it("GET /orgs?status=pending lists only pending orgs", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await registerAndId(app);
    const list = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json();
    expect(list.every((o: { status: string }) => o.status === "pending")).toBe(true);
    expect(list.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run → FAIL** (approve/reject 404, status filter ignored).

- [ ] **Step 3: Extend `GET /orgs`** in routes.ts — add a status filter to the PlatformAdmin branch. Change the PlatformAdmin line to:

```ts
if (claims.role === "PlatformAdmin") {
  const status = (request.query as { status?: string }).status;
  rows = (await deps.organizations.list()).filter((o) => !status || o.status === status);
}
```

And add `status` to the `listOrgs` schema's querystring:
```ts
querystring: { type: "object", properties: { status: { type: "string" } } },
```
(Add the `querystring` key to the existing `S.listOrgs` object if absent.)

- [ ] **Step 4: Add approve/reject schemas** in schemas.ts:

```ts
approveOrg: {
  tags: ["Organizations"], summary: "Approve a pending org (registers its DID on-chain, activates the admin)", security: bearer,
  params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  body: { type: "object", additionalProperties: false, properties: {} },
  response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404, 409, 502) },
},
rejectOrg: {
  tags: ["Organizations"], summary: "Reject a pending org", security: bearer,
  params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  body: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", minLength: 1 } } },
  response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404, 409) },
},
```

- [ ] **Step 5: Add the routes** in routes.ts, right after `POST /orgs`:

```ts
app.post("/orgs/:id/approve", { schema: S.approveOrg, ...auth }, async (request, reply) => {
  const claims = request.user as TokenClaims;
  if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may approve organizations" });
  const { id } = request.params as { id: string };
  const org = await deps.organizations.get(id);
  if (!org) return notFound(reply, "organization not found");
  if (org.status !== "pending") return reply.code(409).send({ error: "NOT_PENDING", message: `organization is ${org.status}` });
  // Chain FIRST: register the DID before activating anything, so a chain failure
  // leaves the org pending (and the admin locked out) with nothing to roll back.
  if (deps.registry) {
    try {
      await deps.registry.anchor.registerDid(deps.registry.didRegistry, org.did);
    } catch (err) {
      request.log.error({ err }, "org DID registration failed");
      return reply.code(502).send({ error: "REGISTRY_UNAVAILABLE", message: "could not register the organization's DID on-chain — nothing was changed" });
    }
  }
  const active = await deps.organizations.setStatus(org.id, "active");
  await deps.organizations.setVerified(org.id, true, new Date().toISOString());
  // Activate the pending OrgAdmin: mint its sub-DID + membership VC, then flip active.
  const admin = (await deps.users.list(NO_USE_CASE)).find((u) => u.orgId === org.id && u.role === "OrgAdmin")
    ?? (await deps.users.list()).find((u) => u.orgId === org.id && u.role === "OrgAdmin");
  if (admin) {
    try {
      await mintMembership(active, admin, "OrgAdmin");
      await deps.users.update(admin.id, { active: true });
    } catch (err) {
      // Roll the org back to pending — never a half-approved org.
      await deps.organizations.setStatus(org.id, "pending");
      await deps.organizations.setVerified(org.id, false, null);
      request.log.error({ err }, "org admin activation failed");
      return reply.code(502).send({ error: "ADMIN_ACTIVATION_FAILED", message: "could not activate the organization admin — reverted to pending" });
    }
  }
  await deps.audit.append({ actorId: claims.id, action: "org-approved" as LifecycleAction, payload: { orgId: org.id, did: org.did } });
  return reply.code(200).send({ id: active.id, name: active.name, did: active.did, orgType: active.orgType, status: "active", verified: true });
});

app.post("/orgs/:id/reject", { schema: S.rejectOrg, ...auth }, async (request, reply) => {
  const claims = request.user as TokenClaims;
  if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may reject organizations" });
  const { id } = request.params as { id: string };
  const { reason } = request.body as { reason: string };
  const org = await deps.organizations.get(id);
  if (!org) return notFound(reply, "organization not found");
  if (org.status !== "pending") return reply.code(409).send({ error: "NOT_PENDING", message: `organization is ${org.status}` });
  const rejected = await deps.organizations.setStatus(org.id, "rejected");
  await deps.audit.append({ actorId: claims.id, action: "org-rejected" as LifecycleAction, payload: { orgId: org.id, reason } });
  return reply.code(200).send({ id: rejected.id, status: "rejected" });
});
```

Confirm `NO_USE_CASE`, `notFound`, `mintMembership` are in scope (they are — `NO_USE_CASE` is the sentinel used by `GET /users`; `mintMembership` is the nested closure fn defined earlier in the same `registerRoutes`). If `deps.users.list(scope)` filters by useCaseKey and the OrgAdmin has `useCaseKey:null`, the fallback `(await deps.users.list())` full scan finds it — keep both.

- [ ] **Step 6: Run the tests → PASS**, full api suite → green.

- [ ] **Step 7: Commit** — `git commit -am "feat(api): platform-admin org approval queue — approve (DID on-chain + admin VC) / reject"`

---

### Task 4: API — `create-use-case` proposal kind + OrgAdmin propose branch

**Files:**
- Create: `apps/api/src/usecase-kinds.ts`
- Modify: `apps/api/src/proposal-kinds.ts` (register), `apps/api/src/http/routes.ts` (POST /use-cases branch)
- Test: `apps/api/test/corporate.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append:

```ts
describe("gated use-case config", () => {
  async function activeOrgAdmin(app: import("fastify").FastifyInstance) {
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgId = (await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody })).json().organizationId;
    await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    const adminTok = (await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } })).json().token;
    return { platform, adminTok, orgId };
  }
  const def = { key: "globex-notes", name: "Globex Notes", symbol: "GXN", tokenStandard: "ERC-20", allowedChainIds: ["fabric"], defaultChainId: "fabric", compliance: { allowlist: true } };

  it("an OrgAdmin proposes a use case (202) and a PlatformAdmin approval creates+deploys it, org-owned", async () => {
    const app = await buildTestApp();
    const { platform, adminTok, orgId } = await activeOrgAdmin(app);
    const prop = await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: { authorization: `Bearer ${adminTok}` }, payload: def });
    expect(prop.statusCode).toBe(202);
    expect(prop.json().proposal.kind).toBe("create-use-case");
    const pid = prop.json().proposal.id;
    // The OrgAdmin cannot self-approve (SoD).
    const self = await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: { authorization: `Bearer ${adminTok}` }, payload: {} });
    expect(self.statusCode).toBe(403);
    // A platform admin approves → the use case exists, owned by the org, deployed.
    const appr = await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.json().proposal.status).toBe("executed");
    const uc = (await app.inject({ method: "GET", url: `${V1}/use-cases`, headers: { authorization: `Bearer ${platform}` } })).json().find((u: { key: string }) => u.key === "globex-notes");
    expect(uc.ownerOrgId).toBe(orgId);
    expect(Object.keys(uc.contracts).length).toBeGreaterThan(0);
  });
  it("a PlatformAdmin creating a use case still deploys directly (201, unchanged)", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: { authorization: `Bearer ${platform}` }, payload: { ...def, key: "pa-direct" } });
    expect(res.statusCode).toBe(201);
  });
});
```

- [ ] **Step 2: Run → FAIL** (OrgAdmin gets 403 today; kind unknown).

- [ ] **Step 3: Create `apps/api/src/usecase-kinds.ts`:**

```ts
/**
 * The create-use-case proposal kind: an OrgAdmin configures a use case; a
 * PlatformAdmin approves; on approval the use case is created (owned by the org)
 * and its contract deployed on every available allowed chain. Org-scoped.
 */
import type { UseCaseDefinition } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { coded } from "./executors.js";
import type { TokenClaims } from "./http/support.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "./persistence/types.js";
import { deployUseCaseContracts } from "./use-cases.js";

const orgScopedView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  claims.role === "PlatformAdmin" || (claims.role === "OrgAdmin" && !!p.orgId && claims.orgId === p.orgId);

export const createUseCaseKind: ProposalKindHandler = {
  kind: "create-use-case",
  canView: orgScopedView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const def = p.payload as unknown as UseCaseDefinition;
    if (await ctx.deps.useCases.has(def.key)) throw coded(409, "USECASE_EXISTS", `use case '${def.key}' already exists`);
    const available = new Set(ctx.deps.chains.list().map((c) => c.id));
    const contracts = await deployUseCaseContracts(def, available, (d, chainId) => ctx.deps.engine.deployUseCaseContract(d, chainId), (m) => ctx.log.error({ m }, m));
    if (Object.keys(contracts).length === 0) throw coded(400, "NO_DEPLOYABLE_CHAIN", `no allowed chain available to deploy '${def.key}'`);
    await ctx.deps.useCases.create({ ...def, contracts });
  },
};
```

(Confirm `deps.useCases.has(key)` exists — the `UseCaseRepository` has `has`/`get`/`create`; if the method is named differently, use the real one. `deployUseCaseContracts` is exported from `apps/api/src/use-cases.ts`.)

- [ ] **Step 4: Register the kind** — bottom of `apps/api/src/proposal-kinds.ts`, with the others:

```ts
import { createUseCaseKind } from "./usecase-kinds.js";
// ...
registerProposalKind(createUseCaseKind);
```

- [ ] **Step 5: Add the OrgAdmin branch to `POST /use-cases`.** Replace the guard at the top of the handler:

```ts
app.post("/use-cases", { schema: S.createUseCase, ...auth }, async (request, reply) => {
  const claims = request.user as TokenClaims;
  if (claims.role !== "PlatformAdmin" && !(claims.role === "OrgAdmin" && claims.orgId)) {
    return reply.code(403).send({ error: "FORBIDDEN", message: "only a Platform Admin or an Org Admin may create use cases" });
  }
  let definition: UseCaseDefinition;
  try {
    definition = normalizeUseCaseDefinition(request.body as UseCaseDefinition);
  } catch (err) {
    if (err instanceof PolicyError) return reply.code(400).send({ error: err.code, message: err.message });
    throw err;
  }
  if (await deps.useCases.has(definition.key)) return reply.code(409).send({ error: "USECASE_EXISTS", message: `use case '${definition.key}' already exists` });

  // OrgAdmin → maker-checker: stamp org ownership + park a create-use-case proposal.
  if (claims.role === "OrgAdmin") {
    const owned = { ...definition, ownerOrgId: claims.orgId };
    const proposal = await deps.proposals.create({
      useCaseKey: null, orgId: claims.orgId!, assetId: null, kind: "create-use-case",
      payload: owned as unknown as Record<string, unknown>,
      proposerId: claims.id, proposerLabel: claims.email, required: 1,
    });
    return reply.code(202).send({ proposal });
  }

  // PlatformAdmin → direct create + deploy (unchanged).
  const available = new Set(deps.chains.list().map((c) => c.id));
  const contracts = await deployUseCaseContracts(definition, available, (def, chainId) => deps.engine.deployUseCaseContract(def, chainId), (m) => request.log.warn(m));
  if (Object.keys(contracts).length === 0) {
    return reply.code(400).send({ error: "NO_DEPLOYABLE_CHAIN", message: `no allowed chain is available to deploy '${definition.key}'; configure at least one of: ${definition.allowedChainIds.join(", ")}` });
  }
  return reply.code(201).send(await deps.useCases.create({ ...definition, contracts }));
});
```

(`UseCaseDefinition` gained `ownerOrgId?: string` in the org-identity arc — confirm it's an allowed field; the normalizer spreads `...def`, so it round-trips. If `normalizeUseCaseDefinition` strips unknown fields, stamp `ownerOrgId` AFTER normalizing, as shown.)

- [ ] **Step 6: Run the tests → PASS**, full api suite → green, `tsc --noEmit` clean.

- [ ] **Step 7: Commit** — `git commit -am "feat(api): create-use-case proposal kind + OrgAdmin propose branch on POST /use-cases"`

---

### Task 5: Web — public routing + Home + Signup

**Files:**
- Create: `apps/web/src/components/Home.tsx`, `apps/web/src/components/Signup.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/Login.tsx`, `apps/web/src/api.ts`, `apps/web/src/types.ts`

- [ ] **Step 1: api.ts** — add the public register client (no token):

```ts
registerOrg: (body: { company: { name: string; orgType: string; registrationId?: string; jurisdiction?: string }; admin: { name: string; email: string; password: string } }) =>
  request<{ organizationId: string; status: string }>("/orgs/register", undefined, { method: "POST", body: JSON.stringify(body) }),
```

Check `request(path, token?, opts)` — if `token` is required positional, pass `undefined` and confirm it sends no Authorization header when falsy (it already does for `login`). If `login` uses a different unauthenticated helper, mirror that.

- [ ] **Step 2: `Home.tsx`** — a marketing homepage using ui.tsx primitives:

```tsx
import { useRoute } from "../router.js";

export function Home(): JSX.Element {
  const { navigate } = useRoute();
  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50">
      <header className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
        <div className="text-lg font-bold text-slate-900">XI<span className="text-brand-600">Tokenize</span></div>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/login")} className="text-sm font-medium text-slate-600 hover:text-slate-900">Login</button>
          <button onClick={() => navigate("/signup")} className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-semibold hover:bg-brand-700">Register your company</button>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 pt-16 pb-24 text-center">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-slate-900">Tokenize real-world assets, on any ledger.</h1>
        <p className="mt-5 text-lg text-slate-600 max-w-2xl mx-auto">A chain-agnostic platform for enterprises to issue, verify, and trade tokenized assets — with on-chain identity, verifiable credentials, and maker-checker governance built in.</p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <button onClick={() => navigate("/signup")} className="rounded-lg bg-brand-600 text-white px-6 py-3 text-sm font-semibold hover:bg-brand-700">Register your company</button>
          <button onClick={() => navigate("/login")} className="rounded-lg border border-slate-200 text-slate-700 px-6 py-3 text-sm font-semibold hover:border-brand-400">Login</button>
        </div>
        <div className="mt-20 grid sm:grid-cols-3 gap-6 text-left">
          {[["Onboard", "Register your company; a platform admin verifies you and issues your organization a decentralized identity (DID) and credentials."], ["Configure", "Design a tokenization use case — asset fields, compliance rules, ledgers — and request approval to go live."], ["Tokenize", "Issue assets to KYC-verified holders, enforce jurisdiction & allowlists, and trade on the built-in marketplace."]].map(([t, d]) => (
            <div key={t} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
              <div className="text-sm font-semibold text-brand-700">{t}</div>
              <p className="mt-2 text-sm text-slate-600">{d}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 3: `Signup.tsx`** — the public corporate registration form:

```tsx
import { useState } from "react";
import { ApiError, api } from "../api.js";
import { useRoute } from "../router.js";

export function Signup(): JSX.Element {
  const { navigate } = useRoute();
  const [f, setF] = useState({ name: "", orgType: "corporate", registrationId: "", jurisdiction: "", adminName: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault(); setError(null);
    if (f.password.length < 8) { setError("Admin password must be at least 8 characters"); return; }
    try {
      await api.registerOrg({ company: { name: f.name, orgType: f.orgType, registrationId: f.registrationId || undefined, jurisdiction: f.jurisdiction || undefined }, admin: { name: f.adminName, email: f.email, password: f.password } });
      setDone(true);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Registration failed"); }
  }
  if (done) return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Registration submitted</h1>
        <p className="text-slate-600">A platform administrator will review your company and activate your account. You'll be able to log in once approved.</p>
        <button onClick={() => navigate("/")} className="rounded-lg bg-brand-600 text-white px-5 py-2.5 text-sm font-semibold hover:bg-brand-700">Back to home</button>
      </div>
    </div>
  );
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-lg bg-white rounded-2xl border border-slate-200/80 shadow-sm p-7 space-y-4">
        <h1 className="text-xl font-bold text-slate-900">Register your company</h1>
        <input className="input w-full" placeholder="Company legal name" value={f.name} onChange={set("name")} required />
        <div className="grid grid-cols-2 gap-3">
          <select className="select" value={f.orgType} onChange={set("orgType")}>
            {["corporate", "bank", "msme", "government"].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="input" placeholder="jurisdiction (e.g. IN)" value={f.jurisdiction} onChange={set("jurisdiction")} />
        </div>
        <input className="input w-full" placeholder="registration id (optional)" value={f.registrationId} onChange={set("registrationId")} />
        <div className="border-t border-slate-100 pt-3 space-y-3">
          <p className="text-xs font-semibold text-slate-500">Administrator account</p>
          <input className="input w-full" placeholder="admin full name" value={f.adminName} onChange={set("adminName")} required />
          <input className="input w-full" type="email" placeholder="admin email" value={f.email} onChange={set("email")} required />
          <input className="input w-full" type="password" placeholder="password (min 8)" value={f.password} onChange={set("password")} required />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => navigate("/")} className="text-sm text-slate-500">← Home</button>
          <button type="submit" className="rounded-lg bg-brand-600 text-white px-5 py-2.5 text-sm font-semibold hover:bg-brand-700">Submit registration</button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: App.tsx public routing.** Replace `if (!token || !user) return <Login />;` with a public-route branch that reads the first path segment (`useRoute().useCaseKey` is the first segment):

```tsx
// near the other hooks:
const { useCaseKey: routeKey, path, navigate } = useRoute();   // add `path`
// ...
if (!token || !user) {
  if (routeKey === "signup") return <Signup />;
  if (routeKey === "login") return <Login />;
  return <Home />;
}
```

Import `Home` and `Signup`. (Keep `Login` reachable at `/login`; the Login component's successful login sets the token and the app re-renders into the shell — verify Login doesn't hard-navigate; if it does, leave it.)

- [ ] **Step 5: Login.tsx** — add a register link under the sign-in button:

```tsx
// after the submit button, inside the form/card:
<p className="text-xs text-slate-500 text-center mt-3">New enterprise? <button type="button" onClick={() => navigate("/signup")} className="text-brand-600 font-medium hover:text-brand-700">Register your company</button></p>
```

Import `useRoute` and pull `navigate` if not already present.

- [ ] **Step 6: Build** — `pnpm --filter @tokenlayer/web build` + `pnpm --filter @tokenlayer/web exec tsc --noEmit` → clean.

- [ ] **Step 7: Commit** — `git commit -am "feat(web): public homepage + corporate signup + routing"`

---

### Task 6: Web — org approval queue (PlatformAdmin) + create-use-case wizard/inbox

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/components/Organizations.tsx`, `apps/web/src/components/UseCaseBuilder.tsx`, `apps/web/src/components/ApprovalsPanel.tsx`

- [ ] **Step 1: api.ts** — add:

```ts
pendingOrgs: (token: string) => request<Organization[]>("/orgs?status=pending", token),
approveOrg: (token: string, id: string) => request<Organization>(`/orgs/${id}/approve`, token, { method: "POST", body: JSON.stringify({}) }),
rejectOrg: (token: string, id: string, reason: string) => request<Organization>(`/orgs/${id}/reject`, token, { method: "POST", body: JSON.stringify({ reason }) }),
```

- [ ] **Step 2: Organizations.tsx — pending approval queue.** At the top of the Organizations component (PlatformAdmin view), fetch and render pending orgs above the existing list:

```tsx
const [pending, setPending] = useState<Organization[]>([]);
const reloadPending = (): void => { if (token && user?.role === "PlatformAdmin") void api.pendingOrgs(token).then(setPending).catch(() => setPending([])); };
useEffect(reloadPending, [token]);
// ...render, above the org list, only when pending.length > 0:
{user?.role === "PlatformAdmin" && pending.length > 0 && (
  <Card>
    <h3 className="text-sm font-semibold text-slate-900 mb-2">Pending corporate registrations</h3>
    {pending.map((o) => (
      <div key={o.id} className="flex items-center justify-between py-2 border-t border-slate-100 text-sm">
        <span>{o.name} <span className="text-slate-400">· {o.orgType}{o.jurisdiction ? ` · ${o.jurisdiction}` : ""}</span></span>
        <span className="space-x-3">
          <button onClick={() => void api.approveOrg(token!, o.id).then(() => { reloadPending(); reload(); })} className="text-xs text-emerald-600 hover:text-emerald-700 font-medium">Approve</button>
          <button onClick={() => { const r = window.prompt("Reason for rejecting?")?.trim(); if (r) void api.rejectOrg(token!, o.id, r).then(reloadPending); }} className="text-xs text-red-500 hover:text-red-700">Reject</button>
        </span>
      </div>
    ))}
  </Card>
)}
```

(Reuse the existing `reload`/list refresh in Organizations.tsx; add `pending`→"warn"/`rejected`→"danger" to the status Pill tone mapping if it renders status.)

- [ ] **Step 3: UseCaseBuilder.tsx — handle the 202 proposal.** At line ~340 (`const created = await api.createUseCase(token, def)`), the response is now either a use case (PlatformAdmin, 201) or `{ proposal }` (OrgAdmin, 202). Change `createUseCase`'s client return type to `UseCase | { proposal: Proposal }` and branch:

```ts
const res = await api.createUseCase(token, def);
if ("proposal" in res) { setNotice(`Use case submitted (${res.proposal.id.slice(0, 8)}…) — pending platform approval in Approvals.`); }
else { onCreated(); }
```

Add a `notice` state + render it (mirror the AddUser notice pattern). `Proposal` is imported from `../types.js`.

- [ ] **Step 4: ApprovalsPanel.tsx** — add the summary arm:

```ts
if (p.kind === "create-use-case") return `configure use case ${String(pl.name ?? pl.key ?? "")} (${String(pl.symbol ?? "")})`;
```

- [ ] **Step 5: Build** — `pnpm --filter @tokenlayer/web build` + `tsc --noEmit` clean.

- [ ] **Step 6: Commit** — `git commit -am "feat(web): org approval queue + gated use-case wizard + inbox summary"`

---

### Task 7: Verify — full suite, live Besu E2E, browser, finish

**Files:**
- Create: `scripts/corporate-e2e.mjs`

- [ ] **Step 1: Full suite + builds** — `pnpm -r test && pnpm --filter @tokenlayer/web build` → all green.

- [ ] **Step 2: Write `scripts/corporate-e2e.mjs`** (copy the `call/ok/login` + ethers `didRegistration` eth_call helpers from `scripts/onboarding-e2e.mjs`):
  flow: `POST /orgs/register` (public, no token) → assert 202 pending → platform admin `GET /orgs?status=pending` shows it → `POST /orgs/:id/approve` → **independent `eth_call didRegistration`** on the DidRegistry proves the org DID is registered+active (copy the DidRegistry ABI/selector from `onchain-registry-e2e.mjs`) → the corporate admin logs in → `GET /me/credentials` shows an OrganizationMembership VC → the admin `POST /use-cases` (a small fabric ERC-20 def) → assert 202 → platform admin approves the proposal → `GET /use-cases` shows it owner-scoped + deployed → the admin onboards an Issuer via `POST /orgs/:id/users` and issues one asset. Exit non-zero on any failed check.

- [ ] **Step 3: Run it live** — `make besu-up`, fresh scratch DB, boot the API with the standard live env (`BESU_RPC_URL`, `BESU_OPERATOR_KEY`, `REGISTRY_CHAIN_ID=besu`, `LOGIN_RATE_LIMIT_MAX=1000`, `DID_MASTER_KEY` optional). Then `node scripts/corporate-e2e.mjs` → all checks pass.

- [ ] **Step 4: Browser** (preview per `.claude/launch.json`): as a logged-out visitor see the homepage → **Register your company** → fill + submit → "submitted" screen; log in as PlatformAdmin → Organizations shows the pending registration → **Approve**; log in as the new corporate admin → Create use case → submit → "pending approval" → back as PlatformAdmin → Approvals shows `create-use-case` → **Approve** → the use case appears under Use cases. Screenshot proof.

- [ ] **Step 5: Teardown + finish** — `make besu-down`, remove scratch DBs, then use superpowers:finishing-a-development-branch.

---

## Self-review notes

- **Spec coverage:** §1 public homepage+signup → Task 5; §2 `POST /orgs/register` → Task 2; §3 org approval queue → Task 3; §4 create-use-case kind + OrgAdmin branch → Task 4; web approval queue + wizard → Task 6; OrgStatus widening → Task 1; login-refuses-inactive → already present (noted in Task 2); rate-limit register → Task 2 (`loginThrottled`); tests → Tasks 2-4 + Task 7 live E2E + browser.
- **Type consistency:** `create-use-case` kind name matches route payload (Task 4) + inbox summary (Task 6); `registerOrg`/`approveOrg`/`rejectOrg`/`pendingOrgs` client names (Tasks 5-6) match the routes (Tasks 2-3); `OrgStatus` members used in routes (`pending`/`rejected`) are defined in Task 1; `mintMembership(org,user,role)` call in Task 3 matches its definition.
- **Verify-points flagged inline for the implementer:** `deps.users.list(scope)` filter semantics (Task 3 OrgAdmin lookup uses a full-scan fallback), `UseCaseRepository.has` method name (Task 4), `normalizeUseCaseDefinition` preserving `ownerOrgId` (stamp after normalize — Task 4), and the api client `request(path, token?, opts)` unauthenticated call shape (Task 5).
