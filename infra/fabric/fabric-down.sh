#!/usr/bin/env bash
# Tear down the Fabric test-network and remove the emitted runtime artifacts.
#   ./infra/fabric/fabric-down.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SAMPLES="${FABRIC_SAMPLES_DIR:-$HOME/fabric-samples}"

log() { printf '\033[1;36m[fabric-down]\033[0m %s\n' "$*"; }

if [[ -d "$SAMPLES/test-network" ]]; then
  export PATH="$SAMPLES/bin:$PATH"
  log "Stopping the Fabric test-network…"
  ( cd "$SAMPLES/test-network" && ./network.sh down )
else
  log "Fabric samples not found at $SAMPLES — skipping network down."
fi

rm -rf "$REPO/infra/fabric/.runtime"
log "Removed infra/fabric/.runtime/. Done."
