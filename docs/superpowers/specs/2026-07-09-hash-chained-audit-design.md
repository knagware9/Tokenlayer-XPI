# Hash-Chained Tamper-Evident Audit (Institutional Trust — cycle 1)

**Date:** 2026-07-09
**Status:** Approved (design)
**Branch:** `feat/hash-chained-audit`

## Problem

The audit trail (`AuditLog`) is append-only by intent but fully mutable at the
DB layer: a row can be edited, deleted, or inserted with no trace. Regulated
tokenization desks require a **tamper-evident** audit — any alteration must be
detectable, including by a privileged operator. This is the integrity
foundation of the "institutional trust" track (SSO/MFA and KYC-provider
integration are separate later cycles; maker-checker approvals already shipped).

## Decisions (from brainstorming)

1. **Per-asset hash chains** — each asset's audit entries form their own linked
   chain (distinct genesis per asset). Simpler concurrency than one global
   chain; every audit entry carries an `assetId`, so per-asset chains cover the
   whole log.
2. **Chain + on-ledger anchoring** — the linked-hash chain catches localized
   tampering; periodically anchoring each chain's head on-ledger additionally
   defeats a consistent full-chain rewrite by someone with DB access.
3. **API + web Integrity surface** — verify/anchor endpoints plus a dashboard
   Integrity view (auditor-facing, demoable).

## Architecture

### Core — pure hashing + verification (`packages/core/src/audit-chain.ts`)

```ts
export interface AuditChainFields {
  assetId: string;        // chain key ("__none__" for asset-less entries)
  seq: number;            // per-asset sequence, 0-based
  actorId: string;
  action: string;
  payload: Record<string, unknown>;
  txHash?: string;
  chainId?: string;
  createdAt: string;      // stored ISO timestamp (part of the hash)
}

/** Distinct genesis per asset — prevents splicing entries between chains. */
export function auditGenesis(assetId: string): string;   // sha256("tokenlayer-audit-genesis|"+assetId)

/** hash = sha256(prevHash + "|" + canonicalJSON(fields)); canonicalJSON sorts keys. */
export function auditEntryHash(prevHash: string, fields: AuditChainFields): string;

export interface ChainEntry { seq: number; prevHash: string; hash: string; fields: AuditChainFields; }
export interface VerifyResult { assetId: string; valid: boolean; count: number; head: string | null; brokenAt: number | null; reason?: string; }

/** Recompute a single asset's chain (entries MUST be seq-ascending) and locate the first break. */
export function verifyChain(assetId: string, entries: ChainEntry[]): VerifyResult;
```

`verifyChain` walks the entries: expects `seq` contiguous from 0; each entry's
`prevHash` must equal the running head; `auditEntryHash(prevHash, fields)` must
equal the stored `hash`. First failure sets `brokenAt` + `reason`
("hash-mismatch" | "prevhash-mismatch" | "seq-gap"). All-pass → `valid: true`,
`head` = last hash. `canonicalJSON` is a small deterministic serializer (recursively
sorts object keys; arrays preserved) so hashing is stable across JS engines.

Exports added to `packages/core/src/index.ts`.

### Persistence — chained append (chokepoint)

`AuditLog` (Prisma) + memory repo gain: `seq Int`, `prevHash String`,
`hash String`. `@@index([assetId, seq])`; `@@unique([assetId, seq])`.

`AuditRepository.append` becomes the single chaining chokepoint (all writers —
the engine's `RepositoryAuditSink` and the direct route appends — already flow
through it). Under a **serialized append** (an in-process promise-chain mutex;
audit volume is low and the API is single-instance):
1. `chainKey = entry.assetId ?? "__none__"`.
2. Read the current head for `chainKey`: the row with the max `seq` → its `hash`
   + `seq`; if none, `prevHash = auditGenesis(chainKey)`, `seq = 0`.
3. Compute `hash = auditEntryHash(prevHash, {assetId: chainKey, seq, ...entry})`
   using the resolved `createdAt` (the same value persisted).
4. Insert the row with `seq/prevHash/hash`. Return the record (record type gains
   optional `seq/prevHash/hash`).

The Prisma `@@unique([assetId, seq])` is the concurrency backstop: if two
appends somehow raced past the mutex, the loser hits P2002 and retries (bounded)
by re-reading the head. Memory repo mirrors the serialize-and-append semantics.

`AuditEntryRecord` gains optional `seq?: number; prevHash?: string; hash?: string`
so existing consumers (analytics `listByAssetIds`, `listByAsset`) are unaffected.

### On-ledger anchoring

New Prisma model + repo:

```prisma
model AuditAnchor {
  id        String   @id @default(cuid())
  assetId   String
  seq       Int      // the head seq anchored
  hash      String   // the head hash anchored
  txHash    String
  chainId   String
  createdAt DateTime @default(now())
  @@index([assetId])
}
```
`AuditAnchorRepository`: `create(...)`, `latest(assetId)` (highest seq), both
impls.

New ledger seam: `LedgerAdapter.anchor(ref: AssetRef, hash: string): Promise<TxReceipt>`
(added to the core `LedgerAdapter` interface).
- Simulated adapter: appends the hash to an in-memory per-ref list, returns a
  synthetic `TxReceipt` (`txHash = "0xanchor" + n`).
