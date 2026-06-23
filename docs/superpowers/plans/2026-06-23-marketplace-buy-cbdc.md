# Marketplace Buy + CBDC Payment (DvP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a KYC-approved Buyer purchase tokens from an asset's treasury pool, paying in a configurable digital currency (CBDC etc.), settled atomically delivery-versus-payment.

**Architecture:** A new `buy` RBAC action + `engine.buy` reuses the existing compliance-checked transfer for the token-delivery leg; a new API-layer `CashRepository` holds per-`(currency, address)` balances and performs the payment leg. The API orchestrates payment-then-delivery with cash compensation on a delivery failure, keeping the chain-agnostic `LifecycleEngine` free of any cash concept.

**Tech Stack:** TypeScript monorepo — `@tokenlayer/core` (Vitest), Fastify + Prisma/SQLite API, React + Vite web. Run binaries directly (`../../node_modules/.bin/vitest`, package-local `./node_modules/.bin/prisma`, `../../node_modules/.bin/tsx`) and prefix `CI=true` for vitest — the pnpm store is mismatched so `pnpm install`/`pnpm add` are unavailable.

> **GIT SAFETY (every task):** Only ever run `git add` + `git commit`. NEVER run `git checkout`, `git switch`, `git reset`, `git branch`, `git stash`, `git rebase`, or `git merge`. Work stays on the current branch.

---

## File Structure

**Create:**
- `config/currencies.json` — supported settlement currencies.
- `apps/api/src/currencies.ts` — currencies config loader (mirrors `chains.ts`).
- `apps/api/src/e2e-buy.ts` — end-to-end fund → list → buy → balances script.

**Modify:**
- `packages/core/src/types.ts` — add `"buy"` to `LifecycleAction`.
- `packages/core/src/rbac.ts` — grant `buy` to Buyer/Trader/admins.
- `packages/core/src/lifecycle-engine.ts` — add `buy()`.
- `packages/core/test/*.test.ts` — RBAC + engine.buy tests.
- `apps/api/prisma/schema.prisma` — `CashBalance` model + `Asset` sale-term columns.
- `apps/api/src/persistence/types.ts` — `CashRepository`, `CashBalanceRecord`, `AssetRecord` sale terms, `AssetRepository.setSaleTerms`.
- `apps/api/src/persistence/memory.ts` — in-memory cash repo + asset sale terms.
- `apps/api/src/persistence/prisma.ts` — prisma cash repo + asset sale terms.
- `apps/api/src/context.ts` — `AppDeps.cash` + `currencies`.
- `apps/api/src/http/schemas.ts` — sale terms, setPrice, buy, creditCash, currencies schemas.
- `apps/api/src/http/routes.ts` — issue sale terms, `setPrice`, `buy`, `cash/credit`, `currencies` routes.
- `apps/api/src/app.ts` / `apps/api/src/server.ts` — wire cash repo + currencies.
- `apps/api/test/api.test.ts` + test app builder — buy/funding tests + cash dep.
- `apps/api/src/seed.ts` — seed demo CBDC balances.
- `apps/web/src/api.ts` — `currencies`, `cashBalances`, `buy`, `setPrice`, `creditCash`, `issue` sale.
- `apps/web/src/rbac.ts` — mirror `buy`.
- `apps/web/src/components/AssetManagement.tsx` (+ issuance/marketplace/holdings sub-views) — sale terms form, Buy panel, CBDC balances, Fund control.
- `README.md` / `docs/` — document the buy flow.

---

## Task 1: Core — `buy` action + RBAC matrix

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/rbac.ts`
- Test: `packages/core/test/rbac.test.ts`

- [ ] **Step 1: Add a failing RBAC test**

Append to `packages/core/test/rbac.test.ts` (inside the existing top-level `describe`, matching its style):

```ts
it("permits 'buy' for Buyer and Trader, denies it for Auditor", () => {
  const policy = new RbacPolicy();
  expect(policy.can({ id: "u", role: "Buyer" }, "buy")).toBe(true);
  expect(policy.can({ id: "u", role: "Trader" }, "buy")).toBe(true);
  expect(policy.can({ id: "u", role: "Auditor" }, "buy")).toBe(false);
});
```

If `policy.can(actor, action)` does not exist in this file's other tests, instead use the assertion style already present (e.g. `expect(() => policy.authorize({ id: "u", role: "Buyer" }, "buy")).not.toThrow()` and `.toThrow()` for Auditor). Match whatever the sibling tests use.

- [ ] **Step 2: Run it, expect failure**

Run: `cd packages/core && CI=true ../../node_modules/.bin/vitest run test/rbac.test.ts`
Expected: FAIL — `"buy"` is not assignable to `LifecycleAction` (type error) or Buyer lacks `buy`.

- [ ] **Step 3: Add `"buy"` to `LifecycleAction`**

In `packages/core/src/types.ts`, extend the union (add the line before `| "read";`):

```ts
export type LifecycleAction =
  | "issue"
  | "mint"
  | "transfer"
  | "burn"
  | "freeze"
  | "unfreeze"
  | "allow"
  | "disallow"
  | "buy"
  | "read";
