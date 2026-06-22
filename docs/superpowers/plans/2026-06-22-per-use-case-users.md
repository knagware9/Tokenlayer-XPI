# Per-Use-Case User Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each use case its own isolated user roster (PlatformAdmin / UseCaseAdmin / Issuer / Trader / Buyer / Auditor), provisioned by a delegated admin, with API-boundary tenancy enforcement and role-specific dashboard views.

**Architecture:** A user carries a single `useCaseKey` (null = global PlatformAdmin) plus an optional wallet `accountId`. The core `LifecycleEngine` is untouched by tenancy — it keeps doing role→action RBAC checks against an expanded matrix. The API layer wraps it with a scope guard that rejects cross-use-case access, and adds a scoped `/users` CRUD. The dashboard routes each role to its own view.

**Tech Stack:** TypeScript monorepo, Fastify + Prisma/SQLite + @fastify/jwt, React + Vite, Vitest, bcryptjs.

**Spec:** `docs/superpowers/specs/2026-06-22-per-use-case-users-design.md`

**Commands (this repo's pnpm trips a pre-run install; use these forms):**
- Core test: `pnpm --filter @tokenlayer/core test`
- API test: `cd apps/api && CI=true ../../node_modules/.bin/vitest run` (or `pnpm --filter @tokenlayer/api test`)
- Typecheck all: `pnpm -r typecheck`
- Run a script: `cd apps/api && ../../node_modules/.bin/tsx src/<file>.ts`

---

## File Structure

**Core (`packages/core/src`)**
- `types.ts` — redefine `Role` union + `ROLES`.
- `rbac.ts` — expanded role→action matrix.
- `user-policy.ts` *(new)* — pure who-can-create-whom + scope helpers.
- `index.ts` — export the new module.

**API (`apps/api/src`)**
- `persistence/types.ts` — `UserRecord` gains `useCaseKey`/`accountId`; `UserRepository` + `AccountRepository` gain lookups/CRUD.
- `persistence/memory.ts`, `persistence/prisma.ts` — implement the above.
- `prisma/schema.prisma` — `User.useCaseKey`, `User.accountId`.
- `http/support.ts` — `TokenClaims.useCaseKey`; `scopedToCaller` guard.
- `http/routes.ts` — login claims; scope guards; `/users` CRUD.
- `http/schemas.ts` — user route schemas; richer login/me response.
- `seed.ts` — Platform Admin + per-use-case rosters.
- `e2e-tenancy.ts` *(new)* — full provisioning story.

**Web (`apps/web/src`)**
- `types.ts` — expand `Role`; `SessionUser` gains `useCaseKey`/`walletAddress`.
- `rbac.ts` — mirror the expanded matrix.
- `api.ts` — `/users` client methods.
- `App.tsx` — role-routed shell.
- `components/Login.tsx` — quick-login grouped by use case.
- `components/Header.tsx` — show use-case name.
- `components/UsersAdmin.tsx` *(new)* — roster table + create form.
- `components/MyHoldings.tsx` *(new)* — buyer holdings.

**Config / docs**
- `config/use-cases/*.json` — `roles` arrays → new role names.
- `README.md` — document roles + provisioning.

---

## Task 1: Expand roles + RBAC matrix (core)

**Files:**
- Modify: `packages/core/src/types.ts:10-12`
- Modify: `packages/core/src/rbac.ts:8-23`
- Test: `packages/core/test/rbac.test.ts`

- [ ] **Step 1: Update the failing test**

Replace the role/matrix expectations in `packages/core/test/rbac.test.ts` (add this block; keep file's existing imports of `RbacPolicy`):

```ts
import { describe, it, expect } from "vitest";
import { RbacPolicy } from "../src/rbac.js";

describe("RbacPolicy (per-use-case roles)", () => {
  const rbac = new RbacPolicy();
  it("PlatformAdmin and UseCaseAdmin can do every lifecycle action", () => {
    for (const role of ["PlatformAdmin", "UseCaseAdmin"] as const) {
      for (const a of ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "read"] as const) {
        expect(rbac.can(role, a)).toBe(true);
      }
    }
  });
  it("Issuer = issuance + KYC/compliance, not trading", () => {
    expect(rbac.can("Issuer", "mint")).toBe(true);
    expect(rbac.can("Issuer", "allow")).toBe(true);
    expect(rbac.can("Issuer", "freeze")).toBe(true);
    expect(rbac.can("Issuer", "transfer")).toBe(false);
    expect(rbac.can("Issuer", "burn")).toBe(false);
  });
  it("Trader = transfer + burn only", () => {
    expect(rbac.can("Trader", "transfer")).toBe(true);
    expect(rbac.can("Trader", "burn")).toBe(true);
    expect(rbac.can("Trader", "mint")).toBe(false);
    expect(rbac.can("Trader", "allow")).toBe(false);
  });
  it("Buyer and Auditor are read-only", () => {
    for (const role of ["Buyer", "Auditor"] as const) {
      expect(rbac.can(role, "read")).toBe(true);
      expect(rbac.can(role, "transfer")).toBe(false);
      expect(rbac.can(role, "mint")).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `pnpm --filter @tokenlayer/core test`
Expected: FAIL — type error / `MATRIX[role]` undefined for the new roles.

- [ ] **Step 3: Redefine the Role union**

In `packages/core/src/types.ts` replace lines 9-12:

```ts
/** Roles recognised by the platform's access-control policy. */
export type Role = "PlatformAdmin" | "UseCaseAdmin" | "Issuer" | "Trader" | "Buyer" | "Auditor";

export const ROLES: readonly Role[] = ["PlatformAdmin", "UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"];
```

- [ ] **Step 4: Expand the matrix**

In `packages/core/src/rbac.ts` replace the `MATRIX` (lines 8-23):

```ts
const FULL: readonly LifecycleAction[] = ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "read"];

const MATRIX: Record<Role, ReadonlySet<LifecycleAction>> = {
  PlatformAdmin: new Set<LifecycleAction>(FULL),
  UseCaseAdmin: new Set<LifecycleAction>(FULL),
  Issuer: new Set<LifecycleAction>(["issue", "mint", "allow", "disallow", "freeze", "unfreeze", "read"]),
  Trader: new Set<LifecycleAction>(["transfer", "burn", "read"]),
  Buyer: new Set<LifecycleAction>(["read"]),
  Auditor: new Set<LifecycleAction>(["read"]),
};
```

- [ ] **Step 5: Run tests; expect pass**

Run: `pnpm --filter @tokenlayer/core test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/rbac.ts packages/core/test/rbac.test.ts
git commit -m "feat(core): expand roles to per-use-case set + new RBAC matrix"
```

---

## Task 2: User-management policy (core)

Pure functions for who-can-create-whom and use-case scope. No I/O.

**Files:**
- Create: `packages/core/src/user-policy.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/user-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/user-policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assignableRoles, canManageUsers, canCreateUser } from "../src/user-policy.js";

