#!/usr/bin/env bash
# ============================================================================
# TokenLayer XPI — one-command Docker deployment
#
#   ./scripts/deploy.sh            # REAL Besu (default): starts the 5-node QBFT network + deploys on-chain
#   ./scripts/deploy.sh --sim      # simulated ledgers only (no external chain)
#
# Idempotent: generates a JWT secret if missing, (optionally) starts + waits for
# the Besu network, builds + starts the stack, and waits until it's healthy.
# ============================================================================
set -euo pipefail

# --- resolve repo root (script lives in <root>/scripts) ---------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- config (override via env) ----------------------------------------------
MODE="besu"
BESU_PROJECT_DIR="${BESU_PROJECT_DIR:-/Users/kamleshnagware/deposittokenization}"
API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-8080}"
BESU_RPC_PORT="${BESU_RPC_PORT:-8545}"
ADMIN_EMAIL="admin@tokenlayer.dev"
ADMIN_PASS="admin123"

# --- args -------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --besu) MODE="besu" ;;
    --sim) MODE="simulated" ;;
    --besu-dir) BESU_PROJECT_DIR="$2"; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

log() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed / not on PATH"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"

# --- 1. ensure a strong JWT secret in .env ----------------------------------
if [[ ! -f .env ]]; then
  log "No .env found — generating one with a fresh JWT_SECRET"
  echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
elif ! grep -q '^JWT_SECRET=..' .env; then
  log "JWT_SECRET missing in .env — appending a generated one"
  echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
else
  log ".env present with JWT_SECRET ✓"
fi

# --- 2. compose file set ----------------------------------------------------
COMPOSE=(docker compose -f docker-compose.yml)

if [[ "$MODE" == "besu" ]]; then
  [[ -f "$BESU_PROJECT_DIR/docker-compose.yml" ]] || \
    die "Besu network compose not found at $BESU_PROJECT_DIR (set BESU_PROJECT_DIR or --besu-dir)"

  log "Starting the 5-node Hyperledger Besu QBFT network ($BESU_PROJECT_DIR)…"
  docker compose -f "$BESU_PROJECT_DIR/docker-compose.yml" --project-directory "$BESU_PROJECT_DIR" \
    up -d besu-node1 besu-node2 besu-node3 besu-node4 besu-node5

  log "Waiting for Besu RPC + QBFT consensus (5 validators)…"
  for i in $(seq 1 60); do
    v=$(curl -s -m 3 -X POST "http://localhost:${BESU_RPC_PORT}" -H 'Content-Type: application/json' \
          -d '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}' 2>/dev/null \
          | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",[])))' 2>/dev/null || echo 0)
    if [[ "$v" -ge 4 ]]; then log "Besu network ready: $v validators ✓"; break; fi
    [[ $i -eq 60 ]] && die "Besu network did not reach consensus in time (got $v validators)"
    sleep 2
  done

  COMPOSE+=(-f docker-compose.besu.yml)
  log "Mode: REAL Besu (assets on the 'besu' chain deploy real contracts)"
else
  log "Mode: simulated ledgers (every chain runs in-memory)"
fi

# --- 3. build + start -------------------------------------------------------
log "Building images and starting the stack…"
"${COMPOSE[@]}" up -d --build

# --- 4. wait for health -----------------------------------------------------
log "Waiting for the API (login endpoint)…"
for i in $(seq 1 60); do
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' -X POST "http://localhost:${API_PORT}/api/v1/auth/login" \
          -H 'Content-Type: application/json' -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASS}\"}" 2>/dev/null || echo 000)
  if [[ "$code" == "200" ]]; then log "API healthy ✓"; break; fi
  [[ $i -eq 60 ]] && die "API did not become healthy (last HTTP $code) — check: ${COMPOSE[*]} logs api"
  sleep 2
done

log "Waiting for the web dashboard…"
for i in $(seq 1 30); do
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}/" 2>/dev/null || echo 000)
  if [[ "$code" == "200" ]]; then log "Web healthy ✓"; break; fi
  [[ $i -eq 30 ]] && die "Web did not become healthy (last HTTP $code)"
  sleep 2
done

# --- 5. smoke test ----------------------------------------------------------
# The stack is already up and healthy at this point; only the functional smoke
# test remains. If it fails, say so explicitly (the deployment itself succeeded)
# and point at the logs — otherwise `set -e` would abort with a bare exit code.
log "Running the smoke test…"
smoke_args=(); [[ "$MODE" == "besu" ]] && smoke_args=(--besu)
if ! ./scripts/verify.sh "${smoke_args[@]}"; then
  printf '\033[1;31m[deploy] Smoke test FAILED — the stack is up but not behaving correctly.\033[0m\n' >&2
  printf '\033[1;31m[deploy] Inspect it with: %s logs api\033[0m\n' "${COMPOSE[*]}" >&2
  exit 1
fi

# --- 6. summary -------------------------------------------------------------
cat <<EOF

  ┌──────────────────────────────────────────────────────────────┐
  │  TokenLayer XPI is deployed ($([ "$MODE" = besu ] && echo "real Besu chain" || echo "simulated"))
  ├──────────────────────────────────────────────────────────────┤
  │  Web dashboard : http://localhost:${WEB_PORT}
  │  API           : http://localhost:${API_PORT}
$([ "$MODE" = besu ] && echo "  │  Besu RPC      : http://localhost:${BESU_RPC_PORT}  (chainId 1337, 5 validators)")
  │  Sign in       : carbon.admin@tokenlayer.dev / carbon123
  └──────────────────────────────────────────────────────────────┘
EOF