```

- [ ] **Step 4: Grant `buy` in the RBAC matrix**

In `packages/core/src/rbac.ts`: add `"buy"` to the `FULL` action list (so PlatformAdmin/UseCaseAdmin keep full access), and update the Trader and Buyer sets:

```ts
Issuer: new Set<LifecycleAction>(["issue", "mint", "allow", "disallow", "freeze", "unfreeze", "read"]),
Trader: new Set<LifecycleAction>(["transfer", "burn", "buy", "read"]),
Buyer: new Set<LifecycleAction>(["read", "buy"]),
Auditor: new Set<LifecycleAction>(["read"]),
```

Locate the `FULL` constant near the top of `rbac.ts` and add `"buy"` to it. If `FULL` is spread into the admin sets, that alone covers admins.

- [ ] **Step 5: Run it, expect pass**

Run: `cd packages/core && CI=true ../../node_modules/.bin/vitest run test/rbac.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/rbac.ts packages/core/test/rbac.test.ts
git commit -m "feat(core): add 'buy' lifecycle action + grant to Buyer/Trader"
```

---

## Task 2: Core — `engine.buy` token-delivery leg

**Files:**
- Modify: `packages/core/src/lifecycle-engine.ts`
- Test: `packages/core/test/lifecycle-engine.test.ts`

The `buy` method mirrors `transfer` (fungible, lifecycle `transfer` enabled, allowlist + freeze on both parties) but authorizes the `buy` action and records a `buy` audit entry carrying the price metadata. Cash is NOT touched here — the API layer wraps this with the payment leg.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/lifecycle-engine.test.ts`. Use the same harness the sibling tests use to build an engine + mock adapter + allowlisted accounts (copy the setup of the existing `transfer` test, renaming the asset/accounts). The new test:

```ts
it("buy delivers tokens treasury→buyer and records a 'buy' audit entry with price metadata", async () => {
  // Arrange: same setup as the transfer happy-path test — fungible use case with
  // allowlist enabled, an asset, treasury + buyer both allowlisted, treasury holding 1000.
  const { engine, ctx, audit, treasury, buyer, actor } = await setupFungibleWithBalance(1000n);

  // Act
  await engine.buy(actor, ctx, treasury, buyer, "10", { unitPrice: "5", currency: "CBDC-INR", cost: "50" });

  // Assert: tokens moved
  expect(await engine.balanceOf(actor, ctx, buyer)).toBe("10");
  // Assert: a 'buy' audit entry with the metadata
  const entry = audit.records.at(-1)!;
  expect(entry.action).toBe("buy");
  expect(entry.payload).toMatchObject({ from: treasury, to: buyer, amount: "10", unitPrice: "5", currency: "CBDC-INR", cost: "50" });
});

it("buy rejects a non-allowlisted buyer", async () => {
  const { engine, ctx, treasury, actor } = await setupFungibleWithBalance(1000n);
  await expect(engine.buy(actor, ctx, treasury, "0xNOTLISTED", "10", { unitPrice: "5", currency: "CBDC-INR", cost: "50" }))
    .rejects.toThrow(/NOT_ALLOWLISTED|allowlist/);
});
```

If no `setupFungibleWithBalance` helper exists, inline the arrangement by copying the existing transfer test's setup verbatim and minting `1000` to the treasury first. The audit sink in these tests exposes recorded entries — use the same accessor the existing tests use (e.g. `audit.records` or a fake's array); match the codebase.

- [ ] **Step 2: Run it, expect failure**

Run: `cd packages/core && CI=true ../../node_modules/.bin/vitest run test/lifecycle-engine.test.ts`
Expected: FAIL — `engine.buy is not a function`.

- [ ] **Step 3: Implement `buy`**

In `packages/core/src/lifecycle-engine.ts`, add immediately after the `transfer` method (around line 124):

```ts
/**
 * Buyer-initiated delivery leg of a DvP purchase. Same compliance as `transfer`
 * (fungible, allowlist + freeze on both parties) but authorized under the `buy`
 * action and audited as `buy` with the payment metadata. The API layer performs
 * the cash payment around this call.
 */
async buy(
  actor: Actor,
  ctx: AssetContext,
  from: string,
  to: string,
  amount: string,
  meta: { unitPrice: string; currency: string; cost: string },
): Promise<TxReceipt> {
  const { adapter, useCase } = await this.prepare(actor, ctx, "buy");
  this.requireFungible(useCase);
  this.requireLifecycle(useCase, "transfer");
  await this.requireAllowed(adapter, ctx.ref, useCase, [from, to]);
  await this.requireNotFrozen(adapter, ctx.ref, [from, to]);
  const receipt = await adapter.transfer(ctx.ref, from, to, amount);
  await this.writeReceipt(actor, "buy", ctx, receipt, { from, to, amount, ...meta });
  return receipt;
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `cd packages/core && CI=true ../../node_modules/.bin/vitest run test/lifecycle-engine.test.ts`
Expected: PASS (both new cases).

- [ ] **Step 5: Run the full core suite**

Run: `cd packages/core && CI=true ../../node_modules/.bin/vitest run`
Expected: all green (38 prior + new).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/lifecycle-engine.ts packages/core/test/lifecycle-engine.test.ts
git commit -m "feat(core): add engine.buy delivery leg (compliance-checked, audited)"
```

---

## Task 3: Persistence — CashRepository (cash ledger)

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/persistence/types.ts`
- Modify: `apps/api/src/persistence/memory.ts`
- Modify: `apps/api/src/persistence/prisma.ts`
- Test: `apps/api/test/cash.test.ts` (create)

Amounts are integer strings (consistent with token amounts). Balances are keyed by `(currency, address)`.

- [ ] **Step 1: Add the Prisma model + push**

In `apps/api/prisma/schema.prisma`, add:

```prisma
model CashBalance {
  id       String @id @default(cuid())
  currency String
  address  String
  amount   String @default("0")

  @@unique([currency, address])
}
```

Run: `cd apps/api && ./node_modules/.bin/prisma db push --skip-generate && ./node_modules/.bin/prisma generate`
Expected: "in sync" + client generated.

- [ ] **Step 2: Define the interface + types**

In `apps/api/src/persistence/types.ts` add:

```ts
export interface CashBalanceRecord {
  currency: string;
  address: string;
  amount: string;
}

