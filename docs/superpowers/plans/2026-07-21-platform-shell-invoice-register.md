# Platform Shell + Invoice Register Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A professional left-sidebar app shell for every role (renamed sections + My Profile + Logout) and a server-side Invoice Register that stages uploaded/ERP/manual invoices and tokenizes them selectively.

**Architecture:** A new `StagedInvoice` store + register routes ride the existing asset-issue path via a behaviour-preserving `issueAssetCore` helper extracted from `POST /assets`. On the web, a new `AppShell` wraps every authenticated screen with a fixed left sidebar; `App.tsx` maps sidebar items to the existing panels (renamed), and a new `InvoiceRegister` view replaces `InvoiceImport`.

**Tech Stack:** Fastify + Prisma/SQLite + Vitest (apps/api); React + Vite + Tailwind (apps/web); existing FakeAnchor double + live Besu E2E.

**Branch:** `feat/platform-shell-invoice-register` off main. Spec: `docs/superpowers/specs/2026-07-21-platform-shell-invoice-register-design.md`.

**Verified contracts (reconcile only if code disagrees):**
- `POST /assets` handler starts at routes.ts:323 (`app.post("/assets", { schema: S.issueAsset, ...auth }, …)`). It: validates use-case scope (403 WRONG_USE_CASE), sale terms, supply/treasury, derives `invoiceFingerprint` into `meta[derivedField]`, enforces `uniqueBy` (409 DUPLICATE_ASSET via `assets.findByMetadata`), computes cashflow schedule, charges/refunds an issuance fee, mints on-ledger, persists the asset + sale terms, audits. Gated issuance path (`useCase.workflow?.approvals?.issue`) creates a `pending_approval` proposal — the invoice use case is NOT gated (direct 201).
- `invoiceFingerprint(input)` from `@tokenlayer/core` (already imported in routes.ts:6).
- `deps.documents.get(id) → DocumentRecord|null` (fields incl. `sha256`); `storeUploadedDocument` helper exists in routes.ts for uploads.
- `deps.assets.findByMetadata(useCaseKey, field, value) → AssetRecord|null`.
- `isInvoiceUseCase(u)` is exported from `apps/web/src/components/AssetManagement.tsx:15` (true iff the use case has an `invoiceFingerprint` derived field).
- `InvoiceImport.tsx` tokenize call (the pattern to reuse): `supply = supplyFor(amount, parValue)` (round face/par), `api.issue(token, { useCaseKey, name: "<invoiceNumber> · <buyerName>", chainId, initialSupply: String(supply), treasuryAccount, metadata })`, treating `err.code === "DUPLICATE_ASSET"` specially. `parValue` default 1000. It's mounted from AssetManagement.tsx:63 as the `import` sub-tab.
- Web `api.ts`: `request<T>(path, token: string|null, init?)`, module-private `const BASE`, exported `ApiError`.
- `App.tsx`: `type Section = "overview"|"assets"|"approvals"|"users"|"organizations"|"verify"|"identity"` (line 23); Buyer branch renders `InvestorPortal` / `MyIdentity` (lines 65-86); PlatformAdmin-no-usecase renders `PlatformHome` (line ~88); OrgAdmin overview renders the `UseCaseBuilder` wizard; the section shell (lines 99-133) renders Dashboard/AssetManagement/ApprovalsPanel/UserManagement/Organizations/VerificationRequests/MyIdentity.
- `Header.tsx` shows `user.email`, `user.role`, and a sign-out that calls `useAuth().logout()` + `navigate("/")`.
- `InvestorPortal.tsx` has internal `Tab = "offerings"|"portfolio"|"activity"` and renders `InvestorOfferings`/`InvestorPortfolio`/`InvestorActivity`.
- Icons available (ui.tsx `IconName`): chain, shield, doc, users, spark, check, warn, code, globe, coins, arrow. Reuse these — do NOT add SVGs.
- `samples/erp/invoices.csv` is the bundled ERP file (`scripts/erp-import.mjs` default). Columns per that script's mapping.
- Prisma JSON convention: `String?` column holding `JSON.stringify(...)`, parsed in the repo mapper (see `Organization.companyProfile`).

---

### Task 1: API — `StagedInvoice` persistence

**Files:**
- Modify: `apps/api/src/persistence/types.ts`, `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/memory.ts`, `apps/api/src/persistence/prisma.ts`, `apps/api/src/context.ts` (AppDeps), and the two construction sites that build `AppDeps` (memory + prisma — grep `new MemoryOrganizationRepository` / `new PrismaOrganizationRepository` to find them).
- Test: `apps/api/test/staged-invoice-repo.test.ts`

- [ ] **Step 1: Types.** In `apps/api/src/persistence/types.ts` add:

```ts
export type InvoiceSource = "upload" | "erp" | "manual";
export type StagedInvoiceStatus = "staged" | "tokenized";

export interface StagedInvoiceRecord {
  id: string;
  useCaseKey: string;
  source: InvoiceSource;
  metadata: Record<string, unknown>;
  invoiceHash: string;
  documentId: string | null;
  documentSha256: string | null;
  status: StagedInvoiceStatus;
  assetId: string | null;
  createdBy: string;
  createdAt: string;
  tokenizedAt: string | null;
}

export interface StagedInvoiceRepository {
  create(input: Omit<StagedInvoiceRecord, "id" | "createdAt">): Promise<StagedInvoiceRecord>;
  get(id: string): Promise<StagedInvoiceRecord | null>;
  listByUseCase(useCaseKey: string, status?: StagedInvoiceStatus): Promise<StagedInvoiceRecord[]>;
  findByHash(useCaseKey: string, invoiceHash: string): Promise<StagedInvoiceRecord | null>;
  markTokenized(id: string, assetId: string, at: string): Promise<StagedInvoiceRecord>;
  remove(id: string): Promise<void>;
}
```

- [ ] **Step 2: Prisma model.** In `apps/api/prisma/schema.prisma` add:

```prisma
model StagedInvoice {
  id             String    @id @default(cuid())
  useCaseKey     String
  source         String    // upload | erp | manual
  metadata       String    // JSON-encoded
  invoiceHash    String
  documentId     String?
  documentSha256 String?
  status         String    @default("staged") // staged | tokenized
  assetId        String?
  createdBy      String
  createdAt      DateTime  @default(now())
  tokenizedAt    DateTime?

  @@index([useCaseKey, status])
  @@index([useCaseKey, invoiceHash])
}
```

- [ ] **Step 3: Failing repo test** — `apps/api/test/staged-invoice-repo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MemoryStagedInvoiceRepository } from "../src/persistence/memory.js";

describe("MemoryStagedInvoiceRepository", () => {
  it("creates, finds by hash, lists by status, marks tokenized, removes", async () => {
    const repo = new MemoryStagedInvoiceRepository();
    const rec = await repo.create({
      useCaseKey: "invoice-tokenization", source: "erp", metadata: { invoiceNumber: "A1" },
      invoiceHash: "0xabc", documentId: null, documentSha256: null, status: "staged",
      assetId: null, createdBy: "u1", tokenizedAt: null,
    });
    expect(rec.id).toBeTruthy();
    expect((await repo.findByHash("invoice-tokenization", "0xabc"))?.id).toBe(rec.id);
    expect(await repo.listByUseCase("invoice-tokenization", "staged")).toHaveLength(1);
    const tok = await repo.markTokenized(rec.id, "asset-1", "2026-07-21T00:00:00.000Z");
    expect(tok.status).toBe("tokenized");
    expect(tok.assetId).toBe("asset-1");
    expect(await repo.listByUseCase("invoice-tokenization", "staged")).toHaveLength(0);
    await repo.remove(rec.id);
    expect(await repo.get(rec.id)).toBeNull();
  });
});
```

- [ ] **Step 4: Run → FAIL** — `cd apps/api && ./node_modules/.bin/vitest run test/staged-invoice-repo.test.ts` (class not exported).

- [ ] **Step 5: Memory repo.** In `apps/api/src/persistence/memory.ts` add (match the `id("…")`/`now()` helpers used by sibling memory repos):

```ts
export class MemoryStagedInvoiceRepository implements StagedInvoiceRepository {
  private readonly byId = new Map<string, StagedInvoiceRecord>();
  async create(input: Omit<StagedInvoiceRecord, "id" | "createdAt">): Promise<StagedInvoiceRecord> {
    const rec: StagedInvoiceRecord = { ...input, id: id("inv"), createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async get(id: string): Promise<StagedInvoiceRecord | null> { return this.byId.get(id) ?? null; }
  async listByUseCase(useCaseKey: string, status?: StagedInvoiceStatus): Promise<StagedInvoiceRecord[]> {
    return [...this.byId.values()].filter((r) => r.useCaseKey === useCaseKey && (!status || r.status === status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  async findByHash(useCaseKey: string, invoiceHash: string): Promise<StagedInvoiceRecord | null> {
    return [...this.byId.values()].find((r) => r.useCaseKey === useCaseKey && r.invoiceHash === invoiceHash) ?? null;
  }
  async markTokenized(id: string, assetId: string, at: string): Promise<StagedInvoiceRecord> {
    const rec = this.byId.get(id);
    if (!rec) throw new Error(`unknown staged invoice '${id}'`);
    rec.status = "tokenized"; rec.assetId = assetId; rec.tokenizedAt = at;
    return rec;
  }
  async remove(id: string): Promise<void> { this.byId.delete(id); }
}
```

Import the new types (`StagedInvoiceRecord`, `StagedInvoiceRepository`, `StagedInvoiceStatus`) at the top of memory.ts.

- [ ] **Step 6: Prisma repo.** In `apps/api/src/persistence/prisma.ts` add a `toStagedInvoice` mapper (parse `metadata` JSON, ISO the dates) and `PrismaStagedInvoiceRepository` implementing the interface (`prisma.stagedInvoice.*`; `create` JSON-stringifies metadata; `markTokenized` uses `update`; `remove` uses `delete`; `listByUseCase` `findMany({ where: { useCaseKey, ...(status?{status}:{}) }, orderBy: { createdAt: "desc" } })`; `findByHash` `findFirst`). Import the types.

