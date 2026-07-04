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
reference. The Besu overlay points the API at the **existing 5-node QBFT network** from the
`deposittokenization` project, so the `besu` chain deploys real `ComplianceToken` /
`ComplianceNFT` / T-REX contracts on-chain.

**1. Start the 5-node network** (it owns the genesis, validator keys, and static peers):

```bash
cd /Users/kamleshnagware/deposittokenization
docker compose up -d besu-node1 besu-node2 besu-node3 besu-node4 besu-node5
# (or ./besu-network/start-network.sh)
```

This creates the docker network `deposittokenization_besu-network` (chainId 1337,
QBFT, 5 validators, RPC on host `:8545`). The genesis pre-funds `0xfe3b…bd73` (~200 ETH).

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

## Common commands

```bash
docker compose up --build -d     # build + start in background
docker compose logs -f api       # tail API logs
docker compose down              # stop (keeps the data volume)
docker compose down -v           # stop and wipe the SQLite volume
```