export interface CashRepository {
  balanceOf(currency: string, address: string): Promise<string>;
  balancesOf(address: string): Promise<CashBalanceRecord[]>;
  /** Mint/fund: add `amount` to (currency,address). */
  credit(currency: string, address: string, amount: string): Promise<void>;
  /** Payment leg: move `amount` from→to in `currency`; throws on insufficient funds. */
  transfer(currency: string, from: string, to: string, amount: string): Promise<void>;
}
```

- [ ] **Step 3: Write the failing test**

Create `apps/api/test/cash.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InMemoryCashRepository } from "../src/persistence/memory.js";

describe("InMemoryCashRepository", () => {
  it("credits and reports balances", async () => {
    const cash = new InMemoryCashRepository();
    await cash.credit("CBDC-INR", "0xA", "100");
    await cash.credit("CBDC-INR", "0xA", "50");
    expect(await cash.balanceOf("CBDC-INR", "0xA")).toBe("150");
    expect(await cash.balanceOf("CBDC-INR", "0xB")).toBe("0");
  });

  it("transfers between addresses", async () => {
    const cash = new InMemoryCashRepository();
    await cash.credit("CBDC-INR", "0xA", "100");
    await cash.transfer("CBDC-INR", "0xA", "0xB", "30");
    expect(await cash.balanceOf("CBDC-INR", "0xA")).toBe("70");
    expect(await cash.balanceOf("CBDC-INR", "0xB")).toBe("30");
  });

  it("rejects an overdraft with INSUFFICIENT_FUNDS", async () => {
    const cash = new InMemoryCashRepository();
    await cash.credit("CBDC-INR", "0xA", "10");
    await expect(cash.transfer("CBDC-INR", "0xA", "0xB", "20")).rejects.toThrow(/INSUFFICIENT_FUNDS/);
  });

  it("lists all currency balances for an address", async () => {
    const cash = new InMemoryCashRepository();
    await cash.credit("CBDC-INR", "0xA", "100");
    await cash.credit("USDC", "0xA", "5");
    const list = await cash.balancesOf("0xA");
    expect(list).toEqual(expect.arrayContaining([
      { currency: "CBDC-INR", address: "0xA", amount: "100" },
      { currency: "USDC", address: "0xA", amount: "5" },
    ]));
  });
});
```

- [ ] **Step 4: Run it, expect failure**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/cash.test.ts`
Expected: FAIL — `InMemoryCashRepository` not exported.

- [ ] **Step 5: Implement the in-memory repo**

In `apps/api/src/persistence/memory.ts`, import the new types and add the class (use `bigint` for arithmetic, store/return decimal strings):

```ts
import type { CashRepository, CashBalanceRecord } from "./types.js";

export class InMemoryCashRepository implements CashRepository {
  private readonly balances = new Map<string, bigint>(); // key: `${currency} ${address}`
  private key(currency: string, address: string): string {
    return `${currency} ${address}`;
  }
  async balanceOf(currency: string, address: string): Promise<string> {
    return (this.balances.get(this.key(currency, address)) ?? 0n).toString();
  }
  async balancesOf(address: string): Promise<CashBalanceRecord[]> {
    const out: CashBalanceRecord[] = [];
    for (const [k, amount] of this.balances) {
      const [currency, addr] = k.split(" ");
      if (addr === address && amount > 0n) out.push({ currency: currency!, address, amount: amount.toString() });
    }
    return out;
  }
  async credit(currency: string, address: string, amount: string): Promise<void> {
    const k = this.key(currency, address);
    this.balances.set(k, (this.balances.get(k) ?? 0n) + BigInt(amount));
  }
  async transfer(currency: string, from: string, to: string, amount: string): Promise<void> {
    const amt = BigInt(amount);
    const fromKey = this.key(currency, from);
    const have = this.balances.get(fromKey) ?? 0n;
    if (have < amt) {
      throw new Error(`INSUFFICIENT_FUNDS: ${from} has ${have} ${currency}, needs ${amt}`);
    }
    this.balances.set(fromKey, have - amt);
    const toKey = this.key(currency, to);
    this.balances.set(toKey, (this.balances.get(toKey) ?? 0n) + amt);
  }
}
```

- [ ] **Step 6: Run it, expect pass**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/cash.test.ts`
Expected: PASS.

- [ ] **Step 7: Implement the Prisma repo**

In `apps/api/src/persistence/prisma.ts`, add (using the existing `prisma` client instance pattern in that file):

```ts
import type { CashRepository, CashBalanceRecord } from "./types.js";

