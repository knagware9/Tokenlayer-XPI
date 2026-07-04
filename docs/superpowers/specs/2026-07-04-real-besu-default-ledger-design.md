# Real Besu Ledger as the Default (No Silent Mock)

**Date:** 2026-07-04
**Status:** Approved

## Problem

TokenLayer's real EVM path (`EvmLedgerAdapter`, ethers v6) already works and is
verified, but the platform *defaults* to in-memory mock ledgers:

- `config/chains.json` marks `besu` and `mst` with `simulatedFallback: true`.
- `buildChainRegistry()` (`apps/api/src/chains.ts`) silently substitutes a
  `MockLedgerAdapter` for any EVM chain whose RPC env is unset.
- The default deploy (`make deploy`) does not set `BESU_RPC_URL`, so every
  issuance lands in memory unless the operator opts into the Besu overlay.

Result: the system looks "mock" even though the real adapter exists. This
change makes the real Besu network the default and removes every silent
mock path for EVM chains.

## Decisions (user-approved)

1. **Scope:** keep the external 5-node QBFT network from the
   `deposittokenization` project as the real chain; make it the default
   deploy path. (No self-contained network in this repo; no public testnet.)
2. **Fallback:** hard-fail — no simulated fallback for EVM chains, ever.
3. **Other chains:** keep fabric/canton as clearly-labeled simulated chains,
   keep `local-evm` for development, keep `mst` env-gated (absent when
   unconfigured, never mocked).
4. **Enforcement:** required-chain config + boot-time connectivity check.

## Design

### 1. Chain registry: required chains, no EVM fallback

- `config/chains.json`
  - `besu`: remove `simulatedFallback`, add `"required": true`.
  - `mst`: remove `simulatedFallback` (optional: absent when env unset).
  - `fabric` / `canton` / `local-evm`: unchanged.
- `buildChainRegistry()` semantics for `kind: "evm"` chains:
  - RPC + key env set → real `EvmLedgerAdapter`.
  - Env unset + `required: true` → **throw** (API refuses to start).
  - Env unset + optional → chain omitted from the registry.
  - There is no code path that returns a mock/simulated adapter for an EVM
    chain.
- **Boot connectivity check:** at startup, for every registered EVM chain the
  API calls `eth_chainId` and reads the operator's balance.
  - Required chain unreachable → abort startup with an actionable error
    naming the chain id, the env vars, the RPC URL tried, and a hint to run
    `make deploy` (which starts the network).
  - Success → log connected chainId, operator address, and balance.
- **Honest escape hatches** (neither ever simulates an EVM chain):
  - Tests: the registry builder accepts `enforceRequired: false` so API unit
    tests can boot without a live network (besu simply absent).
  - Local dev: `CHAIN_STRICT=0` skips required-chain enforcement with a loud
    startup warning; besu is *absent*, not simulated.

### 2. Defaults point at besu

- Seeded use cases (`config/use-cases/*.json`): every use case includes
  `besu` in `allowedChainIds` and sets `defaultChainId: "besu"`.
  - Seeding applies to fresh databases only; existing volumes keep their
    (possibly admin-edited) use cases. Documented, not migrated.
- The chains listing exposed to the web app gains a per-chain
  `mode: "real" | "simulated"` field.
- Web dashboard: chain dropdown and asset views badge chains — "On-chain"
  (real) vs "Simulated" — driven by `mode`, not by hardcoded chain ids.

### 3. Deploy pipeline flips

- `make deploy` = the Besu path (today's `deploy-besu`): start the 5-node
  QBFT network from `/Users/kamleshnagware/deposittokenization`, wait for the
  RPC, bring up the stack with `docker-compose.besu.yml`, then automatically
  run the on-chain smoke test (issue + auto-mint + buy; assert
  `eth_getCode(contractRef)` returns real bytecode).
- `make deploy-sim` = the previous simulated-only stack (kept for demos with
  `CHAIN_STRICT=0` so the API boots without besu).
- `scripts/deploy.sh` defaults to `--besu`; gains `--sim`.
- Docs: DEPLOY.md and README lead with the real-chain path;
  `apps/api/.env.example` documents local dev against the host-mapped RPC
  (`BESU_RPC_URL=http://localhost:8545`, funded dev operator key).

### 4. Testing (TDD)

- New registry unit tests:
  - required + missing env → throws with actionable message;
  - required + unreachable RPC → throws (boot check);
  - optional + missing env → chain absent;
  - no EVM chain ever resolves to a Mock/Simulated adapter;
  - `enforceRequired: false` and `CHAIN_STRICT=0` leave besu absent.
- Existing suites stay green: core, contracts, adapters parity suite, api
  (`pnpm -r test`, ~108 tests) and `pnpm -r typecheck`.
- End-to-end proof: `make deploy` finishes with the on-chain smoke test
  passing against the live QBFT network.

## Error handling

- Startup failures are fatal and specific (which chain, which env vars, which
  RPC URL, what to run). No degraded "half-mock" startup states.
- Runtime RPC errors surface through the existing engine/API error envelope
  unchanged; this design only moves *configuration* errors to boot time.

## Out of scope

- Real Fabric/Canton networks (adapters remain env-gated scaffolding).
- Public testnets, key management/HSM, gas strategy changes.
- Migrating `defaultChainId` inside existing SQLite volumes.
