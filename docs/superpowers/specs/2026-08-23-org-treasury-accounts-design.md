# Org-owned treasury accounts — design

**Status:** approved 2026-08-23
**Theme:** a treasury is an organization's account, not a string someone typed in.

## Why

`Asset.treasuryAccount` is free text. An Issuer types an address into the
issuance form; the platform stores it and mints there. Nothing links that
address to an `Account` row, a `User`, or an `Organization` — the same
architecture whether the address is a real corporate treasury or a typo.

This showed up as a direct question: *who owns this treasury?* There is no
answer today. Contrast with a holder's own wallet (the recent
`resolveAccountId`/`PATCH /me/wallet` work), which is now a real,
queryable link back to a `User`. A treasury has no equivalent — it is
structurally invisible to `scopedAccounts()` (`GET /accounts`), which only
ever surfaces accounts a *user* is linked to.

The real-world shape this is missing: an issuing organization's treasury
belongs to the organization, not to whichever staff member happened to
type an address into a form. Officers with Issuer rights operate it; the
organization owns it. `UseCase.ownerOrgId` already exists — it is just not
connected to `treasuryAccount` at all.

## Goals

- Every use case has a registered, org-owned treasury account —
  `UseCase.treasuryAccountId → Account`, `Account.ownerOrgId → Organization`.
  "Who owns this treasury" becomes a stored fact, not a convention.
- Every use case has an owning organization. The "platform-owned, no org"
  case (`UseCase.ownerOrgId: null`) is retired — the seven platform-seeded
  use cases (`config/use-cases/*.json`) are owned by the existing
  "TokenLayer Platform" org, the same org identity issuance already falls
  back to when a credential use case has no owner.
- Provisioning is automatic, not a manual step: a treasury is created the
  moment a use case is, for both org self-service creation and
  platform-seeded boot creation. No new "register a treasury" endpoint —
  issuance is never blocked waiting on one.
- `treasuryAccount` disappears from every client-facing write that
  currently accepts it as input (`POST /assets`, its nested `sale.treasuryAccount`,
  the `setPrice` action, and `POST /use-cases/:key/invoices/tokenize`).
  Each derives the address from the use case's own registered treasury
  instead. Wrong-treasury becomes structurally impossible rather than a
  validation rule someone could still get past.

## Non-goals

- Multiple treasuries per use case (e.g. one per settlement currency).
  One use case, one treasury — matching the auto-provisioning model. A
  future need for more than one is a separate design.
- Any change to already-issued assets. `Asset.treasuryAccount` is stored
  per-asset at issuance time and never re-read from the use case
  afterward — existing assets, their sale terms, and every buy/sell path
  against them are untouched by this change.
- Real key custody for treasury accounts. `Account.address` stays what it
  already is — an opaque bookkeeping string the operator key mints and
  transfers against, never a keypair the platform holds. Same model the
  wallet-auto-assignment work established; this only adds an owner.
- Changing who may create or administer organizations, or the org
  capability envelope. Provisioning a treasury is a side effect of use-case
  creation, not a new permission surface.

## Design

### 1. Schema

```prisma
model Account {
  id          String  @id @default(cuid())
  address     String  @unique
  label       String
  ownerOrgId  String? // NEW. null for a personal wallet; set for a treasury.
}

model UseCase {
  ...
  ownerOrgId        String  // CHANGED from String? — every use case has an owner now
  treasuryAccountId String? // NEW — this use case's registered treasury
}
```

`Account.ownerOrgId` stays nullable: a Buyer/Trader/Issuer's own wallet
(`resolveAccountId`, `PATCH /me/wallet`) has no org owner, only a treasury
does. The two concepts share one table because they are both "an address
with a label" — only the owner differs.

`packages/core/src/shared/types.ts`'s `UseCaseDefinition.ownerOrgId` (line
168, currently `ownerOrgId?: string`) becomes `ownerOrgId: string`, and
gains `treasuryAccountId?: string`. `UseCaseRepository.create`/`update`
already take a full `UseCaseDefinition`, so no repository interface change
is needed beyond the two persistence layers (Prisma + memory) carrying the
new fields, per the PARITY RULE.

### 2. Provisioning — where a treasury comes from

One new helper, alongside `resolveAccountId` in
`apps/api/src/shared/wallets.ts` (or a sibling file if that one is judged
to have grown unfocused by then — the writing-plans pass decides):

```ts
export async function provisionTreasury(
  deps: Pick<AppDeps, "accounts">, ownerOrgId: string, label: string,
): Promise<string> {
  const address = "0x" + randomBytes(20).toString("hex");
  const account = await deps.accounts.upsert(address, label, ownerOrgId);
  return account.id;
}
```

