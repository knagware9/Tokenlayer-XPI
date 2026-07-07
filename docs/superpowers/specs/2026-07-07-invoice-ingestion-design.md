# Invoice Ingestion — ERP Connector + Upload UI

**Date:** 2026-07-07
**Status:** Approved
**Builds on:** the invoice-tokenization use case (2026-07-07 spec).

## Goal

Feed the invoice-tokenization use case from real sources instead of hand-typed
forms: (a) an **ERP-export connector** (file-based integration, the standard ERP
pattern) and (b) a **browser upload mechanism**, then exercise the full lifecycle
— issuance (tokenize) → transfer between financiers → redeem (burn at repayment).

## The load-bearing invariant: one canonical fingerprint

```
fingerprint = "0x" + sha256hex(
  trim(invoiceNumber) + "|" + upper(trim(sellerGstin)) + "|" +
  upper(trim(buyerGstin)) + "|" + integerString(amountInr) + "|" + trim(dueDate)
)
```

Computed identically by the Node connector (`node:crypto`) and the browser
importer (WebCrypto `crypto.subtle.digest`). The fingerprint is both the
`invoiceHash` metadata field and the **tokenId**, so the ledger's duplicate-tokenId
rejection blocks double financing **across channels**: an ERP-imported invoice and
a hand-uploaded duplicate collide.

## Components (no platform API changes — both are clients of the existing API)

1. **`samples/erp/invoices.csv`** — realistic ERP export: header
   `invoiceNumber,sellerGstin,buyerGstin,amountInr,dueDate,discountRatePct,invoiceDocUrl`,
   ~8 rows including ONE deliberate duplicate (same canonical fields, different
   doc URL) to prove the block.
2. **`scripts/erp-import.mjs`** — the connector. Args: `--api`, `--email`,
   `--password`, `--use-case`, `--chain`, `--financier <wallet>`, `--file`.
   Per row: validate → fingerprint → `POST /assets` (metadata incl. hash) →
   `POST /assets/:id/actions/allow` (financier; idempotent) → `POST .../actions/mint`
   (`tokenId` = fingerprint, `uri` = doc URL). Outcomes per row: `TOKENIZED`,
   `DUPLICATE-BLOCKED` (mint rejected by the ledger; the just-issued asset row is
   left with no token and reported), `INVALID` (metadata rejected). Exit summary
   with counts; non-zero exit if any row was INVALID (duplicates are an expected
   outcome, not an error).
3. **Web "Import" sub-tab** (`apps/web`, in AssetManagement next to Token
   Issuance/Marketplace): shown when the active use case is **non-fungible AND its
   metadataSchema has `invoiceHash` plus the five canonical fields** (no hardcoded
   use-case key). Flow: file input (.csv/.json) → parse in-browser → preview table
   (computed fingerprint + per-row schema validation) → financier picker (accounts
   list; mint recipient) → "Tokenize N invoices" runs issue → allow → mint per row
   with live per-row status (tokenized / duplicate / error). All steps go through
   the engine chokepoint (KYC-gated allowlist, jurisdiction, patterns) — the
   importer adds no compliance bypass.

## E2E proof (on the Docker deployment)

ERP connector imports the batch (financier A): 7 `TOKENIZED` + 1
`DUPLICATE-BLOCKED`. Browser-upload 2 more, one colliding with an ERP row →
blocked cross-channel (fingerprint determinism proven). Transfer one token
financier A → B; redeem one via burn; verify token registry, audit trail, and
dashboard reflect the full lifecycle.

## Error handling

Connector: per-row try/catch, precise outcome labels, summary; auth/connection
failures fail fast. Web importer: per-row status chips, parse errors shown before
any tokenization starts, partial-batch results preserved on screen.

## Out of scope

Live ERP APIs (SAP/Tally connectors), server-side bulk endpoint, background jobs,
CSV column-mapping UI (headers must match field names), PDF invoice parsing.
