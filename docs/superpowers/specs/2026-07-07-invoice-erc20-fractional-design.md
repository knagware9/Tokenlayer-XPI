# Invoice Tokenization → Fractional ERC-20 + Marketplace

**Date:** 2026-07-07
**Status:** Approved (design)
**Branch:** `feat/invoice-erc20-fractional`

## Problem

Product review of the live invoice use case surfaced 10 issues. The root cause of
most is that `invoice-tokenization` was modelled as **ERC-721** — one indivisible
NFT per invoice, `tokenId` = fingerprint, financing = transferring the whole NFT
to a financier, deep-tier = child NFTs. The desired ("real") flow is fractional:
an invoice becomes **N fungible tokens** that an issuer issues to a holder, who
then lists or transfers them, and financiers buy tokens (fractional invoice
discounting).

### Feedback → resolution

| # | Feedback | Resolution |
|---|----------|-----------|
| 1 | No tokens minted | ERC-20 mints the full supply at issue → live supply immediately |
| 2 | Doc URL should also take an upload | `POST /documents` stores the file; Issue form gains a file picker |
| 3 | Tenure — undefined days | FinancingPanel removed (financing → marketplace) |
| 4 | Rate — undefined % | same |
| 5 | Token price, supply, listing not done | native to the fungible AssetDetail (buy + sell/list cards) |
| 6 | Invoice hash should be calculated from data | server-derives `invoiceHash` from canonical fields; UI shows read-only preview |
| 7 | Import — ERP export or file upload | kept; Import reworked to fungible issue-to-holder |
| 8 | "Tokenize N invoices" disabled | replace "financier required" with "holder"; enable once a holder is chosen |
| 9 | Use ERC-20; one invoice = 100 or 10000 tokens | model flip; issuer sets the supply |
| 10 | Make it a real use case | upload/ERP → issuer tokenizes with a token count → issues to a holder → holder lists/transfers |

## Decisions (from brainstorming)

1. **Financing model:** *Marketplace = financing.* Retire the bespoke
   `finance/repay/deep-tier/tier-chain` feature; fractional invoice discounting is
   done by listing tokens at a discounted price and having financiers buy them via
   the existing DvP marketplace.
