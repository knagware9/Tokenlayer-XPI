# Deploying TokenLayer (Docker, self-host)

The whole stack — API and web dashboard — runs from `docker-compose.yml`.

## One-command deploy (automated)

```bash
make deploy         # REAL Besu (default): starts the 5-node QBFT network, deploys on-chain, runs the smoke test
make deploy-sim     # simulated ledgers only (no external chain)
make verify         # re-run the on-chain smoke test
make help           # list all targets (status, logs, down, rebuild, …)
```

`scripts/deploy.sh` is idempotent: it generates a `JWT_SECRET` if missing,
defaults to the real Besu path (starts and waits for the 5-node Besu network,
builds + starts the stack with the besu overlay, and runs the on-chain smoke
test), and blocks until the API and web are healthy. Pass `--sim` for the
simulated-only stack. Run it directly as `./scripts/deploy.sh [--sim]` if you
prefer not to use `make`.

## Quick start (manual)

```bash
cp .env.example .env
# set a strong secret:
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env   # or edit .env by hand

docker compose up --build -d
```

- **Web dashboard:** http://localhost:8080
- **API:** http://localhost:4000 (Swagger UI at `/docs` is exposed only when `NODE_ENV` is not `production`; the container runs in production mode, so `/docs` is disabled there by design)

Sign in with a seeded demo account, e.g. `carbon.admin@tokenlayer.dev` / `carbon123`
(see `apps/api/src/seed.ts` for the full roster).

## What the images do

| Image | Base | Contents |
|-------|------|----------|
| `api` | `node:20-slim` | Installs only `@tokenlayer/api` + its workspace deps (`core`, `adapters`) via a filtered pnpm install, generates the Prisma client, then on start runs `prisma db push` → seed → `tsx src/server.ts`. |
| `web` | build on `node:20-slim`, served by `nginx:alpine` | `vite build` with `VITE_API_URL` baked in, static output served by nginx with SPA fallback. |

The API uses **SQLite** on a named volume (`api-data` → `/data/dev.db`), so data
survives restarts. This is fine for demos/single-node self-host; for a clustered
or high-availability deployment, point `DATABASE_URL` at a networked database and
swap the Prisma datasource provider.

## Configuration (`.env`)

| Var | Default | Purpose |
|-----|---------|---------|
| `JWT_SECRET` | — (required) | Signs auth tokens. Must be ≥16 chars and not the dev default. |
| `CORS_ORIGINS` | `http://localhost:8080` | Comma-separated origins allowed to call the API. |
| `VITE_API_URL` | `http://localhost:4000` | API origin baked into the web bundle (the browser must be able to reach it). |
| `WEB_PORT` | `8080` | Host port for the dashboard. |
| `API_PORT` | `4000` | Host port for the API. |
| `CHAIN_STRICT` | `1` | `0` boots the API without required chains (they become absent — never simulated). Set automatically by `make deploy-sim`. |

> If you deploy behind real hostnames, set `VITE_API_URL` to the public API URL and
> add the web origin to `CORS_ORIGINS`, then rebuild the web image (`VITE_API_URL`
> is compiled in at build time).

## Run on the real 5-node Hyperledger Besu (QBFT) network — the default

`make deploy` runs this path automatically. The `besu` chain is **required and always
real**: the API refuses to start if it can't reach the Besu RPC. The simulated-only
stack (`make deploy-sim`) boots with `CHAIN_STRICT=0`, which leaves besu **absent
(never silently simulated)**, while `fabric`/`canton` remain available as clearly-labeled
simulated chains. The steps below are what `make deploy` performs — run them manually for
reference. The Besu overlay points the API at the **in-repo 5-node QBFT network**
(`infra/besu-network/` + `docker-compose.besu-nodes.yml`), so the `besu` chain deploys real
`ComplianceToken` / `ComplianceNFT` / T-REX contracts on-chain.

**1. Start the 5-node network** (genesis, validator keys, and static peers are vendored in-repo):

```bash
make besu-up          # docker compose -f docker-compose.besu-nodes.yml up -d
# external checkout instead: BESU_PROJECT_DIR=/path/to/checkout make besu-up
```

This creates the docker network `besu-network` (chainId 1337, QBFT, 5 validators, RPC on
host `:8545`). The genesis pre-funds `0xfe3b…bd73` (~200 ETH). Dev-only keys — see
`infra/besu-network/README.md`.

