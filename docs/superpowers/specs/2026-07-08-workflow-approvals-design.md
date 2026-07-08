# Lifecycle States + Maker-Checker Approvals (Template v2, cycle ②)

**Date:** 2026-07-08
**Status:** Approved (design)
**Branch:** `feat/workflow-approvals`

## Problem

Every money-adjacent operation on the platform executes on a single operator's
say-so: issuance goes live instantly, settlements pay out on one click, freezes
and forced burns have no second pair of eyes. Enterprise desks require
segregation of duties (maker-checker) and an auditable draft → approval → live
asset lifecycle. This is cycle ② of Template v2 (① terms/cashflows — DONE;
③ valuation oracles — next), and it deliberately builds on cycle ①'s stable
cashflow IDs.

## Decisions (from brainstorming)

1. **Gated ops are config-declared** over a supported set: `issue`, `mint`,
   `transfer`, `burn`, `freeze`, `unfreeze`, `cashflow-execute`. Unlisted ops
   stay instant.
2. **Approvers = capability holders, minus the proposer.** Any user in the use
   case whose role holds the operation's capability may approve; the proposer
   may never approve their own proposal (SoD). Threshold N from config.
3. **Rejected issuances persist** as status `rejected` — permanent audit trail,
   excluded from marketplace/value.
4. **Architecture: proposal queue + executor registry.** One generic
   `Proposal` record + one approval mechanism; the execution core of each gated
   op is extracted into a callable function used by both the direct route
   (ungated case) and the approval service (gated case, executed as the
   PROPOSER's actor identity).
5. **No admin bypass.** When an op is gated, everyone — including
   PlatformAdmin — goes through the queue.

## Config — `workflow` on `UseCaseDefinition`

```jsonc
"workflow": {
  "approvals": {
    "issue": 1,
    "cashflow-execute": 1,
    "burn": 2
  }
}
```

- `workflow.approvals`: map of gated op → required approval count (integer ≥ 1).
- Validation (`validateWorkflow` in `packages/core/src/validation.ts`): keys
  must be in the supported set; values integers ≥ 1; empty object allowed.
- Core type on `UseCaseDefinition` (after `terms`):
  ```ts
  workflow?: { approvals?: Partial<Record<GatedOp, number>> };
  // GatedOp = "issue" | "mint" | "transfer" | "burn" | "freeze" | "unfreeze" | "cashflow-execute"
  ```
- **Same-commit Prisma round-trip rule**: `workflow String @default("{}")`
  column on the UseCase model + `UseCaseRow.workflow` + `rowToUseCase`/
  `useCaseToData` handling + web `UseCase` type — all in the commit that adds
  the core type.

### Shipped config changes

- `invoice-tokenization.json`: `workflow: { approvals: { "cashflow-execute": 1 } }`
  — settlement/coupon payouts need a second pair of eyes; issuance/import stays
  instant (high-traffic flow undisturbed).
- `corporate-bond.json`: `workflow: { approvals: { "issue": 1, "cashflow-execute": 1 } }`
  — demonstrates the full draft → approval → live lifecycle plus gated payouts.

## Proposal model + repository

Prisma model (and matching `MemoryProposalRepository`):

```prisma
model Proposal {
  id            String    @id @default(cuid())
  useCaseKey    String
  assetId       String?
  kind          String // gated op
  payload       String // JSON — everything needed to execute
  proposerId    String
  proposerLabel String // email, for display
  required      Int
  approvals     String    @default("[]") // JSON: [{ userId, email, at }]
  status        String    @default("pending") // pending|approved|rejected|executed|failed
  error         String?
  createdAt     DateTime  @default(now())
  decidedAt     DateTime?

  @@index([useCaseKey, status])
}
```

`ProposalRepository`: `create`, `get`, `list(useCaseKey?, status?)`,
`addApproval(id, approval)` (append; reject duplicates by userId),
`claimApproved(id)` — **CAS** `pending → approved` (updateMany-where-status;
the cycle-① H1 lesson: the transition that triggers execution must be atomic so
two concurrent Nth approvals cannot both execute), `setStatus(id, status,
error?, decidedAt?)`.

## Flow

### Gating interception

Each gated route keeps its full validation/scope/compliance **pre-checks**
exactly where they are (bad requests are rejected immediately and never
queued — including cycle ①'s burn-capability pre-gate, so an Issuer cannot
even propose a settlement it could not execute). Then, where side effects
would begin:

```
const required = useCase.workflow?.approvals?.[op];
if (required && required >= 1) → create Proposal, return 202 { proposal }
```

### Executor registry

The side-effect core of each gated op is extracted from its route into a
function in `apps/api/src/executors.ts` (new file), each taking
`(deps, actor, payloadRecord)`:

- `executeIssueActivation` — mint deferred initial supply + set sale terms +
  flip asset status `pending_approval → active`.
- `executeAction` — the engine dispatch the `/actions/:action` route performs
  (mint/transfer/burn/freeze/unfreeze on a given asset).
- `executeCashflow` — cycle ①'s execute-route core (claim CAS, payout,
  redemption burn+mature, audit) refactored to be callable.

Routes call these directly in the ungated case; the approval service calls the
same function with the **proposer's** actor identity in the gated case (RBAC
and engine compliance re-apply to the proposer at execution time).

### Issuance lifecycle states