export class PrismaCashRepository implements CashRepository {
  constructor(private readonly prisma: PrismaClient) {}
  async balanceOf(currency: string, address: string): Promise<string> {
    const row = await this.prisma.cashBalance.findUnique({ where: { currency_address: { currency, address } } });
    return row?.amount ?? "0";
  }
  async balancesOf(address: string): Promise<CashBalanceRecord[]> {
    const rows = await this.prisma.cashBalance.findMany({ where: { address } });
    return rows.filter((r) => BigInt(r.amount) > 0n).map((r) => ({ currency: r.currency, address: r.address, amount: r.amount }));
  }
  async credit(currency: string, address: string, amount: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.cashBalance.findUnique({ where: { currency_address: { currency, address } } });
      const next = (BigInt(row?.amount ?? "0") + BigInt(amount)).toString();
      await tx.cashBalance.upsert({
        where: { currency_address: { currency, address } },
        create: { currency, address, amount: next },
        update: { amount: next },
      });
    });
  }
  async transfer(currency: string, from: string, to: string, amount: string): Promise<void> {
    const amt = BigInt(amount);
    await this.prisma.$transaction(async (tx) => {
      const fromRow = await tx.cashBalance.findUnique({ where: { currency_address: { currency, address: from } } });
      const have = BigInt(fromRow?.amount ?? "0");
      if (have < amt) throw new Error(`INSUFFICIENT_FUNDS: ${from} has ${have} ${currency}, needs ${amt}`);
      await tx.cashBalance.update({ where: { currency_address: { currency, address: from } }, data: { amount: (have - amt).toString() } });
      const toRow = await tx.cashBalance.findUnique({ where: { currency_address: { currency, address: to } } });
      const next = (BigInt(toRow?.amount ?? "0") + amt).toString();
      await tx.cashBalance.upsert({
        where: { currency_address: { currency, address: to } },
        create: { currency, address: to, amount: next },
        update: { amount: next },
      });
    });
  }
}
```

Match the file's existing import of `PrismaClient` and how it obtains the client (constructor arg vs module singleton) — follow whichever the sibling repos (e.g. `PrismaUserRepository`) use. The unique compound key accessor is `currency_address` (Prisma's default name for `@@unique([currency, address])`).

- [ ] **Step 8: Typecheck**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && ./node_modules/.bin/tsc --noEmit -p apps/api`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types.ts apps/api/src/persistence/memory.ts apps/api/src/persistence/prisma.ts apps/api/test/cash.test.ts
git commit -m "feat(api): add CashRepository (cash ledger) — memory + prisma"
```

---

## Task 4: Persistence — Asset sale terms

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/persistence/types.ts`
- Modify: `apps/api/src/persistence/memory.ts`
- Modify: `apps/api/src/persistence/prisma.ts`
- Test: `apps/api/test/asset-sale-terms.test.ts` (create)

- [ ] **Step 1: Add columns + push**

In `apps/api/prisma/schema.prisma`, add to `model Asset`:

```prisma
  unitPrice       String?
  currency        String?
  treasuryAccount String?
```

Run: `cd apps/api && ./node_modules/.bin/prisma db push --skip-generate && ./node_modules/.bin/prisma generate`
Expected: "in sync".

- [ ] **Step 2: Extend the record + repository interface**

In `apps/api/src/persistence/types.ts`, add three nullable fields to `AssetRecord` and a `setSaleTerms` method to `AssetRepository`:

```ts
export interface AssetRecord {
  id: string;
  useCaseKey: string;
  name: string;
  symbol: string;
  chainId: string;
  contractRef: string;
  tokenType: TokenType;
  tokenStandard: TokenStandard;
  metadata: Record<string, unknown>;
  status: string;
  createdBy: string;
  createdAt: string;
  unitPrice: string | null;
  currency: string | null;
  treasuryAccount: string | null;
}

export interface SaleTerms {
  unitPrice: string;
  currency: string;
  treasuryAccount: string;
}

export interface AssetRepository {
  create(input: Omit<AssetRecord, "createdAt">): Promise<AssetRecord>;
  get(id: string): Promise<AssetRecord | null>;
  list(filter?: AssetFilter, page?: Page): Promise<Paged<AssetRecord>>;
  setStatus(id: string, status: string): Promise<void>;
  setSaleTerms(id: string, terms: SaleTerms): Promise<void>;
}
```

- [ ] **Step 3: Write the failing test**

Create `apps/api/test/asset-sale-terms.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InMemoryAssetRepository } from "../src/persistence/memory.js";

const base = {
  id: "a1", useCaseKey: "carbon-credit", name: "X", symbol: "X", chainId: "besu",
  contractRef: "ref", tokenType: "fungible" as const, tokenStandard: "ERC-20" as const,
  metadata: {}, status: "active", createdBy: "u1",
  unitPrice: null, currency: null, treasuryAccount: null,
};

describe("AssetRepository sale terms", () => {
  it("defaults sale terms to null and sets them", async () => {
    const repo = new InMemoryAssetRepository();
    const a = await repo.create(base);
    expect(a.unitPrice).toBeNull();
    await repo.setSaleTerms("a1", { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: "0xT" });
    const got = await repo.get("a1");
    expect(got).toMatchObject({ unitPrice: "5", currency: "CBDC-INR", treasuryAccount: "0xT" });
  });
});
```

- [ ] **Step 4: Run it, expect failure**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/asset-sale-terms.test.ts`
Expected: FAIL — `setSaleTerms` missing / fields undefined.

- [ ] **Step 5: Implement in memory + prisma**

In `apps/api/src/persistence/memory.ts` `InMemoryAssetRepository`: in `create`, default the three fields from input (`unitPrice: input.unitPrice ?? null`, etc.); add:

```ts
async setSaleTerms(id: string, terms: { unitPrice: string; currency: string; treasuryAccount: string }): Promise<void> {
  const a = this.assets.get(id);
  if (a) { a.unitPrice = terms.unitPrice; a.currency = terms.currency; a.treasuryAccount = terms.treasuryAccount; }
}
```

In `apps/api/src/persistence/prisma.ts` `PrismaAssetRepository`: the `toAsset` mapper must read `unitPrice/currency/treasuryAccount` (already nullable on the row); `create` must pass them (`unitPrice: input.unitPrice ?? null`, etc.); add:

```ts
async setSaleTerms(id: string, terms: { unitPrice: string; currency: string; treasuryAccount: string }): Promise<void> {
  await this.prisma.asset.update({ where: { id }, data: { unitPrice: terms.unitPrice, currency: terms.currency, treasuryAccount: terms.treasuryAccount } });
}
```

Match the existing `toAsset` shape (it maps every column) — add the three fields there so `get`/`list` surface them.

- [ ] **Step 6: Run it, expect pass + full api suite still green**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/asset-sale-terms.test.ts && CI=true ../../node_modules/.bin/vitest run`
Expected: PASS; existing 31 tests unaffected (any asset literals in `api.test.ts`/seed/e2e that build `AssetRecord` may need the three nullable fields — add `unitPrice: null, currency: null, treasuryAccount: null` to any such literal the compiler flags).

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types.ts apps/api/src/persistence/memory.ts apps/api/src/persistence/prisma.ts apps/api/test/asset-sale-terms.test.ts
git commit -m "feat(api): add asset sale terms (unitPrice/currency/treasuryAccount)"
```

---

## Task 5: Currencies config + loader + `GET /currencies`

**Files:**
- Create: `config/currencies.json`
- Create: `apps/api/src/currencies.ts`
- Modify: `apps/api/src/context.ts`
- Modify: `apps/api/src/http/schemas.ts`
- Modify: `apps/api/src/http/routes.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/server.ts`

- [ ] **Step 1: Create the config**

`config/currencies.json`:

```json
[
  { "code": "CBDC-INR", "label": "Digital Rupee (CBDC)" },
  { "code": "USDC", "label": "USD Coin" },
  { "code": "e-GBP", "label": "Digital Pound (CBDC)" }
]
```

- [ ] **Step 2: Create the loader (mirrors `chains.ts`)**

`apps/api/src/currencies.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CURRENCIES_FILE = fileURLToPath(new URL("../../../config/currencies.json", import.meta.url));