`AccountRepository.upsert(address, label)` gains a third, optional
parameter, `ownerOrgId?: string` — a personal wallet (`resolveAccountId`)
keeps calling it two-argument and gets `ownerOrgId: null`, exactly like
`findByAddress` and every other `AccountRepository` method already added
this session. Same shape of change as those, just one more parameter.

Two call sites create use cases, and both provision a treasury as part of
creation:

- **Org self-service** (`POST /use-cases`, `apps/api/src/http/routes/tokenization.ts:99`
  area) — already stamps `ownerOrgId: claims.orgId`. It now also calls
  `provisionTreasury` and sets `treasuryAccountId` on the same definition
  before persisting.
- **Platform-seeded boot creation** (`seedUseCases`,
  `apps/api/src/tokenization/use-cases.ts`, called from `server.ts:112`) —
  boot order changes so `ensurePlatformIssuerOrg` (already exists,
  `apps/api/src/shared/platform-org.ts:54`, idempotent) runs *before*
  `seedUseCases`, and the resolved org id plus a provisioned treasury are
  stamped onto every use case `seedUseCases` creates from
  `config/use-cases/*.json`.

### 3. Issuance-time resolution

`issueAssetCore` (`apps/api/src/http/routes/tokenization.ts:254`) is the
single function both `POST /assets` and the batch-tokenize route
(`POST /use-cases/:key/invoices/tokenize`, which calls it internally at
line 563) already funnel through — so the derivation logic lives in
exactly one place. It stops accepting `treasuryAccount`/
`sale.treasuryAccount` as input; instead it loads
`useCase.treasuryAccountId`, resolves the `Account.address`, and uses
that. `MISSING_TREASURY` (currently returned when initial supply is
requested with no treasury) becomes unreachable for any use case created
after this ships — reachable only for one that predates it and has not
been backfilled (closed by the migration below).

The `setPrice` branch of the asset-actions route (~line 790) drops its
`treasuryAccount` body field and its `VALIDATION_ERROR` check for it,
deriving the address the same way as `issueAssetCore`.

`treasuryAccount` is dropped from every request body that currently
carries it in `apps/api/src/http/schemas/tokenization.ts`: the create-asset
schema (including its nested `sale.treasuryAccount`, ~line 109/118), the
asset-actions schema's `setPrice` branch (~line 213), and
`tokenizeInvoices` (~line 577/581). The OpenAPI snapshot is regenerated as
part of the plan's verification, same as every schema change this
session.

### 4. Migration for existing use cases

Two idempotent backfills, mirroring `apps/api/scripts/backfill-wallets.ts`'s
shape (a testable core function in `src/shared/`, a thin script wrapper
under `apps/api/scripts/`, run once against each live database):

1. Every `UseCase` with `ownerOrgId: null` is stamped to the Platform
   org's id (`ensurePlatformIssuerOrg` resolves it, idempotently — no new
   org is created if the backfill runs more than once).
2. Every `UseCase` with `treasuryAccountId: null` gets a treasury
   provisioned and linked, exactly as a freshly-created one would.

Order matters: (1) before (2), since provisioning needs an owning org to
stamp the treasury's `ownerOrgId` with.

### 5. Testing

- Unit tests for `provisionTreasury`, mirroring `wallets.test.ts`'s shape
  for `resolveAccountId`.
- Route tests confirming `POST /assets`, the `setPrice` action, and
  `POST /use-cases/:key/invoices/tokenize` no longer accept
  `treasuryAccount` as input and still issue/reprice correctly using the
  use case's registered treasury.
- A boot-sequencing test confirming every platform-seeded use case lands
  with the Platform org as `ownerOrgId` and a non-null
  `treasuryAccountId`.
- The backfill's own idempotency test (second run touches nothing),
  matching `backfillWallets`'s existing test pattern.
- `persistence-parity.test.ts` must stay green with the two new fields
  present across schema, type, and both repositories.

## Risk

Low-to-medium. The two schema changes are additive-in-shape (a new
nullable column on `Account`, a new nullable column plus a widened
existing one on `UseCase`) but the `UseCase.ownerOrgId` widening from
optional to required is a real behavioral tightening: any code path that
still constructs a `UseCaseDefinition` without an `ownerOrgId` (dev
scripts under `apps/api/src/dev/`, `seedUseCases` callers in
`e2e-buy.ts`/`e2e-carbon.ts`/`e2e-tenancy.ts`) needs updating alongside
the two production call sites, or it fails to compile — which is the
point: a use case genuinely cannot exist without an owner after this
ships. The plan's file survey should grep every `seedUseCases` and
direct `useCases.create` call site before writing tasks, not assume the
two documented in this design are the only ones.
