#!/usr/bin/env bash
# Back up one product's database out of its Docker named volume.
#
#   bash deploy/backup/backup.sh tokenization
#   bash deploy/backup/backup.sh identity
#
# Writes deploy/backup/out/<product>-<UTC timestamp>.db, and prints its path
# on success. See deploy/backup/README.md for restore and the full runbook.
set -euo pipefail

PRODUCT="${1:?usage: backup.sh <tokenization|identity>}"
case "$PRODUCT" in
  tokenization) VOLUME="xi-tokenization_tokenization-data"; DB_FILE="tokenization.db" ;;
  identity)     VOLUME="xi-identity_identity-data";         DB_FILE="identity.db" ;;
  *) echo "unknown product '$PRODUCT' — expected tokenization or identity" >&2; exit 1 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HERE/out"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/${PRODUCT}-${STAMP}.db"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "volume '$VOLUME' does not exist — is the $PRODUCT stack up? (bash scripts/stack-up.sh $PRODUCT)" >&2
  exit 1
fi

# SQLite's own `.backup` command, not a raw file copy: it's an ATOMIC,
# consistent snapshot even while the API is actively writing to the live
# file — a `cp` mid-write can capture a torn page. A short-lived alpine
# container (the app images don't carry the sqlite3 CLI) mounts the SAME
# named volume the running API container uses, so this needs no downtime.
docker run --rm \
  -v "${VOLUME}:/data:ro" \
  -v "${OUT_DIR}:/backup" \
  alpine:3.20 \
  sh -c "apk add --no-cache sqlite >/dev/null && sqlite3 /data/${DB_FILE} \".backup /backup/$(basename "$OUT_FILE")\""

echo "$OUT_FILE"
