# KYC / User Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture KYC details + an approve/reject status when onboarding users, and require KYC approval before a user's wallet can be allowlisted on an asset.

**Architecture:** `User` gains a `kycStatus` column (DB-default `approved`, so seeded users/admins/existing rows are unaffected) and a `kyc` JSON blob. The `POST /users` route sets new users `pending`; `PATCH /users/:id` approves/rejects. The `allow` lifecycle action gates on the target wallet's owning user being `approved` — enforced in the API layer (address→account→user), leaving the chain-agnostic engine untouched.

**Tech Stack:** Fastify + Prisma/SQLite, React + Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-23-kyc-onboarding-design.md`

**Command notes:** API tests `cd apps/api && CI=true ../../node_modules/.bin/vitest run`; typecheck `./node_modules/.bin/tsc --noEmit -p apps/api` (or `-p apps/web`) from repo root; Prisma via `cd apps/api && ./node_modules/.bin/prisma ...`; scripts via `../../node_modules/.bin/tsx src/<file>.ts`.

**GIT SAFETY (all subagents):** stay on the working branch; only `git add <paths>` + `git commit`; never `git checkout/switch/reset/branch/stash/rebase`.

---

## File structure
- `apps/api/prisma/schema.prisma` — `User.kycStatus`, `User.kyc`.
- `apps/api/src/persistence/types.ts` — `KycStatus`, `KycDetails`, `UserRecord` fields, `update` patch widen.
- `apps/api/src/persistence/prisma.ts` — `toUser` (parse kyc), `create` (stringify kyc).
- `apps/api/src/persistence/memory.ts` — (no change beyond the widened interface; objects stored directly).
- `apps/api/src/seed.ts` — pass `kycStatus`/`kyc` in the create call.
- `apps/api/src/http/routes.ts` — POST kyc+pending, PATCH kycStatus, GET kyc, allow-gate.
- `apps/api/src/http/schemas.ts` — `createUser.kyc`, `updateUser.kycStatus`.
- `apps/api/test/api.test.ts`, `apps/api/test/user-repo.test.ts` — tests.
- `apps/web/src/api.ts` — kyc in createUser, kycStatus in updateUser, kyc/kycStatus in users().
- `apps/web/src/components/UserManagement.tsx` — Add User KYC fields; Manage Users KYC badge + Approve/Reject.

---

## Task 1: Persistence — `kycStatus` + `kyc`

**Files:** `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/types.ts`, `apps/api/src/persistence/prisma.ts`, `apps/api/src/seed.ts`, `apps/api/test/user-repo.test.ts`

- [ ] **Step 1: Prisma schema.** In `apps/api/prisma/schema.prisma`, add to `User` after `active`:
```prisma
  kycStatus    String   @default("approved")
  kyc          String?
```

- [ ] **Step 2: Push + regenerate.**
```bash
cd apps/api && rm -f prisma/dev.db && ./node_modules/.bin/prisma db push --skip-generate && ./node_modules/.bin/prisma generate
```
Expected: "in sync" + "Generated Prisma Client".

- [ ] **Step 3: types.ts.** Add the types (above `UserRecord`) and extend `UserRecord` + `update`:
```ts
export type KycStatus = "pending" | "approved" | "rejected";
export interface KycDetails {
  legalName?: string;
  country?: string;
  idType?: string;
  idNumber?: string;
  documentRef?: string;
}
```
In `UserRecord`, after `active: boolean;`:
```ts
  kycStatus: KycStatus;
  kyc: KycDetails | null;
```
In `UserRepository.update`, widen the patch:
```ts
  update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus">>): Promise<UserRecord>;
```

- [ ] **Step 4: Failing repo test.** In `apps/api/test/user-repo.test.ts`, update the `MemoryUserRepository` create calls to include the new fields and assert kyc round-trips + status update. Replace the two `repo.create({...})` calls' object literals to add `kycStatus: "approved", kyc: null` (first) / `kycStatus: "pending", kyc: { legalName: "B" }` (second), and add before the `remove`:
```ts
    expect((await repo.findById(a.id))?.kycStatus).toBe("approved");
    const bRec = (await repo.list("gold-loan"))[0];
    expect(bRec?.kyc?.legalName).toBe("B");
    const approved = await repo.update(a.id, { kycStatus: "rejected" });
    expect(approved.kycStatus).toBe("rejected");
