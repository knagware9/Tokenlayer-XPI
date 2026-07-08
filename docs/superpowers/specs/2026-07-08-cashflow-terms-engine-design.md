# Financial Terms & Cashflow Engine (Template v2, cycle ①)

**Date:** 2026-07-08
**Status:** Approved (design)
**Branch:** `feat/cashflow-terms-engine`

## Problem

The use-case template ("a new asset class is configuration, not code") stops at
tokens + compliance + marketplace. Real financial products have **time and money
events**: coupons, distributions, maturity, redemption. Today the invoice
flagship ends at "financier bought tokens at a discount" — the yield-realizing
moment (buyer repays at maturity → financiers receive face value) does not
exist, and the corporate-bond use case has no coupon story at all.

This cycle adds a config-declared **terms** block to the template and a
**cashflow engine** that materializes, tracks, and settles the resulting
payments. It is cycle ① of the Template v2 sequence:
① terms & cashflows → ② lifecycle states + maker-checker approvals →
③ valuation sources/oracles.

## Decisions (from brainstorming)

1. **Execution model: due-ledger + operator executes.** Scheduled payments are
   materialized as DUE cashflow records; a desk operator explicitly executes
   each one. No silent money movement; stable cashflow IDs for cycle-②
   approvals to attach to.
2. **Maturity: repayment-triggered.** The operator records the inbound
   repayment (existing `POST /cash/credit` to the treasury), then executes the
   redemption cashflow — matching reality (buyers pay, sometimes late).
   Past-due unexecuted rows read as OVERDUE.
3. **Architecture: materialize-at-issue + derived status.** The full schedule
   is computed and stored when the asset is issued; DUE/OVERDUE is derived from
   the date at read time. No background scheduler process.

## Config — `terms` on `UseCaseDefinition`

Same pattern as `valuation`/`derivedFields`: the use case declares WHICH
metadata fields carry the values; each asset's metadata supplies them.

```jsonc
"terms": {
  "principalField": "amountInr",   // metadata field with face/principal (number)
  "maturityField": "dueDate",      // metadata field with maturity date (YYYY-MM-DD)
  "rateField": "couponRatePct",    // optional — metadata field with % p.a.
  "frequency": "atMaturity",       // "atMaturity" | "monthly" | "quarterly" | "semiannual" | "annual"
  "currency": "CBDC-INR"           // cash-ledger currency for all payments
}
```

- `principalField` and `maturityField` are required and must name declared
  metadata properties. `rateField` must be declared when present and is
  REQUIRED when `frequency !== "atMaturity"` (periodic coupons need a rate).
  `frequency` defaults to `"atMaturity"`. `currency` is a non-empty string.
- Validation in `packages/core/src/validation.ts` (`validateTerms`, mirroring
  `validateValuation`).
- **Persistence rule (hard-learned):** the new optional config field gets its
  Prisma column (`terms String @default("{}")`) + `rowToUseCase`/`useCaseToData`
  round-trip + `UseCaseRow` entry IN THE SAME COMMIT as the type. The deployed
  API reads use cases from Prisma; in-memory tests will not catch a missing
  column.
- Use-case configs updated this cycle:
  - `invoice-tokenization.json`: `terms { amountInr, dueDate, atMaturity, CBDC-INR }`
    → one redemption cashflow (face value at dueDate). The discount is realized
    through the purchase price, so `atMaturity` produces **no coupons**.
  - `corporate-bond.json`: gains a `couponRatePct` metadata property — plus
    whatever principal/maturity metadata properties its schema is missing (read
    the existing config first; add e.g. `faceValueInr` / `maturityDate` if
    absent) — and `terms { …, rateField: couponRatePct, frequency: quarterly }`
    — proving the template generalizes beyond invoices.
- Web `UseCase` type gains `terms`.

## Core — pure schedule + split math

New module `packages/core/src/cashflows.ts` (exported from the core index):

