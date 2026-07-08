# Financial Terms & Cashflow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Config-declared financial `terms` on the use-case template + a cashflow engine that materializes the payment schedule at issue, tracks due/overdue status, and settles coupons and maturity redemptions pro-rata to token holders.

**Architecture:** Pure schedule/split math in `@tokenlayer/core` (`computeCashflowSchedule`, `splitProRata`); a `Cashflow` Prisma/memory model materialized in `POST /assets`; `GET /assets/:id/cashflows` (derived read-time status + payout preview) and `POST /assets/:id/cashflows/:cfId/execute` (pro-rata cash payout from a payer account; redemption additionally burns all balances and sets the asset `matured`). Web gets a CashflowPanel in AssetDetail. No background scheduler — status derives from the date at read.

**Tech Stack:** pnpm monorepo — `@tokenlayer/core` (pure domain, Vitest), `apps/api` (Fastify + Prisma/SQLite, Vitest), `apps/web` (React + Vite). Branch `feat/cashflow-terms-engine` (already checked out).

**Spec:** `docs/superpowers/specs/2026-07-08-cashflow-terms-engine-design.md`. One refinement vs the spec, adopted here: when the principal/maturity metadata field is **absent**, the schedule is empty (terms inapplicable for that asset — keeps existing bond tests green since `maturityDate` is optional there); only **present-but-invalid** values throw `INVALID_TERMS`. Periodic schedules also emit a final stub coupon at maturity for the last accrual period (interest between the last full coupon and maturity is not silently dropped).

**Known landmines (from prior cycles):**
- A new optional use-case config field MUST get its Prisma column + `UseCaseRow`/`rowToUseCase`/`useCaseToData` round-trip in the same commit — the deployed API reads use cases from Prisma; in-memory tests will not catch the gap.
- `deps.audit.listByAsset` returns rows **createdAt DESC**; `foldAsset` is order-sensitive — sort ascending before folding.
- Wire any new repo into `AppDeps` AND every construction site: `context.ts`, `server.ts`, `test/helpers.ts`, and the five inline-deps scripts (`demo.ts`, `e2e-buy.ts`, `e2e-tenancy.ts`, `e2e-carbon.ts`, `e2e-usecases.ts`).
- The engine independently gates `burn`: an Issuer (no `burn` capability) can execute coupons (cash only) but redemption resolves to UseCaseAdmin/PlatformAdmin — mirror this in a route comment, don't fight it.
- Invoice assets have `treasuryAccount: null` (no sale terms) — the execute route takes an optional `from` payer with `asset.treasuryAccount` as fallback; neither → 400 `NO_PAYER`.

---

## Task 1: Core — `computeCashflowSchedule` + `splitProRata`

