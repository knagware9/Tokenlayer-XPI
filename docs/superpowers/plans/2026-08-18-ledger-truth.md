# Ledger Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the database incapable of silently claiming something the chain does not back.

**Architecture:** Every state-changing ledger call gets a durable `LedgerTransaction` row with an explicit lifecycle. The EVM adapter's confirmation wait becomes bounded, so submission is synchronous and confirmation is not. A confirmer worker — mirroring the proven webhook dispatcher — resolves outstanding transactions. Asset status is derived from its issuing transaction rather than assumed. A read-only reconciliation report compares believed state to chain state, and boot verifies the registry addresses it depends on.

**Tech Stack:** TypeScript, Fastify 5, Prisma + SQLite, ethers v6, vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-ledger-truth-design.md`

## Global Constraints

- **THE PARITY RULE.** A persisted field lands in `schema.prisma`, the record type, the mapper, and **both** repositories (`persistence/memory/*`, `persistence/prisma/*`) in ONE commit. `apps/api/test/persistence-parity.test.ts` fails otherwise.
- **THE ADDITIVITY RULE.** `fast-json-stringify` silently strips response fields not declared in the route schema. A new response field needs its schema entry or it vanishes at runtime with no error.
- **Domain ownership.** Every model needs an entry in `MODEL_DOMAINS` (`apps/api/src/persistence/model-domains.ts`) or `classifyModel` throws; `apps/api/test/data-domains.test.ts` walks `schema.prisma` to enforce it.
- **`AppDeps` shape.** A repository on `AppDeps` must be declared exactly as `  name: XRepository;` — two-space indent, trailing semicolon — because `persistence-parity.test.ts` parses that shape. It also needs a `REPOSITORY_MODELS` entry.
- **No existing behavioural test may be edited.** They are the back-compat oracle. New behaviour gets new tests.
- **Run tests with explicit timeouts on this machine:** `npx vitest run <file> --testTimeout=45000 --hookTimeout=45000`. Six `packages/contracts/test/*` file-level failures are pre-existing (vitest cannot load Hardhat suites) — ignore them.
- **Never touch `apps/api/prisma/dev.db*`.** Throwaway DBs go to `apps/api/prisma/dev-<name>.db` and are deleted after use.
- After any `schema.prisma` change run `pnpm --filter @tokenlayer/api exec prisma generate`, or the Prisma client types will not know the new model.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/prisma/schema.prisma` | `LedgerTransaction` model |
| `apps/api/src/persistence/model-domains.ts` | Declares `LedgerTransaction` as `shared` |
| `apps/api/src/persistence/types/shared.ts` | `LedgerTxStatus`, `LedgerTxKind`, `LedgerTransactionRecord`, `LedgerTransactionRepository` |
| `apps/api/src/persistence/memory/shared.ts` | `MemoryLedgerTransactionRepository` |
| `apps/api/src/persistence/prisma/shared.ts` | `PrismaLedgerTransactionRepository` |
| `apps/api/src/context.ts` | `ledgerTransactions` on `AppDeps` |
| `packages/adapters/src/evm-adapter.ts` | Bounded confirmation wait |
| `apps/api/src/shared/ledger-confirmer.ts` | The confirmer worker |
| `apps/api/src/tokenization/reconciliation.ts` | Believed-vs-chain comparison (read-only) |
| `apps/api/src/identity/registry.ts` | Boot bytecode assertion |
| `apps/api/src/http/routes/shared.ts` | `GET /reconciliation` |
| `apps/api/src/http/schemas/shared.ts` | Its response schema |

---

## Task 1: The `LedgerTransaction` table and its two repositories

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/persistence/model-domains.ts`
- Modify: `apps/api/src/persistence/types/shared.ts`
- Modify: `apps/api/src/persistence/memory/shared.ts`
- Modify: `apps/api/src/persistence/prisma/shared.ts`
- Modify: `apps/api/src/context.ts`
- Test: `apps/api/test/ledger-transactions-repo.test.ts`

**Interfaces:**
- Produces: `LedgerTxStatus`, `LedgerTxKind`, `LedgerTransactionRecord`, `LedgerTransactionRepository`, `MemoryLedgerTransactionRepository`, `PrismaLedgerTransactionRepository`, and `AppDeps.ledgerTransactions`. Every later task consumes these.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/ledger-transactions-repo.test.ts`:

```ts
/**
 * THE DURABLE RECORD OF A LEDGER WRITE.
 *
 * The row exists so that "we asked the chain to do this" survives a crash, a
 * restart, and a chain that stops mining. The cases below are the ones that
 * actually bit: a transaction that never confirms must NOT read as failed, and
 * two confirmers must not both claim the same row.
 */
import { describe, expect, it } from "vitest";
import { MemoryLedgerTransactionRepository } from "../src/persistence/memory/index.js";

const base = { chainId: "besu", txHash: "0xabc", kind: "mint" as const, assetId: "a1" };
const at0 = "2026-08-18T10:00:00.000Z";

