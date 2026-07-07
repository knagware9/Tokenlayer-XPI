# Invoice → Fractional ERC-20 + Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the `invoice-tokenization` use case from ERC-721 (one indivisible NFT per invoice, bespoke financing) to ERC-20 fractional tokens traded on the existing DvP marketplace, with server-derived invoice hashes, a unique-invoice guard, and document upload.

**Architecture:** Flip the use case's token standard so invoices flow through the existing fungible machinery (supply, treasury, listing, buy, transfer). Add two generic config-declared behaviors in core (`derivedFields` to auto-compute `invoiceHash` from canonical fields, `uniqueBy` to reject duplicate invoices at issue). Add a small document store (`POST/GET /documents`). Retire the finance/deep-tier feature (marketplace buys are now the financing). Rework the two web surfaces (IssuePanel, InvoiceImport) accordingly.

**Tech Stack:** pnpm monorepo — `@tokenlayer/core` (domain + validation), `apps/api` (Fastify + Prisma/SQLite, Vitest), `apps/web` (React + Vite + Tailwind), config JSON in `config/use-cases/`.

**Branch:** `feat/invoice-erc20-fractional` (already checked out).

**Canonical fingerprint (must stay byte-identical across Node/browser/core):**
```
fingerprint = "0x" + sha256(
  trim(invoiceNumber) + "|" +
  upper(trim(sellerGstin)) + "|" +
  upper(trim(buyerGstin)) + "|" +
  String(parseInt(amountInr, 10)) + "|" +
  trim(dueDate)
)
```

---

## Phase 1 — Core + config

### Task 1: Canonical invoice-fingerprint module in core

**Files:**
- Create: `packages/core/src/invoice-fingerprint.ts`
- Modify: `packages/core/src/index.ts` (export it)
- Test: `packages/core/test/invoice-fingerprint.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/invoice-fingerprint.test.ts
import { describe, it, expect } from "vitest";
import { invoiceFingerprint } from "../src/invoice-fingerprint.js";

describe("invoiceFingerprint", () => {
  const base = { invoiceNumber: "INV-1", sellerGstin: "27AAECS1234F1Z5", buyerGstin: "29AABCU9876R1Z3", amountInr: 1000000, dueDate: "2026-12-31" };

  it("matches the known canonical SHA-256 of the pipe-joined fields", () => {
    // Precomputed with: printf 'INV-1|27AAECS1234F1Z5|29AABCU9876R1Z3|1000000|2026-12-31' | shasum -a 256
    expect(invoiceFingerprint(base)).toBe("0x" + "e2d…").slice; // placeholder, replaced in Step 2
  });

  it("normalizes: trims fields, uppercases GSTINs, integer-parses the amount", () => {
    const messy = { invoiceNumber: " INV-1 ", sellerGstin: "27aaecs1234f1z5", buyerGstin: " 29AABCU9876R1Z3", amountInr: "1000000.00", dueDate: "2026-12-31 " };
    expect(invoiceFingerprint(messy)).toBe(invoiceFingerprint(base));
  });

  it("changes when any canonical field changes", () => {
    expect(invoiceFingerprint({ ...base, amountInr: 1000001 })).not.toBe(invoiceFingerprint(base));
  });
});
```

- [ ] **Step 2: Compute the real expected hash and fix the test**

Run: `printf 'INV-1|27AAECS1234F1Z5|29AABCU9876R1Z3|1000000|2026-12-31' | shasum -a 256`
Replace the first assertion with `expect(invoiceFingerprint(base)).toBe("0x<hash>")` using the printed hash. Delete the `.slice` placeholder.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tokenlayer/core exec vitest run test/invoice-fingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the module**

```ts
// packages/core/src/invoice-fingerprint.ts
import { createHash } from "node:crypto";

export interface InvoiceFingerprintInput {
  invoiceNumber: string | number;
  sellerGstin: string;
  buyerGstin: string;
  amountInr: string | number;
  dueDate: string;
}

/**
 * Canonical, normalization-stable fingerprint of an invoice. MUST stay
 * byte-identical to scripts/erp-import.mjs and the web computeFingerprint so the
 * same invoice hashes the same across every ingestion channel.
 */
export function invoiceFingerprint(inv: InvoiceFingerprintInput): string {
  const canonical = [
    String(inv.invoiceNumber).trim(),
    String(inv.sellerGstin).trim().toUpperCase(),
    String(inv.buyerGstin).trim().toUpperCase(),
    String(parseInt(String(inv.amountInr), 10)),
    String(inv.dueDate).trim(),
  ].join("|");
  return "0x" + createHash("sha256").update(canonical, "utf8").digest("hex");
}
```

- [ ] **Step 5: Export from core index**

Add to `packages/core/src/index.ts`:
```ts
export { invoiceFingerprint, type InvoiceFingerprintInput } from "./invoice-fingerprint.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @tokenlayer/core exec vitest run test/invoice-fingerprint.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/invoice-fingerprint.ts packages/core/src/index.ts packages/core/test/invoice-fingerprint.test.ts
git commit -m "feat(core): canonical invoice-fingerprint module (parity with erp/web hashers)"
```

