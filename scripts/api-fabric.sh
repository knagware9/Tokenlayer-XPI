#!/usr/bin/env bash
# ============================================================================
# Run the TokenLayer API against the REAL Fabric network (host process).
#
#   make fabric-up          # bring up the network + deploy the chaincode (once)
#   ./scripts/api-fabric.sh # run the API with the emitted FABRIC_* wired in
#
# The Fabric connection profile emitted by fabric-up uses host-published ports
# (localhost:7051, discovery asLocalhost:true), so the API must run on the HOST
# (not in the api container, which can't reach the peer via localhost). The
# dockerized web at :8080 still works — the browser calls the host API at :4000.
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/infra/fabric/.runtime"

[[ -f "$RUNTIME/connection-org1.json" ]] || {
  echo "Fabric runtime not found at $RUNTIME — run 'make fabric-up' first." >&2
  exit 1
}

export FABRIC_CONNECTION_PROFILE="$RUNTIME/connection-org1.json"
export FABRIC_WALLET="$RUNTIME/wallet"
export FABRIC_IDENTITY="${FABRIC_IDENTITY:-appUser}"
export FABRIC_CHANNEL="${FABRIC_CHANNEL:-mychannel}"
export FABRIC_CHAINCODE="${FABRIC_CHAINCODE:-tokenlayer}"
# EVM chains (besu/mst) are absent here — never mocked; fabric is REAL.
export CHAIN_STRICT="${CHAIN_STRICT:-0}"
export NODE_ENV="${NODE_ENV:-development}"
export DATABASE_URL="${DATABASE_URL:-file:./fabric-dev.db}"
export JWT_SECRET="${JWT_SECRET:-dev-secret-fabric}"
export PORT="${PORT:-4000}"

echo "[api-fabric] fabric REAL via $FABRIC_IDENTITY@$FABRIC_CHANNEL/$FABRIC_CHAINCODE"
pnpm --filter @tokenlayer/api exec prisma db push --skip-generate >/dev/null 2>&1 || true
exec pnpm api:dev
