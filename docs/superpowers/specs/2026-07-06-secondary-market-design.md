# Secondary Market — Escrowed Sell-Listings

**Date:** 2026-07-06
**Status:** Approved
**Feature cycle 3 of 3** (analytics dashboard + richer low-code config are merged.)

## Problem / goal

Tokens can only be bought from the issuing treasury (`POST /assets/:id/buy`).
Holders cannot sell to each other, so there is no secondary liquidity, no price
discovery, and no market beyond primary issuance. This adds peer-to-peer trading
as an **escrowed sell-listings marketplace** under the full compliance model.

## Approved decisions

- **Market model: sell-listings** (asks only). Holders list `quantity @ unitPrice
  currency`; eligible buyers take any quantity (partial fills). No bids/matching
  engine, no order expiry, fungible assets only.
- **Escrow on list:** listing moves the tokens to a platform escrow account on the
  asset's ledger, so takes can never fail on seller balance. Cancel returns them.
- Settlement reuses the proven DvP + compensation pattern; the cycle-2
  `fees.marketplaceBps` applies to secondary takes (fee → platform fee account,
  remainder → **seller**).

## Escrow × compliance semantics (normative)

- **Lockup** (`lockupDays`): enforced at **list time** on the seller (seller→escrow
  is the transfer; a seller inside lockup cannot list). Takes (escrow→buyer) do
  NOT check lockup on the escrow. The buyer's own lockup clock starts at take
  (their first credit in the audit stream — already how `acquiredAt` works).
- **Jurisdiction / holder-limit**: enforced on the **buyer** at take time; **skipped
  for the escrow account** (system account, not a holder). Cancel-returns to the
  seller also skip jurisdiction/holder-limit (the seller was the prior owner).
- **Allowlist / freeze**: seller must be allowed + unfrozen to list; buyer allowed +
  unfrozen to take. The escrow address is auto-allowlisted per asset by the
  operator on first use (when the use case has `compliance.allowlist`).
- **Trading gate**: all market operations require the use case's
  `lifecycle.transfer` to be enabled.

## Design

### 1. Core (packages/core)

- `LifecycleAction` union gains `"list"` and `"cancel-listing"` (audit + RBAC).
  RBAC matrix: `Buyer` gains `list`/`cancel-listing`; `Trader`, `UseCaseAdmin`,
  `PlatformAdmin` too. `Auditor`/`Issuer` do not.
