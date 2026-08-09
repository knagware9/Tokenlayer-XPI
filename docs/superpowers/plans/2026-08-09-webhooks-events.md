# Webhooks & Events (EN-C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every integration-relevant fact in a durable, globally ordered event log and push it to org-configured HTTPS endpoints as HMAC-signed, retried deliveries — with a cursor API so an integrator that was offline pulls exactly what it missed.

**Architecture:** A new `Event` outbox carries a global monotonic `seq` (the audit log stays per-asset hash-chained for HA-B and is not touched). Emitting an event fans out `WebhookDelivery` rows to every matching `WebhookEndpoint`. The first background worker in this codebase drains due deliveries, claiming each with a compare-and-set so a second API instance cannot double-send. Two pure modules carry the risk: a URL guard (SSRF) and an HMAC signer.

**Tech Stack:** apps/api (Fastify + Prisma/SQLite + vitest), packages/core (shared closed catalogs), apps/web (React + Vite). No new runtime dependency — `node:crypto` for HMAC, global `fetch` for delivery, the existing AES-256-GCM envelope for secret storage.

**Spec:** `docs/superpowers/specs/2026-08-09-webhooks-events-design.md`

---

## Ground rules for every task

These are not optional and they are why previous sub-projects landed clean.

1. **No existing behavioural test may be edited.** The suite is the back-compat oracle. If an existing test genuinely encodes a bug, say so explicitly in your report with the test name and the reason — never weaken one silently.
2. **Mutation-check every guard you add.** Break it deliberately, confirm a test fails, restore it. A guard that no mutation kills is decoration. Report each mutation and what killed it. On EN-B two mutations survived the first pass and the tests were passing for the wrong reason.
3. **THE PARITY RULE.** Any new persisted field must land in: the Prisma schema, the record type, the row type, the mapper, and the create/update literals in **both** `memory.ts` and `prisma.ts`, then `npx prisma generate` — all in ONE commit. Memory-harness tests cannot catch a prisma-side drop; only a live walkthrough does.
4. **No test directory in this repo is typechecked** (`"include": ["src"]`, vitest runs no typecheck). A `@ts-expect-error` inside a test file is inert — never use one as evidence.
5. Run `npx prisma generate` after any schema edit, from `apps/api`.
6. Never touch `apps/api/prisma/dev.db*`. Throwaway DBs are `apps/api/prisma/dev-<name>.db`, deleted afterwards.
7. Kill APIs by port (`lsof -ti tcp:4000 | xargs kill -9`), never `pkill`.

## File Structure

**Create**
| File | Responsibility |
|---|---|
| `packages/core/src/events.ts` | The closed event catalog + `EventType` union. Nothing else. |
| `packages/core/test/events.test.ts` | Catalog closure + scope interaction. |
| `apps/api/src/webhooks/url-guard.ts` | SSRF guard. Pure: string/DNS in, verdict out. No HTTP. |
| `apps/api/src/webhooks/signing.ts` | HMAC signing + the verification recipe. Pure. |
| `apps/api/src/webhooks/secret-box.ts` | AES-256-GCM seal/open for the endpoint secret. |
| `apps/api/src/webhooks/matching.ts` | `endpointMatches` — the tenancy disjunction. Pure. |
| `apps/api/src/webhooks/dispatcher.ts` | `dispatchDue()` + the interval wrapper. |
| `apps/api/src/events.ts` | `emitEvent()` — writes the Event, fans out deliveries. |
| `apps/api/test/webhooks-url-guard.test.ts` | Hostile-URL table + the rebinding case. |
| `apps/api/test/webhooks-signing.test.ts` | Known vectors, tamper detection. |
| `apps/api/test/webhooks-dispatch.test.ts` | Retry/backoff/dead/auto-disable/CAS/stale reclaim. |
| `apps/api/test/webhooks-routes.test.ts` | Route behaviour, tenancy, envelope, scopes. |
| `apps/api/test/events-emit-coverage.test.ts` | Every catalog entry has an emit site. |
| `apps/web/src/components/Webhooks.tsx` | The Webhooks section of Developers. |
| `apps/web/test/webhooks-panel.test.ts` | Envelope-filtered checkboxes + reveal counter. |

**Modify**
| File | Change |
|---|---|
| `packages/core/src/api-scopes.ts` | `+ "webhooks:read"`, `+ "webhooks:write"` |
| `packages/core/src/index.ts` | Export the events module |
| `apps/api/prisma/schema.prisma` | `Event`, `WebhookEndpoint`, `WebhookDelivery` |
| `apps/api/src/persistence/types.ts` | 3 records + 3 repository interfaces |
| `apps/api/src/persistence/memory.ts` | 3 memory repos |
| `apps/api/src/persistence/prisma.ts` | 3 prisma repos + mappers |
| `apps/api/src/context.ts` | 3 required `AppDeps` fields |
| `apps/api/src/env.ts` | 4 webhook env knobs |
| `apps/api/src/http/routes.ts` | 9 routes + emit sites |
| `apps/api/src/http/schemas.ts` | Route schemas |
| `apps/api/test/scope-coverage.test.ts` | Justify/scope the new routes |
| `apps/web/src/components/Developers.tsx` | Mount the Webhooks section |
| `apps/web/src/lib/api.ts`, `types.ts` | Client methods + types |
| `server.ts`, `demo.ts`, `e2e-*.ts`, test harness | New required deps (compile errors guide you) |

---

## Task C1: Core — the event catalog and two scopes

**Files:**
- Create: `packages/core/src/events.ts`, `packages/core/test/events.test.ts`
- Modify: `packages/core/src/api-scopes.ts`, `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/test/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EVENT_TYPES, isEventType, validateEventTypes, API_SCOPES, scopeAllows } from "../src/index.js";

describe("event catalog", () => {
  it("is the closed v1 set — ten types across both domains", () => {
    expect([...EVENT_TYPES].sort()).toEqual([
      "asset.issued", "asset.redeemed", "asset.transferred",
      "credential.accepted", "credential.issued", "credential.rejected", "credential.revoked",
      "proposal.executed", "verification.completed", "verification.requested",
    ]);
  });

  it("recognises catalog members and rejects everything else", () => {
    expect(isEventType("credential.issued")).toBe(true);
    expect(isEventType("organization.registered")).toBe(false); // deliberately excluded from v1
    expect(isEventType("")).toBe(false);
    expect(isEventType("*")).toBe(false); // a subscription wildcard, never an event type
  });

  it("validateEventTypes accepts the wildcard subscription and known types", () => {
    expect(validateEventTypes(["*"])).toEqual(["*"]);
    expect(validateEventTypes(["credential.issued", "asset.issued"])).toEqual(["credential.issued", "asset.issued"]);
  });

  it("validateEventTypes rejects unknown, empty, duplicate and non-string input", () => {
    expect(() => validateEventTypes([])).toThrow(/at least one/);
    expect(() => validateEventTypes(["nope.gone"])).toThrow(/unknown event type/);
    expect(() => validateEventTypes(["credential.issued", "credential.issued"])).toThrow(/duplicate/);
    expect(() => validateEventTypes("credential.issued")).toThrow(/must be an array/);
    expect(() => validateEventTypes([1])).toThrow(/must be strings/);
  });
});

describe("webhook scopes", () => {
  it("are in the closed scope list", () => {
    expect(API_SCOPES).toContain("webhooks:read");
    expect(API_SCOPES).toContain("webhooks:write");
  });

  it("the webhooks:* wildcard covers both, and no other resource's wildcard does", () => {
    expect(scopeAllows(["webhooks:*"], "webhooks:read")).toBe(true);
    expect(scopeAllows(["webhooks:*"], "webhooks:write")).toBe(true);
    expect(scopeAllows(["org:*"], "webhooks:read")).toBe(false);
    expect(scopeAllows(["webhooks:read"], "webhooks:write")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @tokenlayer/core test -- --run events
```

Expected: FAIL — `EVENT_TYPES` is not exported.

- [ ] **Step 3: Write the catalog**

`packages/core/src/events.ts`:

```ts
/**
 * The closed v1 event catalog (EN-C). Shared by the API (emit + subscribe
 * validation) and the web console (the subscription checkboxes), so the
 * vocabulary lives in exactly one place — the same shape as API_SCOPES.
 *
 * DELIBERATELY EXCLUDED from v1: organization.*, member.*, apikey.* and
 * capability changes. Those are governance facts about an org rather than
 * integration events, and each needs its own tenancy argument before it is
 * shipped to a third party. Adding one later is a catalog entry plus an emit
 * site — a small, reviewable change.
 */
import { PolicyError } from "./errors.js";

export const EVENT_TYPES = [
  // Identity
  "credential.issued",
  "credential.accepted",
  "credential.rejected",
  "credential.revoked",
  "verification.requested",
  "verification.completed",
  // Tokenization
  "asset.issued",
  "asset.transferred",
  "asset.redeemed",
  // Governance
  "proposal.executed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** The same closed set at runtime, built once: its input is a module constant. */
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && EVENT_TYPE_SET.has(v);
}

/** A subscription is `["*"]` or a set of known types. Never a partial wildcard. */
export type EventSubscription = EventType | "*";

export function validateEventTypes(input: unknown): EventSubscription[] {
  if (!Array.isArray(input)) throw new PolicyError("INVALID_EVENT_TYPES", "eventTypes must be an array");
  if (input.length === 0) throw new PolicyError("INVALID_EVENT_TYPES", "subscribe to at least one event type");
  for (const t of input) {
    if (typeof t !== "string") throw new PolicyError("INVALID_EVENT_TYPES", "eventTypes must be strings");
    if (t === "*") continue;
    if (!EVENT_TYPE_SET.has(t)) throw new PolicyError("UNKNOWN_EVENT_TYPE", `unknown event type '${t}'`);
  }
  if (new Set(input).size !== input.length) throw new PolicyError("INVALID_EVENT_TYPES", "eventTypes contain duplicates");
  return [...input] as EventSubscription[];
}
```

- [ ] **Step 4: Add the two scopes**

In `packages/core/src/api-scopes.ts`, add to `API_SCOPES` immediately after `"org:read"`:

```ts
  // EN-C: manage this org's own webhook endpoints and read its event log.
  // Split read/write because an integration that only consumes the cursor API
  // has no business rotating a secret or repointing a delivery URL.
  "webhooks:read",
  "webhooks:write",
```

- [ ] **Step 5: Export from the core barrel**

In `packages/core/src/index.ts`, after the `api-scopes` export line:

```ts
export { EVENT_TYPES, isEventType, validateEventTypes, type EventType, type EventSubscription } from "./events.js";
```

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @tokenlayer/core test -- --run
```

Expected: PASS, 242 existing + the new cases.

- [ ] **Step 7: Mutation-check**

Change `if (t === "*") continue;` to `if (t.endsWith("*")) continue;` — the "rejects unknown" test must fail (`"nope.*"` would slip through). Restore.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/events.ts packages/core/test/events.test.ts packages/core/src/api-scopes.ts packages/core/src/index.ts
git commit -m "feat(core): closed event catalog + webhooks scopes (EN-C)"
```

---

## Task C2: Persistence — three models, both repos, wiring

**THE PARITY RULE APPLIES IN FULL.** Everything below lands in one commit.

**Files:**
- Modify: `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/types.ts`, `apps/api/src/persistence/memory.ts`, `apps/api/src/persistence/prisma.ts`, `apps/api/src/context.ts`, and every `buildApp` construction site.
- Test: `apps/api/test/webhooks-persistence.test.ts`