- [ ] **Step 7: Wire AppDeps.** In `apps/api/src/context.ts` add `stagedInvoices: StagedInvoiceRepository;` to `AppDeps`. In BOTH construction sites (memory + prisma builders), add `stagedInvoices: new MemoryStagedInvoiceRepository()` / `new PrismaStagedInvoiceRepository()`.

- [ ] **Step 8: Prisma generate + push + run.** `cd apps/api && ./node_modules/.bin/prisma generate >/dev/null && ./node_modules/.bin/prisma db push --skip-generate >/dev/null && ./node_modules/.bin/vitest run test/staged-invoice-repo.test.ts` → PASS; then `pnpm -s typecheck` clean.

- [ ] **Step 9: Commit** — `git add apps/api && git commit -m "feat(api): StagedInvoice persistence for the invoice register"`

---

### Task 2: API — extract `issueAssetCore` from `POST /assets` (behaviour-preserving)

**Files:**
- Modify: `apps/api/src/http/routes.ts` (extract the handler body into a helper; the route becomes a thin wrapper)
- Test: rely on the FULL existing api suite (no behaviour change)

- [ ] **Step 1: Extract the helper.** Inside `registerRoutes` (so `deps` is in scope), add an async function `issueAssetCore` whose body is the CURRENT `POST /assets` handler logic, but:
  - Signature: `async function issueAssetCore(input: { claims: TokenClaims; actor: Actor; useCaseKey: string; name: string; chainId: string; metadata?: Record<string, unknown>; treasuryAccount?: string; initialSupply?: string; sale?: { unitPrice: string; currency: string; treasuryAccount: string } }): Promise<{ ok: true; status: number; body: unknown } | { ok: false; status: number; error: string; message: string }>`.
  - Replace every `return reply.code(S).send({ error, message })` with `return { ok: false, status: S, error, message }`, and the final success `return reply.code(201).send(...)` (and the 202 gated path) with `return { ok: true, status: 20X, body: ... }`.
  - Read `claims`/`actor` from the params instead of `request`.

- [ ] **Step 2: Thin the route.** `POST /assets` becomes:

```ts
  app.post("/assets", { schema: S.issueAsset, ...auth }, async (request, reply) => {
    const b = request.body as { useCaseKey: string; name: string; chainId: string; metadata?: Record<string, unknown>; treasuryAccount?: string; initialSupply?: string; sale?: { unitPrice: string; currency: string; treasuryAccount: string } };
    const r = await issueAssetCore({ claims: request.user as TokenClaims, actor: actorOf(request), ...b });
    return r.ok ? reply.code(r.status).send(r.body) : reply.code(r.status).send({ error: r.error, message: r.message });
  });
```

- [ ] **Step 3: Run the FULL api suite** — `cd apps/api && ./node_modules/.bin/vitest run` → all currently-green tests STILL pass (issuance, marketplace, invoice, gated, cashflow). Then `pnpm -s typecheck`. This task is done only when the suite is byte-for-byte green (behaviour preserved).

- [ ] **Step 4: Commit** — `git add apps/api && git commit -m "refactor(api): extract issueAssetCore shared by POST /assets and the invoice register"`

---

### Task 3: API — invoice register routes + tests

**Files:**
- Create: `apps/api/src/invoice-register.ts` (ERP CSV parser + row→metadata mapping + a `stageInvoice` helper), `apps/api/test/invoice-register.test.ts`
- Modify: `apps/api/src/http/routes.ts` (routes), `apps/api/src/http/schemas.ts` (schemas)

- [ ] **Step 1: Failing tests** — `apps/api/test/invoice-register.test.ts`. Use `buildTestApp`, `loginAs`. Seed logins: `m1.issuer@tokenlayer.dev` / `m1issuer123` (invoice Issuer) and `carbon.issuer@…` or any OTHER use case's issuer for the scope test (grep seed.ts for a non-invoice issuer; if none, use a carbon UseCaseAdmin). A valid invoice row:

```ts
const row = { invoiceNumber: "REG-1", invoiceDate: "2026-07-05", buyerName: "JSW Steel", currency: "INR", amount: 1800000, dueDate: "2026-10-15" };
const V1 = "/api/v1", KEY = "invoice-tokenization";
```

Tests:
```ts
it("import stages rows, flags in-batch + existing duplicates and invalid rows", async () => {
  const app = await buildTestApp();
  const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
  const res = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/import`,
    headers: { authorization: `Bearer ${issuer}` },
    payload: { rows: [row, row, { ...row, invoiceNumber: "REG-2", amount: "not-a-number" }, { ...row, invoiceNumber: "REG-3" }] } });
  expect(res.statusCode).toBe(200);
  const results = res.json().results as { status: string }[];
  expect(results.map((r) => r.status)).toEqual(["staged", "duplicate", "invalid", "staged"]);
  const list = (await app.inject({ method: "GET", url: `${V1}/use-cases/${KEY}/invoices?status=staged`, headers: { authorization: `Bearer ${issuer}` } })).json();
  expect(list).toHaveLength(2);
  expect(list[0].invoiceHash).toMatch(/^0x/);
});

