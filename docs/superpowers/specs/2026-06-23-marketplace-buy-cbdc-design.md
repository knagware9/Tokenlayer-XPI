# Marketplace Buy + CBDC Payment (DvP) — Design (Sub-project A)

**Date:** 2026-06-23
**Status:** Approved (pending written-spec review)

## Context

Buyers can currently only view the marketplace; tokens move via operator transfers. We want a
**buyer-initiated purchase** that settles **delivery-versus-payment (DvP)**: the buyer pays in a
digital currency (CBDC and others) and atomically receives the asset tokens. Builds on sub-project
B (KYC) — only KYC-approved, allowlisted buyers can transact. Applies across all use cases.

## Decisions (confirmed)

1. **Multiple settlement currencies** (incl. CBDC-INR), defined in a config list; each asset is
   priced in one chosen currency.
2. **Primary sale only** — buyers buy from a per-asset **treasury pool** at the issuer-set **unit
   price**. No buyer-to-buyer resale yet.
3. **Funding** — Issuer/UseCaseAdmin credits CBDC to KYC-approved accounts; seed demo balances.
4. **Buyer self-service** — the Buyer initiates the buy (new `buy` capability for the Buyer role).

## 1. Currencies + CBDC cash ledger

- `config/currencies.json` — supported settlement currencies, `[{ code, label }]`, e.g.
  `CBDC-INR` ("Digital Rupee (CBDC)"), `USDC` ("USD Coin"), `e-GBP` ("Digital Pound"). Loaded like
  the chains/use-cases config; exposed via `GET /api/v1/currencies`.
- **Cash ledger** — a new `CashRepository` tracking balances by `(currency, address)`; amounts are
  integer strings (consistent with token amounts):
  - `balanceOf(currency, address): Promise<string>`
  - `credit(currency, address, amount): Promise<void>` — funding (mint cash).
  - `transfer(currency, from, to, amount): Promise<void>` — the payment leg; throws
    `INSUFFICIENT_FUNDS` if `from` lacks the balance.
  - `balancesOf(address): Promise<{ currency, amount }[]>` — for "My Holdings".
  - In-memory impl + Prisma `CashBalance(id, currency, address, amount)` with a unique
    `(currency, address)` index. Seeded demo balances for buyer wallets.

## 2. Asset sale terms

`Asset` gains nullable `unitPrice: string | null`, `currency: string | null`,
`treasuryAccount: string | null`. Set at **issuance** (the `POST /assets` body gains optional
`sale: { unitPrice, currency, treasuryAccount }`) and editable via `POST /assets/:id/actions/setPrice`
(`{ unitPrice, currency, treasuryAccount }`, Issuer/UseCaseAdmin/PlatformAdmin). `currency` must be
one of the configured currencies. The issuer mints supply to `treasuryAccount`; that pool is the
seller. An asset with no sale terms is simply not buyable (Buy hidden).

## 3. Buy — atomic DvP

- New lifecycle action **`buy`**; RBAC grants it to **Buyer**, Trader, UseCaseAdmin, PlatformAdmin.
- `POST /api/v1/assets/:id/buy` — body `{ quantity: string }`. The buyer is the **logged-in user**:
  delivery goes to their linked wallet (`accountId → account.address`), payment from their CBDC
  balance in the asset's `currency`.
- **Pre-checks (all before any state change):** asset has sale terms; buyer has a linked wallet;
  `cost = unitPrice × quantity`; buyer's `balanceOf(currency, wallet) ≥ cost`; treasury token
  balance ≥ quantity. (KYC/allowlist + freeze are enforced by the delivery leg below.)
- **Settlement (payment-first with compensation):**
  1. `cash.transfer(currency, buyerWallet, treasuryAccount, cost)` — payment.
  2. `engine.buy(actor, ctx, treasuryAccount, buyerWallet, quantity, { unitPrice, currency, cost })`
     — the **token delivery** leg: a new engine method that authorizes `"buy"`, runs the same
     compliance as transfer (fungible, lifecycle-transfer enabled, allowlist on both parties, not
     frozen), calls `adapter.transfer(treasury → buyer)`, and writes a `"buy"` audit entry
     (`{ from, to, amount: quantity, unitPrice, currency, cost, actorRole }`).
  3. If step 2 throws (e.g. `NOT_ALLOWLISTED`/`ACCOUNT_FROZEN`), **refund** the cash
     (`cash.transfer(currency, treasury, buyerWallet, cost)`) and surface the original error.
- The chain-agnostic `LifecycleEngine` stays free of any cash concept — cash lives entirely in the
  API layer around the existing compliance-checked token move.

## 4. CBDC funding

`POST /api/v1/cash/credit` — body `{ account, currency, amount }`. Allowed for Issuer /
UseCaseAdmin / PlatformAdmin. Scope-guarded: the target `account` must be in the caller's use case
(via the existing account→user scoping) and its owning user KYC-approved (PlatformAdmin
unrestricted). `currency` must be configured. Credits the cash balance.

## 5. Web

- `api.ts`: `currencies()`, `cashBalances(address)`, `buy(id, quantity)`, `setPrice(id, terms)`,
  `creditCash(account, currency, amount)`; `issue` gains optional `sale`.
- **Issuance form** (Token Issuance): optional "List for sale" fields — unit price, currency
  (dropdown from `/currencies`), treasury account (dropdown from scoped accounts).
- **Marketplace / AssetDetail**: when the asset has sale terms and the user can `buy`, a **Buy**
  panel — quantity input, shows unit price + currency + computed total + the buyer's balance in
  that currency; confirm → `POST /buy`; surfaces `INSUFFICIENT_FUNDS` etc.
- **My Holdings**: a CBDC balances section (per currency) alongside token holdings.
- **Fund CBDC** control (Issuer/UseCaseAdmin): credit a chosen in-scope account in a currency.

## 6. Seed / compatibility

- Seed demo CBDC balances for the buyer wallets (e.g. each `<uc>.buyer` wallet funded in a default
  currency) so Buy works out of the box.
- Existing assets/flows are unaffected: sale terms are nullable, `buy` is additive, and the
  existing transfer/mint/allow paths are unchanged. `e2e-tenancy`/`e2e-carbon` keep passing; a new
  `e2e-buy` exercises fund → list → buy → balances.

## 7. Testing

- **Core:** `buy` in the RBAC matrix (Buyer yes; the read-only check updated); `engine.buy`
  authorizes `"buy"`, enforces allowlist/freeze, writes the audit entry.
- **Cash repo:** credit, transfer, `INSUFFICIENT_FUNDS`, balancesOf.
- **API:** buy happy path (buyer cash ↓, treasury cash ↑, tokens delivered, `buy` audit); buy
  blocked — no sale terms, insufficient cash, treasury short, non-KYC/allowlisted buyer (and cash
  refunded on the compliance failure); funding scope rules; `currency` validation.
- **Web:** typecheck + live preview — fund a buyer, list an asset, buy as the buyer, balances move.

## Out of scope

Buyer-to-buyer secondary market / order book; real external payment rails; FX between currencies;
fractional/decimal prices (integer amounts only); refunds/cancellations beyond the DvP compensation;
settlement finality guarantees beyond the simulated atomic compensation.
