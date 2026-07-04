# Real Hyperledger Fabric Ledger

**Date:** 2026-07-04
**Status:** Approved
**Sub-project 1 of 2** (the second, "use-case-owned contracts," is a separate spec.)

## Problem

`fabric` is one of the platform's chains, but only as an in-memory **simulated**
adapter. The real path exists in code — `FabricGatewayAdapter` (the
`fabric-network` Node SDK) in `packages/adapters/src/fabric/fabric-adapter.ts`,
and the `tokenlayer` Go chaincode in `infra/fabric/chaincode/tokenlayer/` — but
there is no runnable network, so the `fabric` chain never actually runs real.
This makes Fabric a genuinely real ledger alongside the EVM chains (Besu, MST):
issuing on `fabric` invokes the chaincode on a running Fabric network.

## Decisions (user-approved)

- **Self-contained real network** using the local `~/fabric-samples/test-network`
  (Fabric 2.5 images + `bin/` binaries confirmed present; crypto material already
  generated). Not a bring-your-own-network approach.
- Fabric stays **optional** (simulated when unconfigured — unchanged, non-breaking);
  it is **not** `required` like `besu`.
- Sequenced **first**; the use-case-owned-contract model change is sub-project 2.

## Confirmed environment facts

- `~/fabric-samples/bin/` has `peer` (v2.5.15), `configtxgen`, `cryptogen`, etc.
- `~/fabric-samples/test-network/network.sh` present; Org1 connection profile
  `organizations/peerOrganizations/org1.example.com/connection-org1.json` exists.
- `hyperledger/fabric-peer:2.5` + `fabric-orderer:2.5` images pulled.
- **Gap:** `fabric-network` is dynamically `import()`-ed by the adapter but is **not**
  a dependency of `@tokenlayer/adapters` and is not installed.

## Design

### 1. Add the `fabric-network` SDK dependency

- Add `fabric-network@^2.2` to `packages/adapters/package.json` `dependencies`
  (the last 2.x line; compatible with Fabric 2.5 peers via connection-profile +
  service discovery). Install so the adapter's dynamic `import("fabric-network")`
  resolves. Keep it a normal dependency (the dynamic import already tolerates its
  absence at build time, but a real run needs it installed).

### 2. Network bring-up / teardown scripts (`infra/fabric/`)

- `infra/fabric/fabric-up.sh`: drives `~/fabric-samples/test-network` (path
  overridable via `FABRIC_SAMPLES_DIR`, default `~/fabric-samples`):
  1. `./network.sh up createChannel -c mychannel`
  2. `./network.sh deployCC -c mychannel -ccn tokenlayer -ccp <repo>/infra/fabric/chaincode/tokenlayer -ccl go`
  3. Invoke `scripts/fabric-wallet.mjs` (below) to emit the connection profile +
     wallet into `infra/fabric/.runtime/` (gitignored).
  4. Print the `FABRIC_*` env block to set.
- `infra/fabric/fabric-down.sh`: `./network.sh down` (tears down containers +
  crypto), and removes `infra/fabric/.runtime/`.
- Idempotent + fail-fast (`set -euo pipefail`); verify `peer` is reachable on
  `$FABRIC_SAMPLES_DIR/bin` and error with an actionable message if not.

### 3. Wallet + connection profile (`infra/fabric/scripts/fabric-wallet.mjs`)