**Files:**
- Create: `packages/core/src/cashflows.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/test/cashflows.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/cashflows.test.ts
import { describe, it, expect } from "vitest";
import { computeCashflowSchedule, splitProRata } from "../src/cashflows.js";

const TERMS = { principalField: "amountInr", maturityField: "dueDate", currency: "CBDC-INR" } as const;

describe("computeCashflowSchedule", () => {
  it("atMaturity → a single redemption row of the principal at the maturity date", () => {
    const rows = computeCashflowSchedule({ ...TERMS }, { amountInr: 1_000_000, dueDate: "2026-12-31" }, "2026-07-08T00:00:00.000Z");
    expect(rows).toEqual([{ seq: 1, kind: "redemption", dueDate: "2026-12-31", amount: "1000000" }]);
  });

  it("returns [] when the principal or maturity metadata field is absent (terms inapplicable)", () => {
    expect(computeCashflowSchedule({ ...TERMS }, { amountInr: 1_000_000 }, "2026-07-08T00:00:00.000Z")).toEqual([]);
    expect(computeCashflowSchedule({ ...TERMS }, { dueDate: "2026-12-31" }, "2026-07-08T00:00:00.000Z")).toEqual([]);
  });

  it("throws INVALID_TERMS for a non-positive principal or unparseable maturity", () => {
    expect(() => computeCashflowSchedule({ ...TERMS }, { amountInr: 0, dueDate: "2026-12-31" }, "2026-07-08T00:00:00.000Z")).toThrow(/INVALID_TERMS|positive/);
    expect(() => computeCashflowSchedule({ ...TERMS }, { amountInr: 100, dueDate: "not-a-date" }, "2026-07-08T00:00:00.000Z")).toThrow(/INVALID_TERMS|date/);
  });

  it("quarterly → coupons stepping from issue, a final stub coupon, then redemption at maturity", () => {
    // Issued 2026-01-15, matures 2026-12-31, 10% p.a. on 1,000,000.
    const rows = computeCashflowSchedule(
      { ...TERMS, principalField: "faceValue", maturityField: "maturityDate", rateField: "couponRate", frequency: "quarterly" },
      { faceValue: 1_000_000, maturityDate: "2026-12-31", couponRate: 10 },
      "2026-01-15T00:00:00.000Z",
    );
    // Coupon dates: 04-15, 07-15, 10-15 (strictly before maturity) + stub coupon 12-31 + redemption 12-31.
    expect(rows.map((r) => `${r.kind}:${r.dueDate}`)).toEqual([
      "coupon:2026-04-15", "coupon:2026-07-15", "coupon:2026-10-15", "coupon:2026-12-31", "redemption:2026-12-31",
    ]);
    // Q1 = 90 days: bp = round(10 × 90 / 365 × 100) = 247 → 1,000,000 × 247 / 10000 = 24,700.
    expect(rows[0]!.amount).toBe("24700");
    expect(rows.at(-1)!.amount).toBe("1000000");
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("splitProRata", () => {
  it("splits by balance with BigInt floor; dust is NOT distributed", () => {
    const out = splitProRata(1_000_000n, new Map([["a", 4000n], ["b", 1000n], ["t", 5000n]]));
    expect(out.get("a")).toBe(400000n);
    expect(out.get("b")).toBe(100000n);
    expect(out.get("t")).toBe(500000n);
  });
  it("floors odd splits (dust stays with the payer)", () => {
    const out = splitProRata(100n, new Map([["a", 1n], ["b", 1n], ["c", 1n]]));
    expect([...out.values()].reduce((s, v) => s + v, 0n)).toBe(99n); // 33+33+33; 1 dust undistributed
  });
  it("ignores zero/negative balances and returns empty on zero supply or total", () => {
    expect(splitProRata(100n, new Map([["a", 0n]])).size).toBe(0);
    expect(splitProRata(0n, new Map([["a", 5n]])).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tokenlayer/core exec vitest run test/cashflows.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/cashflows.ts
/**
 * Pure cashflow math for the use-case `terms` template: schedule generation
 * (coupons + redemption) and pro-rata payout splitting. No I/O, no Date.now —
 * callers inject `issuedAt`. All money math is BigInt over integer amounts.
 */
import { PolicyError } from "./errors.js";

export interface TermsConfig {
  principalField: string;
  maturityField: string;
  rateField?: string;
  frequency?: "atMaturity" | "monthly" | "quarterly" | "semiannual" | "annual";
  currency: string;
}

export interface ScheduledCashflow {
  seq: number;
  kind: "coupon" | "redemption";
  dueDate: string; // YYYY-MM-DD
  amount: string;  // integer decimal string
}

const MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const base = new Date(Date.UTC(y!, m! - 1 + months, d!));
  // Clamp month-end overflow (e.g. Jan 31 + 1mo → Feb 28) back to the last day.
  if (base.getUTCDate() !== d) base.setUTCDate(0);
  return base.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Coupon for `days` of accrual: principal × rate% p.a. × days/365, bp-clamped, floored. */
function couponAmount(principal: bigint, ratePct: number, days: number): bigint {
  const bp = Math.min(10000, Math.max(0, Math.round((ratePct * days) / 365 * 100)));
  return (principal * BigInt(bp)) / 10000n;
}

/**
 * Materialized schedule for one asset. Absent principal/maturity metadata →
 * empty schedule (terms inapplicable); present-but-invalid → INVALID_TERMS.
 */
export function computeCashflowSchedule(
  terms: TermsConfig,
  metadata: Record<string, unknown>,
  issuedAt: string,
): ScheduledCashflow[] {
  const rawPrincipal = metadata[terms.principalField];
  const rawMaturity = metadata[terms.maturityField];
  if (rawPrincipal === undefined || rawMaturity === undefined) return [];

  const n = typeof rawPrincipal === "number" ? rawPrincipal : Number(rawPrincipal);
  if (!Number.isFinite(n) || n <= 0) {
    throw new PolicyError("INVALID_TERMS", `terms: '${terms.principalField}' must be a positive number`);
  }
  const principal = BigInt(Math.round(n));
  const maturity = String(rawMaturity);
  if (!YMD.test(maturity) || Number.isNaN(Date.parse(maturity))) {
    throw new PolicyError("INVALID_TERMS", `terms: '${terms.maturityField}' must be a YYYY-MM-DD date`);
  }

  const rows: ScheduledCashflow[] = [];
  const frequency = terms.frequency ?? "atMaturity";
  if (frequency !== "atMaturity") {
    const rateRaw = terms.rateField ? metadata[terms.rateField] : undefined;
    const rate = typeof rateRaw === "number" ? rateRaw : Number(rateRaw);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new PolicyError("INVALID_TERMS", `terms: '${terms.rateField}' must be a non-negative number`);
    }
    const step = MONTHS[frequency]!;
    let prev = issuedAt.slice(0, 10);
    let due = addMonths(prev, step);
    while (due < maturity) {
      rows.push({ seq: rows.length + 1, kind: "coupon", dueDate: due, amount: couponAmount(principal, rate, daysBetween(prev, due)).toString() });
      prev = due;
      due = addMonths(due, step);
    }
    // Final stub accrual from the last coupon (or issue) to maturity.
    const stubDays = daysBetween(prev, maturity);
    if (stubDays > 0 && rate > 0) {
      rows.push({ seq: rows.length + 1, kind: "coupon", dueDate: maturity, amount: couponAmount(principal, rate, stubDays).toString() });
    }
  }
  rows.push({ seq: rows.length + 1, kind: "redemption", dueDate: maturity, amount: principal.toString() });
  return rows;
}

/** Pro-rata split of `total` over positive balances; BigInt floor, dust undistributed. */
export function splitProRata(total: bigint, balances: Map<string, bigint>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (total <= 0n) return out;
  let supply = 0n;
  for (const b of balances.values()) if (b > 0n) supply += b;
  if (supply <= 0n) return out;
  for (const [addr, bal] of balances) {
    if (bal <= 0n) continue;
    const share = (total * bal) / supply;
    if (share > 0n) out.set(addr, share);
  }
  return out;
}
```

