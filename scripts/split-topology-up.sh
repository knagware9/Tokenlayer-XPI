#!/usr/bin/env bash
# ============================================================================
# Bring up the SPLIT TOPOLOGY as two local processes and prove it.
#
#   ./scripts/split-topology-up.sh          # boot both, run the e2e, tear down
#   ./scripts/split-topology-up.sh --keep   # leave both running afterwards
#
# Two APIs, two SQLite databases, one peer key:
#
#   identity      :4100  ENABLED_DOMAINS=identity      prisma/dev-split-identity.db
#   tokenization  :4000  ENABLED_DOMAINS=tokenization  prisma/dev-split-tokenization.db
#
# The ORDER is the whole point and is why this is a script rather than a compose
# file: IDENTITY_SERVICE_KEY is an API key that only exists once the identity
# deployment is running. Boot identity → mint the peer key → boot tokenization.
#
# Throwaway databases named dev-split-*.db — the real dev.db is never touched.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/apps/api"

KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

IDENTITY_PORT="${IDENTITY_PORT:-4100}"
TOKENIZATION_PORT="${TOKENIZATION_PORT:-4000}"
IDENTITY_DB="$ROOT/apps/api/prisma/dev-split-identity.db"
TOKENIZATION_DB="$ROOT/apps/api/prisma/dev-split-tokenization.db"
LOGDIR="${TMPDIR:-/tmp}/xi-split-$$"
mkdir -p "$LOGDIR"

