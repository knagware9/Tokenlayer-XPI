# Hyperledger Fabric (real) for TokenLayer

A production path for the `fabric` chain: the [`tokenlayer` Go chaincode](chaincode/tokenlayer)
enforces the same compliance-asset rules (fungible + NFT, allowlist + freeze) as the EVM
contracts and the simulated ledger, and [`FabricLedgerAdapter`](../../packages/adapters/src/fabric/fabric-adapter.ts)
drives it through the `fabric-network` Gateway SDK.

> **Not exercised in this build environment** (no Docker daemon / Fabric binaries). This is
> runnable scaffolding: stand up a Fabric network, deploy the chaincode, install the SDK, set
> the env below, and the `fabric` chain switches from the simulated adapter to the real one.

## 1. Bring up a network and deploy the chaincode

Using the Fabric samples `test-network`:

```bash
# in fabric-samples/test-network
./network.sh up createChannel -c mychannel -ca
./network.sh deployCC -c mychannel \
  -ccn tokenlayer \
  -ccp /path/to/TokenLayer/infra/fabric/chaincode/tokenlayer \
  -ccl go
```

This produces a connection profile and an admin identity you import into a wallet.

## 2. Install the SDK and configure the platform

```bash
pnpm --filter @tokenlayer/adapters add fabric-network

export FABRIC_CONNECTION_PROFILE=/path/to/connection-org1.json
export FABRIC_WALLET=/path/to/wallet
export FABRIC_IDENTITY=appUser
export FABRIC_CHANNEL=mychannel
export FABRIC_CHAINCODE=tokenlayer
pnpm api:dev
```

When `FABRIC_CONNECTION_PROFILE` is set, `buildChainRegistry` uses the real
`FabricLedgerAdapter`; otherwise it falls back to the in-memory simulated Fabric adapter, so the
platform always runs.

## Operation mapping

| LedgerAdapter | Chaincode tx |
| ------------- | ------------ |
| deployAsset   | `DeployAsset(ref, tokenType, allowlistEnabled)` |
| mint / transfer / burn | `Mint` / `Transfer` / `Burn` |
| mintToken / transferToken / burnToken | `MintToken` / `TransferToken` / `BurnToken` |
| setFrozen / setAllowed | `SetFrozen` / `SetAllowed` |
| balanceOf / totalSupply / ownerOf / tokensOf | `BalanceOf` / `TotalSupply` / `OwnerOf` / `TokensOf` |
| isFrozen / isAllowed | `IsFrozen` / `IsAllowed` |