- A small Node ESM script (run with the repo's toolchain) that:
  1. Reads the Org1 **admin** X.509 cert + private key from the test-network
     crypto material (`.../users/Admin@org1.example.com/msp/{signcerts,keystore}`).
  2. Writes a filesystem wallet at `infra/fabric/.runtime/wallet` containing an
     `appUser` identity (X.509, mspId `Org1MSP`) — the format `fabric-network`'s
     `Wallets.newFileSystemWallet` expects.
  3. Copies `connection-org1.json` to `infra/fabric/.runtime/connection-org1.json`.
- No CA enrollment needed — the test-network's admin identity is imported directly.

### 4. Chain descriptor relabel

- `config/chains.json`: change the `fabric` entry `label` from
  `"Hyperledger Fabric (simulated)"` to `"Hyperledger Fabric"`. The `mode`
  (real/simulated) is computed at runtime by the registry, so the label must not
  hardcode "simulated". (Canton's label is out of scope — unchanged.)

### 5. Fabric boot connectivity check

- Add `healthCheck(): Promise<{ chainId: string; operator: string; balance: string }>`
  to `FabricGatewayAdapter`: connect the gateway, evaluate a cheap read (e.g.
  `IsAllowed` on a throwaway ref, which returns a boolean without mutating state)
  to prove the channel + chaincode respond; return `{ chainId, operator: mspId+identity, balance: "n/a" }`
  to fit the existing shape.
- `apps/api/src/chains.ts` `assertConnectivity`: today it probes only EVM
  adapters. Extend it to also probe a **configured-real** Fabric adapter (i.e.
  when `makeSimulatedOrReal` returned `real: true`). A real-but-unreachable
  Fabric throws at boot with an actionable message (does not silently degrade).
  Simulated Fabric is never probed.
  - Mechanism: `buildChainRegistry` collects real non-EVM adapters that expose a
    `healthCheck` into the same connectivity sweep (structural check for a
    `healthCheck` method), keeping EVM behavior byte-identical.

### 6. Make targets, env, docs

- `Makefile`: `fabric-up` (→ `infra/fabric/fabric-up.sh`) and `fabric-down`
  (→ `infra/fabric/fabric-down.sh`), mirroring `besu-up`/`besu-down`.
- `.gitignore`: ignore `infra/fabric/.runtime/`.
- `apps/api/.env.example`: document `FABRIC_CONNECTION_PROFILE`,
  `FABRIC_WALLET`, `FABRIC_IDENTITY`, `FABRIC_CHANNEL`, `FABRIC_CHAINCODE`
  pointing at the `.runtime/` outputs, with a "run `make fabric-up` first" note.
- `infra/fabric/README.md`: replace manual steps with the scripted flow.
- `DEPLOY.md`: a "Run on real Hyperledger Fabric" section.

### 7. Tests

- Unit (network-free): `apps/api/test/chains.test.ts` — a configured-real Fabric
  (env set, but the connectivity sweep only runs under `assertConnectivity`)
  surfaces `mode: "real"` and is included in the connectivity sweep; simulated
  Fabric (no env) stays `mode: "simulated"` and is not probed. Assert the sweep
  selects adapters by presence of `healthCheck`.
- Existing suites stay green (`pnpm -r test`, 161) and typecheck clean.
- The real chaincode round-trip is proven by the live verification below, not by
  a unit test (no Fabric network in CI).

## Verification (real, not mock)

1. `make fabric-up` — network up, `tokenlayer` chaincode committed on `mychannel`,
   wallet + connection profile emitted.
2. Boot the API with the emitted `FABRIC_*` env (`CHAIN_STRICT=0`, besu absent);
   confirm the boot log shows `fabric` connected via the new health check and
   `list()` reports `fabric` `mode: "real"`.
3. Issue an asset on `fabric` through the REST API → `contractRef` like
   `fabric:<id>` and a chaincode tx.
4. **Independent proof:** `peer chaincode query -C mychannel -n tokenlayer -c
   '{"Args":["TotalSupply","<ref>"]}'` (via `~/fabric-samples/bin` with the
   test-network env) returns the on-ledger state written by the issuance —
   confirming the write hit the real chaincode, not the in-memory simulator.

## Error handling

- Bring-up scripts fail fast with actionable messages (missing binaries, network
  not up, chaincode deploy failure).
- A configured-real Fabric that is unreachable aborts API startup (same
  philosophy as the EVM chains), naming the env vars to fix.
- Simulated Fabric (unconfigured) behaves exactly as today.

## Out of scope

- Use-case-owned contracts / deploy-at-config (sub-project 2).
- Canton; multi-org Fabric; Fabric CA enrollment flows; production HSM/identity.
- Switching the adapter from `fabric-network` to `@hyperledger/fabric-gateway`.