Add to `packages/core/src/index.ts`:
```ts
export { computeCashflowSchedule, splitProRata, type TermsConfig, type ScheduledCashflow } from "./cashflows.js";
```
(Confirm `PolicyError` is exported from `./errors.js` — it is used this way in `validation.ts`. If the test's expected Q1 coupon differs by a day-count off-by-one, recompute by hand — `daysBetween("2026-01-15","2026-04-15")` = 90 — and fix the TEST only if the hand math disagrees; do not fudge the implementation.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @tokenlayer/core exec vitest run test/cashflows.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cashflows.ts packages/core/src/index.ts packages/core/test/cashflows.test.ts
git commit -m "feat(core): cashflow schedule + pro-rata split math for use-case terms"
```

---

## Task 2: Core — `terms` on `UseCaseDefinition` + validation

**Files:**
- Modify: `packages/core/src/types.ts` (after `uniqueBy`)
- Modify: `packages/core/src/validation.ts`
- Test: `packages/core/test/validation.test.ts`

- [ ] **Step 1: Failing validation tests**

Append inside the existing use-case validation describe (reuse the file's `FUNGIBLE_USE_CASE`-style fixture — read the file first; base it on a schema that has `amountInr` + `dueDate` number/string properties, adding them to a local copy if needed):

```ts
it("accepts a valid terms block", () => {
  const def = withInvoiceFields({ terms: { principalField: "amountInr", maturityField: "dueDate", currency: "CBDC-INR" } });
  expect(() => validateUseCaseDefinition(def)).not.toThrow();
});
it("rejects terms pointing at undeclared metadata fields", () => {
  const def = withInvoiceFields({ terms: { principalField: "nope", maturityField: "dueDate", currency: "CBDC-INR" } });
  expect(() => validateUseCaseDefinition(def)).toThrow(/terms/);
});
it("rejects a periodic frequency without a rateField, and an unknown frequency", () => {
  expect(() => validateUseCaseDefinition(withInvoiceFields({ terms: { principalField: "amountInr", maturityField: "dueDate", frequency: "quarterly", currency: "CBDC-INR" } }))).toThrow(/rateField/);
  expect(() => validateUseCaseDefinition(withInvoiceFields({ terms: { principalField: "amountInr", maturityField: "dueDate", frequency: "weekly", currency: "CBDC-INR" } }))).toThrow(/frequency/);
});
```
Define `withInvoiceFields(extra)` locally in the test: spread the file's valid-definition fixture, ensure `metadataSchema.properties` includes `amountInr` (number) + `dueDate` (string), and spread `extra`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tokenlayer/core exec vitest run test/validation.test.ts`
Expected: FAIL — no throw / unknown field.

- [ ] **Step 3: Add the type**

In `packages/core/src/types.ts`, inside `UseCaseDefinition` after `uniqueBy`:
```ts
  /**
   * Financial terms template: which metadata fields carry the principal,
   * maturity date, and (for periodic coupons) the % p.a. rate — plus the
   * payment frequency and cash-ledger currency. Drives the cashflow schedule
   * materialized at issue (see computeCashflowSchedule()).
   */
  terms?: {
    principalField: string;
    maturityField: string;
    rateField?: string;
    frequency?: "atMaturity" | "monthly" | "quarterly" | "semiannual" | "annual";
    currency: string;
  };
```

- [ ] **Step 4: Add validation**

In `validateUseCaseDefinition` after the `uniqueBy` line:
```ts
  if (d.terms !== undefined) validateTerms(d.terms, d.metadataSchema, String(d.key), fail);
```
Helper near `validateValuation`:
```ts
const TERM_FREQUENCIES = new Set(["atMaturity", "monthly", "quarterly", "semiannual", "annual"]);

function validateTerms(terms: unknown, schema: unknown, key: string, fail: (msg: string) => never): void {
  if (typeof terms !== "object" || terms === null) fail(`use case '${key}' 'terms' must be an object`);
  const t = terms as Record<string, unknown>;
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  for (const f of ["principalField", "maturityField"] as const) {
    if (typeof t[f] !== "string" || !(t[f] as string in props)) fail(`use case '${key}' terms.${f} must name a declared metadata field`);
  }
  if (t.rateField !== undefined && (typeof t.rateField !== "string" || !(t.rateField in props))) {
    fail(`use case '${key}' terms.rateField must name a declared metadata field`);
  }
  if (t.frequency !== undefined && (typeof t.frequency !== "string" || !TERM_FREQUENCIES.has(t.frequency))) {
    fail(`use case '${key}' terms.frequency must be one of ${[...TERM_FREQUENCIES].join("|")}`);
  }
  if (t.frequency !== undefined && t.frequency !== "atMaturity" && t.rateField === undefined) {
    fail(`use case '${key}' terms.rateField is required for periodic frequency`);
  }
  if (typeof t.currency !== "string" || t.currency === "") fail(`use case '${key}' terms.currency must be a non-empty string`);
}
```
(Watch the operator-precedence trap in the field check — write it as `!((t[f] as string) in props)`.)

- [ ] **Step 5: Run core tests, commit**

Run: `pnpm --filter @tokenlayer/core test` — Expected: ALL PASS.
```bash
git add packages/core/src/types.ts packages/core/src/validation.ts packages/core/test/validation.test.ts
git commit -m "feat(core): terms config on UseCaseDefinition with validation"
```

---

## Task 3: Config + persistence round-trip + web type

**Files:**
- Modify: `config/use-cases/invoice-tokenization.json`, `config/use-cases/corporate-bond.json`
- Modify: `apps/api/prisma/schema.prisma` (UseCase model), `apps/api/src/persistence/prisma.ts` (UseCaseRow + rowToUseCase + useCaseToData)
- Modify: `apps/web/src/types.ts` (UseCase)

- [ ] **Step 1: Configs**

`invoice-tokenization.json` — add sibling of `valuation`:
```json
"terms": { "principalField": "amountInr", "maturityField": "dueDate", "frequency": "atMaturity", "currency": "CBDC-INR" },
```
`corporate-bond.json` — its schema already has `faceValue`, `couponRate`, `maturityDate`; add:
```json
"terms": { "principalField": "faceValue", "maturityField": "maturityDate", "rateField": "couponRate", "frequency": "quarterly", "currency": "CBDC-INR" },
```
(Read the file first; if `faceValue`/`couponRate` are typed `string` in its schema, that is fine — `computeCashflowSchedule` Number()-coerces.)

- [ ] **Step 2: Prisma column + round-trip (same commit!)**

`schema.prisma` UseCase model, after `uniqueBy`:
```prisma
  terms            String   @default("{}") // JSON object: { principalField, maturityField, rateField?, frequency?, currency }
```
`prisma.ts`: add `terms: string;` to `UseCaseRow`; in `rowToUseCase` add `const terms = parseJsonObject(r.terms);` and `...(Object.keys(terms).length > 0 ? { terms: terms as UseCaseDefinition["terms"] } : {}),`; in `useCaseToData` add `terms: JSON.stringify(def.terms ?? {}),`.
Run: `pnpm --filter @tokenlayer/api exec prisma generate` — Expected: clean.

- [ ] **Step 3: Web type**

`apps/web/src/types.ts` `UseCase`, after `uniqueBy`:
```ts
  /** Financial terms template driving the cashflow schedule. */
  terms?: { principalField: string; maturityField: string; rateField?: string; frequency?: string; currency: string };
```

- [ ] **Step 4: Verify load + typecheck, commit**

Run: `pnpm --filter @tokenlayer/core build && pnpm --filter @tokenlayer/api exec tsx -e "import('./src/use-cases.js').then(m=>{const u=m.loadDefaultUseCaseDefinitions();console.log(u.find(x=>x.key==='invoice-tokenization').terms, u.find(x=>x.key==='corporate-bond').terms)})"`
Expected: both terms objects print.
Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/web exec tsc --noEmit` — clean.
```bash
git add config/use-cases apps/api/prisma/schema.prisma apps/api/src/persistence/prisma.ts apps/web/src/types.ts
git commit -m "config+persistence: terms on invoice (atMaturity) + bond (quarterly); Prisma round-trip; web type"
```

---

## Task 4: API — Cashflow model + repositories + wiring

**Files:**
- Modify: `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/types.ts`, `apps/api/src/persistence/prisma.ts`, `apps/api/src/persistence/memory.ts`
- Modify: `apps/api/src/context.ts` (AppDeps) + all construction sites: `apps/api/src/server.ts`, `apps/api/test/helpers.ts`, `apps/api/src/{demo,e2e-buy,e2e-tenancy,e2e-carbon,e2e-usecases}.ts`

- [ ] **Step 1: Prisma model**

```prisma
model Cashflow {
  id         String    @id @default(cuid())
  assetId    String
  seq        Int
  kind       String // "coupon" | "redemption"
  dueDate    String // YYYY-MM-DD
  amount     String // integer decimal string
  currency   String
  status     String    @default("scheduled") // "scheduled" | "executed"
  executedAt DateTime?
  createdAt  DateTime  @default(now())

  @@unique([assetId, seq])
}
```
Run: `pnpm --filter @tokenlayer/api exec prisma generate`.

- [ ] **Step 2: Repository types**

`apps/api/src/persistence/types.ts`:
```ts
export interface CashflowRecord {
  id: string;
  assetId: string;
  seq: number;
  kind: "coupon" | "redemption";
  dueDate: string;
  amount: string;
  currency: string;
  status: "scheduled" | "executed";
  executedAt: string | null;
}

export interface CashflowRepository {
  createMany(assetId: string, currency: string, rows: { seq: number; kind: "coupon" | "redemption"; dueDate: string; amount: string }[]): Promise<void>;
  listByAsset(assetId: string): Promise<CashflowRecord[]>; // ordered by seq asc
  get(id: string): Promise<CashflowRecord | null>;
  markExecuted(id: string, executedAt: string): Promise<CashflowRecord>;
}
```

- [ ] **Step 3: Implement both repos**

`prisma.ts` (module-level `prisma` singleton, matching the other repos):
```ts
const toCashflow = (r: { id: string; assetId: string; seq: number; kind: string; dueDate: string; amount: string; currency: string; status: string; executedAt: Date | null }): CashflowRecord => ({
  id: r.id, assetId: r.assetId, seq: r.seq, kind: r.kind as CashflowRecord["kind"], dueDate: r.dueDate,
  amount: r.amount, currency: r.currency, status: r.status as CashflowRecord["status"], executedAt: r.executedAt?.toISOString() ?? null,
});

export class PrismaCashflowRepository implements CashflowRepository {
  async createMany(assetId: string, currency: string, rows: { seq: number; kind: "coupon" | "redemption"; dueDate: string; amount: string }[]): Promise<void> {
    if (rows.length === 0) return;
    await prisma.cashflow.createMany({ data: rows.map((r) => ({ assetId, currency, ...r })) });
  }
  async listByAsset(assetId: string): Promise<CashflowRecord[]> {
    return (await prisma.cashflow.findMany({ where: { assetId }, orderBy: { seq: "asc" } })).map(toCashflow);
  }
  async get(id: string): Promise<CashflowRecord | null> {
    const r = await prisma.cashflow.findUnique({ where: { id } });
    return r ? toCashflow(r) : null;
  }
  async markExecuted(id: string, executedAt: string): Promise<CashflowRecord> {
    return toCashflow(await prisma.cashflow.update({ where: { id }, data: { status: "executed", executedAt: new Date(executedAt) } }));
  }
}
```
`memory.ts` (use the file's `now()` helper and `randomUUID` import, matching the other memory repos):
```ts
export class MemoryCashflowRepository implements CashflowRepository {
  private rows = new Map<string, CashflowRecord>();
  async createMany(assetId: string, currency: string, rows: { seq: number; kind: "coupon" | "redemption"; dueDate: string; amount: string }[]): Promise<void> {
    for (const r of rows) {
      const id = randomUUID();
      this.rows.set(id, { id, assetId, currency, status: "scheduled", executedAt: null, ...r });
    }
  }
  async listByAsset(assetId: string): Promise<CashflowRecord[]> {
    return [...this.rows.values()].filter((r) => r.assetId === assetId).sort((a, b) => a.seq - b.seq);
  }
  async get(id: string): Promise<CashflowRecord | null> { return this.rows.get(id) ?? null; }
  async markExecuted(id: string, executedAt: string): Promise<CashflowRecord> {
    const r = this.rows.get(id);
    if (!r) throw new Error(`unknown cashflow '${id}'`);
    r.status = "executed"; r.executedAt = executedAt;
    return r;
  }
}
```

- [ ] **Step 4: Wire everywhere**

Add `cashflows: CashflowRepository;` to `AppDeps` in `context.ts`; construct `new PrismaCashflowRepository()` in `server.ts` and `new MemoryCashflowRepository()` in `test/helpers.ts` + the five inline-deps scripts. Grep to find every deps object: `grep -rn "documents: new" apps/api/src apps/api/test` and add `cashflows:` beside each.

- [ ] **Step 5: Typecheck, commit**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit` — clean.
```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence apps/api/src/context.ts apps/api/src/server.ts apps/api/test/helpers.ts apps/api/src/demo.ts apps/api/src/e2e-*.ts
git commit -m "feat(api): Cashflow model + Prisma/memory repositories, wired into AppDeps"
```

---

## Task 5: API — materialize at issue + `GET /assets/:id/cashflows`

**Files:**
- Modify: `apps/api/src/http/routes.ts` (POST /assets + new GET), `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/cashflows.test.ts` (new)

- [ ] **Step 1: Failing tests**

```ts
// apps/api/test/cashflows.test.ts
import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

const UC = "invoice-tokenization";
const HOLDER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Carol — seeded account, linkable
const inv = (n: string, due: string) => ({ invoiceNumber: n, sellerGstin: "27AAECS1234F1Z5", buyerGstin: "29AABCU9876R1Z3", amountInr: 1000000, dueDate: due });

async function desk(app: FastifyInstance): Promise<string> {
  const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
  await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: "cf.holder@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { country: "IN" } } });
  return admin;
}

async function issueInvoice(app: FastifyInstance, admin: string, n: string, due: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { useCaseKey: UC, name: n, chainId: "fabric", initialSupply: "10000", treasuryAccount: HOLDER, metadata: inv(n, due) } });
  expect(res.statusCode).toBe(201);
  return res.json().asset.id as string;
}

describe("cashflows: materialization + listing", () => {
  it("issuing an invoice materializes one redemption cashflow at the due date", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-1", "2099-12-31");
    const res = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const { cashflows, preview } = res.json();
    expect(cashflows).toHaveLength(1);
    expect(cashflows[0]).toMatchObject({ kind: "redemption", dueDate: "2099-12-31", amount: "1000000", currency: "CBDC-INR", status: "scheduled" });
    // Redemption is always payable → preview shows the holder's full share.
    expect(preview?.cashflowId).toBe(cashflows[0].id);
    expect(preview?.split?.find((s: { address: string }) => s.address.toLowerCase() === HOLDER.toLowerCase())?.amount).toBe("1000000");
  });

  it("a past due date reads as overdue (derived, not stored)", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-2", "2020-01-01");
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    expect(cashflows[0].status).toBe("overdue");
  });

  it("tenancy: a foreign use-case user gets 404", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-3", "2099-12-31");
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(carbon) })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/cashflows.test.ts`
Expected: FAIL — route missing / no cashflows.

- [ ] **Step 3: Materialize in POST /assets**

In `routes.ts` `POST /assets`, inside the existing `try` block immediately after `deps.assets.create({...})` (before `setSaleTerms`), add:
```ts
      // Materialize the financial-terms schedule (coupons + redemption) so the
      // asset carries its cashflow ledger from birth. Empty when terms are
      // inapplicable for this asset's metadata; invalid values → INVALID_TERMS.
      if (useCase.terms) {
        const schedule = computeCashflowSchedule(useCase.terms, meta, new Date().toISOString());
        await deps.cashflows.createMany(id, useCase.terms.currency, schedule);
      }
```
Add `computeCashflowSchedule` to the `@tokenlayer/core` import. A `PolicyError("INVALID_TERMS")` thrown here propagates through the existing catch (fee refunded) — verify the app's PolicyError → 400 mapping applies (grep how other engine PolicyErrors surface; if the generic handler returns 400 with the code, nothing more to do).

- [ ] **Step 4: GET route + schema**

`schemas.ts` — add a `Cashflow` component and `listCashflows` schema following the file's existing style (params `{id}`, response array is fine loose). `routes.ts`, near the documents routes:
```ts
  // Derived read-time status — never stored; "due"/"overdue" flow from the date.
  function cashflowStatus(cf: CashflowRecord, today: string): "scheduled" | "due" | "overdue" | "executed" {
    if (cf.status === "executed") return "executed";
    if (cf.dueDate < today) return "overdue";
    if (cf.dueDate === today) return "due";
    return "scheduled";
  }

  // Current positive balances from the audit fold (source of truth shared with
  // analytics/compliance). listByAsset returns DESC — sort ASC before folding.
  async function assetBalances(assetId: string): Promise<Map<string, bigint>> {
    const { items } = await deps.audit.listByAsset(assetId, { limit: 10000 });
    const asc = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return foldAsset(asc).balances;
  }

  app.get("/assets/:id/cashflows", { schema: S.listCashflows, ...auth }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    const today = new Date().toISOString().slice(0, 10);
    const rows = (await deps.cashflows.listByAsset(asset.id)).map((cf) => ({ ...cf, status: cashflowStatus(cf, today) }));
    // Preview the next payable row (redemption is payable any time; coupons once due).
    const next = rows.find((cf) => cf.status !== "executed" && (cf.kind === "redemption" || cf.status !== "scheduled"));
    let preview: { cashflowId: string; split: { address: string; amount: string }[] } | null = null;
    if (next) {
      const split = splitProRata(BigInt(next.amount), await assetBalances(asset.id));
      preview = { cashflowId: next.id, split: [...split].map(([address, amount]) => ({ address, amount: amount.toString() })) };
    }
    return { cashflows: rows, preview };
  });
```
Imports: `foldAsset` from `../holders.js`, `splitProRata` from `@tokenlayer/core`, `CashflowRecord` from `../persistence/types.js`.

- [ ] **Step 5: Run tests, commit**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/cashflows.test.ts` — Expected: PASS (3).
```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/cashflows.test.ts
git commit -m "feat(api): materialize cashflow schedule at issue + GET /assets/:id/cashflows"
```

---

## Task 6: API — execute route (coupon + redemption) + audit actions

**Files:**
- Modify: `packages/core/src/types.ts` (`LifecycleAction` gains `"distribute" | "redeem"`), `apps/api/src/analytics.ts` (summarize cases), `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/cashflows.test.ts` (extend), `apps/api/test/analytics.test.ts` (small additions)

- [ ] **Step 1: Failing tests (extend cashflows.test.ts)**

```ts
describe("cashflows: execution", () => {
  it("redemption: pays holders pro-rata from the payer, burns balances, matures the asset", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-10", "2099-12-31");
    // Fund a payer account (buyer repayment landing) — use the platform admin's cash faucet.
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const PAYER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // Treasury (seeded)
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: PAYER, currency: "CBDC-INR", amount: "1000000" } });
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const cfId = cashflows[0].id;

    const exec = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cfId}/execute`, headers: auth(admin), payload: { from: PAYER } });
    expect(exec.statusCode).toBe(200);
    // Holder received face value.
    const bal = (await app.inject({ method: "GET", url: `${V1}/cash/balances?address=${HOLDER}`, headers: auth(platform) })).json();
    expect(bal.find((b: { currency: string }) => b.currency === "CBDC-INR")?.amount).toBe("1000000");
    // Tokens burned; asset matured.
    const accounts = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/accounts`, headers: auth(admin) })).json();
    expect(accounts.find((a: { address: string }) => a.address.toLowerCase() === HOLDER.toLowerCase())?.balance ?? "0").toBe("0");
    const asset = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(admin) })).json();
    expect(asset.status).toBe("matured");
    // Re-execute → 409.
    const again = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cfId}/execute`, headers: auth(admin), payload: { from: PAYER } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("ALREADY_EXECUTED");
  });

  it("redemption without payer funds → INSUFFICIENT_TREASURY_FUNDS; without payer → NO_PAYER", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-11", "2099-12-31");
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const noPayer = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(admin), payload: {} });
    expect(noPayer.statusCode).toBe(400);
    expect(noPayer.json().error).toBe("NO_PAYER");
    const broke = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(admin), payload: { from: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" } });
    expect(broke.statusCode).toBe(400);
    expect(broke.json().error).toBe("INSUFFICIENT_TREASURY_FUNDS");
  });

  it("redemption is blocked while an open listing escrows tokens", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-12", "2099-12-31");
    // Holder lists 100 tokens (holder session).
    const holderTok = await loginAs(app, "cf.holder@x.dev", "secret1");
    const list = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(holderTok), payload: { quantity: "100", unitPrice: "92", currency: "CBDC-INR" } });
    expect([200, 201]).toContain(list.statusCode);
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const exec = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(admin), payload: { from: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" } });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error).toBe("OPEN_LISTINGS_BLOCK_SETTLEMENT");
  });

  it("a future coupon is NOT_DUE (bond-style use case created on the fly)", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // Minimal fungible use case with quarterly terms, far maturity.
    const def = {
      key: "cf-note", name: "CF Note", tokenStandard: "ERC-20", symbol: "CFN",
      allowedChainIds: ["fabric"], defaultChainId: "fabric",
      metadataSchema: { type: "object", properties: { faceValue: { type: "number" }, couponRate: { type: "number" }, maturityDate: { type: "string" } }, required: ["faceValue"] },
      lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
      compliance: { allowlist: false, transferRestrictions: false },
      terms: { principalField: "faceValue", maturityField: "maturityDate", rateField: "couponRate", frequency: "quarterly", currency: "CBDC-INR" },
      roles: ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"],
    };
    expect((await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(platform), payload: def })).statusCode).toBe(201);
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(platform), payload: { useCaseKey: "cf-note", name: "NOTE-1", chainId: "fabric", initialSupply: "1000", treasuryAccount: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", metadata: { faceValue: 1000000, couponRate: 10, maturityDate: "2099-12-31" } } });
    expect(issued.statusCode).toBe(201);
    const assetId = issued.json().asset.id;
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(platform) })).json();
    const coupon = cashflows.find((c: { kind: string }) => c.kind === "coupon");
    expect(coupon).toBeTruthy();
    const exec = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${coupon.id}/execute`, headers: auth(platform), payload: { from: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" } });
    expect(exec.statusCode).toBe(400);
    expect(exec.json().error).toBe("NOT_DUE");
  });
});
```
(Adjust the cash-balances assertion path to the actual `GET /cash/balances` response shape — read the route first. If `POST /use-cases` requires deployable chains, `fabric` is always available in tests.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/cashflows.test.ts`
Expected: new tests FAIL — execute route missing.

