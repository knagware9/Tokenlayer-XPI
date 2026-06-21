# Hyperledger Besu (real EVM) for TokenLayer

Besu is EVM-compatible, so TokenLayer's `EvmLedgerAdapter` drives it through the **same** code
path as `local-evm` — including deploying real ERC-20 / ERC-721 contracts and the full T-REX
(ERC-3643) suite. The only difference is configuration: the `besu` chain uses `gas: "zero"`
(free-gas dev/IBFT) and is enabled when `BESU_RPC_URL` is set.

## Run a local Besu dev network

> Requires Docker (the daemon must be running).

```bash
docker compose -f infra/besu/docker-compose.yml up
```

This starts a single-node Besu **dev** network (instant finality, free gas) with the RPC on
`http://127.0.0.1:8550`. The dev network pre-funds Besu's well-known dev account.

## Point TokenLayer at it

```bash
BESU_RPC_URL=http://127.0.0.1:8550 \
BESU_OPERATOR_KEY=0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63 \
pnpm api:dev
```

`Hyperledger Besu` now appears in the dashboard's chain picker. Any use case whose
`allowedChainIds` includes `besu` can issue and operate assets there.

## Production / other networks (MST, public testnets)

Besu, MST, and any EVM network are configured the same way — set the chain's `*_RPC_URL` and a
funded `*_OPERATOR_KEY`:

| Chain | RPC env | Key env | Gas mode (`config/chains.json`) |
| ----- | ------- | ------- | ------------------------------- |
| besu  | `BESU_RPC_URL` | `BESU_OPERATOR_KEY` | `zero` (free-gas IBFT/dev) |
| mst   | `MST_RPC_URL`  | `MST_OPERATOR_KEY`  | `auto` (EIP-1559/legacy), 2 confirmations |

For a permissioned **IBFT 2.0 / QBFT** Besu network with your own validators and genesis,
replace `--network=dev` with `--genesis-file` + validator config and keep `gas: "zero"`; the
adapter needs no changes.

> Note: this network was **not** started in the build environment (no Docker daemon available);
> the adapter logic is verified against the local Hardhat EVM, which is byte-for-byte the same
> EVM execution the contracts run on Besu.
