#!/usr/bin/env bash
# Restore one product's database into its Docker named volume from a
# snapshot produced by backup.sh.
#
#   bash deploy/backup/restore.sh tokenization deploy/backup/out/tokenization-20260901T082738Z.db
#   bash deploy/backup/restore.sh identity deploy/backup/out/identity-20260901T083000Z.db
#
# The target product's stack MUST be stopped first — SQLite is a
# single-writer file the running API process holds open, and overwriting it
# underneath a live process risks corruption. See deploy/backup/README.md
# for the full runbook.
set -euo pipefail

PRODUCT="${1:?usage: restore.sh <tokenization|identity> <path-to-.db-snapshot>}"
SNAPSHOT="${2:?usage: restore.sh <tokenization|identity> <path-to-.db-snapshot>}"

case "$PRODUCT" in
  tokenization) VOLUME="xi-tokenization_tokenization-data"; DB_FILE="tokenization.db" ;;
  identity)     VOLUME="xi-identity_identity-data";         DB_FILE="identity.db" ;;
  *) echo "unknown product '$PRODUCT' — expected tokenization or identity" >&2; exit 1 ;;
esac

if [ ! -f "$SNAPSHOT" ]; then
  echo "snapshot file not found: $SNAPSHOT" >&2
  exit 1
fi
SNAPSHOT_ABS="$(cd "$(dirname "$SNAPSHOT")" && pwd)/$(basename "$SNAPSHOT")"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "volume '$VOLUME' does not exist — has the $PRODUCT stack ever been started?" >&2
  exit 1
fi

RUNNING="$(docker ps --filter "name=${PRODUCT}-api" --format '{{.Names}}')"
if [ -n "$RUNNING" ]; then
  echo "refusing to restore: ${RUNNING} is still running against this volume." >&2
  echo "stop the $PRODUCT stack first, e.g.:" >&2
  echo "  docker compose -f docker-compose.${PRODUCT}.yml down" >&2
  exit 1
fi

echo "About to overwrite ${DB_FILE} in volume ${VOLUME} with:"
echo "  ${SNAPSHOT_ABS}"
read -r -p "Type 'restore' to confirm: " CONFIRM
if [ "$CONFIRM" != "restore" ]; then
  echo "aborted — no changes made" >&2
  exit 1
fi

# Sanity-check the snapshot is a real, non-corrupt SQLite file before
# touching the volume: `.backup`-produced files may still be truncated if
# backup.sh was interrupted, and a bad restore is worse than a refused one.
docker run --rm \
  -v "${SNAPSHOT_ABS}:/snapshot.db:ro" \
  alpine:3.20 \
  sh -c "apk add --no-cache sqlite >/dev/null && sqlite3 /snapshot.db 'PRAGMA integrity_check;'" \
  | grep -qx ok || {
    echo "snapshot failed SQLite's integrity_check — refusing to restore a bad backup" >&2
    exit 1
  }

docker run --rm \
  -v "${SNAPSHOT_ABS}:/snapshot.db:ro" \
  -v "${VOLUME}:/data" \
  alpine:3.20 \
  sh -c "cp /snapshot.db /data/${DB_FILE}"

echo "restored ${DB_FILE} in volume ${VOLUME} from ${SNAPSHOT_ABS}"
echo "start the $PRODUCT stack again, e.g.:"
echo "  bash scripts/stack-up.sh ${PRODUCT}"
