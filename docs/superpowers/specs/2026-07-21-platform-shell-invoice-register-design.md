# Platform Shell + Invoice Register — Design

**Date:** 2026-07-21
**Status:** Approved for planning
**Scope:** A professional app shell (fixed left sidebar, all roles) with renamed
sections (My Credentials, Asset Ledger, Recent Transactions, My Profile, Logout),
and a server-side Invoice Register: upload/ERP-pull invoices into a persistent
staging store, then SELECTIVELY tokenize them (replacing the immediate-tokenize
Import tab).

Locked decisions (user-confirmed 2026-07-21):
1. **Sidebar for the whole app, all roles** — one shell, role-aware items.
2. **Server-side invoice register, both sources** — CSV upload AND a one-click
   demo ERP pull, plus single manual entry; staged rows persist and are
   selectively tokenized later.

## A. App shell — `AppShell` (web)

New `apps/web/src/components/AppShell.tsx` wraps every AUTHENTICATED screen
(public Home/Signup/Login unchanged):
- **Left sidebar**, fixed width (~16rem), dark ink background (the header's
  existing palette): the Logo at top; icon+label nav items; pinned at the
  BOTTOM: **My Profile**, **My Credentials**, **Logout** (Logout calls the
  existing sign-out). Active item highlighted. On small screens (< md) the
  sidebar collapses behind a hamburger in the top bar.
- **Top bar**: slim, shows the signed-in email + role pill (what the old dark
  header showed); the old `Header` is absorbed by the shell.
- **Content area**: right of the sidebar, existing max-width container.

Role-aware nav (reusing today's visibility rules exactly — only the PLACEMENT
and LABELS change):
- **Desk roles** (PlatformAdmin in a use case, UseCaseAdmin, Issuer, OrgAdmin,
  Auditor): Dashboard (was Overview), **Asset Ledger** (was Asset Management;
  keeps its Token Issuance / Marketplace / Holdings sub-views), **Invoices**
  (NEW — only when `isInvoiceUseCase(activeUseCase)` and the role can issue),
  Approvals, User Management, Organizations, Verification (each shown per the
  current role rules).
- **PlatformAdmin platform home** (no use case selected): Dashboard, Use Cases,
  Create Use Case, Organizations, Approvals, Verification, Networks. Selecting
  a use case swaps the sidebar to the use-case console items plus an
  "← All use cases" item at the top (navigate back to `/`).
- **OrgAdmin**: Configure Use Case (the existing wizard, was their Overview),
  Asset Ledger, Approvals, User Management, Organizations, Verification.
- **Buyer (investor)**: **Portfolio**, **Offerings**, **Recent Transactions**
  (was Activity). The InvestorPortal's internal tab row is replaced by these
  sidebar items.

Renames everywhere (nav + headings + empty-state copy that names the tab):
"My identity" → **My Credentials**; "Activity" → **Recent Transactions**;
"Asset Management" → **Asset Ledger**. The Import sub-tab is REMOVED (replaced
by the Invoices register below).

**My Profile** — new `MyProfile.tsx`: read-only account card built from the
session user + `/me`-style data already available (email, role, organization
name if any, use case, wallet address, DID (truncated, copyable), KYC status)
with a link to My Credentials. No editing this cycle.

## B. Invoice Register (API + web)

### Persistence — `StagedInvoice`
New model (Prisma `String` JSON columns per house style + memory repo):
`{ id, useCaseKey, source: "upload" | "erp" | "manual", metadata (JSON),
invoiceHash, documentId: string | null, documentSha256: string | null,
status: "staged" | "tokenized", assetId: string | null, createdBy,
createdAt, tokenizedAt: string | null }`.
Repository: `create`, `get`, `listByUseCase(key, status?)`, `findByHash(key,
hash)`, `markTokenized(id, assetId, at)`, `remove(id)`.

### Routes (all `...auth`, issue-capable role, use-case-scoped like the issue
route; 404 unknown use case; 400 `NOT_INVOICE_USECASE` when the use case has no
`invoiceFingerprint` derived field)
- `POST /use-cases/:key/invoices/import` — body `{ rows: Record<string,unknown>[] }`
  (the web parses CSV client-side, as today). Per row: `validateMetadata`
  against the use case's schema (minus derived fields) → compute
  `invoiceFingerprint` → duplicate if the hash exists in the REGISTER or among
  ASSETS (`assets.findByMetadata(key, uniqueBy, hash)`) → stage.
  Response: `{ staged: n, results: [{ index, status: "staged"|"duplicate"|"invalid",
  id?, error? }] }` — never all-or-nothing.