```
(Adjust the existing assertions if the second user's email/use case differ — keep them consistent with the file.)

- [ ] **Step 5: Run; expect FAIL.** `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/user-repo.test.ts` (type error: UserRecord lacks kycStatus/kyc; update rejects kycStatus).

- [ ] **Step 6: prisma.ts.** Extend `toUser`'s parameter type with `kycStatus: string; kyc: string | null;` and its output:
```ts
  active: r.active,
  kycStatus: r.kycStatus as KycStatus,
  kyc: r.kyc ? (JSON.parse(r.kyc) as KycDetails) : null,
  createdAt: r.createdAt.toISOString(),
```
Add `KycStatus, KycDetails` to the type import from `./types.js`. In `create`, serialise `kyc`:
```ts
  async create(input: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord> {
    return toUser(await prisma.user.create({ data: { ...input, kyc: input.kyc ? JSON.stringify(input.kyc) : null } }));
  }
```
(`update`'s patch only ever carries `passwordHash`/`accountId`/`active`/`kycStatus` — all scalar — so `prisma.user.update({ where, data: patch })` is unchanged.)

- [ ] **Step 7: memory.ts.** No body change needed — `create` stores `{ ...input }` (kyc stays an object) and `update`'s `Object.assign` handles `kycStatus`. Confirm the `update` signature still matches the widened interface (it uses the same `Partial<Pick<...>>` — widen its annotation to include `"kycStatus"`).

- [ ] **Step 8: seed.ts.** The `users.create({...})` call now needs the new required fields. Add to that object:
```ts
      active: true,
      kycStatus: "approved",
      kyc: null,
```

- [ ] **Step 9: Run repo test + typecheck.** `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/user-repo.test.ts` → PASS. `./node_modules/.bin/tsc --noEmit -p apps/api` → only the `POST /users` create call in routes.ts errors (missing kycStatus/kyc — fixed in Task 2). Confirm that's the only error.

- [ ] **Step 10: Commit.**
```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types.ts apps/api/src/persistence/prisma.ts apps/api/src/persistence/memory.ts apps/api/src/seed.ts apps/api/test/user-repo.test.ts
git commit -m "feat(api): add kycStatus + kyc to User through schema + repos"
```

---

## Task 2: API — onboarding pending, approve/reject, allow-gate

**Files:** `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`, `apps/api/test/api.test.ts`

- [ ] **Step 1: Failing tests.** In `apps/api/test/api.test.ts`, inside the `describe("per-use-case tenancy", ...)` block add:
```ts
  it("KYC: onboard pending, gate allowlist until approved, ungated for unlinked wallets", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const wallet = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"; // not linked by the seed
    const created = (await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${admin}` }, payload: { email: "kyc.buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: wallet, kyc: { legalName: "K Buyer", country: "IN", idType: "Passport", idNumber: "X1", documentRef: "doc://1" } } })).json();
    expect(created.kycStatus).toBe("pending");
    const id = await issueAsset(app, platform, "carbon-credit");
    const blocked = await app.inject({ method: "POST", url: `${V1}/assets/${id}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: wallet } });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toBe("KYC_NOT_APPROVED");
    // an address with no linked user is ungated
    const free = await app.inject({ method: "POST", url: `${V1}/assets/${id}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" } });
    expect(free.statusCode).toBe(200);
    // approve → allow now succeeds
    const appr = await app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { kycStatus: "approved" } });
    expect(appr.json().kycStatus).toBe("approved");
    const allowed = await app.inject({ method: "POST", url: `${V1}/assets/${id}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: wallet } });
    expect(allowed.statusCode).toBe(200);
  });
```

- [ ] **Step 2: Run; expect FAIL.** `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/api.test.ts` (created.kycStatus undefined; allow not gated).

- [ ] **Step 3: POST /users — pending + kyc.** In the `POST /users` handler, widen the body type and the create call + response:
```ts
    const b = request.body as { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; kyc?: import("../persistence/types.js").KycDetails };
```
In the `deps.users.create({...})` object add:
```ts
      active: true,
      kycStatus: "pending",
      kyc: b.kyc ?? null,
```
And the response — add `kycStatus: created.kycStatus`:
```ts
    return reply.code(201).send({ id: created.id, email: created.email, role: created.role, useCaseKey: created.useCaseKey, accountId: created.accountId, kycStatus: created.kycStatus });
```

- [ ] **Step 4: PATCH /users/:id — kycStatus.** Widen the body and patch:
```ts
    const b = request.body as { password?: string; active?: boolean; kycStatus?: "approved" | "rejected" };
```
After the `if (typeof b.active === "boolean")` line:
```ts
    if (b.kycStatus === "approved" || b.kycStatus === "rejected") patch.kycStatus = b.kycStatus;
