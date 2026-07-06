# Use-Case-Owned Contracts (multi-chain)

**Date:** 2026-07-06
**Status:** Approved (multi-chain variant)
**Sub-project 2 of 2** (sub-project 1, real Fabric, is merged.)

## Problem / goal

Today a smart contract is deployed **per asset at issuance** — each issued asset
spins up its own contract (`engine.issue` → `adapter.deployAsset`), and a use
case is purely declarative metadata. The approved change:

- **A use case owns its contract(s)**, deployed **when the use case is
  configured**, on **each ledger it allows** (multi-chain: one contract per
  `allowedChainId`).
- **Issuing an asset then mints/registers within the chosen ledger's use-case
  contract** — assets share the use-case contract instead of each deploying one.

## Approved decisions

- Use case owns its contracts; deploy at config time.
- **Keep multi-chain:** retain `allowedChainIds`; deploy one contract per allowed
  ledger, stored as a `chainId → { contractRef, deployTxHash }` map. Issuance picks
  which allowed+deployed ledger.
- Built after real Fabric (done), covering EVM + Fabric + simulated.

## What an "asset" becomes (the core semantic shift)

- **Fungible (ERC-20 / ERC-3643):** the use-case contract on a given chain *is* the
  token. "Issuing an asset" = **minting a tranche** (an amount, to a treasury, with
  metadata) into that contract. Assets are issuance/tranche records sharing the
  contract; not independent tokens.
- **Non-fungible (ERC-721):** the use-case contract is the **collection**. Issuing
  = **minting a tokenId** into it. Each asset is a distinct tokenId.

## Design

### 1. UseCase model

- **Keep:** `allowedChainIds: string[]`, `defaultChainId: string`,
  `tokenStandard`, `tokenType`, `metadataSchema`, `lifecycle`, `compliance`, `roles`.
- **Add:** `symbol: string` (contracts need name+symbol; `name` → contract name).
- **Add:** `contracts: Record<string, { contractRef: string; deployTxHash: string }>`
  — the deployed contract per chainId (a chain is "deployed" iff it has an entry).
- Prisma `UseCase` gains `symbol` and `contracts` (JSON column, default `{}`).
- Config JSONs under `config/use-cases/*.json` gain `symbol` (keep allowedChainIds).

### 2. Config-time contract deployment (per allowed chain)

- `POST /use-cases` (create): after validation, for **each `allowedChainId` that is
  present in the chain registry**, deploy the use-case contract via
  `deployAsset({ id: key, name, symbol, useCaseKey: key, tokenType, tokenStandard,
  allowlistEnabled: compliance.allowlist, metadata: {} })` and record it in
  `contracts[chainId]`. Best-effort per chain:
  - A chain **absent** from the registry (e.g. besu under `CHAIN_STRICT=0`) is
    skipped (stays pending — no entry).
  - A chain present but whose deploy **fails** (unreachable/reverts) is skipped with
    a logged warning (stays pending).
  - **Require ≥1 successful deploy** (prefer `defaultChainId`); if none deployed, the
    create fails with an actionable error (nothing persisted).
- `POST /use-cases/:key/deploy` (new, admin): deploy the use-case contract on a
  specified **allowed, not-yet-deployed** chain (for chains that were absent/down at
  create time). Adds to `contracts[chainId]`. Fails if the chain is unreachable or
  already deployed.
- `PUT /use-cases/:key` (update): `tokenStandard` and `symbol` are **immutable** once
  any contract is deployed. `allowedChainIds` may **grow** (new chains start pending);
  a chain that already has a deployed contract may **not** be removed. `defaultChainId`
  must stay within `allowedChainIds`. Editable: `name` (display), `description`,
  `metadataSchema`, `lifecycle`, `compliance`, `roles`.

### 3. Issuance becomes minting

`engine.issue` no longer deploys. New flow:

1. Load the use case. `IssueInput` keeps `useCaseKey`, `id`, `chainId`, `metadata`,
   plus amount/treasury (fungible) or tokenId/treasury (NFT); **drops `symbol`**
   (inherited from the use case).