export interface Currency {
  code: string;
  label: string;
}

let cached: Currency[] | null = null;

export function loadCurrencies(): Currency[] {
  if (!cached) {
    cached = JSON.parse(readFileSync(CURRENCIES_FILE, "utf8")) as Currency[];
  }
  return cached;
}

export function isSupportedCurrency(code: string): boolean {
  return loadCurrencies().some((c) => c.code === code);
}
```

Confirm the relative depth `../../../config` matches `chains.ts` (it uses the same path prefix). If `chains.ts` differs, copy its exact prefix.

- [ ] **Step 3: Add `currencies` + `cash` to AppDeps**

In `apps/api/src/context.ts`, add to `AppDeps`:

```ts
  cash: CashRepository;
  currencies: Currency[];
```

Import `CashRepository` from `./persistence/types.js` and `Currency` from `./currencies.js`.

- [ ] **Step 4: Add the schema + route**

In `apps/api/src/http/schemas.ts`, add a `currencies` response schema (array of `{ code, label }`), following the style of the `chains` schema. In `apps/api/src/http/routes.ts`, near the `/chains` route, add:

```ts
app.get("/currencies", { schema: S.currencies, ...auth }, async () => deps.currencies);
```

- [ ] **Step 5: Wire it in app + server**

In `apps/api/src/app.ts` and `apps/api/src/server.ts`, where `AppDeps` is constructed: add `cash: new PrismaCashRepository(prisma)` (server) / the in-memory repo (test builder, Task 7) and `currencies: loadCurrencies()`. Import accordingly. In the **test app builder** (in `apps/api/test/`), add `cash: new InMemoryCashRepository()` and `currencies: loadCurrencies()`.

- [ ] **Step 6: Typecheck + run a quick route check**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && ./node_modules/.bin/tsc --noEmit -p apps/api`
Expected: clean (buy/cash routes not added yet — only currencies wired; the test builder must compile).

- [ ] **Step 7: Commit**

```bash
git add config/currencies.json apps/api/src/currencies.ts apps/api/src/context.ts apps/api/src/http/schemas.ts apps/api/src/http/routes.ts apps/api/src/app.ts apps/api/src/server.ts apps/api/test
git commit -m "feat(api): currencies config + loader + GET /currencies + cash dep"
```

---

## Task 6: API — issuance sale terms, setPrice, buy (DvP), cash/credit

**Files:**
- Modify: `apps/api/src/http/schemas.ts`
- Modify: `apps/api/src/http/routes.ts`
- Test: `apps/api/test/api.test.ts`

### 6a. Schemas

- [ ] **Step 1: Add request schemas**

In `apps/api/src/http/schemas.ts`:
- `createAsset` body: add optional `sale` object `{ unitPrice: string, currency: string, treasuryAccount: string }` (all required *within* the object; `additionalProperties: false`).
- Add a `setPrice` action body schema: `{ unitPrice: string, currency: string, treasuryAccount: string }`.
- Add a `buy` body schema: `{ quantity: string }` (required).
- Add a `creditCash` body schema: `{ account: string, currency: string, amount: string }` (all required).

Follow the existing `additionalProperties: false` + `type: "string"` style used by `createUser`.

### 6b. Buy + funding tests (write first)

- [ ] **Step 2: Write failing API tests**

Add to `apps/api/test/api.test.ts` (reuse the existing helpers that build the app, log in roles, issue + allow + mint — copy from the existing carbon/tenancy tests). Cover the spec's cases:

```ts
it("buyer buys from treasury: cash moves, tokens delivered, 'buy' audit recorded", async () => {
  const app = await buildTestApp();
  const admin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123"); // UseCaseAdmin
  // issue a fungible asset WITH sale terms, treasury = a seeded in-scope account
  const treasury = await someScopedAccountAddress(app, admin); // helper: pick a scoped account
  const assetId = await issueAsset(app, admin, { useCaseKey: "carbon-credit", name: "S", symbol: "S", chainId: "besu", metadata: { projectName: "P", registry: "Verra", vintage: 2024 }, sale: { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: treasury } });
  // allow treasury + buyer wallet, mint supply to treasury
  const buyerWallet = await onboardKycBuyerWithWallet(app, admin); // returns the buyer's wallet; KYC-approve them
  await allow(app, admin, assetId, treasury);
  await allow(app, admin, assetId, buyerWallet);
  await mint(app, admin, assetId, treasury, "100");
  // fund the buyer with CBDC
  await creditCash(app, admin, { account: buyerWallet, currency: "CBDC-INR", amount: "1000" });
  // buyer logs in and buys 10 (cost 50)
  const buyer = await loginAs(app, "live.buyer@x.dev", "secret1");
  const res = await app.inject({ method: "POST", url: `/api/v1/assets/${assetId}/buy`, headers: auth(buyer), payload: { quantity: "10" } });
  expect(res.statusCode).toBe(200);
  expect(await cashBalance(app, admin, buyerWallet, "CBDC-INR")).toBe("950");
  expect(await cashBalance(app, admin, treasury, "CBDC-INR")).toBe("50");
  expect(await tokenBalance(app, admin, assetId, buyerWallet)).toBe("10");
});

it("buy is rejected (and cash refunded) when the buyer is not allowlisted", async () => { /* arrange as above but skip allow(buyerWallet); expect 400 and buyer cash unchanged */ });
it("buy is rejected with 400 when the asset has no sale terms", async () => { /* issue without sale; expect 400 NO_SALE_TERMS */ });
it("buy is rejected with INSUFFICIENT_FUNDS when the buyer cash < cost", async () => { /* fund 10, buy 10@5=50; expect 400 */ });
it("buy is rejected when the treasury holds fewer tokens than quantity", async () => { /* mint 5, buy 10; expect 400 INSUFFICIENT_TREASURY */ });
it("cash/credit is rejected for a Buyer caller (role gate)", async () => { /* buyer tries creditCash; expect 403 */ });
it("cash/credit is rejected for an out-of-scope account", async () => { /* admin of UC-A funds an account in UC-B; expect 403/404 */ });
```

Implement the small helpers (`creditCash`, `cashBalance`, `tokenBalance`, `someScopedAccountAddress`, `onboardKycBuyerWithWallet`) inline using `app.inject` against the routes below, mirroring existing helpers in the file. The buyer `live.buyer@x.dev` is onboarded via `POST /users` (Buyer + walletAddress) then KYC-approved via `PATCH /users/:id { kycStatus: "approved" }`.

- [ ] **Step 3: Run them, expect failure**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run test/api.test.ts`
Expected: FAIL — routes 404 / unknown.

### 6c. Routes

- [ ] **Step 4: Persist sale terms at issuance**

In `apps/api/src/http/routes.ts` `POST /assets` handler, after `deps.assets.create(...)`, if `body.sale` is present:
- validate `isSupportedCurrency(body.sale.currency)` → else `reply.code(400).send({ error: "UNSUPPORTED_CURRENCY", message: ... })`;
- `await deps.assets.setSaleTerms(id, body.sale)`.

Import `isSupportedCurrency` from `../currencies.js`. Ensure the created-asset response includes the sale terms (re-`get` the asset, or attach `body.sale`).

- [ ] **Step 5: Add the `setPrice` action branch**

In the `POST /assets/:id/actions/:action` switch in `routes.ts`, add a case (gate to roles allowed to issue — `actor.role` in `["Issuer","UseCaseAdmin","PlatformAdmin"]`, or reuse the RBAC `issue` check):

```ts
case "setPrice": {
  if (!isSupportedCurrency(b.currency!)) return reply.code(400).send({ error: "UNSUPPORTED_CURRENCY", message: `currency '${b.currency}' is not supported` });
  await deps.assets.setSaleTerms(asset.id, { unitPrice: b.unitPrice!, currency: b.currency!, treasuryAccount: b.treasuryAccount! });
  return reply.code(200).send({ ok: true });
}
```

Wire its body schema in the action route's schema map if actions are individually schema'd; otherwise validate inline. (Authorization: the engine isn't involved, so add an explicit role check — `deps.rbac.authorize(actor, "issue")` throws if not permitted, caught by the error handler.)

- [ ] **Step 6: Add `POST /assets/:id/buy` (DvP)**

Add a dedicated route (not under `/actions`) in `routes.ts`:

```ts
app.post("/assets/:id/buy", { schema: S.buy, ...auth }, async (request, reply) => {
  const asset = await deps.assets.get((request.params as { id: string }).id);
  if (!asset) return notFound(reply);
  if (!asset.unitPrice || !asset.currency || !asset.treasuryAccount) {
    return reply.code(400).send({ error: "NO_SALE_TERMS", message: "this asset is not listed for sale" });
  }
  const claims = request.user as TokenClaims;
  const actor = actorOf(request);
  // resolve the buyer's linked wallet
  const me = (await deps.users.list()).find((u) => u.id === claims.id);
  const wallet = me?.accountId ? (await deps.accounts.list()).find((a) => a.id === me.accountId)?.address : undefined;
  if (!wallet) return reply.code(400).send({ error: "NO_WALLET", message: "your account has no linked wallet to receive tokens" });

  const { unitPrice, currency, treasuryAccount } = asset;
  const quantity = (request.body as { quantity: string }).quantity;
  const cost = (BigInt(unitPrice) * BigInt(quantity)).toString();
  const ctx = contextOf(asset);
  const adapter = deps.chains.resolveAdapter(asset.chainId);

  // pre-checks
  if (BigInt(await deps.cash.balanceOf(currency, wallet)) < BigInt(cost)) {
    return reply.code(400).send({ error: "INSUFFICIENT_FUNDS", message: `you need ${cost} ${currency}` });
  }
  if (BigInt(await adapter.balanceOf(ctx.ref, treasuryAccount).catch(() => "0")) < BigInt(quantity)) {
    return reply.code(400).send({ error: "INSUFFICIENT_TREASURY", message: "the treasury does not hold enough tokens" });
  }

  // payment-first with compensation
  await deps.cash.transfer(currency, wallet, treasuryAccount, cost);
  try {
    const receipt = await deps.engine.buy(actor, ctx, treasuryAccount, wallet, quantity, { unitPrice, currency, cost });
    return reply.code(200).send({ receipt, paid: { amount: cost, currency }, delivered: { amount: quantity, to: wallet } });
  } catch (err) {
    await deps.cash.transfer(currency, treasuryAccount, wallet, cost); // refund
    throw err; // surfaced by the error handler (NOT_ALLOWLISTED / ACCOUNT_FROZEN → 400)
  }
});
```

Confirm `actorOf`, `contextOf`, `notFound`, `TokenClaims` are already imported in `routes.ts` (they are — see the existing action handler). Confirm the error handler maps `PolicyError` codes to 400 (it does for allow/transfer).

- [ ] **Step 7: Add `POST /cash/credit` (funding) + `GET /cash/balances`**

```ts
app.post("/cash/credit", { schema: S.creditCash, ...auth }, async (request, reply) => {
  const claims = request.user as TokenClaims;
  if (!["Issuer", "UseCaseAdmin", "PlatformAdmin"].includes(claims.role)) {
    return reply.code(403).send({ error: "FORBIDDEN", message: "you may not fund accounts" });
  }
  const b = request.body as { account: string; currency: string; amount: string };
  if (!isSupportedCurrency(b.currency)) return reply.code(400).send({ error: "UNSUPPORTED_CURRENCY", message: `currency '${b.currency}' is not supported` });
  // scope: target account must be in the caller's use case (PlatformAdmin unrestricted)
  if (claims.role !== "PlatformAdmin") {
    const scoped = await scopedAccounts(claims);
    if (!scoped.some((a) => a.address === b.account)) {
      return reply.code(403).send({ error: "OUT_OF_SCOPE", message: "that account is not in your use case" });
    }
  }
  await deps.cash.credit(b.currency, b.account, b.amount);
  return reply.code(200).send({ ok: true, balance: await deps.cash.balanceOf(b.currency, b.account) });
});