```
Widen the local `patch` type to include `kycStatus?: KycStatus` — import `KycStatus` from `../persistence/types.js` at the top, and:
```ts
    const patch: { passwordHash?: string; active?: boolean; kycStatus?: KycStatus } = {};
```
Add `kycStatus: updated.kycStatus` to the response object.

- [ ] **Step 5: GET /users — expose kyc.** In the `GET /users` `.map(...)`, add `kycStatus: u.kycStatus, kyc: u.kyc`:
```ts
    return rows.map((u) => ({ id: u.id, email: u.email, role: u.role, useCaseKey: u.useCaseKey, accountId: u.accountId, active: u.active, kycStatus: u.kycStatus, kyc: u.kyc }));
```

- [ ] **Step 6: Allow-gate.** In the action route, replace the `allow` case with a braced block that resolves the wallet's owner and blocks if not approved:
```ts
      case "allow": {
        const acct = (await deps.accounts.list()).find((a) => a.address === b.account);
        if (acct) {
          const owner = (await deps.users.list()).find((u) => u.accountId === acct.id);
          if (owner && owner.kycStatus !== "approved") {
            return reply.code(400).send({ error: "KYC_NOT_APPROVED", message: "the wallet owner has not completed KYC approval" });
          }
        }
        receipt = await deps.engine.setAllowed(actor, ctx, b.account!, true);
        break;
      }
```
(Leave `disallow` unchanged.)

- [ ] **Step 7: Schemas.** In `apps/api/src/http/schemas.ts`:
`createUser` body `properties` — add:
```ts
        kyc: {
          type: "object",
          additionalProperties: false,
          properties: { legalName: { type: "string" }, country: { type: "string" }, idType: { type: "string" }, idNumber: { type: "string" }, documentRef: { type: "string" } },
        },
```
`updateUser` body `properties` — add:
```ts
        kycStatus: { type: "string", enum: ["approved", "rejected"] },
```

- [ ] **Step 8: Run tests + typecheck.** `cd apps/api && CI=true ../../node_modules/.bin/vitest run` → all pass (existing + new). `./node_modules/.bin/tsc --noEmit -p apps/api` → clean.

- [ ] **Step 9: Commit.**
```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/api.test.ts
git commit -m "feat(api): onboard users as KYC-pending, approve/reject, gate allowlist on KYC"
```

---

## Task 3: Web — Add User KYC fields + Manage Users approve/reject

**Files:** `apps/web/src/api.ts`, `apps/web/src/components/UserManagement.tsx`

- [ ] **Step 1: api.ts.** Update the three methods:
```ts
  users: (token: string) => request<{ id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null; active: boolean; kycStatus: "pending" | "approved" | "rejected"; kyc: { legalName?: string; country?: string; idType?: string; idNumber?: string; documentRef?: string } | null }[]>("/users", token),
  createUser: (token: string, input: { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; kyc?: { legalName?: string; country?: string; idType?: string; idNumber?: string; documentRef?: string } }) =>
    request<{ id: string; email: string; role: Role }>("/users", token, { method: "POST", body: JSON.stringify(input) }),
  updateUser: (token: string, id: string, patch: { password?: string; active?: boolean; kycStatus?: "approved" | "rejected" }) =>
    request<{ id: string }>(`/users/${id}`, token, { method: "PATCH", body: JSON.stringify(patch) }),
```
(Keep `deleteUser` unchanged.)

- [ ] **Step 2: UserManagement.tsx — Summary type + AddUser KYC fields.** Update the `Summary` type to add `active`, `kycStatus`, `kyc` if not present:
```ts
type Summary = { id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null; active: boolean; kycStatus: "pending" | "approved" | "rejected"; kyc: { legalName?: string; country?: string; idType?: string; idNumber?: string; documentRef?: string } | null };
```
In `AddUser`, add KYC state + inputs and include them in the create payload. Add state near the others:
```ts
  const [legalName, setLegalName] = useState("");
  const [country, setCountry] = useState("");
  const [idType, setIdType] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [documentRef, setDocumentRef] = useState("");
```
Change the `api.createUser(...)` call to include `kyc`:
```ts
      await api.createUser(token!, { email, password, role, useCaseKey: isPlatform ? selUseCase : undefined, walletAddress: needsWallet ? walletAddress : undefined, kyc: { legalName, country, idType, idNumber, documentRef } });