- [ ] **Step 3: LifecycleAction + analytics summaries**

`packages/core/src/types.ts`: add `| "distribute" | "redeem"` to `LifecycleAction` (before `"read"`).
`apps/api/src/analytics.ts` `summarize`:
```ts
    case "distribute":
      return `coupon ${String(p.amount ?? "")} ${String(p.currency ?? "")} → ${String(p.holders ?? "?")} holder(s)`;
    case "redeem":
      return `redeemed ${String(p.amount ?? "")} ${String(p.currency ?? "")} → ${String(p.holders ?? "?")} holder(s)`;
```
(Distribute/redeem must NOT be added to the traded loop — servicing, not trading.)

- [ ] **Step 4: Execute route + schema**

`schemas.ts`: `executeCashflow` — params `{ id, cfId }`, body `{ from?: string }`.
`routes.ts` (after the GET route; note the engine independently gates `burn`, so redemption effectively requires UseCaseAdmin/PlatformAdmin while coupons work for an Issuer):
```ts
  app.post("/assets/:id/cashflows/:cfId/execute", { schema: S.executeCashflow, ...auth }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "act");
    if (!asset) return reply;
    const actor = actorOf(request);
    if (!deps.rbac.can(actor.role, "issue")) {
      return reply.code(403).send({ error: "FORBIDDEN", message: `role '${actor.role}' may not execute cashflows` });
    }
    const { cfId } = request.params as { id: string; cfId: string };
    const cf = await deps.cashflows.get(cfId);
    if (!cf || cf.assetId !== asset.id) return notFound(reply, "cashflow not found");
    if (cf.status === "executed") return reply.code(409).send({ error: "ALREADY_EXECUTED", message: "this cashflow was already executed" });

    const today = new Date().toISOString().slice(0, 10);
    // Coupons pay only once due; redemption may settle early (early repayment).
    if (cf.kind === "coupon" && cf.dueDate > today) {
      return reply.code(400).send({ error: "NOT_DUE", message: `coupon is due ${cf.dueDate}` });
    }
    if (cf.kind === "redemption") {
      const open = await deps.listings.listByAsset(asset.id, "open");
      if (open.length > 0) {
        return reply.code(409).send({ error: "OPEN_LISTINGS_BLOCK_SETTLEMENT", message: "cancel open listings before settling — escrowed tokens cannot be redeemed" });
      }
    }

    const payer = (request.body as { from?: string } | null)?.from ?? asset.treasuryAccount ?? null;
    if (!payer) return reply.code(400).send({ error: "NO_PAYER", message: "supply 'from' (the funded payer account) — this asset has no treasury account" });

    const balances = await assetBalances(asset.id);
    const split = splitProRata(BigInt(cf.amount), balances);
    split.delete(payer); // the payer's own share stays with the payer
    let payable = 0n;
    for (const v of split.values()) payable += v;
    if (BigInt(await deps.cash.balanceOf(cf.currency, payer)) < payable) {
      return reply.code(400).send({ error: "INSUFFICIENT_TREASURY_FUNDS", message: `payer needs ${payable} ${cf.currency} (record the repayment via /cash/credit first)` });
    }

    // Pay sequentially with compensation on failure (mirrors the buy path).
    const paid: [string, bigint][] = [];
    try {
      for (const [addr, amount] of split) {
        await deps.cash.transfer(cf.currency, payer, addr, amount.toString());
        paid.push([addr, amount]);
      }
    } catch (err) {
      for (const [addr, amount] of paid) {
        await deps.cash.transfer(cf.currency, addr, payer, amount.toString()).catch(() => {});
      }
      throw err;
    }

    // Redemption closes the lifecycle: burn every remaining balance, mature the asset.
    if (cf.kind === "redemption") {
      const ctx = contextOf(asset);
      for (const [addr, bal] of balances) {
        if (bal > 0n) await deps.engine.burn(actor, ctx, addr, bal.toString());
      }
      await deps.assets.setStatus(asset.id, "matured");
    }

    const executed = await deps.cashflows.markExecuted(cf.id, new Date().toISOString());
    await deps.audit.append({
      assetId: asset.id,
      actorId: actor.id,
      action: cf.kind === "redemption" ? "redeem" : "distribute",
      payload: { currency: cf.currency, amount: cf.amount, holders: split.size, from: payer, seq: cf.seq },
      chainId: asset.chainId,
    });
    return { cashflow: { ...executed, status: "executed" } };
  });
```

