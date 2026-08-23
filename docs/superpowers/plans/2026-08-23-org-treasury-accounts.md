# Org-Owned Treasury Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every use case has a registered, org-owned treasury account, so "who owns this treasury" is a stored fact instead of a free-text convention — and every use case has an owning organization, closing the "platform-owned, no org" case.

**Architecture:** `Account` gains an optional `ownerOrgId`; `UseCase` gains `treasuryAccountId` and its existing `ownerOrgId` becomes required. A treasury is auto-provisioned the moment a use case is created — by the org self-service route, by the PlatformAdmin direct-create route, by the proposal executor that creates an OrgAdmin's approved use case, and by boot-time seeding of the platform demo use cases (which now also gain an owner: the existing "TokenLayer Platform" org). `treasuryAccount` is removed from every client-facing write that currently accepts it — issuance, `setPrice`, and batch invoice tokenization all derive it from the use case instead.

**Tech Stack:** Fastify 5, Prisma/SQLite, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-org-treasury-accounts-design.md`

## Global Constraints

- **THE PARITY RULE.** A new persisted field lands in the Prisma schema, the record type, the mapper, and **both** repositories (memory and prisma), in one commit. `apps/api/test/persistence-parity.test.ts` fails otherwise.
- **THE ADDITIVITY RULE.** `fast-json-stringify` silently strips response fields absent from the schema. A new field on a response needs its schema entry, and every object node needs `additionalProperties: true`.
- **NEVER touch `apps/api/prisma/dev.db*` directly.** Migrations go through `prisma migrate dev`; the live databases pick the schema up via `prisma db push` at container boot, same as every other schema change this session.
- **No existing behavioural test may be edited**, except where its own subject is what this plan removes (`treasuryAccount` as client input) — narrow that edit to the fixture/assertion touching the removed field, nothing else in the test.
- Run `npx tsc --noEmit -p apps/api` bare, never piped through `grep` — a filtered-to-nothing pipe exits 1 and reads as a false failure.
- Full suite: `npx vitest run apps/api packages/core apps/web --testTimeout=45000 --hookTimeout=45000`.

---

### Task 1: Schema, types, and both repositories — `Account.ownerOrgId`, `UseCase.treasuryAccountId`, `UseCase.ownerOrgId` required

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `packages/core/src/shared/types.ts:168` (`UseCaseDefinition`)
- Modify: `apps/api/src/persistence/types/tokenization.ts:36-41` (`AccountRecord`), `:58-62` (`AccountRepository`)
- Modify: `apps/api/src/persistence/memory/tokenization.ts:223-241` (`MemoryAccountRepository`)
- Modify: `apps/api/src/persistence/prisma/tokenization.ts:83-98` (`PrismaAccountRepository`)
- Test: `apps/api/test/user-repo.test.ts` (Account repo tests already live here)
- Test: `apps/api/test/persistence-parity.test.ts` (no edit — must stay green)

**Interfaces:**
- Produces: `AccountRecord.ownerOrgId: string | null`; `AccountRepository.upsert(address, label, ownerOrgId?)`; `UseCaseDefinition.ownerOrgId: string` (was `string | undefined`), `UseCaseDefinition.treasuryAccountId?: string`.

- [ ] **Step 1: Write the failing test for `upsert`'s new parameter**

```ts
// apps/api/test/user-repo.test.ts — inside describe("MemoryAccountRepository")
it("upsert stamps ownerOrgId when supplied, and leaves it null otherwise", async () => {
  const repo = new MemoryAccountRepository();
  const personal = await repo.upsert("0xaaa", "buyer wallet");
  expect(personal.ownerOrgId).toBeNull();
  const treasury = await repo.upsert("0xbbb", "carbon-credit treasury", "org_1");
  expect(treasury.ownerOrgId).toBe("org_1");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run apps/api/test/user-repo.test.ts -t "upsert stamps ownerOrgId" --testTimeout=45000
```
Expected: FAIL — `ownerOrgId` is `undefined`, not `null`, or a TS error if `upsert` rejects a third argument (depends on whether the test file compiles before the type change; either failure is correct RED).

- [ ] **Step 3: Edit the schema**

In `apps/api/prisma/schema.prisma`, `model Account`:
```prisma
model Account {
  id         String  @id @default(cuid())
  address    String  @unique
  label      String
  ownerOrgId String? // the organization this treasury belongs to; null for a personal wallet
}
```

`model UseCase`, change the existing `ownerOrgId String?` line (with its "legacy platform-owned" comment) to:
```prisma
  ownerOrgId        String  // every use case has an owning organization now
  treasuryAccountId String? // this use case's registered treasury Account
```

- [ ] **Step 4: Update the core type**

In `packages/core/src/shared/types.ts:168`, change:
```ts
  ownerOrgId?: string;
```
to:
```ts
  ownerOrgId: string;
  treasuryAccountId?: string;
```

- [ ] **Step 5: Update the persistence type**

In `apps/api/src/persistence/types/tokenization.ts`:
```ts
export interface AccountRecord {
  id: string;
  address: string;
  label: string;
  ownerOrgId: string | null;
}
```
And the repository interface:
```ts
export interface AccountRepository {
  list(): Promise<AccountRecord[]>;
  findById(id: string): Promise<AccountRecord | null>;
  findByAddress(address: string): Promise<AccountRecord | null>;
  upsert(address: string, label: string, ownerOrgId?: string): Promise<AccountRecord>;
}
```

- [ ] **Step 6: Update the memory repository**

In `apps/api/src/persistence/memory/tokenization.ts`, `MemoryAccountRepository`:
```ts
export class MemoryAccountRepository implements AccountRepository {
  private readonly byAddress = new Map<string, AccountRecord>();
  async list(): Promise<AccountRecord[]> {
    return [...this.byAddress.values()];
  }
  async findById(accountId: string): Promise<AccountRecord | null> {
    return [...this.byAddress.values()].find((a) => a.id === accountId) ?? null;
  }
  async findByAddress(address: string): Promise<AccountRecord | null> {
    return this.byAddress.get(address) ?? null;
  }
  async upsert(address: string, label: string, ownerOrgId?: string): Promise<AccountRecord> {
    const existing = this.byAddress.get(address);
    if (existing) {
      existing.label = label;
      if (ownerOrgId !== undefined) existing.ownerOrgId = ownerOrgId;
      return existing;
    }
    const rec: AccountRecord = { id: id("acct"), address, label, ownerOrgId: ownerOrgId ?? null };
    this.byAddress.set(address, rec);
    return rec;
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
npx vitest run apps/api/test/user-repo.test.ts -t "upsert stamps ownerOrgId" --testTimeout=45000
```
Expected: PASS.

- [ ] **Step 8: Update the Prisma repository**

In `apps/api/src/persistence/prisma/tokenization.ts`:
```ts
  async findById(id: string): Promise<AccountRecord | null> {
    const r = await prisma.account.findUnique({ where: { id } });
    return r ? { id: r.id, address: r.address, label: r.label, ownerOrgId: r.ownerOrgId } : null;
  }
  async findByAddress(address: string): Promise<AccountRecord | null> {
    const r = await prisma.account.findUnique({ where: { address } });
    return r ? { id: r.id, address: r.address, label: r.label, ownerOrgId: r.ownerOrgId } : null;
  }
  async upsert(address: string, label: string, ownerOrgId?: string): Promise<AccountRecord> {
    return prisma.account.upsert({
      where: { address },
      update: { label, ...(ownerOrgId !== undefined ? { ownerOrgId } : {}) },
      create: { address, label, ownerOrgId: ownerOrgId ?? null },
    });
  }
```
(`list()` at the top of the file returns `prisma.account.findMany()` directly and needs no change — Prisma's generated row shape already carries `ownerOrgId` once the migration below runs.)

- [ ] **Step 9: Generate the migration**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/api"
npx prisma migrate dev --name org_treasury_accounts
```
Expected: applies cleanly. `UseCase.ownerOrgId` going from nullable to required on a table that may already hold NULL rows will make Prisma ask for either a default or a manual data-fill step — answer with a temporary placeholder value (e.g. an empty string) for the migration to apply against the dev database; Task 6's backfill is what gives every row a REAL org id afterward, so this default is transitional, not a design decision.

- [ ] **Step 10: Regenerate the client and compile**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI"
pnpm --filter @tokenlayer/api exec prisma generate
npx tsc --noEmit -p apps/api
```
Expected: **many** errors — every place that constructs a `UseCaseDefinition` without `ownerOrgId`, and every caller of `deployAndCreateUseCase`/`seedUseCases`. This is expected; Tasks 3-4 fix them. Confirm the errors are all in the files this plan already names (`use-cases.ts`, `usecase-kinds.ts`, `tokenization.ts` route, `server.ts`, the five `dev/*.ts` scripts) — if `tsc` names a file not on that list, note it and extend Task 4's file list before continuing.

- [ ] **Step 11: Commit**

```bash
git add apps/api/prisma packages/core/src/shared/types.ts apps/api/src/persistence apps/api/test/user-repo.test.ts
git commit -m "feat(treasury): Account.ownerOrgId, UseCase.treasuryAccountId, UseCase.ownerOrgId required"
```

(The build stays red until Task 4 — that is expected for this one task, and the reason every later task in this plan runs `tsc` again before its own commit.)

---

### Task 2: `provisionTreasury` helper

**Files:**
- Modify: `apps/api/src/shared/wallets.ts`
- Test: `apps/api/test/wallets.test.ts`

**Interfaces:**
- Consumes: `AccountRepository.upsert(address, label, ownerOrgId?)` from Task 1.
- Produces: `provisionTreasury(deps: Pick<AppDeps, "accounts">, ownerOrgId: string, label: string): Promise<string>` — returns the new `Account.id`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/wallets.test.ts
import { provisionTreasury } from "../src/shared/wallets.js";

describe("provisionTreasury", () => {
  it("creates an org-owned account and returns its id", async () => {
    const accounts = new MemoryAccountRepository();
    const id = await provisionTreasury({ accounts }, "org_1", "carbon-credit treasury");
    const acct = await accounts.findById(id);
    expect(acct?.ownerOrgId).toBe("org_1");
    expect(acct?.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(acct?.label).toBe("carbon-credit treasury");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run apps/api/test/wallets.test.ts -t "provisionTreasury" --testTimeout=45000
```
Expected: FAIL — `provisionTreasury is not a function`.

- [ ] **Step 3: Implement it**

In `apps/api/src/shared/wallets.ts`, alongside `resolveAccountId`:
```ts
/** Auto-provisions a fresh, org-owned treasury Account. One per use case —
 *  called by every path that creates one (org self-service, PlatformAdmin
 *  direct-create, the create-use-case proposal executor, and boot seeding). */
export async function provisionTreasury(
  deps: Pick<AppDeps, "accounts">, ownerOrgId: string, label: string,
): Promise<string> {
  const address = "0x" + randomBytes(20).toString("hex");
  const account = await deps.accounts.upsert(address, label, ownerOrgId);
  return account.id;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run apps/api/test/wallets.test.ts -t "provisionTreasury" --testTimeout=45000
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/shared/wallets.ts apps/api/test/wallets.test.ts
git commit -m "feat(treasury): provisionTreasury helper"
```

---

### Task 3: Wire provisioning into use-case creation — the route and the proposal executor

**Files:**
- Modify: `apps/api/src/http/routes/tokenization.ts:99-154` (`POST /use-cases`)
- Modify: `apps/api/src/tokenization/usecase-kinds.ts` (`createUseCaseKind.execute`)
- Test: `apps/api/test/organizations.test.ts` (org self-service use-case creation lives near the org tests already touched this session)

**Interfaces:**
- Consumes: `provisionTreasury` from Task 2; `ensurePlatformIssuerOrg` (`apps/api/src/shared/platform-org.ts:54`, already imported in `tokenization.ts:30`).
- Produces: every use case created through either path now has `ownerOrgId` and `treasuryAccountId` set before `deployAndCreateUseCase` persists it.

- [ ] **Step 1: Write the failing test for the OrgAdmin path**

```ts
// apps/api/test/organizations.test.ts — new describe block
describe("POST /use-cases (org self-service) — treasury provisioning", () => {
  it("an OrgAdmin-created use case gets a treasury owned by their org", async () => {
    const org = (await createOrg(admin, { name: "Treasury Test Org", orgType: "corporate" })).json();
    const orgAdminRes = await app.inject({
      method: "POST", url: `${V1}/orgs/${org.id}/users`, headers: auth(admin),
      payload: { email: `oa.${org.id}@x.io`, password: "secret1", role: "OrgAdmin" },
    });
    const orgAdminToken = await loginAs(app, `oa.${org.id}@x.io`, "secret1");
    const propose = await app.inject({
      method: "POST", url: `${V1}/use-cases`, headers: auth(orgAdminToken),
      payload: {
        key: `treasury-test-${org.id}`, name: "Treasury Test", symbol: "TRT", tokenStandard: "erc20",
        allowedChainIds: ["fabric"], defaultChainId: "fabric",
        compliance: { allowlist: true }, workflow: {},
      },
    });
    expect(propose.statusCode).toBe(202);
    const executed = await app.inject({
      method: "POST", url: `${V1}/proposals/${propose.json().proposal.id}/approve`,
      headers: auth(admin), payload: {},
    });
    expect(executed.statusCode).toBe(200);
    const uc = await app.inject({ method: "GET", url: `${V1}/use-cases/treasury-test-${org.id}`, headers: auth(admin) });
    expect(uc.json().ownerOrgId).toBe(org.id);
    expect(uc.json().treasuryAccountId).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run apps/api/test/organizations.test.ts -t "treasury provisioning" --testTimeout=45000
```
Expected: FAIL — `treasuryAccountId` is `undefined`/absent (and this whole task also unblocks the `tsc` errors Task 1 left behind for these two files).

- [ ] **Step 3: Fix the proposal executor**

In `apps/api/src/tokenization/usecase-kinds.ts`, import `provisionTreasury` and call it before `deployAndCreateUseCase`:
```ts
import { provisionTreasury } from "../shared/wallets.js";
```
```ts
    const available = new Set(ctx.deps.chains.list().map((c) => c.id));
    const treasuryAccountId = await provisionTreasury(ctx.deps, def.ownerOrgId, `${def.name} treasury`);
    // Deploy + persist via the shared helper so the NO_DEPLOYABLE_CHAIN surface
    // stays identical to the PlatformAdmin direct-create path.
    await deployAndCreateUseCase(
      ctx.deps.useCases,
      { ...def, treasuryAccountId },
      available,
      (d, chainId) => ctx.deps.engine.deployUseCaseContract(d, chainId),
      (m) => ctx.log.error({ err: m }, "use-case contract deploy skipped"),
    );
```

- [ ] **Step 4: Fix the PlatformAdmin direct-create route**

In `apps/api/src/http/routes/tokenization.ts`, right before the existing `const available = new Set(deps.chains.list().map((c) => c.id));` at line 145 (the PlatformAdmin path, reached only after the `if (claims.role === "OrgAdmin")` block returns early):
```ts
    // PlatformAdmin may name an owning org explicitly in the body; absent one,
    // the use case belongs to the platform's own org — the same fallback
    // identity issuance already uses when a credential use case has no owner.
    const ownerOrgId = definition.ownerOrgId ?? (await ensurePlatformIssuerOrg(deps)).id;
    const treasuryAccountId = await provisionTreasury(deps, ownerOrgId, `${definition.name} treasury`);
    const available = new Set(deps.chains.list().map((c) => c.id));
    const created = await deployAndCreateUseCase(
      deps.useCases,
      { ...definition, ownerOrgId, treasuryAccountId },
      available,
      (def, chainId) => deps.engine.deployUseCaseContract(def, chainId),
      (m) => request.log.warn(m),
    );
```
Add the import:
```ts
import { provisionTreasury } from "../../shared/wallets.js";
```

- [ ] **Step 5: Run it to verify it passes**

```bash
npx vitest run apps/api/test/organizations.test.ts -t "treasury provisioning" --testTimeout=45000
```
Expected: PASS.

- [ ] **Step 6: Confirm tsc is clean for these two files**

```bash
npx tsc --noEmit -p apps/api
```
Expected: the errors Task 1 left in `usecase-kinds.ts` and the `tokenization.ts` route are gone. Errors in `use-cases.ts`, `server.ts`, and `dev/*.ts` remain — Task 4 fixes those.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/routes/tokenization.ts apps/api/src/tokenization/usecase-kinds.ts apps/api/test/organizations.test.ts
git commit -m "feat(treasury): provision a treasury when a use case is created (both paths)"
```

---

### Task 4: `seedUseCases` gains an owner and a treasury — boot, plus every dev-script caller

**Files:**
- Modify: `apps/api/src/tokenization/use-cases.ts:63-102` (`seedUseCases`)
- Modify: `apps/api/src/server.ts` (boot order: `ensurePlatformIssuerOrg` before `seedUseCases`)
- Modify: `apps/api/src/dev/e2e-tenancy.ts`, `apps/api/src/dev/demo.ts`, `apps/api/src/dev/e2e-carbon.ts`, `apps/api/src/dev/e2e-buy.ts`, `apps/api/src/dev/e2e-usecases.ts`
- Test: `apps/api/test/*.ts` — a new boot-sequencing test (new file: `apps/api/test/treasury-boot-seed.test.ts`)

**Interfaces:**
- Consumes: `provisionTreasury` from Task 2, `ensurePlatformIssuerOrg` from `platform-org.ts`.
- Produces: `seedUseCases(repo, ownerOrgId: string, provisionTreasury: (label: string) => Promise<string>, wiring?)` — two new required parameters ahead of the existing optional `wiring`.

- [ ] **Step 1: Write the failing boot-sequencing test**

```ts
// apps/api/test/treasury-boot-seed.test.ts
import { describe, expect, it } from "vitest";
import { MemoryUseCaseRepository, MemoryOrganizationRepository, MemoryAccountRepository } from "../src/persistence/memory/index.js";
import { seedUseCases } from "../src/tokenization/use-cases.js";
import { ensurePlatformIssuerOrg } from "../src/shared/platform-org.js";
import { provisionTreasury } from "../src/shared/wallets.js";
import { createKeystore } from "../src/shared/keystore.js";

describe("seedUseCases — every platform-seeded use case gets an owner and a treasury", () => {
  it("stamps the Platform org and a provisioned treasury on every seeded use case", async () => {
    const useCases = new MemoryUseCaseRepository();
    const organizations = new MemoryOrganizationRepository();
    const accounts = new MemoryAccountRepository();
    const keystore = createKeystore("11".repeat(32));
    const platformOrg = await ensurePlatformIssuerOrg({ organizations, keystore, registry: undefined });
    await seedUseCases(useCases, platformOrg.id, (label) => provisionTreasury({ accounts }, platformOrg.id, label));
    const carbon = await useCases.get("carbon-credit");
    expect(carbon.ownerOrgId).toBe(platformOrg.id);
    expect(carbon.treasuryAccountId).not.toBeUndefined();
    const acct = await accounts.findById(carbon.treasuryAccountId!);
    expect(acct?.ownerOrgId).toBe(platformOrg.id);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run apps/api/test/treasury-boot-seed.test.ts --testTimeout=45000
```
Expected: a TS/runtime error — `seedUseCases` does not yet accept these arguments.

- [ ] **Step 3: Change `seedUseCases`'s signature**

In `apps/api/src/tokenization/use-cases.ts`:
```ts
export async function seedUseCases(
  repo: UseCaseRepository,
  ownerOrgId: string,
  provisionTreasury: (label: string) => Promise<string>,
  wiring?: {
    availableChainIds: ReadonlySet<string>;
    simulatedChainIds?: ReadonlySet<string>;
    deploy: (def: UseCaseDefinition, chainId: string) => Promise<UseCaseContract>;
  },
): Promise<void> {
  for (const def of loadDefaultUseCaseDefinitions()) {
    if (await repo.has(def.key)) {
      if (wiring) await redeployOnSimulatedChains(repo, def, wiring);
      continue;
    }
    let contracts: Record<string, UseCaseContract> = {};
    if (wiring) {
      contracts = await deployUseCaseContracts(def, wiring.availableChainIds, wiring.deploy);
      if (Object.keys(contracts).length === 0) {
        console.warn(`[use-cases] seeded '${def.key}' with no deployed contracts (no allowed chain available) — pending`);
      }
    }
    const treasuryAccountId = await provisionTreasury(`${def.name} treasury`);
    await repo.create({ ...def, ownerOrgId, treasuryAccountId, contracts });
  }
}
```
(An already-existing use case, hit on a warm restart, takes the `continue` branch and is never re-provisioned here — that is Task 6's backfill's job, not this function's, exactly as the spec's migration section describes.)

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run apps/api/test/treasury-boot-seed.test.ts --testTimeout=45000
```
Expected: PASS.

- [ ] **Step 5: Fix `server.ts`'s boot order**

In `apps/api/src/server.ts`, `ensurePlatformIssuerOrg(deps)` currently runs at line 182, after `seedUseCases` at line 112. Move the platform-org resolution earlier and thread it through:
```ts
  // Resolved BEFORE seedUseCases now: every seeded use case needs an owner.
  const platformOrg = await ensurePlatformIssuerOrg(deps);
```
placed immediately before the existing `if (env.enabledDomains.includes("tokenization")) {` block, and change the call inside it to:
```ts
    await seedUseCases(
      useCases,
      platformOrg.id,
      (label) => provisionTreasury(deps, platformOrg.id, label),
      {
        availableChainIds: new Set(chains.list().map((c) => c.id)),
        simulatedChainIds: new Set(chains.list().filter((c) => c.mode === "simulated").map((c) => c.id)),
        deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
      },
    );
```
Remove the now-duplicate `const platformOrg = await ensurePlatformIssuerOrg(deps);` further down at the old line 182 (every later use of `platformOrg` in that file now reads the one resolved earlier). Add the import:
```ts
import { provisionTreasury } from "./shared/wallets.js";
```

- [ ] **Step 6: Fix the five dev-script callers**

Each of `apps/api/src/dev/e2e-tenancy.ts`, `demo.ts`, `e2e-carbon.ts`, `e2e-buy.ts`, `e2e-usecases.ts` constructs its own `accounts` repository already and calls `createKeystore(...)` inline for `buildApp`'s `keystore` option. In each file, hoist an `organizations` repository and a `keystore` constant above the `seedUseCases` call (if not already hoisted — several already build `accounts` as a named local), resolve the platform org, and pass the same two new arguments:
```ts
const organizations = new MemoryOrganizationRepository();
const keystore = createKeystore("11".repeat(32));
const platformOrg = await ensurePlatformIssuerOrg({ organizations, keystore, registry: undefined });
await seedUseCases(useCases, platformOrg.id, (label) => provisionTreasury({ accounts }, platformOrg.id, label), {
  availableChainIds: new Set(chains.list().map((c) => c.id)),
  deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
});
```
Then pass the SAME `organizations` instance (not a second `new MemoryOrganizationRepository()`) into the file's `buildApp({...})` call, replacing whatever inline `organizations: new MemoryOrganizationRepository()` it currently has — otherwise the app serves a different, empty organizations store than the one the platform org was seeded into. Add the two imports (`ensurePlatformIssuerOrg` from `../shared/platform-org.js`, `provisionTreasury` from `../shared/wallets.js`) to each file that does not already have them.

- [ ] **Step 7: Compile everything**

```bash
npx tsc --noEmit -p apps/api
```
Expected: clean. If any error remains outside the files this task and Task 3 named, read it and fix it here before moving on — Task 1's Step 10 was the early-warning check; this is where it must actually be zero.

- [ ] **Step 8: Run the full boot-relevant test slice**

```bash
npx vitest run apps/api/test/treasury-boot-seed.test.ts apps/api/test/onboarding.test.ts apps/api/test/organizations.test.ts --testTimeout=45000
```
Expected: all pass (these three exercise boot-time seeding and both use-case creation paths).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/tokenization/use-cases.ts apps/api/src/server.ts apps/api/src/dev apps/api/test/treasury-boot-seed.test.ts
git commit -m "feat(treasury): seedUseCases stamps an owner and a treasury on every platform use case"
```

---

### Task 5: Issuance, `setPrice`, and batch tokenization derive the treasury instead of accepting it

**Files:**
- Modify: `apps/api/src/http/routes/tokenization.ts:254-283` (`issueAssetCore`), `:557-570` (`POST /use-cases/:key/invoices/tokenize`), the `setPrice` action branch (~line 792)
- Modify: `apps/api/src/http/schemas/tokenization.ts` (three schema sites carrying `treasuryAccount`: the create-asset body incl. nested `sale.treasuryAccount` ~line 109/118, the asset-actions `setPrice` shape ~line 213, `tokenizeInvoices` ~line 577/581)
- Test: `apps/api/test/api.test.ts` (issuance/setPrice tests already live here — narrow edits to fixtures that supply `treasuryAccount`, per the Global Constraints exception)
- Test: `apps/api/test/invoice-lifecycle*.test.ts` or wherever `tokenizeInvoices` is exercised — grep for the actual file before editing

**Interfaces:**
- Consumes: `useCase.treasuryAccountId` (Task 1) resolved to an `Account.address` (Task 1's `AccountRepository.findById`, already existing).
- Produces: `issueAssetCore` no longer takes `treasuryAccount`/`sale.treasuryAccount` in its `input` object type; callers stop passing them.

- [ ] **Step 1: Find every test currently supplying `treasuryAccount` at issuance, `setPrice`, or batch-tokenize**

```bash
grep -rln "treasuryAccount" apps/api/test --include='*.ts'
```
Read each hit before touching anything — Global Constraints only permits narrowing the specific fixture/assertion that names the field this task removes, not a broader rewrite of the test.

- [ ] **Step 2: Write the failing test — issuance derives the treasury**

```ts
// apps/api/test/api.test.ts — new test near the existing issuance suite
it("issues without treasuryAccount and mints into the use case's own registered treasury", async () => {
  const app = await buildTestApp();
  const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  const uc = await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit`, headers: { authorization: `Bearer ${platform}` } });
  const treasuryAccountId = uc.json().treasuryAccountId as string;

  const res = await app.inject({
    method: "POST", url: `${V1}/assets`, headers: { authorization: `Bearer ${platform}` },
    payload: {
      useCaseKey: "carbon-credit", name: "Derived Treasury VCU", symbol: "DTV", chainId: "fabric",
      metadata: { projectName: "Test", registry: "Verra", vintage: 2025 }, initialSupply: "50",
    },
  });
  expect(res.statusCode).toBe(201);
  const asset = res.json().asset as { treasuryAccount: string };
  const accountsRes = await app.inject({ method: "GET", url: `${V1}/accounts`, headers: { authorization: `Bearer ${platform}` } });
  const treasury = (accountsRes.json() as Array<{ id: string; address: string }>).find((a) => a.id === treasuryAccountId);
  expect(asset.treasuryAccount).toBe(treasury?.address);
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npx vitest run apps/api/test/api.test.ts -t "derives the treasury" --testTimeout=45000
```
Expected: FAIL — `MISSING_TREASURY` (no `treasuryAccount` supplied and none derived yet).

- [ ] **Step 4: Fix `issueAssetCore` and its one caller's body cast**

In `apps/api/src/http/routes/tokenization.ts`, the `input` object type at lines 258-260 drops `treasuryAccount`/`sale`'s nested one:
```ts
    useCaseKey: string; name: string; chainId: string;
    metadata?: Record<string, unknown>; initialSupply?: string;
    sale?: { unitPrice: string; currency: string };
```

Replace the whole block from the destructure (line 262) through the existing `useCase` fetch and its immediately following `SUPPLY_UNSUPPORTED` check (lines 262-292) with:
```ts
    const { useCaseKey: bUseCaseKey, name, chainId, metadata, initialSupply, sale } = input;
    const claims = input.claims;
    if (claims.role !== "PlatformAdmin" && bUseCaseKey !== claims.useCaseKey) {
      return { ok: false, status: 403, error: "WRONG_USE_CASE", message: "cannot issue into another use case" };
    }
    // Validate sale terms if provided
    if (sale) {
      if (!isSupportedCurrency(sale.currency)) {
        return { ok: false, status: 400, error: "UNSUPPORTED_CURRENCY", message: `currency '${sale.currency}' is not supported` };
      }
      if (!isPositiveIntString(sale.unitPrice)) {
        return { ok: false, status: 400, error: "INVALID_PRICE", message: "unitPrice must be a positive integer" };
      }
    }
    const wantsSupply = initialSupply !== undefined && initialSupply !== "" && initialSupply !== "0";
    if (wantsSupply && !/^\d+$/.test(initialSupply!)) {
      return { ok: false, status: 400, error: "INVALID_SUPPLY", message: "initialSupply must be a whole number" };
    }
    const actor = input.actor;
    const useCase = await deps.useCases.get(bUseCaseKey);
    // The treasury is the use case's own registered account — never client-
    // supplied. A use case created before this shipped and not yet backfilled
    // has no treasuryAccountId; that is the one case MISSING_TREASURY still
    // reaches, and the fix is running the backfill, not re-adding the field.
    const treasury = useCase.treasuryAccountId
      ? (await deps.accounts.findById(useCase.treasuryAccountId))?.address ?? null
      : null;
    if (wantsSupply && !treasury) {
      return { ok: false, status: 400, error: "MISSING_TREASURY", message: "a treasury account is required to mint initial supply" };
    }
    // Initial supply is fungible-only — reject up front, before charging any fee.
    if (wantsSupply && useCase.tokenType !== "fungible") {
      return { ok: false, status: 400, error: "SUPPLY_UNSUPPORTED", message: "initial supply is only supported for fungible assets" };
    }
```
This preserves every existing check in its original order (`WRONG_USE_CASE` → sale currency/price → `INVALID_SUPPLY` format, none of which depend on the use case) and fetches the use case exactly once, at the same point the original code already fetched it — `treasury` and `MISSING_TREASURY` simply move to right after that fetch, since deriving `treasury` now requires it.

The route handler that calls `issueAssetCore` (`app.post("/assets", ...)`, a few lines below) casts its own body with the same fields — drop `treasuryAccount` and `sale.treasuryAccount` there too:
```ts
    const b = request.body as { useCaseKey: string; name: string; chainId: string; metadata?: Record<string, unknown>; initialSupply?: string; sale?: { unitPrice: string; currency: string } };
```

- [ ] **Step 5: Fix the `setPrice` action branch**

Replace:
```ts
      case "setPrice": {
        deps.rbac.authorize(actor, "issue");
        if (!b.unitPrice || !b.currency || !b.treasuryAccount) return reply.code(400).send({ error: "VALIDATION_ERROR", message: "setPrice requires unitPrice, currency, and treasuryAccount" });
        if (!isSupportedCurrency(b.currency)) return reply.code(400).send({ error: "UNSUPPORTED_CURRENCY", message: `currency '${b.currency}' is not supported` });
        if (!isPositiveIntString(b.unitPrice)) return reply.code(400).send({ error: "INVALID_PRICE", message: "unitPrice must be a positive integer" });
        await deps.assets.setSaleTerms(asset.id, { unitPrice: b.unitPrice, currency: b.currency, treasuryAccount: b.treasuryAccount });
        return reply.code(200).send({ ok: true });
      }
```
with:
```ts
      case "setPrice": {
        deps.rbac.authorize(actor, "issue");
        if (!b.unitPrice || !b.currency) return reply.code(400).send({ error: "VALIDATION_ERROR", message: "setPrice requires unitPrice and currency" });
        if (!isSupportedCurrency(b.currency)) return reply.code(400).send({ error: "UNSUPPORTED_CURRENCY", message: `currency '${b.currency}' is not supported` });
        if (!isPositiveIntString(b.unitPrice)) return reply.code(400).send({ error: "INVALID_PRICE", message: "unitPrice must be a positive integer" });
        const uc = await deps.useCases.get(asset.useCaseKey);
        const treasuryAccount = uc.treasuryAccountId ? (await deps.accounts.findById(uc.treasuryAccountId))?.address ?? null : null;
        if (!treasuryAccount) return reply.code(400).send({ error: "MISSING_TREASURY", message: "this use case has no registered treasury — run the treasury backfill" });
        await deps.assets.setSaleTerms(asset.id, { unitPrice: b.unitPrice, currency: b.currency, treasuryAccount });
        return reply.code(200).send({ ok: true });
      }
```
No type edit is needed for the enclosing handler's own body cast — it reads `const b = (request.body ?? {}) as Record<string, string>;` (`apps/api/src/http/routes/tokenization.ts:747`), a loose cast with no `treasuryAccount` field to remove; `b.treasuryAccount` simply stops existing once the schema (Step 7) stops accepting it.

- [ ] **Step 6: Fix batch tokenization**

In `POST /use-cases/:key/invoices/tokenize` (~line 557), remove `treasuryAccount` from the destructured body and from the two places it is passed into `issueAssetCore`:
```ts
    const { ids, chainId, parValue = 1000, sale } = request.body as { ids: string[]; chainId: string; parValue?: number; sale?: { unitPrice: string; currency: string } };
```
```ts
      const r = await issueAssetCore({
        claims: gate.claims, actor: gate.actor, request, useCaseKey: gate.useCase.key,
        name: `${rec.metadata.invoiceNumber} · ${rec.metadata.buyerName}`, chainId,
        metadata: rec.metadata, initialSupply: String(supply),
        sale: sale ? { unitPrice: sale.unitPrice, currency: sale.currency } : undefined,
      });
```

- [ ] **Step 7: Update the three schemas**

In `apps/api/src/http/schemas/tokenization.ts`, remove the `treasuryAccount` property (and its entry in any `required` array) from the create-asset body, its nested `sale` object, the asset-actions `setPrice` shape, and `tokenizeInvoices`. Run:
```bash
grep -n "treasuryAccount" apps/api/src/http/schemas/tokenization.ts
```
Expected after the edit: no output.

- [ ] **Step 8: Run the new test, then the full issuance/setPrice/invoice suites**

```bash
npx vitest run apps/api/test/api.test.ts -t "derives the treasury" --testTimeout=45000
```
Expected: PASS.
```bash
npx vitest run apps/api/test/api.test.ts --testTimeout=45000
```
Expected: all pass — including the earlier `buy 400 NO_WALLET when buyer has no linked wallet` test and any fixture narrowed in Step 1, which must still assert the same behavior with the field simply removed from its payload rather than left dangling as an ignored extra property (`additionalProperties: false` on these schemas means a stray `treasuryAccount` in an old fixture now 400s at the SCHEMA layer with a validation error, not silently ignored — Step 1's grep is what catches every such fixture before this run surfaces it as a confusing failure).

- [ ] **Step 9: Regenerate the OpenAPI snapshot and read the diff**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/api"
pnpm exec tsx scripts/write-openapi-snapshot.ts
cd "/Users/kamleshnagware/Tokenlayer XPI"
git diff apps/api/openapi.snapshot.json
```
Expected: the diff shows only `treasuryAccount` disappearing from the three request bodies named in Step 7 — nothing else.

- [ ] **Step 10: Full API suite + tsc**

```bash
npx tsc --noEmit -p apps/api
npx vitest run apps/api --testTimeout=45000 --hookTimeout=45000
```
Expected: `tsc` clean. Vitest: same baseline as before this task, plus this task's new passing tests, minus nothing (no test file this task touches loses a test — only fixtures inside existing tests are narrowed).

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/http/routes/tokenization.ts apps/api/src/http/schemas/tokenization.ts apps/api/openapi.snapshot.json apps/api/test
git commit -m "feat(treasury): issuance, setPrice, and batch tokenization derive the treasury instead of accepting it"
```

---

### Task 6: Backfill — every existing use case gets an owner and a treasury

**Files:**
- Create: `apps/api/src/shared/treasury-backfill.ts`
- Create: `apps/api/scripts/backfill-treasuries.ts`
- Test: `apps/api/test/wallets.test.ts` (or a new `treasury-backfill.test.ts` if `wallets.test.ts` is judged to have grown unfocused — controller's call at dispatch time)

**Interfaces:**
- Consumes: `provisionTreasury` (Task 2), `ensurePlatformIssuerOrg` (existing), `UseCaseRepository.list()`/`.update()` (existing — confirm the exact listing method name before writing the loop; `UseCaseRepository extends UseCaseSource`, whose `list()` shape may differ from `UserRepository.list()`'s).
- Produces: `backfillTreasuries(deps: Pick<AppDeps, "useCases" | "accounts" | "organizations" | "keystore" | "registry">): Promise<{ ownersAssigned: number; treasuriesAssigned: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/wallets.test.ts
import { backfillTreasuries } from "../src/shared/treasury-backfill.js";
import { MemoryUseCaseRepository, MemoryOrganizationRepository, MemoryAccountRepository } from "../src/persistence/memory/index.js";
import { createKeystore } from "../src/shared/keystore.js";

describe("backfillTreasuries", () => {
  it("assigns an owner and a treasury to a use case that predates both", async () => {
    const useCases = new MemoryUseCaseRepository();
    const organizations = new MemoryOrganizationRepository();
    const accounts = new MemoryAccountRepository();
    const keystore = createKeystore("11".repeat(32));
    await useCases.create({
      key: "legacy-uc", name: "Legacy", symbol: "LEG", tokenStandard: "erc20", tokenType: "fungible",
      allowedChainIds: ["fabric"], defaultChainId: "fabric", compliance: { allowlist: true }, workflow: {},
      ownerOrgId: "", // Task 1's transitional migration default
    } as never);

    const result = await backfillTreasuries({ useCases, organizations, accounts, keystore, registry: undefined });
    expect(result.ownersAssigned).toBe(1);
    expect(result.treasuriesAssigned).toBe(1);

    const uc = await useCases.get("legacy-uc");
    expect(uc.ownerOrgId).not.toBe("");
    expect(uc.treasuryAccountId).not.toBeUndefined();
  });

  it("is idempotent", async () => {
    const useCases = new MemoryUseCaseRepository();
    const organizations = new MemoryOrganizationRepository();
    const accounts = new MemoryAccountRepository();
    const keystore = createKeystore("11".repeat(32));
    await useCases.create({
      key: "legacy-uc-2", name: "Legacy 2", symbol: "LG2", tokenStandard: "erc20", tokenType: "fungible",
      allowedChainIds: ["fabric"], defaultChainId: "fabric", compliance: { allowlist: true }, workflow: {},
      ownerOrgId: "",
    } as never);

    await backfillTreasuries({ useCases, organizations, accounts, keystore, registry: undefined });
    const second = await backfillTreasuries({ useCases, organizations, accounts, keystore, registry: undefined });
    expect(second.ownersAssigned).toBe(0);
    expect(second.treasuriesAssigned).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run apps/api/test/wallets.test.ts -t "backfillTreasuries" --testTimeout=45000
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

```ts
// apps/api/src/shared/treasury-backfill.ts
import type { AppDeps } from "../context.js";
import { ensurePlatformIssuerOrg } from "./platform-org.js";
import { provisionTreasury } from "./wallets.js";

/**
 * One-time backfill for use cases created before org-owned treasuries
 * shipped: every use case missing an owner is stamped to the Platform org
 * (mirroring seedUseCases' own default for platform-seeded ones); every use
 * case missing a treasury gets one provisioned, exactly as a freshly
 * created use case would. Idempotent — re-running touches only rows still
 * missing either field.
 */
export async function backfillTreasuries(
  deps: Pick<AppDeps, "useCases" | "accounts" | "organizations" | "keystore" | "registry">,
): Promise<{ ownersAssigned: number; treasuriesAssigned: number }> {
  const platformOrg = await ensurePlatformIssuerOrg(deps);
  const all = await deps.useCases.list();
  let ownersAssigned = 0;
  let treasuriesAssigned = 0;
  for (const uc of all) {
    let ownerOrgId = uc.ownerOrgId;
    if (!ownerOrgId) {
      ownerOrgId = platformOrg.id;
      ownersAssigned++;
    }
    let treasuryAccountId = uc.treasuryAccountId;
    if (!treasuryAccountId) {
      treasuryAccountId = await provisionTreasury(deps, ownerOrgId, `${uc.name} treasury`);
      treasuriesAssigned++;
    }
    if (ownerOrgId !== uc.ownerOrgId || treasuryAccountId !== uc.treasuryAccountId) {
      await deps.useCases.update(uc.key, { ...uc, ownerOrgId, treasuryAccountId });
    }
  }
  return { ownersAssigned, treasuriesAssigned };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run apps/api/test/wallets.test.ts -t "backfillTreasuries" --testTimeout=45000
```
Expected: both tests PASS.

- [ ] **Step 5: Write the script wrapper**

```ts
// apps/api/scripts/backfill-treasuries.ts
/**
 * One-time backfill: every use case missing an owning org or a registered
 * treasury gets both, matching what a freshly-created use case gets by
 * construction. Idempotent — safe to re-run.
 *
 *   DATABASE_URL="file:./dev.db" pnpm --filter @tokenlayer/api exec tsx scripts/backfill-treasuries.ts
 *
 * Run once against each live database (combined stack's dev.db, and both
 * split stacks' — every stack has UseCase rows that predate this feature).
 */
import { prisma, PrismaAccountRepository, PrismaOrganizationRepository, PrismaUseCaseRepository } from "../src/persistence/prisma/index.js";
import { createKeystore } from "../src/shared/keystore.js";
import { backfillTreasuries } from "../src/shared/treasury-backfill.js";

const keystore = createKeystore(process.env.DID_MASTER_KEY ?? (() => { throw new Error("DID_MASTER_KEY is required — the platform org's DID seed is encrypted under it, same as every organization's"); })());
const result = await backfillTreasuries({
  useCases: new PrismaUseCaseRepository(),
  accounts: new PrismaAccountRepository(),
  organizations: new PrismaOrganizationRepository(),
  keystore,
  registry: undefined,
});
console.log(`owners assigned: ${result.ownersAssigned}, treasuries assigned: ${result.treasuriesAssigned}`);
await prisma.$disconnect();
```
(`PrismaOrganizationRepository`, like `PrismaUserRepository`/`PrismaAccountRepository`, takes no constructor argument — confirmed against `apps/api/src/persistence/prisma/shared.ts:322`.)

- [ ] **Step 6: Add the package script**

In `apps/api/package.json`, alongside `"backfill:wallets"`:
```json
    "backfill:treasuries": "tsx scripts/backfill-treasuries.ts",
```

- [ ] **Step 7: tsc + commit**

```bash
npx tsc --noEmit -p apps/api
```
Expected: clean.
```bash
git add apps/api/src/shared/treasury-backfill.ts apps/api/scripts/backfill-treasuries.ts apps/api/package.json apps/api/test/wallets.test.ts
git commit -m "feat(treasury): backfill-treasuries — owner + treasury for every pre-existing use case"
```

---

### Task 7: Full suite, live rebuild, and e2e verification

**Files:** none (verification only).

- [ ] **Step 1: Full local suite**

```bash
npx tsc --noEmit -p apps/api
npx tsc --noEmit -p packages/core
npx tsc --noEmit -p apps/web
npx vitest run apps/api packages/core apps/web --testTimeout=45000 --hookTimeout=45000
```
Expected: all green except the one pre-existing, already-tracked `try-it-safety.test.ts` failure on `GET /reconciliation` (task_44d24416) — unrelated to this plan and not to be touched here.

- [ ] **Step 2: Rebuild the combined stack from an empty volume**

This plan's migration (Task 1's transitional `ownerOrgId` default, closed by Task 6's backfill) means the safest verification is a **fresh** boot, not a warm one — a warm boot would only exercise the backfill path, never the "brand new database" path Task 4 changed.

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI"
docker compose down -v
docker volume rm tokenlayerxpi_api-data 2>/dev/null || true
./scripts/deploy.sh
```
Expected: boots clean; `deploy.sh`'s own smoke test passes (fresh chain + fresh DB, matching the pattern already established earlier this session for a cold-volume verification).

- [ ] **Step 3: Confirm a freshly-seeded use case has an owner and a treasury**

```bash
node -e '
(async()=>{
  const API="http://localhost:4000/api/v1";
  const r=await fetch(API+"/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"admin@tokenlayer.dev",password:"admin123"})});
  const t=(await r.json()).token;
  const uc=await fetch(API+"/use-cases/carbon-credit",{headers:{authorization:"Bearer "+t}});
  const body=await uc.json();
  console.log("ownerOrgId:", body.ownerOrgId, "treasuryAccountId:", body.treasuryAccountId);
})()'
```
Expected: both fields are non-empty strings.

- [ ] **Step 4: Confirm issuance works with no treasuryAccount in the request**

```bash
./scripts/verify.sh
```
Expected: `SMOKE TEST PASSED` — this script already issues without inspecting `treasuryAccount` in its own payload beyond what Task 5 removed, so a pass here confirms the derived path works end to end on a live chain.

- [ ] **Step 5: Run the backfill against a database that predates this feature, and confirm it's a no-op on a fresh one**

On the just-rebuilt (fresh) database:
```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/api"
DATABASE_URL="file:./dev.db" pnpm exec tsx scripts/backfill-treasuries.ts
```
Expected: `owners assigned: 0, treasuries assigned: 0` — every use case already got both at boot (Task 4), so the backfill has nothing to do here. (Verifying it assigns something real happens against the *pre-migration* production databases when this ships — that verification is manual, on the live deployments, once this plan merges, not part of this task.)

- [ ] **Step 6: Full 20-script e2e sweep**

Follow the same procedure established earlier this session for the sandbox-removal branch: rebuild both split stacks (`bash scripts/stack-up.sh identity tokenization --chain=besu`), run the 18 combined-stack scripts and the 2 split-topology scripts (`personas-e2e.mjs`, `seam-e2e.mjs`), watching for the shared-operator-key nonce-collision artifact if more than one stack's API is live at once (stop the stack not under test, confirm `eth_getTransactionCount` pending==latest before each run, exactly as before). Report a full honest pass/fail tally.

- [ ] **Step 7: Final whole-branch review**

Per the `subagent-driven-development` skill: dispatch a final review (most capable model) against the full diff, covering the same checks as the sandbox-removal branch's final review — grep for anything this plan should have removed but didn't (`treasuryAccount` as client input, in particular), confirm THE PARITY RULE held for both new fields, confirm the boot-order change in `server.ts` didn't silently break anything that used to run before `ensurePlatformIssuerOrg` resolved. Fix what it finds, re-verify, then merge per the standing instruction to merge and push once review comes back clean.