log() { printf '\033[1;36m[split]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[split] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

IDENTITY_PID=""; TOKENIZATION_PID=""
cleanup() {
  if [[ $KEEP -eq 1 ]]; then
    log "--keep: leaving identity (pid $IDENTITY_PID, :$IDENTITY_PORT) and tokenization (pid $TOKENIZATION_PID, :$TOKENIZATION_PORT) running"
    log "logs: $LOGDIR"
    return
  fi
  [[ -n "$TOKENIZATION_PID" ]] && kill "$TOKENIZATION_PID" 2>/dev/null || true
  [[ -n "$IDENTITY_PID" ]] && kill "$IDENTITY_PID" 2>/dev/null || true
  rm -f "$IDENTITY_DB" "$IDENTITY_DB-journal" "$TOKENIZATION_DB" "$TOKENIZATION_DB-journal"
}
trap cleanup EXIT

wait_for() { # wait_for <port> <label>
  for _ in $(seq 1 90); do
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' -X POST "http://localhost:$1/api/v1/auth/login" \
      -H 'Content-Type: application/json' -d '{"email":"admin@tokenlayer.dev","password":"admin123"}' 2>/dev/null || echo 000)
    [[ "$code" == "200" ]] && { log "$2 API healthy on :$1 ✓"; return 0; }
    sleep 1
  done
  die "$2 API did not come up on :$1 — see $LOGDIR/$2.log"
}

for p in "$IDENTITY_PORT" "$TOKENIZATION_PORT"; do
  lsof -ti "tcp:$p" >/dev/null 2>&1 && die "port $p is already in use — stop that process first"
done

JWT="$(openssl rand -hex 32)"
export JWT_SECRET="$JWT" CHAIN_STRICT=0 LOGIN_RATE_LIMIT_MAX=1000

# --- 1. identity ------------------------------------------------------------
rm -f "$IDENTITY_DB" "$TOKENIZATION_DB"
log "Preparing the identity database…"
DATABASE_URL="file:$IDENTITY_DB" npx prisma db push --skip-generate >/dev/null 2>&1 || die "prisma db push (identity) failed"
log "Starting the IDENTITY deployment on :$IDENTITY_PORT…"
DATABASE_URL="file:$IDENTITY_DB" PORT="$IDENTITY_PORT" ENABLED_DOMAINS=identity \
  PUBLIC_API_URL="http://localhost:$IDENTITY_PORT/api/v1" \
  npx tsx src/server.ts >"$LOGDIR/identity.log" 2>&1 &
IDENTITY_PID=$!
wait_for "$IDENTITY_PORT" identity

# --- 2. the peer key (only mintable once identity is up) --------------------
log "Minting the peer API key (identity:assert) on the identity deployment…"
PEER_KEY="$(IDENTITY_URL="http://localhost:$IDENTITY_PORT/api/v1" node "$ROOT/scripts/mint-identity-peer-key.mjs")"
[[ -n "$PEER_KEY" ]] || die "peer key was empty"

# --- 3. tokenization --------------------------------------------------------
log "Preparing the tokenization database…"
DATABASE_URL="file:$TOKENIZATION_DB" npx prisma db push --skip-generate >/dev/null 2>&1 || die "prisma db push (tokenization) failed"
log "Starting the TOKENIZATION deployment on :$TOKENIZATION_PORT (delegating identity)…"
DATABASE_URL="file:$TOKENIZATION_DB" PORT="$TOKENIZATION_PORT" ENABLED_DOMAINS=tokenization \
  PUBLIC_API_URL="http://localhost:$TOKENIZATION_PORT/api/v1" \
  IDENTITY_SERVICE_URL="http://localhost:$IDENTITY_PORT/api/v1" \
  IDENTITY_SERVICE_KEY="$PEER_KEY" \
  npx tsx src/server.ts >"$LOGDIR/tokenization.log" 2>&1 &
TOKENIZATION_PID=$!
wait_for "$TOKENIZATION_PORT" tokenization

# --- 4. the proof -----------------------------------------------------------
log "Running the split-topology end-to-end…"
set +e
HANDOFF="$LOGDIR/handoff.json"
IDENTITY_URL="http://localhost:$IDENTITY_PORT/api/v1" \
TOKENIZATION_URL="http://localhost:$TOKENIZATION_PORT/api/v1" \
SPLIT_HANDOFF="$HANDOFF" \
  node "$ROOT/scripts/split-topology-e2e.mjs"
E2E=$?
set -e

# --- 5. fail-closed: with identity DOWN, the gate must REFUSE, loudly -------
# The one thing no single-process test can show. It runs LAST because it stops
# the identity deployment; a 503 here (not a 400, and not a quiet "not
# verified") is what says the tokenization gate is genuinely asking a peer.
if [[ $E2E -eq 0 ]]; then
  log "Stopping identity to prove the gate fails CLOSED and LOUDLY…"
  kill "$IDENTITY_PID" 2>/dev/null || true
  sleep 2
  TOKEN=$(curl -s -m 10 -X POST "http://localhost:$TOKENIZATION_PORT/api/v1/auth/login" \
    -H 'Content-Type: application/json' -d '{"email":"admin@tokenlayer.dev","password":"admin123"}' \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null || echo "")
  if [[ -n "$TOKEN" ]]; then
    log "tokenization still signs in and serves its own product with identity down ✓"
  else
    printf '\033[1;31m[split] tokenization stopped serving when identity went down\033[0m\n' >&2; E2E=1
  fi

  # The same transfer that just succeeded, with the peer unreachable.
  ASSET=$(python3 -c "import json;print(json.load(open('$HANDOFF'))['assetId'])")
  FROM=$(python3 -c "import json;print(json.load(open('$HANDOFF'))['treasury'])")
  TO=$(python3 -c "import json;print(json.load(open('$HANDOFF'))['holder'])")
  BODY=$(curl -s -m 20 -w '\n%{http_code}' -X POST \
    "http://localhost:$TOKENIZATION_PORT/api/v1/assets/$ASSET/actions/transfer" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"from\":\"$FROM\",\"to\":\"$TO\",\"amount\":\"1\"}")
  STATUS=$(printf '%s' "$BODY" | tail -1)
  ERROR=$(printf '%s' "$BODY" | head -1 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("error",""))' 2>/dev/null || echo "?")
  if [[ "$STATUS" == "503" && "$ERROR" == "IDENTITY_SERVICE_UNAVAILABLE" ]]; then
    log "the gated transfer fails CLOSED and LOUDLY: 503 IDENTITY_SERVICE_UNAVAILABLE ✓"
  else
    printf '\033[1;31m[split] with identity DOWN the gated transfer answered %s %s — expected 503 IDENTITY_SERVICE_UNAVAILABLE.\033[0m\n' "$STATUS" "$ERROR" >&2
    printf '\033[1;31m[split] (a 200 means it passed everyone; IDENTITY_NOT_VERIFIED means it reported a policy answer for a network failure.)\033[0m\n' >&2
    E2E=1
  fi
  IDENTITY_PID=""
fi

[[ $E2E -eq 0 ]] || die "split-topology end-to-end FAILED (see $LOGDIR/*.log)"
log "Split topology verified ✓"
