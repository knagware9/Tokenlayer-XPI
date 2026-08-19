# Ledger truth — design

**Status:** approved 2026-08-18
**Theme:** the database must never claim something the chain does not back.

## The problem, as observed

Three failures on 2026-08-18, all one missing concept. None was hypothetical;
each was reproduced on the running deployment.

1. **A mint left the register and the ledger disagreeing.** Tokenizing
   `INV-ERP-2026-206` on Besu created the asset row with `status: "active"` and
   wrote `ISSUE` + `ALLOW` to the audit chain. On-chain `totalSupply` was
   unchanged at 3000 and the holder's balance was `0`. The transaction sat
   unmined in the pool. Nothing in the system noticed, and nothing ever would
   have: no reconciliation exists.

2. **The HTTP request was the thing holding the mint.** `EvmLedgerAdapter.sendTx`
   does `await tx.wait(this.confirmations)` with **no timeout**
   (`packages/adapters/src/evm-adapter.ts:244`). On a chain that had lost QBFT
   consensus this never resolved: the browser spun indefinitely, and the React
   handler's `finally { setBusy(false) }` could not run because the promise
   never settled.

3. **Boot trusted the database about the chain.** After a Besu re-genesis,
   `GET /registry` still served `0x630e594e…`, an address that now held no
   bytecode. Boot reads the stored `RegistryDeployment` row and never asks the
   chain whether that code exists.

The product's core claim is that the ledger is the truth. These are three places
where the database was believed instead.

## Goals

- Every state-changing ledger operation has a **persisted, durable record** with
  an explicit lifecycle, so "we asked the chain to do this" is a fact that
  survives a crash, a restart, and a stalled chain.
- **No HTTP request ever blocks on chain confirmation.** Submission is
  synchronous; confirmation is not.
- A **reconciliation** pass can answer, per asset, "does what we believe match
  what the chain says?" — and surface drift to a human.
- Boot **verifies chain state it depends on** rather than trusting a stored row.

## Non-goals

- Key management (envelope encryption, KMS/HSM, `DID_MASTER_KEY` rotation). A
  genuinely separate subsystem; it gets its own spec and plan.
- Contract upgradeability / proxy patterns.
- Changing the simulated adapters' semantics. They confirm instantly and
  legitimately; the lifecycle must degrade to a single `confirmed` row for them
  rather than pretending they are pending.
- Retrying a *failed* transaction automatically. Recording the failure and
  surfacing it is in scope; deciding to re-mint is a human's call, because a
  blind retry of a mint that actually landed would double-issue.

## Design

### 1. `LedgerTransaction` — the durable record

A new table, owned by **`shared`** in `apps/api/src/persistence/model-domains.ts`:
both products write to chains (identity anchors DIDs and VCs, tokenization mints
and transfers), so neither owns it alone.

```
id, chainId, txHash, kind, amount?, assetId?, credentialId?, status,
attempts, nextAttemptAt, lastAttemptAt?, claimedAt?, claimedBy?,
blockNumber?, error?, submittedAt, confirmedAt?
```

`amount` is what makes believed supply **derivable** — the sum of confirmed
mints minus confirmed burns — rather than a figure the register asserts and
nothing can check. Reconciliation compares that derived number against the
chain, so both sides of the comparison are evidence.

`status` is `pending | confirmed | failed | unknown`.

`unknown` earns its place: a submitted transaction whose receipt we could not
obtain within the confirmation window is **not** failed. Calling it failed is
the mistake that leads to double-issuance when it later mines. It means exactly
"we know it was submitted and we do not yet know its outcome", which is the true
state of the invoice mint described above.

### 2. Submission and confirmation are separate

`EvmLedgerAdapter` gains a bounded wait, `confirmationTimeoutMs` (default
30 000). On timeout it returns the receipt it has — `txHash` and `chainId`, no
`blockNumber` — rather than throwing or hanging. The caller therefore always
learns the hash, which is what makes the transaction recoverable.

A **confirmer** worker resolves `pending` and `unknown` rows by polling
`eth_getTransactionReceipt`. It mirrors `apps/api/src/webhooks/dispatcher.ts`
exactly — `listDue` / CAS `claim` / `reclaimStale`, `nextAttemptAt` backoff,
`claimedBy` worker id — because that pattern is already proven, already tested
against two concurrent instances, and inventing a second one would be the drift
this codebase keeps paying for.

### 3. Asset status stops over-claiming

`Asset.status` must not read `active` on the strength of an unconfirmed mint.
An asset whose issuing transaction is `pending` or `unknown` reports
`status: "pending"`; it becomes `active` when the transaction confirms, and
`failed` when it fails. This is the change that would have made failure 1 visible
at the moment it happened.

### 4. Reconciliation

A service that, for a set of assets, compares believed supply and holder
balances against the adapter's on-chain reads, and returns the differences. It
is a **read-only report**: it never "fixes" the database, because a mismatch has
several possible causes and picking one automatically is how you turn a
reporting problem into a data-loss problem.

Exposed to platform admins and auditors as `GET /reconciliation`.

### 5. Boot asserts chain state

Before trusting a stored `RegistryDeployment`, verify the address still holds
bytecode. If it does not, treat the registries as undeployed and redeploy —
which is the same "real or absent, never silently mocked" rule the chain
registry already applies, extended to the registries themselves.

## Constraints

These are project-wide and already enforced by tests; the plan inherits them.

- **THE PARITY RULE.** A new persisted field lands in the Prisma schema, the
  record type, the mapper, and **both** repositories (memory and prisma), in one
  commit. `apps/api/test/persistence-parity.test.ts` fails otherwise.
- **THE ADDITIVITY RULE.** `fast-json-stringify` silently strips response fields
  absent from the schema. A new field on a response needs its schema entry.
- **Domain ownership.** A model absent from `MODEL_DOMAINS` throws at
  `classifyModel`; `apps/api/test/data-domains.test.ts` walks `schema.prisma` so
  a new table cannot exist without an owner.
- **No existing behavioural test may be edited.** They are the back-compat
  oracle. New behaviour gets new tests.
- Repositories reached from `AppDeps` need a `REPOSITORY_MODELS` entry, and the
  `AppDeps` field must be declared as `  name: XRepository;` (two-space indent,
  trailing semicolon) — `persistence-parity.test.ts` parses that shape.