- [ ] **Step 1: Add the Prisma models**

Append to `apps/api/prisma/schema.prisma`:

```prisma
// EN-C event outbox. Deliberately NOT the audit log: AuditLog is per-asset
// hash-chained (@@unique([assetId, seq])) for HA-B tamper evidence, its seq is
// per-asset, and assetId is null for every credential/org row — so it has no
// global cursor. `seq` here is that cursor.
//
// `seq` is the @id because SQLite/Prisma only allow @default(autoincrement())
// on an Int @id. The public, stable identifier sent to integrators is `id`.
model Event {
  seq        Int      @id @default(autoincrement())
  id         String   @unique @default(cuid())
  type       String
  orgId      String? // the single owning org; null = platform-scope
  useCaseKey String?
  subjectId  String? // the credential / asset / verification this is about
  data       String // JSON-encoded, redacted payload
  occurredAt DateTime @default(now())

  @@index([orgId, seq])
  @@index([type])
}

// An org's declared interest. `secretEncrypted` is AES-256-GCM under
// DID_MASTER_KEY, NOT a hash: HMAC signing must REPRODUCE the secret, so a
// one-way hash would make signing impossible.
model WebhookEndpoint {
  id                  String    @id @default(cuid())
  orgId               String? // null = platform-scope, PlatformAdmin only
  url                 String
  description         String?
  eventTypes          String // JSON string[]; ["*"] allowed
  useCaseKey          String?
  secretEncrypted     String
  status              String    @default("active") // active | disabled
  disabledReason      String?
  disabledAt          DateTime?
  consecutiveFailures Int       @default(0)
  deletedAt           DateTime?
  createdBy           String
  createdAt           DateTime  @default(now())
  lastDeliveryAt      DateTime?

  @@index([orgId])
}

// One attempt chain for one (event, endpoint) pair. The unique pair is the
// fan-out idempotency key: re-emitting or re-fanning cannot double-enqueue.
model WebhookDelivery {
  id             String    @id @default(cuid())
  endpointId     String
  eventId        String
  eventSeq       Int
  status         String    @default("pending") // pending | inflight | delivered | failed | dead
  attempts       Int       @default(0)
  nextAttemptAt  DateTime  @default(now())
  lastAttemptAt  DateTime?
  responseStatus Int?
  responseError  String?
  durationMs     Int?
  claimedAt      DateTime?
  claimedBy      String?
  createdAt      DateTime  @default(now())

  @@unique([endpointId, eventId])
  @@index([status, nextAttemptAt])
}
```

Then:

```bash
cd apps/api && npx prisma generate
```

- [ ] **Step 2: Add the record types and repository interfaces**

In `apps/api/src/persistence/types.ts`:

```ts
export interface EventRecord {
  /** Global monotonic cursor. */
  seq: number;
  /** Public, stable id sent to integrators as Tokenlayer-Event-Id. */
  id: string;
  type: string;
  /** The single owning org — the tenancy key. null = platform-scope. */
  orgId: string | null;
  useCaseKey: string | null;
  subjectId: string | null;
  data: Record<string, unknown>;
  occurredAt: string;
}

export interface EventRepository {
  append(input: Omit<EventRecord, "seq" | "id" | "occurredAt"> & { occurredAt?: string }): Promise<EventRecord>;
  /** Cursor read, seq-ascending. `orgId: undefined` = every org (PlatformAdmin). */
  listAfter(after: number, opts: { orgId?: string | null; type?: string; limit: number }): Promise<EventRecord[]>;
  findById(id: string): Promise<EventRecord | null>;
}

export interface WebhookEndpointRecord {
  id: string;
  orgId: string | null;
  url: string;
  description: string | null;
  eventTypes: string[];
  useCaseKey: string | null;
  /** AES-256-GCM ciphertext. NEVER returned by any read route. */
  secretEncrypted: string;
  status: "active" | "disabled";
  disabledReason: string | null;
  disabledAt: string | null;
  consecutiveFailures: number;
  deletedAt: string | null;
  createdBy: string;
  createdAt: string;
  lastDeliveryAt: string | null;
}

export interface WebhookEndpointRepository {
  create(input: Omit<WebhookEndpointRecord, "id" | "createdAt" | "status" | "disabledReason" | "disabledAt" | "consecutiveFailures" | "deletedAt" | "lastDeliveryAt">): Promise<WebhookEndpointRecord>;
  findById(id: string): Promise<WebhookEndpointRecord | null>;
  /** Live endpoints of one org. `null` lists platform-scope endpoints. */
  listByOrg(orgId: string | null): Promise<WebhookEndpointRecord[]>;
  /** Every active, non-deleted endpoint — the fan-out candidate set. */
  listActive(): Promise<WebhookEndpointRecord[]>;
  update(id: string, patch: Partial<Pick<WebhookEndpointRecord, "url" | "description" | "eventTypes" | "useCaseKey" | "secretEncrypted" | "status" | "disabledReason" | "disabledAt" | "consecutiveFailures" | "deletedAt" | "lastDeliveryAt">>): Promise<WebhookEndpointRecord>;
}

export interface WebhookDeliveryRecord {
  id: string;
  endpointId: string;
  eventId: string;
  eventSeq: number;
  status: "pending" | "inflight" | "delivered" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  responseError: string | null;
  durationMs: number | null;
  claimedAt: string | null;
  claimedBy: string | null;
  createdAt: string;
}

export interface WebhookDeliveryRepository {
  /** Idempotent on (endpointId, eventId): a duplicate returns the existing row. */
  enqueue(input: { endpointId: string; eventId: string; eventSeq: number }): Promise<WebhookDeliveryRecord>;
  findById(id: string): Promise<WebhookDeliveryRecord | null>;
  listByEndpoint(endpointId: string, limit: number): Promise<WebhookDeliveryRecord[]>;
  /** Due = (pending|failed) and nextAttemptAt <= now, oldest first. */
  listDue(now: string, limit: number): Promise<WebhookDeliveryRecord[]>;
  /**
   * CAS claim: pending|failed -> inflight, ONLY if still unclaimed. Returns the
   * claimed row or null if another instance won. Mirrors ProposalRepository's
   * claimDecided — this is what makes two dispatchers safe.
   */
  claim(id: string, workerId: string, now: string): Promise<WebhookDeliveryRecord | null>;
  /** Rows stuck inflight since before `before` — crash recovery. */
  reclaimStale(before: string): Promise<number>;
  update(id: string, patch: Partial<Pick<WebhookDeliveryRecord, "status" | "attempts" | "nextAttemptAt" | "lastAttemptAt" | "responseStatus" | "responseError" | "durationMs" | "claimedAt" | "claimedBy">>): Promise<WebhookDeliveryRecord>;
}
```

- [ ] **Step 3: Write the parity test FIRST**

`apps/api/test/webhooks-persistence.test.ts` — run against the memory repos; the prisma side is proven by the live walkthrough in C8.

```ts
import { describe, expect, it } from "vitest";
import { MemoryEventRepository, MemoryWebhookDeliveryRepository, MemoryWebhookEndpointRepository } from "../src/persistence/memory.js";

const endpointInput = {
  orgId: "org1", url: "https://example.test/hook", description: null,
  eventTypes: ["credential.issued"], useCaseKey: null,
  secretEncrypted: "ct", createdBy: "u1",
};

describe("event repository", () => {
  it("assigns a strictly increasing seq and a distinct public id", async () => {
    const repo = new MemoryEventRepository();
    const a = await repo.append({ type: "credential.issued", orgId: "org1", useCaseKey: null, subjectId: "c1", data: { a: 1 } });
    const b = await repo.append({ type: "asset.issued", orgId: "org1", useCaseKey: null, subjectId: "a1", data: {} });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(a.id).not.toEqual(b.id);
    expect(a.data).toEqual({ a: 1 });
  });

  it("listAfter is exclusive, seq-ordered, org-filtered and limited", async () => {
    const repo = new MemoryEventRepository();
    const a = await repo.append({ type: "credential.issued", orgId: "org1", useCaseKey: null, subjectId: null, data: {} });
    await repo.append({ type: "credential.issued", orgId: "org2", useCaseKey: null, subjectId: null, data: {} });
    const c = await repo.append({ type: "asset.issued", orgId: "org1", useCaseKey: null, subjectId: null, data: {} });
    const mine = await repo.listAfter(0, { orgId: "org1", limit: 10 });
    expect(mine.map((e) => e.seq)).toEqual([a.seq, c.seq]);
    expect(await repo.listAfter(a.seq, { orgId: "org1", limit: 10 })).toHaveLength(1);
    expect(await repo.listAfter(0, { orgId: "org1", limit: 1 })).toHaveLength(1);
    expect(await repo.listAfter(0, { orgId: "org1", type: "asset.issued", limit: 10 })).toHaveLength(1);
  });
});

describe("delivery repository", () => {
  it("enqueue is idempotent on (endpoint, event)", async () => {
    const repo = new MemoryWebhookDeliveryRepository();
    const a = await repo.enqueue({ endpointId: "e1", eventId: "ev1", eventSeq: 1 });
    const b = await repo.enqueue({ endpointId: "e1", eventId: "ev1", eventSeq: 1 });
    expect(b.id).toEqual(a.id);
    expect(await repo.listByEndpoint("e1", 10)).toHaveLength(1);
  });

  it("claim is a compare-and-set: the second caller gets null", async () => {
    const repo = new MemoryWebhookDeliveryRepository();
    const d = await repo.enqueue({ endpointId: "e1", eventId: "ev1", eventSeq: 1 });
    const now = new Date().toISOString();
    expect(await repo.claim(d.id, "worker-a", now)).not.toBeNull();
    expect(await repo.claim(d.id, "worker-b", now)).toBeNull();
  });

  it("reclaimStale returns inflight rows to pending", async () => {
    const repo = new MemoryWebhookDeliveryRepository();
    const d = await repo.enqueue({ endpointId: "e1", eventId: "ev1", eventSeq: 1 });
    await repo.claim(d.id, "dead-worker", "2020-01-01T00:00:00.000Z");
    expect(await repo.reclaimStale("2021-01-01T00:00:00.000Z")).toBe(1);
    expect((await repo.findById(d.id))!.status).toBe("pending");
  });

  it("listDue excludes future, delivered and dead rows", async () => {
    const repo = new MemoryWebhookDeliveryRepository();
    const due = await repo.enqueue({ endpointId: "e1", eventId: "ev1", eventSeq: 1 });
    const later = await repo.enqueue({ endpointId: "e1", eventId: "ev2", eventSeq: 2 });
    await repo.update(later.id, { nextAttemptAt: "2999-01-01T00:00:00.000Z", status: "failed" });
    const done = await repo.enqueue({ endpointId: "e1", eventId: "ev3", eventSeq: 3 });
    await repo.update(done.id, { status: "delivered" });
    const ids = (await repo.listDue(new Date().toISOString(), 10)).map((d) => d.id);
    expect(ids).toEqual([due.id]);
  });
});

describe("endpoint repository", () => {
  it("listActive excludes disabled and soft-deleted endpoints", async () => {
    const repo = new MemoryWebhookEndpointRepository();
    const live = await repo.create(endpointInput);
    const off = await repo.create(endpointInput);
    const gone = await repo.create(endpointInput);
    await repo.update(off.id, { status: "disabled", disabledReason: "too many failures" });
    await repo.update(gone.id, { deletedAt: new Date().toISOString() });
    expect((await repo.listActive()).map((e) => e.id)).toEqual([live.id]);
  });

  it("listByOrg(null) lists platform-scope endpoints, not every org's", async () => {
    const repo = new MemoryWebhookEndpointRepository();
    await repo.create(endpointInput);
    const plat = await repo.create({ ...endpointInput, orgId: null });
    expect((await repo.listByOrg(null)).map((e) => e.id)).toEqual([plat.id]);
  });
});
```