2. **Supply & price:** issuer picks the **number of tokens** (supply); par value
   per token = face ÷ supply (informational); the **discounted price is set at
   listing** (financier's yield = par − discounted price).
3. **Hash & document:** `invoiceHash` is **auto-derived** (server-side, from the
   canonical fields; UI shows a live read-only preview). The document field
   accepts a **file upload** (API stores it, records URL + content hash); URL
   entry still allowed.
4. **Duplicate guard:** enforce **one tokenized asset per invoice fingerprint**
   (unique `invoiceHash` across the use case's assets) at issue time → the
   anti-double-financing guarantee, moved from mint-time to issue-time.

## Architecture

### Model shift

`config/use-cases/invoice-tokenization.json`:
- `tokenStandard`: `ERC-721` → `ERC-20`. `symbol` stays `INVT`.
- Remove financing-only metadata fields: `tier`, `parentInvoiceHash`,
  `anchorBuyerGstin`.
- Keep `invoiceNumber`, `sellerGstin`, `buyerGstin`, `amountInr`, `dueDate`,
  `discountRatePct`, `invoiceDocUrl`, and `invoiceHash`.
- Add optional `invoiceDocHash` (string) to the schema so the uploaded
  document's SHA-256 can be pinned in metadata without validation rejecting it.
- `invoiceHash` is no longer a required *input* — it is server-derived. It stays
  in the schema (pattern-validated) so it appears in metadata, but the Issue form
  renders it read-only.
- `valuation { amountInr, INR }` stays (dashboard values invoices by face value ×
  live supply — already correct for fungible).
- `lifecycle`: mint/transfer/burn/freeze all true. `compliance`: allowlist +
  `allowedJurisdictions ["IN"]` stays.

Flipping the standard routes every invoice through the existing fungible path:
`IssuePanel` already renders supply + treasury + list-for-sale; `AssetDetail`'s
`!isNft` branch already renders total supply, a Buy panel, and a secondary-market
card (sell / list / cancel / trades); `MyHoldings` already supports Sell.

### New building block 1 — canonical fingerprint + unique guard

A shared canonical-fingerprint function in `@tokenlayer/core`, byte-identical to
the existing `scripts/erp-import.mjs` / web `computeFingerprint`:

```
fingerprint = "0x" + sha256(
  trim(invoiceNumber) + "|" +
  upper(trim(sellerGstin)) + "|" +
  upper(trim(buyerGstin)) + "|" +
  String(parseInt(amountInr)) + "|" +
  trim(dueDate)
)
```

Opt-in via new optional `UseCaseDefinition` fields:
- `derivedFields?: { invoiceHash: "invoiceFingerprint" }` — on issue the API
  computes `invoiceHash` from the canonical fields and writes it into metadata,
  overriding any client-supplied value (so #6 is enforced server-side; the client
  need not send it).
- `uniqueBy?: "invoiceHash"` — on issue the API rejects a create whose
  `invoiceHash` already exists among the use case's assets → `409
  DUPLICATE_INVOICE`.

Both are generic (config-declared), not hard-coded to invoices, so other use
cases can reuse them. Validation added in `packages/core/src/validation.ts`.

The uniqueness check needs to find assets by a metadata field. Implement as a
narrow repo query (`AssetRepository.findByMetadata(useCaseKey, field, value)`)
in both Prisma and memory repos, or scan the (small) per-use-case asset list.
Prefer the explicit repo method for clarity.

### New building block 2 — document storage

- Prisma `Document` model: `id` (cuid), `contentType`, `sha256`, `bytes` (Blob),
  `size`, `createdAt`.
- `DocumentRepository` (Prisma + memory): `create(bytes, contentType) → { id,
  sha256, size }`, `get(id) → { bytes, contentType } | null`.
- `POST /documents` (auth, issue-capable): accepts the file. Transport: JSON body
  `{ contentType, dataBase64 }` (keeps the existing JSON body parser; avoids a
  multipart dependency). Enforce a max size (e.g. 5 MB). Returns
  `{ id, url: "/api/v1/documents/:id", sha256, size }`.
- `GET /documents/:id` (auth): streams the bytes with the stored `contentType`.
- The Issue form uploads the file, then sets `invoiceDocUrl` to the returned
  `url`; the returned `sha256` is stored alongside as `invoiceDocHash` in
  metadata (optional field) so the on-ledger record pins the document.

### Retire financing / deep-tier

Remove:
- Routes: `finance`, `repay`, `deep-tier`, `tier-chain`, and their helpers
  (`requireIssue`, `ensureAllowed`, `isoDatePlusDays`) if unused elsewhere.
- `Financing` Prisma model + `FinancingRepository` (types/prisma/memory).
- `deepTierCapPct` env + wiring in `context.ts`/`app.ts`/`server.ts`/test
  helpers/e2e scripts.
- `LifecycleAction` members `finance`/`repay`, and the finance/repay audit-event
  emission + analytics handling + `summarize` cases. **Keep** the analytics
  `valuation` feature (it is orthogonal and still used).
- Web: `FinancingPanel.tsx`, the `financing/finance/repay/deepTier/tierChain` api
  methods, `Financing`/`TierChainNode` types, and the AssetDetail import/usage.
- Tests: `apps/api/test/financing.test.ts`; the finance/analytics-traded
  assertions that depend on finance events (the `finance`-as-traded analytics
  test is removed; valuation tests stay).

> Note: this deletes recently-merged work by explicit choice — marketplace buys
> now represent financing. Traded/activity analytics reflect marketplace `buy`
> events as before.

### Web changes

- **`isInvoiceUseCase`** (AssetManagement + FinancingPanel's copy is deleted):
  drop the `tokenType === "nonfungible"` requirement; detect by the invoice
  metadata fields only.
- **IssuePanel:**
  - When the use case declares `derivedFields.invoiceHash`, render `invoiceHash`
    read-only and show a live preview computed from the canonical fields (reuse
    the web `computeFingerprint`); do not require manual entry; omit it from the
    submitted metadata (server derives it).
  - Document (`type: "document"`) fields: add a file picker that uploads via
    `api.uploadDocument(...)` and fills the field with the returned URL; keep the
    URL text input as an alternative.
- **Import tab (`InvoiceImport.tsx`):** rework from `issue → allow → mint(tokenId)`
  to fungible `issue(initialSupply, treasury=holder, sale?)`:
  - Replace the "Financier (mint recipient)" select with a "Holder (issue to)"
    select (fixes #8).
  - Add a "Par value per token (₹)" input (default `1`); per-invoice supply =
    `round(amountInr / par)` (≥ 1). Show the resulting token count per row.
  - Duplicate fingerprint → the API returns `409 DUPLICATE_INVOICE`; surface as
    the existing "duplicate" row status.
- **AssetDetail:** remove FinancingPanel; the fungible branch already covers
  supply, buy, list/sell, transfer.

### Data flow (happy path, realizing #10)

1. Issuer ingests invoices (Import tab or ERP connector) **or** enters one on the
   Issuance tab.
2. Issuer tokenizes: server derives `invoiceHash`, rejects duplicates, mints
   `supply` tokens to the chosen **holder** (MSME seller / treasury).
3. Holder lists tokens at a discounted price (secondary-market card) — or the
   issuer lists at issue via "list for sale".
4. A KYC'd, IN-jurisdiction, allowlisted **financier buys** tokens (DvP: CBDC →
   holder, tokens → financier). This *is* the financing.
5. Financier can transfer or re-list; at maturity the receivable is settled and
   the tokens can be burned (redeem).
6. Dashboard: Tokenized value = Σ face value of live invoices (INR); Traded =
   marketplace buy volume.

## Error handling

- `409 DUPLICATE_INVOICE` — re-tokenizing an existing fingerprint.
- `413`/`400` — document upload over the size cap or bad base64.
- `404` — `GET /documents/:id` for an unknown id.
- Existing compliance failures (allowlist / IN jurisdiction / freeze) continue to
  apply fail-closed on mint (issue) and on buy/transfer.

## Testing

- Core: canonical fingerprint unit tests (parity with the web/Node hashers);
  `derivedFields`/`uniqueBy` validation.
- API:
  - issue derives `invoiceHash` and ignores a bogus client value;
  - duplicate invoice → 409;
  - document upload round-trip (`POST` then `GET`, sha256 + contentType);
  - full fungible invoice lifecycle: issue supply → list → buy (DvP) → transfer →
    burn;
  - analytics valuation still correct for ERC-20 invoices (kept from prior work).
- Web: `tsc --noEmit` + build.
- Live E2E script on the deployment: ingest → tokenize into N tokens → issue to
  holder → list → financier buys → transfer → dashboard.

## Out of scope

- Auction/bidding for the discount rate (single listing price only).
- Multipart/streaming uploads (base64 JSON is sufficient for the demo).
- Migrating existing NFT-tokenized invoices in a live DB (fresh-volume boot
  re-seeds cleanly).

## Phasing

1. **Config + API:** model flip; canonical-hash module + derive/verify + unique
   guard; `POST/GET /documents`; retire financing; update tests.
2. **Web:** IssuePanel auto-hash + doc upload; Import tab fungible rework; remove
   FinancingPanel + financing api/types; `isInvoiceUseCase` update.
3. **Verify:** live E2E; full suite; code review; merge.