describe("user-policy", () => {
  it("PlatformAdmin may only mint UseCaseAdmins, in an explicit use case", () => {
    expect(assignableRoles("PlatformAdmin")).toEqual(["UseCaseAdmin"]);
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "UseCaseAdmin", "carbon-credit")).toBe(true);
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "UseCaseAdmin", null)).toBe(false); // needs a use case
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "Issuer", "carbon-credit")).toBe(false); // not a UseCaseAdmin
  });
  it("UseCaseAdmin may create roster roles only in their own use case", () => {
    expect(assignableRoles("UseCaseAdmin")).toEqual(["Issuer", "Trader", "Buyer", "Auditor"]);
    const admin = { role: "UseCaseAdmin", useCaseKey: "carbon-credit" } as const;
    expect(canCreateUser(admin, "Issuer", "carbon-credit")).toBe(true);
    expect(canCreateUser(admin, "Buyer", "carbon-credit")).toBe(true);
    expect(canCreateUser(admin, "Issuer", "gold-loan")).toBe(false); // cross use case
    expect(canCreateUser(admin, "UseCaseAdmin", "carbon-credit")).toBe(false); // can't escalate
    expect(canCreateUser(admin, "PlatformAdmin", "carbon-credit")).toBe(false);
  });
  it("roster roles cannot manage users at all", () => {
    expect(canManageUsers("Issuer")).toBe(false);
    expect(canManageUsers("Buyer")).toBe(false);
    expect(canManageUsers("PlatformAdmin")).toBe(true);
    expect(canManageUsers("UseCaseAdmin")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `pnpm --filter @tokenlayer/core test`
Expected: FAIL — `Cannot find module '../src/user-policy.js'`.

- [ ] **Step 3: Implement the policy**

Create `packages/core/src/user-policy.ts`:

```ts
import type { Role } from "./types.js";

/** Identity of the user performing a management action. */
export interface ManagerRef {
  role: Role;
  useCaseKey: string | null;
}

/** Roles allowed to provision other users. */
export function canManageUsers(role: Role): boolean {
  return role === "PlatformAdmin" || role === "UseCaseAdmin";
}

/** Which roles a given manager may assign to a new user. */
export function assignableRoles(role: Role): Role[] {
  if (role === "PlatformAdmin") return ["UseCaseAdmin"];
  if (role === "UseCaseAdmin") return ["Issuer", "Trader", "Buyer", "Auditor"];
  return [];
}

/**
 * May `manager` create a user with `targetRole` in `targetUseCaseKey`?
 * - PlatformAdmin: only UseCaseAdmin, and a use case must be named.
 * - UseCaseAdmin: only roster roles, and only in their own use case.
 */
export function canCreateUser(manager: ManagerRef, targetRole: Role, targetUseCaseKey: string | null): boolean {
  if (!assignableRoles(manager.role).includes(targetRole)) return false;
  if (manager.role === "PlatformAdmin") return targetUseCaseKey !== null;
  if (manager.role === "UseCaseAdmin") return targetUseCaseKey !== null && targetUseCaseKey === manager.useCaseKey;
  return false;
}
```

- [ ] **Step 4: Export it**

In `packages/core/src/index.ts` add (next to the other `export *` lines):

```ts
export * from "./user-policy.js";
```

- [ ] **Step 5: Run tests; expect pass**

Run: `pnpm --filter @tokenlayer/core test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/user-policy.ts packages/core/src/index.ts packages/core/test/user-policy.test.ts
git commit -m "feat(core): add user-management policy (who-can-create-whom + scope)"
```

---

## Task 3: User persistence — schema, records, repository interface

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (User model)
- Modify: `apps/api/src/persistence/types.ts`

- [ ] **Step 1: Extend the Prisma User model**

In `apps/api/prisma/schema.prisma` replace the `User` model:

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  role         String
  useCaseKey   String?  // null = global Platform Admin
  accountId    String?  // wallet link for Buyer/Trader
  createdAt    DateTime @default(now())
}
```

- [ ] **Step 2: Push the schema + regenerate client**

```bash
cd apps/api && rm -f prisma/dev.db && ./node_modules/.bin/prisma db push --skip-generate && ./node_modules/.bin/prisma generate
```
Expected: "Your database is now in sync" + "Generated Prisma Client".

- [ ] **Step 3: Extend records + repository interfaces**

In `apps/api/src/persistence/types.ts`:

Replace `UserRecord` (lines 3-9):

```ts
export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  useCaseKey: string | null;
  accountId: string | null;
  createdAt: string;
}
```

Replace `UserRepository` (lines 43-47):

```ts
export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(input: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord>;
  list(useCaseKey?: string): Promise<UserRecord[]>;
  update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId">>): Promise<UserRecord>;
  remove(id: string): Promise<void>;
}
```

Replace `AccountRepository` (lines 78-81) to add a by-id lookup:

```ts
export interface AccountRepository {
  list(): Promise<AccountRecord[]>;
  findById(id: string): Promise<AccountRecord | null>;
  upsert(address: string, label: string): Promise<AccountRecord>;
}
```

- [ ] **Step 4: Typecheck (expect errors in repo impls — fixed next task)**

Run: `pnpm --filter @tokenlayer/api typecheck`
Expected: errors only in `persistence/memory.ts` and `persistence/prisma.ts` (missing methods). That confirms the interface widened.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types.ts
git commit -m "feat(api): add useCaseKey/accountId to User + widen repo interfaces"
```

---

## Task 4: Implement user/account repositories (memory + prisma)

**Files:**
- Modify: `apps/api/src/persistence/memory.ts:22-35` (user), `:110-125` (account)
- Modify: `apps/api/src/persistence/prisma.ts` (`toUser`, `PrismaUserRepository`, `PrismaAccountRepository`)
- Test: `apps/api/test/user-repo.test.ts`

- [ ] **Step 1: Write the failing test (memory repo)**

Create `apps/api/test/user-repo.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MemoryUserRepository, MemoryAccountRepository } from "../src/persistence/memory.js";

describe("MemoryUserRepository", () => {
  it("creates, finds, lists-by-use-case, updates and removes", async () => {
    const repo = new MemoryUserRepository();
    const a = await repo.create({ email: "a@x.dev", passwordHash: "h", role: "Issuer", useCaseKey: "carbon-credit", accountId: null });
    await repo.create({ email: "b@x.dev", passwordHash: "h", role: "Trader", useCaseKey: "gold-loan", accountId: null });
    expect((await repo.findById(a.id))?.email).toBe("a@x.dev");
    expect((await repo.list("carbon-credit")).map((u) => u.email)).toEqual(["a@x.dev"]);
    expect((await repo.list()).length).toBe(2);
    const upd = await repo.update(a.id, { passwordHash: "h2", accountId: "acct_1" });
    expect(upd.passwordHash).toBe("h2");
    expect(upd.accountId).toBe("acct_1");
    await repo.remove(a.id);
    expect(await repo.findById(a.id)).toBeNull();
  });
});

describe("MemoryAccountRepository", () => {
  it("upserts and finds by id", async () => {
    const repo = new MemoryAccountRepository();
    const acct = await repo.upsert("0xabc", "EcoFund");
    expect((await repo.findById(acct.id))?.label).toBe("EcoFund");
    expect(await repo.findById("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/user-repo.test.ts`
Expected: FAIL — methods `findById/update/remove` missing.

- [ ] **Step 3: Implement memory repos**

In `apps/api/src/persistence/memory.ts` replace `MemoryUserRepository` (lines 22-35):

```ts
export class MemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, UserRecord>();
  async findByEmail(email: string): Promise<UserRecord | null> {
    return [...this.byId.values()].find((u) => u.email === email) ?? null;
  }
  async findById(userId: string): Promise<UserRecord | null> {
    return this.byId.get(userId) ?? null;
  }
  async create(input: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord> {
    const rec: UserRecord = { ...input, id: id("user"), createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async list(useCaseKey?: string): Promise<UserRecord[]> {
    const all = [...this.byId.values()];
    return useCaseKey ? all.filter((u) => u.useCaseKey === useCaseKey) : all;
  }
  async update(userId: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId">>): Promise<UserRecord> {
    const rec = this.byId.get(userId);
    if (!rec) throw new Error(`unknown user '${userId}'`);
    Object.assign(rec, patch);
    return rec;
  }
  async remove(userId: string): Promise<void> {
    this.byId.delete(userId);
  }
}
```

In the same file, add `findById` to `MemoryAccountRepository` (inside the class, after `list`):

```ts
  async findById(accountId: string): Promise<AccountRecord | null> {
    return [...this.byAddress.values()].find((a) => a.id === accountId) ?? null;
  }
```

- [ ] **Step 4: Run the test; expect pass**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/user-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement prisma repos**

In `apps/api/src/persistence/prisma.ts` replace the `toUser` helper:

```ts
const toUser = (r: {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  useCaseKey: string | null;
  accountId: string | null;
  createdAt: Date;
}): UserRecord => ({
  id: r.id,
  email: r.email,
  passwordHash: r.passwordHash,
  role: r.role as Role,
  useCaseKey: r.useCaseKey,
  accountId: r.accountId,
  createdAt: r.createdAt.toISOString(),
});
```

Replace `PrismaUserRepository`:

```ts
export class PrismaUserRepository implements UserRepository {
  async findByEmail(email: string): Promise<UserRecord | null> {
    const r = await prisma.user.findUnique({ where: { email } });
    return r ? toUser(r) : null;
  }
  async findById(id: string): Promise<UserRecord | null> {
    const r = await prisma.user.findUnique({ where: { id } });
    return r ? toUser(r) : null;
  }
  async create(input: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord> {
    return toUser(await prisma.user.create({ data: input }));
  }
  async list(useCaseKey?: string): Promise<UserRecord[]> {
    return (await prisma.user.findMany({ where: useCaseKey ? { useCaseKey } : undefined, orderBy: { createdAt: "asc" } })).map(toUser);
  }
  async update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId">>): Promise<UserRecord> {
    return toUser(await prisma.user.update({ where: { id }, data: patch }));
  }
  async remove(id: string): Promise<void> {
    await prisma.user.delete({ where: { id } });
  }
}
```

Add `findById` to `PrismaAccountRepository` (after its `list` method):

```ts
  async findById(id: string): Promise<AccountRecord | null> {
    const r = await prisma.account.findUnique({ where: { id } });
    return r ? { id: r.id, address: r.address, label: r.label } : null;
  }
```

- [ ] **Step 6: Typecheck + full core/api tests**

Run: `pnpm --filter @tokenlayer/api typecheck && cd apps/api && CI=true ../../node_modules/.bin/vitest run test/user-repo.test.ts`
Expected: typecheck clean; test PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/persistence/memory.ts apps/api/src/persistence/prisma.ts apps/api/test/user-repo.test.ts
git commit -m "feat(api): implement user/account repo CRUD + lookups (memory + prisma)"
```

---

## Task 5: JWT claims + scope guard (API support)

**Files:**
- Modify: `apps/api/src/http/support.ts`
- Test: `apps/api/test/scope-guard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/scope-guard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { scopedToCaller } from "../src/http/support.js";

describe("scopedToCaller", () => {
  const platform = { id: "1", email: "a", role: "PlatformAdmin", useCaseKey: null } as const;
  const carbon = { id: "2", email: "b", role: "Issuer", useCaseKey: "carbon-credit" } as const;
  it("PlatformAdmin sees every use case", () => {
    expect(scopedToCaller(platform, "carbon-credit")).toBe(true);
    expect(scopedToCaller(platform, "gold-loan")).toBe(true);
  });
  it("a scoped user only sees their own use case", () => {
    expect(scopedToCaller(carbon, "carbon-credit")).toBe(true);
    expect(scopedToCaller(carbon, "gold-loan")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/scope-guard.test.ts`
Expected: FAIL — `scopedToCaller` not exported.

- [ ] **Step 3: Extend `TokenClaims` + add the guard**

In `apps/api/src/http/support.ts`:

Replace the `TokenClaims` interface (lines 5-9):

```ts
export interface TokenClaims {
  id: string;
  email: string;
  role: Role;
  useCaseKey: string | null;
}
```

Add at the end of the file:

```ts
/** True if the caller may see/act on a resource governed by `useCaseKey`. */
export function scopedToCaller(claims: TokenClaims, useCaseKey: string): boolean {
  return claims.role === "PlatformAdmin" || claims.useCaseKey === useCaseKey;
}
```

Note: `actorOf` is unchanged — it still returns `{ id, role }` for the engine; tenancy stays in the API layer.

- [ ] **Step 4: Run test; expect pass; typecheck**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/scope-guard.test.ts && pnpm --filter @tokenlayer/api typecheck`
Expected: test PASS; typecheck shows an error in `routes.ts` login (claims missing `useCaseKey`) — fixed in Task 6.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/http/support.ts apps/api/test/scope-guard.test.ts
git commit -m "feat(api): carry useCaseKey in JWT claims + add scope guard"
```

---

## Task 6: Enforce scoping on routes + scoped /users CRUD

**Files:**
- Modify: `apps/api/src/http/routes.ts`
- Modify: `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/api.test.ts` (new cases added in Task 9; this task wires routes + a focused unit of the users route)

- [ ] **Step 1: Update login to emit useCaseKey + richer user**

In `apps/api/src/http/routes.ts` replace the login handler body (lines 14-22) with:

```ts
  app.post("/auth/login", { schema: S.login }, async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };
    const user = await deps.users.findByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "invalid credentials" });
    }
    const claims: TokenClaims = { id: user.id, email: user.email, role: user.role, useCaseKey: user.useCaseKey };
    const wallet = user.accountId ? await deps.accounts.findById(user.accountId) : null;
    return { token: app.jwt.sign(claims), user: { ...claims, walletAddress: wallet?.address ?? null } };
  });
```

Add the import of `scopedToCaller` to the existing support import line:

```ts
import { actorOf, authenticate, contextOf, notFound, scopedToCaller, type TokenClaims } from "./support.js";
```

- [ ] **Step 2: Scope the use-case + asset reads/writes**

In `routes.ts`:

Replace `GET /use-cases` (line 30) so non-platform users see only theirs:

```ts
  app.get("/use-cases", { schema: S.listUseCases, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    const all = await deps.useCases.list();
    return claims.role === "PlatformAdmin" ? all : all.filter((u) => u.key === claims.useCaseKey);
  });
```

Replace `GET /use-cases/:key` (lines 31-35) to 404 when out of scope:

```ts
  app.get("/use-cases/:key", { schema: S.getUseCase, ...auth }, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!scopedToCaller(request.user as TokenClaims, key)) return notFound(reply, `unknown use case '${key}'`);
    if (!(await deps.useCases.has(key))) return notFound(reply, `unknown use case '${key}'`);
    return deps.useCases.get(key);
  });