---

### Task 2: `derivedFields` + `uniqueBy` config on UseCaseDefinition

**Files:**
- Modify: `packages/core/src/types.ts` (UseCaseDefinition — add optional fields, near `valuation`)
- Modify: `packages/core/src/validation.ts` (validate them)
- Test: `packages/core/test/validation.test.ts` (add cases; find the existing describe block)

- [ ] **Step 1: Add the failing validation test**

Append to `packages/core/test/validation.test.ts` inside the existing use-case validation describe:
```ts
it("accepts derivedFields.invoiceHash = invoiceFingerprint and uniqueBy = invoiceHash", () => {
  const def = { ...validFungibleUseCase(), derivedFields: { invoiceHash: "invoiceFingerprint" }, uniqueBy: "invoiceHash" };
  expect(() => validateUseCaseDefinition(def)).not.toThrow();
});

it("rejects an unknown derivedFields generator", () => {
  const def = { ...validFungibleUseCase(), derivedFields: { invoiceHash: "nope" } };
  expect(() => validateUseCaseDefinition(def)).toThrow(/derivedFields/);
});

it("rejects uniqueBy that is not a declared metadata field", () => {
  const def = { ...validFungibleUseCase(), uniqueBy: "notAField" };
  expect(() => validateUseCaseDefinition(def)).toThrow(/uniqueBy/);
});
```
If `validFungibleUseCase()` does not exist in the test file, reuse whatever minimal valid-definition helper/object the file already uses (read the file first) and spread the two new keys onto it. Ensure the base definition's `metadataSchema.properties` contains `invoiceHash` (add it if the helper's schema lacks it) so the `uniqueBy` positive case passes.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tokenlayer/core exec vitest run test/validation.test.ts`
Expected: FAIL — `derivedFields`/`uniqueBy` unknown, no throw.

- [ ] **Step 3: Add the types**

In `packages/core/src/types.ts`, inside `UseCaseDefinition`, after the `valuation?` block:
```ts
  /**
   * Metadata fields the platform computes on issue instead of accepting from the
   * client. Maps a metadata field to a named generator. Currently the only
   * generator is "invoiceFingerprint" (see invoiceFingerprint()).
   */
  derivedFields?: Record<string, "invoiceFingerprint">;
  /**
   * A metadata field whose value must be unique across the use case's assets.
   * Issue rejects a duplicate with DUPLICATE_INVOICE. Must name a declared
   * metadata property.
   */
  uniqueBy?: string;
```

- [ ] **Step 4: Add validation**

In `packages/core/src/validation.ts`, in the main `validateUseCaseDefinition` body (after the `valuation` check), add:
```ts
  if (d.derivedFields !== undefined) validateDerivedFields(d.derivedFields, d.metadataSchema, String(d.key), fail);
  if (d.uniqueBy !== undefined) validateUniqueBy(d.uniqueBy, d.metadataSchema, String(d.key), fail);
```
And add these helpers near `validateValuation`:
```ts
const DERIVED_GENERATORS = new Set(["invoiceFingerprint"]);

function validateDerivedFields(df: unknown, schema: unknown, key: string, fail: (msg: string) => never): void {
  if (typeof df !== "object" || df === null) fail(`use case '${key}' 'derivedFields' must be an object`);
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  for (const [field, gen] of Object.entries(df as Record<string, unknown>)) {
    if (!(field in props)) fail(`use case '${key}' derivedFields target '${field}' is not a declared metadata field`);
    if (typeof gen !== "string" || !DERIVED_GENERATORS.has(gen)) fail(`use case '${key}' derivedFields.${field} has unknown generator '${String(gen)}'`);
  }
}