it("pull-erp stages the sample file; a second pull is all duplicates", async () => {
  const app = await buildTestApp();
  const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
  const first = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/pull-erp`, headers: { authorization: `Bearer ${issuer}` }, payload: {} });
  expect(first.statusCode).toBe(200);
  expect(first.json().staged).toBeGreaterThan(0);
  const again = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/pull-erp`, headers: { authorization: `Bearer ${issuer}` }, payload: {} });
  expect(again.json().staged).toBe(0);
  expect((again.json().results as { status: string }[]).every((r) => r.status === "duplicate")).toBe(true);
});

it("selective tokenize: chosen staged rows become assets; others stay staged; re-tokenize skipped", async () => {
  const app = await buildTestApp();
  const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
  const staged = (await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/import`,
    headers: { authorization: `Bearer ${issuer}` },
    payload: { rows: [row, { ...row, invoiceNumber: "REG-2" }, { ...row, invoiceNumber: "REG-3" }] } })).json().results.map((r: { id: string }) => r.id);
  const tok = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/tokenize`,
    headers: { authorization: `Bearer ${issuer}` },
    payload: { ids: [staged[0], staged[1]], chainId: "fabric", treasuryAccount: "0x00000000000000000000000000000000000abc01" } });
  expect(tok.statusCode).toBe(200);
  const results = tok.json().results as { status: string; assetId?: string }[];
  expect(results.filter((r) => r.status === "tokenized")).toHaveLength(2);
  expect(results.every((r) => !r.assetId || r.assetId.length > 0)).toBe(true);
  const staged2 = (await app.inject({ method: "GET", url: `${V1}/use-cases/${KEY}/invoices?status=staged`, headers: { authorization: `Bearer ${issuer}` } })).json();
  expect(staged2).toHaveLength(1); // REG-3 remains
  const retry = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/tokenize`, headers: { authorization: `Bearer ${issuer}` }, payload: { ids: [staged[0]], chainId: "fabric", treasuryAccount: "0x00000000000000000000000000000000000abc01" } });
  expect((retry.json().results as { status: string }[])[0].status).toBe("skipped");
});

it("delete staged ok, tokenized 409; foreign-use-case issuer 403", async () => {
  const app = await buildTestApp();
  const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
  const id = (await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/import`, headers: { authorization: `Bearer ${issuer}` }, payload: { rows: [row] } })).json().results[0].id;
  expect((await app.inject({ method: "DELETE", url: `${V1}/use-cases/${KEY}/invoices/${id}`, headers: { authorization: `Bearer ${issuer}` } })).statusCode).toBe(200);
  // foreign issuer (another use case) is refused
  const carbon = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123"); // adjust to a real seeded non-invoice issuer
  const forbidden = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/import`, headers: { authorization: `Bearer ${carbon}` }, payload: { rows: [row] } });
  expect(forbidden.statusCode).toBe(403);
});
```

(If the exact seeded issuer emails differ, grep `apps/api/src/seed.ts` and adjust the logins — the ASSERTIONS stay.)

- [ ] **Step 2: Run → FAIL** (routes 404).

- [ ] **Step 3: Register module** — `apps/api/src/invoice-register.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { invoiceFingerprint, validateMetadata, type UseCaseDefinition } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import type { StagedInvoiceRecord, InvoiceSource } from "./persistence/types.js";

const ERP_CSV = fileURLToPath(new URL("../../../samples/erp/invoices.csv", import.meta.url));

/** Parse the bundled ERP CSV into invoice metadata rows (header-mapped). */
export function readErpInvoices(): Record<string, unknown>[] {
  const text = readFileSync(ERP_CSV, "utf8").trim();
  const [head, ...lines] = text.split(/\r?\n/);
  const cols = head.split(",").map((c) => c.trim());
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(",");
    const rec: Record<string, unknown> = {};
    cols.forEach((c, i) => { rec[c] = cells[i]?.trim(); });
    if (rec.amount !== undefined) rec.amount = Number(rec.amount);
    return rec;
  });
}

/** Validate + fingerprint + dedupe one row; returns a staged record or a reason. */
export async function stageInvoice(
  deps: AppDeps, useCase: UseCaseDefinition, actorId: string, source: InvoiceSource,
  metadata: Record<string, unknown>, doc: { id: string; sha256: string } | null,
): Promise<{ status: "staged"; record: StagedInvoiceRecord } | { status: "duplicate" | "invalid"; error: string }> {
  try {
    validateMetadata(metadata, useCase.metadataSchema);
  } catch (err) {
    return { status: "invalid", error: (err as Error).message };
  }
  const invoiceHash = invoiceFingerprint(metadata as Parameters<typeof invoiceFingerprint>[0]);
  if (await deps.stagedInvoices.findByHash(useCase.key, invoiceHash)) return { status: "duplicate", error: "already staged" };
  if (useCase.uniqueBy && (await deps.assets.findByMetadata(useCase.key, useCase.uniqueBy, invoiceHash))) {
    return { status: "duplicate", error: "already tokenized" };
  }
  const record = await deps.stagedInvoices.create({
    useCaseKey: useCase.key, source, metadata, invoiceHash,
    documentId: doc?.id ?? null, documentSha256: doc?.sha256 ?? null,
    status: "staged", assetId: null, createdBy: actorId, tokenizedAt: null,
  });
  return { status: "staged", record };
}
```