```

Change the use-case create/update guards (lines 36-44) from `role !== "Admin"` to PlatformAdmin:

```ts
  app.post("/use-cases", { schema: S.createUseCase, ...auth }, async (request, reply) => {
    if ((request.user as TokenClaims).role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may create use cases" });
    return reply.code(201).send(await deps.useCases.create(request.body as UseCaseDefinition));
  });
  app.put("/use-cases/:key", { schema: S.updateUseCase, ...auth }, async (request, reply) => {
    if ((request.user as TokenClaims).role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may edit use cases" });
    const { key } = request.params as { key: string };
    return deps.useCases.update(key, request.body as UseCaseDefinition);
  });
```

Force the issue route to the caller's use case — replace the first lines of the `POST /assets` handler (lines 48-49) with:

```ts
    const body = request.body as { useCaseKey: string; name: string; symbol: string; chainId: string; metadata?: Record<string, unknown> };
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin" && body.useCaseKey !== claims.useCaseKey) {
      return reply.code(403).send({ error: "WRONG_USE_CASE", message: "cannot issue into another use case" });
    }
    const actor = actorOf(request);
```

Scope `GET /assets` (replace lines 69-76):

```ts
  app.get("/assets", { schema: S.listAssets, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    const q = request.query as { useCaseKey?: string; chainId?: string; status?: string; limit: number; offset: number };
    const useCaseKey = claims.role === "PlatformAdmin" ? q.useCaseKey : claims.useCaseKey ?? "__none__";
    const { items, total } = await deps.assets.list({ useCaseKey, chainId: q.chainId, status: q.status }, { limit: q.limit, offset: q.offset });
    return { data: items, pagination: { limit: q.limit, offset: q.offset, total } };
  });
```

Add a scope check to every `/assets/:id*` route. Create one helper near the top of `registerRoutes` (after `const auth = ...`):

```ts
  // Loads an asset and enforces use-case scope. Returns null after sending the
  // right error (404 for reads to hide existence; 403 for actions).
  async function scopedAsset(request: any, reply: any, mode: "read" | "act") {
    const { id } = request.params as { id: string };
    const asset = await deps.assets.get(id);
    if (!asset) {
      notFound(reply, "asset not found");
      return null;
    }
    if (!scopedToCaller(request.user as TokenClaims, asset.useCaseKey)) {
      if (mode === "read") notFound(reply, "asset not found");
      else reply.code(403).send({ error: "WRONG_USE_CASE", message: "asset belongs to another use case" });
      return null;
    }
    return asset;
  }
```

Then in `GET /assets/:id`, `/accounts`, `/tokens`, `/audit`, replace each handler's first two lines (`const { id } = ...; const asset = await deps.assets.get(id); if (!asset) return notFound(...)`) with:

```ts
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
```

And in `POST /assets/:id/actions/:action` replace its load (lines 132-134) with:

```ts
    const { action } = request.params as { action: string };
    const asset = await scopedAsset(request, reply, "act");
    if (!asset) return reply;
```

(Keep using `asset.id`/`contextOf(asset)` below as before.)

- [ ] **Step 3: Add the /users routes**

Append inside `registerRoutes`, before the closing brace:

```ts
  // --- users (scoped provisioning) ----------------------------------------
  app.get("/users", { schema: S.listUsers, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (!canManageUsers(claims.role)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to manage users" });
    const rows = await deps.users.list(claims.role === "PlatformAdmin" ? undefined : claims.useCaseKey ?? "__none__");
    return rows.map((u) => ({ id: u.id, email: u.email, role: u.role, useCaseKey: u.useCaseKey, accountId: u.accountId }));
  });

  app.post("/users", { schema: S.createUser, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string };
    const targetUseCaseKey = claims.role === "PlatformAdmin" ? (b.useCaseKey ?? null) : claims.useCaseKey;
    if (!canCreateUser({ role: claims.role, useCaseKey: claims.useCaseKey }, b.role, targetUseCaseKey)) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to create that user" });
    }
    if (await deps.users.findByEmail(b.email)) return reply.code(400).send({ error: "EMAIL_TAKEN", message: "email already registered" });
    let accountId: string | null = null;
    if (b.walletAddress) accountId = (await deps.accounts.upsert(b.walletAddress, b.email)).id;
    const created = await deps.users.create({
      email: b.email,
      passwordHash: bcrypt.hashSync(b.password, 10),
      role: b.role,
      useCaseKey: targetUseCaseKey,
      accountId,
    });
    return reply.code(201).send({ id: created.id, email: created.email, role: created.role, useCaseKey: created.useCaseKey, accountId: created.accountId });
  });

  app.delete("/users/:id", { schema: S.deleteUser, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const target = await deps.users.findById(id);
    if (!target) return notFound(reply, "user not found");
    const sameScope = claims.role === "PlatformAdmin" || (canManageUsers(claims.role) && target.useCaseKey === claims.useCaseKey && target.role !== "UseCaseAdmin");
    if (!sameScope) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to remove that user" });
    await deps.users.remove(id);
    return reply.code(204).send();
  });