- [ ] **Step 4: Run it, watch it fail**

```bash
pnpm --filter @tokenlayer/api test -- --run webhooks-persistence
```

Expected: FAIL — the memory repos do not exist.

- [ ] **Step 5: Implement the memory repos**

In `apps/api/src/persistence/memory.ts`, following the `MemoryApiKeyRepository` style (a `Map` keyed by id, `randomUUID()` ids, ISO strings):

```ts
export class MemoryEventRepository implements EventRepository {
  private readonly rows: EventRecord[] = [];
  private nextSeq = 1;
  async append(input: Omit<EventRecord, "seq" | "id" | "occurredAt"> & { occurredAt?: string }): Promise<EventRecord> {
    const rec: EventRecord = {
      seq: this.nextSeq++, id: `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      type: input.type, orgId: input.orgId, useCaseKey: input.useCaseKey ?? null,
      subjectId: input.subjectId ?? null, data: input.data,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    };
    this.rows.push(rec);
    return { ...rec };
  }
  async listAfter(after: number, opts: { orgId?: string | null; type?: string; limit: number }): Promise<EventRecord[]> {
    return this.rows
      .filter((e) => e.seq > after)
      .filter((e) => (opts.orgId === undefined ? true : e.orgId === opts.orgId))
      .filter((e) => (opts.type ? e.type === opts.type : true))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, opts.limit)
      .map((e) => ({ ...e }));
  }
  async findById(id: string): Promise<EventRecord | null> {
    const r = this.rows.find((e) => e.id === id);
    return r ? { ...r } : null;
  }
}
```

`MemoryWebhookEndpointRepository`: a `Map<string, WebhookEndpointRecord>`; `create` fills `status: "active"`, `consecutiveFailures: 0`, and the nullable lifecycle columns with `null`; `listByOrg(orgId)` filters `r.orgId === orgId && r.deletedAt === null`; `listActive()` filters `r.status === "active" && r.deletedAt === null`; `update` merges and returns a copy.

`MemoryWebhookDeliveryRepository`: a `Map<string, WebhookDeliveryRecord>`; `enqueue` first scans for an existing `(endpointId, eventId)` and returns it (emulating the DB unique constraint); `claim` returns `null` unless `status` is `pending` or `failed`, otherwise sets `status: "inflight"`, `claimedAt: now`, `claimedBy: workerId`; `reclaimStale(before)` flips `inflight` rows whose `claimedAt < before` back to `pending`, clearing the claim, returning the count; `listDue` filters `(pending|failed) && nextAttemptAt <= now`, sorts by `nextAttemptAt` then `eventSeq`, slices to `limit`.

- [ ] **Step 6: Implement the prisma repos**

In `apps/api/src/persistence/prisma.ts`, mirroring `toApiKey`:

```ts
const toEvent = (r: {
  seq: number; id: string; type: string; orgId: string | null; useCaseKey: string | null;
  subjectId: string | null; data: string; occurredAt: Date;
}): EventRecord => ({
  seq: r.seq, id: r.id, type: r.type, orgId: r.orgId, useCaseKey: r.useCaseKey,
  subjectId: r.subjectId, data: JSON.parse(r.data) as Record<string, unknown>,
  occurredAt: r.occurredAt.toISOString(),
});
```

`toWebhookEndpoint` parses `eventTypes` from JSON, casts `status` to the union, and ISO-formats `disabledAt`, `deletedAt`, `createdAt`, `lastDeliveryAt`. `toWebhookDelivery` casts `status` and ISO-formats `nextAttemptAt`, `lastAttemptAt`, `claimedAt`, `createdAt`.

The two that are not mechanical:

```ts
async enqueue(input: { endpointId: string; eventId: string; eventSeq: number }): Promise<WebhookDeliveryRecord> {
  // The unique (endpointId, eventId) pair IS the idempotency key. upsert with an
  // empty update returns the existing row instead of throwing P2002.
  return toWebhookDelivery(await prisma.webhookDelivery.upsert({
    where: { endpointId_eventId: { endpointId: input.endpointId, eventId: input.eventId } },
    create: { endpointId: input.endpointId, eventId: input.eventId, eventSeq: input.eventSeq },
    update: {},
  }));
}

async claim(id: string, workerId: string, now: string): Promise<WebhookDeliveryRecord | null> {
  // Compare-and-set. The status predicate is inside the WHERE, so two racing
  // dispatchers cannot both transition the same row — the loser updates 0 rows.
  const n = await prisma.webhookDelivery.updateMany({
    where: { id, status: { in: ["pending", "failed"] } },
    data: { status: "inflight", claimedAt: new Date(now), claimedBy: workerId },
  });
  if (n.count === 0) return null;
  const r = await prisma.webhookDelivery.findUnique({ where: { id } });
  return r ? toWebhookDelivery(r) : null;
}
```

- [ ] **Step 7: Wire AppDeps — make the fields REQUIRED**

In `apps/api/src/context.ts`, inside `AppDeps`:

```ts
  /** EN-C event outbox: the durable, globally ordered log integrators read. */
  events: EventRepository;
  webhookEndpoints: WebhookEndpointRepository;
  webhookDeliveries: WebhookDeliveryRepository;
```

Required, not optional, so every construction site that forgets them is a **compile error** rather than a runtime surprise. Find them all:

```bash
grep -rln "buildApp(" apps/api/src apps/api/test
```

Add `events: new MemoryEventRepository(), webhookEndpoints: new MemoryWebhookEndpointRepository(), webhookDeliveries: new MemoryWebhookDeliveryRepository(),` to each memory-based site (`demo.ts`, `e2e-buy.ts`, `e2e-tenancy.ts`, `e2e-usecases.ts`, `e2e-carbon.ts`, the test harness) and the Prisma variants in `server.ts`.

- [ ] **Step 8: Run everything**

```bash
cd apps/api && npx prisma generate && cd ../.. \
  && npx tsc --noEmit -p apps/api \
  && pnpm --filter @tokenlayer/api test -- --run --testTimeout=180000
```

Expected: PASS — 502 existing + the new persistence cases.

- [ ] **Step 9: Mutation-check the CAS**

In the memory `claim`, drop the status predicate so it always claims. The "second caller gets null" test must fail. Restore.

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence apps/api/src/context.ts apps/api/src/*.ts apps/api/test/webhooks-persistence.test.ts
git commit -m "feat(api): Event + WebhookEndpoint + WebhookDelivery persistence (EN-C)"
```

---

## Task C3: The two pure modules that carry the risk — URL guard and signing

Neither touches the database or the network. Both are heavily tested because both are load-bearing for security.

**Files:**
- Create: `apps/api/src/webhooks/url-guard.ts`, `apps/api/src/webhooks/signing.ts`, `apps/api/src/webhooks/secret-box.ts`, `apps/api/src/webhooks/matching.ts`
- Test: `apps/api/test/webhooks-url-guard.test.ts`, `apps/api/test/webhooks-signing.test.ts`

- [ ] **Step 1: Write the URL-guard test**

`apps/api/test/webhooks-url-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertDeliverableUrl, checkUrl } from "../src/webhooks/url-guard.js";

/** Deterministic resolver stub — the guard never does real DNS in tests. */
const resolvesTo = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];

describe("webhook URL guard", () => {
  const publicDns = resolvesTo({ "hooks.example.com": ["93.184.216.34"] });

  it("accepts a public HTTPS URL", async () => {
    await expect(assertDeliverableUrl("https://hooks.example.com/x", { resolve: publicDns })).resolves.toBeUndefined();
  });

  for (const [label, url] of [
    ["cloud metadata by literal IP", "https://169.254.169.254/latest/meta-data/"],
    ["loopback by literal IP", "https://127.0.0.1/hook"],
    ["IPv6 loopback", "https://[::1]/hook"],
    ["private 10/8", "https://10.0.0.5/hook"],
    ["private 172.16/12", "https://172.16.3.4/hook"],
    ["private 192.168/16", "https://192.168.1.10/hook"],
    ["CGNAT 100.64/10", "https://100.64.0.1/hook"],
    ["plain HTTP to a public host", "http://hooks.example.com/x"],
    ["credentials in the URL", "https://user:pass@hooks.example.com/x"],
    ["a non-HTTP scheme", "file:///etc/passwd"],
  ] as const) {
    it(`rejects ${label}`, async () => {
      await expect(assertDeliverableUrl(url, { resolve: publicDns })).rejects.toThrow();
    });
  }

  it("rejects a public NAME that resolves to a private address", async () => {
    const rebind = resolvesTo({ "evil.example.com": ["10.1.2.3"] });
    await expect(assertDeliverableUrl("https://evil.example.com/x", { resolve: rebind })).rejects.toThrow(/private|not publicly routable/i);
  });

  it("THE REBINDING CASE: public at registration, private at delivery", async () => {
    const atRegistration = resolvesTo({ "flip.example.com": ["93.184.216.34"] });
    const atDelivery = resolvesTo({ "flip.example.com": ["127.0.0.1"] });
    await expect(assertDeliverableUrl("https://flip.example.com/x", { resolve: atRegistration })).resolves.toBeUndefined();
    // The SAME url must be rejected when checked again at delivery time. This is
    // the whole reason the guard runs twice rather than only on registration.
    await expect(assertDeliverableUrl("https://flip.example.com/x", { resolve: atDelivery })).rejects.toThrow();
  });

  it("allows http to loopback ONLY when explicitly opted in (dev/test)", async () => {
    const loop = resolvesTo({ localhost: ["127.0.0.1"] });
    await expect(assertDeliverableUrl("http://localhost:9931/hook", { resolve: loop })).rejects.toThrow();
    await expect(assertDeliverableUrl("http://localhost:9931/hook", { resolve: loop, allowInsecureLoopback: true })).resolves.toBeUndefined();
  });

  it("checkUrl reports a reason instead of throwing", async () => {
    const r = await checkUrl("https://127.0.0.1/x", { resolve: publicDns });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/loopback/i);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

```bash
pnpm --filter @tokenlayer/api test -- --run webhooks-url-guard
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the guard**

`apps/api/src/webhooks/url-guard.ts`:

