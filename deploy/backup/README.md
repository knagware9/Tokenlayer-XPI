# Backup & restore runbook

Both products (`tokenization`, `identity`) persist to a **SQLite** file
(`tokenization.db` / `identity.db`) inside a Docker named volume
(`xi-tokenization_tokenization-data`, `xi-identity_identity-data`), mounted
at `/data` in the corresponding API container. There is no separate
database service to back up — the file in that volume *is* the database.

> **SQLite, not Postgres.** SQLite is a single-writer, single-file database.
> That's fine at today's scale and keeps the deployment simple, but it means
> there is no built-in replication, point-in-time recovery, or concurrent
> writer failover — a lost or corrupted volume is a full-outage event
> recovered only from the most recent backup below. If usage grows to the
> point that write concurrency or high availability matters, migrating to
> Postgres is the natural next step — a deliberate infra decision for
> whoever owns that tradeoff, not something this runbook does on its own.

## What gets backed up

Everything in the product's database: assets, accounts, users, credentials,
audit logs, ledger transactions, documents, and every other table Prisma
manages for that product. `deploy/backup/backup.sh` was verified against
the live `tokenization` stack and confirmed all 40 tables are present and
queryable in the resulting snapshot.

Docker volumes for uploaded files (`Document` blobs), if stored outside the
SQLite file, are out of scope for this runbook — check
`docker-compose.<product>.yml` for any additional volume mounts before
relying on this alone as a full disaster-recovery plan.

## Backup

```bash
bash deploy/backup/backup.sh tokenization
bash deploy/backup/backup.sh identity
```

This can be run **while the stack is up** — no downtime required. It uses
SQLite's own `.backup` command (via a short-lived `alpine` container that
mounts the same named volume read-only) to take an atomic, consistent
snapshot, not a raw file copy. A raw `cp` of a live SQLite file can capture
a torn page mid-write; `.backup` cannot.

Output: `deploy/backup/out/<product>-<UTC timestamp>.db`, path printed on
success. This directory is git-ignored — snapshots contain real user and
transaction data and must never be committed.

### Recommended schedule

- Run manually before any risky operation: a schema migration, a stack
  rebuild, a Docker volume prune, an infra change.
- For routine coverage, wire `backup.sh` into a daily cron/CI job and ship
  the output off-box (S3, another disk, etc.) — this repo does not do that
  automatically today.
- Retention: keep at least the last 7 daily snapshots and the last 4
  weekly ones; prune older ones once off-box copies exist.

## Restore

**Stop the target product's stack first.** SQLite is a single-writer file
the running API process holds open; overwriting it underneath a live
process risks corruption. `restore.sh` refuses to run while the product's
API container is up.

```bash
docker compose -f docker-compose.tokenization.yml down
bash deploy/backup/restore.sh tokenization deploy/backup/out/tokenization-20260901T082738Z.db
bash scripts/stack-up.sh tokenization
```

`restore.sh`:
1. Refuses if the product's API container is still running.
2. Runs `PRAGMA integrity_check` on the snapshot before touching anything —
   refuses to restore a truncated or corrupt file.
3. Prompts for a typed `restore` confirmation (it is about to overwrite the
   live database).
4. Copies the snapshot into the volume, replacing the current
   `tokenization.db` / `identity.db`.

Restoring loses any writes made after the snapshot was taken — this is
expected; that's the gap the backup schedule above is meant to bound.

## Testing a restore

Don't wait for a real incident to find out a backup doesn't restore
cleanly. Periodically verify on a scratch volume, not the live one:

```bash
docker volume create restore-test
docker run --rm -v restore-test:/data -v "$(pwd)/deploy/backup/out:/backup:ro" \
  alpine:3.20 sh -c "cp /backup/tokenization-<timestamp>.db /data/tokenization.db"
docker run --rm -v restore-test:/data:ro alpine:3.20 \
  sh -c "apk add --no-cache sqlite >/dev/null && sqlite3 /data/tokenization.db 'PRAGMA integrity_check; SELECT count(*) FROM Asset;'"
docker volume rm restore-test
```

If `integrity_check` returns `ok` and the row counts look sane, the backup
is good.