```
After the existing grid of inputs (before the error `<p>`), add a KYC fieldset:
```tsx
      <div className="border-t border-slate-100 pt-3">
        <p className="text-xs font-semibold text-slate-500 mb-2">KYC / onboarding (reviewed before the user can transact)</p>
        <div className="grid grid-cols-2 gap-4">
          <input className="input" placeholder="legal name" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
          <input className="input" placeholder="country" value={country} onChange={(e) => setCountry(e.target.value)} />
          <input className="input" placeholder="ID type (e.g. Passport)" value={idType} onChange={(e) => setIdType(e.target.value)} />
          <input className="input" placeholder="ID number" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
          <input className="input col-span-2" placeholder="document reference (URL/ref)" value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} />
        </div>
      </div>
```
Clear them on success (add to the existing reset): `setLegalName(""); setCountry(""); setIdType(""); setIdNumber(""); setDocumentRef("");`

- [ ] **Step 3: UserManagement.tsx — ManageUsers KYC column + approve/reject.** In the `ManageUsers` table header add a `KYC` column header after `Status`:
```tsx
<th className="text-left px-4 py-2">KYC</th>
```
In each row, after the status `<td>`, add a KYC badge cell:
```tsx
                <td className="px-4 py-2">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${u.kycStatus === "approved" ? "bg-emerald-100 text-emerald-700" : u.kycStatus === "rejected" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`} title={u.kyc?.legalName ? `${u.kyc.legalName}${u.kyc.country ? " · " + u.kyc.country : ""}` : ""}>{u.kycStatus}</span>
                </td>
```
In the actions cell (`manageable(u)` branch), add Approve/Reject buttons before the Edit/Revoke/Delete group:
```tsx
                      {u.kycStatus !== "approved" && <button onClick={() => act(() => api.updateUser(token!, u.id, { kycStatus: "approved" }))} className="text-xs text-emerald-600 hover:text-emerald-700">Approve</button>}
                      {u.kycStatus !== "rejected" && <button onClick={() => act(() => api.updateUser(token!, u.id, { kycStatus: "rejected" }))} className="text-xs text-red-500 hover:text-red-700">Reject</button>}
```
(The colspan of any empty-state row, if present, should be bumped to match the new column count — verify the table still renders.)

- [ ] **Step 4: Typecheck.** `./node_modules/.bin/tsc --noEmit -p apps/web` → zero errors.

- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/api.ts apps/web/src/components/UserManagement.tsx
git commit -m "feat(web): KYC fields on Add User + approve/reject in Manage Users"
```

---

## Task 4: Verify + docs

**Files:** `README.md`

- [ ] **Step 1: Full verification.**
```bash
./node_modules/.bin/tsc --noEmit -p packages/core && ./node_modules/.bin/tsc --noEmit -p apps/api && ./node_modules/.bin/tsc --noEmit -p apps/web
cd packages/core && CI=true ../../node_modules/.bin/vitest run && cd ../..
cd apps/api && CI=true ../../node_modules/.bin/vitest run && cd ../..
cd apps/api && rm -f prisma/dev.db && ./node_modules/.bin/prisma db push --skip-generate && ../../node_modules/.bin/tsx src/seed.ts && ../../node_modules/.bin/tsx src/e2e-tenancy.ts && ../../node_modules/.bin/tsx src/e2e-carbon.ts
```
All must pass (e2e banners present). The e2e scripts allowlist wallets of seeded `approved` users, so the KYC gate does not block them.

- [ ] **Step 2: README.** In the User Management description, add a line: onboarding captures KYC (legal name, country, ID type/number, document reference); new users start KYC `pending` and a UseCaseAdmin/PlatformAdmin Approves/Rejects in Manage Users; a wallet can only be allowlisted once its owner is KYC-approved.

- [ ] **Step 3: Live preview** (controller does this): add a Buyer with KYC (pending) as `carbon.admin`; confirm allowlisting their wallet is blocked; Approve in Manage Users; confirm allowlist then succeeds.

- [ ] **Step 4: Commit.**
```bash
git add README.md
git commit -m "docs: KYC onboarding in User Management"
```

---

## Self-review notes
- **Spec coverage:** data model §1 → Task 1; API + gate §2 → Task 2; web §3 → Task 3; seed/compat §4 + testing §5 → Tasks 1/2/4. All covered.
- **Type consistency:** `KycStatus`/`KycDetails` defined in types.ts (Task 1) and reused in routes (Task 2) and mirrored inline in api.ts/UserManagement (Task 3); `kycStatus`/`kyc` field names consistent across persistence, API responses, and web; the `allow` gate uses `accountId` matching consistent with the existing account model.
- **No placeholders:** every code step is complete.
- **Compat:** DB default `approved` + seed passing `approved` keeps all existing tests/e2e green; gate only affects linked, non-approved users.
