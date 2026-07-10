# Investor Portal v1 — Design

**Date:** 2026-07-10
**Status:** Approved (brainstorm decisions locked with user)

## Goal

Give investors (role `Buyer`) a dedicated, investor-first experience in the existing
webapp — statement #6 of the product vision: *"Simplify investment process and
portfolio management for your investors … from subscribing to new offerings to
managing payments and transfers."* Digital-identity KYC (statement #2) is the NEXT
cycle; this cycle ships the portal.

## Decisions (locked)

1. **Delivery:** investor mode inside the same webapp. When a `Buyer` logs in, the
   app renders the investor experience instead of the operator console. Operators,
   auditors, and admins are unchanged.
2. **V1 scope:** Offerings + subscribe, Portfolio + activity. NOT in v1: sell/exit
   from portfolio, self-service sign-up, cross-use-case offerings.
3. **Tenancy:** an investor sees offerings from their own use case only. No changes
   to the tenancy model; new endpoints clamp to the caller's `useCaseKey` exactly
   like existing scoped routes.
4. Compliance stays fail-closed and entirely server-side (KYC / jurisdiction /
   allowlist enforced by the existing engine chokepoint at buy time). The portal
   surfaces rejections clearly; it never pre-empts them client-side.

## Architecture

Two new **read-only aggregation endpoints** on the API (the only backend change),
plus an investor UI in `apps/web`. Everything else reuses existing routes:
`GET /assets`, `GET /assets/:id`, `GET /assets/:id/listings`, `POST /assets/:id/buy`,
`POST /listings/:id/take`, `GET /documents/:id`.

### New API

Both endpoints resolve the caller's linked wallet (user → accountId → address) and
return `400 NO_WALLET` when absent. Both are `Buyer`-accessible but not
Buyer-exclusive (any authenticated role with a linked wallet may call them — they
describe *the caller*, so there is nothing to leak).

**`GET /me/portfolio`**

```json
{
  "wallet": "0x…",
  "cash": [{ "currency": "CBDC-INR", "amount": "125000" }],
  "holdings": [{
    "assetId": "…", "name": "RAMCO-INV-011824-2026 · JSW Steel Limited",
    "symbol": "INVT", "useCaseKey": "invoice-tokenization", "chainId": "fabric",
    "units": "371", "unitPrice": "920", "currency": "CBDC-INR", "value": "341320"
  }],
  "totalByCurrency": { "CBDC-INR": "466320" }
}
```

- Holdings come from the server-side audit fold (`holders.foldAsset` over
  `audit.listByAssetIds`, chronological) — the same per-asset accounting that
  drives redemption and analytics. NOT raw ledger balances (invoices share one
  ERC-20 contract, so ledger balances are pooled across assets).
- `value` = `units × unitPrice` when the asset has sale terms; otherwise, for a
  use case with `valuation` (e.g. invoices), the investor's pro-rata share of the
  metadata face value (`units × faceValue / totalSupply`, BigInt floor); otherwise
  omitted from totals.
- Assets iterated: the caller's use case's assets (`assets.list({ useCaseKey })`),
  active or matured — zero-unit holdings are excluded.

**`GET /me/activity`**

```json
[{ "at": "2026-07-10T…", "kind": "subscribed", "assetId": "…", "assetName": "…",
   "units": "371", "amount": "341320", "currency": "CBDC-INR", "txHash": "0x…" }]
```

Newest-first, derived from the same chronological audit fold in one pass:

| kind | source audit entry | attribution |
|---|---|---|
| `subscribed` | `buy` where `payload.to == wallet` | units = amount; amount = cost |
| `received` | `transfer`/`mint` where `payload.to == wallet` | units |
| `sent` | `transfer` where `payload.from == wallet` | units |
| `coupon` | `distribute` | recomputed share (see below) |
| `redemption` | `redeem` | recomputed share + units retired |

`distribute`/`redeem` audit payloads carry only aggregates
(`{currency, amount, paid, holders, from, seq}`), so the investor's share is
**recomputed**: the fold's balances *at that point in the stream* → drop the payer
share → `splitProRata` (core, BigInt floor) → the wallet's slice. This reuses the
exact pure helpers the settlement path used, so displayed amounts match what was
paid. Escrow moves (list/cancel by a legacy path) appear as plain `sent`/`received`
in v1. Limit: last 100 events.

### Web (investor mode)

`App.tsx`: `user.role === "Buyer"` → render `<InvestorPortal />` (new component
tree) instead of the operator sections. Header unchanged (brand, email, sign out).
Sections: **Offerings · Portfolio · Activity** (same pill-tab pattern as the
operator console).

- **Offerings** (`InvestorOfferings.tsx`): grid of cards for active assets with
  sale terms (`unitPrice > 0`) — name, price/unit, currency, available supply,
  2-3 metadata highlights, doc link when a `document` field is present — plus a
  "Secondary market" strip of open listings (price, remaining qty, seller label).
  Detail view: full metadata, documents, and a **Subscribe** box — quantity input,
  live cost preview (`qty × unitPrice`, marketplace fee bps shown when configured),
  confirm → `POST /assets/:id/buy`; listings use `POST /listings/:id/take`.
  Server rejections (INSUFFICIENT_FUNDS, JURISDICTION_NOT_ALLOWED, NOT_ALLOWED,
  KYC…) surface as human-readable banners.
- **Portfolio** (`InvestorPortfolio.tsx`): headline total (per currency), cash
  balances, holdings table from `/me/portfolio`.
- **Activity** (`InvestorActivity.tsx`): feed from `/me/activity` with kind pills
  and relative timestamps.
- Client: `api.mePortfolio(token)`, `api.meActivity(token)` + types.

### Buyers without a wallet

Render the portal chrome with an empty-state card ("Your account has no linked
wallet yet — contact your desk administrator"), driven by the `NO_WALLET` error.

## Error handling

- `/me/*`: 401 unauthenticated; 400 `NO_WALLET`; empty arrays (not errors) for an
  investor with no holdings/activity.
- Subscribe flow: pass through the API's error code + message verbatim into the
  banner; never retry automatically.

## Testing

- **API tests** (`apps/api/test/investor-portal.test.ts`): portfolio holdings math
  (buy → units/value correct; invoice face-value pro-rata; excludes zero
  holdings); activity kinds incl. a coupon whose recomputed share matches what the
  settlement actually paid; tenancy (holdings never include another use case's
  assets); `NO_WALLET`; walletless roles.
- **Live E2E** (`scripts/investor-portal-e2e.mjs`): onboard an IN-KYC investor →
  fund → subscribe to an offering via the portal endpoints → execute a coupon →
  `/me/portfolio` shows the holding + value, `/me/activity` shows subscribed +
  coupon with the exact paid amount.
- **Browser verification**: log in as an investor in the preview; check all three
  sections render; subscribe end-to-end; confirm a compliance rejection banner
  (non-IN investor) reads clearly.

## Out of scope (later cycles)

Sell/cancel from portfolio · self-service sign-up + KYC submission ·
digital-identity provider integration (#2, next cycle) · cross-use-case
offerings · white-label theming.