```

Add imports at the top of `routes.ts`:

```ts
import { canCreateUser, canManageUsers, type Role, type UseCaseDefinition } from "@tokenlayer/core";
```
(Replace the existing `import type { UseCaseDefinition } from "@tokenlayer/core";` line.)

- [ ] **Step 4: Add the route schemas**

In `apps/api/src/http/schemas.ts`, add these entries to the `S` object (anywhere among the others). Use loose `additionalProperties: true` objects to match the file's existing simple style:

```ts
  listUsers: { tags: ["Users"], summary: "List users in scope", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401, 403) } },
  createUser: {
    tags: ["Users"], summary: "Create a user (scoped)", security: bearer,
    body: {
      type: "object",
      required: ["email", "password", "role"],
      properties: {
        email: { type: "string" },
        password: { type: "string", minLength: 6 },
        role: { type: "string", enum: ["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"] },
        useCaseKey: { type: "string" },
        walletAddress: { type: "string" },
      },
    },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 403) },
  },
  deleteUser: { tags: ["Users"], summary: "Remove a user (scoped)", security: bearer, params: { type: "object", properties: { id: { type: "string" } } }, response: { 204: { type: "null" }, ...errs(401, 403, 404) } },
```

`errs(...codes: number[])` takes HTTP status numbers (it's defined as `const errs = (...codes: number[]) => ...` in `schemas.ts`), so `errs(400, 401, 403)` / `errs(401, 403, 404)` work as written — no change to `errs` needed.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tokenlayer/api typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts
git commit -m "feat(api): enforce use-case scoping + add scoped /users CRUD"
```

---

## Task 7: Seed — Platform Admin + per-use-case rosters

**Files:**
- Modify: `apps/api/src/seed.ts`
- Modify: `config/use-cases/*.json` (`roles` arrays)

- [ ] **Step 1: Rewrite the seed users + roster generator**

In `apps/api/src/seed.ts` replace `DEFAULT_USERS` (lines 12-18) and the user loop, keeping `DEFAULT_ACCOUNTS` as-is:

