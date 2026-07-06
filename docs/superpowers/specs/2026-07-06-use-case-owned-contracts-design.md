# Use-Case-Owned Contracts

**Date:** 2026-07-06
**Status:** Draft — awaiting user review
**Sub-project 2 of 2** (sub-project 1, real Fabric, is merged.)

## Problem / goal

Today a smart contract is deployed **per asset at issuance** — each issued asset
spins up its own contract (`engine.issue` → `adapter.deployAsset`), and a use
case is purely declarative metadata. The approved change (from brainstorming):

- **A use case owns one contract**, deployed **when the use case is configured**
  (saved), on **one selected ledger**.
- **Issuing an asset then mints/registers within that contract** — assets share
  the use-case contract instead of each deploying their own.

## Approved decisions (from brainstorming)

- Use case owns one contract; deploy at config time.
- One selected ledger per use case (drops multi-chain `allowedChainIds`).
- Build after real Fabric (done), covering EVM + Fabric + simulated.

## What an "asset" becomes (the core semantic shift)

- **Fungible (ERC-20 / ERC-3643):** the use-case contract *is* the token (its
  name/symbol/supply). "Issuing an asset" = **minting a tranche** (an amount, to a
  treasury, with metadata) into that one contract. Assets are issuance/tranche
  records sharing the contract; they are not independent tokens.
- **Non-fungible (ERC-721):** the use-case contract is the **collection**. Issuing
  an asset = **minting a tokenId** into it. Each asset is a distinct tokenId in the
  shared collection.