2. Require `chainId ∈ allowedChainIds` (else `CHAIN_NOT_ALLOWED`) **and**
   `contracts[chainId]` present (else `USE_CASE_NOT_DEPLOYED_ON_CHAIN`).
3. Validate metadata. Resolve the adapter for `chainId`; ref =
   `{ id, chainId, contractRef: contracts[chainId].contractRef }`.
4. Fungible → `adapter.mint(ref, treasury, amount)`. NFT → `adapter.mintToken(ref,
   treasury, tokenId, uri?)`.
5. Persist the Asset with `contractRef = contracts[chainId].contractRef`, `chainId`,
   tranche/tokenId details; write audit.

Existing lifecycle ops (mint/transfer/burn/freeze/allow/buy) already operate on an
`AssetContext` ref — unchanged in mechanism, now pointing at the shared use-case
contract. Marketplace/buy (transfer from treasury) unchanged.

### 4. Seeding & chain availability

- Seeded demo use cases (`config/use-cases/*.json`) keep `allowedChainIds`
  including **`fabric`** (always-available simulated ledger) plus besu/mst; at seed,
  the create deploys on whichever allowed chains are available (fabric always;
  besu/mst if their env is set). Pending chains can be deployed later via the deploy
  action.
- `seedUseCases` deploys only when creating a use case that doesn't exist (fresh DB);
  existing DBs untouched (idempotent). Never crashes boot on a deploy failure — logs
  and leaves the chain pending.

### 5. Web

- **UseCaseBuilder:** keep the multi-chain allowed-chains selector + default picker;
  **add a `symbol` field**. After save, show **per-chain deployment status** (deployed
  with a contract link via the existing `ExplorerLink`, or "pending" with a **Deploy**
  button calling the deploy action). Lock `tokenStandard`/`symbol` once deployed.
- **IssuePanel:** keep the chain picker but scope it to **deployed** chains
  (`allowedChainIds ∩ keys(contracts)`); **drop the symbol input** (inherited). Keep
  name/metadata/treasury/supply (fungible) or tokenId (NFT).
- **AssetDetail/AssetList:** asset chain + contract come from the chosen chain's
  use-case contract; explorer links already handle real chains.

### 6. Tests

- Core: `engine.issue` mints into the chosen chain's use-case contract (fungible +
  NFT); rejects issuance when that chain isn't deployed
  (`USE_CASE_NOT_DEPLOYED_ON_CHAIN`) or not allowed; validation requires `symbol`;
  immutability of `tokenStandard`/`symbol` after deploy; allowedChainIds grow-only for
  deployed chains.
- API: `POST /use-cases` deploys per available allowed chain (simulated chains in
  tests) and stores the `contracts` map; `POST /use-cases/:key/deploy` deploys a
  pending chain; issuance mints; marketplace/buy still passes.
- Web: typecheck + build.
- Full suite green (`pnpm -r test`) + typecheck.

## Migration

- `config/use-cases/*.json`: add `symbol` to each (carbon-credit → `VCU`,
  corporate-bond → `BOND`, gold-loan → `GLD`, generic-asset → `GEN`,
  generic-certificate → `CERT`); keep `allowedChainIds`/`defaultChainId`.
- Prisma migration: add `symbol` (string) + `contracts` (JSON, default `{}`) to
  `UseCase`. Existing SQLite demo volumes: documented as a fresh-DB change
  (single-node/demo; wipe or migrate).

## Error handling

- Config-time create with **no** deployable allowed chain → fails, nothing persisted.
- Per-chain deploy failure during create → that chain stays pending (logged), others
  proceed.
- Issuance on a not-deployed allowed chain → `USE_CASE_NOT_DEPLOYED_ON_CHAIN`;
  on a disallowed chain → `CHAIN_NOT_ALLOWED`.
- Editing a locked field / removing a deployed chain → clear 4xx.

## Out of scope

- Redeploying/upgrading an existing use-case contract; cross-use-case contract
  sharing; Canton; changing the adapter surface (`deployAsset`/`mint`/`mintToken`
  reused as-is).