NOTE: `validateMetadata` may require the derived field. If it rejects when `invoiceHash` is absent, strip derived-field keys from the schema's `required` before validating (the derived value is computed here, not supplied) — mirror how `POST /assets` avoids that (it never validates the raw metadata against the full schema pre-derivation; check and match its behaviour — if `POST /assets` doesn't call validateMetadata at all for invoices, DROP the validate step and treat only fingerprint-throwing rows as invalid).

- [ ] **Step 4: Routes.** In routes.ts add, near the assets routes, a helper `requireInvoiceUseCase` and the six routes. Guard: reuse the issue scope check — `claims.role === "PlatformAdmin" || key === claims.useCaseKey` (403 `WRONG_USE_CASE` otherwise) AND `deps.rbac.can(actor.role, "issue")` (403 FORBIDDEN). 404 unknown use case; 400 `NOT_INVOICE_USECASE` if `!useCase.derivedFields?.invoiceHash` (or whichever field maps to `invoiceFingerprint`).

```ts
  app.post("/use-cases/:key/invoices/import", { schema: S.importInvoices, ...auth }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const { rows } = request.body as { rows: Record<string, unknown>[] };
    const results = [];
    for (let i = 0; i < rows.length; i++) {
      const r = await stageInvoice(deps, gate.useCase, gate.actorId, "upload", rows[i], null);
      results.push(r.status === "staged" ? { index: i, status: "staged", id: r.record.id } : { index: i, status: r.status, error: r.error });
    }
    return reply.code(200).send({ staged: results.filter((r) => r.status === "staged").length, results });
  });
  app.post("/use-cases/:key/invoices/pull-erp", { schema: S.pullErp, ...auth }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const rows = readErpInvoices();
    const results = [];
    for (let i = 0; i < rows.length; i++) {
      const r = await stageInvoice(deps, gate.useCase, gate.actorId, "erp", rows[i], null);
      results.push(r.status === "staged" ? { index: i, status: "staged", id: r.record.id } : { index: i, status: r.status, error: r.error });
    }
    return reply.code(200).send({ staged: results.filter((r) => r.status === "staged").length, results });
  });
  app.post("/use-cases/:key/invoices", { schema: S.addInvoice, ...auth }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const { metadata, documentId } = request.body as { metadata: Record<string, unknown>; documentId?: string };
    let doc: { id: string; sha256: string } | null = null;
    if (documentId) {
      const d = await deps.documents.get(documentId);
      if (!d) return reply.code(400).send({ error: "DOCUMENT_NOT_FOUND", message: "document upload not found" });
      doc = { id: d.id, sha256: d.sha256 };
    }
    const r = await stageInvoice(deps, gate.useCase, gate.actorId, "manual", metadata, doc);
    if (r.status === "invalid") return reply.code(400).send({ error: "INVALID_INVOICE", message: r.error });
    if (r.status === "duplicate") return reply.code(409).send({ error: "DUPLICATE_INVOICE", message: r.error });
    return reply.code(201).send(r.record);
  });
  app.get("/use-cases/:key/invoices", { schema: S.listInvoices, ...auth }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const { status } = request.query as { status?: "staged" | "tokenized" };
    return deps.stagedInvoices.listByUseCase(gate.useCase.key, status);
  });
  app.delete("/use-cases/:key/invoices/:id", { schema: S.deleteInvoice, ...auth }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const { id } = request.params as { key: string; id: string };
    const rec = await deps.stagedInvoices.get(id);
    if (!rec || rec.useCaseKey !== gate.useCase.key) return notFound(reply, "invoice not found");
    if (rec.status !== "staged") return reply.code(409).send({ error: "ALREADY_TOKENIZED", message: "cannot delete a tokenized invoice" });
    await deps.stagedInvoices.remove(id);
    return reply.code(200).send({ id, deleted: true });
  });
  app.post("/use-cases/:key/invoices/tokenize", { schema: S.tokenizeInvoices, ...auth }, async (request, reply) => {
    const gate = await invoiceGate(request, reply); if (!gate) return reply;
    const { ids, chainId, treasuryAccount, parValue = 1000, sale } = request.body as { ids: string[]; chainId: string; treasuryAccount: string; parValue?: number; sale?: { unitPrice: string; currency: string } };
    const results = [];
    for (const id of ids) {
      const rec = await deps.stagedInvoices.get(id);
      if (!rec || rec.useCaseKey !== gate.useCase.key || rec.status !== "staged") { results.push({ id, status: "skipped" }); continue; }
      const amount = Number(rec.metadata.amount);
      const supply = Math.max(1, Math.round(amount / parValue));
      const r = await issueAssetCore({
        claims: gate.claims, actor: gate.actor, useCaseKey: gate.useCase.key,
        name: `${rec.metadata.invoiceNumber} · ${rec.metadata.buyerName}`, chainId,
        metadata: rec.metadata, initialSupply: String(supply), treasuryAccount,
        sale: sale ? { unitPrice: sale.unitPrice, currency: sale.currency, treasuryAccount } : undefined,
      });
      if (r.ok) {
        const assetId = (r.body as { asset: { id: string } }).asset.id;
        await deps.stagedInvoices.markTokenized(id, assetId, new Date().toISOString());
        results.push({ id, status: "tokenized", assetId });
      } else {
        results.push({ id, status: "failed", error: r.error });
      }
    }
    return reply.code(200).send({ results });
  });
```

