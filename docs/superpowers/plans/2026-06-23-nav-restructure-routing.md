# Dashboard Nav Restructure + Per-Use-Case Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the dashboard into Asset Management (Token Issuance / Marketplace / My Holdings) and User Management (Add User / Manage Users with Edit-password / Revoke-suspend / Delete), add path-based per-use-case routing (`/<use-case>`), and add the backend `User.active` suspend flag + `PATCH /users/:id`.

**Architecture:** A tiny in-app router (no new dependency) drives the active use-case key from the URL's first path segment. `App.tsx` resolves `(role, routeUseCaseKey)` into role-gated sections; new container components host sub-tabs and reuse existing panels. Backend gains a reversible `active` flag and a scoped `PATCH /users/:id`.

**Tech Stack:** React + Vite + TypeScript + Tailwind (web); Fastify + Prisma/SQLite + @fastify/jwt (api); Vitest.

**Spec:** `docs/superpowers/specs/2026-06-23-nav-restructure-routing-design.md`

**Command notes (this repo's pnpm trips a pre-run install — use these forms):**
- API tests: `cd apps/api && CI=true ../../node_modules/.bin/vitest run`
- Typecheck a package: `./node_modules/.bin/tsc --noEmit -p apps/api` (or `-p apps/web`, `-p packages/core`) from repo root
- Prisma: use the package-local binary `cd apps/api && ./node_modules/.bin/prisma ...`
- Run a script: `cd apps/api && ../../node_modules/.bin/tsx src/<file>.ts`

**GIT SAFETY for all implementer subagents:** stay on the working branch; only `git add <paths>` + `git commit`. Never run `git checkout/switch/reset/branch/stash/rebase`.

---

## File Structure

**Backend (`apps/api`)**
- `prisma/schema.prisma` — `User.active Boolean @default(true)`.
- `src/persistence/types.ts` — `UserRecord.active`; widen `update` patch.
- `src/persistence/memory.ts`, `src/persistence/prisma.ts` — map/handle `active`.
- `src/seed.ts` — seed users with `active: true`.
- `src/http/routes.ts` — login rejects suspended; `POST /users` sets `active: true`; new `PATCH /users/:id`; `GET /users` returns `active`.
- `src/http/schemas.ts` — `updateUser` schema.
- `test/api.test.ts` — PATCH / suspend tests.

**Web (`apps/web/src`)**
- `router.tsx` *(new)* — `RouterProvider` + `useRoute()`.
- `main.tsx` — wrap `<App>` in `<RouterProvider>`.
- `api.ts` — `users` returns `active`; new `updateUser`; `assets(token, useCaseKey?)`.
- `components/AssetList.tsx` — optional `useCaseKey` filter prop.
- `components/Header.tsx` — route-aware scope label + clickable logo (PlatformAdmin → home).
- `components/AssetManagement.tsx` *(new)* — sub-tabs Token Issuance / Marketplace / My Holdings.
- `components/UserManagement.tsx` *(new)* — sub-tabs Add User / Manage Users (Edit/Revoke/Delete).
- `components/PlatformHome.tsx` *(new)* — use-case catalog/switcher + Use-Case Builder.
- `App.tsx` — route-driven sections shell.
- (`components/UsersAdmin.tsx` is superseded by `UserManagement.tsx`; delete it in Task 9.)

---

## Task 1: Backend — `User.active` column, records, repositories

**Files:** `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/types.ts`, `apps/api/src/persistence/memory.ts`, `apps/api/src/persistence/prisma.ts`, `apps/api/src/seed.ts`, `apps/api/src/http/routes.ts`, test `apps/api/test/user-repo.test.ts`

- [ ] **Step 1: Add the column to the Prisma schema**

In `apps/api/prisma/schema.prisma`, the `User` model — add `active` after `accountId`:

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  role         String
  useCaseKey   String?
  accountId    String?
  active       Boolean  @default(true)
  createdAt    DateTime @default(now())
}
```

- [ ] **Step 2: Push schema + regenerate client**

```bash
cd apps/api && rm -f prisma/dev.db && ./node_modules/.bin/prisma db push --skip-generate && ./node_modules/.bin/prisma generate
```
Expected: "Your database is now in sync" + "Generated Prisma Client".

- [ ] **Step 3: Extend `UserRecord` + `update` patch in types.ts**

In `apps/api/src/persistence/types.ts`:

`UserRecord` — add `active: boolean;` after `accountId`:
```ts
export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  useCaseKey: string | null;
  accountId: string | null;
  active: boolean;
  createdAt: string;
}
```

`UserRepository.update` — widen the patch to include `active`:
```ts
  update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active">>): Promise<UserRecord>;