```ts
/**
 * SSRF guard (EN-C). A webhook URL is the first place an ORG-SUPPLIED string
 * tells this server where to send a request FROM INSIDE THE NETWORK. Unguarded,
 * an OrgAdmin points an endpoint at 169.254.169.254 (cloud metadata) or
 * localhost:8545 (the operator's own Besu node) and the API becomes their proxy.
 *
 * Run at REGISTRATION and AGAIN immediately before EVERY delivery attempt.
 * Checking only at registration is defeated by DNS rebinding: a name that
 * resolved publicly when it was saved can resolve to 127.0.0.1 an hour later.
 *
 * Pure by construction — the resolver is injected, so the whole policy is
 * testable without DNS or HTTP.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolver = (host: string) => Promise<string[]>;

export interface UrlGuardOptions {
  resolve?: Resolver;
  /** Dev/test only: permits http:// to a loopback address. */
  allowInsecureLoopback?: boolean;
}

export type UrlVerdict = { ok: true } | { ok: false; reason: string };

const realResolve: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Every range an integrator endpoint has no business being in. */
function blockedReason(ip: string): string | null {
  const v = isIP(ip);
  if (v === 6) {
    const a = ip.toLowerCase();
    if (a === "::1") return "IPv6 loopback";
    if (a === "::") return "unspecified address";
    if (a.startsWith("fe80")) return "IPv6 link-local";
    if (a.startsWith("fc") || a.startsWith("fd")) return "IPv6 unique-local";
    // ::ffff:a.b.c.d — judge the embedded v4 address, not the wrapper.
    const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return blockedReason(m[1]!);
    return null;
  }
  if (v !== 4) return "not an IP address";
  const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
  if (a === 0) return "unspecified network";
  if (a === 127) return "loopback";
  if (a === 10) return "private 10/8";
  if (a === 172 && b >= 16 && b <= 31) return "private 172.16/12";
  if (a === 192 && b === 168) return "private 192.168/16";
  if (a === 169 && b === 254) return "link-local / cloud metadata";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT 100.64/10";
  if (a >= 224) return "multicast or reserved";
  return null;
}

export async function checkUrl(raw: string, opts: UrlGuardOptions = {}): Promise<UrlVerdict> {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: "not a valid absolute URL" }; }

  if (u.username || u.password) return { ok: false, reason: "credentials in the URL are not allowed" };
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: `unsupported scheme '${u.protocol}'` };

  const host = u.hostname.replace(/^\[|\]$/g, "");
  const resolve = opts.resolve ?? realResolve;
  const addrs = isIP(host) ? [host] : await resolve(host);
  if (addrs.length === 0) return { ok: false, reason: `host '${host}' does not resolve` };

  // EVERY resolved address must be acceptable. A name resolving to one public
  // and one private address is a rebinding attempt, not a valid endpoint.
  for (const ip of addrs) {
    const bad = blockedReason(ip);
    if (bad) {
      const loopbackOk = opts.allowInsecureLoopback && (bad === "loopback" || bad === "IPv6 loopback");
      if (!loopbackOk) return { ok: false, reason: `${ip} is ${bad} — not publicly routable` };
    }
  }

  if (u.protocol === "http:") {
    const allLoopback = addrs.every((ip) => { const r = blockedReason(ip); return r === "loopback" || r === "IPv6 loopback"; });
    if (!(opts.allowInsecureLoopback && allLoopback)) {
      return { ok: false, reason: "webhook URLs must use https" };
    }
  }
  return { ok: true };
}

export async function assertDeliverableUrl(raw: string, opts: UrlGuardOptions = {}): Promise<void> {
  const v = await checkUrl(raw, opts);
  if (!v.ok) throw new Error(v.reason);
}
```

- [ ] **Step 4: Write the signing test**

`apps/api/test/webhooks-signing.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signPayload, signatureHeader, verifySignature } from "../src/webhooks/signing.js";

const SECRET = "whsec_test_0123456789abcdef";
const BODY = JSON.stringify({ id: "evt_1", type: "credential.issued" });
const T = 1754697600;

describe("webhook signing", () => {
  it("matches an independently computed HMAC over `${t}.${rawBody}`", () => {
    const expected = createHmac("sha256", SECRET).update(`${T}.${BODY}`).digest("hex");
    expect(signPayload(SECRET, T, BODY)).toEqual(expected);
  });

  it("emits the documented header format", () => {
    expect(signatureHeader(SECRET, T, BODY)).toEqual(`t=${T},v1=${signPayload(SECRET, T, BODY)}`);
  });

  it("a single byte changed in the body invalidates it", () => {
    const header = signatureHeader(SECRET, T, BODY);
    expect(verifySignature(SECRET, header, BODY, { nowSeconds: T })).toBe(true);
    expect(verifySignature(SECRET, header, BODY.replace("evt_1", "evt_2"), { nowSeconds: T })).toBe(false);
  });

  it("the timestamp is INSIDE the signed material, so it cannot be re-stamped", () => {
    const header = signatureHeader(SECRET, T, BODY);
    const restamped = header.replace(`t=${T}`, `t=${T + 10}`);
    expect(verifySignature(SECRET, restamped, BODY, { nowSeconds: T + 10 })).toBe(false);
  });

  it("rejects a stale delivery outside the tolerance", () => {
    const header = signatureHeader(SECRET, T, BODY);
    expect(verifySignature(SECRET, header, BODY, { nowSeconds: T + 299 })).toBe(true);
    expect(verifySignature(SECRET, header, BODY, { nowSeconds: T + 301 })).toBe(false);
  });

  it("rejects a wrong secret and a malformed header", () => {
    const header = signatureHeader(SECRET, T, BODY);
    expect(verifySignature("whsec_other", header, BODY, { nowSeconds: T })).toBe(false);
    expect(verifySignature(SECRET, "garbage", BODY, { nowSeconds: T })).toBe(false);
    expect(verifySignature(SECRET, `t=${T},v2=abc`, BODY, { nowSeconds: T })).toBe(false);
  });
});
```

- [ ] **Step 5: Implement signing**

`apps/api/src/webhooks/signing.ts`:

```ts
/**
 * Delivery signing (EN-C). HMAC-SHA256 over `${timestamp}.${rawBody}` with the
 * endpoint's shared secret, in the Stripe/GitHub shape integrators already know.
 *
 * The timestamp is INSIDE the signed material. Signing the body alone would let
 * anyone who captured one delivery replay it forever against a verifier that
 * checks freshness — the freshness check would be unauthenticated.
 *
 * `v1=` is a version prefix so the scheme can change without breaking verifiers.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
}

export function signatureHeader(secret: string, timestampSeconds: number, rawBody: string): string {
  return `t=${timestampSeconds},v1=${signPayload(secret, timestampSeconds, rawBody)}`;
}

/** The recipe we document to integrators, implemented so our own tests use it. */
export function verifySignature(
  secret: string, header: string, rawBody: string,
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;

  const parts = new Map(header.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)] as const; }));
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now - t) > tolerance) return false;

  const expected = Buffer.from(signPayload(secret, t, rawBody), "hex");
  const got = Buffer.from(v1, "hex");
  // Length check first: timingSafeEqual throws on a length mismatch.
  return expected.length === got.length && timingSafeEqual(expected, got);
}
```

- [ ] **Step 6: Implement the secret box and the matcher**

`apps/api/src/webhooks/secret-box.ts` — the same AES-256-GCM envelope `keystore.ts` uses for custodial seeds (12-byte IV ‖ 16-byte tag ‖ ciphertext, base64):

```ts
/**
 * The endpoint secret is stored ENCRYPTED, not hashed. EN-B's API keys are
 * bcrypt-hashed because the platform only ever VERIFIES a secret someone
 * presents. HMAC signing is the opposite: the dispatcher must REPRODUCE the
 * secret on every delivery, so a one-way hash makes signing impossible — while
 * plaintext at rest hands over every integrator's signing key in one DB read.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12, TAG_LEN = 16;

export interface SecretBox {
  seal(plaintext: string): string;
  open(sealed: string): string;
  /** A fresh endpoint secret. Shown once, never retrievable again. */
  mint(): string;
}

export function createSecretBox(masterKeyHex: string): SecretBox {
  const key = Buffer.from(masterKeyHex, "hex");
  if (key.length !== 32) throw new Error("webhook secret key must be 32 bytes (64 hex chars)");
  return {
    seal(plaintext) {
      const iv = randomBytes(IV_LEN);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
    },
    open(sealed) {
      const buf = Buffer.from(sealed, "base64");
      const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_LEN));
      d.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
      return Buffer.concat([d.update(buf.subarray(IV_LEN + TAG_LEN)), d.final()]).toString("utf8");
    },
    mint: () => `whsec_${randomBytes(24).toString("base64url")}`,
  };
}
```

`apps/api/src/webhooks/matching.ts` — **the tenancy decision, written as an explicit disjunction**:

```ts
import type { EventRecord, WebhookEndpointRecord } from "../persistence/types.js";

/**
 * Does this endpoint receive this event?
 *
 * The org rule is deliberately a DISJUNCTION, not an equality. Writing it as
 * `ep.orgId === ev.orgId` looks equivalent and is not: a platform-scope event
 * (orgId null) would then match every org-scoped endpoint whose orgId happened
 * to be null. That `null === null` shape is exactly the class of bug EN-B's
 * final review found in the user-management predicate, where an unscoped
 * service user matched every PlatformAdmin. Two different rules, spelled out.
 */
export function endpointMatches(ep: WebhookEndpointRecord, ev: EventRecord): boolean {
  if (ep.status !== "active" || ep.deletedAt !== null) return false;
  const orgOk = ep.orgId === null            // platform-scope: sees everything
    || (ev.orgId !== null && ep.orgId === ev.orgId); // org-scope: only its own
  if (!orgOk) return false;
  if (ep.useCaseKey !== null && ep.useCaseKey !== ev.useCaseKey) return false;
  return ep.eventTypes.includes("*") || ep.eventTypes.includes(ev.type);
}
```

Add to `apps/api/test/webhooks-signing.test.ts` (or a sibling) the four matcher cases that pin the disjunction:

```ts
import { endpointMatches } from "../src/webhooks/matching.js";

const ep = (o: Partial<WebhookEndpointRecord>) => ({
  id: "e", orgId: "org1", url: "https://x.test", description: null, eventTypes: ["*"],
  useCaseKey: null, secretEncrypted: "", status: "active" as const, disabledReason: null,
  disabledAt: null, consecutiveFailures: 0, deletedAt: null, createdBy: "u", createdAt: "",
  lastDeliveryAt: null, ...o,
});
const ev = (o: Partial<EventRecord>) => ({
  seq: 1, id: "evt", type: "credential.issued", orgId: "org1", useCaseKey: null,
  subjectId: null, data: {}, occurredAt: "", ...o,
});

it("an org endpoint sees its own org's events and no others", () => {
  expect(endpointMatches(ep({}), ev({ orgId: "org1" }))).toBe(true);
  expect(endpointMatches(ep({}), ev({ orgId: "org2" }))).toBe(false);
});
it("an org endpoint NEVER sees a platform-scope event (the null === null trap)", () => {
  expect(endpointMatches(ep({ orgId: null }), ev({ orgId: null }))).toBe(true);  // platform sees platform
  expect(endpointMatches(ep({ orgId: "org1" }), ev({ orgId: null }))).toBe(false); // org must not
});
it("a platform endpoint sees every org's events", () => {
  expect(endpointMatches(ep({ orgId: null }), ev({ orgId: "org7" }))).toBe(true);
});
it("a useCaseKey filter narrows, and a disabled endpoint receives nothing", () => {
  expect(endpointMatches(ep({ useCaseKey: "uc1" }), ev({ useCaseKey: "uc2" }))).toBe(false);
  expect(endpointMatches(ep({ status: "disabled" }), ev({}))).toBe(false);
});
```

- [ ] **Step 7: Run and mutation-check**

```bash
pnpm --filter @tokenlayer/api test -- --run webhooks-url-guard webhooks-signing
```