**2. Run TokenLayer against it:**

```bash
docker compose -f docker-compose.yml -f docker-compose.besu.yml up -d
```

The overlay ([docker-compose.besu.yml](docker-compose.besu.yml)) joins the API to that
external network, sets `BESU_RPC_URL=http://besu-node1:8545` and the funded
`BESU_OPERATOR_KEY`. The chain registry then exposes `besu` as `kind: "evm"`, and any
use case whose `allowedChainIds` includes `besu` issues on-chain — the deployed
contract address becomes the asset's `contractRef`.

> This network has London/EIP-1559 enabled (non-zero base fee), so the `besu` chain in
> [config/chains.json](config/chains.json) uses `gas: "auto"` (the operator pays from its
> funded balance). It uses a **dev/demo** operator key — do not reuse it on production.

The compiled contract artifacts (`packages/contracts/artifacts/`) must be present in
the build context (they are baked into the API image). If you build from a clean
clone where they're absent, run `pnpm --filter @tokenlayer/contracts build` first.

## Run on the MST Testnet (public EVM)

The `mst` chain is preconfigured for the public **MST Testnet**:

| | |
|---|---|
| RPC URL | `https://testnetrpc.mstblockchain.com` |
| Chain ID | `91562037` |
| Currency | `tMSTC` |
| Explorer | https://testnet.mstscan.com |
| Faucet | https://faucet.mstblockchain.com/ |

**1. Fund an operator address** with test `tMSTC` from the faucet (it becomes the sole
operator that signs deployments and token operations).

**2. Set the env and start the stack** (compose reads them from `.env`):

```bash
cat >> .env <<'EOF'
MST_RPC_URL=https://testnetrpc.mstblockchain.com
MST_OPERATOR_KEY=0x<your-funded-testnet-key>
EOF

# MST is not `required`, so it comes up on any stack. To run WITHOUT the real Besu
# network, use the simulated base stack (besu absent) plus your MST env:
make deploy-sim
```

The API validates at boot that the RPC reports chainId `91562037` and **refuses to start
against the wrong network**. Once connected, any use case whose `allowedChainIds` includes
`mst` issues real contracts on the testnet; the dashboard links each contract address and tx
hash to the MST explorer. MST Testnet has a zero base fee (EIP-1559), so `mst` uses
`gas: "auto"` in [config/chains.json](config/chains.json) and the operator pays the small
priority fee from its faucet balance. **Never reuse a testnet key on a production network.**

## Run on real Hyperledger Fabric

The `fabric` chain runs on a real Hyperledger Fabric network (the `tokenlayer` Go
chaincode) — or the in-memory simulated adapter when unconfigured.

```bash
make fabric-up      # test-network up + deploy the tokenlayer chaincode + emit wallet/profile
make fabric-down    # tear it down
```

`make fabric-up` uses the Fabric samples `test-network` (`FABRIC_SAMPLES_DIR`, default
`~/fabric-samples`), deploys the chaincode on channel `mychannel`, and writes an `appUser`
wallet + connection profile under `infra/fabric/.runtime/` (gitignored), printing the
`FABRIC_*` env to set. Then run the API with that env (and `CHAIN_STRICT=0` so besu isn't
required):

```bash
FABRIC_CONNECTION_PROFILE=infra/fabric/.runtime/connection-org1.json \
FABRIC_WALLET=infra/fabric/.runtime/wallet FABRIC_IDENTITY=appUser \
FABRIC_CHANNEL=mychannel FABRIC_CHAINCODE=tokenlayer \
CHAIN_STRICT=0 pnpm api:dev
```

`fabric` then reports `mode: "real"` and issuing on it invokes the chaincode. The API probes
Fabric at boot (a `TotalSupply` chaincode read) and refuses to start if the configured network
is unreachable. Fabric needs ~2–3 GiB free in the Docker VM for its peers/orderer. See
[infra/fabric/README.md](infra/fabric/README.md) for details.

## Common commands

```bash
docker compose up --build -d     # build + start in background
docker compose logs -f api       # tail API logs
docker compose down              # stop (keeps the data volume)
docker compose down -v           # stop and wipe the SQLite volume
```
