# Hash-Chained Tamper-Evident Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the audit trail tamper-evident — each asset's audit entries form a hash chain (`seq`/`prevHash`/`hash`), a `verifyChain` recomputes it to pinpoint any edit/delete/insert, and chain heads are anchored on-ledger so even a consistent full rewrite is caught.

**Architecture:** A pure core module (`audit-chain.ts`) does genesis/hashing/verification. `AuditRepository.append` — the single chokepoint every writer flows through (engine sink + direct route appends) — computes the chain fields under a serialized append. An `AuditAnchor` table + a new `LedgerAdapter.anchor` write chain heads on-ledger. API `verify`/`anchor` routes + a web Integrity view surface it.

**Tech Stack:** pnpm monorepo — `@tokenlayer/core` (pure domain), `@tokenlayer/adapters` (ledger adapters), `apps/api` (Fastify + Prisma/SQLite, Vitest), `apps/web` (React + Vite).

**Branch:** `feat/hash-chained-audit` (checked out).

**Spec:** `docs/superpowers/specs/2026-07-09-hash-chained-audit-design.md`.

**Landmines (carry-overs from prior cycles):**
- New Prisma model/column ⇒ column + repo round-trip + `AppDeps` wiring in the SAME task; wire new repos into ALL construction sites — grep `documents: new` (server.ts, test/helpers.ts, demo.ts, e2e-buy.ts, e2e-tenancy.ts, e2e-carbon.ts, e2e-usecases.ts).
- Adapters: `SimulatedAdapter` (abstract; extended by Mock/Fabric/Canton) and `EvmLedgerAdapter` are the only two `LedgerAdapter` impls — a new interface method needs implementing in both.
- e2e scripts must not send `Content-Type: application/json` on a bodyless request (Fastify 400s it).
- Deploy uses `prisma db push` (no migration files); run `prisma generate` after schema edits.

---

## Task 1: Core — `audit-chain.ts` (genesis, hash, verifyChain)

**Files:**
- Create: `packages/core/src/audit-chain.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/audit-chain.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/audit-chain.test.ts
import { describe, it, expect } from "vitest";
import { auditGenesis, auditEntryHash, verifyChain, type AuditChainFields, type ChainEntry } from "../src/audit-chain.js";

const f = (seq: number, over: Partial<AuditChainFields> = {}): AuditChainFields => ({
  assetId: "a1", seq, actorId: "u1", action: "mint", payload: { to: "0xabc", amount: "100" },
  txHash: "0xtx", chainId: "fabric", createdAt: "2026-07-09T00:00:00.000Z", ...over,
});
/** Build a valid chain of N entries for asset a1. */
function chain(n: number): ChainEntry[] {
  const out: ChainEntry[] = [];
  let prev = auditGenesis("a1");
  for (let i = 0; i < n; i++) {
    const fields = f(i);
    const hash = auditEntryHash(prev, fields);
    out.push({ seq: i, prevHash: prev, hash, fields });
    prev = hash;
  }
  return out;
}

describe("audit-chain", () => {
  it("genesis is deterministic and distinct per asset", () => {
    expect(auditGenesis("a1")).toBe(auditGenesis("a1"));
    expect(auditGenesis("a1")).not.toBe(auditGenesis("a2"));
    expect(auditGenesis("a1")).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("entry hash is deterministic and sensitive to every field", () => {
    const g = auditGenesis("a1");
    const h = auditEntryHash(g, f(0));
    expect(auditEntryHash(g, f(0))).toBe(h);
    expect(auditEntryHash(g, f(0, { actorId: "u2" }))).not.toBe(h);
    expect(auditEntryHash(g, f(0, { payload: { to: "0xabc", amount: "101" } }))).not.toBe(h);
    expect(auditEntryHash("0xdifferentprev", f(0))).not.toBe(h);
  });
  it("verifyChain passes a valid chain", () => {
    const r = verifyChain("a1", chain(4));
    expect(r).toMatchObject({ valid: true, count: 4, brokenAt: null });
    expect(r.head).toMatch(/^0x/);
  });
  it("empty chain is valid with null head", () => {
    expect(verifyChain("a1", [])).toMatchObject({ valid: true, count: 0, head: null, brokenAt: null });
  });
  it("detects a mutated field (hash-mismatch)", () => {
    const c = chain(4);
    c[2] = { ...c[2], fields: { ...c[2].fields, actorId: "attacker" } }; // edit payload/actor, keep stored hash
    expect(verifyChain("a1", c)).toMatchObject({ valid: false, brokenAt: 2, reason: "hash-mismatch" });
  });
  it("detects a deleted middle entry (prevhash-mismatch after reindex)", () => {
    const c = chain(4).filter((_, i) => i !== 1).map((e, i) => ({ ...e, seq: i })); // drop seq1, reindex seqs
    expect(verifyChain("a1", c)).toMatchObject({ valid: false, brokenAt: 1 });
  });
  it("detects an inserted forgery", () => {
    const c = chain(3);
    const forged: ChainEntry = { seq: 1, prevHash: c[0].hash, hash: "0xforged", fields: f(1, { action: "burn" }) };
    const tampered = [c[0], forged, { ...c[1], seq: 2 }, { ...c[2], seq: 3 }];
    expect(verifyChain("a1", tampered)).toMatchObject({ valid: false, brokenAt: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @tokenlayer/core exec vitest run test/audit-chain.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `audit-chain.ts`**

```ts
// packages/core/src/audit-chain.ts
import { createHash } from "node:crypto";

