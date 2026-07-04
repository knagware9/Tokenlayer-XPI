#!/usr/bin/env bash
# ============================================================================
# Bring up a real Hyperledger Fabric network for the `fabric` chain, using the
# Fabric samples test-network, and deploy the `tokenlayer` Go chaincode.
#
#   ./infra/fabric/fabric-up.sh            # channel 'mychannel', chaincode 'tokenlayer'
#
# After it completes, it emits a wallet + connection profile under
# infra/fabric/.runtime/ and prints the FABRIC_* env to run the API against it.
#
# Prereq: the Fabric samples (binaries + images). Override the location with
# FABRIC_SAMPLES_DIR (default ~/fabric-samples). Needs Docker with enough memory
# for the peers/orderer (~2-3 GiB free in the Docker VM).
# ============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SAMPLES="${FABRIC_SAMPLES_DIR:-$HOME/fabric-samples}"
CHANNEL="${FABRIC_CHANNEL:-mychannel}"
CC_NAME="${FABRIC_CHAINCODE:-tokenlayer}"
CC_PATH="$REPO/infra/fabric/chaincode/tokenlayer"

log() { printf '\033[1;36m[fabric-up]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[fabric-up] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$SAMPLES/test-network" ]] || die "Fabric samples not found at $SAMPLES (set FABRIC_SAMPLES_DIR)."
[[ -x "$SAMPLES/bin/peer" ]] || die "Fabric binaries missing at $SAMPLES/bin (need peer, configtxgen, ...)."
command -v docker >/dev/null || die "docker is not installed / not on PATH."
[[ -f "$CC_PATH/go.mod" ]] || die "chaincode not found at $CC_PATH."

export PATH="$SAMPLES/bin:$PATH"
export FABRIC_CFG_PATH="$SAMPLES/config"

cd "$SAMPLES/test-network"

log "Bringing up the network and creating channel '$CHANNEL'…"
./network.sh up createChannel -c "$CHANNEL"

log "Deploying the '$CC_NAME' chaincode from $CC_PATH …"
./network.sh deployCC -c "$CHANNEL" -ccn "$CC_NAME" -ccp "$CC_PATH" -ccl go

log "Emitting wallet + connection profile to infra/fabric/.runtime/ …"
node "$REPO/infra/fabric/scripts/fabric-wallet.mjs" --samples "$SAMPLES"

log "Fabric is up. The 'fabric' chain runs REAL when the printed FABRIC_* env is set."