- `computeCashflowSchedule(terms, metadata, issuedAt) → ScheduledCashflow[]`
  where `ScheduledCashflow = { seq, kind: "coupon" | "redemption", dueDate,
  amount }` (amount = integer decimal string).
  - `atMaturity`: a single `redemption` row at the maturity date, amount =
    principal.
  - Periodic: coupon dates step from `issuedAt` by 1/3/6/12 months while
    strictly before maturity; a final `redemption` row at maturity. Coupon
    amount = principal × rate × days-in-period / 365, computed BigInt-safe with
    the platform's basis-point pattern:
    `bp = clamp(round(ratePct × days / 365 × 100), 0..10000)`;
    `amount = principal × bp / 10000` (floor).
  - Throws a PolicyError when the metadata principal is not a positive number
    or the maturity date does not parse — surfaced as a 400 at issue time.
- `splitProRata(total, balances) → Map<address, amount>` — BigInt floor per
  holder (`total × balance / supply`); the dust remainder stays with the payer
  (treasury). Pure, unit-tested including dust cases.

`LifecycleAction` gains `"distribute"` and `"redeem"` (audit vocabulary only —
no engine dispatch changes). `foldAsset` is untouched: redemption burns emit
ordinary per-holder `burn` events, so supply/holder analytics stay correct and
matured invoices drop out of Tokenized value automatically. Distributions and
redemptions do NOT count toward Traded volume (they are servicing, not trading);
they appear in the recent-activity feed via new `summarize` cases.

## API

### `Cashflow` model + repository

Prisma model: `{ id (cuid), assetId, seq, kind, dueDate (String YYYY-MM-DD),
amount (String), currency, status ("scheduled" | "executed"), executedAt?,
createdAt }` with `@@unique([assetId, seq])`. `CashflowRepository`
(`createMany`, `listByAsset`, `get`, `markExecuted`) implemented in BOTH
`prisma.ts` and `memory.ts`, wired into `AppDeps` and **every** construction
site (server.ts, test helpers, the five demo/e2e scripts) — parity between the
repos is part of the definition of done.

Derived read-time status (never stored): `executed` → `"executed"`; else
`dueDate < today` → `"overdue"`; `dueDate === today` → `"due"`; else
`"scheduled"`.

### Materialization

In `POST /assets`, after the asset row is created (same try block, so the fee
compensation applies): when the use case declares `terms`, compute the schedule
from the asset's metadata and `createMany` the cashflow rows. A schedule
computation error fails issuance with 400 `INVALID_TERMS`.

### Routes

- `GET /assets/:id/cashflows` (read-scoped) → rows with derived status, plus a
  per-holder pro-rata `preview` for the next payable row (computed from current
  balances via the existing holders fold).
- `POST /assets/:id/cashflows/:cfId/execute` (issue-capable, act-scoped):
  1. Row exists for this asset, not `executed` → else 409 `ALREADY_EXECUTED`.
  2. **Payability**: coupons require `dueDate <= today` (400 `NOT_DUE`);
     redemption may execute at any time (early repayment is legitimate).
  3. **Redemption only**: no open listings on the asset → else 409
     `OPEN_LISTINGS_BLOCK_SETTLEMENT` (escrowed tokens would be paid to the
     escrow account; the operator cancels listings first).
  4. Compute pro-rata split over current positive balances. The treasury's own
     share is skipped (it stays in the treasury implicitly); dust stays in the
     treasury.
  5. Treasury cash balance (terms.currency) must cover the payable total →
     else 400 `INSUFFICIENT_TREASURY_FUNDS` (for a redemption this is the
     "buyer has not repaid yet" signal — record the repayment via
     `POST /cash/credit` first).
  6. Pay each holder sequentially from the treasury; on a mid-stream failure,
     best-effort refund the completed transfers and rethrow (compensation
     mirrors the buy path).
  7. **Redemption additionally**: force-burn every positive balance (operator
     burn via the engine → per-holder audit `burn` events) and set asset
     status `"matured"`.
  8. `markExecuted`; append a `distribute` (coupon) or `redeem` (redemption)
     audit event with `{ currency, amount, holders }`.