function validateUniqueBy(uniqueBy: unknown, schema: unknown, key: string, fail: (msg: string) => never): void {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  if (typeof uniqueBy !== "string" || !(uniqueBy in props)) fail(`use case '${key}' uniqueBy '${String(uniqueBy)}' is not a declared metadata field`);
}
```
Read the top of `validateUseCaseDefinition` first to confirm the `d`/`fail` names and the `metadataSchema` access pattern; adapt the two call lines to match (the existing `valuation` call is the template).

- [ ] **Step 5: Run core tests**

Run: `pnpm --filter @tokenlayer/core exec vitest run test/validation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/validation.ts packages/core/test/validation.test.ts
git commit -m "feat(core): derivedFields + uniqueBy use-case config with validation"
```

---

### Task 3: Flip the invoice use case config to ERC-20

**Files:**
- Modify: `config/use-cases/invoice-tokenization.json`

- [ ] **Step 1: Edit the config**

- `"tokenStandard": "ERC-721"` → `"ERC-20"`.
- Remove the `tier`, `parentInvoiceHash`, `anchorBuyerGstin` properties from `metadataSchema.properties`.
- Add to `metadataSchema.properties`:
```json
"invoiceDocHash": {
  "type": "string",
  "description": "SHA-256 of the uploaded invoice document (pins the off-ledger doc)",
  "pattern": "^0x[0-9a-fA-F]{64}$"
}
```
- Keep `invoiceHash` in properties but REMOVE it from `metadataSchema.required` (it is now server-derived). Keep `invoiceNumber, sellerGstin, buyerGstin, amountInr, dueDate` required.
- Add at the top level (sibling of `valuation`):
```json
"derivedFields": { "invoiceHash": "invoiceFingerprint" },
"uniqueBy": "invoiceHash",
```
- Update the `description` to reflect fractional ERC-20 (drop NFT/tokenId wording; e.g. "…each approved invoice is tokenized into fungible units (ERC-20) that a holder lists at a discount for financiers to buy; the invoice fingerprint is enforced unique so an invoice is tokenized only once.").

- [ ] **Step 2: Validate config loads**

Run: `pnpm --filter @tokenlayer/core build && pnpm --filter @tokenlayer/api exec tsx -e "import('./src/use-cases.js').then(m=>{const d=m.loadDefaultUseCaseDefinitions().find(u=>u.key==='invoice-tokenization');console.log(d.tokenStandard, d.derivedFields, d.uniqueBy, 'tier' in d.metadataSchema.properties)})"`
Expected: `ERC-20 { invoiceHash: 'invoiceFingerprint' } invoiceHash false`
(If the tsx module path differs, adapt to however `loadDefaultUseCaseDefinitions` is exported — grep it first.)

- [ ] **Step 3: Commit**

```bash
git add config/use-cases/invoice-tokenization.json
git commit -m "config: invoice-tokenization → ERC-20 fractional; derive+unique invoiceHash; drop deep-tier fields"
```

---

## Phase 2 — API

### Task 4: `AssetRepository.findByMetadata`

**Files:**
- Modify: `apps/api/src/persistence/types.ts` (AssetRepository interface)
- Modify: `apps/api/src/persistence/prisma.ts` (PrismaAssetRepository)
- Modify: `apps/api/src/persistence/memory.ts` (MemoryAssetRepository)
- Test: `apps/api/test/persistence.test.ts` if one exists, else add to a repo test; otherwise cover via Task 5's route test.

- [ ] **Step 1: Add the interface method**

In `apps/api/src/persistence/types.ts`, in `AssetRepository`:
```ts
  /** First asset in the use case whose metadata[field] === value, else null. */
  findByMetadata(useCaseKey: string, field: string, value: unknown): Promise<AssetRecord | null>;
```

- [ ] **Step 2: Implement in memory repo**

In `apps/api/src/persistence/memory.ts`, add to `MemoryAssetRepository`:
```ts
  async findByMetadata(useCaseKey: string, field: string, value: unknown): Promise<AssetRecord | null> {
    for (const a of this.items.values()) {
      if (a.useCaseKey === useCaseKey && a.metadata?.[field] === value) return a;
    }
    return null;
  }
```
(Read the class first to match the internal store name — it may be `this.assets` or `this.items`.)

- [ ] **Step 3: Implement in prisma repo**

In `apps/api/src/persistence/prisma.ts`, add to `PrismaAssetRepository`. Metadata is stored as a JSON string column, so filter in-process over the (small) per-use-case set:
```ts
  async findByMetadata(useCaseKey: string, field: string, value: unknown): Promise<AssetRecord | null> {
    const rows = await this.prisma.asset.findMany({ where: { useCaseKey } });
    const hit = rows.find((r) => (JSON.parse(r.metadata) as Record<string, unknown>)?.[field] === value);
    return hit ? this.rowToAsset(hit) : null;
  }
```
(Match the existing row→record mapper name used elsewhere in the file, e.g. `rowToAsset`/`toAsset`.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/persistence/types.ts apps/api/src/persistence/prisma.ts apps/api/src/persistence/memory.ts
git commit -m "feat(api): AssetRepository.findByMetadata"
```

---

### Task 5: Issue route — derive `invoiceHash` + unique-invoice guard