Then apply each mutation and confirm a specific test dies:
1. `endpointMatches` org rule → `ep.orgId === ev.orgId`. The `null === null` trap test must fail.
2. `checkUrl` — return `{ok:true}` before the resolved-address loop. The rebinding test must fail.
3. `verifySignature` — drop the tolerance check. The stale-delivery test must fail.
4. `signPayload` — sign `rawBody` alone. The re-stamp test must fail.

Restore each. Report all four.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/webhooks apps/api/test/webhooks-url-guard.test.ts apps/api/test/webhooks-signing.test.ts
git commit -m "feat(api): webhook URL guard, HMAC signing, secret box, tenancy matcher (EN-C)"
```

---

## Task C4: Emit — the outbox writer, the emit sites, and the anti-drift test

**Files:**
- Create: `apps/api/src/events.ts`, `apps/api/test/events-emit-coverage.test.ts`
- Modify: `apps/api/src/http/routes.ts` (emit sites), `apps/api/src/credential-usecase-kinds.ts`, `apps/api/src/credential-kinds.ts`, `apps/api/src/executors.ts`

- [ ] **Step 1: Write the emit test**

`apps/api/test/events-emit-coverage.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EVENT_TYPES } from "@tokenlayer/core";
import { describe, expect, it } from "vitest";

/**
 * ANTI-DRIFT. The spec chose an explicit outbox over deriving events from the
 * audit sink, and the cost of that choice is that a future author can add a
 * catalog entry and forget to emit it — a subscription that silently never
 * fires. This test makes the omission a build failure, the same way
 * scope-coverage.test.ts makes an ungated route a build failure.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

function allSource(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (e.name.endsWith(".ts")) out.push(readFileSync(`${dir}/${e.name}`, "utf8"));
    }
  };
  walk(SRC);
  return out.join("\n");
}

describe("event emit coverage", () => {
  it("every catalog type has at least one emit site", () => {
    const src = allSource();
    const missing = EVENT_TYPES.filter((t) => !src.includes(`"${t}"`));
    expect(missing, `catalog types with no emit site: ${missing.join(", ")}`).toEqual([]);
  });
});
```

Plus a behavioural test in `apps/api/test/webhooks-routes.test.ts` (created in C6) is not enough on its own — add these here too, using the memory repos directly:

```ts
import { MemoryEventRepository, MemoryWebhookDeliveryRepository, MemoryWebhookEndpointRepository } from "../src/persistence/memory.js";
import { emitEvent } from "../src/events.js";

const depsFor = () => ({
  events: new MemoryEventRepository(),
  webhookEndpoints: new MemoryWebhookEndpointRepository(),
  webhookDeliveries: new MemoryWebhookDeliveryRepository(),
  log: { error: () => {}, warn: () => {} },
});

describe("emitEvent", () => {
  it("writes the event and fans out ONLY to matching endpoints", async () => {
    const d = depsFor();
    const mine = await d.webhookEndpoints.create({ orgId: "org1", url: "https://a.test", description: null, eventTypes: ["credential.issued"], useCaseKey: null, secretEncrypted: "x", createdBy: "u" });
    await d.webhookEndpoints.create({ orgId: "org2", url: "https://b.test", description: null, eventTypes: ["*"], useCaseKey: null, secretEncrypted: "x", createdBy: "u" });
    await d.webhookEndpoints.create({ orgId: "org1", url: "https://c.test", description: null, eventTypes: ["asset.issued"], useCaseKey: null, secretEncrypted: "x", createdBy: "u" });

    await emitEvent(d as never, { type: "credential.issued", orgId: "org1", subjectId: "cred1", data: { credentialId: "cred1" } });

    expect(await d.webhookDeliveries.listByEndpoint(mine.id, 10)).toHaveLength(1);
    expect(await d.events.listAfter(0, { orgId: "org1", limit: 10 })).toHaveLength(1);
  });

  it("NEVER throws into the caller — observing must not break acting", async () => {
    const d = depsFor();
    d.events.append = async () => { throw new Error("db down"); };
    await expect(emitEvent(d as never, { type: "asset.issued", orgId: "org1", data: {} })).resolves.toBeUndefined();
  });

  it("refuses to persist credential material", async () => {
    const d = depsFor();
    await emitEvent(d as never, { type: "credential.issued", orgId: "org1", data: { credentialId: "c1", passwordHash: "$2a$12$x", vcJwt: "ey..." } as never });
    const [ev] = await d.events.listAfter(0, { orgId: "org1", limit: 10 });
    expect(JSON.stringify(ev)).not.toContain("$2a$");
    expect(JSON.stringify(ev)).not.toContain("ey...");
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

```bash
pnpm --filter @tokenlayer/api test -- --run events-emit-coverage
```

Expected: FAIL — `emitEvent` does not exist and no catalog type has an emit site.

- [ ] **Step 3: Implement emit**

`apps/api/src/events.ts`:

```ts
/**
 * The outbox writer (EN-C). Called at the points that already audit, it records
 * the fact and fans out a delivery row per matching endpoint.
 *
 * FAN-OUT HAPPENS HERE, not at dispatch time, so the (endpointId, eventId)
 * unique pair is the idempotency key and an endpoint registered later does not
 * retroactively receive old events — that is what GET /events?after= is for.
 *
 * THIS FUNCTION NEVER THROWS. Observing must never break acting: a webhook
 * subsystem failure must not fail a credential issuance that already happened.
 * Failures are logged loudly and swallowed.
 */
import type { EventType } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { endpointMatches } from "./webhooks/matching.js";

/** Keys that must never reach an integrator, at any nesting depth. */
const FORBIDDEN_KEYS = new Set(["passwordHash", "secretHash", "secretEncrypted", "didSeedEncrypted", "vcJwt", "secret", "password"]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      out[k] = redact(v);
    }
    return out;
  }
  if (typeof value === "string" && value.startsWith("tl_live_")) return "[redacted]";
  return value;
}

export interface EmitInput {
  type: EventType;
  /** The single owning org. null = platform-scope (PlatformAdmin endpoints only). */
  orgId: string | null;
  useCaseKey?: string | null;
  subjectId?: string | null;
  data: Record<string, unknown>;
}

export async function emitEvent(deps: AppDeps, input: EmitInput): Promise<void> {
  try {
    const event = await deps.events.append({
      type: input.type, orgId: input.orgId,
      useCaseKey: input.useCaseKey ?? null, subjectId: input.subjectId ?? null,
      data: redact(input.data) as Record<string, unknown>,
    });
    const endpoints = await deps.webhookEndpoints.listActive();
    for (const ep of endpoints) {
      if (!endpointMatches(ep, event)) continue;
      await deps.webhookDeliveries.enqueue({ endpointId: ep.id, eventId: event.id, eventSeq: event.seq });
    }
  } catch (err) {
    // Deliberately swallowed — see the module comment.
    console.error("[events] emit failed", { type: input.type, orgId: input.orgId, err });
  }
}
```

- [ ] **Step 4: Add the ten emit sites**

Each goes immediately after the corresponding successful state change, next to the existing audit append. `orgId` is the **acting/owning** org.

| Event | Site | orgId | subjectId |
|---|---|---|---|
| `credential.issued` | `credential-issuance.ts`, after the credential row is created and anchored | `issuerOrg.id` | credential id |
| `credential.accepted` | routes.ts, holder-acceptance route after status flips | credential's issuer org | credential id |
| `credential.rejected` | routes.ts, the reject branch of the same route | credential's issuer org | credential id |
| `credential.revoked` | routes.ts, revoke route after chain-first revocation succeeds | credential's issuer org | credential id |
| `verification.requested` | routes.ts, verification request route after the row is created | `verifierOrgId \|\| null` | request id |
| `verification.completed` | routes.ts, verify route after the result is stored | `verifierOrgId \|\| null` | request id |
| `asset.issued` | `issueAssetCore` in routes.ts, after the mint returns | use case's `ownerOrgId` | asset id |
| `asset.transferred` | routes.ts, transfer route after the ledger call | use case's `ownerOrgId` | asset id |
| `asset.redeemed` | routes.ts, redeem/burn route after the ledger call | use case's `ownerOrgId` | asset id |
| `proposal.executed` | `decide()` in routes.ts, after `executeProposal` returns | `p.orgId` | proposal id |

Example, the issuance site:

```ts
await emitEvent(deps, {
  type: "credential.issued",
  orgId: issuerOrg.id,
  useCaseKey: def.key,
  subjectId: credential.id,
  data: {
    credentialId: credential.id, credentialType: spec.name,
    subjectDid: pl.subjectDid, issuerOrgId: issuerOrg.id,
    useCaseKey: def.key, issuedAt: credential.issuedAt, expiresAt: credential.expiresAt,
    txHash: credential.anchorTxHash ?? null,
  },
});
```

**Payload rule:** identifiers, type, status and timestamps — never the signed credential, never claim values that were not already visible to the owning org. An integrator that needs the credential fetches it with its EN-B key, which re-runs every authorization gate.

- [ ] **Step 5: Run the suite**

```bash
pnpm --filter @tokenlayer/api test -- --run --testTimeout=180000
```

Expected: PASS. Existing tests must be untouched — emit is additive and swallows its own failures.

- [ ] **Step 6: Mutation-check**

1. Remove the `credential.revoked` emit site — the coverage test must fail naming it.
2. Delete `if (FORBIDDEN_KEYS.has(k)) continue;` — the "refuses to persist credential material" test must fail.
3. Remove the try/catch — the "NEVER throws" test must fail.

Restore each.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/events.ts apps/api/src/http/routes.ts apps/api/src/credential-issuance.ts apps/api/test/events-emit-coverage.test.ts
git commit -m "feat(api): event emit + fan-out with redaction and coverage guard (EN-C)"
```

---

## Task C5: The dispatcher — retries, dead-letter, auto-disable, CAS

**Files:**
- Create: `apps/api/src/webhooks/dispatcher.ts`, `apps/api/test/webhooks-dispatch.test.ts`
- Modify: `apps/api/src/env.ts`, `apps/api/src/server.ts`, `apps/api/src/context.ts`

- [ ] **Step 1: Add the env knobs**

In `apps/api/src/env.ts`, inside the exported `env` object:

```ts
  webhooksEnabled: process.env.WEBHOOKS_ENABLED !== "0",
  webhooksPollMs: process.env.WEBHOOKS_POLL_MS ? Number(process.env.WEBHOOKS_POLL_MS) : 2000,
  webhooksAllowInsecure: process.env.WEBHOOKS_ALLOW_INSECURE === "1",
  webhooksTimeoutMs: process.env.WEBHOOKS_TIMEOUT_MS ? Number(process.env.WEBHOOKS_TIMEOUT_MS) : 10_000,
```

Add `webhooksAllowInsecure: boolean;` to `AppDeps` (the routes need it for the registration-time guard).

- [ ] **Step 2: Write the dispatcher test**