```

- [ ] **Step 4: Update the failing repo test**

In `apps/api/test/user-repo.test.ts`, extend the MemoryUserRepository test: the `create` calls now must pass `active: true`, and add suspend coverage. Replace the existing `MemoryUserRepository` `it(...)` body with:

```ts
    const repo = new MemoryUserRepository();
    const a = await repo.create({ email: "a@x.dev", passwordHash: "h", role: "Issuer", useCaseKey: "carbon-credit", accountId: null, active: true });
    await repo.create({ email: "b@x.dev", passwordHash: "h", role: "Trader", useCaseKey: "gold-loan", accountId: null, active: true });
    expect((await repo.findById(a.id))?.email).toBe("a@x.dev");
    expect((await repo.findByEmail("a@x.dev"))?.role).toBe("Issuer");
    expect((await repo.list("carbon-credit")).map((u) => u.email)).toEqual(["a@x.dev"]);
    expect((await repo.list()).length).toBe(2);
    const upd = await repo.update(a.id, { passwordHash: "h2", accountId: "acct_1" });
    expect(upd.passwordHash).toBe("h2");
    expect(upd.accountId).toBe("acct_1");
    const suspended = await repo.update(a.id, { active: false });
    expect(suspended.active).toBe(false);
    await expect(repo.update("no-such-id", { passwordHash: "x" })).rejects.toThrow("unknown user");
    await repo.remove(a.id);
    expect(await repo.findById(a.id)).toBeNull();
