#!/usr/bin/env bash
# Boot the TokenLayer API against the real ledgers (Besu + MST + Fabric) with the
# secondary market enabled. Reads secrets/keys from the repo-root .env (stable
# DID_MASTER_KEY, MST creds, JWT secret). Reusable across sessions.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; . "$ROOT/.env"; set +a
export BESU_RPC_URL="${BESU_RPC_URL:-http://localhost:8545}"
export BESU_OPERATOR_KEY="${BESU_OPERATOR_KEY:-0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63}"
export REGISTRY_CHAIN_ID="${REGISTRY_CHAIN_ID:-besu}"
export FABRIC_CONNECTION_PROFILE="$ROOT/infra/fabric/.runtime/connection-org1.json"
export FABRIC_WALLET="$ROOT/infra/fabric/.runtime/wallet"
export FABRIC_IDENTITY="${FABRIC_IDENTITY:-appUser}"
export FABRIC_CHANNEL="${FABRIC_CHANNEL:-mychannel}"
export FABRIC_CHAINCODE="${FABRIC_CHAINCODE:-tokenlayer}"
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:5173}"
export LOGIN_RATE_LIMIT_MAX="${LOGIN_RATE_LIMIT_MAX:-1000}"
export DATABASE_URL="file:./dev.db"
cd "$ROOT/apps/api"
exec ./node_modules/.bin/tsx src/server.ts
