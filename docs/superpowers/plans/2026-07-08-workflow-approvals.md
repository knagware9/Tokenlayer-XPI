# Lifecycle States + Maker-Checker Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Config-declared maker-checker approvals (`workflow.approvals`) over issue / lifecycle actions / cashflow execution, with an asset `pending_approval → active | rejected` lifecycle, a generic Proposal queue, SoD (proposer ≠ approver), and a CAS-guarded execution transition.

**Architecture:** A `Proposal` record captures a gated operation's payload; gated routes run ALL their validations, then return 202 with a proposal instead of side effects. The side-effect cores are extracted into `apps/api/src/executors.ts` (coded-error style) and shared by the direct routes (ungated) and the approval service (gated, executed as the proposer's identity, looked up at execution time). The pending→approved transition is an atomic CAS so concurrent Nth approvals execute exactly once.

**Tech Stack:** pnpm monorepo — `@tokenlayer/core`, `apps/api` (Fastify + Prisma/SQLite, Vitest), `apps/web`. Branch `feat/workflow-approvals` (checked out).

**Spec:** `docs/superpowers/specs/2026-07-08-workflow-approvals-design.md`.

**Landmines (carry-overs):** new config field ⇒ Prisma column + `UseCaseRow`/`rowToUseCase`/`useCaseToData` round-trip in the SAME commit; new repo ⇒ wire into `AppDeps` + all 7 construction sites (`server.ts`, `test/helpers.ts`, `demo.ts`, `e2e-buy.ts`, `e2e-tenancy.ts`, `e2e-carbon.ts`, `e2e-usecases.ts` — grep `cashflows: new`); the transition that triggers execution must be a CAS (`updateMany` where-status); e2e scripts must not send `Content-Type: application/json` on bodyless requests.

**Route anchors (verified against current code):**
- Issue route `apps/api/src/http/routes.ts` ~189–328: schedule computed ~236–248; fee ~250–273; try block issues + creates asset (`status: "active"` at ~289) + `cashflows.createMany` ~298 + `setSaleTerms` ~299–301 + treasury allowlist+mint ~302–311; catch refunds fee + maps P2002.
- Action route ~450–506: switch over mint/transfer/burn/freeze/unfreeze/allow/disallow/setPrice; gated set = the first five cases only.
- Cashflow execute route ~1016–1142: pre-checks (issue-cap ~1020, burn pre-gate ~1028, ALREADY_EXECUTED ~1032, NOT_DUE ~1036, COUPONS_OUTSTANDING ~1041, early listings ~1049, payer resolve+scope ~1055–1067, split/NO_HOLDERS/funds ~1069–1079) then the claim + payout + burn + markExecuted + audit block ~1081–1141.

---

## Task 1: Core — `workflow` config + validation

**Files:**
- Modify: `packages/core/src/types.ts` (after `terms`), `packages/core/src/validation.ts`
- Test: `packages/core/test/validation.test.ts`

- [ ] **Step 1: Failing tests** (reuse the file's fixture helpers as in the `terms` tests):

```ts
it("accepts a valid workflow block", () => {
  const def = { ...FIXTURE, workflow: { approvals: { issue: 1, "cashflow-execute": 2 } } };
  expect(() => validateUseCaseDefinition(def)).not.toThrow();
});
it("rejects unknown gated ops and non-positive counts", () => {
  expect(() => validateUseCaseDefinition({ ...FIXTURE, workflow: { approvals: { list: 1 } } })).toThrow(/workflow/);
  expect(() => validateUseCaseDefinition({ ...FIXTURE, workflow: { approvals: { issue: 0 } } })).toThrow(/workflow/);
  expect(() => validateUseCaseDefinition({ ...FIXTURE, workflow: { approvals: { issue: 1.5 } } })).toThrow(/workflow/);
});
```
(`FIXTURE` = whatever valid-definition object the file already uses.)

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @tokenlayer/core exec vitest run test/validation.test.ts` → FAIL.

- [ ] **Step 3: Types** — in `UseCaseDefinition` after `terms`:

```ts
  /**
   * Maker-checker policy: gated operations require N approvals from capability
   * holders other than the proposer before they execute. Unlisted ops run
   * instantly. No role bypasses a gated op — including admins.
   */
  workflow?: {
    approvals?: Partial<Record<GatedOp, number>>;
  };
```
And near `LifecycleAction`:
```ts
/** Operations that may be gated behind maker-checker approvals. */
export type GatedOp = "issue" | "mint" | "transfer" | "burn" | "freeze" | "unfreeze" | "cashflow-execute";
export const GATED_OPS: readonly GatedOp[] = ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "cashflow-execute"];
```

- [ ] **Step 4: Validation** — call `if (d.workflow !== undefined) validateWorkflow(d.workflow, String(d.key), fail);` after the `terms` line; helper near `validateTerms`:

```ts
const GATED_OP_SET = new Set<string>(GATED_OPS);