This is the model the user approved ("assets become mints/token-ids rather than
separate contracts").

## Design

### 1. UseCase model

Replace the multi-chain fields with a single selected ledger, and add the
contract identity:

- **Remove:** `allowedChainIds: string[]`, `defaultChainId: string`.
- **Add:** `chainId: string` (the one selected ledger).
- **Add:** `symbol: string` (the token symbol — contracts need name+symbol; `name`
  already exists and becomes the contract name).
- **Add (nullable, set on deploy):** `contractRef: string | null`,
  `deployTxHash: string | null`.

`tokenStandard`, `tokenType`, `metadataSchema`, `lifecycle`, `compliance`, `roles`
unchanged. Prisma `UseCase` gains `chainId`, `symbol`, `contractRef`,
`deployTxHash`; drops `allowedChainIds`, `defaultChainId`. Config JSONs under
`config/use-cases/*.json` migrate to the new shape.

### 2. Config-time contract deployment

- `POST /use-cases` (create): after validation, resolve the adapter for `chainId`
  and call `deployAsset({ id: key, name, symbol, useCaseKey: key, tokenType,
  tokenStandard, allowlistEnabled: compliance.allowlist, metadata: {} })`. Store
  the returned `contractRef` + `deployTxHash` on the use case. **Synchronous** —
  if the chain is unreachable or the deploy reverts, the create **fails** with an
  actionable error (consistent with the boot-check fail-fast philosophy); no
  half-created use case is persisted.
- `PUT /use-cases/:key` (update): once `contractRef` is set, `chainId`,
  `tokenStandard`, and `symbol` are **immutable** (the contract exists on-chain).
  Editable: `name` (display only), `description`, `metadataSchema`, `lifecycle`,
  `compliance`, `roles`. Attempting to change a locked field → 4xx with a clear
  message.
- A use case with `contractRef === null` is "pending deployment" (see seeding).

### 3. Issuance becomes minting

`engine.issue` no longer deploys. New flow:

1. Load the use case; require `contractRef` set (else `USE_CASE_NOT_DEPLOYED`).
2. `IssueInput` drops `symbol` and `chainId` (inherited from the use case); keeps
   `useCaseKey`, `id`, `metadata`, plus issuance amount/treasury (fungible) or
   tokenId/treasury (NFT). Validate metadata.
3. Resolve the adapter for `useCase.chainId`; build the ref
   `{ id, chainId: useCase.chainId, contractRef: useCase.contractRef }`.
4. Fungible → `adapter.mint(ref, treasury, amount)`. NFT → `adapter.mintToken(ref,
   treasury, tokenId, uri?)`.
5. Persist the Asset with `contractRef = useCase.contractRef`,
   `chainId = useCase.chainId`, plus the tranche/tokenId details; write audit.

The existing lifecycle ops (mint/transfer/burn/freeze/allow/buy) already take an
`AssetContext` with a ref — they keep working, now all pointing at the shared
use-case contract. The marketplace/buy path (transfer from treasury) is unchanged
in mechanism.

### 4. Seeding & chain availability

Deploying at config time needs the chain reachable **at seed time**. The default
stack may have besu absent (`CHAIN_STRICT=0`). Resolution:

- Seeded demo use cases (`config/use-cases/*.json`) target **`chainId: "fabric"`**
  (the always-available simulated ledger), so they deploy cleanly at boot on every
  stack. Admins create real use cases on `besu`/`mst`/real-`fabric` when those are
  reachable.
- `seedUseCases` deploys the contract only when creating a use case that doesn't
  exist yet (fresh DB); existing DBs are untouched (idempotent). If a seeded
  chain is somehow unreachable, seeding logs a warning and leaves `contractRef`
  null (pending) rather than crashing boot.

### 5. Web

- **UseCaseBuilder:** add a `symbol` field and a **single** chain `<select>`
  (replaces the multi-chain checkboxes + default picker). After save, show the
  deployed `contractRef` (with an explorer link when the chain has `explorerUrl`,
  reusing the MST/EVM `ExplorerLink`). Locked fields become read-only once
  deployed.
- **IssuePanel:** drop the chain picker and the symbol input (both inherited from
  the use case); show the use case's chain + contract as read-only context. Keep
  name/metadata/treasury/supply (fungible) or tokenId (NFT).
- **AssetDetail / AssetList:** an asset's chain + contract now come from its use
  case; explorer links already handle real chains.

### 6. Tests

- Core: `engine.issue` mints into the use-case contract (fungible + NFT); rejects
  issuance when `contractRef` is null; use-case validation requires `chainId` +
  `symbol`; immutability of locked fields after deploy. Update the parity/adapter
  suites only where the issue→mint shift touches them.
- API: `POST /use-cases` deploys + stores contractRef (against a simulated chain
  in tests); issuance mints; the old `CHAIN_NOT_ALLOWED` test is replaced by the
  single-chain model; marketplace/buy still passes.
- Web: typecheck + build.
- Full suite green (`pnpm -r test`) + typecheck.

## Migration

- `config/use-cases/*.json`: rewrite each to `{ chainId, symbol, ... }` (drop
  `allowedChainIds`/`defaultChainId`). Pick sensible symbols (e.g. carbon-credit →
  `VCU`, corporate-bond → `BOND`, gold-loan → `GLD`, generic-asset → `GEN`,
  generic-certificate → `CERT`). `chainId: "fabric"` for all seeded demos.
- Prisma migration: add the 4 columns, drop the 2. Existing SQLite demo volumes:
  documented as a fresh-DB change (the deploy is single-node/demo; wipe or migrate).

## Error handling

- Config-time deploy failure → the create fails with the chain/adapter error,
  named and actionable; nothing persisted.
- Issuance before deployment → `USE_CASE_NOT_DEPLOYED`.
- Editing a locked field on a deployed use case → clear 4xx.

## Out of scope

- Redeploying / upgrading a use case's contract; multi-ledger use cases;
  cross-use-case contract sharing.
- Canton; changing the adapter surface (`deployAsset`/`mint`/`mintToken` are
  reused as-is).

## Open decisions for review

1. **Seeded demos on `fabric` (simulated)** so they always deploy at boot — OK, or
   should seeds target `besu` and simply be "pending" until besu is reachable?
2. **Fungible "asset" = mint tranche** within the one token (confirmed by the
   brainstorming choice, restated here because it changes the product materially).
3. **Immutability** of `chainId`/`tokenStandard`/`symbol` after deploy — reasonable,
   since the contract is live on-chain.