`apps/api/test/webhooks-dispatch.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository, MemoryWebhookDeliveryRepository, MemoryWebhookEndpointRepository } from "../src/persistence/memory.js";
import { createSecretBox } from "../src/webhooks/secret-box.js";
import { dispatchDue, BACKOFF_MS, MAX_ATTEMPTS, AUTO_DISABLE_AFTER } from "../src/webhooks/dispatcher.js";
import { verifySignature } from "../src/webhooks/signing.js";

const box = createSecretBox("22".repeat(32));

async function fixture(overrides: { eventTypes?: string[] } = {}) {
  const events = new MemoryEventRepository();
  const endpoints = new MemoryWebhookEndpointRepository();
  const deliveries = new MemoryWebhookDeliveryRepository();
  const secret = box.mint();
  const ep = await endpoints.create({
    orgId: "org1", url: "https://hooks.example.test/x", description: null,
    eventTypes: overrides.eventTypes ?? ["*"], useCaseKey: null,
    secretEncrypted: box.seal(secret), createdBy: "u1",
  });
  const ev = await events.append({ type: "credential.issued", orgId: "org1", useCaseKey: null, subjectId: "c1", data: { credentialId: "c1" } });
  const d = await deliveries.enqueue({ endpointId: ep.id, eventId: ev.id, eventSeq: ev.seq });
  return { events, endpoints, deliveries, ep, ev, d, secret };
}

/** Never real DNS or HTTP in dispatcher tests. */
const okGuard = { resolve: async () => ["93.184.216.34"] };

describe("dispatcher", () => {
  it("delivers a signed payload the documented recipe verifies", async () => {
    const f = await fixture();
    let seen: { url: string; body: string; headers: Record<string, string> } | null = null;
    const send = vi.fn(async (url: string, body: string, headers: Record<string, string>) => {
      seen = { url, body, headers };
      return { status: 200 };
    });
    await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" } as never);

    expect(seen!.url).toBe("https://hooks.example.test/x");
    expect(seen!.headers["Tokenlayer-Event-Id"]).toBe(f.ev.id);
    expect(seen!.headers["Tokenlayer-Event-Type"]).toBe("credential.issued");
    expect(verifySignature(f.secret, seen!.headers["Tokenlayer-Signature"]!, seen!.body)).toBe(true);
    expect((await f.deliveries.findById(f.d.id))!.status).toBe("delivered");
  });

  it("a 500 schedules a retry with growing backoff, and does not deliver", async () => {
    const f = await fixture();
    const send = vi.fn(async () => ({ status: 500 }));
    await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" } as never);
    const after1 = (await f.deliveries.findById(f.d.id))!;
    expect(after1.status).toBe("failed");
    expect(after1.attempts).toBe(1);
    expect(Date.parse(after1.nextAttemptAt) - Date.now()).toBeGreaterThan(BACKOFF_MS[0]! * 0.7);
  });

  it("a 3xx is a FAILURE — redirects are not followed", async () => {
    const f = await fixture();
    const send = vi.fn(async () => ({ status: 302 }));
    await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" } as never);
    expect((await f.deliveries.findById(f.d.id))!.status).toBe("failed");
  });

  it("reaches dead after MAX_ATTEMPTS and stops being due", async () => {
    const f = await fixture();
    const send = vi.fn(async () => ({ status: 500 }));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await f.deliveries.update(f.d.id, { nextAttemptAt: new Date(Date.now() - 1000).toISOString() });
      await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" } as never);
    }
    const dead = (await f.deliveries.findById(f.d.id))!;
    expect(dead.status).toBe("dead");
    expect(dead.attempts).toBe(MAX_ATTEMPTS);
    expect(await f.deliveries.listDue(new Date().toISOString(), 10)).toHaveLength(0);
  });

  it("auto-disables an endpoint after AUTO_DISABLE_AFTER consecutive failures", async () => {
    const f = await fixture();
    await f.endpoints.update(f.ep.id, { consecutiveFailures: AUTO_DISABLE_AFTER - 1 });
    const send = vi.fn(async () => ({ status: 500 }));
    await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" } as never);
    const ep = await f.endpoints.findById(f.ep.id);
    expect(ep!.status).toBe("disabled");
    expect(ep!.disabledReason).toMatch(/consecutive/i);
  });

  it("a success resets the consecutive-failure counter", async () => {
    const f = await fixture();
    await f.endpoints.update(f.ep.id, { consecutiveFailures: 5 });
    await dispatchDue({ ...f, secretBox: box, send: async () => ({ status: 200 }), guard: okGuard, workerId: "w1" } as never);
    expect((await f.endpoints.findById(f.ep.id))!.consecutiveFailures).toBe(0);
  });

  it("REFUSES to deliver when the URL guard rejects at delivery time (rebinding)", async () => {
    const f = await fixture();
    const send = vi.fn(async () => ({ status: 200 }));
    const rebound = { resolve: async () => ["127.0.0.1"] };
    await dispatchDue({ ...f, secretBox: box, send, guard: rebound, workerId: "w1" } as never);
    expect(send).not.toHaveBeenCalled();
    const d = (await f.deliveries.findById(f.d.id))!;
    expect(d.status).toBe("failed");
    expect(d.responseError).toMatch(/loopback|not publicly routable/i);
  });

  it("a claimed delivery is invisible to a second concurrent dispatcher", async () => {
    const f = await fixture();
    const slow = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); return { status: 200 }; });
    const [a, b] = await Promise.all([
      dispatchDue({ ...f, secretBox: box, send: slow, guard: okGuard, workerId: "w1" } as never),
      dispatchDue({ ...f, secretBox: box, send: slow, guard: okGuard, workerId: "w2" } as never),
    ]);
    expect(a + b).toBe(1); // exactly one dispatcher handled it
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run it, watch it fail**

```bash
pnpm --filter @tokenlayer/api test -- --run webhooks-dispatch
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the dispatcher**

`apps/api/src/webhooks/dispatcher.ts`:

```ts
/**
 * The first background worker in this codebase (EN-C).
 *
 * `dispatchDue()` is the whole worker minus the timer, so tests drive it
 * directly and the test harness never starts a live interval. `startDispatcher`
 * is only called from server.ts.
 *
 * Every delivery is CLAIMED with a compare-and-set before any HTTP happens,
 * mirroring ProposalRepository.claimDecided. That makes a second API instance
 * SAFE (it cannot double-send) though not COORDINATED (no fair distribution);
 * an operator running replicas sets WEBHOOKS_ENABLED=0 on all but one.
 */
import { randomUUID } from "node:crypto";
import type { EventRepository, WebhookDeliveryRepository, WebhookEndpointRepository } from "../persistence/types.js";
import type { SecretBox } from "./secret-box.js";
import { checkUrl, type UrlGuardOptions } from "./url-guard.js";
import { signatureHeader } from "./signing.js";

/** Delays BEFORE attempts 2..6 — six attempts spanning ~8h. */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
export const AUTO_DISABLE_AFTER = 20;
const STALE_CLAIM_MS = 120_000;

export type Sender = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;

export interface DispatchDeps {
  events: EventRepository;
  webhookEndpoints: WebhookEndpointRepository;
  webhookDeliveries: WebhookDeliveryRepository;
  secretBox: SecretBox;
  send: Sender;
  guard: UrlGuardOptions;
  workerId: string;
  batchSize?: number;
}

/** ±20% jitter so a recovering endpoint is not thundered by a backlog. */
function withJitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

export const httpSender: Sender = async (url, body, headers) => {
  const res = await fetch(url, {
    method: "POST", body, headers: { ...headers, "content-type": "application/json" },
    redirect: "manual", // a 3xx is a failure, never a hop — the target of a
                        // redirect has not been through the URL guard
    signal: AbortSignal.timeout(Number(process.env.WEBHOOKS_TIMEOUT_MS ?? 10_000)),
  });
  // Read and discard a bounded prefix: we record only the status, and an
  // integrator streaming an unbounded body must not be able to hold us open.
  try { await res.text(); } catch { /* body is not part of the contract */ }
  return { status: res.status };
};

/** One pass. Returns how many deliveries this worker actually handled. */
export async function dispatchDue(deps: DispatchDeps): Promise<number> {
  const now = new Date();
  await deps.webhookDeliveries.reclaimStale(new Date(now.getTime() - STALE_CLAIM_MS).toISOString());

  const due = await deps.webhookDeliveries.listDue(now.toISOString(), deps.batchSize ?? 20);
  let handled = 0;

  for (const row of due) {
    const claimed = await deps.webhookDeliveries.claim(row.id, deps.workerId, new Date().toISOString());
    if (!claimed) continue; // another worker won the race
    handled++;

    const endpoint = await deps.webhookEndpoints.findById(claimed.endpointId);
    const event = await deps.events.findById(claimed.eventId);
    if (!endpoint || !event || endpoint.status !== "active" || endpoint.deletedAt !== null) {
      await deps.webhookDeliveries.update(claimed.id, { status: "dead", responseError: "endpoint is no longer deliverable", claimedAt: null, claimedBy: null });
      continue;
    }

    const attempts = claimed.attempts + 1;
    const startedAt = Date.now();
    let ok = false;
    let responseStatus: number | null = null;
    let responseError: string | null = null;

    // RE-CHECK THE URL. It passed at registration; DNS may have moved since.
    const verdict = await checkUrl(endpoint.url, deps.guard);
    if (!verdict.ok) {
      responseError = verdict.reason;
    } else {
      const body = JSON.stringify({
        id: event.id, seq: event.seq, type: event.type,
        occurredAt: event.occurredAt, orgId: event.orgId,
        useCaseKey: event.useCaseKey, subjectId: event.subjectId, data: event.data,
      });
      const t = Math.floor(Date.now() / 1000);
      try {
        const res = await deps.send(endpoint.url, body, {
          "Tokenlayer-Event-Id": event.id,
          "Tokenlayer-Delivery-Id": claimed.id,
          "Tokenlayer-Event-Type": event.type,
          "Tokenlayer-Signature": signatureHeader(deps.secretBox.open(endpoint.secretEncrypted), t, body),
        });
        responseStatus = res.status;
        ok = res.status >= 200 && res.status < 300; // 3xx is a failure
        if (!ok) responseError = `endpoint returned ${res.status}`;
      } catch (err) {
        responseError = err instanceof Error ? err.message : String(err);
      }
    }

    const terminal = ok || attempts >= MAX_ATTEMPTS;
    await deps.webhookDeliveries.update(claimed.id, {
      status: ok ? "delivered" : terminal ? "dead" : "failed",
      attempts, lastAttemptAt: new Date().toISOString(),
      nextAttemptAt: ok || terminal
        ? claimed.nextAttemptAt
        : new Date(Date.now() + withJitter(BACKOFF_MS[attempts - 1] ?? BACKOFF_MS.at(-1)!)).toISOString(),
      responseStatus, responseError, durationMs: Date.now() - startedAt,
      claimedAt: null, claimedBy: null,
    });

    const failures = ok ? 0 : endpoint.consecutiveFailures + 1;
    await deps.webhookEndpoints.update(endpoint.id, {
      consecutiveFailures: failures,
      lastDeliveryAt: new Date().toISOString(),
      ...(failures >= AUTO_DISABLE_AFTER
        ? { status: "disabled" as const, disabledReason: `${failures} consecutive delivery failures`, disabledAt: new Date().toISOString() }
        : {}),
    });
  }
  return handled;
}

export function startDispatcher(deps: Omit<DispatchDeps, "workerId">, pollMs: number): () => void {
  const workerId = `wh-${randomUUID().slice(0, 8)}`;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap passes
    running = true;
    try { await dispatchDue({ ...deps, workerId }); }
    catch (err) { console.error("[webhooks] dispatch pass failed", err); }
    finally { running = false; }
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
```

- [ ] **Step 5: Start it from server.ts only**

In `apps/api/src/server.ts`, after `await app.listen(...)`:

```ts
  // Started HERE, not in buildApp, so the test harness never runs a live timer.
  if (env.webhooksEnabled) {
    const stop = startDispatcher({
      events, webhookEndpoints, webhookDeliveries,
      secretBox: createSecretBox(env.didMasterKey),
      send: httpSender,
      guard: { allowInsecureLoopback: env.webhooksAllowInsecure },
    }, env.webhooksPollMs);
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.once(sig, () => { stop(); process.exit(0); });
    }
    console.log(`[webhooks] dispatcher polling every ${env.webhooksPollMs}ms`);
  }
```

- [ ] **Step 6: Run and mutation-check**

```bash
pnpm --filter @tokenlayer/api test -- --run webhooks-dispatch
```

Mutations, each must kill a specific test:
1. Skip the `claim` call and process `row` directly → the concurrency test fails.
2. `ok = res.status < 400` → the 3xx test fails.
3. Drop the delivery-time `checkUrl` → the rebinding test fails.
4. Never set `status: "disabled"` → the auto-disable test fails.
5. Fixed backoff instead of `BACKOFF_MS[attempts - 1]` → the growing-backoff test fails.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/webhooks/dispatcher.ts apps/api/src/env.ts apps/api/src/server.ts apps/api/src/context.ts apps/api/test/webhooks-dispatch.test.ts
git commit -m "feat(api): webhook dispatcher — CAS claim, backoff, dead-letter, auto-disable (EN-C)"
```

---

## Task C6: Routes, schemas, and the scope map

**Files:**
- Modify: `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`, `apps/api/test/scope-coverage.test.ts`
- Test: `apps/api/test/webhooks-routes.test.ts`

- [ ] **Step 1: Write the route test**

`apps/api/test/webhooks-routes.test.ts` — follow the existing harness style in `apps/api/test/api-keys.test.ts` (build the app with memory repos, log in as seeded admins). Cover:

```ts
it("creates an endpoint and returns the secret EXACTLY once", async () => {
  const res = await post(`/orgs/${orgId}/webhooks`, { url: "https://hooks.example.test/x", eventTypes: ["credential.issued"] }, adminToken);
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.secret).toMatch(/^whsec_/);
  const list = await get(`/orgs/${orgId}/webhooks`, adminToken);
  expect(JSON.stringify(list.json())).not.toContain(body.secret);
  expect(JSON.stringify(list.json())).not.toContain("secretEncrypted");
});

it("rejects an SSRF URL at registration with a specific reason", async () => {
  const res = await post(`/orgs/${orgId}/webhooks`, { url: "https://169.254.169.254/", eventTypes: ["*"] }, adminToken);
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("INVALID_WEBHOOK_URL");
});

it("rejects an unknown event type naming the valid list", async () => {
  const res = await post(`/orgs/${orgId}/webhooks`, { url: "https://hooks.example.test/x", eventTypes: ["organization.registered"] }, adminToken);
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("UNKNOWN_EVENT_TYPE");
});

it("EN-A: an identity-only org cannot subscribe to asset events", async () => {
  await patch(`/orgs/${orgId}/capabilities`, { capabilities: { domains: ["identity"], roles: ["Issuer"] } }, adminToken);
  const res = await post(`/orgs/${orgId}/webhooks`, { url: "https://hooks.example.test/x", eventTypes: ["asset.issued"] }, adminToken);
  expect(res.statusCode).toBe(403);
  expect(res.json().error).toBe("ORG_CAPABILITY_MISSING");
});

it("EN-A is non-retroactive: tightening does not stop existing subscriptions", async () => {
  const made = await post(`/orgs/${orgId}/webhooks`, { url: "https://hooks.example.test/x", eventTypes: ["asset.issued"] }, adminToken);
  await patch(`/orgs/${orgId}/capabilities`, { capabilities: { domains: ["identity"], roles: [] } }, adminToken);
  const list = await get(`/orgs/${orgId}/webhooks`, adminToken);
  expect(list.json().find((e: { id: string }) => e.id === made.json().endpoint.id).status).toBe("active");
});

it("a foreign OrgAdmin cannot read or manage another org's endpoints", async () => {
  expect((await get(`/orgs/${otherOrgId}/webhooks`, orgAdminToken)).statusCode).toBe(403);
});

it("EN-B: webhooks:read cannot create, webhooks:write can", async () => {
  expect((await post(`/orgs/${orgId}/webhooks`, { url: "https://hooks.example.test/y", eventTypes: ["*"] }, readKey)).statusCode).toBe(403);
  expect((await get(`/orgs/${orgId}/webhooks`, readKey)).statusCode).toBe(200);
  expect((await post(`/orgs/${orgId}/webhooks`, { url: "https://hooks.example.test/y", eventTypes: ["*"] }, writeKey)).statusCode).toBe(201);
});

it("GET /events is org-scoped and cursor-exclusive", async () => {
  const first = await get(`/events?after=0`, adminToken);
  const seqs = first.json().events.map((e: { seq: number }) => e.seq);
  const next = await get(`/events?after=${seqs.at(-1)}`, adminToken);
  expect(next.json().events.every((e: { seq: number }) => e.seq > seqs.at(-1))).toBe(true);
});

it("replay of a foreign org's delivery is 404, not 403 (no existence oracle)", async () => {
  expect((await post(`/orgs/${otherOrgId}/webhooks/${foreignEpId}/deliveries/${foreignDelId}/replay`, {}, orgAdminToken)).statusCode).toBe(404);
});
```

- [ ] **Step 2: Add the schemas**

In `apps/api/src/http/schemas.ts`, following the `createApiKey` style (loose arrays; core does the real validation so the vocabulary lives in one place):

```ts
  createWebhook: {
    tags: ["Webhooks"], summary: "Register a webhook endpoint (secret returned once, never again)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["url", "eventTypes"],
      properties: {
        url: { type: "string", minLength: 1 },
        // Loose: the route runs core's validateEventTypes for the real check
        // (400 UNKNOWN_EVENT_TYPE), so the catalog lives in exactly one place.
        eventTypes: { type: "array", items: { type: "string" } },
        useCaseKey: { type: "string" },
        description: { type: "string" },
      },
    },
    response: { 201: { type: "object", additionalProperties: true } },
  },
```

Add `listWebhooks`, `updateWebhook`, `rotateWebhookSecret`, `deleteWebhook`, `testWebhook`, `listWebhookDeliveries`, `replayWebhookDelivery`, `listEvents` in the same shape. Keep responses `additionalProperties: true` — fast-json-stringify silently strips undeclared fields, which has bitten this codebase before.

- [ ] **Step 3: Implement the routes**

All nine in `apps/api/src/http/routes.ts`, reusing `apiKeyScope(request, reply, id)` for the org guard (it already refuses machine principals where required and handles PlatformAdmin/OrgAdmin):

```ts
app.post("/orgs/:id/webhooks", { schema: S.createWebhook, ...authScoped("webhooks:write") }, async (request, reply) => {
  const claims = request.user as TokenClaims;
  const { id } = request.params as { id: string };
  const b = request.body as { url: string; eventTypes: unknown; useCaseKey?: string; description?: string };
  if (!(await apiKeyScope(request, reply, id))) return;

  const eventTypes = validateEventTypes(b.eventTypes); // 400 UNKNOWN_EVENT_TYPE

  // EN-A gates SUBSCRIBING, not receiving. An org may always observe acts it
  // already performed (the envelope is non-retroactive by design), but it may
  // not newly subscribe to a domain it does not hold.
  const org = await deps.organizations.get(id);
  if (!org) return notFound(reply, "organization not found");
  for (const t of eventTypes) {
    if (t === "*") continue;
    const domain = t.startsWith("asset.") ? "tokenization" : t.startsWith("credential.") || t.startsWith("verification.") ? "identity" : null;
    if (domain && !orgDomainEnabled(org.capabilities, domain)) {
      return reply.code(403).send({ error: "ORG_CAPABILITY_MISSING", message: `organization '${org.name}' (${org.id}) does not have the '${domain}' domain`, details: { orgId: org.id, missing: domain } });
    }
  }

  const verdict = await checkUrl(b.url, { allowInsecureLoopback: deps.webhooksAllowInsecure });
  if (!verdict.ok) return reply.code(400).send({ error: "INVALID_WEBHOOK_URL", message: verdict.reason });

  const secret = deps.secretBox.mint();
  const endpoint = await deps.webhookEndpoints.create({
    orgId: id, url: b.url, description: b.description ?? null,
    eventTypes, useCaseKey: b.useCaseKey ?? null,
    secretEncrypted: deps.secretBox.seal(secret), createdBy: claims.id,
  });
  await audit(request, { action: "webhook-created", payload: { endpointId: endpoint.id, orgId: id, url: endpoint.url, eventTypes } });
  // The secret exists in a response body exactly once, here.
  return reply.code(201).send({ endpoint: webhookView(endpoint), secret });
});
```

`webhookView` strips `secretEncrypted` — the one projection every read route uses:

```ts
function webhookView(e: WebhookEndpointRecord) {
  const { secretEncrypted: _omit, ...rest } = e;
  return rest;
}
```

The remaining eight follow the same shape. `GET /events`:

```ts
app.get("/events", { schema: S.listEvents, ...authScoped("webhooks:read") }, async (request) => {
  const claims = request.user as TokenClaims;
  const q = request.query as { after?: string; type?: string; limit?: string };
  const limit = Math.min(Number(q.limit ?? 100), 500);
  // A PlatformAdmin reads every org's log; anyone else reads exactly their own.
  const orgId = claims.role === "PlatformAdmin" ? undefined : claims.orgId ?? null;
  const events = await deps.events.listAfter(Number(q.after ?? 0), { orgId, type: q.type, limit });
  return { events, nextAfter: events.at(-1)?.seq ?? Number(q.after ?? 0) };
});
```

- [ ] **Step 4: Update the scope-coverage table**

All nine routes carry `authScoped(...)`, so `scope-coverage.test.ts` needs no new exemptions. Run it to confirm:

```bash
pnpm --filter @tokenlayer/api test -- --run scope-coverage
```

Expected: PASS. If it fails, it will name the route you forgot to gate — gate it, do not exempt it.

- [ ] **Step 5: Run the suite**

```bash
npx tsc --noEmit -p apps/api && pnpm --filter @tokenlayer/api test -- --run --testTimeout=180000
```

- [ ] **Step 6: Mutation-check**

1. Return the raw record instead of `webhookView` → the "never contains secretEncrypted" test fails.
2. Drop the envelope loop → the identity-only test fails.
3. Replace the replay 404 with 403 → the no-oracle test fails.
4. Change `webhooks:write` to `webhooks:read` on create → the scope test fails.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http apps/api/test/webhooks-routes.test.ts
git commit -m "feat(api): webhook management + event cursor routes (EN-C)"
```

---

## Task C7: Web — the Webhooks section on Developers