function validateWorkflow(workflow: unknown, key: string, fail: (msg: string) => never): void {
  if (typeof workflow !== "object" || workflow === null) fail(`use case '${key}' 'workflow' must be an object`);
  const approvals = (workflow as Record<string, unknown>).approvals;
  if (approvals === undefined) return;
  if (typeof approvals !== "object" || approvals === null) fail(`use case '${key}' workflow.approvals must be an object`);
  for (const [op, n] of Object.entries(approvals as Record<string, unknown>)) {
    if (!GATED_OP_SET.has(op)) fail(`use case '${key}' workflow.approvals has unknown operation '${op}'`);
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) fail(`use case '${key}' workflow.approvals.${op} must be an integer >= 1`);
  }
}
```
(Import `GATED_OPS` from `./types.js`.)

- [ ] **Step 5: Run core tests + commit**

Run: `pnpm --filter @tokenlayer/core test` → ALL PASS.
```bash
git add packages/core/src/types.ts packages/core/src/validation.ts packages/core/test/validation.test.ts
git commit -m "feat(core): workflow.approvals maker-checker config with validation"
```

---

## Task 2: Config + persistence round-trip + web type

**Files:**
- Modify: `config/use-cases/invoice-tokenization.json`, `config/use-cases/corporate-bond.json`
- Modify: `apps/api/prisma/schema.prisma` (UseCase model), `apps/api/src/persistence/prisma.ts`
- Modify: `apps/web/src/types.ts`

- [ ] **Step 1: Configs** — add sibling of `terms`:
  - invoice: `"workflow": { "approvals": { "cashflow-execute": 1 } },`
  - bond: `"workflow": { "approvals": { "issue": 1, "cashflow-execute": 1 } },`

- [ ] **Step 2: Prisma round-trip (same commit)** — schema: `workflow String @default("{}")` after `terms`; `prisma.ts`: `workflow: string;` in `UseCaseRow`, `const workflow = parseJsonObject(r.workflow);` + `...(Object.keys(workflow).length > 0 ? { workflow: workflow as UseCaseDefinition["workflow"] } : {}),` in `rowToUseCase`, `workflow: JSON.stringify(def.workflow ?? {}),` in `useCaseToData`. Run `pnpm --filter @tokenlayer/api exec prisma generate`.

- [ ] **Step 3: Web type** — `apps/web/src/types.ts` `UseCase` after `terms`:
```ts
  /** Maker-checker policy: gated op → required approvals. */
  workflow?: { approvals?: Record<string, number> };
```

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter @tokenlayer/core build && pnpm --filter @tokenlayer/api exec tsx -e "import('./src/use-cases.js').then(m=>{const u=m.loadDefaultUseCaseDefinitions();console.log(u.find(x=>x.key==='invoice-tokenization').workflow, u.find(x=>x.key==='corporate-bond').workflow)})"`
Expected: both workflow objects print.
Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/web exec tsc --noEmit` → clean.
```bash
git add config/use-cases apps/api/prisma/schema.prisma apps/api/src/persistence/prisma.ts apps/web/src/types.ts
git commit -m "config+persistence: workflow approvals on invoice (settlement) + bond (issue+settlement); Prisma round-trip; web type"
```

---

## Task 3: API — Proposal model + repositories + wiring

**Files:**
- Modify: `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/{types,prisma,memory}.ts`
- Modify: `apps/api/src/context.ts` + the 7 construction sites (grep `cashflows: new`)

- [ ] **Step 1: Prisma model**

```prisma
model Proposal {
  id            String    @id @default(cuid())
  useCaseKey    String
  assetId       String?
  kind          String
  payload       String // JSON
  proposerId    String
  proposerLabel String
  required      Int
  approvals     String    @default("[]") // JSON [{userId,email,at}]
  status        String    @default("pending") // pending|approved|rejected|executed|failed
  error         String?
  createdAt     DateTime  @default(now())
  decidedAt     DateTime?

  @@index([useCaseKey, status])
}
```
Run `prisma generate`.

- [ ] **Step 2: Repo types** (`persistence/types.ts`):

```ts
export interface ProposalApproval { userId: string; email: string; at: string; }
export interface ProposalRecord {
  id: string;
  useCaseKey: string;
  assetId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  proposerId: string;
  proposerLabel: string;
  required: number;
  approvals: ProposalApproval[];
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
}
export interface ProposalRepository {
  create(input: Omit<ProposalRecord, "id" | "approvals" | "status" | "error" | "createdAt" | "decidedAt">): Promise<ProposalRecord>;
  get(id: string): Promise<ProposalRecord | null>;
  list(useCaseKey?: string, status?: string): Promise<ProposalRecord[]>; // createdAt desc
  /** Append an approval; throws coded error if this userId already approved. */
  addApproval(id: string, approval: ProposalApproval): Promise<ProposalRecord>;
  /** CAS pending → approved. Returns false when the row is no longer pending. */
  claimApproved(id: string): Promise<boolean>;
  setStatus(id: string, status: ProposalRecord["status"], error?: string | null): Promise<ProposalRecord>;
}
```

- [ ] **Step 3: Implement both repos.** Prisma: JSON round-trip for payload/approvals (mirror the Cashflow repo's `to…` mapper style); `addApproval` reads, rejects duplicates by userId with `Object.assign(new Error("already approved"), { code: "ALREADY_APPROVED" })`, writes the appended array; `claimApproved` = `updateMany({ where: { id, status: "pending" }, data: { status: "approved" } })` → `count === 1`; `setStatus` sets `decidedAt: new Date()` for terminal states (rejected/executed/failed). Memory: same semantics over a Map (follow `MemoryCashflowRepository` idioms, `id("proposal")` helper).

- [ ] **Step 4: Wire** — `proposals: ProposalRepository` into `AppDeps` + all 7 construction sites (`PrismaProposalRepository` in server, `MemoryProposalRepository` elsewhere). Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence apps/api/src/context.ts apps/api/src/server.ts apps/api/test/helpers.ts apps/api/src/demo.ts apps/api/src/e2e-*.ts
git commit -m "feat(api): Proposal model + Prisma/memory repositories with CAS approve transition"
```