app.get("/cash/balances", { schema: S.cashBalances, ...auth }, async (request) => {
  const address = (request.query as { address?: string }).address;
  return address ? deps.cash.balancesOf(address) : [];
});
```

`scopedAccounts` already exists in `routes.ts`. Add `S.cashBalances` (query `{ address?: string }`, array response) and `S.creditCash` schemas.

- [ ] **Step 8: Run the API suite, expect pass**

Run: `cd apps/api && CI=true ../../node_modules/.bin/vitest run`
Expected: all green — prior 31 + new buy/funding cases.

- [ ] **Step 9: Typecheck + commit**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && ./node_modules/.bin/tsc --noEmit -p apps/api
git add apps/api/src/http/schemas.ts apps/api/src/http/routes.ts apps/api/test/api.test.ts
git commit -m "feat(api): issuance sale terms, setPrice, buy (DvP) + cash/credit endpoints"
```

---

## Task 7: Seed demo CBDC balances + test app wiring

**Files:**
- Modify: `apps/api/src/seed.ts`
- Modify: the test app builder (in `apps/api/test/`)

- [ ] **Step 1: Wire cash into the test builder (if not done in Task 5)**

Ensure the test app builder constructs `cash: new InMemoryCashRepository()` and `currencies: loadCurrencies()` so all API tests run.

- [ ] **Step 2: Seed demo balances**

In `apps/api/src/seed.ts`, after accounts + users are created, fund each buyer wallet so Buy works out of the box. Use the same `cash` repo the server wires (export a `seedCash(cash, accounts)` helper or fund inside the existing seed if it has repo access). Concretely, for every seeded buyer account, credit a default amount in the default currency:

```ts
const DEFAULT_CURRENCY = "CBDC-INR";
for (const acct of buyerAccounts) {
  await cash.credit(DEFAULT_CURRENCY, acct.address, "1000000");
}
```

Identify `buyerAccounts` from the seed's existing roster (accounts whose owning user role is `Buyer`, or the labelled buyer accounts the seed already creates). If `seed.ts` does not currently receive a `cash` repo, pass one in from `server.ts` where seeding is invoked.

- [ ] **Step 3: Re-seed live DB + smoke check**

Run:
```bash
cd apps/api && rm -f prisma/dev.db prisma/dev.db-journal prisma/dev.db-wal prisma/dev.db-shm && ./node_modules/.bin/prisma db push --skip-generate && ../../node_modules/.bin/tsx src/seed.ts
```
Expected: "Seeded …" with no error.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/seed.ts apps/api/test
git commit -m "feat(api): seed demo CBDC balances for buyer wallets"
```

---

## Task 8: Web — Buy panel, sale terms, CBDC balances, Fund control

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/rbac.ts`
- Modify: `apps/web/src/components/AssetManagement.tsx` (and its issuance / marketplace / holdings sub-views)

Web is verified via typecheck + live preview (no unit tests in this package).

- [ ] **Step 1: Mirror `buy` in the web RBAC**

In `apps/web/src/rbac.ts`, add `"buy"` to the `LifecycleAction` mirror union and grant it to `Buyer` and `Trader` (and the admin/full sets) exactly as Task 1 did for core.

- [ ] **Step 2: Extend the API client**

In `apps/web/src/api.ts`, add (matching the existing `fetchJson`/auth-header helper style):

```ts
export interface Currency { code: string; label: string; }
export interface CashBalance { currency: string; address: string; amount: string; }

export const currencies = (token: string) => api<Currency[]>(token, "GET", "/currencies");
export const cashBalances = (token: string, address: string) => api<CashBalance[]>(token, "GET", `/cash/balances?address=${encodeURIComponent(address)}`);
export const buy = (token: string, id: string, quantity: string) => api(token, "POST", `/assets/${id}/buy`, { quantity });
export const setPrice = (token: string, id: string, terms: { unitPrice: string; currency: string; treasuryAccount: string }) => api(token, "POST", `/assets/${id}/actions/setPrice`, terms);
export const creditCash = (token: string, account: string, currency: string, amount: string) => api(token, "POST", "/cash/credit", { account, currency, amount });
```

