# Canton / Daml (real) for TokenLayer

A production path for the `canton` chain: the [TokenLayer Daml model](daml/TokenLayer.daml)
holds each asset as one `Asset` contract (keyed by `(operator, assetId)`) enforcing the same
compliance-asset rules (fungible + NFT, allowlist + freeze), and
[`CantonJsonApiAdapter`](../../packages/adapters/src/canton/canton-adapter.ts) drives it over the
Daml ledger **JSON API** (no extra SDK dependency — plain HTTP + JWT).

> **Not exercised in this build environment** (no Daml SDK / JVM). This is runnable scaffolding:
> compile the DAR, run a Canton/Daml ledger + JSON API, set the env below, and the `canton`
> chain switches from the simulated adapter to the real one.

## 1. Build the DAR and start a ledger

```bash
cd infra/canton
daml build                       # produces .daml/dist/tokenlayer-0.1.0.dar

# Sandbox + JSON API (dev). For Canton proper, upload the DAR to your participant.
daml start                       # ledger on :6865, JSON API on :7575
```

## 2. Configure the platform

```bash
export CANTON_LEDGER_URL=http://localhost:7575
export CANTON_TOKEN=<JWT authorising the Operator party>
export CANTON_OPERATOR_PARTY=Operator::<namespace>
export CANTON_TEMPLATE_ID=<packageId>:TokenLayer:Asset
pnpm api:dev
```

When all four `CANTON_*` vars are set, `buildChainRegistry` uses the real
`CantonJsonApiAdapter`; otherwise it falls back to the in-memory simulated Canton adapter, so the
platform always runs.

## Operation mapping

| LedgerAdapter | Daml |
| ------------- | ---- |
| deployAsset   | `create Asset` |
| mint / transfer / burn | exercise `Mint` / `Transfer` / `Burn` (by key) |
| mintToken / transferToken / burnToken | exercise `MintToken` / `TransferToken` / `BurnToken` |
| setFrozen / setAllowed | exercise `SetFrozen` / `SetAllowed` |
| reads (balanceOf, ownerOf, …) | `/v1/query` the `Asset` payload |

Mutating choices are consuming and recreate the `Asset` with updated state; `exerciseByKey`
keeps the adapter free of contract-id bookkeeping.