/** The immutable fields of one audit entry that get hashed into the chain. */
export interface AuditChainFields {
  assetId: string;      // chain key ("__none__" for asset-less entries)
  seq: number;          // per-asset sequence, 0-based
  actorId: string;
  action: string;
  payload: Record<string, unknown>;
  txHash?: string;
  chainId?: string;
  createdAt: string;    // stored ISO timestamp
}

export interface ChainEntry { seq: number; prevHash: string; hash: string; fields: AuditChainFields; }
export interface VerifyResult { assetId: string; valid: boolean; count: number; head: string | null; brokenAt: number | null; reason?: string; }

/** Deterministic JSON: object keys sorted recursively, arrays preserved. */
function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJSON).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalJSON(o[k])).join(",") + "}";
}

const sha256hex = (s: string): string => "0x" + createHash("sha256").update(s, "utf8").digest("hex");

/** Distinct genesis per asset so entries cannot be spliced between chains. */
export function auditGenesis(assetId: string): string {
  return sha256hex("tokenlayer-audit-genesis|" + assetId);
}

/** hash = sha256(prevHash + "|" + canonicalJSON(normalized fields)). */
export function auditEntryHash(prevHash: string, fields: AuditChainFields): string {
  const canonical = canonicalJSON({
    assetId: fields.assetId, seq: fields.seq, actorId: fields.actorId, action: fields.action,
    payload: fields.payload, txHash: fields.txHash ?? null, chainId: fields.chainId ?? null, createdAt: fields.createdAt,
  });
  return sha256hex(prevHash + "|" + canonical);
}

/** Recompute one asset's chain (entries MUST be seq-ascending). First break wins. */
export function verifyChain(assetId: string, entries: ChainEntry[]): VerifyResult {
  let prev = auditGenesis(assetId);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i) return { assetId, valid: false, count: entries.length, head: null, brokenAt: i, reason: "seq-gap" };
    if (e.prevHash !== prev) return { assetId, valid: false, count: entries.length, head: null, brokenAt: e.seq, reason: "prevhash-mismatch" };
    if (e.hash !== auditEntryHash(prev, e.fields)) return { assetId, valid: false, count: entries.length, head: null, brokenAt: e.seq, reason: "hash-mismatch" };
    prev = e.hash;
  }
  return { assetId, valid: true, count: entries.length, head: entries.length ? prev : null, brokenAt: null };
}
```

- [ ] **Step 4: Export from core index** — add to `packages/core/src/index.ts`:
```ts
export { auditGenesis, auditEntryHash, verifyChain, type AuditChainFields, type ChainEntry, type VerifyResult } from "./audit-chain.js";
```

- [ ] **Step 5: Run tests** — `pnpm --filter @tokenlayer/core exec vitest run test/audit-chain.test.ts` → PASS (7). Then `pnpm --filter @tokenlayer/core test` → all green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/audit-chain.ts packages/core/src/index.ts packages/core/test/audit-chain.test.ts
git commit -m "feat(core): audit hash-chain — genesis, entry hash, verifyChain"
```