**Files:**
- Modify: `apps/api/src/http/routes.ts` (the `POST /assets` handler)
- Test: `apps/api/test/invoice-erc20.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/test/invoice-erc20.test.ts
import { describe, it, expect } from "vitest";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";
import { invoiceFingerprint } from "@tokenlayer/core";

const UC = "invoice-tokenization";
const inv = { invoiceNumber: "INV-9001", sellerGstin: "27AAECS1234F1Z5", buyerGstin: "29AABCU9876R1Z3", amountInr: 1000000, dueDate: "2026-12-31" };

async function invoiceAdmin(app) {
  const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(platform), payload: { email: "inv.admin@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: UC } });
  return loginAs(app, "inv.admin@x.dev", "secret1");
}

describe("invoice ERC-20 issue", () => {
  it("derives invoiceHash from canonical fields, ignoring any client value", async () => {
    const app = await buildTestApp();
    const admin = await invoiceAdmin(app);
    const res = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: {
      useCaseKey: UC, name: inv.invoiceNumber, chainId: "fabric", initialSupply: "10000", treasuryAccount: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      metadata: { ...inv, invoiceHash: "0x" + "00".repeat(32) }, // bogus — must be ignored
    }});
    expect(res.statusCode).toBe(201);
    expect(res.json().asset.metadata.invoiceHash).toBe(invoiceFingerprint(inv));
  });

  it("rejects a duplicate invoice (same fingerprint) with 409 DUPLICATE_INVOICE", async () => {
    const app = await buildTestApp();
    const admin = await invoiceAdmin(app);
    const body = { useCaseKey: UC, name: inv.invoiceNumber, chainId: "fabric", initialSupply: "10000", treasuryAccount: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", metadata: { ...inv } };
    expect((await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: body })).statusCode).toBe(201);
    const dup = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { ...body, name: "dup" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("DUPLICATE_INVOICE");
  });
});
```
(Confirm `buildTestApp/loginAs/auth/V1` signatures from `apps/api/test/helpers.js`; adjust the treasury address to a seeded account if the fungible issue path requires a known account. Read an existing fungible issue test, e.g. in `api.test.ts`, for the exact issue payload shape.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/invoice-erc20.test.ts`
Expected: FAIL — hash not derived / duplicate not rejected.

- [ ] **Step 3: Implement in the issue handler**

In `apps/api/src/http/routes.ts`, find the `POST /assets` handler. After the use case is resolved and `metadata` is in hand but BEFORE `engine.issue`/persistence, insert:
```ts
    // Server-derived metadata fields (e.g. invoice fingerprint): compute from the
    // declared source fields and overwrite any client-supplied value.
    if (useCase.derivedFields) {
      for (const [field, gen] of Object.entries(useCase.derivedFields)) {
        if (gen === "invoiceFingerprint") {
          metadata[field] = invoiceFingerprint(metadata as unknown as Parameters<typeof invoiceFingerprint>[0]);
        }
      }
    }
    // Uniqueness guard: reject a second asset with the same unique field value.
    if (useCase.uniqueBy) {
      const existing = await deps.assets.findByMetadata(useCase.key, useCase.uniqueBy, metadata[useCase.uniqueBy]);
      if (existing) return reply.code(409).send({ error: "DUPLICATE_INVOICE", message: `an invoice with this fingerprint is already tokenized` });
    }
```
Add `invoiceFingerprint` to the `@tokenlayer/core` import at the top of the file. Confirm the local variable names (`useCase`, `metadata`, `deps`, `reply`) match the handler; read the handler first. Ensure this runs after metadata validation but the derived write happens before validation if `invoiceHash` is `required`+pattern — since we removed `invoiceHash` from `required`, order is flexible, but place the derive BEFORE `validateMetadata`/`engine.issue` so the derived value is validated and persisted.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/invoice-erc20.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/test/invoice-erc20.test.ts
git commit -m "feat(api): issue derives invoiceHash + rejects duplicate invoices (uniqueBy)"
```

---

### Task 6: Document store — model, repo, `POST/GET /documents`

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (Document model)
- Modify: `apps/api/src/persistence/types.ts` (DocumentRepository + record type)
- Modify: `apps/api/src/persistence/prisma.ts` (PrismaDocumentRepository)
- Modify: `apps/api/src/persistence/memory.ts` (MemoryDocumentRepository)
- Modify: `apps/api/src/context.ts` / wherever `AppDeps` is assembled (wire `documents`)
- Modify: `apps/api/src/http/routes.ts` (two routes) + `apps/api/src/http/schemas.ts` (schemas)
- Test: `apps/api/test/documents.test.ts` (new)

- [ ] **Step 1: Add the Prisma model**

In `apps/api/prisma/schema.prisma`:
```prisma
model Document {
  id          String   @id @default(cuid())
  contentType String
  sha256      String
  size        Int
  bytes       Bytes
  createdAt   DateTime @default(now())
}
```
Run: `pnpm --filter @tokenlayer/api exec prisma generate`
Expected: client regenerates without error.

- [ ] **Step 2: Add repo types**

In `apps/api/src/persistence/types.ts`:
```ts
export interface DocumentRecord { id: string; contentType: string; sha256: string; size: number; bytes: Buffer; createdAt: string; }
export interface DocumentRepository {
  create(input: { contentType: string; bytes: Buffer }): Promise<{ id: string; sha256: string; size: number }>;
  get(id: string): Promise<DocumentRecord | null>;
}
```

- [ ] **Step 3: Implement both repos**

Memory (`memory.ts`):
```ts
import { createHash, randomUUID } from "node:crypto";
export class MemoryDocumentRepository implements DocumentRepository {
  private docs = new Map<string, DocumentRecord>();
  async create({ contentType, bytes }: { contentType: string; bytes: Buffer }) {
    const id = randomUUID();
    const sha256 = "0x" + createHash("sha256").update(bytes).digest("hex");
    this.docs.set(id, { id, contentType, sha256, size: bytes.length, bytes, createdAt: new Date(0).toISOString() });
    return { id, sha256, size: bytes.length };
  }
  async get(id: string) { return this.docs.get(id) ?? null; }
}
```
Prisma (`prisma.ts`):
```ts
import { createHash } from "node:crypto";
export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private prisma: PrismaClient) {}
  async create({ contentType, bytes }: { contentType: string; bytes: Buffer }) {
    const sha256 = "0x" + createHash("sha256").update(bytes).digest("hex");
    const row = await this.prisma.document.create({ data: { contentType, sha256, size: bytes.length, bytes } });
    return { id: row.id, sha256, size: bytes.length };
  }
  async get(id: string) {
    const r = await this.prisma.document.findUnique({ where: { id } });
    return r ? { id: r.id, contentType: r.contentType, sha256: r.sha256, size: r.size, bytes: Buffer.from(r.bytes), createdAt: r.createdAt.toISOString() } : null;
  }
}
```
(`new Date(0)` avoids the ambient no-`Date.now` concern in some contexts; if the memory repo elsewhere uses real dates, follow that instead.)

- [ ] **Step 4: Wire `documents` into AppDeps**

Grep for where other repos (`assets`, `audit`) are constructed and added to the deps/context object (likely `apps/api/src/context.ts` and `apps/api/src/server.ts`/`app.ts` and `apps/api/test/helpers.ts`). Add `documents: new PrismaDocumentRepository(prisma)` (and `MemoryDocumentRepository` in the memory/test wiring), and add `documents: DocumentRepository` to the `AppDeps`/context type.

- [ ] **Step 5: Write the failing test**

```ts
// apps/api/test/documents.test.ts
import { describe, it, expect } from "vitest";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

describe("documents", () => {
  it("uploads a document (base64) and serves it back with content-type + sha", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const dataBase64 = Buffer.from("hello invoice").toString("base64");
    const up = await app.inject({ method: "POST", url: `${V1}/documents`, headers: auth(admin), payload: { contentType: "text/plain", dataBase64 } });
    expect(up.statusCode).toBe(201);
    const { id, url, sha256 } = up.json();
    expect(url).toBe(`/api/v1/documents/${id}`);
    expect(sha256).toMatch(/^0x[0-9a-f]{64}$/);
    const get = await app.inject({ method: "GET", url: `${V1}/documents/${id}`, headers: auth(admin) });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toContain("text/plain");
    expect(get.body).toBe("hello invoice");
  });

  it("404 for an unknown document", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    expect((await app.inject({ method: "GET", url: `${V1}/documents/nope`, headers: auth(admin) })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/documents.test.ts`
Expected: FAIL — routes missing.

- [ ] **Step 7: Add the routes + schemas**

In `apps/api/src/http/schemas.ts` add (follow existing schema style):
```ts
export const uploadDocument = { body: { type: "object", required: ["contentType", "dataBase64"], properties: { contentType: { type: "string" }, dataBase64: { type: "string" } } } };
export const getDocument = { params: { type: "object", required: ["id"], properties: { id: { type: "string" } } } };
```
In `apps/api/src/http/routes.ts` (after an existing authed route group; `auth` spread + `deps` are in scope):
```ts
  const MAX_DOC_BYTES = 5 * 1024 * 1024;
  app.post("/documents", { schema: S.uploadDocument, ...auth }, async (request, reply) => {
    const actor = actorOf(request);
    if (!deps.rbac.can(actor.role, "issue")) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to upload documents" });
    const { contentType, dataBase64 } = request.body as { contentType: string; dataBase64: string };
    let bytes: Buffer;
    try { bytes = Buffer.from(dataBase64, "base64"); } catch { return reply.code(400).send({ error: "BAD_DOCUMENT", message: "invalid base64" }); }
    if (bytes.length === 0) return reply.code(400).send({ error: "BAD_DOCUMENT", message: "empty document" });
    if (bytes.length > MAX_DOC_BYTES) return reply.code(413).send({ error: "DOCUMENT_TOO_LARGE", message: `max ${MAX_DOC_BYTES} bytes` });
    const doc = await deps.documents.create({ contentType, bytes });
    return reply.code(201).send({ id: doc.id, url: `/api/v1/documents/${doc.id}`, sha256: doc.sha256, size: doc.size });
  });
  app.get("/documents/:id", { schema: S.getDocument, ...auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const doc = await deps.documents.get(id);
    if (!doc) return reply.code(404).send({ error: "NOT_FOUND", message: "document not found" });
    return reply.header("content-type", doc.contentType).send(doc.bytes);
  });
```
(Confirm `S` is the schemas import alias, `actorOf`, and `deps.rbac.can` names by reading the top of the file. If routes register under a `/api/v1` prefix already, the `url` string must still be the absolute `/api/v1/documents/:id` — verify the prefix and adjust the returned `url` to match what clients call.)

- [ ] **Step 8: Run tests**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/documents.test.ts`
Expected: PASS (2).

- [ ] **Step 9: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/ apps/api/src/context.ts apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/documents.test.ts
git commit -m "feat(api): document store — POST/GET /documents (base64, sha256, 5MB cap)"
```

---

### Task 7: Retire the financing / deep-tier feature

**Files (remove/trim):**
- `apps/api/src/http/routes.ts` — delete finance/repay/deep-tier/tier-chain handlers + finance/repay audit `append`s + any now-unused helper (`isoDatePlusDays`; keep `requireIssue`/`ensureAllowed` only if still referenced).
- `apps/api/src/http/schemas.ts` — delete `financeAsset/repayAsset/getFinancing/deepTier/tierChain` + Financing/TierChainNode components.
- `apps/api/prisma/schema.prisma` — delete `model Financing`.
- `apps/api/src/persistence/{types,prisma,memory}.ts` — delete `FinancingRecord`/`FinancingRepository` + impls.
- `apps/api/src/env.ts` — delete `deepTierCapPct`/`DEEP_TIER_CAP_PCT`.
- `apps/api/src/context.ts`, `app.ts`, `server.ts`, `apps/api/test/helpers.ts`, and any `apps/api/src/*e2e*`/`demo` scripts — delete `financing` + `deepTierCapPct` wiring.
- `packages/core/src/types.ts` — remove `"finance"`/`"repay"` from `LifecycleAction`.
- `apps/api/src/analytics.ts` — remove the `finance` branch in the traded loop and the `finance`/`repay` cases in `summarize`. **Keep** `unitValueOf`/`valuation` and the `buy` branch.
- Delete `apps/api/test/financing.test.ts`.
- `apps/api/test/analytics.test.ts` — remove the "counts financing as traded" assertions/test; keep valuation tests. If the valuation test used a `finance` audit entry to move a token, switch it to a `buy` entry or drop only the traded assertion.

- [ ] **Step 1: Delete the financing test file and Prisma model**

```bash
git rm apps/api/test/financing.test.ts
```
Remove `model Financing { … }` from `apps/api/prisma/schema.prisma`, then:
Run: `pnpm --filter @tokenlayer/api exec prisma generate`

- [ ] **Step 2: Remove routes/schemas/repo/env/wiring**

Delete the listed blocks. Use grep to find every reference so nothing dangles:
Run: `grep -rn "financing\|Financing\|deepTier\|deep-tier\|tier-chain\|deepTierCapPct\|DEEP_TIER_CAP_PCT\|FinancingRepository\|FinancingRecord" apps/api/src`
Expected after edits: no matches (except possibly a comment; remove those too).

- [ ] **Step 3: Trim core LifecycleAction + analytics**

Remove `| "finance"` and `| "repay"` from `packages/core/src/types.ts`. In `apps/api/src/analytics.ts` change the traded condition back to `if (e.action === "buy")` with `amountOf(p, "cost")`, and delete the `finance`/`repay` `summarize` cases.
Run: `grep -rn "\"finance\"\|\"repay\"\|discountedInr" apps/api/src packages/core/src`
Expected: no matches.

- [ ] **Step 4: Typecheck + build core**

Run: `pnpm --filter @tokenlayer/core build && pnpm --filter @tokenlayer/api exec tsc --noEmit`
Expected: clean (fix any dangling imports the compiler flags).

- [ ] **Step 5: Run the full API + core suites**

Run: `pnpm --filter @tokenlayer/core test && pnpm --filter @tokenlayer/api test`
Expected: PASS (financing tests gone; analytics/valuation green; invoice-erc20 + documents green).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: retire finance/repay/deep-tier — marketplace buys are now the financing"
```

---

## Phase 3 — Web

### Task 8: Remove FinancingPanel + financing client; update detection

**Files:**
- Delete: `apps/web/src/components/FinancingPanel.tsx`
- Modify: `apps/web/src/components/AssetDetail.tsx` (remove import + `<FinancingPanel>` usage)
- Modify: `apps/web/src/api.ts` (remove `financing/finance/repay/deepTier/tierChain`)
- Modify: `apps/web/src/types.ts` (remove `Financing`, `TierChainNode`)
- Modify: `apps/web/src/components/AssetManagement.tsx` (`isInvoiceUseCase`: drop the `nonfungible` requirement)

- [ ] **Step 1: Delete + de-reference**

```bash
git rm apps/web/src/components/FinancingPanel.tsx
```
In `AssetDetail.tsx`: remove `import { FinancingPanel, isInvoiceUseCase } from "./FinancingPanel.js";` and the `<FinancingPanel … />` block. If `isInvoiceUseCase` was imported from FinancingPanel anywhere, re-point it to `AssetManagement`'s export (or inline). In `api.ts` delete the five financing methods and the `Financing`/`TierChainNode` type imports. In `types.ts` delete the two interfaces.

- [ ] **Step 2: Update `isInvoiceUseCase`**

In `apps/web/src/components/AssetManagement.tsx`:
```ts
function isInvoiceUseCase(u: UseCase | undefined): u is UseCase {
  return !!u && INVOICE_FIELDS.every((f) => f in (u.metadataSchema?.properties ?? {}));
}
```
(Drop `u.tokenType === "nonfungible"`.) Export it so other components can import it instead of the deleted FinancingPanel copy.

- [ ] **Step 3: Typecheck + build**

Run: `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: clean (fix any leftover references the compiler flags).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(web): remove FinancingPanel + financing client; detect invoices by fields only"
```

---

### Task 9: IssuePanel — auto-derived hash (read-only) + document upload

**Files:**
- Modify: `apps/web/src/api.ts` (add `uploadDocument`)
- Modify: `apps/web/src/components/IssuePanel.tsx`
- Reuse: `computeFingerprint` exported from `apps/web/src/components/InvoiceImport.tsx`

- [ ] **Step 1: Add the API client method**

In `apps/web/src/api.ts`:
```ts
  uploadDocument: (token: string, contentType: string, dataBase64: string) =>
    request<{ id: string; url: string; sha256: string; size: number }>("/documents", token, { method: "POST", body: JSON.stringify({ contentType, dataBase64 }) }),
```

- [ ] **Step 2: Auto-derive `invoiceHash` in the form**

In `IssuePanel.tsx`:
- Import `computeFingerprint` from `./InvoiceImport.js`.
- Add state `const [derived, setDerived] = useState<Record<string,string>>({})`.
- Add an effect: when `useCase?.derivedFields?.invoiceHash === "invoiceFingerprint"` and the canonical fields (`invoiceNumber, sellerGstin, buyerGstin, amountInr, dueDate`) are all present in `meta`, compute the fingerprint and store it in `derived.invoiceHash`; else clear it.
```ts
useEffect(() => {
  const gen = useCase?.derivedFields?.invoiceHash;
  if (gen !== "invoiceFingerprint") { setDerived({}); return; }
  const f = { invoiceNumber: meta.invoiceNumber, sellerGstin: meta.sellerGstin, buyerGstin: meta.buyerGstin, amountInr: meta.amountInr, dueDate: meta.dueDate };
  if (Object.values(f).every((v) => (v ?? "").trim() !== "")) {
    void computeFingerprint(f as Parameters<typeof computeFingerprint>[0]).then((h) => setDerived({ invoiceHash: h }));
  } else setDerived({});
}, [useCase, meta.invoiceNumber, meta.sellerGstin, meta.buyerGstin, meta.amountInr, meta.dueDate]);
```
- In the metadata field renderer, if `field` is a key of `useCase.derivedFields`, render a **read-only** input showing `derived[field] ?? "(fill invoice fields to compute)"` instead of an editable input, and do NOT include it in `meta`.
- In `submit`, when building `metadata`, skip any field in `useCase.derivedFields` (the server derives it). (Leaving it out is correct; the server overwrites regardless.)

- [ ] **Step 3: Document upload for `type: "document"` fields**

Replace the `prop.type === "document"` branch with a component that offers both a URL input and a file picker. On file select: read the file as base64, `api.uploadDocument(token, file.type || "application/octet-stream", base64)`, then `onChange(res.url)` and stash `res.sha256` to also set `meta.invoiceDocHash`. Minimal inline handler:
```tsx
) : prop.type === "document" ? (
  <div className="space-y-1">
    <input className="input" type="url" placeholder="https://… or upload →" value={value} onChange={(e) => onChange(e.target.value)} />
    <input type="file" disabled={busy} onChange={async (e) => {
      const file = e.target.files?.[0]; if (!file || !token) return;
      const b64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
      try { const r = await api.uploadDocument(token, file.type || "application/octet-stream", b64); onChange(r.url); setMeta((m) => ({ ...m, invoiceDocHash: r.sha256 })); }
      catch { setError("Document upload failed"); }
      finally { e.target.value = ""; }
    }} className="block w-full text-xs file:mr-2 file:rounded file:border-0 file:bg-brand-600 file:text-white file:px-2 file:py-1 file:text-xs" />
  </div>
) : ...
```
(For large files `String.fromCharCode(...bigArray)` can overflow the call stack; for the demo's small PDFs it is fine. If robustness is wanted, chunk the base64 conversion.)

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/components/IssuePanel.tsx
git commit -m "feat(web): IssuePanel auto-derives invoiceHash (read-only) + document upload"
```

