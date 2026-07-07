# Invoice Financing + Deep-Tier Financing

**Date:** 2026-07-07
**Status:** Approved
**Builds on:** invoice-tokenization use case + ingestion.

## Goal

Add the financing lifecycle on top of tokenized invoices, and **deep-tier
financing** — extending credit down the supply chain (anchor buyer → tier-1
supplier → tier-2 → tier-3…), each tier a linked child invoice financed against
its parent under the anchor buyer's credit.

## Approved decisions

- **Record-only financing**: financing terms + status are recorded and the token
  moves to the financier through the existing compliance-checked transfer; **no
  CBDC cash leg** (kept out of scope for this iteration).
- **Deep-tier = linked child invoices**: a child references its parent
  (`parentInvoiceHash`), is capped at a % of the parent's face value, and is a
  full invoice token in its own right.
- **No core/engine changes** — this is an API layer over the existing token
  lifecycle (transfer/burn), plus config + web.

## Design

### A. Config (invoice-tokenization use case)

Add three OPTIONAL, backward-compatible metadata fields to
`config/use-cases/invoice-tokenization.json`:
- `parentInvoiceHash` — `string`, pattern `^0x[0-9a-fA-F]{64}$` (the parent
  invoice's tokenId; present only on deep-tier children).
- `tier` — `number`, min 1 (1 = a direct anchor-buyer invoice).
- `anchorBuyerGstin` — `string`, GSTIN pattern (the root buyer underwriting the
  chain; inherited by every descendant).

### B. Persistence — `Financing`

Prisma model (one per financed asset):
```prisma
model Financing {
  id               String   @id @default(cuid())
  assetId          String   @unique
  tokenId          String
  financier        String   // wallet
  ratePct          String   // annualised discount rate, decimal string
  tenorDays        Int
  faceValueInr     String
  discountedInr    String   // face × (1 − rate×tenor/365), floor — record-only
  maturityDate     String   // ISO date
  status           String   @default("financed") // financed | repaid
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
}
```
`FinancingRepository` (types + prisma + memory): `create`, `getByAsset(assetId)`,
`setStatus(assetId, status)`.

### C. API routes (apps/api/src/http/routes.ts)

All scoped like the existing asset routes; RBAC: finance/repay/deep-tier require
`issue` capability (Issuer / UseCaseAdmin / PlatformAdmin — the operator desk).

- `POST /assets/:id/finance` `{ financier, ratePct, tenorDays }` — the invoice must
  be a fungible-or-NFT invoice asset that is **not already financed**. Resolve the
  token's current holder (its single NFT owner via the adapter/audit); transfer the
  token holder→financier via `engine.transferToken` (enforces allowlist + IN
  jurisdiction + freeze — record-only, no cash). Compute
  `discountedInr = floor(face × (1 − ratePct×tenorDays/365))` in integer math,
  `maturityDate = today + tenorDays`. Create the `Financing` row (status
  `financed`). Return the financing record. If the transfer fails, nothing is
  recorded. `face` = the invoice's `amountInr` metadata.
- `POST /assets/:id/repay` — require a `financed` record; `engine.burnToken` the
  token (matured/repaid); set status `repaid`. Return the updated record.
- `GET /assets/:id/financing` — the `Financing` record (or `null`).
- `POST /assets/:id/deep-tier` `{ invoiceNumber, sellerGstin, buyerGstin?, amountInr,
  dueDate, invoiceHash, discountRatePct?, invoiceDocUrl? }` — the parent asset must
  be **financed**; require `amountInr ≤ floor(parentFace × DEEP_TIER_CAP_PCT/100)`
  (`DEEP_TIER_CAP_PCT` env, default 80) else `DEEP_TIER_CAP_EXCEEDED`. Mint a child
  invoice token via the normal issue+mint path, with metadata:
  `parentInvoiceHash = parent invoiceHash`, `tier = parentTier + 1`,
  `anchorBuyerGstin = parent.anchorBuyerGstin ?? parent.buyerGstin`,
  `buyerGstin = provided ?? parent.sellerGstin` (the tier-1 supplier is the buyer
  for the tier-2 sub-supplier). The child is minted to the **operator/seller**
  (the sub-supplier's receivable), ready to be financed independently. Duplicate
  `invoiceHash` is still blocked by the ledger. Return the child asset.
- `GET /assets/:id/tier-chain` — walk metadata links: find the root (follow
  `parentInvoiceHash` up), then all descendants (assets whose `parentInvoiceHash`
  is in the tree), returning `[{ assetId, invoiceNumber, tier, sellerGstin,
  buyerGstin, amountInr, financing: {financier,status}|null, parentInvoiceHash }]`
  so the UI can render the tree. Scoped to the caller's use case.

HTTP schemas for all five.

### D. Web (apps/web)

`AssetDetail` gains a **Financing** panel (for invoice-type assets — non-fungible
with the invoice fields, reusing the ingestion detection):
- Financing status/terms (financier, rate, tenor, face, discounted amount,
  maturity) from `GET /financing`.
- **Finance** form (financier picker + ratePct + tenorDays) with a live discounted-
  amount preview; disabled once financed. **Mark repaid** button when financed.
- **Extend to sub-supplier (deep-tier)** form: sub-supplier GSTIN, invoice number,
  amount (with the cap shown), due date, auto-computed fingerprint (reuse the
  InvoiceImport canonical hasher) → `POST /deep-tier`.
- **Tier chain** tree: render `GET /tier-chain` as an indented tree by `tier`, each
  node showing invoice #, amount, tier badge, financier/status; the current asset
  highlighted.

api.ts client methods + types for financing, deep-tier, tier-chain.

### E. Error handling

Typed: `ALREADY_FINANCED`, `NOT_FINANCED` (repay before finance),
`DEEP_TIER_CAP_EXCEEDED`, `PARENT_NOT_FINANCED`, `NO_WALLET`, plus engine
PolicyErrors on the transfer (allowlist/jurisdiction/freeze). Finance is atomic:
the Financing row is created only after a successful transfer.

### F. Testing

- API: finance an invoice (token owner → financier, record created, discounted
  math correct); double-finance → `ALREADY_FINANCED`; repay (token burned, status
  `repaid`); deep-tier child within cap (linked, tier+1, anchor inherited) and
  over-cap rejected; a 3-level chain via tier-chain; a non-financed parent rejects
  deep-tier; tenancy (cross-use-case blocked). Duplicate child hash blocked.
- Web: typecheck + build.
- Full suite green + typecheck; live E2E on the deployment.

## Out of scope

CBDC cash disbursement/settlement (record-only); rate/bid engine; automated
repayment waterfalls / securitisation pooling (doc Phase 3); partial financing;
default handling beyond the existing freeze.