---

## Task 2: Persistence — chained append + AuditLog columns

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (AuditLog), `apps/api/src/persistence/types.ts` (AuditEntryRecord), `apps/api/src/persistence/prisma.ts` (PrismaAuditRepository + toAuditRecord), `apps/api/src/persistence/memory.ts` (MemoryAuditRepository)
- Test: `apps/api/test/audit-chain.test.ts` (new)

- [ ] **Step 1: Schema columns** — in `apps/api/prisma/schema.prisma`, AuditLog gains:
```prisma
  seq       Int      @default(0)
  prevHash  String   @default("")
  hash      String   @default("")
```
Add `@@unique([assetId, seq])` alongside the existing `@@index([assetId])`. Run `pnpm --filter @tokenlayer/api exec prisma generate`.

- [ ] **Step 2: Record type** — in `apps/api/src/persistence/types.ts`, `AuditEntryRecord` gains (optional, so existing consumers are unaffected):
```ts
  seq?: number;
  prevHash?: string;
  hash?: string;
```

- [ ] **Step 3: Failing test**

```ts
// apps/api/test/audit-chain.test.ts
import { describe, it, expect } from "vitest";
import { MemoryAuditRepository } from "../src/persistence/memory.js";
import { verifyChain, type ChainEntry } from "@tokenlayer/core";

function toChain(items: { seq?: number; prevHash?: string; hash?: string; assetId?: string; actorId: string; action: string; payload: Record<string, unknown>; txHash?: string; chainId?: string; createdAt: string }[]): ChainEntry[] {
  return items
    .slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((e) => ({ seq: e.seq!, prevHash: e.prevHash!, hash: e.hash!, fields: { assetId: e.assetId ?? "__none__", seq: e.seq!, actorId: e.actorId, action: e.action, payload: e.payload, txHash: e.txHash, chainId: e.chainId, createdAt: e.createdAt } }));
}

describe("MemoryAuditRepository chaining", () => {
  it("assigns seq 0..n and a verifiable chain per asset", async () => {
    const repo = new MemoryAuditRepository();
    for (let i = 0; i < 3; i++) await repo.append({ assetId: "a1", actorId: "u", action: "mint", payload: { i }, chainId: "fabric" });
    await repo.append({ assetId: "a2", actorId: "u", action: "issue", payload: {}, chainId: "fabric" });
    const a1 = (await repo.listByAsset("a1", { limit: 100 })).items;
    expect(a1.map((e) => e.seq).sort()).toEqual([0, 1, 2]);
    expect(verifyChain("a1", toChain(a1))).toMatchObject({ valid: true, count: 3 });
    const a2 = (await repo.listByAsset("a2", { limit: 100 })).items;
    expect(a2[0].seq).toBe(0); // a2 has its own chain
    expect(verifyChain("a2", toChain(a2))).toMatchObject({ valid: true, count: 1 });
  });
  it("a mutated entry fails verification at its seq", async () => {
    const repo = new MemoryAuditRepository();
    for (let i = 0; i < 3; i++) await repo.append({ assetId: "a1", actorId: "u", action: "mint", payload: { i }, chainId: "fabric" });
    const items = (await repo.listByAsset("a1", { limit: 100 })).items;
    const mutated = toChain(items).map((e) => (e.seq === 1 ? { ...e, fields: { ...e.fields, actorId: "attacker" } } : e));
    expect(verifyChain("a1", mutated)).toMatchObject({ valid: false, brokenAt: 1, reason: "hash-mismatch" });
  });
});
```

- [ ] **Step 4: Run to verify failure** — `pnpm --filter @tokenlayer/api exec vitest run test/audit-chain.test.ts` → FAIL (seq undefined).

- [ ] **Step 5: Memory repo chained append** — replace `MemoryAuditRepository.append` in `apps/api/src/persistence/memory.ts` (add `auditGenesis, auditEntryHash` to the `@tokenlayer/core` import at the top):