---

## Task 4: API — executor extraction (pure refactor, behavior unchanged)

**Files:**
- Create: `apps/api/src/executors.ts`
- Modify: `apps/api/src/http/routes.ts` (issue / action / cashflow-execute routes call the executors)

- [ ] **Step 1: Coded-error helper + executors.** `executors.ts`:

```ts
/**
 * Side-effect cores of the gatable operations, shared by the direct routes
 * (ungated) and the approval service (executed as the proposer's identity).
 * Failures throw CodedError so callers map them to HTTP or proposal `error`.
 */
import type { Actor } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import type { AssetRecord, CashflowRecord } from "./persistence/types.js";
import { contextOf } from "./http/support.js";
import { splitProRata } from "@tokenlayer/core";
import { foldAsset } from "./holders.js";

export class CodedError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = "CodedError";
  }
}
export const coded = (statusCode: number, code: string, message: string): CodedError => new CodedError(statusCode, code, message);

/** Activate a pending (or complete an ungated) issuance: sale terms + treasury allowlist + initial-supply mint + status active. */
export async function executeIssueActivation(
  deps: AppDeps,
  actor: Actor,
  asset: AssetRecord,
  p: { initialSupply?: string; treasury?: string; sale?: { unitPrice: string; currency: string; treasuryAccount: string } },
): Promise<void> {
  if (p.sale) await deps.assets.setSaleTerms(asset.id, p.sale);
  if (p.initialSupply && p.treasury) {
    const fresh = (await deps.assets.get(asset.id))!;
    const ctx = contextOf(fresh);
    const useCase = await deps.useCases.get(asset.useCaseKey);
    if (useCase.compliance.allowlist) await deps.engine.setAllowed(actor, ctx, p.treasury, true);
    await deps.engine.mint(actor, ctx, p.treasury, p.initialSupply);
  }
  await deps.assets.setStatus(asset.id, "active");
}

/** The five gatable lifecycle actions (mint/transfer/burn/freeze/unfreeze), engine-dispatched. */
export async function runGatedAction(
  deps: AppDeps,
  actor: Actor,
  asset: AssetRecord,
  action: string,
  b: Record<string, string>,
): Promise<{ txHash: string }> {
  const ctx = contextOf(asset);
  const isNft = asset.tokenType === "nonfungible";
  switch (action) {
    case "mint": return isNft ? deps.engine.mintToken(actor, ctx, b.to!, b.tokenId!, b.uri) : deps.engine.mint(actor, ctx, b.to!, b.amount!);
    case "transfer": return isNft ? deps.engine.transferToken(actor, ctx, b.from!, b.to!, b.tokenId!) : deps.engine.transfer(actor, ctx, b.from!, b.to!, b.amount!);
    case "burn": return isNft ? deps.engine.burnToken(actor, ctx, b.tokenId!) : deps.engine.burn(actor, ctx, b.from!, b.amount!);
    case "freeze": return deps.engine.setFrozen(actor, ctx, b.account!, true);
    case "unfreeze": return deps.engine.setFrozen(actor, ctx, b.account!, false);
    default: throw coded(400, "VALIDATION_ERROR", `unknown gated action '${action}'`);
  }
}

/** Current positive balances from the audit fold (asc sort — listByAsset returns desc). */
export async function assetBalancesOf(deps: AppDeps, assetId: string): Promise<Map<string, bigint>> {
  const { items } = await deps.audit.listByAsset(assetId, { limit: 100000 });
  const asc = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return foldAsset(asc).balances;
}

/**
 * Execute a validated cashflow: CAS claim, pro-rata payout from `payer`,
 * redemption burn-all + mature, markExecuted + audit. Throws CodedError on
 * guard failures (claim released, payments refunded best-effort).
 * PRE-CONDITIONS the caller has already enforced (route at request time,
 * approval service at propose time): actor capability, NOT_DUE,
 * COUPONS_OUTSTANDING, payer resolution + scoping.
 */
export async function executeCashflowCore(
  deps: AppDeps,
  actor: Actor,
  asset: AssetRecord,
  cf: CashflowRecord,
  payer: string,
  log: { error: (obj: unknown, msg: string) => void },
): Promise<CashflowRecord> {
  if (cf.kind === "redemption") {
    const open = await deps.listings.listByAsset(asset.id, "open");
    if (open.length > 0) throw coded(409, "OPEN_LISTINGS_BLOCK_SETTLEMENT", "cancel open listings before settling — escrowed tokens cannot be redeemed");
  }
  const balances = await assetBalancesOf(deps, asset.id);
  const split = splitProRata(BigInt(cf.amount), balances);
  for (const key of [...split.keys()]) if (key.toLowerCase() === payer.toLowerCase()) split.delete(key);
  if (split.size === 0) throw coded(400, "NO_HOLDERS", "no positive balances to pay");
  let payable = 0n;
  for (const v of split.values()) payable += v;
  if (BigInt(await deps.cash.balanceOf(cf.currency, payer)) < payable) {
    throw coded(400, "INSUFFICIENT_TREASURY_FUNDS", `payer needs ${payable} ${cf.currency} (record the repayment via /cash/credit first)`);
  }
  if (!(await deps.cashflows.claim(cf.id))) throw coded(409, "ALREADY_EXECUTED", "this cashflow was already executed");
  const releaseClaim = () => deps.cashflows.release(cf.id).catch((releaseErr) => log.error({ releaseErr, cashflowId: cf.id }, "cashflow claim release failed — row stuck 'executing', manual reconciliation required"));
  const paid: [string, bigint][] = [];
  try {
    if (cf.kind === "redemption") {
      const open = await deps.listings.listByAsset(asset.id, "open");
      if (open.length > 0) { await releaseClaim(); throw coded(409, "OPEN_LISTINGS_BLOCK_SETTLEMENT", "cancel open listings before settling — escrowed tokens cannot be redeemed"); }
    }
    for (const [addr, amount] of split) {
      await deps.cash.transfer(cf.currency, payer, addr, amount.toString());
      paid.push([addr, amount]);
    }
    if (cf.kind === "redemption") {
      const ctx = contextOf(asset);
      for (const [addr, bal] of balances) if (bal > 0n) await deps.engine.burn(actor, ctx, addr, bal.toString());
      await deps.assets.setStatus(asset.id, "matured");
    }
    const executed = await deps.cashflows.markExecuted(cf.id, new Date().toISOString());
    await deps.audit.append({
      assetId: asset.id, actorId: actor.id,
      action: cf.kind === "redemption" ? "redeem" : "distribute",
      payload: { currency: cf.currency, amount: cf.amount, paid: payable.toString(), holders: split.size, from: payer, seq: cf.seq },
      chainId: asset.chainId,
    });
    return executed;
  } catch (err) {
    if (!(err instanceof CodedError && err.code === "OPEN_LISTINGS_BLOCK_SETTLEMENT")) {
      for (const [addr, amount] of paid) {
        await deps.cash.transfer(cf.currency, addr, payer, amount.toString()).catch((refundErr) => log.error({ refundErr, addr, amount: amount.toString(), cashflowId: cf.id }, "cashflow refund compensation failed — manual reconciliation required"));
      }
      await releaseClaim();
    }
    throw err;
  }
}
```
NOTE the subtlety: the post-claim OPEN_LISTINGS throw already releases the claim before throwing, so the catch must not release twice — the `instanceof` guard above handles it. The funds/NO_HOLDERS checks moved INSIDE the core (pre-claim) so the approval path re-validates them at execution time; that is intentional and matches current route behavior (they were pre-claim in the route too).