Add `invoiceGate(request, reply)` near these routes returning `null` (after sending an error) or `{ useCase, claims, actor, actorId }` — resolves the use case (404), checks scope (403 WRONG_USE_CASE) + issue capability (403 FORBIDDEN) + invoice-type (400 NOT_INVOICE_USECASE). Reconcile `issueAssetCore`'s success `body` shape — confirm it returns `{ asset }` (POST /assets today returns `{ asset, txHash? }` on 201); use `.asset.id`.

- [ ] **Step 5: Schemas.** In schemas.ts add `importInvoices`, `pullErp`, `addInvoice`, `listInvoices`, `deleteInvoice`, `tokenizeInvoices` (params `{ key }` / `{ key, id }`; permissive `additionalProperties:true` bodies where rows/metadata are freeform; `...errs(400,401,403,404,409)`). Follow the `registerOrg`/`uploadKybDocument` schema idioms.

- [ ] **Step 6: Run → PASS** — the new test file, then the FULL api suite, then `pnpm -s typecheck`.

- [ ] **Step 7: Commit** — `git add apps/api && git commit -m "feat(api): invoice register — import/pull-erp/manual/list/delete/selective-tokenize"`

---

### Task 4: Web — `AppShell` left sidebar + renames + My Profile

**Files:**
- Create: `apps/web/src/components/AppShell.tsx`, `apps/web/src/components/MyProfile.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/InvestorPortal.tsx` (accept a controlled `tab`), `apps/web/src/components/PlatformHome.tsx` (its internal tabs become sidebar-driven — see Step 4)