```ts
  private appendLock: Promise<unknown> = Promise.resolve();
  async append(entry: Omit<AuditEntryRecord, "id" | "createdAt"> & { createdAt?: string }): Promise<AuditEntryRecord> {
    // Serialize appends so each entry reads a consistent per-asset head.
    const run = this.appendLock.then(async () => {
      const chainKey = entry.assetId ?? "__none__";
      const chain = this.entries.filter((e) => (e.assetId ?? "__none__") === chainKey).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const seq = chain.length;
      const prevHash = chain.length ? chain[chain.length - 1]!.hash! : auditGenesis(chainKey);
      const createdAt = entry.createdAt ?? now();
      const hash = auditEntryHash(prevHash, { assetId: chainKey, seq, actorId: entry.actorId, action: entry.action, payload: entry.payload, txHash: entry.txHash, chainId: entry.chainId, createdAt });
      const rec: AuditEntryRecord = { ...entry, id: id("audit"), createdAt, seq, prevHash, hash };
      this.entries.push(rec);
      return rec;
    });
    this.appendLock = run.catch(() => {});
    return run;
  }
```

- [ ] **Step 6: Prisma repo chained append** — in `apps/api/src/persistence/prisma.ts`: add `auditGenesis, auditEntryHash` to the `@tokenlayer/core` import; map `seq/prevHash/hash` in `toAuditRecord` (read `r.seq/r.prevHash/r.hash`); replace `PrismaAuditRepository.append`:

```ts
  private appendLock: Promise<unknown> = Promise.resolve();
  async append(entry: Omit<AuditEntryRecord, "id" | "createdAt"> & { createdAt?: string }): Promise<AuditEntryRecord> {
    const run = this.appendLock.then(async () => {
      const chainKey = entry.assetId ?? "__none__";
      const head = await prisma.auditLog.findFirst({ where: { assetId: entry.assetId ?? null }, orderBy: { seq: "desc" } });
      const seq = head ? head.seq + 1 : 0;
      const prevHash = head ? head.hash : auditGenesis(chainKey);
      const createdAt = entry.createdAt ? new Date(entry.createdAt) : new Date();
      const hash = auditEntryHash(prevHash, { assetId: chainKey, seq, actorId: entry.actorId, action: entry.action, payload: entry.payload, txHash: entry.txHash, chainId: entry.chainId, createdAt: createdAt.toISOString() });
      const r = await prisma.auditLog.create({
        data: { assetId: entry.assetId, actorId: entry.actorId, action: entry.action, payload: JSON.stringify(entry.payload), txHash: entry.txHash, chainId: entry.chainId, createdAt, seq, prevHash, hash },
      });
      return toAuditRecord({ ...r, payload: entry.payload });
    });
    this.appendLock = run.catch(() => {});
    return run;
  }
```
Note the createdAt subtlety: the hash uses `createdAt.toISOString()` and the row stores the same `Date`, so `toAuditRecord`'s `r.createdAt.toISOString()` round-trips to the identical string the hash used. Confirm `toAuditRecord` returns `createdAt: r.createdAt.toISOString()` (it does) — this MUST match, or verification fails. If `toAuditRecord` reparses payload from a string, pass the object form as shown to avoid a re-stringify mismatch (hash used `entry.payload`, not a reparse).

- [ ] **Step 7: Run tests + full suite** — `pnpm --filter @tokenlayer/api exec vitest run test/audit-chain.test.ts` → PASS; then `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api test` → all green (analytics/others unaffected — they ignore the new fields).

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence
git commit -m "feat(api): chained audit append — seq/prevHash/hash on every entry"
```

---

## Task 3: Ledger anchoring — adapter method + AuditAnchor repo

**Files:**
- Modify: `packages/core/src/types.ts` (LedgerAdapter), `packages/adapters/src/simulated-adapter.ts`, `packages/adapters/src/evm-adapter.ts`
- Modify: `apps/api/prisma/schema.prisma` (AuditAnchor), `apps/api/src/persistence/types.ts`, `apps/api/src/persistence/prisma.ts`, `apps/api/src/persistence/memory.ts`
- Modify: `apps/api/src/context.ts` + all construction sites

- [ ] **Step 1: Adapter interface** — in `packages/core/src/types.ts`, add to `LedgerAdapter` (after `isAllowed`):
```ts
  /** Anchor an off-ledger hash (e.g. an audit chain head) on-ledger for tamper-evidence. */
  anchor(ref: AssetRef, hash: string): Promise<TxReceipt>;