- `POST /use-cases/:key/invoices/pull-erp` — the demo ERP connector: reads the
  repo-bundled `samples/erp/invoices.csv` server-side (the same file
  `scripts/erp-import.mjs` defaults to; a small CSV row parser mirroring that
  script's column mapping), stages rows with `source: "erp"`, same per-row
  dedupe/validation. Response as above.
- `POST /use-cases/:key/invoices` — single manual invoice
  `{ metadata, documentId? }`; documentId resolved via `deps.documents.get`
  (server-side sha256, 400 `DOCUMENT_NOT_FOUND` on bad ref); same
  validate/fingerprint/dedupe; 409 `DUPLICATE_INVOICE` for a single-row dupe.
- `GET /use-cases/:key/invoices?status=` — the register, newest first.
- `DELETE /use-cases/:key/invoices/:id` — staged rows only; 409
  `ALREADY_TOKENIZED` otherwise.
- `POST /use-cases/:key/invoices/tokenize` — `{ ids: string[], chainId,
  treasuryAccount, parValue?: number (default 1000), sale?: { unitPrice,
  currency } }`. For each id, in order: skip non-staged (result "skipped");
  re-check the duplicate guard; issue via the EXISTING asset-issue path —
  extract the issue route's core (validate metadata → derive invoiceHash →
  unique guard → mint on-chain → persist asset + sale terms → audit) into a
  shared helper called by BOTH `POST /assets` and this endpoint, so the two
  paths cannot drift — with
  `name: "<invoiceNumber> · <buyerName>"`,
  `initialSupply = round(amount / parValue)` (mirroring today's Import),
  the record's metadata (server re-derives invoiceHash), the shared
  treasury/sale; on success `markTokenized` with the assetId. Response
  `{ results: [{ id, status: "tokenized"|"skipped"|"failed", assetId?, error? }] }`
  — failures leave rows staged.
  NOTE: if the existing issue flow is maker-checker-gated for the use case, the
  tokenize call surfaces the same 202-style behaviour per row; for the invoice
  use case today issuance is direct (201), which is the target path.

### Web — `InvoiceRegister.tsx` (replaces `InvoiceImport.tsx`)
The **Invoices** nav item renders the register:
- Table: checkbox, invoiceNumber, buyerName, amount, dueDate, source pill
  (upload/erp/manual), fingerprint (short), status pill (**staged** /
  **tokenized** linking to the asset), delete (staged only).
- Toolbar: **[Pull from ERP]** (one click → pull-erp), **[Upload CSV]** (file
  input → parse client-side, reusing InvoiceImport's CSV parsing → import),
  **[Add invoice]** (small form matching the invoice schema + optional PDF via
  the KYB-style upload pattern → single create), **[Tokenize selected (n)]** —
  opens a compact form: chain (deployed chains of the use case), treasury
  account (accounts select, as the Import tab had), par value (default 1000),
  optional sale terms; submits ids; per-row results shown inline.
- Import/pull results render as per-row notices (staged / duplicate / invalid),
  matching the existing Import tab's row-status idiom.

## Out of scope (explicit)
- Editing staged invoices (delete + re-add instead); profile editing; password
  change; real ERP connectivity (the pull is the bundled demo CSV); pagination
  of the register; mobile-first polish beyond the collapsible sidebar.

## Error handling
- Import/pull: per-row `invalid` (schema) / `duplicate` (register or assets);
  nothing all-or-nothing. Single add: 409 `DUPLICATE_INVOICE`, 400 schema /
  `DOCUMENT_NOT_FOUND`. Tokenize: per-row failures leave rows staged;
  `ALREADY_TOKENIZED` delete guard. Register routes 403 for non-issue-capable
  or out-of-scope callers (same guard as issuance).

## Testing
**API (vitest, new `invoice-register.test.ts`):**
1. Import: N rows → staged with fingerprints; a row duplicated WITHIN the batch
   and one already staged → "duplicate"; a schema-invalid row → "invalid";
   others stage fine.
2. pull-erp stages the sample rows (source "erp"); pulling twice → all
   duplicates the second time.
3. Single add with a document ref persists {documentId, sha256}; bad ref → 400;
   dupe → 409.
4. Tokenize selected: 2 of 3 staged ids → 2 assets exist (correct supply =
   amount/parValue, server-derived invoiceHash), rows tokenized+assetId, third
   stays staged; re-tokenizing a tokenized id → "skipped"; an invoice whose
   hash was tokenized out-of-band → "failed"/duplicate and stays staged.
5. Delete: staged OK; tokenized → 409. Scope: an Issuer of ANOTHER use case →
   403.
**Web:** tsc + build; browser walkthrough — every role sees the sidebar with
its items and bottom trio; renames visible (My Credentials, Asset Ledger,
Recent Transactions); Buyer portal driven from sidebar; full invoice flow:
Pull from ERP → register populated → select 2 → tokenize on besu →
status pills flip with asset links → Asset Ledger shows the new assets.
Suite + build green → merge via finishing-a-development-branch.
