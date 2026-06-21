# TokenLayer — Real T-REX, Real EVM (Besu/MST), Real Fabric/Canton

## Context

The platform supports multi-DLT and multi-standard tokenization via simplified, simulated
implementations. This iteration replaces the simplifications with production-grade
integrations, in three workstreams of differing verifiability **in this environment** (Docker
daemon down; no Java/Daml SDK):

- **T-REX ERC-3643** — built + verified here (pure Solidity + Hardhat).
- **Real EVM (Besu/MST)** — adapter logic verified against a local EVM proxy; real node/testnet
  needs infra/keys the sandbox lacks.
- **Real Fabric/Canton** — production scaffolding, NOT verifiable here (needs Docker/Daml/JVM).

Scope decisions (confirmed): vendor official Tokeny T-REX + ONCHAINID; target local Besu (Docker
IBFT) + treat MST/Besu as generic configurable EVM; build both Fabric and Canton real adapters
now as labeled production scaffolding with graceful fallback to the existing simulated adapters.

## Workstream 1 — Full T-REX ERC-3643 (verified)

Vendor `@tokenysolutions/t-rex` + `@onchain-id/solidity`. Stand up the real suite:

- **Identity:** ClaimTopicsRegistry, TrustedIssuersRegistry, IdentityRegistryStorage,
  IdentityRegistry; per-investor ONCHAINID identities; a trusted KYC-claim issuer + claim topic.
- **Compliance:** ModularCompliance + ≥1 real module (e.g. max-holders or country-restrict).
- **Token:** T-REX `Token`, agent-operated (mint / forcedTransfer / burn / setAddressFrozen).
- **Deployment:** a `TrexDeployer` (Hardhat + a runtime helper) that stands up the full stack
  with the platform operator as agent/owner and returns the Token address as `contractRef`.
- **Adapter integration:** the EVM adapter deploys the real T-REX stack for ERC-3643 assets and
  maps engine ops:
  - `setAllowed(acct,true)` → deploy/register the account's ONCHAINID in IdentityRegistry +
    issue a KYC claim; `false` → remove from registry.
  - `isAllowed` → `IdentityRegistry.isVerified(acct)`.
  - `mint` → `token.mint`; `transfer(from,to)` → `token.forcedTransfer`; `burn` → `token.burn`.
  - `setFrozen`/`isFrozen` → `token.setAddressFrozen` / `token.isFrozen`.
  - `balanceOf`/`totalSupply` → token views.
  - T-REX assets are detected via the on-chain `identityRegistry()` view (no fragile state).
- **Hardhat tests:** unregistered holder rejected; identity-gated transfer; a compliance module
  enforced; freeze blocks transfer; recovery forcedTransfer.
- Simulated chains keep the simplified ERC-3643 (mandatory allowlist) as a faithful stand-in.
- **Risk:** official T-REX may hit solc/OZ version friction. Pin to T-REX's peer versions; if
  intractable after reasonable effort, fall back to a faithful in-repo suite and surface the
  switch (do not silently change).

## Workstream 2 — Real EVM: Besu + MST (logic verified vs local EVM proxy)

- Harden `EvmLedgerAdapter`: EIP-1559 gas with legacy/`gasPrice:0` fallback (Besu IBFT
  free-gas), configurable confirmations, RPC timeout/retry, chainId awareness — from per-chain
  config in `config/chains.json` (`gas`, `confirmations`).
- `infra/besu/`: Docker IBFT 2.0 dev-network compose + genesis pre-funding the operator + run
  scripts. (Run `docker compose up`; adapter logic verified against the Hardhat proxy here.)
- MST/generic: env-configured EVM RPC endpoints; document supplying RPC + funded key.

## Workstream 3 — Real Fabric + Canton (production scaffolding; unverified here)

- **Fabric:** `infra/fabric/` Go chaincode for the compliance asset (fungible + NFT,
  allowlist/freeze) + `FabricLedgerAdapter` (`fabric-network` gateway SDK: connection profile +
  wallet) + scripts to deploy onto `test-network`.
- **Canton:** `infra/canton/` Daml templates (Asset/Holding/compliance) + `CantonLedgerAdapter`
  over the Daml ledger JSON/gRPC API + scripts to start the sandbox + upload the DAR.
- **Fallback:** the chain registry uses the real adapter for `fabric`/`canton` when its
  connection env is set (`FABRIC_CONNECTION_PROFILE`, `CANTON_LEDGER_URL`), otherwise the
  existing simulated one — platform stays runnable, upgrades by config.

## Build order

1. T-REX contracts + deployment + Hardhat tests (verify).
2. T-REX adapter integration + API/dashboard surfacing of identity registration.
3. EVM hardening + Besu compose.
4. Fabric chaincode + adapter + scripts.
5. Canton Daml + adapter + scripts.
6. Update demo + README; full test / typecheck / build.

## Verification

- `pnpm -r test` incl. new T-REX Hardhat tests + EVM-hardening unit tests (against Hardhat).
- `pnpm -r typecheck`, `pnpm build`.
- `pnpm --filter @tokenlayer/api demo` with `EVM_RPC_URL` set issues a real T-REX ERC-3643 asset
  and runs identity-gated lifecycle on the local EVM.
- Fabric/Canton: provide scripts + a documented manual run procedure; mark explicitly as
  not executed in this session.

## Out of scope

Running Fabric/Canton/real testnets in this session; cross-chain identity portability; on-chain
claim revocation beyond trusted-issuer basics.