```

- [ ] **Step 5: Run it; expect FAIL**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/user-repo.test.ts`
Expected: type error / failure (UserRecord has no `active`; create calls reject the field until types compile, and `update` doesn't accept `active`).

- [ ] **Step 6: Implement in memory.ts + prisma.ts**

`apps/api/src/persistence/memory.ts` — `MemoryUserRepository.update`'s `Object.assign(rec, patch)` already handles `active` once the patch type allows it; no body change needed beyond the widened interface. Confirm `update`'s signature matches the interface:
```ts
  async update(userId: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active">>): Promise<UserRecord> {
    const rec = this.byId.get(userId);
    if (!rec) throw new Error(`unknown user '${userId}'`);
    Object.assign(rec, patch);
    return rec;
  }
```

`apps/api/src/persistence/prisma.ts` — in the `toUser` mapper add `active`, and widen `update`:
```ts
const toUser = (r: {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  useCaseKey: string | null;
  accountId: string | null;
  active: boolean;
  createdAt: Date;
}): UserRecord => ({
  id: r.id,
  email: r.email,
  passwordHash: r.passwordHash,
  role: r.role as Role,
  useCaseKey: r.useCaseKey,
  accountId: r.accountId,
  active: r.active,
  createdAt: r.createdAt.toISOString(),
});
```
And the `update` method signature:
```ts
  async update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active">>): Promise<UserRecord> {
    return toUser(await prisma.user.update({ where: { id }, data: patch }));
  }
```

- [ ] **Step 7: Keep the two create-callers compiling (pass `active: true`)**

`create(input)` now requires `active`. Update both callers:

`apps/api/src/seed.ts` — in `seedDefaults`, the `users.create({...})` call, add `active: true`:
```ts
    await users.create({ email: u.email, passwordHash: bcrypt.hashSync(u.password, 10), role: u.role, useCaseKey: u.useCaseKey, accountId, active: true });
```

`apps/api/src/http/routes.ts` — in the `POST /users` handler, the `deps.users.create({...})` call, add `active: true`:
```ts
    const created = await deps.users.create({
      email: b.email,
      passwordHash: bcrypt.hashSync(b.password, 10),
      role: b.role,
      useCaseKey: targetUseCaseKey,
      accountId,
      active: true,
    });
```

- [ ] **Step 8: Run repo test + typecheck**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/user-repo.test.ts` → PASS.
Run: `./node_modules/.bin/tsc --noEmit -p apps/api` (from repo root) → clean except the pre-existing `seed-carbon-projects.ts` note is gone now (it was fixed earlier); expect zero errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types.ts apps/api/src/persistence/memory.ts apps/api/src/persistence/prisma.ts apps/api/src/seed.ts apps/api/src/http/routes.ts apps/api/test/user-repo.test.ts
git commit -m "feat(api): add User.active suspend flag through schema + repos"
```

---

## Task 2: Backend — login rejects suspended, `PATCH /users/:id`, `/users` returns active

**Files:** `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`, test `apps/api/test/api.test.ts`

- [ ] **Step 1: Write the failing API tests**

Add to `apps/api/test/api.test.ts` inside the `describe("per-use-case tenancy", ...)` block (it already imports `buildTestApp`, `V1`, `loginAs`):

```ts
  it("edit (reset password), revoke (suspend), reactivate, and scope rules", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    // create a fresh issuer to manage
    const created = (await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${admin}` }, payload: { email: "edit.me@x.dev", password: "secret1", role: "Issuer" } })).json();
    // reset password
    const reset = await app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { password: "newpass1" } });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "edit.me@x.dev", password: "secret1" } })).statusCode).toBe(401); // old password fails
    expect((await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "edit.me@x.dev", password: "newpass1" } })).statusCode).toBe(200); // new works
    // revoke (suspend) → login blocked
    expect((await app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { active: false } })).statusCode).toBe(200);
    const blocked = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "edit.me@x.dev", password: "newpass1" } });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toBe("ACCOUNT_SUSPENDED");
    // reactivate → login works again
    await app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { active: true } });
    expect((await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "edit.me@x.dev", password: "newpass1" } })).statusCode).toBe(200);
    // GET /users exposes active
    const list = (await app.inject({ method: "GET", url: `${V1}/users`, headers: { authorization: `Bearer ${admin}` } })).json();
    expect(list.find((u: any) => u.email === "edit.me@x.dev").active).toBe(true);
  });

  it("a UseCaseAdmin cannot PATCH a user in another use case", async () => {
    const app = await buildTestApp();
    const goldAdmin = await loginAs(app, "gold.admin@tokenlayer.dev", "gold123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const carbonIssuer = (await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${carbonAdmin}` }, payload: { email: "x.iss@x.dev", password: "secret1", role: "Issuer" } })).json();
    const res = await app.inject({ method: "PATCH", url: `${V1}/users/${carbonIssuer.id}`, headers: { authorization: `Bearer ${goldAdmin}` }, payload: { active: false } });
    expect(res.statusCode).toBe(403);
  });
```

- [ ] **Step 2: Run; expect FAIL** (`PATCH` route 404/not found; ACCOUNT_SUSPENDED not implemented)

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/api.test.ts`

- [ ] **Step 3: Login rejects suspended users**

In `apps/api/src/http/routes.ts`, the `POST /auth/login` handler — after the credential check passes, add an active check before signing the token:
```ts
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "invalid credentials" });
    }
    if (!user.active) {
      return reply.code(401).send({ error: "ACCOUNT_SUSPENDED", message: "this account is suspended" });
    }
```

- [ ] **Step 4: `GET /users` returns `active`**

In `routes.ts`, the `GET /users` handler — include `active` in the projected summary:
```ts
    return rows.map((u) => ({ id: u.id, email: u.email, role: u.role, useCaseKey: u.useCaseKey, accountId: u.accountId, active: u.active }));
```

- [ ] **Step 5: Add `PATCH /users/:id`**

In `routes.ts`, right after the `DELETE /users/:id` handler, add (reuses the same scope rule as delete):
```ts
  app.patch("/users/:id", { schema: S.updateUser, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const b = request.body as { password?: string; active?: boolean };
    const target = await deps.users.findById(id);
    if (!target) return notFound(reply, "user not found");
    const sameScope = claims.role === "PlatformAdmin" || (canManageUsers(claims.role) && target.useCaseKey === claims.useCaseKey && target.role !== "UseCaseAdmin");
    if (!sameScope) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to edit that user" });
    const patch: { passwordHash?: string; active?: boolean } = {};
    if (typeof b.password === "string") patch.passwordHash = bcrypt.hashSync(b.password, 10);
    if (typeof b.active === "boolean") patch.active = b.active;
    const updated = await deps.users.update(id, patch);
    return { id: updated.id, email: updated.email, role: updated.role, useCaseKey: updated.useCaseKey, accountId: updated.accountId, active: updated.active };
  });
```

- [ ] **Step 6: Add the `updateUser` schema**

In `apps/api/src/http/schemas.ts`, add to the `S` object near `deleteUser`:
```ts
  updateUser: {
    tags: ["Users"], summary: "Edit a user (reset password / suspend) — scoped", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      properties: { password: { type: "string", minLength: 6 }, active: { type: "boolean" } },
    },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
```

- [ ] **Step 7: Run tests + typecheck**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run` → all pass (existing + 2 new).
Run: `./node_modules/.bin/tsc --noEmit -p apps/api` → clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/api.test.ts
git commit -m "feat(api): reject suspended logins + PATCH /users/:id (reset password / suspend)"
```

---

## Task 3: Web — API client (active, updateUser, asset filter)

**Files:** `apps/web/src/api.ts`, `apps/web/src/components/AssetList.tsx`

- [ ] **Step 1: Extend the api client**

In `apps/web/src/api.ts`:

Change `assets` to accept an optional use-case filter:
```ts
  assets: (token: string, useCaseKey?: string) =>
    request<Listed<Asset>>(`/assets?limit=200${useCaseKey ? `&useCaseKey=${encodeURIComponent(useCaseKey)}` : ""}`, token).then((r) => r.data),
```

Change `users` return type to include `active` and add `updateUser`:
```ts
  users: (token: string) => request<{ id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null; active: boolean }[]>("/users", token),
  createUser: (token: string, input: { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string }) =>
    request<{ id: string; email: string; role: Role }>("/users", token, { method: "POST", body: JSON.stringify(input) }),
  updateUser: (token: string, id: string, patch: { password?: string; active?: boolean }) =>
    request<{ id: string; active: boolean }>(`/users/${id}`, token, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteUser: (token: string, id: string) => request<void>(`/users/${id}`, token, { method: "DELETE" }),
```
(Keep the existing `Role` import.)

- [ ] **Step 2: AssetList honors a use-case filter**

In `apps/web/src/components/AssetList.tsx`, add an optional `useCaseKey` prop and pass it through:
```ts
interface Props {
  chains: ChainInfo[];
  refreshKey: number;
  onSelect: (id: string) => void;
  useCaseKey?: string;
}

export function AssetList({ chains, refreshKey, onSelect, useCaseKey }: Props): JSX.Element {
```
and the effect:
```ts
  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api.assets(token, useCaseKey).then((a) => {
      setAssets(a);
      setLoading(false);
    });
  }, [token, refreshKey, useCaseKey]);
```

- [ ] **Step 3: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit -p apps/web` (from repo root). Expect clean (these are additive; existing callers still compile).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/components/AssetList.tsx
git commit -m "feat(web): api client gains active/updateUser + asset use-case filter"
```

---

## Task 4: Web — minimal router

**Files:** create `apps/web/src/router.tsx`, modify `apps/web/src/main.tsx`

- [ ] **Step 1: Create the router**

Create `apps/web/src/router.tsx`:
```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface RouteState {
  path: string;
  /** First path segment — the active use-case key ("" at the root). */
  useCaseKey: string;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouteState | null>(null);

export function RouterProvider({ children }: { children: ReactNode }): JSX.Element {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string): void => {
    if (to === window.location.pathname) return;
    window.history.pushState({}, "", to);
    setPath(to);
  };
  const useCaseKey = decodeURIComponent(path.split("/").filter(Boolean)[0] ?? "");
  return <RouterContext.Provider value={{ path, useCaseKey, navigate }}>{children}</RouterContext.Provider>;
}

export function useRoute(): RouteState {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRoute must be used within RouterProvider");
  return ctx;
}
```

- [ ] **Step 2: Wrap the app**

In `apps/web/src/main.tsx`, import and wrap (inside AuthProvider):
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AuthProvider } from "./auth.js";
import { RouterProvider } from "./router.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider>
        <App />
      </RouterProvider>
    </AuthProvider>
  </StrictMode>,
);
```

- [ ] **Step 3: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit -p apps/web`. Expect clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/router.tsx apps/web/src/main.tsx
git commit -m "feat(web): add minimal path-based router"
```

---

## Task 5: Web — AssetManagement container

**Files:** create `apps/web/src/components/AssetManagement.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/AssetManagement.tsx`:
```tsx
import { useState } from "react";
import { useAuth } from "../auth.js";
import { can } from "../rbac.js";
import type { ChainInfo, UseCase } from "../types.js";
import { AssetDetail } from "./AssetDetail.js";
import { AssetList } from "./AssetList.js";
import { IssuePanel } from "./IssuePanel.js";
import { MyHoldings } from "./MyHoldings.js";