- [ ] **Step 5: Analytics guard test (extend analytics.test.ts)**

```ts
it("distribute/redeem events do not count as traded volume", () => {
  const a = [asset({ id: "n1", chainId: "fabric", useCaseKey: "carbon-credit" })];
  const audit = [
    entry("n1", "mint", { to: ALICE, amount: "100" }, "2026-06-01T00:00:00.000Z"),
    entry("n1", "distribute", { currency: "CBDC-INR", amount: "5000", holders: 2 }, "2026-06-02T00:00:00.000Z"),
    entry("n1", "redeem", { currency: "CBDC-INR", amount: "100000", holders: 2 }, "2026-06-03T00:00:00.000Z"),
  ];
  const r = computeAnalytics({ ...base, assets: a, audit });
  expect(r.totals.trades).toBe(0);
  expect(r.totals.tradedByCurrency).toEqual({});
  expect(r.recent.find((e) => e.action === "distribute")?.summary).toContain("coupon 5000");
});
```

- [ ] **Step 6: Run full api + core suites, commit**

Run: `pnpm --filter @tokenlayer/core test && pnpm --filter @tokenlayer/api test` — Expected: ALL PASS.
```bash
git add packages/core/src/types.ts apps/api/src/analytics.ts apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/cashflows.test.ts apps/api/test/analytics.test.ts
git commit -m "feat(api): execute cashflows — pro-rata payout, redemption burn+mature, distribute/redeem audit"
```