- Gated issue: run derive/uniqueness/INVALID_TERMS checks and the fee logic as
  today, run `engine.issue` (on-ledger registration — supply-free), create the
  asset row with status **`pending_approval`**, materialize cashflows, store
  `{ initialSupply, treasury, sale, issuanceFee? }` in the proposal payload.
  **Do not mint or set sale terms.** The 202 response is
  `{ proposal, asset }` so the desk immediately sees the pending asset.
  Existing guards already freeze pending assets: cycle ①'s `ASSET_NOT_ACTIVE`
  on actions/buy, and the listings-create `status !== "active"` check.
- Approve (threshold reached) → `executeIssueActivation` → status `active`.
- Reject → asset status **`rejected`**, and any issuance fee charged at
  propose time is refunded (best-effort, logged on failure — mirrors the
  existing fee-compensation pattern). Excluded from analytics value by the
  existing supply-0 behavior (nothing was minted) and unbuyable/unlistable
  alongside other non-active statuses.

### Approval routes

- `POST /proposals/:id/approve` — approver must be: authenticated in the
  proposal's use case (PlatformAdmin allowed), holding the op's capability
  (`rbac.can(role, capabilityFor(kind))`; `cashflow-execute` maps to `issue` —
  matching the route gate — and every other op maps to itself; the burn
  requirement for redemptions was already enforced against the proposer at
  propose time), and **not the proposer**
  (403 `SELF_APPROVAL`). Duplicate approval by the same user → 409
  `ALREADY_APPROVED_BY_YOU`. Below threshold → 200 with updated proposal.
  At threshold → `claimApproved` CAS (lost race → 409 `PROPOSAL_NOT_PENDING`),
  then execute via the registry: success → `executed`; failure → `failed` +
  `error` (approvals preserved; nothing auto-retries; the response carries the
  underlying error code/message alongside the proposal).
- `POST /proposals/:id/reject` — same eligibility rules; one rejection flips
  `pending → rejected` (CAS) and, for issuance, sets the asset `rejected`.
- `GET /proposals?status=` — scoped to the caller's use case (PlatformAdmin:
  all, optional `useCaseKey` filter).

## Web

- **Approvals sub-tab** in `AssetManagement` (shown when the active use case
  declares `workflow`): pending inbox — kind, asset name/link, payload summary
  (amount/recipient/cashflow), proposer, progress `1/2`, Approve / Reject
  buttons (disabled with reason for the proposer), and a recent-decisions list.
  Tab label carries a pending-count badge.
- **AssetDetail**: a `pending approval` banner for `pending_approval` assets;
  `rejected` shown distinctly.
- **202 handling**: `IssuePanel`, `CashflowPanel`, and the action buttons treat
  a 202 as "Submitted for approval" (info banner, not success), and refresh.
- `api.ts`: `proposals(token, status?)`, `approveProposal`, `rejectProposal`;
  `types.ts`: `Proposal`.

## Error handling

- 202 is the propose contract (not an error).
- `SELF_APPROVAL` 403, `NOT_ELIGIBLE` 403 (role lacks capability / wrong use
  case → 404 for cross-tenant invisibility), `ALREADY_APPROVED_BY_YOU` 409,
  `PROPOSAL_NOT_PENDING` 409 (decided/raced), execution failure → proposal
  `failed` with underlying code in `error` (e.g. `INSUFFICIENT_TREASURY_FUNDS`).
- Proposals do not expire (YAGNI for the demo; a decidedAt index exists for
  future sweep jobs).

## Testing

- Core: `validateWorkflow` (unknown op rejected; non-integer/zero rejected;
  empty ok).
- API:
  - gated issue → 202, asset `pending_approval`, buy/actions/listings all
    blocked; approve → supply minted, sale terms set, `active`; reject →
    `rejected` and stays frozen;
  - SoD: proposer self-approve → 403; same approver twice → 409;
  - threshold 2: first approval → still pending; second (distinct user) →
    executed;
  - concurrency: two simultaneous Nth approvals → exactly one execution
    (CAS claim; assert single mint / single payout);
  - gated `cashflow-execute`: propose (202) → approve → holders paid (reuse
    cycle ①'s settlement fixtures); failed execution (unfunded payer) →
    proposal `failed`, error preserved, approvals intact, cashflow still
    schedulable;
  - eligibility: Buyer cannot approve; cross-tenant user gets 404;
  - ungated ops on the same use case still execute instantly.
- Web: tsc + build.
- Live E2E: corporate-bond draft → approve → live (mint deferred until
  approval); invoice settlement now propose → approve → paid (extend the
  cycle-① settlement script); dashboard/audit reflect both.

## Out of scope (later cycles)

- Config-designated approver roles per op (layerable on top).
- Proposal expiry/escalation, notifications, batch approvals.
- Gating marketplace listing/take or document upload.
- Approval-gated automation (auto-execute due coupons post-approval).

## Phasing

1. **CORE + config**: `workflow` type + `validateWorkflow` + Prisma round-trip
   + invoice/bond config updates + web type.
2. **API**: Proposal model/repo (both impls, CAS claim) + executor extraction
   (`executors.ts`) + gating in issue/actions/cashflow-execute routes +
   approve/reject/list routes + tests.
3. **WEB**: Approvals inbox + badges + 202 handling + pending/rejected
   banners.
4. **Verify**: full suite, fresh deploy, live E2E (bond lifecycle + gated
   settlement), adversarial review (SoD bypass, CAS races, capability
   escalation, proposer-identity execution), merge.