- `LifecycleEngine` gains three escrow-aware methods (engine stays the single
  policy chokepoint; the escrow address is a parameter — the engine holds no env):
  - `escrowList(actor, ctx, seller, escrow, amount)` — authorize `list`; require
    `lifecycle.transfer`; require fungible; allowlist(seller) + notFrozen(seller);
    **lockup(seller)**; then `adapter.transfer(ref, seller, escrow, amount)`.
    Audits as `list` with `{seller, escrow, amount}`.
  - `escrowRelease(actor, ctx, escrow, seller, amount)` — authorize
    `cancel-listing`; require `lifecycle.transfer`; no compliance checks beyond
    notFrozen(seller) (returning prior property); `adapter.transfer(ref, escrow,
    seller, amount)`. Audits as `cancel-listing`.
  - `settleFromEscrow(actor, ctx, escrow, to, amount, meta)` — authorize `buy`;
    require `lifecycle.transfer` + fungible; allowlist(to) + notFrozen(to);
    **jurisdiction(to) + holder-limit(to)**; NO lockup (from is escrow);
    `adapter.transfer(ref, escrow, to, amount)`. Audits as `buy` with the price
    meta (so analytics' traded metrics count secondary trades automatically).

### 2. Persistence (apps/api)

- Prisma model `Listing`:
  ```prisma
  model Listing {
    id        String   @id @default(cuid())
    assetId   String
    seller    String   // wallet address
    quantity  String   // REMAINING quantity (decrements on takes)
    unitPrice String
    currency  String
    status    String   @default("open")  // open | filled | cancelled
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt
    @@index([assetId, status])
  }
  ```
- `ListingRepository` (types + Prisma + memory): `create`, `get`, `listByAsset
  (assetId, status?)`, `decrement(id, byQuantity)` (sets `filled` at 0),
  `cancel(id)`.

### 3. API routes (apps/api/src/http/routes.ts)

- `MARKET_ESCROW_ACCOUNT` env (apps/api/src/env.ts): the escrow address. Outside
  production it defaults to a seeded demo address; unset in production → the
  market endpoints return 503 `MARKET_DISABLED`. Documented in `.env.example`.
- `POST /assets/:id/listings` `{quantity, unitPrice, currency}` — caller must have
  a linked wallet (the seller); validate positive integer quantity/price +
  supported currency; auto-allowlist escrow (operator `setAllowed`) if the use
  case has allowlist and escrow isn't yet allowed; `engine.escrowList`; create the
  Listing row. If the row create fails, compensate (`escrowRelease`).
- `GET /assets/:id/listings` — open listings, sorted unitPrice asc then createdAt.
- `POST /listings/:id/take` `{quantity}` — buyer (linked wallet) takes ≤ remaining:
  `cost = quantity × unitPrice`; require buyer cash ≥ cost; fee =
  `floor(cost × marketplaceBps / 10000)` when configured (same rules as primary);
  cash buyer→feeAccount(fee) + buyer→seller(cost−fee); then
  `engine.settleFromEscrow`; decrement the listing. Full cash compensation if the
  token leg fails (both legs reversed). Sellers cannot take their own listing.
- `DELETE /listings/:id` — the seller (own listing) or an admin cancels:
  `engine.escrowRelease` for the remaining quantity, mark cancelled.
- `GET /assets/:id/trades` — recent trades derived from the asset's audit `buy`
  entries (amount, unitPrice, currency, at, from→to), newest first, limit 50.
- All routes scoped by use case exactly like the existing asset routes (scoped
  callers only reach assets in their use case; listings resolve through the asset).
- HTTP schemas for all five routes.

### 4. Web (apps/web)

- **AssetDetail** gains a **Market** section (fungible assets):
  - Open asks: qty remaining @ price, sorted; a Take button with quantity input
    (visible to roles with `buy`); disabled when it's the caller's own listing.
  - Sell form (visible when the signed-in user's wallet holds a balance): quantity
    + price + currency → create listing.
  - My listings: the caller's open listings with Cancel.
  - Recent trades list (from `GET /assets/:id/trades`).
- **MyHoldings**: each holding row gains a "Sell" affordance navigating to the
  asset's Market section.
- api.ts client methods + types for listings/trades.

### 5. Error handling

- Typed errors end-to-end: `MARKET_DISABLED`, `NO_WALLET`, `INSUFFICIENT_BALANCE`
  (list > holdings), `LISTING_NOT_OPEN`, `TAKE_EXCEEDS_REMAINING`, `OWN_LISTING`,
  `INSUFFICIENT_FUNDS` (buyer cash), plus the engine's compliance PolicyErrors
  (`LOCKUP_ACTIVE` at list; `JURISDICTION_NOT_ALLOWED`/`HOLDER_LIMIT_EXCEEDED`/
  `NOT_ALLOWLISTED`/`ACCOUNT_FROZEN` at take) via the existing envelope.
- Take is atomic: cash legs reversed if delivery fails; listing decremented only
  after successful delivery.

### 6. Testing

- **Core:** the three engine methods × rules — lockup blocks list (inside window)
  and allows after; jurisdiction/holder-limit block a take (bad buyer) but ignore
  escrow; release skips buyer-rules; non-fungible rejected; `lifecycle.transfer`
  disabled blocks all three; RBAC (Buyer can list, Auditor cannot).
- **API:** full lifecycle — list (escrow moves, listing row), partial take (cash
  split incl. fee→feeAccount + remainder→seller, tokens delivered, remaining
  decremented), second take to fill (status `filled`), cancel returns remaining;
  guards (take > remaining, own listing, buyer without funds refunded, listing on
  a frozen seller blocked); tenancy (cross-use-case caller cannot see/take);
  trades endpoint returns the takes.
- **Web:** typecheck + build.
- Full suite green (`pnpm -r test`) + typecheck; live smoke on the sim stack.

## Out of scope

Bids/matching, order expiry/TTL, NFT (token-id) listings, cross-asset portfolio
views, on-chain escrow contracts (escrow is a platform-operated account, matching
the operator-mediated compliance model), market-data candles/charts.