```ts
export interface SeedUser {
  email: string;
  password: string;
  role: Role;
  useCaseKey: string | null;
  walletLabel?: string; // links a Buyer/Trader to a DEFAULT_ACCOUNTS label
}

/** The single global Platform Admin. */
export const PLATFORM_ADMIN: SeedUser = { email: "admin@tokenlayer.dev", password: "admin123", role: "PlatformAdmin", useCaseKey: null };

/** Generates a full demo roster for one use case. */
function rosterFor(useCaseKey: string, prefix: string, buyerWalletLabel: string, traderWalletLabel: string): SeedUser[] {
  return [
    { email: `${prefix}.admin@tokenlayer.dev`, password: `${prefix}123`, role: "UseCaseAdmin", useCaseKey },
    { email: `${prefix}.issuer@tokenlayer.dev`, password: `${prefix}123`, role: "Issuer", useCaseKey },
    { email: `${prefix}.trader@tokenlayer.dev`, password: `${prefix}123`, role: "Trader", useCaseKey, walletLabel: traderWalletLabel },
    { email: `${prefix}.buyer@tokenlayer.dev`, password: `${prefix}123`, role: "Buyer", useCaseKey, walletLabel: buyerWalletLabel },
    { email: `${prefix}.auditor@tokenlayer.dev`, password: `${prefix}123`, role: "Auditor", useCaseKey },
  ];
}

export const DEFAULT_USERS: SeedUser[] = [
  PLATFORM_ADMIN,
  ...rosterFor("carbon-credit", "carbon", "EcoFund Capital", "Treasury"),
  ...rosterFor("gold-loan", "gold", "Alice", "Treasury"),
  ...rosterFor("corporate-bond", "bond", "Bob", "Treasury"),
];
```

Replace the seeding loop in `seedDefaults` (lines 40-44) so wallets are linked:

```ts
  for (const a of DEFAULT_ACCOUNTS) {
    await accounts.upsert(a.address, a.label);
  }
  for (const u of DEFAULT_USERS) {
    if (await users.findByEmail(u.email)) continue;
    let accountId: string | null = null;
    if (u.walletLabel) {
      const acct = DEFAULT_ACCOUNTS.find((a) => a.label === u.walletLabel);
      if (acct) accountId = (await accounts.upsert(acct.address, acct.label)).id;
    }
    await users.create({ email: u.email, passwordHash: bcrypt.hashSync(u.password, 10), role: u.role, useCaseKey: u.useCaseKey, accountId });
  }
```

(Account upsert now runs before user creation so the wallet id exists. Remove the old account loop that followed the user loop.)

- [ ] **Step 2: Update the use-case config `roles` arrays**

In each of `config/use-cases/carbon-credit.json`, `gold-loan.json`, `corporate-bond.json`, `generic-asset.json`, `generic-certificate.json`, replace the `"roles": [...]` line with:

```json
  "roles": ["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"]
```

- [ ] **Step 3: Reseed + smoke-check the rosters**