Recording the buyer's repayment is NOT a new primitive: it is the existing
`POST /cash/credit` into the treasury account, composed by the web helper.

## Web

`AssetDetail` gains a **Cashflows & Settlement panel** (own component,
`CashflowPanel.tsx`), shown when the asset's use case declares `terms`:

- Schedule table: seq, kind, due date, amount, status pill
  (scheduled/due/overdue/executed).
- Per-holder payout preview for the next payable row.
- **Execute** button on payable rows (role-gated on `issue`).
- On the redemption row: a **"Record repayment & settle"** helper — inputs the
  repayment amount (defaults to face), calls `api.creditCash` to the treasury,
  then executes the redemption. Errors surface in the shared banner style
  (`CODE: message`).
- `api.ts` gains `cashflows(token, assetId)` and
  `executeCashflow(token, assetId, cfId)`; `types.ts` gains `Cashflow`.

## Flagship semantics this completes

Invoice: financier buys 4,000 of 10,000 tokens @ ₹92 (₹3,68,000 disbursed). At
`dueDate` the redemption row reads DUE/OVERDUE. Desk records the buyer's
₹10,00,000 repayment → executes settlement → the financier receives ₹4,00,000
(₹100/token): **₹32,000 realized yield**. Tokens burn, asset matures, Tokenized
value drops by the face amount, the feed shows the redemption. The identical
engine pays quarterly bond coupons from the `corporate-bond` config with zero
invoice-specific code.

## Error handling summary

`INVALID_TERMS` (bad metadata at issue), `NOT_DUE`, `ALREADY_EXECUTED`,
`OPEN_LISTINGS_BLOCK_SETTLEMENT`, `INSUFFICIENT_TREASURY_FUNDS`, plus existing
auth/scope errors. Partial-payment failure → compensating refunds + rethrow
(generic 500, funds restored).

## Testing

- Core: schedule math (atMaturity single row; quarterly count/dates/amounts;
  bp clamp; invalid principal/date throws), `splitProRata` (exact split, dust,
  single holder, zero-balance exclusion).
- API: cashflows materialized at issue (invoice: 1 redemption; bond: n coupons
  + redemption); GET derived statuses; coupon execute happy path (cash moved
  pro-rata, audit `distribute`); `NOT_DUE`; `ALREADY_EXECUTED`;
  `INSUFFICIENT_TREASURY_FUNDS`; redemption blocks on open listing; redemption
  happy path (holders paid, tokens burned, asset `matured`, audit `redeem`);
  tenancy (foreign use case → 404).
- Analytics: matured asset contributes 0 to Tokenized value; `distribute`/
  `redeem` do not inflate Traded.
- Web: tsc + build.
- Live E2E: extend the invoice script through repayment → settlement →
  financier cash delta = ₹4,00,000 (yield ₹32,000 over the ₹3,68,000 paid) →
  dashboard reflects maturity.

## Out of scope (later cycles)

- Automatic scheduler / auto-execution (cycle ② may add approval-gated
  automation).
- Day-count conventions beyond actual/365; multi-currency terms.
- Maker-checker approvals on execution (cycle ② attaches to cashflow IDs).
- Partial repayments / default workflows (OVERDUE display only).
- Withholding tax / fees on distributions.

## Phasing

1. **CORE + config**: `cashflows.ts` (schedule + split) + `terms` type/
   validation + Prisma column round-trip + invoice/bond config updates.
2. **API**: Cashflow model/repo (both impls) + materialize-at-issue + GET/
   execute routes + audit actions + tests.
3. **WEB**: CashflowPanel + api/types.
4. **Verify**: full suite, fresh deploy, live E2E through settlement, review,
   merge.