type Sub = "issuance" | "marketplace" | "holdings";

export function AssetManagement({ useCaseKey, useCases, chains }: { useCaseKey: string; useCases: UseCase[]; chains: ChainInfo[] }): JSX.Element {
  const { user } = useAuth();
  const isPlatform = user?.role === "PlatformAdmin";
  const canIssue = user ? can(user.role, "issue") : false;
  const hasWallet = !!user?.walletAddress;

  const subs: { id: Sub; label: string }[] = [
    ...(canIssue ? [{ id: "issuance" as Sub, label: "Token Issuance" }] : []),
    { id: "marketplace" as Sub, label: "Marketplace" },
    ...(hasWallet ? [{ id: "holdings" as Sub, label: "My Holdings" }] : []),
  ];
  const [sub, setSub] = useState<Sub>(subs[0]?.id ?? "marketplace");
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Issuance is locked to the active use case; PlatformAdmin filters the list by it.
  const issueUseCases = useCases.filter((u) => u.key === useCaseKey);
  const listKey = isPlatform ? useCaseKey : undefined;

  if (selected) {
    return <AssetDetail assetId={selected} useCases={useCases} chains={chains} onBack={() => setSelected(null)} onChanged={() => setRefreshKey((k) => k + 1)} />;
  }

  return (
    <div>
      <div className="flex gap-1 mb-5">
        {subs.map((s) => (
          <button
            key={s.id}
            onClick={() => setSub(s.id)}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-medium ${sub === s.id ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {sub === "issuance" && <IssuePanel useCases={issueUseCases} chains={chains} onIssued={(id) => { setRefreshKey((k) => k + 1); setSelected(id); }} />}
      {sub === "marketplace" && <AssetList chains={chains} useCaseKey={listKey} refreshKey={refreshKey} onSelect={setSelected} />}
      {sub === "holdings" && <MyHoldings onSelect={setSelected} />}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit -p apps/web`. (App.tsx still references old tabs — it is replaced in Task 8; if you typecheck the whole project now you may see errors only in App.tsx, which is expected. The new file itself must be clean.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/AssetManagement.tsx
git commit -m "feat(web): AssetManagement container (Token Issuance / Marketplace / My Holdings)"
```

---

## Task 6: Web — UserManagement container (Add User / Manage Users)

**Files:** create `apps/web/src/components/UserManagement.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/UserManagement.tsx`. It hosts two sub-tabs and an edit-password modal:
```tsx
import { useEffect, useState } from "react";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import type { Role, UseCase } from "../types.js";

type Summary = { id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null; active: boolean };
type Sub = "add" | "manage";

const ROLE_OPTIONS: Record<string, Role[]> = {
  PlatformAdmin: ["UseCaseAdmin"],
  UseCaseAdmin: ["Issuer", "Trader", "Buyer", "Auditor"],
};

export function UserManagement({ useCaseKey, useCases }: { useCaseKey: string; useCases: UseCase[] }): JSX.Element {
  const { token, user } = useAuth();
  const [sub, setSub] = useState<Sub>("manage");
  const [rows, setRows] = useState<Summary[]>([]);
  const reload = (): void => { if (token) void api.users(token).then(setRows); };
  useEffect(reload, [token]);

  return (
    <div>
      <div className="flex gap-1 mb-5">
        {(["add", "manage"] as Sub[]).map((s) => (
          <button
            key={s}
            onClick={() => setSub(s)}
            className={`px-3.5 py-1.5 rounded-lg text-sm font-medium ${sub === s ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}
          >
            {s === "add" ? "Add User" : "Manage Users"}
          </button>
        ))}
      </div>
      {sub === "add" ? (
        <AddUser useCaseKey={useCaseKey} useCases={useCases} onAdded={() => { reload(); setSub("manage"); }} />
      ) : (
        <ManageUsers rows={rows} me={user?.email} onChanged={reload} />
      )}
    </div>
  );
}

function AddUser({ useCaseKey, useCases, onAdded }: { useCaseKey: string; useCases: UseCase[]; onAdded: () => void }): JSX.Element {
  const { token, user } = useAuth();
  const isPlatform = user?.role === "PlatformAdmin";
  const roleOptions = ROLE_OPTIONS[user?.role ?? ""] ?? [];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>(roleOptions[0] ?? "Issuer");
  const [selUseCase, setSelUseCase] = useState(useCaseKey || useCases[0]?.key || "");
  const [walletAddress, setWalletAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsWallet = role === "Buyer" || role === "Trader";

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await api.createUser(token!, { email, password, role, useCaseKey: isPlatform ? selUseCase : undefined, walletAddress: needsWallet ? walletAddress : undefined });
      setEmail(""); setPassword(""); setWalletAddress("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Create failed");
    }
  }

  return (
    <form onSubmit={create} className="bg-white rounded-xl border border-slate-200 p-6 space-y-4 max-w-2xl">
      <h2 className="font-semibold text-slate-900">{isPlatform ? "Create a Use-Case Admin" : "Add a user to this use case"}</h2>
      <div className="grid grid-cols-2 gap-4">
        <input className="input" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" placeholder="password (min 6)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {isPlatform && (
          <select className="select" value={selUseCase} onChange={(e) => setSelUseCase(e.target.value)}>
            {useCases.map((u) => <option key={u.key} value={u.key}>{u.name}</option>)}
          </select>
        )}
        {needsWallet && <input className="input" placeholder="wallet address 0x…" value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} />}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700">Create user</button>
    </form>
  );
}