```

- [ ] **Step 2: Simulated adapter** — in `SimulatedAdapter` (packages/adapters/src/simulated-adapter.ts), add:
```ts
  private readonly anchors = new Map<string, string[]>();
  async anchor(ref: AssetRef, hash: string): Promise<TxReceipt> {
    const list = this.anchors.get(ref.contractRef) ?? [];
    list.push(hash);
    this.anchors.set(ref.contractRef, list);
    return { txHash: "0xanchor" + list.length.toString(16).padStart(8, "0"), chainId: this.chainId, timestamp: new Date().toISOString() };
  }
```
(Match how other sim methods build a `TxReceipt` — read `setAllowed` at line ~81 and mirror its receipt shape/fields.)

- [ ] **Step 3: EVM adapter** — in `EvmLedgerAdapter` (packages/adapters/src/evm-adapter.ts), add an `anchor` that sends a 0-value self-transaction carrying the hash as calldata when a signer is configured, else returns a synthetic receipt. Read how the adapter sends an existing write tx (e.g. its `mint`/`setAllowed`) and mirror the signer/tx pattern:
```ts
  async anchor(ref: AssetRef, hash: string): Promise<TxReceipt> {
    // No signer configured → synthetic marker (matches the adapter's real-or-absent stance).
    if (!this.signer) return { txHash: "0xanchor-unsigned", chainId: this.chainId, timestamp: new Date().toISOString() };
    const tx = await this.signer.sendTransaction({ to: await this.signer.getAddress(), value: 0n, data: hash });
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash, chainId: this.chainId, timestamp: new Date().toISOString() };
  }
```
Adapt `this.signer` / send call to the adapter's actual field + ethers version (read the file first; if it uses a provider+wallet named differently, use those).

- [ ] **Step 4: AuditAnchor model + repo** — schema:
```prisma
model AuditAnchor {
  id        String   @id @default(cuid())
  assetId   String
  seq       Int
  hash      String
  txHash    String
  chainId   String
  createdAt DateTime @default(now())
  @@index([assetId])
}
```
`prisma generate`. In `persistence/types.ts`:
```ts
export interface AuditAnchorRecord { id: string; assetId: string; seq: number; hash: string; txHash: string; chainId: string; createdAt: string; }
export interface AuditAnchorRepository {
  create(input: Omit<AuditAnchorRecord, "id" | "createdAt">): Promise<AuditAnchorRecord>;
  latest(assetId: string): Promise<AuditAnchorRecord | null>; // highest seq
}
```
Implement `PrismaAuditAnchorRepository` (create; `latest` = findFirst orderBy seq desc; toRecord maps createdAt.toISOString()) and `MemoryAuditAnchorRepository` (Map/array, `id("anchor")`, `now()`). Mirror the Cashflow/Document repo idioms.

- [ ] **Step 5: Wire** — `auditAnchors: AuditAnchorRepository` into `AppDeps` (context.ts) + every construction site (server.ts → Prisma; test/helpers.ts + demo.ts + e2e-buy.ts + e2e-tenancy.ts + e2e-carbon.ts + e2e-usecases.ts → Memory). Grep `documents: new` to find them all.

- [ ] **Step 6: Verify + commit**

Run: `pnpm --filter @tokenlayer/core build && pnpm --filter @tokenlayer/adapters build && pnpm --filter @tokenlayer/adapters test && pnpm --filter @tokenlayer/api exec tsc --noEmit`
Expected: clean; adapters tests still pass (the abstract `anchor` is inherited by all sim adapters).
```bash
git add packages/core/src/types.ts packages/adapters/src apps/api/prisma/schema.prisma apps/api/src/persistence apps/api/src/context.ts apps/api/src/server.ts apps/api/test/helpers.ts apps/api/src/demo.ts apps/api/src/e2e-*.ts
git commit -m "feat: LedgerAdapter.anchor + AuditAnchor model/repo (on-ledger audit anchoring)"
```

---

## Task 4: API — verify + anchor routes

**Files:**
- Modify: `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/audit-verify.test.ts` (new)

- [ ] **Step 1: Failing tests**

```ts
// apps/api/test/audit-verify.test.ts
import { describe, it, expect } from "vitest";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