- EVM adapter: sends a 0-value self-transaction with the hash in calldata → a
  real, immutable `txHash` (best-effort; falls back to a synthetic marker if no
  signer is configured, mirroring the adapter's existing real-or-absent stance).

### API routes

- `POST /audit/anchor` (Auditor / UseCaseAdmin / PlatformAdmin; use-case scoped
  for non-platform): for each in-scope asset with ≥1 audit entry, compute the
  head via `verifyChain` over its entries, call `deps.chains.resolveAdapter(chainId).anchor(ref, head)`,
  and `auditAnchors.create({...})`. Returns the anchors written.
- `GET /assets/:id/audit/verify` (read-scoped): fetch the asset's entries
  seq-asc, `verifyChain`, load `latest` anchor, and additionally recompute the
  entry hash **at the anchored seq** and compare to `anchor.hash`
  (`anchorConsistent`: false ⇒ tampering at/before the anchor even if the chain
  is internally consistent; true when there is no anchor yet). Response: `{ assetId, valid, count, head, brokenAt,
  reason?, lastAnchor: { seq, hash, txHash, chainId, at } | null, anchorConsistent: boolean }`.
- `GET /audit/verify` (scoped): per-asset roll-up
  `{ assets: number, verified: number, tampered: { assetId, brokenAt, reason }[], anchoredAssets: number }`.
- Schemas added to `apps/api/src/http/schemas.ts`; `auditAnchors` wired into
  `AppDeps` + all construction sites (server, test helper, 5 demo/e2e scripts).

### Web — Integrity view

A top-level **Integrity** nav item (Auditor + admins). A table over the caller's
assets: name · chain status pill (✓ verified / ✗ tampered @#N) · entry count ·
last anchor (seq + short `txHash` + time) · anchor-consistent pill. Header
actions: **Verify now** (re-fetch) and **Anchor now** (admin → `POST /audit/anchor`).
`api.ts`: `verifyAudit(token, assetId?)`, `verifyAuditSummary(token)`,
`anchorAudit(token)`. `types.ts`: `AuditVerify`, `AuditSummary`.

## Data flow

Any lifecycle op → `repo.append` computes `seq/prevHash/hash` → chained row.
Auditor opens Integrity → `GET /audit/verify` recomputes every chain live →
green. Admin clicks Anchor → head hashes written on-ledger + `AuditAnchor` rows.
Later, a tampered row (edit/delete/insert) → verify shows the exact asset + `seq`
of the break; a sophisticated full rewrite → `anchorConsistent: false`.

## Error handling

- `anchor` on an asset with no entries → skipped (not an error).
- Adapter `anchor` failure on a real chain → the anchor for that asset is
  skipped and reported; other assets still anchor (best-effort, logged).
- `verifyChain` never throws — a malformed/tampered chain returns
  `valid: false` with `brokenAt`/`reason`.
- Append mutex ensures a consistent head; P2002 (unique seq) → bounded retry.

## Testing

- Core: `auditEntryHash` determinism + sensitivity (any field change → different
  hash); `auditGenesis` distinct per asset; `verifyChain` green on a valid
  constructed chain and detecting edit / delete (seq-gap + prevhash-mismatch) /
  inserted-forgery / reordering.
- API: `append` produces seq 0..n with correct prevHash/hash (fetch + re-verify);
  `GET /audit/verify` green after real activity; a raw entry mutation (bypassing
  `append` via a repo test hook / direct row write) → verify `valid:false` at the
  right seq; anchor writes a row + non-empty `txHash`; after anchoring, a mutation
  at/before the anchored seq → `anchorConsistent:false`. Tenancy: cross-use-case
  verify → 404.
- Web: tsc + build.
- Live E2E: run the full-platform activity → `GET /audit/verify` all green →
  `POST /audit/anchor` → confirm anchors → tamper one AuditLog row in SQLite
  (`sqlite3 UPDATE`) → verify flags exactly that asset + seq and
  `anchorConsistent:false`.

## Out of scope (later cycles)

- Backfilling hashes onto a pre-existing (unchained) DB — fresh-volume deploy
  chains from genesis, which matches how we deploy.
- Global (cross-asset) chain; Merkle batching; scheduled auto-anchoring.
- Anchoring to a dedicated on-chain AuditAnchor contract (the EVM self-tx +
  simulated store is sufficient for the demo).
- Signing entries with the actor's key (chain integrity, not authenticity, is
  this cycle's goal).

## Phasing

1. **Core**: `audit-chain.ts` (genesis + hash + verifyChain) + tests + exports.
2. **Persistence**: AuditLog seq/prevHash/hash + chained `append` (both repos,
   mutex + unique backstop); AuditAnchor model + repo; `LedgerAdapter.anchor`
   (interface + simulated + EVM); wiring.
3. **API**: `POST /audit/anchor`, `GET /assets/:id/audit/verify`,
   `GET /audit/verify` + schemas + tests.
4. **Web**: Integrity view + client + types.
5. **Verify**: full suite, fresh deploy, live E2E incl. real DB tamper, review,
   merge.