function ManageUsers({ rows, me, onChanged }: { rows: Summary[]; me?: string; onChanged: () => void }): JSX.Element {
  const { token } = useAuth();
  const [editing, setEditing] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try { await fn(); onChanged(); } catch (err) { setError(err instanceof ApiError ? err.message : "Action failed"); }
  };
  // can't manage your own row, other PlatformAdmins
  const manageable = (u: Summary): boolean => u.email !== me && u.role !== "PlatformAdmin";

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500 bg-slate-50"><tr><th className="text-left px-4 py-2">Email</th><th className="text-left px-4 py-2">Role</th><th className="text-left px-4 py-2">Use case</th><th className="text-left px-4 py-2">Status</th><th className="px-4 py-2 text-right">Actions</th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2">{u.role}</td>
                <td className="px-4 py-2 text-slate-500">{u.useCaseKey ?? "—"}</td>
                <td className="px-4 py-2">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${u.active ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{u.active ? "active" : "suspended"}</span>
                </td>
                <td className="px-4 py-2 text-right space-x-3">
                  {manageable(u) ? (
                    <>
                      <button onClick={() => setEditing(u)} className="text-xs text-brand-600 hover:text-brand-700">Edit</button>
                      <button onClick={() => act(() => api.updateUser(token!, u.id, { active: !u.active }))} className="text-xs text-amber-600 hover:text-amber-700">{u.active ? "Revoke" : "Reactivate"}</button>
                      <button onClick={() => act(() => api.deleteUser(token!, u.id))} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                    </>
                  ) : (
                    <span className="text-xs text-slate-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <EditPasswordModal
          user={editing}
          onClose={() => setEditing(null)}
          onSave={async (pw) => { await act(() => api.updateUser(token!, editing.id, { password: pw })); setEditing(null); }}
        />
      )}
    </div>
  );
}