**Files:**
- Create: `apps/web/src/components/Webhooks.tsx`, `apps/web/test/webhooks-panel.test.ts`
- Modify: `apps/web/src/components/Developers.tsx`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/types.ts`

- [ ] **Step 1: Add client types and methods**

In `apps/web/src/lib/types.ts`, mirror core's catalog (the mirrored `API_SCOPES` precedent — a stale copy can only under-offer, never over-offer):

```ts
export const EVENT_TYPES = [
  "credential.issued", "credential.accepted", "credential.rejected", "credential.revoked",
  "verification.requested", "verification.completed",
  "asset.issued", "asset.transferred", "asset.redeemed",
  "proposal.executed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Total record: an undescribed new event type fails the build. */
export const EVENT_DESCRIPTIONS: Record<EventType, string> = {
  "credential.issued": "A credential was issued to a holder.",
  "credential.accepted": "A holder accepted a credential offered to them.",
  "credential.rejected": "A holder declined a credential.",
  "credential.revoked": "A credential was revoked on-chain.",
  "verification.requested": "A verifier asked a holder to present credentials.",
  "verification.completed": "A verification finished and has a result.",
  "asset.issued": "A new asset was minted on a ledger.",
  "asset.transferred": "Tokens moved between accounts.",
  "asset.redeemed": "An asset was redeemed or burned.",
  "proposal.executed": "A maker-checker proposal was approved and executed.",
};

export interface WebhookEndpoint {
  id: string; orgId: string | null; url: string; description: string | null;
  eventTypes: string[]; useCaseKey: string | null;
  status: "active" | "disabled"; disabledReason: string | null;
  consecutiveFailures: number; createdAt: string; lastDeliveryAt: string | null;
}
export interface WebhookDelivery {
  id: string; eventId: string; eventSeq: number;
  status: "pending" | "inflight" | "delivered" | "failed" | "dead";
  attempts: number; nextAttemptAt: string; lastAttemptAt: string | null;
  responseStatus: number | null; responseError: string | null; durationMs: number | null;
}
```

- [ ] **Step 2: Write the panel test**

`apps/web/test/webhooks-panel.test.ts` — mirror `developers-key-lifecycle.test.ts` (test the logic, not the DOM):

```ts
import { describe, expect, it } from "vitest";
import { subscribableEventTypes, canRetry, EMPTY_WEBHOOK_DRAFT, checkWebhookDraft } from "../src/components/Webhooks.js";

describe("event-type filtering by the EN-A envelope", () => {
  it("null capabilities (legacy) offers every type", () => {
    expect(subscribableEventTypes(null, "OrgAdmin")).toHaveLength(10);
  });
  it("an identity-only org is not offered asset events", () => {
    const t = subscribableEventTypes({ domains: ["identity"], roles: ["Issuer"] }, "OrgAdmin");
    expect(t).toContain("credential.issued");
    expect(t).not.toContain("asset.issued");
  });
  it("a tokenization-only org is not offered credential events", () => {
    const t = subscribableEventTypes({ domains: ["tokenization"], roles: [] }, "OrgAdmin");
    expect(t).toContain("asset.issued");
    expect(t).not.toContain("credential.issued");
  });
  it("a PlatformAdmin is unfiltered", () => {
    expect(subscribableEventTypes({ domains: ["identity"], roles: [] }, "PlatformAdmin")).toHaveLength(10);
  });
});

describe("the create form refuses an incomplete draft", () => {
  it("starts with nothing selected", () => {
    expect(EMPTY_WEBHOOK_DRAFT.eventTypes).toEqual([]);
    expect(EMPTY_WEBHOOK_DRAFT.url).toBe("");
  });
  it("requires a url and at least one event type", () => {
    expect(checkWebhookDraft({ url: "", eventTypes: ["asset.issued"] }).ok).toBe(false);
    expect(checkWebhookDraft({ url: "https://x.test", eventTypes: [] }).ok).toBe(false);
    expect(checkWebhookDraft({ url: "https://x.test", eventTypes: ["asset.issued"] }).ok).toBe(true);
  });
  it("rejects a plainly non-https url before the round trip", () => {
    expect(checkWebhookDraft({ url: "http://x.test", eventTypes: ["asset.issued"] }).ok).toBe(false);
  });
});

describe("delivery affordances", () => {
  it("offers Replay only for a settled failure, never mid-flight", () => {
    expect(canRetry("dead")).toBe(true);
    expect(canRetry("failed")).toBe(true);
    expect(canRetry("inflight")).toBe(false);
    expect(canRetry("delivered")).toBe(false);
    expect(canRetry("pending")).toBe(false);
  });
});
```

- [ ] **Step 3: Build the component**

`apps/web/src/components/Webhooks.tsx`, exporting the pure helpers the test imports plus the panel. Requirements:

- Endpoint table: url, event-type pills, status, consecutive failures, last delivery.
- A **disabled** endpoint shows `disabledReason` and a Re-enable button — never a bare "disabled" with no explanation (the EN-B lesson: a status must explain itself, and an affordance must not be offered where the server will refuse it).
- Create form: url, description, event-type checkboxes **filtered by the envelope** via the shared `lib/capabilities` module, and no default selection.
- One-time secret panel: reuse EN-B's reveal-counter keying and the `lib/nav-guard` singleton so navigating away cannot silently destroy an unacknowledged secret.
- "Send test event" button calling `POST .../test`.
- Deliveries drawer: status, response code, attempts, next attempt, error; Replay only where `canRetry`.
- A copyable verification snippet:

```js
const sig = req.headers["tokenlayer-signature"];
const [t, v1] = sig.split(",").map(p => p.split("=")[1]);
const expected = crypto.createHmac("sha256", SECRET).update(`${t}.${rawBody}`).digest("hex");
const fresh = Math.abs(Math.floor(Date.now()/1000) - Number(t)) <= 300;
const ok = fresh && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

Note in the copy that `rawBody` must be the **raw** bytes, not a re-serialized object — the most common integration mistake.

- [ ] **Step 4: Mount it**

In `Developers.tsx`, render `<Webhooks orgId={orgId} org={org} token={token} />` below the API-keys card. No new nav entry, so no nav-classification decision and no repeat of the ID-N self-lockout.

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit -p apps/web && pnpm --filter @tokenlayer/web test && pnpm --filter @tokenlayer/web build
```

- [ ] **Step 6: Mutation-check**

1. `subscribableEventTypes` ignores capabilities → the identity-only test fails.
2. `EMPTY_WEBHOOK_DRAFT.eventTypes = [...EVENT_TYPES]` → the "starts with nothing selected" test fails.
3. `canRetry` returns true for `inflight` → the affordance test fails.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/Webhooks.tsx apps/web/src/components/Developers.tsx apps/web/src/lib apps/web/test/webhooks-panel.test.ts
git commit -m "feat(web): Webhooks section — endpoints, deliveries, replay, signature recipe (EN-C)"
```

---

## Task C8: Verify — suites, live Besu walkthrough, browser, review, merge

- [ ] **Step 1: Full suites**

```bash
pnpm --filter @tokenlayer/core test -- --run
pnpm --filter @tokenlayer/api test -- --run --testTimeout=180000
pnpm --filter @tokenlayer/web test
pnpm --filter @tokenlayer/web build
npx tsc --noEmit -p apps/api && npx tsc --noEmit -p apps/web
```

- [ ] **Step 2: Boot against live Besu with a throwaway DB**

```bash
cd apps/api && DATABASE_URL="file:./dev-whdemo.db" npx prisma db push --skip-generate && DATABASE_URL="file:./dev-whdemo.db" ../../node_modules/.bin/tsx src/seed.ts
```

Then, with the root `.env` sourced:

```bash
unset MST_RPC_URL MST_OPERATOR_KEY
BESU_RPC_URL=http://localhost:8545 \
BESU_OPERATOR_KEY=0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63 \
REGISTRY_CHAIN_ID=besu CHAIN_STRICT=0 DATABASE_URL="file:./dev-whdemo.db" PORT=4000 \
LOGIN_RATE_LIMIT_MAX=1000 CORS_ORIGINS=http://localhost:5173 \
ENABLED_DOMAINS=tokenization,identity \
WEBHOOKS_ALLOW_INSECURE=1 WEBHOOKS_POLL_MS=1000 \
exec ./node_modules/.bin/tsx src/server.ts
```

Boot takes ~85–130s. `WEBHOOKS_ALLOW_INSECURE=1` is what lets the walkthrough's loopback receiver be a legal endpoint.

- [ ] **Step 3: Write and run the walkthrough**

In the scratchpad, `webhook-walkthrough.mjs`. It must prove, in order:

1. A loopback receiver on a spare port records every request it gets.
2. Registering it returns **201 and the secret exactly once**; the list route never contains it.
3. `POST .../test` delivers a `ping`, and the receiver's copy **verifies against the secret** with the documented recipe — recomputed independently in the script, not by importing our signing module.
4. Issuing a real credential on Besu produces `credential.issued` at the receiver, with `subjectId` matching the credential and the on-chain anchor confirmed by `eth_call` on `VcRegistry.statusOf`.
5. Kill the receiver, issue again: the delivery goes `failed` with a growing `nextAttemptAt`, and the endpoint's `consecutiveFailures` climbs.
6. Restart the receiver, `POST .../replay` the failed delivery, and watch it land.
7. `GET /events?after=<seq before step 5>` returns **exactly** the events the receiver missed — the durable-log claim, proven.
8. A second org's endpoint receives **none** of org one's events.

- [ ] **Step 4: Browser pass**

Start vite, log in, open Developers → Webhooks. Confirm: envelope-filtered checkboxes, the one-time secret ceremony and its nav guard, a disabled endpoint showing its reason with Re-enable, and the deliveries drawer showing a real failure with Replay.

- [ ] **Step 5: Teardown**

```bash
lsof -ti tcp:4000 | xargs kill -9
rm -f apps/api/prisma/dev-whdemo.db*
ls -la apps/api/prisma/dev.db apps/api/prisma/dev.db.freshkey.bak   # mtimes MUST be unchanged
git status --porcelain                                              # expect clean
```

- [ ] **Step 6: Final whole-branch review**

Dispatch a reviewer in an **isolated worktree** with instructions to **hunt independently** rather than re-check this plan's list. On EN-A and again on EN-B, every per-task review passed and the whole-branch review found a HIGH the branch had introduced. Point it at, but do not limit it to: SSRF including redirect and rebinding, the `null`/`null` tenancy arm, secret exposure through any projection or log, the CAS under concurrency, whether auto-disable can be weaponised by a third party to silence a competitor's endpoint, and whether any emitted payload discloses more than the owning org already sees.

- [ ] **Step 7: Finish the branch**

Use `superpowers:finishing-a-development-branch` (standing choice: merge locally, `--no-ff`), delete the branch, then update `enterprise-program.md`: EN-C merged with its sha, EN-D developer portal next, plus any new gotchas discovered.

---

## Self-review

**Spec coverage.** Outbox-not-audit → C2. Three models + parity → C2. Encrypted-not-hashed secret → C3 (`secret-box.ts`). SSRF including rebinding → C3 + C5 (both checks). Signature with the timestamp inside → C3. At-least-once, no ordering guarantee → documented in C5's payload and the C7 copy. Retry schedule, dead-letter, auto-disable → C5. Dispatcher as the first worker, CAS, stale reclaim, `WEBHOOKS_ENABLED` → C5. Ten-type catalog → C1. Redaction → C4. Tenancy disjunction → C3 (`matching.ts`) with the `null === null` trap test. EN-A gates subscribing not receiving → C6, both directions tested. EN-B scopes → C1 + C6. Nine routes → C6. Web surface → C7. Testing + live walkthrough → C8.

**Placeholder scan.** No TBD/TODO; every code step carries the code; the repetitive memory-repo bodies are specified field-by-field rather than left to taste.

**Type consistency.** `EventRecord.seq`/`.id` used consistently as cursor/public-id; `endpointMatches(ep, ev)` argument order matches every call; `dispatchDue` returns the handled count that the concurrency test sums; `BACKOFF_MS`/`MAX_ATTEMPTS`/`AUTO_DISABLE_AFTER` are imported by the tests exactly as exported; `webhookView` is the single projection used by every read route.