- [ ] **Step 2: Refactor the routes to call the executors** (behavior identical):
  - Cashflow route: keep everything through the payer scope check (~1016–1067), delete the split/funds/claim/payout block (~1069–1141), replace with:
    ```ts
    try {
      const executed = await executeCashflowCore(deps, actor, asset, cf, payer, request.log);
      return { cashflow: { ...executed, status: "executed" } };
    } catch (err) {
      if (err instanceof CodedError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      throw err;
    }
    ```
    Also DELETE the now-redundant early NO_HOLDERS/funds pre-checks if they were only in the deleted block (they were), and keep the friendly early open-listings + ALREADY_EXECUTED checks where they are. Remove the now-unused local `assetBalances` helper/`dropPayerShare` if nothing else uses them (grep; the GET route preview uses `assetBalances` — repoint it to `assetBalancesOf` from executors and delete the local).
  - Action route: replace the five gated `case` bodies with a single branch:
    ```ts
    case "mint": case "transfer": case "burn": case "freeze": case "unfreeze":
      receipt = await runGatedAction(deps, actor, asset, action, b);
      break;
    ```
    (allow/disallow/setPrice/default stay as-is.)
  - Issue route: replace the `setSaleTerms` + allowlist/mint block (~299–311) with `await executeIssueActivation(deps, actor, (await deps.assets.get(id))!, { initialSupply: wantsSupply ? initialSupply : undefined, treasury, sale });` — note `executeIssueActivation` sets status "active", and the asset was created with status "active" already; that is an idempotent no-op here. Keep the surrounding try/catch untouched.