- [ ] **Step 1: AppShell.** Create `AppShell.tsx` exporting `AppShell({ items, active, onSelect, children })` where `items: { id: string; label: string; icon: IconName }[]`. Layout: `flex min-h-screen`; a fixed `w-64` dark sidebar (`bg-ink`/the header's dark class) with the `Logo` at top, the items as full-width buttons (icon + label; active = lighter bg + brand accent), and a bottom-pinned group rendering the LAST items flagged `pinned` (My Profile, My Credentials, Logout). Top-right of the content: a slim bar with `user.email` + role pill. Content: `<main className="flex-1 …"><div className="max-w-6xl mx-auto px-6 py-6">{children}</div></main>`. Collapsible under `md` via a hamburger toggling a `useState` open flag. Logout item calls `useAuth().logout()` + `navigate("/")`.

- [ ] **Step 2: MyProfile.** Create `MyProfile.tsx`: a read-only `Card` grid from `useAuth().user` (email, role, `useCaseKey ?? "—"`, `orgId`→resolve org name via `api.orgs`/`api.org` if convenient else show the id, `walletAddress ?? "—"`, `did` truncated with a copy button, KYC status if present on the session user). A footer link/button that calls `onSelect("credentials")` (passed from App) to jump to My Credentials. Keep it simple — no fetch beyond what's cheap.

- [ ] **Step 3: App.tsx — drive everything through the shell.** Replace the three separate render branches (Buyer portal, PlatformHome, section shell) with ONE shell whose `items` are computed from role/use-case, and a `view` state (string) selecting the panel. Mapping:
  - Buyer: items `[{portfolio, coins},{offerings, spark},{transactions, arrow}]` + pinned `[{profile},{credentials, shield},{logout, arrow}]`. Render `InvestorPortal` with a controlled `tab` (portfolio/offerings/activity) for the first three; `MyProfile`/`MyIdentity` for the pinned. (Map "transactions"→InvestorPortal tab "activity".)
  - PlatformAdmin, no active use case: items Dashboard(spark), Use Cases(doc), Create Use Case(code), Organizations(users), Approvals(check), Verification(shield), Networks(chain) + pinned profile/credentials/logout. Render the corresponding PlatformHome sub-panels DIRECTLY (see Step 4) — no nested tab row.
  - PlatformAdmin WITH an active use case, and desk roles (UseCaseAdmin/Issuer/Auditor): items Dashboard(spark), Asset Ledger(coins), **Invoices(doc)** (only when `isInvoiceUseCase(activeUseCase)` and `can(role,"issue")`), Approvals(check), User Management(users) (when `canManageUsers`), Organizations(users)/Verification(shield) (when platform/OrgAdmin) + an "← All use cases"(arrow) item at top for PlatformAdmin. Pinned profile/credentials/logout.
  - OrgAdmin: Configure Use Case(code) → the UseCaseBuilder wizard, Asset Ledger, Approvals, User Management, Organizations, Verification + pinned.
  Keep the EXACT visibility predicates already in App.tsx (`canManageUsers`, `isPlatform`, OrgAdmin checks) — only the container changes. Renamed labels: **My Credentials**, **Asset Ledger**, **Recent Transactions**, **Dashboard**. `activeUseCase`/routing logic (the `useRoute` first-segment behaviour, the scoped-user clamp effect) is unchanged.

- [ ] **Step 4: PlatformHome + InvestorPortal controlled.** Give `InvestorPortal` an optional `tab?: "offerings"|"portfolio"|"activity"` prop; when provided, use it instead of internal state and hide its internal tab row (the shell drives it). For `PlatformHome`: export its sub-panels (overview/use-cases/create/networks/organizations/approvals/verify) so App can render the one matching the sidebar `view` — either lift them to named exports or add a `view` prop to PlatformHome and drop its internal tab row. Match whichever is least invasive; the goal is NO nested centered tab bar remains anywhere.

- [ ] **Step 5: Verify** — `pnpm --filter @tokenlayer/web exec tsc --noEmit` and `build` clean. (Behaviour parity is checked in the browser in Task 6.)

- [ ] **Step 6: Commit** — `git add apps/web && git commit -m "feat(web): professional left-sidebar AppShell, My Profile, section renames"`

---

### Task 5: Web — `InvoiceRegister` view (replaces `InvoiceImport`)

**Files:**
- Create: `apps/web/src/components/InvoiceRegister.tsx`
- Modify: `apps/web/src/api.ts` (client methods + types), `apps/web/src/types.ts` (StagedInvoice type), `apps/web/src/App.tsx` (render Invoices view), `apps/web/src/components/AssetManagement.tsx` (drop the `import` sub-tab), delete `apps/web/src/components/InvoiceImport.tsx`

- [ ] **Step 1: types.ts** — add:

```ts
export interface StagedInvoice {
  id: string; useCaseKey: string; source: "upload" | "erp" | "manual";
  metadata: Record<string, unknown>; invoiceHash: string;
  documentId: string | null; documentSha256: string | null;
  status: "staged" | "tokenized"; assetId: string | null;
  createdBy: string; createdAt: string; tokenizedAt: string | null;
}
export interface InvoiceRowResult { index: number; status: "staged" | "duplicate" | "invalid"; id?: string; error?: string }
export interface TokenizeResult { id: string; status: "tokenized" | "skipped" | "failed"; assetId?: string; error?: string }
```

- [ ] **Step 2: api.ts** — add:

```ts
  invoices: (token: string, key: string, status?: "staged" | "tokenized") =>
    request<StagedInvoice[]>(`/use-cases/${encodeURIComponent(key)}/invoices${status ? `?status=${status}` : ""}`, token),
  importInvoices: (token: string, key: string, rows: Record<string, unknown>[]) =>
    request<{ staged: number; results: InvoiceRowResult[] }>(`/use-cases/${encodeURIComponent(key)}/invoices/import`, token, { method: "POST", body: JSON.stringify({ rows }) }),
  pullErpInvoices: (token: string, key: string) =>
    request<{ staged: number; results: InvoiceRowResult[] }>(`/use-cases/${encodeURIComponent(key)}/invoices/pull-erp`, token, { method: "POST", body: JSON.stringify({}) }),
  addInvoice: (token: string, key: string, metadata: Record<string, unknown>, documentId?: string) =>
    request<StagedInvoice>(`/use-cases/${encodeURIComponent(key)}/invoices`, token, { method: "POST", body: JSON.stringify({ metadata, documentId }) }),
  deleteInvoice: (token: string, key: string, id: string) =>
    request<{ id: string; deleted: boolean }>(`/use-cases/${encodeURIComponent(key)}/invoices/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
  tokenizeInvoices: (token: string, key: string, body: { ids: string[]; chainId: string; treasuryAccount: string; parValue?: number; sale?: { unitPrice: string; currency: string } }) =>
    request<{ results: TokenizeResult[] }>(`/use-cases/${encodeURIComponent(key)}/invoices/tokenize`, token, { method: "POST", body: JSON.stringify(body) }),
```

Import the new types.

- [ ] **Step 3: InvoiceRegister.tsx** — props `{ useCase: UseCase; chains: ChainInfo[] }`. State: `rows: StagedInvoice[]`, `selected: Set<string>`, `busy`, `error`, `importResults`, `tokenizeOpen`. On mount + after every mutation, `api.invoices(token, useCase.key)` → `rows`. Render:
  - Toolbar buttons: **Pull from ERP** (`api.pullErpInvoices` → reload + show `{staged} staged`), **Upload CSV** (hidden file input; parse CSV client-side reusing InvoiceImport's parser — copy its `parseCsv`/row-mapping into this file before deleting the old one — → `api.importInvoices` → reload), **Add invoice** (toggle a small form built from the invoice schema's required fields + optional PDF via the KYB `uploadKybDocument`-style flow → `api.addInvoice`), **Tokenize selected (n)** (disabled when no staged rows selected; opens the tokenize form).
  - Table: checkbox (staged rows only, syncs `selected`), invoiceNumber, buyerName, amount, dueDate, source `Pill`, short `invoiceHash`, status `Pill` (staged=warn, tokenized=ok linking `assetId`), delete button (staged only → `api.deleteInvoice`).
  - Tokenize form (inline panel): chain select (deployed chains of the use case — `Object.keys(useCase.contracts ?? {})`), treasury account (text or accounts select), par value (default 1000), optional sale unitPrice + currency; submit → `api.tokenizeInvoices({ ids: [...selected], chainId, treasuryAccount, parValue, sale? })` → per-row result notices → reload; clear selection.
  - Import/ERP results: per-row notices (staged/duplicate/invalid) like the old Import tab.

- [ ] **Step 4: Wire + remove old.** In App.tsx render `<InvoiceRegister useCase={activeUseCaseObject} chains={chains} />` for the `invoices` view. In `AssetManagement.tsx` remove the `import` sub-tab entry + its `InvoiceImport` render + import (the register replaces it). Delete `apps/web/src/components/InvoiceImport.tsx` (after copying its CSV parser into InvoiceRegister). Grep for any other `InvoiceImport` references and remove.

- [ ] **Step 5: Verify** — `pnpm --filter @tokenlayer/web exec tsc --noEmit` and `build` clean.

- [ ] **Step 6: Commit** — `git add apps/web && git commit -m "feat(web): Invoice Register — upload/ERP/manual staging + selective tokenize"`

---

### Task 6: Verify — suite, browser walkthrough, finish

- [ ] **Step 1: Full verification** — from repo root `pnpm -r test` (core/contracts/adapters/api green) + `pnpm --filter @tokenlayer/web build`.

- [ ] **Step 2: Live boot** — `make besu-up`; wait for RPC; reset+seed the api DB; boot with `BESU_RPC_URL=http://localhost:8545 BESU_OPERATOR_KEY=0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63 REGISTRY_CHAIN_ID=besu DID_MASTER_KEY=<64hex> JWT_SECRET=<any> PORT=4000 LOGIN_RATE_LIMIT_MAX=1000 CORS_ORIGINS=http://localhost:5173 DEV_KYC_ISSUER_SEED=tokenlayer-demo-kyc-issuer TRUSTED_KYC_ISSUERS=did:key:z6MkmBbFP8p1GRsRWPBctZ9PcseXoojmFnyxuj5u9rMGa4uU ./node_modules/.bin/tsx src/server.ts`; `preview_start {name:"web"}`.

- [ ] **Step 3: Browser — shell + renames.** For a desk role (`m1.admin`/`m1admin123`) and PlatformAdmin (`admin@tokenlayer.dev`/`admin123`) and a Buyer: confirm the LEFT sidebar renders with role-correct items, the bottom trio (My Profile / My Credentials / Logout), the renamed labels (My Credentials, Asset Ledger, Recent Transactions, Dashboard), My Profile page shows the account card, and NO centered top-tab bar remains. Confirm Logout works.

- [ ] **Step 4: Browser — invoice register.** As `m1.issuer`/`m1issuer123` on the invoice use case: open **Invoices** → **Pull from ERP** populates the register (staged rows with fingerprints, source=erp) → select 2 rows → **Tokenize selected** on besu → the rows flip to **tokenized** with asset links → **Asset Ledger** shows the two new assets on-chain. Upload the `samples/erp/upload-batch.csv` via **Upload CSV** and confirm duplicates are flagged. Confirm no fresh console errors.

- [ ] **Step 5: Screenshot proof** — capture the sidebar shell and the invoice register post-tokenize.

- [ ] **Step 6: Finish** — stop API/preview, `make besu-down`, restore dev.db; then use superpowers:finishing-a-development-branch (full-suite gate → merge choice).

---

## Self-review notes
- Spec coverage: shell §A → Task 4 (+ My Profile, renames, Logout, PlatformHome/InvestorPortal sidebar-driven); register §B persistence → Task 1; issueAssetCore → Task 2; routes → Task 3; web register → Task 5; testing → Tasks 1/3/6. No gaps.
- Type consistency: `StagedInvoiceRecord`/`StagedInvoice` fields identical across api types, web types, repo, routes, and client; `issueAssetCore` result `{ ok, status, body|error }` consumed identically in the thin route and the tokenize loop; `readErpInvoices`/`stageInvoice` names stable.
- Risk: Task 2 (issueAssetCore extraction) is behaviour-preserving — its gate is the UNCHANGED full api suite staying green; Task 4 (shell) is the largest — its gate is tsc/build + the Task 6 browser parity check across roles.