---

### Task 10: Import tab — fungible issue-to-holder

**Files:**
- Modify: `apps/web/src/components/InvoiceImport.tsx`

- [ ] **Step 1: Swap "financier" → "holder" + add par value**

- Rename the `financier` state/label to `holder` ("Holder (issue to)"). Keep the account `<select>`.
- Add `const [parValue, setParValue] = useState("1")` and a "Par value per token (₹)" number input (min 1). Show a hint: "supply per invoice = round(face ÷ par)".
- Per row, compute `supply = Math.max(1, Math.round(Number(row.amountInr) / Math.max(1, Number(parValue) || 1)))`. Display a "Tokens" column showing this.

- [ ] **Step 2: Rework `tokenize()` to fungible issue**

Replace the `issue → allow → mint(tokenId)` body with a fungible issue that mints supply to the holder:
```ts
const supply = Math.max(1, Math.round(Number(row.amountInr) / Math.max(1, Number(parValue) || 1)));
const metadata: Record<string, unknown> = {
  invoiceNumber: row.invoiceNumber, sellerGstin: row.sellerGstin, buyerGstin: row.buyerGstin,
  amountInr: Number(row.amountInr), dueDate: row.dueDate,
  ...(row.discountRatePct ? { discountRatePct: Number(row.discountRatePct) } : {}),
  ...(row.invoiceDocUrl ? { invoiceDocUrl: row.invoiceDocUrl } : {}),
  // invoiceHash intentionally omitted — the server derives it.
};
try {
  await api.issue(token, { useCaseKey: useCase.key, name: `${row.invoiceNumber} · ${row.sellerGstin.slice(0,4)}→${row.buyerGstin.slice(0,4)}`, chainId, initialSupply: String(supply), treasuryAccount: holder, metadata });
  patchRow(i, { status: "tokenized" });
  anyMinted = true;
} catch (err) {
  if (err instanceof ApiError && err.code === "DUPLICATE_INVOICE") patchRow(i, { status: "duplicate", message: "already tokenized" });
  else patchRow(i, { status: "error", message: err instanceof ApiError ? err.message : "request failed" });
}
```
- Remove client-side `computeFingerprint` usage in the row build (the fingerprint column can show "server-derived" or be dropped; keep validation of the other fields). The `duplicate` status now comes from the API's 409, not a mint failure.
- Update the Tokenize button `disabled` to require `holder` (not `financier`) and `chainId`; keep `pending > 0`.