Also extend the existing `issue`/`createAsset` call to accept an optional `sale` object and pass it through. Match the file's actual function names + `api()` helper signature.

- [ ] **Step 3: Issuance — "List for sale" fields**

In the Token Issuance sub-view, add an optional collapsible "List for sale" section: unit price (number→string), currency (`<select>` populated from `currencies(token)`), treasury account (`<select>` from the scoped accounts already loaded for issuance). On submit, include `sale` only when all three are filled.

- [ ] **Step 4: Marketplace — Buy panel**

In the Marketplace / asset detail sub-view: when `asset.unitPrice && asset.currency` and `can(role, "buy")`, render a Buy panel — a quantity input, a live "Total = unitPrice × qty currency" line, the user's balance in that currency (from `cashBalances(token, myWallet)`), and a **Buy** button calling `buy(token, asset.id, qty)`. On success, refresh balances + holdings; on error, show the server `error`/`message` (e.g. `INSUFFICIENT_FUNDS`, `NO_WALLET`).

- [ ] **Step 5: My Holdings — CBDC balances**

Add a "Cash balances" section listing `cashBalances(token, myWallet)` as `amount currency` rows, above or beside the token holdings.

- [ ] **Step 6: Fund CBDC control (Issuer/UseCaseAdmin)**

Where admins manage the use case (e.g. Manage Users or a marketplace admin strip), add a small "Fund CBDC" form for Issuer/UseCaseAdmin: account (`<select>` of scoped accounts), currency (`<select>`), amount → `creditCash(...)`, then refresh.

- [ ] **Step 7: Typecheck the web app**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && ./node_modules/.bin/tsc --noEmit -p apps/web`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/rbac.ts apps/web/src/components
git commit -m "feat(web): Buy panel + sale terms + CBDC balances + Fund control"
```

---

## Task 9: End-to-end script + verification + docs

**Files:**
- Create: `apps/api/src/e2e-buy.ts`
- Modify: `README.md` (+ any user-facing docs)

- [ ] **Step 1: Write the e2e script**

Create `apps/api/src/e2e-buy.ts` modelled on `e2e-carbon.ts` (build an in-process app or hit a live server — match `e2e-carbon.ts`'s approach). It must assert, with clear PASS/FAIL lines:
1. Admin issues a fungible asset WITH sale terms (unitPrice 5, CBDC-INR, treasury account).
2. Allow treasury + a KYC-approved buyer wallet; mint 100 to treasury.
3. Fund the buyer 1000 CBDC-INR via `cash/credit`.
4. Buyer buys 10 → 200; buyer cash 950, treasury cash 50, buyer token balance 10.
5. Buyer attempts to buy 1,000,000 → 400 INSUFFICIENT_FUNDS; balances unchanged.
6. A non-allowlisted/non-KYC buyer's buy → 400 and cash refunded (balance unchanged).

- [ ] **Step 2: Run all gates**

Run:
```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" \
 && ./node_modules/.bin/tsc --noEmit -p apps/api && ./node_modules/.bin/tsc --noEmit -p apps/web \
 && (cd packages/core && CI=true ../../node_modules/.bin/vitest run) \
 && (cd apps/api && CI=true ../../node_modules/.bin/vitest run) \
 && (cd apps/api && ../../node_modules/.bin/tsx src/e2e-tenancy.ts) \
 && (cd apps/api && ../../node_modules/.bin/tsx src/e2e-carbon.ts) \
 && (cd apps/api && ../../node_modules/.bin/tsx src/e2e-buy.ts)
```
Expected: typechecks clean; core + api suites green; all three e2e scripts PASS.

- [ ] **Step 3: Live preview verification**

Restart the API (`CORS_ORIGINS="http://localhost:5174,http://localhost:5173"`, fresh seeded dev.db) and the web dev server, then via the preview tools: log in as a buyer, open a listed asset, confirm the Buy panel shows price + balance, buy a small quantity, and confirm balances + holdings update. Screenshot the result.

- [ ] **Step 4: Document**

Update `README.md` (and any marketplace/user docs) with a "Buy & CBDC payment" subsection: supported currencies config, listing an asset for sale, funding CBDC, and the buyer self-service DvP flow.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/e2e-buy.ts README.md docs
git commit -m "test+docs: e2e buy/DvP script + document marketplace buy & CBDC payment"
```

---

## Self-Review Notes (coverage vs spec)

- **Currencies + config** → Task 5 (config + loader + `GET /currencies`).
- **Cash ledger** → Task 3 (interface + memory + prisma + tests).
- **Asset sale terms** → Task 4 (columns + repo + `setSaleTerms`).
- **`buy` RBAC + engine.buy** → Tasks 1–2.
- **Buy DvP endpoint (payment-first + compensation, pre-checks)** → Task 6 (6c step 6).
- **Funding endpoint (role + scope gated)** → Task 6 (6c step 7).
- **Seed demo balances** → Task 7.
- **Web (client, issuance terms, Buy panel, balances, Fund)** → Task 8.
- **Testing (cash, buy happy/blocked/refund, funding scope) + e2e** → Tasks 3, 6, 9.
- **Type consistency:** `SaleTerms { unitPrice, currency, treasuryAccount }`, `CashBalanceRecord { currency, address, amount }`, `engine.buy(actor, ctx, from, to, amount, { unitPrice, currency, cost })`, action string `"buy"`, `"setPrice"` — used consistently across tasks.
- **Out of scope** (secondary market, FX, fractional prices) — not implemented, matching the spec.