---

## Task 7: Web — Cashflows & Settlement panel

**Files:**
- Modify: `apps/web/src/types.ts`, `apps/web/src/api.ts`
- Create: `apps/web/src/components/CashflowPanel.tsx`
- Modify: `apps/web/src/components/AssetDetail.tsx`

- [ ] **Step 1: Types + client**

`types.ts`:
```ts
export interface Cashflow {
  id: string;
  assetId: string;
  seq: number;
  kind: "coupon" | "redemption";
  dueDate: string;
  amount: string;
  currency: string;
  status: "scheduled" | "due" | "overdue" | "executed";
  executedAt: string | null;
}
export interface CashflowPreview { cashflowId: string; split: { address: string; amount: string }[] }
```
`api.ts`:
```ts
  cashflows: (token: string, assetId: string) =>
    request<{ cashflows: Cashflow[]; preview: CashflowPreview | null }>(`/assets/${assetId}/cashflows`, token),
  executeCashflow: (token: string, assetId: string, cfId: string, from?: string) =>
    request<{ cashflow: Cashflow }>(`/assets/${assetId}/cashflows/${cfId}/execute`, token, { method: "POST", body: JSON.stringify(from ? { from } : {}) }),
```

- [ ] **Step 2: CashflowPanel component**

`CashflowPanel.tsx` — follow the codebase's card/table/pill idioms (read AssetDetail's market card for class names):
```tsx
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import { can } from "../rbac.js";
import type { Asset, Cashflow, CashflowPreview, Role, UseCase } from "../types.js";

const TONE: Record<Cashflow["status"], string> = {
  scheduled: "bg-slate-100 text-slate-500",
  due: "bg-amber-100 text-amber-700",
  overdue: "bg-red-100 text-red-700",
  executed: "bg-emerald-100 text-emerald-700",
};

export function CashflowPanel({ asset, useCase, role, onChanged }: { asset: Asset; useCase: UseCase; role: Role; onChanged: () => void }): JSX.Element | null {
  const { token } = useAuth();
  const [rows, setRows] = useState<Cashflow[]>([]);
  const [preview, setPreview] = useState<CashflowPreview | null>(null);
  const [accounts, setAccounts] = useState<{ address: string; label: string }[]>([]);
  const [payer, setPayer] = useState("");
  const [repayAmount, setRepayAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    const r = await api.cashflows(token, asset.id);
    setRows(r.cashflows);
    setPreview(r.preview);
  }, [token, asset.id]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (token) void api.accounts(token).then(setAccounts).catch(() => {}); }, [token]);

  if (!useCase.terms || rows.length === 0) return null;
  const operator = can(role, "issue");
  const payable = (cf: Cashflow) => cf.status !== "executed" && (cf.kind === "redemption" || cf.status === "due" || cf.status === "overdue");

  async function run(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true); setError(null);
    try { await fn(); await reload(); onChanged(); }
    catch (err) { setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Action failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
      <h3 className="text-sm font-semibold text-slate-800">Cashflows & settlement</h3>
      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}
      <table className="w-full text-sm">
        <thead className="text-xs text-slate-500 uppercase tracking-wide">
          <tr><th className="text-left py-1.5">#</th><th className="text-left">Type</th><th className="text-left">Due</th><th className="text-right">Amount</th><th className="text-left pl-4">Status</th><th /></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((cf) => (
            <tr key={cf.id}>
              <td className="py-2 text-slate-500">{cf.seq}</td>
              <td className="capitalize text-slate-700">{cf.kind}</td>
              <td className="text-slate-600">{cf.dueDate}</td>
              <td className="text-right font-mono text-slate-700">₹{Number(cf.amount).toLocaleString("en-IN")}</td>
              <td className="pl-4"><span className={`text-xs px-2 py-0.5 rounded-full ${TONE[cf.status]}`}>{cf.status}</span></td>
              <td className="text-right">
                {operator && payable(cf) && cf.kind === "coupon" && (
                  <button disabled={busy} onClick={() => void run(() => api.executeCashflow(token!, asset.id, cf.id, payer || undefined))} className="text-xs rounded bg-brand-600 text-white px-2.5 py-1 hover:bg-brand-700 disabled:opacity-50">Pay coupon</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {operator && rows.some((cf) => cf.kind === "redemption" && cf.status !== "executed") && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2">
          <div className="text-xs font-medium text-slate-600">Record repayment & settle</div>
          <div className="grid grid-cols-3 gap-3">
            <select className="select" value={payer} onChange={(e) => setPayer(e.target.value)} disabled={busy}>
              <option value="">Payer account…</option>
              {accounts.map((a) => <option key={a.address} value={a.address}>{a.label}</option>)}
            </select>
            <input className="input" type="number" min="1" placeholder={`Repayment (default ₹${Number(rows.find((c) => c.kind === "redemption")?.amount ?? 0).toLocaleString("en-IN")})`} value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} disabled={busy} />
            <button
              disabled={busy || !payer}
              onClick={() => {
                const cf = rows.find((c) => c.kind === "redemption" && c.status !== "executed")!;
                void run(async () => {
                  await api.creditCash(token!, payer, cf.currency, repayAmount || cf.amount);
                  await api.executeCashflow(token!, asset.id, cf.id, payer);
                });
              }}
              className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? "Settling…" : "Settle at maturity"}
            </button>
          </div>
          {preview && (
            <div className="text-[11px] text-slate-500">
              Payout preview: {preview.split.map((s) => `${s.address.slice(0, 6)}… ₹${Number(s.amount).toLocaleString("en-IN")}`).join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```
