# Hyperledger Fabric (real) for TokenLayer

A real ledger for the `fabric` chain: the [`tokenlayer` Go chaincode](chaincode/tokenlayer)
enforces the same compliance-asset rules (fungible + NFT, allowlist + freeze) as the EVM
contracts and the simulated ledger, and [`FabricLedgerAdapter`](../../packages/adapters/src/fabric/fabric-adapter.ts)
drives it through the `fabric-network` Gateway SDK.

The `fabric-network` SDK is a dependency of `@tokenlayer/adapters`. `fabric` runs **real** when
`FABRIC_CONNECTION_PROFILE` is set (and is probed at boot — a configured-but-down network fails
fast), and falls back to the in-memory **simulated** Fabric adapter otherwise, so the platform
always runs.

## One command: bring it up

```bash
make fabric-up      # test-network up + deploy the tokenlayer chaincode + emit wallet/profile
make fabric-down    # tear it down and remove infra/fabric/.runtime/
```

`fabric-up` uses the Fabric samples `test-network` (override its location with
`FABRIC_SAMPLES_DIR`, default `~/fabric-samples`), deploys the chaincode on channel `mychannel`,
then runs [`scripts/fabric-wallet.mjs`](scripts/fabric-wallet.mjs) to write an `appUser` wallet
identity + a copy of the connection profile under `infra/fabric/.runtime/` (gitignored). It prints
the `FABRIC_*` env to set.

> Needs Docker with enough memory for the peers/orderer (~2–3 GiB free in the Docker VM).

## Run the platform against it

```bash
# paste the FABRIC_* block that `make fabric-up` printed, then:
CHAIN_STRICT=0 pnpm api:dev
```

At boot the API logs `fabric` as connected (real) via a chaincode `TotalSupply` health probe, and
`GET /chains` reports `fabric` with `mode: "real"`. Issuing on `fabric` invokes the chaincode.

Manual equivalent of `fabric-up` (for reference):

```bash
cd $FABRIC_SAMPLES_DIR/test-network
./network.sh up createChannel -c mychannel
./network.sh deployCC -c mychannel -ccn tokenlayer \
  -ccp /path/to/TokenLayer/infra/fabric/chaincode/tokenlayer -ccl go
node /path/to/TokenLayer/infra/fabric/scripts/fabric-wallet.mjs
```

## Operation mapping

| LedgerAdapter | Chaincode tx |
| ------------- | ------------ |
| deployAsset   | `DeployAsset(ref, tokenType, allowlistEnabled)` |
| mint / transfer / burn | `Mint` / `Transfer` / `Burn` |
| mintToken / transferToken / burnToken | `MintToken` / `TransferToken` / `BurnToken` |
| setFrozen / setAllowed | `SetFrozen` / `SetAllowed` |
| balanceOf / totalSupply / ownerOf / tokensOf | `BalanceOf` / `TotalSupply` / `OwnerOf` / `TokensOf` |
| isFrozen / isAllowed | `IsFrozen` / `IsAllowed` |