function EditPasswordModal({ user, onClose, onSave }: { user: Summary; onClose: () => void; onSave: (pw: string) => Promise<void> }): JSX.Element {
  const [pw, setPw] = useState("");
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-slate-900">Reset password</h3>
        <p className="text-xs text-slate-500">{user.email}</p>
        <input className="input" type="password" placeholder="new password (min 6)" value={pw} onChange={(e) => setPw(e.target.value)} />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm text-slate-500 px-3 py-1.5">Cancel</button>
          <button disabled={pw.length < 6} onClick={() => void onSave(pw)} className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-40">Save</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit -p apps/web`. The new file must be clean (App.tsx errors are expected until Task 8).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/UserManagement.tsx
git commit -m "feat(web): UserManagement container (Add User + Manage Users w/ edit/revoke/delete)"
```

---

## Task 7: Web — PlatformHome (catalog/switcher + builder)

**Files:** create `apps/web/src/components/PlatformHome.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/PlatformHome.tsx`:
```tsx
import { useRoute } from "../router.js";
import type { ChainInfo, UseCase } from "../types.js";
import { UseCaseBuilder } from "./UseCaseBuilder.js";

export function PlatformHome({ useCases, chains, onReloadUseCases }: { useCases: UseCase[]; chains: ChainInfo[]; onReloadUseCases: () => void }): JSX.Element {
  const { navigate } = useRoute();
  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-semibold text-slate-900 mb-3">Use cases</h2>
        {useCases.length === 0 ? (
          <p className="text-sm text-slate-500">No use cases yet — define one below.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {useCases.map((u) => (
              <button key={u.key} onClick={() => navigate(`/${u.key}`)} className="text-left bg-white rounded-xl border border-slate-200 p-4 hover:border-brand-500 hover:shadow-sm transition">
                <div className="font-medium text-slate-800">{u.name}</div>
                <div className="text-xs text-slate-400 mt-0.5">{u.key}</div>
                <span className="inline-block mt-2 text-[10px] px-1.5 py-0.5 rounded bg-brand-600 text-white font-semibold">{u.tokenStandard}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div>
        <h2 className="font-semibold text-slate-900 mb-3">Define a new use case</h2>
        <UseCaseBuilder chains={chains} existing={useCases} onCreated={onReloadUseCases} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit -p apps/web`. New file clean (App.tsx still pending).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/PlatformHome.tsx
git commit -m "feat(web): PlatformHome (use-case catalog/switcher + builder)"
```

---

## Task 8: Web — App shell + Header (route-driven sections)

**Files:** `apps/web/src/rbac.ts`, `apps/web/src/App.tsx`, `apps/web/src/components/Header.tsx`

> NOTE: the web app has NO dependency on `@tokenlayer/core` (it keeps its own `Role`/RBAC mirror). Do NOT import from `@tokenlayer/core` in the web app — add a local `canManageUsers` helper instead.

- [ ] **Step 0: Add `canManageUsers` to the web RBAC mirror**

In `apps/web/src/rbac.ts`, after the `can` function, add:
```ts
/** Roles that can manage a use case's user roster. */
export function canManageUsers(role: Role): boolean {
  return role === "PlatformAdmin" || role === "UseCaseAdmin";
}
```

- [ ] **Step 1: Rewrite App.tsx**

Replace `apps/web/src/App.tsx` entirely:
```tsx
import { useEffect, useState } from "react";
import { api } from "./api.js";
import { useAuth } from "./auth.js";
import { useRoute } from "./router.js";
import { AssetManagement } from "./components/AssetManagement.js";
import { Header } from "./components/Header.js";
import { Login } from "./components/Login.js";
import { PlatformHome } from "./components/PlatformHome.js";
import { UserManagement } from "./components/UserManagement.js";
import { canManageUsers } from "./rbac.js";
import type { ChainInfo, UseCase } from "./types.js";

type Section = "assets" | "users";

export function App(): JSX.Element {
  const { token, user } = useAuth();
  const { useCaseKey: routeKey, navigate } = useRoute();
  const [chains, setChains] = useState<ChainInfo[]>([]);
  const [useCases, setUseCases] = useState<UseCase[]>([]);
  const [section, setSection] = useState<Section>("assets");

  const reloadUseCases = (): void => { if (token) void api.useCases(token).then(setUseCases); };

  useEffect(() => {
    if (!token) return;
    void Promise.all([api.chains(token), api.useCases(token)]).then(([c, u]) => { setChains(c); setUseCases(u); });
  }, [token]);

  // Scoped users are clamped to their own use case's path.
  useEffect(() => {
    if (user && user.useCaseKey && routeKey !== user.useCaseKey) navigate(`/${user.useCaseKey}`);
  }, [user, routeKey, navigate]);

  if (!token || !user) return <Login />;

  const isPlatform = user.role === "PlatformAdmin";
  const activeUseCase = isPlatform ? routeKey : user.useCaseKey ?? "";

  // PlatformAdmin at the root → Platform home.
  if (isPlatform && !activeUseCase) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="max-w-6xl mx-auto px-6 py-6">
          <PlatformHome useCases={useCases} chains={chains} onReloadUseCases={reloadUseCases} />
        </main>
      </div>
    );
  }

  const sections: { id: Section; label: string }[] = [
    { id: "assets", label: "Asset Management" },
    ...(canManageUsers(user.role) ? [{ id: "users" as Section, label: "User Management" }] : []),
  ];

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-6xl mx-auto px-6 py-6">
        <div className="flex gap-1 mb-5">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${section === s.id ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {section === "assets" && <AssetManagement useCaseKey={activeUseCase} useCases={useCases} chains={chains} />}
        {section === "users" && <UserManagement useCaseKey={activeUseCase} useCases={useCases} />}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Update Header (route-aware scope + home link)**

Replace `apps/web/src/components/Header.tsx`:
```tsx
import { useAuth } from "../auth.js";
import { useRoute } from "../router.js";
import { Logo } from "./Logo.js";

export function Header(): JSX.Element {
  const { user, logout } = useAuth();
  const { useCaseKey, navigate } = useRoute();
  const isPlatform = user?.role === "PlatformAdmin";
  const scope = isPlatform ? (useCaseKey || "Platform") : (user?.useCaseKey ?? "");
  return (
    <header className="bg-ink border-b border-ink-700">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => isPlatform && navigate("/")} className={isPlatform ? "cursor-pointer" : "cursor-default"} aria-label="Home">
            <Logo onDark size={30} />
          </button>
          {scope && <span className="hidden sm:inline-block text-[11px] text-brand-400 font-medium border border-brand-400/30 rounded-full px-2 py-0.5">{scope}</span>}
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-xs font-medium text-slate-100">{user?.email}</div>
            <div className="text-[11px] text-brand-400 font-semibold">{user?.role}</div>
          </div>
          <button onClick={logout} className="text-xs text-slate-200 hover:text-white border border-white/20 hover:border-white/40 rounded-lg px-3 py-1.5">Sign out</button>
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Typecheck (whole web app must now be clean)**

Run: `./node_modules/.bin/tsc --noEmit -p apps/web`. Expect ZERO errors (App + all containers + router resolve). `canManageUsers` comes from the local `./rbac.js` helper added in Step 0 — NOT from `@tokenlayer/core` (the web app has no core dependency).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/components/Header.tsx
git commit -m "feat(web): route-driven App shell (Asset/User Management) + home-aware header"
```

---

## Task 9: Cleanup, verification, docs

**Files:** delete `apps/web/src/components/UsersAdmin.tsx`; `README.md`

- [ ] **Step 1: Remove the superseded component**

`UsersAdmin.tsx` is no longer imported (UserManagement replaced it). Confirm and delete:
```bash
grep -rn "UsersAdmin" apps/web/src || echo "no references"
git rm apps/web/src/components/UsersAdmin.tsx
```
(If grep still shows a reference, fix that import to UserManagement first.)

- [ ] **Step 2: Full verification**

```bash
# typecheck everything
./node_modules/.bin/tsc --noEmit -p packages/core && ./node_modules/.bin/tsc --noEmit -p apps/api && ./node_modules/.bin/tsc --noEmit -p apps/web
# core + api tests
cd packages/core && CI=true ../../node_modules/.bin/vitest run && cd ../..
cd apps/api && CI=true ../../node_modules/.bin/vitest run && cd ../..
```
All must pass. Then reseed + run the carbon e2e to confirm nothing regressed server-side:
```bash
cd apps/api && rm -f prisma/dev.db && ./node_modules/.bin/prisma db push --skip-generate && ../../node_modules/.bin/tsx src/seed.ts && ../../node_modules/.bin/tsx src/e2e-carbon.ts
```
Expected: "✅ CARBON CREDIT USE CASE PASSED END-TO-END".

- [ ] **Step 3: Live preview walkthrough** (controller does this with preview tools, not the implementer)

Restart API + web; verify: scoped login (`carbon.admin`) lands on `/carbon-credit`; Asset Management shows Token Issuance + Marketplace (+ My Holdings for `carbon.buyer`); User Management shows Add User + Manage Users with Edit/Revoke/Delete; revoke a user then confirm their login returns ACCOUNT_SUSPENDED; PlatformAdmin (`admin@`) lands on `/` home, picking a use-case card navigates to `/<key>`.

- [ ] **Step 4: README note**

In `README.md`, under the dashboard/UI description, add a short bullet: the dashboard is organized into **Asset Management** (Token Issuance · Marketplace · My Holdings) and **User Management** (Add User · Manage Users — reset password, revoke/reactivate, delete), with a per-use-case URL `/<use-case-key>` and a Platform home for the PlatformAdmin. Replace any stale "Assets / Issue Asset / Users" tab references.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(web): remove superseded UsersAdmin; docs: nav restructure + routing"
```

---

## Self-Review notes

- **Spec coverage:** routing §1 → Task 4 + App clamp (Task 8); Asset Management §2 → Task 5; User Management + backend §3 → Tasks 1, 2, 6; Platform home §4 → Task 7 + App (Task 8); testing §5 → Tasks 1, 2, 9. All sections covered.
- **Type consistency:** `Summary` type includes `active` in Task 6 matching the `/users` response (Task 2 Step 4); `api.updateUser(token, id, { password?, active? })` signature consistent across Tasks 3 and 6; `AssetManagement`/`UserManagement` props `{ useCaseKey, useCases[, chains] }` match the calls in App (Task 8); `useRoute()` shape (`{ path, useCaseKey, navigate }`) consistent across router (Task 4), Header (Task 8), PlatformHome (Task 7).
- **No placeholders:** every code step is complete.
- **Known sequencing:** Tasks 5–7 create components App imports in Task 8; whole-project web typecheck is only expected fully clean after Task 8. Each new file is independently clean when created.