```bash
cd apps/api && rm -f prisma/dev.db && ./node_modules/.bin/prisma db push --skip-generate >/dev/null && ../../node_modules/.bin/tsx src/seed.ts
```
Expected: "Seeded default users and accounts." Then verify counts:
```bash
cd apps/api && ../../node_modules/.bin/tsx -e "import('./src/persistence/prisma.js').then(async m=>{const u=new m.PrismaUserRepository();console.log((await u.list()).map(x=>x.email+':'+x.role+':'+x.useCaseKey));process.exit(0)})"
```
Expected: 1 PlatformAdmin (useCaseKey null) + 5 per use case.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/seed.ts config/use-cases/*.json
git commit -m "feat(api): seed Platform Admin + per-use-case rosters; update config roles"
```

---

## Task 8: API integration tests for tenancy

**Files:**
- Modify: `apps/api/test/helpers.ts`, `apps/api/test/api.test.ts`

- [ ] **Step 1: Replace the role-keyed login helper with an email-keyed one**

The existing `login(app, role)` in `helpers.ts` builds `EMAILS`/`PASSWORDS` maps keyed by `role` from `DEFAULT_USERS`. That now **collides** — every use case has an `Issuer`, a `Trader`, etc., so the map keeps only the last. Add an email-keyed helper and migrate callers.

In `apps/api/test/helpers.ts` add (keep the old `login` for any single-use callers, but new tests use this):

```ts
export async function loginAs(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email, password } });
  return res.json().token as string;
}
```

Existing tests that call `login(app, "Admin")` etc. must switch to `loginAs(app, "admin@tokenlayer.dev", "admin123")` (or the relevant roster email) since the old role names (`Admin/Operator/Viewer`) no longer exist. Update them as the test run flags failures.

- [ ] **Step 2: Write the failing tenancy tests**

Add to `apps/api/test/api.test.ts` (these assume the test harness seeds `DEFAULT_USERS`; if it seeds a custom set, create the carbon Issuer + gold Issuer via `seedDefaults` in the test setup):

```ts
describe("per-use-case tenancy", () => {
  it("a carbon Issuer cannot read a gold-loan asset (404) or act on it (403)", async () => {
    const app = await buildTestApp(); // existing helper that seeds DEFAULT_USERS
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // platform issues one asset in each use case
    const carbon = await issueAsset(app, platform, "carbon-credit");
    const gold = await issueAsset(app, platform, "gold-loan");
    const carbonIssuer = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");

    const read = await app.inject({ method: "GET", url: `${V1}/assets/${gold}`, headers: { authorization: `Bearer ${carbonIssuer}` } });
    expect(read.statusCode).toBe(404);
    const act = await app.inject({ method: "POST", url: `${V1}/assets/${gold}/actions/mint`, headers: { authorization: `Bearer ${carbonIssuer}` }, payload: { to: "0x1", amount: "1" } });
    expect(act.statusCode).toBe(403);
    expect(act.json().error).toBe("WRONG_USE_CASE");

    const list = await app.inject({ method: "GET", url: `${V1}/assets?limit=50`, headers: { authorization: `Bearer ${carbonIssuer}` } });
    expect(list.json().data.every((a: any) => a.useCaseKey === "carbon-credit")).toBe(true);
  });

  it("a UseCaseAdmin can create an Issuer in-scope but not a PlatformAdmin or cross-tenant user", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const ok = await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${admin}` }, payload: { email: "new.issuer@x.dev", password: "secret1", role: "Issuer" } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().useCaseKey).toBe("carbon-credit");
    const escalate = await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${admin}` }, payload: { email: "x@x.dev", password: "secret1", role: "UseCaseAdmin" } });
    expect(escalate.statusCode).toBe(403);
  });

  it("a Buyer is read-only", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbon = await issueAsset(app, platform, "carbon-credit");
    const buyer = await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const mint = await app.inject({ method: "POST", url: `${V1}/assets/${carbon}/actions/mint`, headers: { authorization: `Bearer ${buyer}` }, payload: { to: "0x1", amount: "1" } });
    expect(mint.statusCode).toBe(403);
  });
});
```

Add helper `issueAsset(app, token, useCaseKey)` in `helpers.ts` (issues with minimal valid metadata per use case):

```ts
export async function issueAsset(app: import("fastify").FastifyInstance, token: string, useCaseKey: string): Promise<string> {
  const meta: Record<string, Record<string, unknown>> = {
    "carbon-credit": { projectName: "P", registry: "Verra", vintage: 2024 },
    "gold-loan": { borrower: "R", goldWeightGrams: 1, loanAmountInr: 1 },
    "corporate-bond": { issuer: "ACME", isin: "X", faceValue: 1 },
  };
  const res = await app.inject({ method: "POST", url: `${V1}/assets`, headers: { authorization: `Bearer ${token}` }, payload: { useCaseKey, name: "T", symbol: "T", chainId: "besu", metadata: meta[useCaseKey] ?? {} } });
  return res.json().asset.id as string;
}
```

If `buildTestApp` doesn't already seed `DEFAULT_USERS`, update the test setup to call `seedDefaults(users, accounts)` (it already imports them per the existing demo/e2e pattern).

- [ ] **Step 3: Run; expect pass; fix the existing tests that used old roles**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run`
Expected: new tenancy tests PASS. Existing tests that logged in as `issuer@/operator@/viewer@` or asserted old role names must be updated to the new rosters (e.g. use `carbon.issuer@`, expect role `Issuer`/`Trader`). Fix each failure shown.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/helpers.ts apps/api/test/api.test.ts
git commit -m "test(api): cover use-case scoping + scoped user provisioning"
```

---

## Task 9: Web — types, RBAC mirror, API client, auth

**Files:**
- Modify: `apps/web/src/types.ts:1-7`
- Modify: `apps/web/src/rbac.ts:16-21`
- Modify: `apps/web/src/api.ts`

- [ ] **Step 1: Expand web Role + SessionUser**

In `apps/web/src/types.ts` replace lines 1-7:

```ts
export type Role = "PlatformAdmin" | "UseCaseAdmin" | "Issuer" | "Trader" | "Buyer" | "Auditor";

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  useCaseKey: string | null;
  walletAddress?: string | null;
}
```

- [ ] **Step 2: Mirror the matrix**

In `apps/web/src/rbac.ts` replace `MATRIX` (lines 16-21):

```ts
const MATRIX: Record<Role, Action[]> = {
  PlatformAdmin: ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "read"],
  UseCaseAdmin: ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "read"],
  Issuer: ["issue", "mint", "allow", "disallow", "freeze", "unfreeze", "read"],
  Trader: ["transfer", "burn", "read"],
  Buyer: ["read"],
  Auditor: ["read"],
};
```

- [ ] **Step 3: Add /users client methods + typed UserSummary**

In `apps/web/src/api.ts`, add to the `api` object:

```ts
  users: (token: string) => request<{ id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null }[]>("/users", token),
  createUser: (token: string, input: { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string }) =>
    request<{ id: string; email: string; role: Role }>("/users", token, { method: "POST", body: JSON.stringify(input) }),
  deleteUser: (token: string, id: string) => request<void>(`/users/${id}`, token, { method: "DELETE" }),
```

Add `Role` to the import at the top of `api.ts`:

```ts
import type { AccountState, Asset, AuditEntry, ChainInfo, Role, SessionUser, TokenInfo, UseCase } from "./types.js";
```

- [ ] **Step 4: Typecheck the web app**

Run: `pnpm --filter @tokenlayer/web typecheck`
Expected: errors only where `App.tsx`/`Login.tsx` reference old roles (`Admin`) — fixed in Tasks 10-11. Confirm `types.ts`/`rbac.ts`/`api.ts` themselves are clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/rbac.ts apps/web/src/api.ts
git commit -m "feat(web): expand roles, mirror RBAC matrix, add /users client"
```

---

## Task 10: Web — role-routed shell, header, grouped login

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/Header.tsx`
- Modify: `apps/web/src/components/Login.tsx`

- [ ] **Step 1: Route tabs by role in App.tsx**

Replace `apps/web/src/App.tsx` body. Key change: derive tabs from role; show `UsersAdmin`/`MyHoldings` where relevant. Full file:

```tsx
import { useEffect, useState } from "react";
import { api } from "./api.js";
import { useAuth } from "./auth.js";
import { AssetDetail } from "./components/AssetDetail.js";
import { AssetList } from "./components/AssetList.js";
import { Header } from "./components/Header.js";
import { IssuePanel } from "./components/IssuePanel.js";
import { Login } from "./components/Login.js";
import { MyHoldings } from "./components/MyHoldings.js";
import { UseCaseBuilder } from "./components/UseCaseBuilder.js";
import { UsersAdmin } from "./components/UsersAdmin.js";
import type { ChainInfo, Role, UseCase } from "./types.js";

type Tab = "assets" | "issue" | "build" | "users" | "holdings";

const TABS_BY_ROLE: Record<Role, { id: Tab; label: string }[]> = {
  PlatformAdmin: [
    { id: "build", label: "Use Cases" },
    { id: "users", label: "Use-Case Admins" },
    { id: "assets", label: "All Assets" },
  ],
  UseCaseAdmin: [
    { id: "assets", label: "Assets" },
    { id: "issue", label: "Issue Asset" },
    { id: "users", label: "Users" },
  ],
  Issuer: [
    { id: "assets", label: "Assets" },
    { id: "issue", label: "Issue Asset" },
  ],
  Trader: [{ id: "assets", label: "Trading Desk" }],
  Buyer: [
    { id: "assets", label: "Marketplace" },
    { id: "holdings", label: "My Holdings" },
  ],
  Auditor: [{ id: "assets", label: "Assets" }],
};

export function App(): JSX.Element {
  const { token, user } = useAuth();
  const [chains, setChains] = useState<ChainInfo[]>([]);
  const [useCases, setUseCases] = useState<UseCase[]>([]);
  const [tab, setTab] = useState<Tab>("assets");
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const reloadUseCases = (): void => {
    if (token) void api.useCases(token).then(setUseCases);
  };

  useEffect(() => {
    if (!token) return;
    void Promise.all([api.chains(token), api.useCases(token)]).then(([c, u]) => {
      setChains(c);
      setUseCases(u);
    });
  }, [token]);

  useEffect(() => {
    if (user) setTab(TABS_BY_ROLE[user.role][0].id);
  }, [user?.role]);

  if (!token || !user) return <Login />;
  const tabs = TABS_BY_ROLE[user.role];

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-6xl mx-auto px-6 py-6">
        {selected ? (
          <AssetDetail assetId={selected} useCases={useCases} chains={chains} onBack={() => setSelected(null)} onChanged={() => setRefreshKey((k) => k + 1)} />
        ) : (
          <>
            <div className="flex gap-1 mb-5">
              {tabs.map((t) => (
                <TabButton key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
                  {t.label}
                </TabButton>
              ))}
            </div>
            {tab === "assets" && <AssetList chains={chains} refreshKey={refreshKey} onSelect={setSelected} />}
            {tab === "issue" && (
              <IssuePanel useCases={useCases} chains={chains} onIssued={(id) => { setRefreshKey((k) => k + 1); setSelected(id); }} />
            )}
            {tab === "build" && <UseCaseBuilder chains={chains} existing={useCases} onCreated={reloadUseCases} />}
            {tab === "users" && <UsersAdmin useCases={useCases} />}
            {tab === "holdings" && <MyHoldings onSelect={setSelected} />}
          </>
        )}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button onClick={onClick} className={`px-4 py-2 rounded-lg text-sm font-medium ${active ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}>
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Show use-case in the Header**

Replace the title block in `apps/web/src/components/Header.tsx` (the inner `<div className="font-semibold ...">TokenLayer</div>`) with a version that reads the session:

```tsx
import { useAuth } from "../auth.js";

export function Header(): JSX.Element {
  const { user, logout } = useAuth();
  const scope = user?.role === "PlatformAdmin" ? "Platform" : (user?.useCaseKey ?? "");
  return (
    <header className="bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-brand-600 flex items-center justify-center text-white font-bold">T</div>
          <div>
            <div className="font-semibold text-slate-900 leading-tight">TokenLayer</div>
            {scope && <div className="text-[11px] text-slate-400 leading-tight">{scope}</div>}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-xs font-medium text-slate-700">{user?.email}</div>
            <div className="text-[11px] text-brand-600 font-semibold">{user?.role}</div>
          </div>
          <button onClick={logout} className="text-xs text-slate-500 hover:text-slate-800 border border-slate-200 rounded-lg px-3 py-1.5">Sign out</button>
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Group quick-login by use case**

Replace `QUICK` and its rendering in `apps/web/src/components/Login.tsx`:

```tsx
const QUICK: { group: string; users: { label: string; email: string; password: string }[] }[] = [
  { group: "Platform", users: [{ label: "Platform Admin", email: "admin@tokenlayer.dev", password: "admin123" }] },
  { group: "Carbon Credit", users: ["admin", "issuer", "trader", "buyer", "auditor"].map((r) => ({ label: r, email: `carbon.${r}@tokenlayer.dev`, password: "carbon123" })) },
  { group: "Gold Loan", users: ["admin", "issuer", "trader", "buyer", "auditor"].map((r) => ({ label: r, email: `gold.${r}@tokenlayer.dev`, password: "gold123" })) },
  { group: "Corporate Bond", users: ["admin", "issuer", "trader", "buyer", "auditor"].map((r) => ({ label: r, email: `bond.${r}@tokenlayer.dev`, password: "bond123" })) },
];
```

Replace the quick-login block (the `<div className="grid grid-cols-2 gap-2">…</div>`) with grouped rows:

```tsx
          <div className="space-y-3">
            {QUICK.map((g) => (
              <div key={g.group}>
                <p className="text-[11px] font-semibold text-slate-500 mb-1">{g.group}</p>
                <div className="flex flex-wrap gap-1.5">
                  {g.users.map((q) => (
                    <button key={q.email} onClick={() => { setEmail(q.email); setPassword(q.password); }} className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:border-brand-500 hover:text-brand-700">
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tokenlayer/web typecheck`
Expected: errors only "Cannot find module './components/UsersAdmin.js' / MyHoldings.js" — created next task.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/components/Header.tsx apps/web/src/components/Login.tsx
git commit -m "feat(web): role-routed dashboard shell, use-case header, grouped login"
```

---

## Task 11: Web — UsersAdmin + MyHoldings components

**Files:**
- Create: `apps/web/src/components/UsersAdmin.tsx`
- Create: `apps/web/src/components/MyHoldings.tsx`

- [ ] **Step 1: Build UsersAdmin**

Create `apps/web/src/components/UsersAdmin.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import type { Role, UseCase } from "../types.js";

type Summary = { id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null };

const ROLE_OPTIONS: Record<string, Role[]> = {
  PlatformAdmin: ["UseCaseAdmin"],
  UseCaseAdmin: ["Issuer", "Trader", "Buyer", "Auditor"],
};

export function UsersAdmin({ useCases }: { useCases: UseCase[] }): JSX.Element {
  const { token, user } = useAuth();
  const [rows, setRows] = useState<Summary[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const roleOptions = ROLE_OPTIONS[user?.role ?? ""] ?? [];
  const [role, setRole] = useState<Role>(roleOptions[0]);
  const [useCaseKey, setUseCaseKey] = useState(useCases[0]?.key ?? "");
  const [walletAddress, setWalletAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = (): void => { if (token) void api.users(token).then(setRows); };
  useEffect(reload, [token]);

  const isPlatform = user?.role === "PlatformAdmin";
  const needsWallet = role === "Buyer" || role === "Trader";

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await api.createUser(token!, { email, password, role, useCaseKey: isPlatform ? useCaseKey : undefined, walletAddress: needsWallet ? walletAddress : undefined });
      setEmail(""); setPassword(""); setWalletAddress("");
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Create failed");
    }
  }

  async function remove(id: string): Promise<void> {
    await api.deleteUser(token!, id);
    reload();
  }

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="bg-white rounded-xl border border-slate-200 p-6 space-y-4 max-w-2xl">
        <h2 className="font-semibold text-slate-900">{isPlatform ? "Create a Use-Case Admin" : "Add a user to this use case"}</h2>
        <div className="grid grid-cols-2 gap-4">
          <input className="input" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" type="password" placeholder="password (min 6)" value={password} onChange={(e) => setPassword(e.target.value)} />
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {isPlatform && (
            <select className="select" value={useCaseKey} onChange={(e) => setUseCaseKey(e.target.value)}>
              {useCases.map((u) => <option key={u.key} value={u.key}>{u.name}</option>)}
            </select>
          )}
          {needsWallet && <input className="input" placeholder="wallet address 0x…" value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} />}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700">Create user</button>
      </form>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500 bg-slate-50"><tr><th className="text-left px-4 py-2">Email</th><th className="text-left px-4 py-2">Role</th><th className="text-left px-4 py-2">Use case</th><th className="px-4 py-2"></th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2">{u.role}</td>
                <td className="px-4 py-2 text-slate-500">{u.useCaseKey ?? "—"}</td>
                <td className="px-4 py-2 text-right">
                  {u.role !== "PlatformAdmin" && u.role !== "UseCaseAdmin" && (
                    <button onClick={() => remove(u.id)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build MyHoldings**

Create `apps/web/src/components/MyHoldings.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { Asset } from "../types.js";

type Holding = { asset: Asset; balance: string };

export function MyHoldings({ onSelect }: { onSelect: (id: string) => void }): JSX.Element {
  const { token, user } = useAuth();
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);
  const wallet = user?.walletAddress ?? null;

  useEffect(() => {
    if (!token) return;
    void (async () => {
      const assets = await api.assets(token);
      const rows: Holding[] = [];
      for (const asset of assets) {
        const accounts = await api.assetAccounts(token, asset.id);
        const mine = accounts.find((a) => a.address.toLowerCase() === wallet?.toLowerCase());
        if (mine && mine.balance !== "0") rows.push({ asset, balance: mine.balance });
      }
      setHoldings(rows);
      setLoading(false);
    })();
  }, [token, wallet]);

  if (!wallet) return <p className="text-sm text-slate-500">No wallet is linked to your account.</p>;
  if (loading) return <p className="text-sm text-slate-500">Loading holdings…</p>;
  if (!holdings.length) return <p className="text-sm text-slate-500">You don't hold any credits yet.</p>;

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-xs text-slate-500 bg-slate-50"><tr><th className="text-left px-4 py-2">Asset</th><th className="text-left px-4 py-2">Symbol</th><th className="text-right px-4 py-2">Balance</th></tr></thead>
        <tbody>
          {holdings.map((h) => (
            <tr key={h.asset.id} className="border-t border-slate-100 cursor-pointer hover:bg-slate-50" onClick={() => onSelect(h.asset.id)}>
              <td className="px-4 py-2">{h.asset.name}</td>
              <td className="px-4 py-2 text-slate-500">{h.asset.symbol}</td>
              <td className="px-4 py-2 text-right font-medium">{h.balance}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm --filter @tokenlayer/web typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/UsersAdmin.tsx apps/web/src/components/MyHoldings.tsx
git commit -m "feat(web): UsersAdmin roster screen + Buyer MyHoldings view"
```

---

## Task 12: End-to-end tenancy script + verification + docs

**Files:**
- Create: `apps/api/src/e2e-tenancy.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the e2e tenancy script**

Create `apps/api/src/e2e-tenancy.ts` (in-memory app, mirrors `e2e-carbon.ts` style):

```ts
import { RbacPolicy } from "@tokenlayer/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { buildChainRegistry } from "./chains.js";
import { createEngine } from "./context.js";
import { MemoryAccountRepository, MemoryAssetRepository, MemoryAuditRepository, MemoryUseCaseRepository, MemoryUserRepository } from "./persistence/memory.js";
import { seedDefaults } from "./seed.js";
import { seedUseCases } from "./use-cases.js";

let failures = 0;
const check = (label: string, ok: boolean): void => { console.log(`   ${ok ? "✓" : "✗"} ${label}`); if (!ok) failures++; };

async function main(): Promise<void> {
  const rbac = new RbacPolicy();
  const chains = buildChainRegistry();
  const users = new MemoryUserRepository();
  const assets = new MemoryAssetRepository();
  const audit = new MemoryAuditRepository();
  const accounts = new MemoryAccountRepository();
  const useCases = new MemoryUseCaseRepository();
  await seedUseCases(useCases);
  await seedDefaults(users, accounts); // Platform Admin + per-use-case rosters
  const engine = createEngine(useCases, rbac, chains, audit);
  const app = await buildApp({ useCases, rbac, engine, users, assets, audit, accounts, chains, jwtSecret: "e2e" });

  const platform = await login(app, "admin@tokenlayer.dev", "admin123");
  const carbonAdmin = await login(app, "carbon.admin@tokenlayer.dev", "carbon123");
  const carbonIssuer = await login(app, "carbon.issuer@tokenlayer.dev", "carbon123");
  const carbonTrader = await login(app, "carbon.trader@tokenlayer.dev", "carbon123");
  const goldIssuer = await login(app, "gold.issuer@tokenlayer.dev", "gold123");

  // UseCaseAdmin provisions a new buyer (with wallet) in-scope.
  const newBuyer = await post(app, "/users", carbonAdmin, { email: "extra.buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" });
  check("UseCaseAdmin creates a scoped Buyer with a wallet", newBuyer.status === 201 && newBuyer.body.useCaseKey === "carbon-credit");
  check("UseCaseAdmin cannot create a UseCaseAdmin", (await post(app, "/users", carbonAdmin, { email: "x@x.dev", password: "secret1", role: "UseCaseAdmin" })).status === 403);

  // Issuer issues + mints in their use case.
  const issue = await post(app, "/assets", carbonIssuer, { useCaseKey: "carbon-credit", name: "VCU Test", symbol: "VCUT", chainId: "besu", metadata: { projectName: "P", registry: "Verra", vintage: 2024 } });
  check("Carbon Issuer issues a credit", issue.status === 201);
  const id = issue.body.asset.id as string;
  const buyerWallet = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
  await post(app, `/assets/${id}/actions/allow`, carbonIssuer, { account: buyerWallet });
  check("Carbon Issuer mints to the buyer wallet", (await post(app, `/assets/${id}/actions/mint`, carbonIssuer, { to: buyerWallet, amount: "1000" })).status === 200);

  // Trader transfers; Issuer cannot.
  await post(app, `/assets/${id}/actions/allow`, carbonIssuer, { account: "0x976EA74026E726554dB657fA54763abd0C3a0aa9" });
  check("Carbon Trader settles a transfer", (await post(app, `/assets/${id}/actions/transfer`, carbonTrader, { from: buyerWallet, to: "0x976EA74026E726554dB657fA54763abd0C3a0aa9", amount: "100" })).status === 200);
  check("Carbon Issuer cannot transfer (role)", (await post(app, `/assets/${id}/actions/transfer`, carbonIssuer, { from: buyerWallet, to: "0x976EA74026E726554dB657fA54763abd0C3a0aa9", amount: "1" })).status === 403);

  // Cross-tenant isolation.
  check("Gold Issuer cannot read the carbon asset (404)", (await get(app, `/assets/${id}`, goldIssuer)).status === 404);
  check("Gold Issuer cannot act on the carbon asset (403)", (await post(app, `/assets/${id}/actions/mint`, goldIssuer, { to: buyerWallet, amount: "1" })).status === 403);
  const goldList = await get(app, "/assets?limit=50", goldIssuer);
  check("Gold Issuer's asset list excludes carbon assets", goldList.body.data.every((a: any) => a.useCaseKey === "gold-loan"));

  await app.close();
  console.log(failures === 0 ? "\n✅ TENANCY E2E PASSED" : `\n❌ FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

async function login(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
  return res.json().token as string;
}
async function post(app: FastifyInstance, url: string, token: string, payload: unknown) {
  const res = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
}
async function get(app: FastifyInstance, url: string, token: string) {
  const res = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  return { status: res.statusCode, body: res.json() };
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it; expect pass**

Run: `cd apps/api && ../../node_modules/.bin/tsx src/e2e-tenancy.ts`
Expected: all ✓, "✅ TENANCY E2E PASSED".

- [ ] **Step 3: Full suite + typecheck**

Run: `pnpm -r typecheck && pnpm --filter @tokenlayer/core test && (cd apps/api && CI=true ../../node_modules/.bin/vitest run)`
Expected: all green. Fix any remaining old-role references the compiler flags.

- [ ] **Step 4: Update README**

In `README.md`, update the auth/roles section to document: the six roles, strict per-use-case isolation, the Platform-Admin→UseCaseAdmin→roster provisioning flow, and the new quick-login groups. Replace any mention of `Admin/Issuer/Operator/Viewer` with the new set.

- [ ] **Step 5: Live verification**

```bash
# API with the new seed (besu/mst simulated):
cd apps/api && rm -f prisma/dev.db && ./node_modules/.bin/prisma db push --skip-generate && ../../node_modules/.bin/tsx src/seed.ts && ../../node_modules/.bin/tsx src/server.ts &
# Web:
# preview_start "web"
```
In the browser: quick-login as `carbon.admin@` → create a Buyer with a wallet; log in as that Buyer → see Marketplace + My Holdings; log in as `gold.issuer@` → confirm only gold-loan assets are visible. Screenshot each.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/e2e-tenancy.ts README.md
git commit -m "test(api): end-to-end tenancy story; docs: per-use-case roles"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Task 1 (roles/RBAC §3), Task 2 (userPolicy §4), Tasks 3-4 (data model §1), Tasks 5-6 (auth/scoping §2, provisioning §4), Task 7 (seeding §6), Tasks 8 & 12 (testing §7), Tasks 9-11 (UI §5). All spec sections map to a task.
- **Type consistency:** `Role` union identical in `packages/core/src/types.ts` and `apps/web/src/types.ts`; `TokenClaims.useCaseKey: string | null` matches `UserRecord.useCaseKey`; `scopedToCaller`, `canCreateUser`, `canManageUsers` names used consistently across api + tests.
- **Known follow-up:** the `errs(...)` helper in `schemas.ts` — confirm it accepts 403/404/400; if it only maps a fixed set, extend it (small) in Task 6 Step 4.
- **No production data**: dev SQLite is reset (`rm -f prisma/dev.db`) on schema change; acceptable per spec.
```
