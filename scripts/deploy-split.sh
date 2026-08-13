#!/usr/bin/env bash
# ============================================================================
# TokenLayer XPI — deploy the SPLIT TOPOLOGY (two products, two deployments).
#
#   ./scripts/deploy-split.sh              # or: make deploy-split
#
# Identity  → API :4100, web :8081, its own database volume
# Tokenize  → API :4000, web :8080, its own database volume
#
# WHY THIS IS A SCRIPT AND NOT JUST `docker compose up`:
#
#   IDENTITY_SERVICE_KEY is an API key that does not exist until the identity
#   deployment is running. It cannot be a compose literal, and a fixed one baked
#   into an image would be a shared secret in a git repository. So the order is
#   load-bearing: bring identity up → mint a peer key holding `identity:assert`
#   → bring tokenization up with it.
#
# The minted key is written to .env.split (git-ignored). Re-running mints a
# fresh one; the old key keeps working until it is revoked on the identity
# deployment (GET /orgs/:id/api-keys lists them).
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IDENTITY_API_PORT="${IDENTITY_API_PORT:-4100}"
API_PORT="${API_PORT:-4000}"
IDENTITY_WEB_PORT="${IDENTITY_WEB_PORT:-8081}"
WEB_PORT="${WEB_PORT:-8080}"
COMPOSE=(docker compose -f docker-compose.split.yml --env-file .env --env-file .env.split)

log() { printf '\033[1;36m[split]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[split] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed / not on PATH"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"

# --- 1. secrets -------------------------------------------------------------
if [[ ! -f .env ]]; then
  log "No .env — generating one with a fresh JWT_SECRET"
  echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
elif ! grep -q '^JWT_SECRET=..' .env; then
  echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
fi
# A placeholder so compose can interpolate on the first pass — the identity
# service is brought up alone, so nothing reads it yet.
echo "IDENTITY_SERVICE_KEY=pending" > .env.split

wait_for() { # wait_for <port> <label>
  for _ in $(seq 1 90); do
    code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' -X POST "http://localhost:$1/api/v1/auth/login" \
      -H 'Content-Type: application/json' -d '{"email":"admin@tokenlayer.dev","password":"admin123"}' 2>/dev/null || echo 000)
    [[ "$code" == "200" ]] && { log "$2 API healthy on :$1 ✓"; return 0; }
    sleep 2
  done
  die "$2 API did not become healthy on :$1 — check: ${COMPOSE[*]} logs $2-api"
}

# --- 2. identity first ------------------------------------------------------
log "Building and starting the IDENTITY deployment…"
"${COMPOSE[@]}" up -d --build identity-api identity-web
wait_for "$IDENTITY_API_PORT" identity

# --- 3. the peer key --------------------------------------------------------
log "Minting the peer API key (identity:assert) on the identity deployment…"
PEER_KEY="$(IDENTITY_URL="http://localhost:${IDENTITY_API_PORT}/api/v1" node scripts/mint-identity-peer-key.mjs)"
[[ -n "$PEER_KEY" ]] || die "peer key was empty"
echo "IDENTITY_SERVICE_KEY=$PEER_KEY" > .env.split
log "Wrote IDENTITY_SERVICE_KEY to .env.split (git-ignored — it is a live credential)"

# --- 4. tokenization --------------------------------------------------------
log "Building and starting the TOKENIZATION deployment (delegating identity)…"
"${COMPOSE[@]}" up -d --build tokenization-api tokenization-web
wait_for "$API_PORT" tokenization

# --- 5. the proof -----------------------------------------------------------
log "Running the split-topology end-to-end…"
if ! IDENTITY_URL="http://localhost:${IDENTITY_API_PORT}/api/v1" \
     TOKENIZATION_URL="http://localhost:${API_PORT}/api/v1" \
     node scripts/split-topology-e2e.mjs; then
  printf '\033[1;31m[split] The stack is up but the split-topology e2e FAILED.\033[0m\n' >&2
  printf '\033[1;31m[split] Inspect it with: %s logs tokenization-api\033[0m\n' "${COMPOSE[*]}" >&2
  exit 1
fi

cat <<EOF

  ┌──────────────────────────────────────────────────────────────┐
  │  TokenLayer XPI — SPLIT topology (two products, two databases)
  ├──────────────────────────────────────────────────────────────┤
  │  Identity      web : http://localhost:${IDENTITY_WEB_PORT}
  │  Identity      API : http://localhost:${IDENTITY_API_PORT}
  │  Tokenization  web : http://localhost:${WEB_PORT}
  │  Tokenization  API : http://localhost:${API_PORT}
  │
  │  Tokenization asks Identity one question — "does this DID hold
  │  a valid KycCredential?" — and nothing else.
  └──────────────────────────────────────────────────────────────┘
EOF