describe("LedgerTransactionRepository", () => {
  it("records a submission as pending", async () => {
    const repo = new MemoryLedgerTransactionRepository();
    const rec = await repo.record({ ...base, submittedAt: "2026-08-18T10:00:00.000Z" });
    expect(rec.status).toBe("pending");
    expect(rec.attempts).toBe(0);
    expect(rec.confirmedAt).toBeNull();
  });

  it("lists only rows that are due, oldest first", async () => {
    const repo = new MemoryLedgerTransactionRepository();
    const older = await repo.record({ ...base, txHash: "0x1", submittedAt: "2026-08-18T10:00:00.000Z" });
    await repo.record({ ...base, txHash: "0x2", submittedAt: "2026-08-18T10:00:01.000Z" });
    const settled = await repo.record({ ...base, txHash: "0x3", submittedAt: "2026-08-18T10:00:02.000Z" });
    await repo.settle(settled.id, { status: "confirmed", blockNumber: 7, confirmedAt: "2026-08-18T10:00:03.000Z" });

    const due = await repo.listDue("2026-08-18T11:00:00.000Z", 10);
    expect(due.map((r) => r.txHash)).toEqual(["0x1", "0x2"]);
    expect(due[0]!.id).toBe(older.id);
  });

  it("CAS claim: the second claimer gets null", async () => {
    // Without this two confirmers double-poll the same hash and race on settle.
    const repo = new MemoryLedgerTransactionRepository();
    const rec = await repo.record({ ...base, submittedAt: "2026-08-18T10:00:00.000Z" });
    const first = await repo.claim(rec.id, "worker-a", "2026-08-18T10:00:01.000Z");
    const second = await repo.claim(rec.id, "worker-b", "2026-08-18T10:00:02.000Z");
    expect(first?.claimedBy).toBe("worker-a");
    expect(second).toBeNull();
  });

  it("an unconfirmed transaction is 'unknown', NEVER 'failed'", async () => {
    // The distinction is the whole point. A submitted mint whose receipt we
    // cannot obtain may still land; calling it failed invites a re-mint and
    // double-issuance.
    const repo = new MemoryLedgerTransactionRepository();
    const rec = await repo.record({ ...base, submittedAt: "2026-08-18T10:00:00.000Z" });
    const out = await repo.settle(rec.id, { status: "unknown", error: "no receipt within 30000ms" });
    expect(out.status).toBe("unknown");
    expect(out.confirmedAt).toBeNull();
  });

  it("reclaims a claim left behind by a crashed worker", async () => {
    const repo = new MemoryLedgerTransactionRepository();
    const rec = await repo.record({ ...base, submittedAt: "2026-08-18T10:00:00.000Z" });
    await repo.claim(rec.id, "worker-a", "2026-08-18T10:00:01.000Z");
    const n = await repo.reclaimStale("2026-08-18T10:05:00.000Z");
    expect(n).toBe(1);
    const due = await repo.listDue("2026-08-18T10:06:00.000Z", 10);
    expect(due.map((r) => r.id)).toEqual([rec.id]);
  });

  it("derives believed supply from CONFIRMED mints and burns only", async () => {
    // Pending work must not count toward believed supply, or reconciliation
    // compares the chain against a number that includes what has not happened.
    const repo = new MemoryLedgerTransactionRepository();
    const minted = await repo.record({ ...base, txHash: "0xm", kind: "mint", amount: "500", submittedAt: at0 });
    await repo.settle(minted.id, { status: "confirmed", blockNumber: 1, confirmedAt: at0 });
    const burned = await repo.record({ ...base, txHash: "0xb", kind: "burn", amount: "200", submittedAt: at0 });
    await repo.settle(burned.id, { status: "confirmed", blockNumber: 2, confirmedAt: at0 });
    await repo.record({ ...base, txHash: "0xp", kind: "mint", amount: "999", submittedAt: at0 }); // still pending
    expect(await repo.settledSupply("a1")).toBe("300");
  });

  it("finds outstanding rows for one asset", async () => {
    const repo = new MemoryLedgerTransactionRepository();
    await repo.record({ ...base, txHash: "0x1", submittedAt: "2026-08-18T10:00:00.000Z" });
    const other = await repo.record({ ...base, assetId: "a2", txHash: "0x2", submittedAt: "2026-08-18T10:00:01.000Z" });
    await repo.settle(other.id, { status: "confirmed", blockNumber: 1, confirmedAt: "2026-08-18T10:00:02.000Z" });
    expect((await repo.listByAsset("a1")).map((r) => r.txHash)).toEqual(["0x1"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/api/test/ledger-transactions-repo.test.ts --testTimeout=45000
```

Expected: FAIL — `MemoryLedgerTransactionRepository` is not exported.

- [ ] **Step 3: Add the Prisma model**

Append to `apps/api/prisma/schema.prisma`:

```prisma
// A state-changing ledger call we have made, and what became of it.
//
// SUBMISSION AND CONFIRMATION ARE SEPARATE FACTS. Before this table the only
// record of a mint was the Asset row, written optimistically; a transaction that
// never mined left the register saying "active" while the chain held nothing.
model LedgerTransaction {
  id            String    @id @default(cuid())
  chainId       String
  txHash        String
  kind          String // deploy | mint | transfer | burn | freeze | allow | anchor
  // Units moved, for mint/transfer/burn. This is what makes believed supply
  // DERIVABLE (sum of confirmed mints minus confirmed burns) instead of a
  // number the register asserts and nothing can check.
  amount        String?
  assetId       String?
  credentialId  String?
  // pending | confirmed | failed | unknown.
  // `unknown` is NOT failure: it means submitted, outcome not yet known. Calling
  // it failed is what leads to a re-mint and double-issuance.
  status        String    @default("pending")
  attempts      Int       @default(0)
  nextAttemptAt DateTime  @default(now())
  lastAttemptAt DateTime?
  claimedAt     DateTime?
  claimedBy     String?
  blockNumber   Int?
  error         String?
  submittedAt   DateTime  @default(now())
  confirmedAt   DateTime?

  @@unique([chainId, txHash])
  @@index([status, nextAttemptAt])
  @@index([assetId])
}
```

- [ ] **Step 4: Declare who owns it**

In `apps/api/src/persistence/model-domains.ts`, add to `MODEL_DOMAINS` under the shared section:

```ts
  // Both products write to chains — identity anchors DIDs and VCs, tokenization
  // mints and transfers — so neither owns the record of those writes.
  LedgerTransaction: "shared",
```

and to `REPOSITORY_MODELS`:

```ts
  ledgerTransactions: "LedgerTransaction",
```

- [ ] **Step 5: Add the types**

In `apps/api/src/persistence/types/shared.ts`:

```ts
export type LedgerTxStatus = "pending" | "confirmed" | "failed" | "unknown";
export type LedgerTxKind = "deploy" | "mint" | "transfer" | "burn" | "freeze" | "allow" | "anchor";

export interface LedgerTransactionRecord {
  id: string;
  chainId: string;
  txHash: string;
  kind: LedgerTxKind;
  amount: string | null;
  assetId: string | null;
  credentialId: string | null;
  status: LedgerTxStatus;
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  claimedAt: string | null;
  claimedBy: string | null;
  blockNumber: number | null;
  error: string | null;
  submittedAt: string;
  confirmedAt: string | null;
}

export interface LedgerTransactionSettlement {
  status: LedgerTxStatus;
  blockNumber?: number;
  confirmedAt?: string;
  error?: string;
}

export interface LedgerTransactionRepository {
  /** Idempotent on (chainId, txHash): re-recording the same submission returns the existing row. */
  record(input: {
    chainId: string; txHash: string; kind: LedgerTxKind; amount?: string | null;
    assetId?: string | null; credentialId?: string | null; submittedAt: string;
  }): Promise<LedgerTransactionRecord>;
  findById(id: string): Promise<LedgerTransactionRecord | null>;
  /** Confirmed mints minus confirmed burns for one asset — the believed supply. */
  settledSupply(assetId: string): Promise<string>;
  /** Due = (pending|unknown) and nextAttemptAt <= now, oldest first. */
  listDue(now: string, limit: number): Promise<LedgerTransactionRecord[]>;
  /** CAS claim, mirroring WebhookDeliveryRepository.claim — null if another worker won. */
  claim(id: string, workerId: string, now: string): Promise<LedgerTransactionRecord | null>;
  /** Claims left behind by a crashed worker. Returns how many were released. */
  reclaimStale(before: string): Promise<number>;
  /** Outstanding (pending|unknown) rows for one asset, oldest first. */
  listByAsset(assetId: string): Promise<LedgerTransactionRecord[]>;
  settle(id: string, settlement: LedgerTransactionSettlement): Promise<LedgerTransactionRecord>;
  /** Records one more failed poll and backs off. */
  defer(id: string, nextAttemptAt: string, now: string, error?: string): Promise<LedgerTransactionRecord>;
}
```

- [ ] **Step 6: Implement the memory repository**

In `apps/api/src/persistence/memory/shared.ts` (imports `id`, `now` from `./common.js` — already present):

```ts
export class MemoryLedgerTransactionRepository implements LedgerTransactionRepository {
  private readonly byId = new Map<string, LedgerTransactionRecord>();

  async record(input: {
    chainId: string; txHash: string; kind: LedgerTxKind; amount?: string | null;
    assetId?: string | null; credentialId?: string | null; submittedAt: string;
  }): Promise<LedgerTransactionRecord> {
    const existing = [...this.byId.values()].find((r) => r.chainId === input.chainId && r.txHash === input.txHash);
    if (existing) return { ...existing };
    const rec: LedgerTransactionRecord = {
      id: id("ltx"), chainId: input.chainId, txHash: input.txHash, kind: input.kind,
      amount: input.amount ?? null,
      assetId: input.assetId ?? null, credentialId: input.credentialId ?? null,
      status: "pending", attempts: 0, nextAttemptAt: input.submittedAt, lastAttemptAt: null,
      claimedAt: null, claimedBy: null, blockNumber: null, error: null,
      submittedAt: input.submittedAt, confirmedAt: null,
    };
    this.byId.set(rec.id, rec);
    return { ...rec };
  }

  async findById(txId: string): Promise<LedgerTransactionRecord | null> {
    const r = this.byId.get(txId);
    return r ? { ...r } : null;
  }

  async listDue(nowIso: string, limit: number): Promise<LedgerTransactionRecord[]> {
    // createdAt/nextAttemptAt are ISO STRINGS here, so compare as strings —
    // calling .getTime() on them throws, and only with 2+ rows.
    return [...this.byId.values()]
      .filter((r) => (r.status === "pending" || r.status === "unknown") && !r.claimedAt && r.nextAttemptAt <= nowIso)
      .sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async claim(txId: string, workerId: string, nowIso: string): Promise<LedgerTransactionRecord | null> {
    const r = this.byId.get(txId);
    if (!r || r.claimedAt) return null;
    if (r.status !== "pending" && r.status !== "unknown") return null;
    r.claimedAt = nowIso; r.claimedBy = workerId;
    return { ...r };
  }

  async reclaimStale(before: string): Promise<number> {
    let n = 0;
    for (const r of this.byId.values()) {
      if (r.claimedAt && r.claimedAt < before) { r.claimedAt = null; r.claimedBy = null; n++; }
    }
    return n;
  }

  async listByAsset(assetId: string): Promise<LedgerTransactionRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.assetId === assetId && (r.status === "pending" || r.status === "unknown"))
      .sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0))
      .map((r) => ({ ...r }));
  }

  async settledSupply(assetId: string): Promise<string> {
    // BigInt, not Number: token amounts routinely exceed 2^53 and a float here
    // would silently round the very quantity being reconciled.
    let total = 0n;
    for (const r of this.byId.values()) {
      if (r.assetId !== assetId || r.status !== "confirmed" || !r.amount) continue;
      if (r.kind === "mint") total += BigInt(r.amount);
      if (r.kind === "burn") total -= BigInt(r.amount);
    }
    return total.toString();
  }

  async settle(txId: string, s: LedgerTransactionSettlement): Promise<LedgerTransactionRecord> {
    const r = this.byId.get(txId);
    if (!r) throw new Error(`unknown ledger transaction '${txId}'`);
    r.status = s.status;
    r.blockNumber = s.blockNumber ?? r.blockNumber;
    r.confirmedAt = s.confirmedAt ?? null;
    r.error = s.error ?? null;
    r.claimedAt = null; r.claimedBy = null;
    return { ...r };
  }

  async defer(txId: string, nextAttemptAt: string, nowIso: string, error?: string): Promise<LedgerTransactionRecord> {
    const r = this.byId.get(txId);
    if (!r) throw new Error(`unknown ledger transaction '${txId}'`);
    r.attempts += 1; r.nextAttemptAt = nextAttemptAt; r.lastAttemptAt = nowIso;
    r.error = error ?? r.error; r.claimedAt = null; r.claimedBy = null;
    return { ...r };
  }
}
```

- [ ] **Step 7: Run the test — it must pass now**

```bash
npx vitest run apps/api/test/ledger-transactions-repo.test.ts --testTimeout=45000
```

Expected: PASS, 7 tests.

- [ ] **Step 8: Implement the Prisma twin**

In `apps/api/src/persistence/prisma/shared.ts`:

```ts
const toLedgerTx = (r: {
  id: string; chainId: string; txHash: string; kind: string; amount: string | null; assetId: string | null;
  credentialId: string | null; status: string; attempts: number; nextAttemptAt: Date;
  lastAttemptAt: Date | null; claimedAt: Date | null; claimedBy: string | null;
  blockNumber: number | null; error: string | null; submittedAt: Date; confirmedAt: Date | null;
}): LedgerTransactionRecord => ({
  id: r.id, chainId: r.chainId, txHash: r.txHash, kind: r.kind as LedgerTxKind, amount: r.amount,
  assetId: r.assetId, credentialId: r.credentialId, status: r.status as LedgerTxStatus,
  attempts: r.attempts, nextAttemptAt: r.nextAttemptAt.toISOString(),
  lastAttemptAt: r.lastAttemptAt ? r.lastAttemptAt.toISOString() : null,
  claimedAt: r.claimedAt ? r.claimedAt.toISOString() : null, claimedBy: r.claimedBy,
  blockNumber: r.blockNumber, error: r.error,
  submittedAt: r.submittedAt.toISOString(),
  confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
});

export class PrismaLedgerTransactionRepository implements LedgerTransactionRepository {
  async record(input: {
    chainId: string; txHash: string; kind: LedgerTxKind; amount?: string | null;
    assetId?: string | null; credentialId?: string | null; submittedAt: string;
  }): Promise<LedgerTransactionRecord> {
    const row = await prisma.ledgerTransaction.upsert({
      where: { chainId_txHash: { chainId: input.chainId, txHash: input.txHash } },
      update: {},
      create: {
        chainId: input.chainId, txHash: input.txHash, kind: input.kind, amount: input.amount ?? null,
        assetId: input.assetId ?? null, credentialId: input.credentialId ?? null,
        status: "pending", submittedAt: new Date(input.submittedAt),
        nextAttemptAt: new Date(input.submittedAt),
      },
    });
    return toLedgerTx(row);
  }

  async findById(id: string): Promise<LedgerTransactionRecord | null> {
    const row = await prisma.ledgerTransaction.findUnique({ where: { id } });
    return row ? toLedgerTx(row) : null;
  }

  async listDue(now: string, limit: number): Promise<LedgerTransactionRecord[]> {
    const rows = await prisma.ledgerTransaction.findMany({
      where: { status: { in: ["pending", "unknown"] }, claimedAt: null, nextAttemptAt: { lte: new Date(now) } },
      orderBy: { submittedAt: "asc" }, take: limit,
    });
    return rows.map(toLedgerTx);
  }

  async claim(id: string, workerId: string, now: string): Promise<LedgerTransactionRecord | null> {
    // CAS: the WHERE carries claimedAt:null, so a loser updates 0 rows.
    const res = await prisma.ledgerTransaction.updateMany({
      where: { id, claimedAt: null, status: { in: ["pending", "unknown"] } },
      data: { claimedAt: new Date(now), claimedBy: workerId },
    });
    if (res.count === 0) return null;
    return this.findById(id);
  }

  async reclaimStale(before: string): Promise<number> {
    const res = await prisma.ledgerTransaction.updateMany({
      where: { claimedAt: { lt: new Date(before) } },
      data: { claimedAt: null, claimedBy: null },
    });
    return res.count;
  }

  async listByAsset(assetId: string): Promise<LedgerTransactionRecord[]> {
    const rows = await prisma.ledgerTransaction.findMany({
      where: { assetId, status: { in: ["pending", "unknown"] } },
      orderBy: { submittedAt: "asc" },
    });
    return rows.map(toLedgerTx);
  }

  async settledSupply(assetId: string): Promise<string> {
    const rows = await prisma.ledgerTransaction.findMany({
      where: { assetId, status: "confirmed", kind: { in: ["mint", "burn"] } },
      select: { kind: true, amount: true },
    });
    // BigInt, not Number: a float would silently round the quantity being reconciled.
    let total = 0n;
    for (const r of rows) {
      if (!r.amount) continue;
      total += r.kind === "mint" ? BigInt(r.amount) : -BigInt(r.amount);
    }
    return total.toString();
  }

  async settle(id: string, s: LedgerTransactionSettlement): Promise<LedgerTransactionRecord> {
    const row = await prisma.ledgerTransaction.update({
      where: { id },
      data: {
        status: s.status,
        blockNumber: s.blockNumber ?? undefined,
        confirmedAt: s.confirmedAt ? new Date(s.confirmedAt) : null,
        error: s.error ?? null, claimedAt: null, claimedBy: null,
      },
    });
    return toLedgerTx(row);
  }

  async defer(id: string, nextAttemptAt: string, now: string, error?: string): Promise<LedgerTransactionRecord> {
    const row = await prisma.ledgerTransaction.update({
      where: { id },
      data: {
        attempts: { increment: 1 }, nextAttemptAt: new Date(nextAttemptAt),
        lastAttemptAt: new Date(now), error: error ?? undefined,
        claimedAt: null, claimedBy: null,
      },
    });
    return toLedgerTx(row);
  }
}
```

- [ ] **Step 9: Wire it onto `AppDeps`**

In `apps/api/src/context.ts`, inside the `AppDeps` interface — exact two-space indent and trailing semicolon:

```ts
  ledgerTransactions: LedgerTransactionRepository;
```

Add `LedgerTransactionRepository` to the existing import from `./persistence/types/index.js`. Then wire the concrete repository at every construction site that builds `AppDeps` (search: `rg -l "webhookDeliveries:" apps/api/src apps/api/test`) — `new MemoryLedgerTransactionRepository()` in the memory/test wiring, `new PrismaLedgerTransactionRepository()` in `apps/api/src/server.ts`.

- [ ] **Step 10: Regenerate Prisma and typecheck**

```bash
pnpm --filter @tokenlayer/api exec prisma generate && npx tsc --noEmit -p apps/api
```

Expected: 0 errors. A missing construction site shows up here as a compile error, which is why `ledgerTransactions` is required rather than optional.

- [ ] **Step 11: Prove the invariant tests accept it**

```bash
npx vitest run apps/api/test/persistence-parity.test.ts apps/api/test/data-domains.test.ts --testTimeout=45000
```

Expected: PASS. `persistence-parity` confirms both twins exist in `shared`; `data-domains` confirms the new model is classified.

- [ ] **Step 12: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence apps/api/src/context.ts apps/api/src/server.ts apps/api/test/ledger-transactions-repo.test.ts
git commit -m "feat(ledger): a durable record of every chain write"
```

---

## Task 2: The adapter stops blocking forever

**Files:**
- Modify: `packages/adapters/src/evm-adapter.ts:239-246`
- Test: `packages/adapters/test/evm-confirmation-timeout.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `EvmAdapterConfig.confirmationTimeoutMs?: number` (default 30000). `sendTx` still returns `TxReceipt`, but on timeout `blockNumber` is `undefined` — the signal Task 4 uses to mean "submitted, outcome unknown".

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/test/evm-confirmation-timeout.test.ts`:

```ts
/**
 * A CHAIN THAT STOPS MINING MUST NOT HANG THE CALLER.
 *
 * `sendTx` awaited `tx.wait()` with no bound. When Besu lost QBFT consensus the
 * HTTP request never returned, the browser spinner never cleared, and the
 * transaction was invisible because its hash was never surfaced. The hash is
 * exactly what makes it recoverable, so a timeout must RETURN it, not throw.
 */
import { describe, expect, it } from "vitest";
import { waitForReceipt } from "../src/evm-adapter.js";

describe("bounded confirmation", () => {
  it("returns the receipt when it arrives in time", async () => {
    const tx = { hash: "0xaaa", wait: async () => ({ blockNumber: 42 }) };
    expect(await waitForReceipt(tx, 1, 1000)).toEqual({ blockNumber: 42 });
  });

  it("returns null — not a throw — when the wait exceeds the budget", async () => {
    const never = { hash: "0xbbb", wait: () => new Promise<never>(() => {}) };
    expect(await waitForReceipt(never, 1, 50)).toBeNull();
  });

  it("propagates a genuine revert rather than swallowing it as a timeout", async () => {
    // A reverted transaction is a real answer and must not be reported as
    // "unknown" — the two lead to opposite operator decisions.
    const reverted = { hash: "0xccc", wait: async () => { throw new Error("execution reverted"); } };
    await expect(waitForReceipt(reverted, 1, 1000)).rejects.toThrow("execution reverted");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run packages/adapters/test/evm-confirmation-timeout.test.ts --testTimeout=45000
```

Expected: FAIL — `waitForReceipt` is not exported.

- [ ] **Step 3: Implement it**

In `packages/adapters/src/evm-adapter.ts`, above the class:

```ts
/**
 * Await a receipt for at most `timeoutMs`.
 *
 * RETURNS NULL ON TIMEOUT, THROWS ON REVERT. The two outcomes are different
 * facts and lead to opposite decisions: a revert is final and the operator must
 * not retry blindly, while a timeout means the transaction may still land and
 * re-sending it would double-issue. Collapsing them into one error is how a
 * stalled chain becomes a data-integrity incident.
 */
export async function waitForReceipt(
  tx: { wait: (c?: number) => Promise<unknown> },
  confirmations: number,
  timeoutMs: number,
): Promise<{ blockNumber?: number } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    return (await Promise.race([tx.wait(confirmations), timeout])) as { blockNumber?: number } | null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

Add to `EvmAdapterConfig` (near `confirmations?: number;` at line 121):

```ts
  /** How long to await a receipt before returning the hash unconfirmed. Default 30s. */
  confirmationTimeoutMs?: number;
```

Assign it beside `this.confirmations` (line 159):

```ts
    this.confirmationTimeoutMs = config.confirmationTimeoutMs ?? 30_000;
```

with the field declared next to `private readonly confirmations: number;`:

```ts
  private readonly confirmationTimeoutMs: number;
```

Replace the body of `sendTx`:

```ts
  private async sendTx(
    build: (overrides: Record<string, unknown>) => Promise<{ hash: string; wait: (c?: number) => Promise<unknown> }>,
  ): Promise<TxReceipt> {
    const tx = await build(this.gasOverrides());
    const receipt = await waitForReceipt(tx, this.confirmations, this.confirmationTimeoutMs);
    // No blockNumber means "submitted, not yet known" — never "failed".
    return { txHash: tx.hash, chainId: this.chainId, blockNumber: receipt?.blockNumber, timestamp: new Date().toISOString() };
  }
```

- [ ] **Step 4: Run the test — it must pass**

```bash
npx vitest run packages/adapters/test/evm-confirmation-timeout.test.ts --testTimeout=45000
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Prove the existing adapter contract still holds**

```bash
npx vitest run packages/adapters --testTimeout=45000
```

Expected: the existing `LedgerAdapter contract: EvmLedgerAdapter` suite passes unchanged — confirmation still works on a live chain.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/evm-adapter.ts packages/adapters/test/evm-confirmation-timeout.test.ts
git commit -m "fix(adapters): bound the confirmation wait so a stalled chain cannot hang the caller"
```

---

## Task 3: Record every submission

**Files:**
- Create: `apps/api/src/shared/ledger-transactions.ts`
- Modify: `apps/api/src/http/routes/context.ts`
- Test: `apps/api/test/ledger-transaction-recording.test.ts`

**Interfaces:**
- Consumes: `AppDeps.ledgerTransactions`, `LedgerTxKind` (Task 1); `TxReceipt` from `@tokenlayer/core`.
- Produces: `recordSubmission(deps, kind, receipt, refs)` returning `Promise<LedgerTransactionRecord>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/ledger-transaction-recording.test.ts`:

```ts
/**
 * EVERY CHAIN WRITE LEAVES A ROW, and a receipt without a block number is
 * recorded as PENDING rather than assumed good. This is the seam that made the
 * invoice mint invisible: the adapter returned, the asset was marked active,
 * and nothing recorded that a transaction was outstanding.
 */
import { describe, expect, it } from "vitest";
import { MemoryLedgerTransactionRepository } from "../src/persistence/memory/index.js";
import { recordSubmission } from "../src/shared/ledger-transactions.js";

describe("recordSubmission", () => {
  it("records a confirmed receipt as confirmed", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await recordSubmission({ ledgerTransactions }, "mint", {
      txHash: "0x1", chainId: "besu", blockNumber: 9, timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(rec.status).toBe("confirmed");
    expect(rec.blockNumber).toBe(9);
  });

  it("records a receipt with NO block number as pending", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await recordSubmission({ ledgerTransactions }, "mint", {
      txHash: "0x2", chainId: "besu", timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(rec.status).toBe("pending");
    expect(rec.blockNumber).toBeNull();
  });

  it("is idempotent on (chainId, txHash)", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const r = { txHash: "0x3", chainId: "besu", timestamp: "2026-08-18T10:00:00.000Z" };
    const a = await recordSubmission({ ledgerTransactions }, "mint", r, { assetId: "a1" });
    const b = await recordSubmission({ ledgerTransactions }, "mint", r, { assetId: "a1" });
    expect(b.id).toBe(a.id);
  });

  it("a simulated chain's instant receipt is confirmed, not pending", async () => {
    // Simulated adapters genuinely finalise on return. Recording them as pending
    // would fill the confirmer's queue with rows no chain can ever answer for.
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await recordSubmission({ ledgerTransactions }, "mint", {
      txHash: "sim:abc", chainId: "fabric", blockNumber: 1, timestamp: "2026-08-18T10:00:00.000Z",
    }, { assetId: "a1" });
    expect(rec.status).toBe("confirmed");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/api/test/ledger-transaction-recording.test.ts --testTimeout=45000
```

Expected: FAIL — module `../src/shared/ledger-transactions.js` not found.

- [ ] **Step 3: Implement it**

Create `apps/api/src/shared/ledger-transactions.ts`:

```ts
/**
 * RECORDING WHAT WE ASKED THE CHAIN TO DO.
 *
 * One seam, called by every path that produces a TxReceipt, so that a chain
 * write is never a fact known only to a variable on the stack.
 *
 * The block number is the whole signal. An adapter that confirmed returns one;
 * an adapter that timed out returns a hash and nothing else. Treating the second
 * case as success is precisely the bug this exists to end.
 */
import type { TxReceipt } from "@tokenlayer/core";
import type { LedgerTransactionRecord, LedgerTransactionRepository, LedgerTxKind } from "../persistence/types/index.js";

export async function recordSubmission(
  deps: { ledgerTransactions: LedgerTransactionRepository },
  kind: LedgerTxKind,
  receipt: TxReceipt,
  refs: { assetId?: string | null; credentialId?: string | null; amount?: string | null } = {},
): Promise<LedgerTransactionRecord> {
  const rec = await deps.ledgerTransactions.record({
    chainId: receipt.chainId, txHash: receipt.txHash, kind, amount: refs.amount ?? null,
    assetId: refs.assetId ?? null, credentialId: refs.credentialId ?? null,
    submittedAt: receipt.timestamp,
  });
  if (receipt.blockNumber === undefined || rec.status !== "pending") return rec;
  return deps.ledgerTransactions.settle(rec.id, {
    status: "confirmed", blockNumber: receipt.blockNumber, confirmedAt: receipt.timestamp,
  });
}
```

- [ ] **Step 4: Run the test — it must pass**

```bash
npx vitest run apps/api/test/ledger-transaction-recording.test.ts --testTimeout=45000
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Call it from the issue path**

In `apps/api/src/http/routes/context.ts`, find where `deps.engine.issue(...)` returns and the asset row is created. Immediately after the receipt is available, add:

```ts
  await recordSubmission(deps, "deploy", result.receipt, { assetId: asset.id });
```

Import at the top of the file:

```ts
import { recordSubmission } from "../../shared/ledger-transactions.js";
```

Do the same at each mint/transfer/burn call site in `apps/api/src/http/routes/tokenization.ts`, passing the matching `LedgerTxKind` and `{ assetId }`.

- [ ] **Step 6: Prove nothing regressed**

```bash
npx vitest run apps/api --testTimeout=45000 --hookTimeout=45000
```

Expected: every existing suite still passes; no existing test was edited.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/shared/ledger-transactions.ts apps/api/src/http/routes apps/api/test/ledger-transaction-recording.test.ts
git commit -m "feat(ledger): record every submission, and never assume an unconfirmed one succeeded"
```

---

## Task 4: The confirmer

**Files:**
- Create: `apps/api/src/shared/ledger-confirmer.ts`
- Modify: `apps/api/src/server.ts:228-245`
- Test: `apps/api/test/ledger-confirmer.test.ts`

**Interfaces:**
- Consumes: `LedgerTransactionRepository` (Task 1).
- Produces: `runConfirmerOnce(deps, opts)` and `startConfirmer(deps, opts)` returning a `() => void` stop function, mirroring `startDispatcher`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/ledger-confirmer.test.ts`:

```ts
/**
 * RESOLVING WHAT THE CHAIN ACTUALLY DID.
 *
 * Mirrors webhooks/dispatcher.ts deliberately — listDue, CAS claim, backoff,
 * reclaimStale — because that pattern is already proven against two concurrent
 * instances and a second design would be drift.
 */
import { describe, expect, it } from "vitest";
import { MemoryLedgerTransactionRepository } from "../src/persistence/memory/index.js";
import { runConfirmerOnce } from "../src/shared/ledger-confirmer.js";

const at = (s: string) => `2026-08-18T10:00:0${s}.000Z`;

describe("the confirmer", () => {
  it("confirms a transaction the chain has mined", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await ledgerTransactions.record({ chainId: "besu", txHash: "0x1", kind: "mint", assetId: "a1", submittedAt: at("0") });
    await runConfirmerOnce(
      { ledgerTransactions },
      { workerId: "w1", now: at("1"), getReceipt: async () => ({ blockNumber: 12, status: 1 }) },
    );
    expect((await ledgerTransactions.findById(rec.id))?.status).toBe("confirmed");
    expect((await ledgerTransactions.findById(rec.id))?.blockNumber).toBe(12);
  });

  it("marks a reverted transaction failed", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await ledgerTransactions.record({ chainId: "besu", txHash: "0x2", kind: "mint", assetId: "a1", submittedAt: at("0") });
    await runConfirmerOnce(
      { ledgerTransactions },
      { workerId: "w1", now: at("1"), getReceipt: async () => ({ blockNumber: 12, status: 0 }) },
    );
    const out = await ledgerTransactions.findById(rec.id);
    expect(out?.status).toBe("failed");
  });

  it("defers — does NOT fail — a transaction with no receipt yet", async () => {
    // The stalled-chain case. Backing off leaves it recoverable; failing it
    // would invite a re-mint of a transaction that may still land.
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await ledgerTransactions.record({ chainId: "besu", txHash: "0x3", kind: "mint", assetId: "a1", submittedAt: at("0") });
    await runConfirmerOnce(
      { ledgerTransactions },
      { workerId: "w1", now: at("1"), getReceipt: async () => null },
    );
    const out = await ledgerTransactions.findById(rec.id);
    expect(out?.status).toBe("pending");
    expect(out?.attempts).toBe(1);
    expect(out?.claimedAt).toBeNull();
  });

  it("gives up into 'unknown' after the attempt ceiling, never into 'failed'", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const rec = await ledgerTransactions.record({ chainId: "besu", txHash: "0x4", kind: "mint", assetId: "a1", submittedAt: at("0") });
    for (let i = 0; i < 12; i++) {
      await runConfirmerOnce(
        { ledgerTransactions },
        { workerId: "w1", now: at("1"), getReceipt: async () => null, maxAttempts: 10 },
      );
    }
    const out = await ledgerTransactions.findById(rec.id);
    expect(out?.status).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/api/test/ledger-confirmer.test.ts --testTimeout=45000
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

Create `apps/api/src/shared/ledger-confirmer.ts`:

```ts
/**
 * RESOLVES OUTSTANDING LEDGER TRANSACTIONS.
 *
 * A deliberate mirror of `webhooks/dispatcher.ts`: listDue → CAS claim → act →
 * settle or defer, plus reclaimStale for crash recovery. That shape is already
 * proven safe with two instances polling one table, and this file exists to
 * reuse it rather than invent a second one.
 *
 * THE CEILING LEADS TO `unknown`, NOT `failed`. After enough silent polls we
 * stop asking, but we have learned nothing about the outcome — and a mint
 * recorded as failed is a mint someone re-issues.
 */
import type { LedgerTransactionRepository } from "../persistence/types/index.js";

const STALE_CLAIM_MS = 60_000;
const BASE_BACKOFF_MS = 5_000;

export interface ConfirmerOptions {
  workerId: string;
  now: string;
  /** Resolves a receipt, or null when the chain does not have one yet. */
  getReceipt: (chainId: string, txHash: string) => Promise<{ blockNumber?: number; status?: number } | null>;
  maxAttempts?: number;
  limit?: number;
}

export async function runConfirmerOnce(
  deps: { ledgerTransactions: LedgerTransactionRepository },
  opts: ConfirmerOptions,
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 10;
  const nowMs = new Date(opts.now).getTime();
  await deps.ledgerTransactions.reclaimStale(new Date(nowMs - STALE_CLAIM_MS).toISOString());

  for (const row of await deps.ledgerTransactions.listDue(opts.now, opts.limit ?? 25)) {
    const claimed = await deps.ledgerTransactions.claim(row.id, opts.workerId, opts.now);
    if (!claimed) continue; // another worker won the race

    let receipt: { blockNumber?: number; status?: number } | null = null;
    let error: string | undefined;
    try {
      receipt = await opts.getReceipt(claimed.chainId, claimed.txHash);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (receipt && receipt.status === 0) {
      await deps.ledgerTransactions.settle(claimed.id, { status: "failed", blockNumber: receipt.blockNumber, error: "reverted" });
      continue;
    }
    if (receipt) {
      await deps.ledgerTransactions.settle(claimed.id, { status: "confirmed", blockNumber: receipt.blockNumber, confirmedAt: opts.now });
      continue;
    }
    if (claimed.attempts + 1 >= maxAttempts) {
      await deps.ledgerTransactions.settle(claimed.id, { status: "unknown", error: error ?? `no receipt after ${maxAttempts} polls` });
      continue;
    }
    const backoff = BASE_BACKOFF_MS * 2 ** claimed.attempts;
    await deps.ledgerTransactions.defer(claimed.id, new Date(nowMs + backoff).toISOString(), opts.now, error);
  }
}

/** Polling loop. Returns a stop function, mirroring startDispatcher. */
export function startConfirmer(
  deps: { ledgerTransactions: LedgerTransactionRepository },
  opts: Omit<ConfirmerOptions, "now"> & { intervalMs?: number },
): () => void {
  const interval = setInterval(() => {
    void runConfirmerOnce(deps, { ...opts, now: new Date().toISOString() }).catch(() => {
      /* a poll failure must not kill the loop; the row stays due */
    });
  }, opts.intervalMs ?? 5_000);
  return () => clearInterval(interval);
}
```

- [ ] **Step 4: Run the test — it must pass**

```bash
npx vitest run apps/api/test/ledger-confirmer.test.ts --testTimeout=45000
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Start it in the server**

In `apps/api/src/server.ts`, beside the existing `startDispatcher(...)` call (around line 233):

```ts
  const stopConfirmer = startConfirmer(deps, {
    workerId,
    getReceipt: async (chainId, txHash) => {
      const chain = deps.chains.get(chainId);
      // A chain that is absent here is not a failed transaction — leaving the
      // row due means it resolves when the chain returns.
      if (!chain?.provider) return null;
      const r = await chain.provider.getTransactionReceipt(txHash);
      return r ? { blockNumber: r.blockNumber, status: r.status ?? 1 } : null;
    },
  });
```

Register `stopConfirmer()` alongside the dispatcher's stop in the shutdown path. Import `startConfirmer` from `./shared/ledger-confirmer.js`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/shared/ledger-confirmer.ts apps/api/src/server.ts apps/api/test/ledger-confirmer.test.ts
git commit -m "feat(ledger): a confirmer that resolves outstanding transactions"
```

---

## Task 5: Asset status stops over-claiming

**Files:**
- Modify: `apps/api/src/http/routes/context.ts` (the asset view helper)
- Modify: `apps/api/src/http/schemas/tokenization.ts`
- Test: `apps/api/test/asset-status-reflects-chain.test.ts`

**Interfaces:**
- Consumes: `LedgerTransactionRepository.listByAsset` (Task 1).
- Produces: `settlementStatus(deps, asset)` returning `Promise<"active" | "pending" | "failed">`, and an added `settlement` field on the asset response.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/asset-status-reflects-chain.test.ts`:

```ts
/**
 * AN ASSET IS NOT ACTIVE UNTIL ITS ISSUING TRANSACTION IS.
 *
 * The exact failure: INV-ERP-2026-206 read `status: "active"` while on-chain
 * supply was unchanged and the holder's balance was 0.
 */
import { describe, expect, it } from "vitest";
import { MemoryLedgerTransactionRepository } from "../src/persistence/memory/index.js";
import { settlementStatus } from "../src/http/routes/context.js";

const asset = { id: "a1", status: "active" } as { id: string; status: string };

describe("settlementStatus", () => {
  it("is active when nothing is outstanding", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    expect(await settlementStatus({ ledgerTransactions }, asset)).toBe("active");
  });

  it("is pending while the issuing transaction is unconfirmed", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    await ledgerTransactions.record({ chainId: "besu", txHash: "0x1", kind: "deploy", assetId: "a1", submittedAt: "2026-08-18T10:00:00.000Z" });
    expect(await settlementStatus({ ledgerTransactions }, asset)).toBe("pending");
  });

  it("is pending — not active — when the outcome is unknown", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    const r = await ledgerTransactions.record({ chainId: "besu", txHash: "0x2", kind: "deploy", assetId: "a1", submittedAt: "2026-08-18T10:00:00.000Z" });
    await ledgerTransactions.settle(r.id, { status: "unknown", error: "no receipt" });
    expect(await settlementStatus({ ledgerTransactions }, asset)).toBe("pending");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/api/test/asset-status-reflects-chain.test.ts --testTimeout=45000
```

Expected: FAIL — `settlementStatus` is not exported.

- [ ] **Step 3: Implement it**

In `apps/api/src/http/routes/context.ts`:

```ts
/**
 * What the REGISTER may claim about an asset, given what the CHAIN has settled.
 *
 * `unknown` maps to `pending`, not to `failed` and not to `active`: we do not
 * know, and both of the confident answers are wrong in a way that costs money.
 */
export async function settlementStatus(
  deps: { ledgerTransactions: LedgerTransactionRepository },
  asset: { id: string; status: string },
): Promise<"active" | "pending" | "failed"> {
  const outstanding = await deps.ledgerTransactions.listByAsset(asset.id);
  if (outstanding.length > 0) return "pending";
  return asset.status === "failed" ? "failed" : "active";
}
```

Use it wherever an asset is projected into a response, adding a `settlement` field beside the existing `status` (leaving `status` untouched, so no existing test changes meaning).

- [ ] **Step 4: Declare the new field in the schema — THE ADDITIVITY RULE**

In `apps/api/src/http/schemas/tokenization.ts`, add to the asset response properties:

```ts
        settlement: { type: "string", enum: ["active", "pending", "failed"] },
```

Without this line `fast-json-stringify` strips the field silently and the API looks unchanged.

- [ ] **Step 5: Run the test and the full API suite**

```bash
npx vitest run apps/api/test/asset-status-reflects-chain.test.ts --testTimeout=45000 && npx vitest run apps/api --testTimeout=45000 --hookTimeout=45000
```

Expected: the new test passes; every existing suite still passes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http apps/api/test/asset-status-reflects-chain.test.ts
git commit -m "feat(assets): report settlement from the chain, not from optimism"
```

---

## Task 6: Reconciliation

**Files:**
- Create: `apps/api/src/tokenization/reconciliation.ts`
- Modify: `apps/api/src/http/routes/shared.ts`
- Modify: `apps/api/src/http/schemas/shared.ts`
- Test: `apps/api/test/reconciliation.test.ts`

**Interfaces:**
- Consumes: `AppDeps.assets`, `AppDeps.engine`, `AppDeps.ledgerTransactions`.
- Produces: `reconcile(deps, actor, opts)` returning `Promise<ReconciliationReport>` where `ReconciliationReport = { checked: number; drifted: ReconciliationRow[] }` and `ReconciliationRow = { assetId: string; chainId: string; believedSupply: string | null; chainSupply: string | null; outstanding: number; reason: string }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/reconciliation.test.ts`:

```ts
/**
 * DOES WHAT WE BELIEVE MATCH WHAT THE CHAIN SAYS?
 *
 * Read-only by design. A mismatch has several possible causes and picking one
 * automatically turns a reporting problem into a data-loss problem.
 */
import { describe, expect, it } from "vitest";
import { MemoryLedgerTransactionRepository } from "../src/persistence/memory/index.js";
import { reconcile } from "../src/tokenization/reconciliation.js";

const actor = { id: "u1", role: "PlatformAdmin" } as never;
const asset = { id: "a1", chainId: "besu", contractRef: "0xC", useCaseKey: "u", status: "active" };

describe("reconcile", () => {
  it("reports nothing when belief and chain agree", async () => {
    const deps = {
      assets: { list: async () => ({ items: [asset], total: 1 }) },
      engine: { totalSupply: async () => "100" },
      ledgerTransactions: new MemoryLedgerTransactionRepository(),
    } as never;
    const report = await reconcile(deps, actor, { believedSupply: async () => "100" });
    expect(report.checked).toBe(1);
    expect(report.drifted).toEqual([]);
  });

  it("reports drift when the chain holds less than the register claims", async () => {
    // The observed failure: register says issued, chain never minted.
    const deps = {
      assets: { list: async () => ({ items: [asset], total: 1 }) },
      engine: { totalSupply: async () => "0" },
      ledgerTransactions: new MemoryLedgerTransactionRepository(),
    } as never;
    const report = await reconcile(deps, actor, { believedSupply: async () => "510" });
    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0]).toMatchObject({ assetId: "a1", believedSupply: "510", chainSupply: "0" });
  });

  it("reports an unreadable chain as drift with a distinct reason, not as zero", async () => {
    // Reading "absent" as 0 would invent a discrepancy on every asset whenever a
    // chain is down — the alarm that trains people to ignore alarms.
    const deps = {
      assets: { list: async () => ({ items: [asset], total: 1 }) },
      engine: { totalSupply: async () => { throw new Error("chain absent"); } },
      ledgerTransactions: new MemoryLedgerTransactionRepository(),
    } as never;
    const report = await reconcile(deps, actor, { believedSupply: async () => "510" });
    expect(report.drifted[0]?.chainSupply).toBeNull();
    expect(report.drifted[0]?.reason).toBe("chain-unreadable");
  });

  it("counts outstanding transactions so pending work is not read as drift", async () => {
    const ledgerTransactions = new MemoryLedgerTransactionRepository();
    await ledgerTransactions.record({ chainId: "besu", txHash: "0x1", kind: "mint", assetId: "a1", submittedAt: "2026-08-18T10:00:00.000Z" });
    const deps = {
      assets: { list: async () => ({ items: [asset], total: 1 }) },
      engine: { totalSupply: async () => "0" },
      ledgerTransactions,
    } as never;
    const report = await reconcile(deps, actor, { believedSupply: async () => "510" });
    expect(report.drifted[0]?.outstanding).toBe(1);
    expect(report.drifted[0]?.reason).toBe("settlement-outstanding");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/api/test/reconciliation.test.ts --testTimeout=45000
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

Create `apps/api/src/tokenization/reconciliation.ts`:

```ts
/**
 * BELIEVED STATE VERSUS CHAIN STATE.
 *
 * READ-ONLY, DELIBERATELY. A mismatch can mean an unmined transaction, a chain
 * that is merely unreachable, a re-genesis, or a genuine bug — and "fixing" the
 * database on a guess turns a reporting problem into a data-loss problem.
 *
 * THREE REASONS, KEPT DISTINCT, because they need different actions:
 *   settlement-outstanding  transactions are still in flight; wait
 *   chain-unreadable        we could not ask; fix the connection, do not panic
 *   supply-mismatch         we asked, and the answer disagrees; investigate
 */
import type { Actor } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";

export interface ReconciliationRow {
  assetId: string;
  chainId: string;
  believedSupply: string | null;
  chainSupply: string | null;
  outstanding: number;
  reason: "settlement-outstanding" | "chain-unreadable" | "supply-mismatch";
}

export interface ReconciliationReport {
  checked: number;
  drifted: ReconciliationRow[];
}

export async function reconcile(
  deps: Pick<AppDeps, "assets" | "engine" | "ledgerTransactions">,
  actor: Actor,
  opts: { believedSupply: (assetId: string) => Promise<string | null>; limit?: number },
): Promise<ReconciliationReport> {
  const { items } = await deps.assets.list({}, { limit: opts.limit ?? 500, offset: 0 });
  const drifted: ReconciliationRow[] = [];

  for (const asset of items) {
    const outstanding = (await deps.ledgerTransactions.listByAsset(asset.id)).length;
    const believed = await opts.believedSupply(asset.id);

    let chainSupply: string | null = null;
    let unreadable = false;
    try {
      const ctx = { assetId: asset.id, chainId: asset.chainId, contractRef: asset.contractRef } as never;
      chainSupply = await deps.engine.totalSupply(actor, ctx);
    } catch {
      unreadable = true;
    }

    if (!unreadable && chainSupply === believed) continue;

    drifted.push({
      assetId: asset.id, chainId: asset.chainId,
      believedSupply: believed, chainSupply: unreadable ? null : chainSupply, outstanding,
      reason: outstanding > 0 ? "settlement-outstanding" : unreadable ? "chain-unreadable" : "supply-mismatch",
    });
  }

  return { checked: items.length, drifted };
}
```

- [ ] **Step 4: Run the test — it must pass**

```bash
npx vitest run apps/api/test/reconciliation.test.ts --testTimeout=45000
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Expose it**

In `apps/api/src/http/routes/shared.ts`, beside the audit console routes:

```ts
  app.get("/reconciliation", { schema: S.reconciliation, ...auth("PlatformAdmin", "Auditor") }, async (request) => {
    return reconcile(deps, actorOf(request), {
      // DERIVED from confirmed transactions, not asserted by the register. An
      // asset row has no supply column, and inventing one would just move the
      // unchecked claim somewhere else.
      believedSupply: (assetId) => deps.ledgerTransactions.settledSupply(assetId),
    });
  });
```

In `apps/api/src/http/schemas/shared.ts` — every field must be declared or it is stripped:

```ts
export const reconciliation = {
  response: {
    200: {
      type: "object",
      properties: {
        checked: { type: "integer" },
        drifted: {
          type: "array",
          items: {
            type: "object",
            properties: {
              assetId: { type: "string" },
              chainId: { type: "string" },
              believedSupply: { type: ["string", "null"] },
              chainSupply: { type: ["string", "null"] },
              outstanding: { type: "integer" },
              reason: { type: "string", enum: ["settlement-outstanding", "chain-unreadable", "supply-mismatch"] },
            },
          },
        },
      },
    },
  },
} as const;
```

- [ ] **Step 6: Prove the route file domain tests still pass**

```bash
npx vitest run apps/api/test/route-file-domains.test.ts apps/api/test/schema-file-domains.test.ts --testTimeout=45000
```

Expected: PASS — `/reconciliation` is a shared route in the shared file with its schema in the shared schema file.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/tokenization/reconciliation.ts apps/api/src/http apps/api/test/reconciliation.test.ts
git commit -m "feat(reconciliation): report where belief and chain disagree"
```

---

## Task 7: Boot asserts the registry actually exists

**Files:**
- Modify: `apps/api/src/identity/registry.ts`
- Test: `apps/api/test/registry-bytecode-assertion.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `registryIsLive(provider, address)` returning `Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/registry-bytecode-assertion.test.ts`:

```ts
/**
 * A STORED ADDRESS IS NOT EVIDENCE THAT A CONTRACT EXISTS.
 *
 * After a Besu re-genesis, GET /registry kept serving 0x630e594e… — an address
 * holding no bytecode — because boot read the RegistryDeployment row and never
 * asked the chain. Same rule the chain registry already applies to chains: real
 * or absent, never assumed.
 */
import { describe, expect, it } from "vitest";
import { registryIsLive } from "../src/identity/registry.js";

describe("registryIsLive", () => {
  it("is true when the address holds bytecode", async () => {
    const provider = { getCode: async () => "0x6080604052" };
    expect(await registryIsLive(provider, "0xC")).toBe(true);
  });

  it("is false for an address wiped by a re-genesis", async () => {
    const provider = { getCode: async () => "0x" };
    expect(await registryIsLive(provider, "0xC")).toBe(false);
  });

  it("is false — not a throw — when the chain cannot be reached", async () => {
    // Boot must not crash because a chain is down; absent is a valid answer.
    const provider = { getCode: async () => { throw new Error("ECONNREFUSED"); } };
    expect(await registryIsLive(provider, "0xC")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/api/test/registry-bytecode-assertion.test.ts --testTimeout=45000
```

Expected: FAIL — `registryIsLive` is not exported.

- [ ] **Step 3: Implement it**

In `apps/api/src/identity/registry.ts`:

```ts
/**
 * Does a contract still exist at `address`?
 *
 * FALSE ON ERROR, NOT A THROW. A chain we cannot reach is indistinguishable
 * from one where the code is gone, and both mean the same thing to boot: do not
 * trust the stored deployment. Crashing instead would take the whole API down
 * because one chain was briefly unreachable.
 */
export async function registryIsLive(
  provider: { getCode: (address: string) => Promise<string> },
  address: string,
): Promise<boolean> {
  try {
    const code = await provider.getCode(address);
    return !!code && code !== "0x";
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Use it before trusting a stored deployment**

At the point where boot reads `RegistryDeployment` and skips deployment, gate the skip:

```ts
  const stored = await deps.registryDeployments.get(chainId);
  if (stored && (await registryIsLive(provider, stored.didRegistry))) return stored;
  if (stored) {
    console.warn(`[registry] stored ${chainId} registries hold no bytecode (re-genesis?) — redeploying`);
  }
```

- [ ] **Step 5: Run the test and the identity suites**

```bash
npx vitest run apps/api/test/registry-bytecode-assertion.test.ts --testTimeout=45000 && npx vitest run apps/api --testTimeout=45000 --hookTimeout=45000
```

Expected: the new test passes; nothing else regressed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/identity/registry.ts apps/api/test/registry-bytecode-assertion.test.ts
git commit -m "fix(registry): verify the stored address still holds code before trusting it"
```

---

## Final verification

- [ ] **Full suite**

```bash
npx vitest run --testTimeout=45000 --hookTimeout=45000
```

Expected: ~1,731 passing (1,703 + 28 new). Six `packages/contracts/test/*` file-level failures are pre-existing.

- [ ] **Typecheck**

```bash
npx tsc --noEmit -p apps/api && npx tsc --noEmit -p packages/adapters
```

- [ ] **Prove it against the real failure**

With Besu running (`bash deploy/shared.sh --chain=besu`), tokenize an invoice on besu, then stop the validators mid-flight:

```bash
docker stop besu-node2 besu-node3
```

Expected, and none of it true before this plan: the HTTP request **returns** with a txHash instead of hanging; the asset reports `settlement: "pending"`; `GET /reconciliation` lists it with reason `settlement-outstanding`; and after `docker start besu-node2 besu-node3` the confirmer settles it to `confirmed` without anyone re-issuing it.

- [ ] **Restore**

```bash
docker start besu-node2 besu-node3
```