// Issue a carbon asset (activity → audit entries) and return { admin, assetId, app }.
async function seeded() {
  const app = await buildTestApp();
  const admin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
  const issuer = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");
  const res = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(issuer), payload: { useCaseKey: "carbon-credit", name: "VCU-1", chainId: "fabric", initialSupply: "100", treasuryAccount: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", metadata: { projectName: "P", registry: "Verra", vintage: 2024 } } });
  return { app, admin, assetId: res.json().asset.id };
}

describe("audit verify + anchor", () => {
  it("verifies a clean chain and rolls up a summary", async () => {
    const { app, admin, assetId } = await seeded();
    const v = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/audit/verify`, headers: auth(admin) });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ valid: true, anchorConsistent: true });
    expect(v.json().count).toBeGreaterThan(0);
    const s = await app.inject({ method: "GET", url: `${V1}/audit/verify`, headers: auth(admin) });
    expect(s.json().tampered).toEqual([]);
    expect(s.json().verified).toBeGreaterThan(0);
  });
  it("anchors chain heads on-ledger and reports the anchor", async () => {
    const { app, admin, assetId } = await seeded();
    const a = await app.inject({ method: "POST", url: `${V1}/audit/anchor`, headers: auth(admin), payload: {} });
    expect(a.statusCode).toBe(200);
    expect(a.json().anchored.length).toBeGreaterThan(0);
    const v = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/audit/verify`, headers: auth(admin) });
    expect(v.json().lastAnchor.txHash).toMatch(/^0x/);
    expect(v.json().anchorConsistent).toBe(true);
  });
  it("tenancy: a foreign use-case user cannot verify (404)", async () => {
    const { app, assetId } = await seeded();
    const gold = await loginAs(app, "gold.admin@tokenlayer.dev", "gold123");
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/audit/verify`, headers: auth(gold) })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @tokenlayer/api exec vitest run test/audit-verify.test.ts` → FAIL (routes missing).

- [ ] **Step 3: Add the routes** — in `apps/api/src/http/routes.ts` (add `verifyChain, auditEntryHash, type ChainEntry` to the `@tokenlayer/core` import). A shared helper inside `registerRoutes`:

```ts
  // Build an asset's seq-ascending ChainEntry list from its audit rows.
  async function assetChain(assetId: string): Promise<ChainEntry[]> {
    const { items } = await deps.audit.listByAsset(assetId, { limit: 100000 });
    return items
      .filter((e) => e.hash !== undefined)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((e) => ({ seq: e.seq!, prevHash: e.prevHash!, hash: e.hash!, fields: { assetId: e.assetId ?? "__none__", seq: e.seq!, actorId: e.actorId, action: e.action, payload: e.payload, txHash: e.txHash, chainId: e.chainId, createdAt: e.createdAt } }));
  }
  // Verify one asset + compare the anchored seq's recomputed hash to the anchor.
  async function verifyAsset(assetId: string) {
    const chain = await assetChain(assetId);
    const base = verifyChain(assetId, chain);
    const anchor = await deps.auditAnchors.latest(assetId);
    let anchorConsistent = true;
    if (anchor) {
      const at = chain.find((e) => e.seq === anchor.seq);
      // Recompute the hash at the anchored seq; if the entry is gone or altered, the anchor won't match.
      anchorConsistent = !!at && auditEntryHash(at.prevHash, at.fields) === anchor.hash;
    }
    return { assetId, valid: base.valid, count: base.count, head: base.head, brokenAt: base.brokenAt, reason: base.reason ?? null, lastAnchor: anchor ? { seq: anchor.seq, hash: anchor.hash, txHash: anchor.txHash, chainId: anchor.chainId, at: anchor.createdAt } : null, anchorConsistent };
  }

  app.get("/assets/:id/audit/verify", { schema: S.verifyAssetAudit, ...auth }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    return verifyAsset(asset.id);
  });

  app.get("/audit/verify", { schema: S.verifyAuditSummary, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    const useCaseKey = claims.role === "PlatformAdmin" ? undefined : claims.useCaseKey ?? NO_USE_CASE;
    const { items } = await deps.assets.list({ useCaseKey }, { limit: 1000 });
    const results = await Promise.all(items.map((a) => verifyAsset(a.id)));
    const tampered = results.filter((r) => !r.valid || !r.anchorConsistent).map((r) => ({ assetId: r.assetId, brokenAt: r.brokenAt, reason: r.anchorConsistent ? r.reason : "anchor-mismatch" }));
    return { assets: results.length, verified: results.filter((r) => r.valid && r.anchorConsistent).length, tampered, anchoredAssets: results.filter((r) => r.lastAnchor).length };
  });

  app.post("/audit/anchor", { schema: S.anchorAudit, ...auth }, async (request, reply) => {
    const actor = actorOf(request);
    if (!(deps.rbac.can(actor.role, "issue") || actor.role === "Auditor")) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to anchor the audit trail" });
    }
    const claims = request.user as TokenClaims;
    const useCaseKey = claims.role === "PlatformAdmin" ? undefined : claims.useCaseKey ?? NO_USE_CASE;
    const { items } = await deps.assets.list({ useCaseKey }, { limit: 1000 });
    const anchored: { assetId: string; seq: number; txHash: string }[] = [];
    for (const a of items) {
      const chain = await assetChain(a.id);
      if (chain.length === 0) continue;
      const head = chain[chain.length - 1]!;
      try {
        const receipt = await deps.chains.resolveAdapter(a.chainId).anchor({ id: a.id, chainId: a.chainId, contractRef: a.contractRef }, head.hash);
        const rec = await deps.auditAnchors.create({ assetId: a.id, seq: head.seq, hash: head.hash, txHash: receipt.txHash, chainId: a.chainId });
        anchored.push({ assetId: a.id, seq: rec.seq, txHash: rec.txHash });
      } catch (err) {
        request.log.error({ err, assetId: a.id }, "audit anchor failed for asset — skipped (best-effort)");
      }
    }
    return { anchored };
  });
```
(Confirm `scopedAsset`, `actorOf`, `NO_USE_CASE`, `deps.rbac.can`, `deps.chains.resolveAdapter` names by reading the file top — all already used elsewhere in routes.ts.)

- [ ] **Step 4: Schemas** — in `apps/api/src/http/schemas.ts` add under `S` (permissive `additionalProperties: true` objects; follow the file's style):
```ts
  verifyAssetAudit: { tags: ["Audit"], summary: "Verify an asset's audit hash chain + anchor", security: bearer, params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404) } },
  verifyAuditSummary: { tags: ["Audit"], summary: "Platform audit-integrity roll-up", security: bearer, response: { 200: { type: "object", additionalProperties: true }, ...errs(401) } },
  anchorAudit: { tags: ["Audit"], summary: "Anchor each asset's audit chain head on-ledger", security: bearer, body: { type: "object", additionalProperties: false, properties: {} }, response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403) } },
```

- [ ] **Step 5: Run tests + full suite** — `pnpm --filter @tokenlayer/api exec vitest run test/audit-verify.test.ts` → PASS (3); then `pnpm --filter @tokenlayer/api test` → all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/audit-verify.test.ts
git commit -m "feat(api): GET /assets/:id/audit/verify + GET /audit/verify + POST /audit/anchor"
```

---

## Task 5: Web — Integrity view

**Files:**
- Modify: `apps/web/src/types.ts`, `apps/web/src/api.ts`
- Create: `apps/web/src/components/IntegrityPanel.tsx`
- Modify: the app nav/section switch (read `apps/web/src/App.tsx` for how "Overview"/dashboard sections are registered) to add an **Integrity** section.

- [ ] **Step 1: Types + client** — `types.ts`:
```ts
export interface AuditVerify { assetId: string; valid: boolean; count: number; head: string | null; brokenAt: number | null; reason: string | null; lastAnchor: { seq: number; hash: string; txHash: string; chainId: string; at: string } | null; anchorConsistent: boolean; }
export interface AuditSummary { assets: number; verified: number; anchoredAssets: number; tampered: { assetId: string; brokenAt: number | null; reason: string | null }[]; }
```
`api.ts`:
```ts
  verifyAudit: (token: string, assetId: string) => request<AuditVerify>(`/assets/${assetId}/audit/verify`, token),
  auditSummary: (token: string) => request<AuditSummary>("/audit/verify", token),
  anchorAudit: (token: string) => request<{ anchored: { assetId: string; seq: number; txHash: string }[] }>("/audit/anchor", token, { method: "POST", body: JSON.stringify({}) }),
```
(Add `AuditVerify, AuditSummary` to the `types.js` import.)

- [ ] **Step 2: IntegrityPanel** — `apps/web/src/components/IntegrityPanel.tsx`: fetch `api.assets(token)` for the caller's assets, then `api.verifyAudit` per asset (Promise.all); render a table: name · status pill (green "verified" when `valid && anchorConsistent`, red "tampered @#brokenAt" / "anchor mismatch" otherwise) · entry count · last anchor (`seq` + short `txHash` + relative time, or "not anchored"). Header: a "Verify now" button (re-fetch) and, for issue-capable/Auditor roles, an "Anchor now" button calling `api.anchorAudit` then re-fetching. Follow the card/table/pill idioms in `CashflowPanel.tsx`/`ApprovalsPanel.tsx`. Use `useAuth()` for token + role; gate "Anchor now" with `can(role, "issue") || role === "Auditor"`.

- [ ] **Step 3: Register the nav section** — in `App.tsx`, add an "Integrity" entry to the sections list (mirror how the Overview/dashboard tab is registered) rendering `<IntegrityPanel />`. Show it for all signed-in roles (auditors especially).

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build` → clean.
```bash
git add apps/web/src
git commit -m "feat(web): Integrity view — per-asset audit chain status + verify/anchor"
```

---

## Task 6: Verify — suite, live E2E (real DB tamper), review, merge

- [ ] **Step 1: Full workspace suite** — core / adapters / api / contracts tests + web tsc/build, all green.
- [ ] **Step 2: Rebuild + fresh-volume deploy** — `docker compose build api web && docker compose down -v && docker compose up -d`; wait for login 200.
- [ ] **Step 3: Live E2E** — a scratchpad script: run cross-use-case activity (reuse the full-platform flow, or issue+mint a couple of assets); `GET /audit/verify` → all valid; `POST /audit/anchor` → anchors returned; `GET /assets/:id/audit/verify` → `lastAnchor.txHash` present + `anchorConsistent:true`. Then **tamper the DB directly**: `docker compose exec -T api sh -c "apk add --no-cache sqlite || true; sqlite3 /data/dev.db \"UPDATE AuditLog SET actorId='attacker' WHERE seq=1 AND assetId='<id>'\""` (or via a node prisma one-liner in the container). Re-run verify → the tampered asset reports `valid:false, brokenAt:1` and the summary lists it under `tampered`; `anchorConsistent:false` for a pre-anchor edit. Print ✓/✗.
- [ ] **Step 4: Adversarial review** — dispatch a reviewer on `git diff main...feat/hash-chained-audit` focused on: canonicalJSON determinism (unicode/number/nested-key edge cases; does the hash round-trip the stored createdAt/payload exactly — the #1 false-positive risk), the append serialization (can two appends still race to the same seq under the mutex? Prisma createdAt-vs-hash mismatch?), the anchor-consistency check correctness (does it actually catch a full rewrite?), best-effort anchor error handling, tenancy on verify/anchor, and adapter `anchor` on the EVM path. Fix real findings; re-run suites.
- [ ] **Step 5: Merge + redeploy + memory** — `git checkout main && git merge --no-ff feat/hash-chained-audit`; rebuild + fresh deploy; update `product-feature-roadmap.md` (institutional-trust cycle 1 done; SSO/MFA + KYC-provider are the remaining cycles).

---

## Self-review notes

- **Spec coverage:** core hashing/verify (T1), chained append + columns (T2), anchoring adapter + AuditAnchor (T3), verify/anchor/summary routes + anchor-consistency (T4), web Integrity view (T5), verify incl. real DB tamper + review + merge (T6). All spec sections mapped.
- **Type consistency:** `AuditChainFields`/`ChainEntry`/`VerifyResult` (core) reused verbatim in T2/T4; `AuditAnchorRecord`/`AuditAnchorRepository` names match across T3/T4; `verifyAsset`'s response shape matches the web `AuditVerify` type in T5; `anchorConsistent` used consistently.
- **Critical correctness watch:** the Prisma append must hash with the SAME `createdAt` string and payload object that `toAuditRecord` later returns, or verify false-positives. The plan pins this (hash uses `createdAt.toISOString()`; `toAuditRecord` returns `r.createdAt.toISOString()`; payload passed as the object, not a reparse).
