# Analytics / Overview Dashboard

**Date:** 2026-07-06
**Status:** Approved
**Feature cycle 1 of 3** (then richer low-code config, then secondary-market trading.)

## Problem / goal

The dashboard today is transactional — lists and forms, two screens per use case.
There is no *insight* layer: an admin can't see total value tokenized, supply /
holders per use case, activity over time, or a per-ledger breakdown at a glance.
This adds a visual overview that reads existing data (no new data plumbing).

## Approved decisions

- **Audience:** a platform-wide overview for PlatformAdmin (all use cases, all
  ledgers) AND a scoped per-use-case overview for UseCaseAdmin/Issuer (same
  components, filtered by scope). No Buyer portfolio this cycle.
- **Value metric:** priced value grouped **by currency** (no FX conversion) plus
  token supply and counts. Unpriced assets count toward supply, excluded from value.
- **Charts:** hand-rolled SVG components (no new dependency; keep the lean bundle).

## Data sources (all existing)

- `assets` — supply (on-chain `totalSupply`, already computed in list), `unitPrice`,
  `currency`, `chainId`, `useCaseKey`, `treasuryAccount`, `status`.
- `audit` log — event stream: `issue`, `mint`, `transfer`, `burn`, `buy`, with
  `createdAt`, `chainId`, `assetId`, and payload (`to`/`from`/`amount`, and for
  `buy`: `unitPrice`/`currency`/`cost`).
- `cash` balances + `currencies` — CBDC context.
- `chains` registry — per-chain `mode` (real/simulated) for the ledger breakdown.

Holders and activity are **derived from the audit stream** (fast, DB-only):
net balance per (asset, account) from mint/transfer/buy/burn → count accounts with
a positive balance. This is instant and accurate to recorded events; live on-chain
`balanceOf` reconciliation is a later option, not this cycle.

## Design

### 1. API — one scope-aware aggregation endpoint

- `GET /api/v1/analytics` (authenticated). Query: optional `useCaseKey`, optional
  `days` (activity window, default 30, clamped 1–90).
- **Scope (RBAC/tenancy, reusing existing rules):**
  - PlatformAdmin: platform-wide by default; `useCaseKey` filters to one use case.
  - Scoped roles (UseCaseAdmin/Issuer/Buyer/Auditor): always clamped to their own
    `useCaseKey`; a `useCaseKey` for another use case → the caller's own (never
    another tenant's data). Mirrors the existing `/assets` scoping.
- **Response shape (`AnalyticsSummary`):**
  ```jsonc
  {
    "scope": "platform" | "use-case",
    "useCaseKey": "carbon-credit" | null,
    "totals": {
      "assets": 4, "useCases": 4, "holders": 37, "supply": "106500",
      "valueByCurrency": { "INR": "6350000", "USD": "120000" },   // supply×unitPrice for priced assets
      "tradedByCurrency": { "INR": "480000" },                     // sum of buy costs in window
      "trades": 61
    },
    "byLedger":  [{ "chainId": "besu", "mode": "real", "assets": 1, "supply": "100000", "holders": 18 }],
    "byUseCase": [{ "useCaseKey": "deposit-tokenization", "name": "Deposit Tokenization", "symbol": "DEP",
                    "chainId": "besu", "supply": "100000", "holders": 18, "valueByCurrency": { "INR": "5000000" } }],
    "activity":  [{ "date": "2026-07-01", "count": 12, "tradedByCurrency": { "INR": "20000" } }],  // one per day in window
    "recent":    [{ "at": "...", "action": "buy", "assetId": "...", "assetName": "...", "chainId": "mst", "summary": "500 → 0x70.. @ 5 USD" }]
  }
  ```
- **Implementation:** a pure `computeAnalytics(assets, auditEntries, chains, window)`
  function in `apps/api/src/analytics.ts` (unit-testable, no I/O), called by the
  route which loads the scoped assets + audit entries from the repos. All bigint
  math on supply/value as strings (no float on token amounts).
- `byUseCase` is present only in platform scope (a single-use-case view has one row —
  folded into `totals`).

### 2. API — supporting bits

- HTTP schema `Analytics` (+ nested) in `apps/api/src/http/schemas.ts`; route in
  `routes.ts` under the existing auth plugin.
- Repos: reuse `assets.list(filter, page)` (large page) and
  `audit.listByAsset`/a new `audit.listAll(filter, page)` if needed for a
  scope-wide audit read. Prefer adding `audit.list(filter, page)` mirroring the
  asset repo if a cross-asset audit query doesn't exist yet (check first; keep it
  paginated with a generous cap for the window).

### 3. Web — Overview screen + SVG chart primitives

- `apps/web/src/components/charts/` — `Donut.tsx`, `AreaChart.tsx` (activity line
  + fill), `BarChart.tsx`. Small, presentational, typed props, no dependency.
- `apps/web/src/components/Dashboard.tsx` — composes: headline stat cards
  (value-by-currency, supply, holders, traded), supply-by-ledger donut, 30-day
  activity area chart, by-use-case table (platform), recent-activity feed. Renders
  from one `api.analytics(token, { useCaseKey?, days? })` call.
- `apps/web/src/api.ts` — `analytics()` client + `AnalyticsSummary` type in `types.ts`.
- **Navigation:**
  - PlatformAdmin at the platform root (`PlatformHome`): add the platform Overview
    (either as the landing section or a tab next to the use-case gallery).
  - Scoped users + PlatformAdmin inside a use case: add an **Overview** tab in
    `App.tsx` `sections`, before "Asset Management".
- Money formatting: group by currency with the currency's symbol/label from the
  existing `currencies` list; token amounts shown as integer counts.

### 4. Error / empty handling

- No assets in scope → a friendly empty Overview ("No assets yet — issue one to see
  analytics"), not a broken chart.
- Unpriced assets: counted in supply/holders, excluded from `valueByCurrency`.
- A metric that can't be computed degrades to 0/absent; the page never crashes.

### 5. Testing

- **API (`apps/api/test/`):** unit tests for `computeAnalytics` (seed a fixture set
  of assets + audit entries → assert supply totals, per-currency value & traded,
  per-ledger and per-use-case rows, holder counts from net balances, daily activity
  buckets incl. empty days, and the recent feed). Route tests: scope enforcement
  (a scoped user's `/analytics` never includes another use case; `useCaseKey`
  override is ignored for scoped roles), and PlatformAdmin platform vs filtered.
- **Web:** typecheck + build; chart primitives render with sample props (snapshot-free,
  just render-without-throw).
- Full suite stays green (`pnpm -r test`) + typecheck.

## Out of scope

- Buyer portfolio view; live on-chain holder reconciliation; corporate-actions
  metrics; CSV/PDF export; configurable date ranges beyond the `days` param;
  real-time push (poll/refresh on mount is enough).

## Non-goals / YAGNI

No charting dependency, no FX conversion, no historical value snapshots (activity is
event-derived from the audit log), no new persistence.