- [ ] **Step 3: Full api suite (pure-refactor gate)**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api test`
Expected: **107 passed — zero behavior change.** If any cashflow test fails, the extraction diverged; fix the extraction, not the test.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/executors.ts apps/api/src/http/routes.ts
git commit -m "refactor(api): extract issue-activation/action/cashflow execution cores into executors.ts (no behavior change)"
```

---

## Task 5: API — gating + proposal routes

**Files:**
- Modify: `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/approvals.test.ts` (new)

- [ ] **Step 1: Failing tests** — `apps/api/test/approvals.test.ts`. Fixtures: bond desk (`bond.admin`/`bond123` UCA proposer, `bond.issuer`/`bond123` Issuer approver — both issue-capable); invoice desk (`m1.admin`, `m1.issuer`) for cashflow gating; reuse the settlement fixtures from `apps/api/test/cashflows.test.ts` (read it first — `desk()`, `issueInvoice()`, `linkPayer` pattern, seeded HOLDER). Bond chain: use a chain from the use case's `contracts` keys (defaultChainId is besu — absent in tests). Tests:

```ts
// 1. gated issue → 202 pending_approval, frozen
it("gated issuance returns 202 with a pending proposal and a frozen pending_approval asset", async () => {
  // bond.admin issues with initialSupply+treasury (metadata: issuer/isin/faceValue/couponRate/maturityDate)
  // expect 202; body.proposal.status "pending"; body.asset.status "pending_approval"
  // actions/mint on the asset → 409 ASSET_NOT_ACTIVE; listings create → 400/409 (status check); buy → 409
});
// 2. approve activates
it("approval by a second capability holder mints supply, sets sale terms, activates", async () => {
  // bond.issuer approves → 200, proposal.status "executed"
  // asset.status "active"; treasury balance == initialSupply
});
// 3. SoD + duplicates
it("proposer cannot approve own proposal; same approver cannot approve twice", async () => {
  // proposer approve → 403 SELF_APPROVAL
  // threshold 2 use case (on the fly): approver approves twice → second is 409 ALREADY_APPROVED_BY_YOU
});
// 4. threshold 2 needs two distinct approvers
it("threshold 2: first approval leaves pending, second executes", async () => {
  // on-the-fly use case with workflow.approvals.issue = 2 and three issue-capable users
});
// 5. CAS: concurrent final approvals execute exactly once
it("two concurrent final approvals → exactly one executes", async () => {
  // threshold 1, two eligible approvers, Promise.all two approve calls
  // expect one 200 (executed) and one 409 PROPOSAL_NOT_PENDING; treasury minted exactly once
});
// 6. reject
it("rejection marks the proposal and the pending asset rejected", async () => {
  // reject → 200; proposal "rejected"; asset.status "rejected"; approve after reject → 409 PROPOSAL_NOT_PENDING
});
// 7. gated cashflow-execute
it("invoice settlement is proposal-gated: 202 then approve pays out", async () => {
  // reuse cashflows.test fixtures; m1.admin proposes execute (202), m1.issuer approves → holders paid, asset matured
});
// 8. failed execution preserved
it("approving an execution that fails (unfunded payer) marks the proposal failed with the error", async () => {
  // propose settle with an unfunded-but-scoped payer... NOTE: funds are checked inside the core at
  // execution: proposal executes → INSUFFICIENT_TREASURY_FUNDS → proposal.status "failed",
  // proposal.error contains the code, cashflow still schedulable (claim released)
});
// 9. eligibility + tenancy
it("a Buyer cannot approve; a cross-tenant admin gets 404", async () => {});
// 10. ungated ops unaffected
it("invoice issuance (ungated) still returns 201 and mints instantly", async () => {});
```
Write these fully (follow the exact inject/auth style of `cashflows.test.ts`). Run to verify failure.

- [ ] **Step 2: Gating helper + interception.** In `registerRoutes`:

```ts
  // Maker-checker: when the use case gates `op`, capture the operation as a
  // pending Proposal instead of executing. Returns null when ungated.
  async function proposeIfGated(
    request: FastifyRequest,
    useCase: UseCaseDefinition,
    op: string,
    assetId: string | null,
    payload: Record<string, unknown>,
  ): Promise<ProposalRecord | null> {
    const required = useCase.workflow?.approvals?.[op as keyof NonNullable<NonNullable<UseCaseDefinition["workflow"]>["approvals"]>];
    if (!required || required < 1) return null;
    const claims = request.user as TokenClaims;
    return deps.proposals.create({
      useCaseKey: useCase.key, assetId, kind: op, payload,
      proposerId: claims.id, proposerLabel: claims.email, required,
    });
  }
```
Interception points:
  - **Issue route**: inside the try, right after `deps.cashflows.createMany(...)` (~298) — i.e. after asset creation — branch:
    ```ts
    const proposal = await proposeIfGated(request, useCase, "issue", id, {
      ...(wantsSupply ? { initialSupply, treasury } : {}),
      ...(sale ? { sale } : {}),
      ...(issuanceFeeCharged ? { issuanceFee: { ...issuanceFeeCharged, payer: feePayer } } : {}),
    });
    if (proposal) {
      await deps.assets.setStatus(id, "pending_approval");
      const pendingAsset = await deps.assets.get(id);
      return reply.code(202).send({ proposal, asset: pendingAsset });
    }
    ```
    (The ungated path continues to `executeIssueActivation` as refactored in Task 4. The asset is created "active" then flipped — acceptable single-request window, or set the status string conditionally at create; prefer conditional create: compute `const gatedIssue = !!useCase.workflow?.approvals?.issue;` BEFORE the try and pass `status: gatedIssue ? "pending_approval" : "active"` in `assets.create`, then create the proposal after `createMany` without the setStatus. Do it the conditional-create way.)
  - **Action route**: after the `ASSET_NOT_ACTIVE` guard and before the switch, for the five gated actions only:
    ```ts
    if (["mint", "transfer", "burn", "freeze", "unfreeze"].includes(action)) {
      deps.rbac.authorize(actor, action as LifecycleAction); // proposer must hold the capability
      const useCase = await deps.useCases.get(asset.useCaseKey);
      const proposal = await proposeIfGated(request, useCase, action, asset.id, { action, body: b });
      if (proposal) return reply.code(202).send({ proposal });
    }
    ```
    (`rbac.authorize` throws PolicyError → existing mapping; confirm the engine's authorize call signature by grepping `rbac.authorize` usage at the setPrice case.)
  - **Cashflow route**: after the payer scope check (all validations done), before `executeCashflowCore`:
    ```ts
    const proposal = await proposeIfGated(request, useCase, "cashflow-execute", asset.id, { cfId: cf.id, from: payer });
    if (proposal) return reply.code(202).send({ proposal });
    ```
    (`useCase` needs loading in this route — `const useCase = await deps.useCases.get(asset.useCaseKey);` near the top.)

- [ ] **Step 3: Approval routes + schemas.** Schemas: `Proposal` component + `listProposals` (querystring status/useCaseKey) + `decideProposal` (params id). Routes:

```ts
  // --- maker-checker proposals ---------------------------------------------
  const CAPABILITY_FOR: Record<string, LifecycleAction> = {
    issue: "issue", mint: "mint", transfer: "transfer", burn: "burn",
    freeze: "freeze", unfreeze: "unfreeze", "cashflow-execute": "issue",
  };

  async function scopedProposal(request: FastifyRequest, reply: FastifyReply): Promise<ProposalRecord | null> {
    const { id } = request.params as { id: string };
    const p = await deps.proposals.get(id);
    if (!p || !scopedToCaller(request.user as TokenClaims, p.useCaseKey)) {
      notFound(reply, "proposal not found");
      return null;
    }
    return p;
  }

  app.get("/proposals", { schema: S.listProposals, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    const q = request.query as { status?: string; useCaseKey?: string };
    const useCaseKey = claims.role === "PlatformAdmin" ? q.useCaseKey : claims.useCaseKey ?? NO_USE_CASE;
    return deps.proposals.list(useCaseKey, q.status);
  });

  async function decide(request: FastifyRequest, reply: FastifyReply, verdict: "approve" | "reject") {
    const p = await scopedProposal(request, reply);
    if (!p) return reply;
    const claims = request.user as TokenClaims;
    if (p.status !== "pending") return reply.code(409).send({ error: "PROPOSAL_NOT_PENDING", message: `proposal is ${p.status}` });
    if (claims.id === p.proposerId) return reply.code(403).send({ error: "SELF_APPROVAL", message: "the proposer may not decide their own proposal" });
    const capability = CAPABILITY_FOR[p.kind];
    if (!capability || !deps.rbac.can(claims.role, capability)) {
      return reply.code(403).send({ error: "NOT_ELIGIBLE", message: `role '${claims.role}' may not decide '${p.kind}' proposals` });
    }

    if (verdict === "reject") {
      if (!(await deps.proposals.claimApproved(p.id))) return reply.code(409).send({ error: "PROPOSAL_NOT_PENDING", message: "already decided" });
      const rejected = await deps.proposals.setStatus(p.id, "rejected");
      if (p.kind === "issue" && p.assetId) {
        await deps.assets.setStatus(p.assetId, "rejected");
        // Refund any issuance fee charged at propose time (best-effort).
        const fee = p.payload.issuanceFee as { amount: string; currency: string; payer?: string } | undefined;
        if (fee?.payer && deps.platformFeeAccount) {
          await deps.cash.transfer(fee.currency, deps.platformFeeAccount, fee.payer, fee.amount).catch((refundErr) =>
            request.log.error({ refundErr, proposalId: p.id }, "issuance fee refund on rejection failed — manual reconciliation required"));
        }
      }
      return { proposal: rejected };
    }

    let withApproval: ProposalRecord;
    try {
      withApproval = await deps.proposals.addApproval(p.id, { userId: claims.id, email: claims.email, at: new Date().toISOString() });
    } catch (err) {
      if ((err as { code?: string }).code === "ALREADY_APPROVED") {
        return reply.code(409).send({ error: "ALREADY_APPROVED_BY_YOU", message: "you already approved this proposal" });
      }
      throw err;
    }
    if (withApproval.approvals.length < withApproval.required) return { proposal: withApproval };

    // Threshold reached — CAS to approved, then execute as the PROPOSER.
    if (!(await deps.proposals.claimApproved(p.id))) {
      return reply.code(409).send({ error: "PROPOSAL_NOT_PENDING", message: "another approval already finalized this proposal" });
    }
    const proposerUser = await deps.users.findById(p.proposerId);
    if (!proposerUser || !proposerUser.active) {
      const failed = await deps.proposals.setStatus(p.id, "failed", "PROPOSER_INACTIVE");
      return { proposal: failed };
    }
    const proposerActor: Actor = { id: proposerUser.id, role: proposerUser.role };
    try {
      const asset = p.assetId ? await deps.assets.get(p.assetId) : null;
      if (p.kind === "issue") {
        if (!asset) throw coded(404, "NOT_FOUND", "pending asset missing");
        await executeIssueActivation(deps, proposerActor, asset, p.payload as Parameters<typeof executeIssueActivation>[3]);
      } else if (p.kind === "cashflow-execute") {
        if (!asset) throw coded(404, "NOT_FOUND", "asset missing");
        const cf = await deps.cashflows.get(String(p.payload.cfId));
        if (!cf || cf.assetId !== asset.id) throw coded(404, "NOT_FOUND", "cashflow missing");
        await executeCashflowCore(deps, proposerActor, asset, cf, String(p.payload.from), request.log);
      } else {
        if (!asset) throw coded(404, "NOT_FOUND", "asset missing");
        await runGatedAction(deps, proposerActor, asset, p.kind, (p.payload.body ?? {}) as Record<string, string>);
      }
      return { proposal: await deps.proposals.setStatus(p.id, "executed") };
    } catch (err) {
      const code = err instanceof CodedError ? err.code : err instanceof PolicyError ? err.code : "EXECUTION_FAILED";
      const failed = await deps.proposals.setStatus(p.id, "failed", `${code}: ${(err as Error).message}`);
      return reply.code(200).send({ proposal: failed });
    }
  }

  app.post("/proposals/:id/approve", { schema: S.decideProposal, ...auth }, (req, rep) => decide(req, rep, "approve"));
  app.post("/proposals/:id/reject", { schema: S.decideProposal, ...auth }, (req, rep) => decide(req, rep, "reject"));
```
Notes: `claims.email` exists on `TokenClaims` (grep to confirm; it is signed into the JWT at login). The reject path reuses `claimApproved` purely as the pending→(terminal) CAS gate — acceptable since `setStatus` immediately overwrites to `rejected`; if that reads too cute, add a dedicated `claimDecided(id)` with the same updateMany semantics. Failed executions return 200 with the failed proposal (the caller sees `status: "failed"` + `error`).

- [ ] **Step 4: Run the new tests + full suite**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/approvals.test.ts` → PASS (10).
Run: `pnpm --filter @tokenlayer/api test` → ALL PASS. NOTE: gating `cashflow-execute: 1` on the invoice config makes the existing `cashflows.test.ts` execute-path tests return 202 instead of executing — UPDATE those tests to drive execution through propose→approve (use `m1.issuer` as the approver), or point them at an on-the-fly ungated use case; prefer updating them to the propose→approve flow so the shipped config stays exercised. The cycle-① guard tests (NOT_DUE, OUT_OF_SCOPE, burn pre-gate, COUPONS_OUTSTANDING) still hit at REQUEST time and stay unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/approvals.test.ts apps/api/test/cashflows.test.ts
git commit -m "feat(api): maker-checker gating + proposal approve/reject/list with SoD and CAS execution"
```

---

## Task 6: Web — Approvals inbox + 202 handling

**Files:**
- Modify: `apps/web/src/types.ts`, `apps/web/src/api.ts`
- Create: `apps/web/src/components/ApprovalsPanel.tsx`
- Modify: `apps/web/src/components/AssetManagement.tsx` (sub-tab), `apps/web/src/components/AssetDetail.tsx` (pending/rejected banner), `apps/web/src/components/IssuePanel.tsx` + `CashflowPanel.tsx` (202 handling)

- [ ] **Step 1: Types + client**

```ts
// types.ts
export interface Proposal {
  id: string; useCaseKey: string; assetId: string | null; kind: string;
  payload: Record<string, unknown>; proposerId: string; proposerLabel: string;
  required: number; approvals: { userId: string; email: string; at: string }[];
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  error: string | null; createdAt: string; decidedAt: string | null;
}
// api.ts
  proposals: (token: string, status?: string) =>
    request<Proposal[]>(`/proposals${status ? `?status=${status}` : ""}`, token),
  approveProposal: (token: string, id: string) =>
    request<{ proposal: Proposal }>(`/proposals/${id}/approve`, token, { method: "POST", body: JSON.stringify({}) }),
  rejectProposal: (token: string, id: string) =>
    request<{ proposal: Proposal }>(`/proposals/${id}/reject`, token, { method: "POST", body: JSON.stringify({}) }),
```
(202 responses: the shared `request<T>` treats any 2xx as success — confirm `res.ok` covers 202; it does.)

- [ ] **Step 2: ApprovalsPanel** — follow the codebase's card/table idioms: pending list (kind pill, asset name via a passed lookup or assetId short, payload summary — for issue show `initialSupply → treasury`, for cashflow-execute show `cfId/from`, for actions show the body —, proposer, `approvals.length/required`, Approve/Reject buttons disabled for the proposer with a tooltip); a "Recent decisions" list (non-pending, newest first, status pill + error). Refetch after every decision; expose `onChanged`. Props: `{ useCase: UseCase; currentUserId: string; onChanged: () => void }`. Use `useAuth()` for token + user (the session user id — grep `SessionUser`).

- [ ] **Step 3: Mount as sub-tab.** In `AssetManagement.tsx`: add `{ id: "approvals", label: "Approvals" }` to `subs` when `activeUseCase?.workflow?.approvals` has keys; render `<ApprovalsPanel useCase={activeUseCase} … onChanged={() => setRefreshKey(k => k + 1)} />`. A pending-count badge: fetch `api.proposals(token, "pending")` in the panel and lift the count via a callback, or keep the badge inside the tab label minimal (skip the badge if it forces awkward state lifting — label suffix `Approvals` is acceptable; note the deviation).

- [ ] **Step 4: 202 + status surfaces.**
  - `IssuePanel.submit`: the issue response may now be `{ proposal, asset }` (202). Detect `"proposal" in res` and show an info banner "Submitted for approval — pending in the Approvals tab" instead of navigating to the asset as a success. (Type the client: `api.issue` return becomes a union or `{ asset: Asset; txHash?: string; proposal?: Proposal }` — simplest: widen the generic to include optional `proposal`.)
  - `CashflowPanel`: `executeCashflow` may return `{ proposal }` (202) — show "Submitted for approval" info line and refetch.
  - `AssetDetail`: when `asset.status === "pending_approval"` render an amber banner "Pending approval — supply mints when approved"; `rejected` → red banner.

- [ ] **Step 5: Verify + commit**

Run: `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build` → clean.
```bash
git add apps/web/src
git commit -m "feat(web): Approvals inbox + 202 submitted-for-approval handling + pending/rejected banners"
```

---

## Task 7: Verify — suite, live E2E, adversarial review, merge

- [ ] **Step 1: Full workspace suite** — core/adapters/api/contracts tests + web tsc/build, all green.
- [ ] **Step 2: Rebuild + fresh-volume deploy** (`docker compose build api web && docker compose down -v && docker compose up -d`); confirm invoice + bond use cases report `workflow`.
- [ ] **Step 3: Live E2E** (scratchpad script, remember: no Content-Type on bodyless requests; bond chain from `contracts` keys): ① bond.admin proposes issuance (202, asset pending_approval, buy blocked) → bond.admin self-approve → 403 → bond.issuer approves → active + supply minted; ② bond.issuer proposes a second bond → bond.admin REJECTS → asset rejected; ③ invoice flow: tokenize → list → buy → cancel listing → fund payer → m1.admin proposes settlement (202) → m1.issuer approves → holders paid, matured, yield delta correct; ④ eligibility probes (m1.buyer approve → 403; carbon.admin on m1 proposal → 404). Print ✓/✗; all ✓.
- [ ] **Step 4: Adversarial review** — dispatch a reviewer on `git diff main...feat/workflow-approvals` focused on: SoD bypass vectors (proposer approving via role change/second account; reject-then-repropose loops), CAS races (concurrent approvals, approve-vs-reject race), capability escalation (proposer identity execution — can a proposal execute something the CURRENT proposer couldn't?), fee-refund correctness on rejection, payload tampering surface (payload is server-built — confirm no client-supplied fields flow unvalidated into executors), pending-asset freeze completeness (every mutation path), and the executor refactor's behavior-parity. Fix real findings, re-run suites.
- [ ] **Step 5: Merge + redeploy + memory** — `git checkout main && git merge --no-ff feat/workflow-approvals -m "Merge: lifecycle states + maker-checker approvals (Template v2 cycle 2)"`; rebuild + fresh deploy from main; update `product-feature-roadmap.md` (cycle ② done, gotchas).

---

## Self-review notes

- **Spec coverage:** config+validation (T1/T2), Proposal model+CAS (T3), executor registry (T4), gating + lifecycle states + fee-refund-on-reject + approve/reject/list + SoD (T5), web inbox + 202 + banners (T6), verify/review/merge (T7). The 202 `{proposal, asset}` issuance contract, proposer-identity execution with inactive-proposer failure, and `capabilityFor` mapping are all in T5 code.
- **Type consistency:** `ProposalRecord`/`ProposalRepository` names match across T3/T5; `executeIssueActivation`/`runGatedAction`/`executeCashflowCore`/`assetBalancesOf`/`CodedError`/`coded` match across T4/T5; web `Proposal` mirrors the record (JSON-safe).
- **Known judgment calls encoded:** conditional `pending_approval` at create (no active→pending flicker); funds/NO_HOLDERS re-validated inside the core at execution time; reject uses the same CAS gate; failed executions return 200 with the failed proposal.