(Adjust to the real `can`/`api.creditCash` signatures — read `rbac.ts` and `api.ts` first. `creditCash(token, account, currency, amount)` exists.)

- [ ] **Step 3: Mount in AssetDetail**

Import and render after the asset header card, before the Buy panel:
```tsx
{useCase.terms && <CashflowPanel asset={asset} useCase={useCase} role={role} onChanged={() => { void reload(); onChanged(); }} />}
```

- [ ] **Step 4: Typecheck + build, commit**

Run: `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build` — clean.
```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/components/CashflowPanel.tsx apps/web/src/components/AssetDetail.tsx
git commit -m "feat(web): Cashflows & Settlement panel — schedule, pay coupon, record repayment & settle"
```

---

## Task 8: Verify — full suite, live E2E through settlement, review, merge

- [ ] **Step 1: Full workspace suite**

Run: `pnpm --filter @tokenlayer/core test && pnpm --filter @tokenlayer/adapters test && pnpm --filter @tokenlayer/api test && pnpm --filter @tokenlayer/contracts test && pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: all green (core gains cashflow+terms tests; api gains cashflows tests).

- [ ] **Step 2: Rebuild + fresh-volume deploy**

`docker compose build api web && docker compose down -v && docker compose up -d`; wait for admin login 200; confirm `GET /use-cases/invoice-tokenization` shows `terms`.

- [ ] **Step 3: Live E2E**

Extend the scratchpad invoice E2E (`invoice-erc20-e2e.mjs` pattern) with settlement:
tokenize ₹10L → holder lists @ ₹92 → financier buys 4,000 → **cancel remaining listing** (settlement blocks on open listings) → `GET cashflows` shows the redemption row → attempt execute without funds → `INSUFFICIENT_TREASURY_FUNDS` → credit ₹10L to the payer → execute → assert: financier cash +₹4,00,000 (yield ₹32,000 over the ₹3,68,000 paid), holder cash + its share, balances zero, asset `matured`, dashboard Tokenized value dropped by ₹10L, recent feed shows `redeem`. Print ✓/✗ per check; all ✓.

- [ ] **Step 4: Code review**

Dispatch an adversarial review of `git diff main...feat/cashflow-terms-engine` focused on: pro-rata/dust math, compensation on partial payment failure, the payer-share skip, redemption vs escrow/listings, derived-status correctness at date boundaries, Prisma round-trip parity (terms column), memory/prisma repo parity. Fix real findings; re-run affected suites.

- [ ] **Step 5: Merge + memory**

```bash
git checkout main && git merge --no-ff feat/cashflow-terms-engine -m "Merge: financial terms & cashflow engine — config-declared schedules, pro-rata distributions, repayment-triggered maturity settlement"
```
Rebuild + fresh deploy from main. Update `product-feature-roadmap.md` memory (Template v2 cycle ① done; gotchas found).