- [ ] **Step 3: Typecheck + build**

Run: `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/InvoiceImport.tsx
git commit -m "feat(web): Import tab tokenizes invoices as fungible tokens issued to a holder"
```

---

## Phase 4 — Verify + merge

### Task 11: Full suite, live E2E, review, merge

- [ ] **Step 1: Full workspace suite + web build**

Run: `pnpm --filter @tokenlayer/core test && pnpm --filter @tokenlayer/contracts test && pnpm --filter @tokenlayer/adapters test && pnpm --filter @tokenlayer/api test && pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: all green.

- [ ] **Step 2: Rebuild + fresh-volume deploy**

Run: `docker compose build api web && docker compose down -v && docker compose up -d`, then wait for `POST /api/v1/auth/login` (admin) to return 200 and confirm the invoice use case reports `tokenStandard ERC-20` and a deployed fabric contract.

- [ ] **Step 3: Live E2E script**

Write `scratchpad/invoice-erc20-e2e.mjs` that, as `m1.admin` (or a fresh UCA): creates an IN-KYC holder + an IN-KYC financier (both with cash funded); tokenizes an invoice via `POST /assets` with `initialSupply` to the holder (assert supply live, `invoiceHash` derived, duplicate → 409); uploads a document via `POST /documents` and reads it back; lists tokens from the holder at a discounted price; funds + buys as the financier (assert token balance moved, cash moved); transfers some tokens financier→another holder; reads `/analytics` (assert Tokenized value = Σ live face value in INR, Traded reflects the buy). Print a ✓/✗ summary. Run it; expect all ✓.

- [ ] **Step 4: Code review (money/compliance/dedup paths)**

Run `/code-review` (or dispatch a review subagent) focused on: the derive/unique-guard race, document size/base64 handling, and that no financing references remain. Fix any real findings; re-run the affected suite.

- [ ] **Step 5: Merge**

```bash
git checkout main && git merge --no-ff feat/invoice-erc20-fractional -m "Merge: invoice tokenization → fractional ERC-20 + marketplace financing"
```

- [ ] **Step 6: Update memory**

Update `product-feature-roadmap.md` (and index) with the model flip, the retirement of finance/deep-tier, the derive/unique config, and the document store; note the fresh-volume requirement.

---

## Self-review notes

- **Spec coverage:** model flip (Task 3), auto-hash (#6, Tasks 1/5/9), unique guard (#9-dedup, Tasks 2/4/5), doc upload (#2, Tasks 6/9), retire financing → removes #3/#4 (Task 7/8), Import rework + button fix (#7/#8, Task 10), price/supply/listing (#5) and "no tokens" (#1) inherent to ERC-20 (Task 3, verified Task 11), real flow (#10, Tasks 9/10/11). All ten mapped.
- **Type consistency:** `invoiceFingerprint` (core) vs `computeFingerprint` (web) are deliberately separate names for the same algorithm on different runtimes; parity is asserted by shared known-hash tests. `findByMetadata`, `DocumentRepository.create/get`, and `derivedFields`/`uniqueBy` names are used identically across tasks.
- **Watch-outs:** confirm the `/api/v1` route prefix when returning the document `url`; match repo internal store names before editing; place the derive step before `validateMetadata`.
