# Asset Due Diligence & Listing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real due-diligence documents on an asset, a single-UseCaseAdmin review decision before it can be bought, risk classification, and a curated investor-facing display, replacing today's one-click/unreviewed issuance.

**Architecture:** `Asset` gains one new nullable JSON column, `dueDiligence` (a genuine Prisma migration — unlike KYC, there is no existing JSON column to extend). Two new self-service routes (`POST /assets/:id/diligence/documents`, `POST /assets/:id/submit-for-review`) let the Issuer assemble and submit a diligence package on their own pending asset. A **direct decision endpoint** (`POST /assets/:id/review-decision`) — deliberately NOT a maker-checker proposal, since the proposer (Issuer) has no basis to supply the decision the reviewing UseCaseAdmin alone can make — replaces the old `workflow.approvals.issue`-gated issuance path for every new asset. The web side adds a due-diligence panel + upload UI to `AssetDetail.tsx`, a risk column to `AssetList.tsx`, and a dedicated "Review Assets" screen for UseCaseAdmins.

**Tech Stack:** Fastify, Prisma (SQLite, needs a real schema change here), TypeScript, React, vitest.

**Spec:** [docs/superpowers/specs/2026-09-05-asset-due-diligence-design.md](../specs/2026-09-05-asset-due-diligence-design.md)

## Global Constraints

- `Asset` (`apps/api/prisma/schema.prisma`) needs a new column: `dueDiligence String?` — a genuine migration via `prisma db push` (this codebase has no `prisma/migrations` directory; schema changes are applied with `db push`, matching the Dockerfile's own boot sequence and `backfill-treasuries.ts`'s documented precedent).
- `AssetRecord` (`apps/api/src/persistence/types/tokenization.ts`) and its two repository implementations (`PrismaAssetRepository`, `MemoryAssetRepository`) are the only two `AssetRepository` implementations in this codebase (verified) — both need updating together, and `AssetRepository` needs one new interface method, `setDueDiligence(id, dueDiligence)`, mirroring the existing narrow `setStatus`/`setSaleTerms` methods (there is no general-purpose `update`).
- **The fast test suite never exercises `PrismaAssetRepository` at all** — `buildTestApp()`/`buildTestAppWithRepos()` (`apps/api/test/helpers.ts`) wire every test against `MemoryAssetRepository` only. This exact blind spot let a real bug (`PrismaDocumentRepository.get()` silently dropping a `purpose` value) ship undetected earlier in this project. Any task touching `PrismaAssetRepository` must be hand-verified against a real SQLite file (a short throwaway script run with `pnpm exec tsx`, mirroring how the KYC document-purpose backfill script was smoke-tested against the live deployment) — do not rely on the fast suite to catch a Prisma-layer mistake here.
- **No new `route-domains.ts` entry is needed** for any new route in this plan — `["/assets", "tokenization"]` already classifies every `/assets/*` prefix (verified by reading `route-domains.ts` directly).
- **The generic maker-checker proposal system (`apps/api/src/shared/proposal-kinds.ts`, `/proposals/:id/approve`) is deliberately NOT used anywhere in this plan.** `POST /assets/:id/review-decision` is a direct, synchronous decision endpoint. See the spec's section D for the full reasoning — do not "helpfully" route this through a proposal kind.
- `executeIssueActivation` (`apps/api/src/shared/executors.ts`) — sets sale terms, allowlists the treasury, mints supply, flips `status: "active"` — already exists and is reused unchanged by the new review-decision route. It is currently imported into `apps/api/src/http/routes/tokenization.ts` already (`from "../../shared/executors.js"`), no new import path needed.
- `storeUploadedDocument` (`apps/api/src/http/routes/common.ts`) is reused unchanged for diligence document uploads. It is NOT currently imported into `tokenization.ts` (only `shared.ts` imports it today) — add `import { storeUploadedDocument, DOC_UPLOAD_BODY_LIMIT } from "./common.js";` to `tokenization.ts`.
- `authScoped`, `auth`, `machinePrincipal`, `notFound`, `scopedToCaller` are all already available inside `registerTokenizationRoutes` (destructured from `ctx`, or already imported from `../support.js`) — verified by reading the file's existing imports/destructuring.
- **This plan bypasses, but does not remove, the pre-existing `workflow.approvals.issue` gate and its `"issue"` proposal kind.** For every asset issued after this ships, `issueAssetCore` stops calling `proposeIfGated` for issuance entirely and always takes this plan's `pending_approval` + due-diligence path instead — regardless of whether `workflow.approvals.issue` is set on that use case. The flag and the `"issue"` kind stay defined (other code may reference them), they just become inert for new assets specifically. This is a real, deliberate behavior change — see spec Non-goals for the full reasoning.
- **`POST /assets` currently returns 201.** After this plan, it always returns 202 (every asset is `pending_approval` from birth) — `S.issueAsset`'s response schema drops `201` entirely in favor of `202`, and this is a genuine, intentional public-surface change requiring `openapi.snapshot.json` regeneration (reviewed, not silent).
- **Blast radius warning:** making every new asset `pending_approval` breaks a large number of existing tests that assume synchronous, immediately-`active` issuance. A repo-wide grep found **48 inline `POST .../assets` call sites across 21 test files**, plus **8 call sites of the one shared `issueAsset()` helper** in `apps/api/test/helpers.ts` (across 2 files) — both counts confirmed via `grep -rn` immediately before this plan was written. Task 8 handles this migration; do not attempt it piecemeal in earlier tasks.
- Demo UseCaseAdmin accounts, needed by Task 8's test migration (verified against `docs/demo-credentials.md`): `carbon-credit` → `carbon.admin@tokenlayer.dev` / `carbon123`; `gold-loan` → `gold.admin@tokenlayer.dev` / `gold123`; `corporate-bond` → `bond.admin@tokenlayer.dev` / `bond123`; `invoice-tokenization` → `m1.admin@tokenlayer.dev` / `m1admin123`.
- Run `pnpm exec tsc --noEmit` in both `apps/api` and `apps/web` as an explicit verification step in every task that touches `src/` files in that package.
- Run every test/typecheck/build command as a single, direct, blocking call with a generous explicit timeout — never background it, and never assume a command finished without checking its actual exit output. (This project has a documented, repeated failure mode of subagents backgrounding or losing track of long-running commands.)

---

### Task 1: Data model — `dueDiligence` on `Asset`

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`Asset` model)
- Modify: `apps/api/src/persistence/types/tokenization.ts` (`AssetDueDiligence` interface, `AssetRecord`, `AssetRepository`)
- Modify: `apps/api/src/persistence/prisma/tokenization.ts` (`PrismaAssetRepository`, `toAsset`)
- Modify: `apps/api/src/persistence/memory/tokenization.ts` (`MemoryAssetRepository`)
- Test: `apps/api/test/asset-due-diligence-repo.test.ts`

**Interfaces:**
- Produces: `AssetDueDiligence` (new type), `AssetRecord.dueDiligence?: AssetDueDiligence | null`, `AssetRepository.setDueDiligence(id, dueDiligence): Promise<void>`. Every later task reads/writes these exact names.

- [ ] **Step 1: Add the column to the Prisma schema**

In `apps/api/prisma/schema.prisma`, find the `Asset` model (currently ending at the `@@unique([useCaseKey, uniqueKey])` line) and add one new column right after `uniqueKey`:

```prisma
  uniqueKey       String?
  // Due-diligence documents, risk classification, and the reviewer's decision
  // for this asset — JSON-encoded, same convention as `metadata` above. Kept
  // as its own column rather than folded into `metadata` because `metadata`
  // is the use case's own metadataSchema-validated, investor-facing free-form
  // data; mixing review state into it would pollute that display and
  // complicate its validation. Also carries the issuer's originally-requested
  // initialSupply/sale terms from POST /assets, deferred until
  // POST /assets/:id/review-decision approves and needs them to activate —
  // see AssetDueDiligence's own doc comment for why they live here.
  dueDiligence    String?
```

- [ ] **Step 2: Push the schema and regenerate the client**

Run: `cd "apps/api" && DATABASE_URL="file:./dev.db" pnpm exec prisma db push --accept-data-loss`
Expected: reports the new `dueDiligence` column added; no data loss on any existing table (a new nullable column never loses data — `--accept-data-loss` is required by the CLI regardless, matching this codebase's existing `backfill-treasuries.ts` precedent).

Run: `cd "apps/api" && pnpm exec prisma generate`
Expected: regenerates the Prisma client so `prisma.asset.create`/`update`/`findUnique` type-check against the new column.

- [ ] **Step 3: Add the `AssetDueDiligence` type**

In `apps/api/src/persistence/types/tokenization.ts`, add right above `export interface AssetRecord {`:

```typescript
export interface AssetDueDiligence {
  prospectus?: { id: string; sha256: string } | null;
  legalOpinion?: { id: string; sha256: string } | null;
  additionalDocuments?: { id: string; sha256: string; label: string }[];
  riskTier?: "low" | "medium" | "high" | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
  // The issuer's own requested activation parameters, captured at POST
  // /assets time (see Task 8's issueAssetCore change). `executeIssueActivation`
  // needs them at approval time; with no proposal system involved, this is
  // the only durable place they can wait.
  pendingInitialSupply?: string | null;
  pendingSale?: { unitPrice: string; currency: string } | null;
}
```

Then add one new field to `AssetRecord`, right after `uniqueKey?: string | null;`:

```typescript
  dueDiligence?: AssetDueDiligence | null;
```

Then add one new method to the `AssetRepository` interface, right after `setSaleTerms(id: string, terms: SaleTerms): Promise<void>;`:

```typescript
  setDueDiligence(id: string, dueDiligence: AssetDueDiligence): Promise<void>;
```

- [ ] **Step 4: Implement it in `PrismaAssetRepository`**

In `apps/api/src/persistence/prisma/tokenization.ts`:

1. In `function toAsset(r: Asset, parsedMetadata?: Record<string, unknown>): AssetRecord`, add one line to the returned object, right after `uniqueKey: r.uniqueKey,`:

```typescript
    dueDiligence: r.dueDiligence ? JSON.parse(r.dueDiligence) as AssetDueDiligence : null,
```

(Add `AssetDueDiligence` to this file's existing `import type { ... } from "../types/tokenization.js";`-style import — check the current import line for `AssetRecord`/`AssetFilter`/`SaleTerms` and add `AssetDueDiligence` alongside them.)

2. In `PrismaAssetRepository.create`, the `data: { ...input, uniqueKey: input.uniqueKey ?? null, metadata: JSON.stringify(input.metadata) }` object needs one more line — since `input.dueDiligence` may be `undefined` (not part of every caller's input) or `null`, stringify only when present:

```typescript
      data: {
        ...input,
        uniqueKey: input.uniqueKey ?? null,
        metadata: JSON.stringify(input.metadata),
        dueDiligence: input.dueDiligence ? JSON.stringify(input.dueDiligence) : null,
      },
```

3. Add a new method to the class, right after `setSaleTerms`:

```typescript
  async setDueDiligence(id: string, dueDiligence: AssetDueDiligence): Promise<void> {
    await prisma.asset.update({ where: { id }, data: { dueDiligence: JSON.stringify(dueDiligence) } });
  }
```

- [ ] **Step 5: Implement it in `MemoryAssetRepository`**

In `apps/api/src/persistence/memory/tokenization.ts`:

1. In `create`, the returned `rec: AssetRecord` object needs one more field, right after `uniqueKey: input.uniqueKey ?? null,`:

```typescript
      dueDiligence: input.dueDiligence ?? null,
```

2. Add a new method right after `setSaleTerms`:

```typescript
  async setDueDiligence(id: string, dueDiligence: AssetDueDiligence): Promise<void> {
    const a = this.byId.get(id);
    if (a) a.dueDiligence = dueDiligence;
  }
```

(Add `AssetDueDiligence` to this file's existing type import from `../types/tokenization.js`, same as Step 4.)

- [ ] **Step 6: Write a test proving both repositories round-trip `dueDiligence` correctly**

Create `apps/api/test/asset-due-diligence-repo.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { MemoryAssetRepository } from "../src/persistence/memory/index.js";
import type { AssetDueDiligence, AssetRecord } from "../src/persistence/types/index.js";

const baseInput = (over: Partial<AssetRecord> = {}): Omit<AssetRecord, "createdAt"> => ({
  id: "a1", useCaseKey: "carbon-credit", name: "T", symbol: "T", chainId: "fabric",
  contractRef: "0xref", tokenType: "fungible", tokenStandard: "ERC-20",
  metadata: {}, status: "pending_approval", createdBy: "u1",
  unitPrice: null, currency: null, treasuryAccount: null, uniqueKey: null,
  ...over,
});

describe("AssetRepository.setDueDiligence", () => {
  it("MemoryAssetRepository: create() with no dueDiligence stores null; setDueDiligence() then updates it", async () => {
    const assets = new MemoryAssetRepository();
    const created = await assets.create(baseInput());
    expect(created.dueDiligence).toBeNull();

    const dd: AssetDueDiligence = {
      prospectus: { id: "doc1", sha256: "0xabc" },
      riskTier: "low",
      pendingInitialSupply: "1000",
      pendingSale: { unitPrice: "5", currency: "CBDC-INR" },
    };
    await assets.setDueDiligence("a1", dd);
    const after = await assets.get("a1");
    expect(after?.dueDiligence).toEqual(dd);
  });

  it("MemoryAssetRepository: create() with dueDiligence already set stores it verbatim", async () => {
    const assets = new MemoryAssetRepository();
    const dd: AssetDueDiligence = { legalOpinion: { id: "doc2", sha256: "0xdef" } };
    const created = await assets.create(baseInput({ dueDiligence: dd }));
    expect(created.dueDiligence).toEqual(dd);
  });
});
```

- [ ] **Step 7: Run it, then run tsc**

Run: `cd "apps/api" && pnpm exec vitest run test/asset-due-diligence-repo.test.ts`
Expected: PASS (2 tests).

Run: `cd "apps/api" && pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Hand-verify the Prisma path against a real SQLite file**

The fast suite above only exercises `MemoryAssetRepository` — per this plan's Global Constraints, the Prisma path needs its own direct check. Run this one-off script (delete it afterward — it is not a permanent part of the codebase):

```bash
cd "apps/api" && cat > /tmp/verify-dd.mjs << 'EOF'
import { prisma, PrismaUseCaseRepository, PrismaAccountRepository, PrismaOrganizationRepository } from "./src/persistence/prisma/index.js";
import { PrismaAssetRepository } from "./src/persistence/prisma/tokenization.js";
const assets = new PrismaAssetRepository();
const created = await assets.create({
  id: "prisma-verify-1", useCaseKey: "carbon-credit", name: "T", symbol: "T", chainId: "fabric",
  contractRef: "0xref", tokenType: "fungible", tokenStandard: "ERC-20",
  metadata: {}, status: "pending_approval", createdBy: "u1",
  unitPrice: null, currency: null, treasuryAccount: null, uniqueKey: null,
});
console.log("created.dueDiligence:", created.dueDiligence);
await assets.setDueDiligence("prisma-verify-1", { riskTier: "medium", prospectus: { id: "d1", sha256: "0x1" } });
const after = await assets.get("prisma-verify-1");
console.log("after.dueDiligence:", JSON.stringify(after?.dueDiligence));
await prisma.asset.delete({ where: { id: "prisma-verify-1" } });
await prisma.$disconnect();
EOF
DATABASE_URL="file:./dev.db" pnpm exec tsx /tmp/verify-dd.mjs
rm /tmp/verify-dd.mjs
```

Expected output: `created.dueDiligence: null` then `after.dueDiligence: {"riskTier":"medium","prospectus":{"id":"d1","sha256":"0x1"}}`. If either line is wrong (e.g. `null` after `setDueDiligence`, or a stringified-twice value), the Prisma-layer code in Step 4 has a bug the fast suite cannot see — fix it before proceeding.

- [ ] **Step 9: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types/tokenization.ts apps/api/src/persistence/prisma/tokenization.ts apps/api/src/persistence/memory/tokenization.ts apps/api/test/asset-due-diligence-repo.test.ts
git commit -m "feat(assets): add dueDiligence to Asset (documents, risk tier, reviewer decision, deferred activation params)"
```

---

### Task 2: Document storage — upload + dedicated read gate

**Files:**
- Modify: `apps/api/src/persistence/types/shared.ts` (`DocumentPurpose`)
- Modify: `apps/api/src/http/routes/tokenization.ts` (2 new routes)
- Modify: `apps/api/src/http/routes/shared.ts` (`GET /documents/:id` refusal)
- Modify: `apps/api/src/http/schemas/tokenization.ts` (2 new schemas)
- Test: `apps/api/test/asset-diligence-documents.test.ts`

**Interfaces:**
- Consumes: `storeUploadedDocument` (`apps/api/src/http/routes/common.ts`), `scopedAsset`/`scopedToCaller` (already defined in `tokenization.ts`), `AssetDueDiligence` (Task 1).
- Produces: `POST /assets/:id/diligence/documents`, `GET /assets/:id/diligence/documents/:docId`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/asset-diligence-documents.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, issueAsset, loginAs, V1 } from "./helpers.js";

describe("Asset due-diligence document upload and read gate", () => {
  it("the issuer can upload a prospectus, then read it back", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 fake prospectus").toString("base64") },
    });
    expect(upload.statusCode).toBe(201);
    const docId = upload.json().id as string;
    const read = await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}/diligence/documents/${docId}`, headers: auth(platform) });
    expect(read.statusCode).toBe(200);
    expect(read.payload).toContain("fake prospectus");
  });

  it("an additional document requires a label", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "additional", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("LABEL_REQUIRED");
  });

  it("a buyer scoped to a DIFFERENT use case cannot read a pending asset's documents", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    const docId = upload.json().id as string;
    const goldBuyer = await loginAs(h.app, "gold.buyer@tokenlayer.dev", "gold123");
    const read = await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}/diligence/documents/${docId}`, headers: auth(goldBuyer) });
    expect(read.statusCode).toBe(404);
  });

  it("a buyer scoped to the SAME use case cannot read a still-pending asset's documents, but can once it's active", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    // issueAsset() issues via today's synchronous path (no use case has
    // workflow.approvals.issue set) and returns an already-active asset —
    // this task's own routes don't yet run before Task 8 makes
    // pending_approval the universal default, so force the state this test
    // actually needs directly through the repository, the same way this
    // plan's Task 3 test 3 already does.
    await h.assets.setStatus(assetId, "pending_approval");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    const docId = upload.json().id as string;
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const pendingRead = await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}/diligence/documents/${docId}`, headers: auth(buyer) });
    expect(pendingRead.statusCode).toBe(403);

    await h.assets.setStatus(assetId, "active");
    const activeRead = await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}/diligence/documents/${docId}`, headers: auth(buyer) });
    expect(activeRead.statusCode).toBe(200);
  });

  it("GET /documents/:id refuses an asset-diligence-purposed document outright, even for a PlatformAdmin", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    const docId = upload.json().id as string;
    const res = await h.app.inject({ method: "GET", url: `${V1}/documents/${docId}`, headers: auth(platform) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/asset-diligence-documents.test.ts`
Expected: FAIL — 404s (routes don't exist yet).

- [ ] **Step 3: Widen `DocumentPurpose`**

In `apps/api/src/persistence/types/shared.ts`, find the `DocumentPurpose` type (currently `"brand-logo" | "kyc"`) and widen it:

```typescript
export type DocumentPurpose = "brand-logo" | "kyc" | "asset-diligence";
```

- [ ] **Step 4: Add the schemas**

In `apps/api/src/http/schemas/tokenization.ts`, add near `issueAsset`/`getAsset`:

```typescript
  uploadAssetDiligenceDocument: {
    tags: ["Assets"],
    summary: "Attach a due-diligence document to a pending asset",
    security: eitherCredential,
    description: "Requires the `assets:issue` scope. `slot` picks which part of the diligence package this fills; `label` is required (and free-text) only for `slot: \"additional\"`.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      required: ["slot", "contentType", "dataBase64"],
      properties: {
        slot: { type: "string", enum: ["prospectus", "legalOpinion", "additional"] },
        label: { type: "string" },
        contentType: { type: "string" },
        dataBase64: { type: "string" },
      },
    },
    response: { 201: { type: "object", additionalProperties: true, properties: { id: { type: "string" }, sha256: { type: "string" }, size: { type: "number" } } }, ...errs(400, 401, 403, 404, 413, 415) },
  },
  getAssetDiligenceDocument: {
    tags: ["Assets"],
    summary: "Read one of an asset's due-diligence documents",
    security: eitherCredential,
    description: "Requires the `assets:read` scope. Visible to anyone scoped to the asset's use case once it is active; visible to the asset's own issuer/use-case staff even while still pending review.",
    params: { type: "object", required: ["id", "docId"], properties: { id: { type: "string" }, docId: { type: "string" } } },
    response: { ...errs(401, 403, 404) },
  },
```

- [ ] **Step 5: Add the routes**

In `apps/api/src/http/routes/tokenization.ts`, add this import alongside the file's other relative imports (near the top, with the other `"./`/`"../` imports):

```typescript
import { storeUploadedDocument, DOC_UPLOAD_BODY_LIMIT } from "./common.js";
```

Then add the two routes right after the existing `GET /assets/:id` route (search for `app.get("/assets/:id"`, insert after its closing `});`):

```typescript
  app.post("/assets/:id/diligence/documents", { schema: S.uploadAssetDiligenceDocument, bodyLimit: DOC_UPLOAD_BODY_LIMIT, ...authScoped("assets:issue") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "act");
    if (!asset) return reply;
    const claims = request.user as TokenClaims;
    const b = request.body as { slot: "prospectus" | "legalOpinion" | "additional"; label?: string; contentType: string; dataBase64: string };
    if (b.slot === "additional" && !b.label) {
      return reply.code(400).send({ error: "LABEL_REQUIRED", message: "an additional document needs a label" });
    }
    const useCase = await deps.useCases.get(asset.useCaseKey);
    const doc = await storeUploadedDocument(deps.documents, { contentType: b.contentType, dataBase64: b.dataBase64 }, useCase.ownerOrgId ?? null, "asset-diligence", claims.id);
    const dd = { ...(asset.dueDiligence ?? {}) };
    const ref = { id: doc.id, sha256: doc.sha256 };
    if (b.slot === "prospectus") dd.prospectus = ref;
    else if (b.slot === "legalOpinion") dd.legalOpinion = ref;
    else dd.additionalDocuments = [...(dd.additionalDocuments ?? []), { ...ref, label: b.label! }];
    await deps.assets.setDueDiligence(asset.id, dd);
    return reply.code(201).send({ id: doc.id, sha256: doc.sha256, size: doc.size });
  });

  app.get("/assets/:id/diligence/documents/:docId", { schema: S.getAssetDiligenceDocument, ...authScoped("assets:read") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "read");
    if (!asset) return reply;
    const claims = request.user as TokenClaims;
    const { docId } = request.params as { docId: string };
    // THE ID IN THE URL MUST BE ONE OF *THIS ASSET'S OWN* DILIGENCE DOCUMENTS.
    // Without this, the checks below only prove the caller may see asset `:id`
    // — they say nothing about whose bytes `docId` names. A buyer scoped to a
    // use case with even one ACTIVE asset would otherwise be able to swap in
    // any other document id in the whole system (another still-pending asset's
    // prospectus in the same use case, a KYC scan, ...) and read it back,
    // because `deps.documents.get` alone knows nothing about asset ownership.
    // Tying `docId` to the asset record already loaded and scope-checked above
    // is what makes this a dedicated gate rather than a second `GET /documents/:id`.
    const dd = asset.dueDiligence ?? {};
    const belongsToAsset = dd.prospectus?.id === docId || dd.legalOpinion?.id === docId || (dd.additionalDocuments ?? []).some((d) => d.id === docId);
    if (!belongsToAsset) return notFound(reply, "document not found");
    // A still-pending or rejected asset's diligence package is not yet public —
    // only this asset's own use-case staff (anyone who can `act` on it, i.e.
    // Issuer/UseCaseAdmin scoped here) may see it before it goes active. Once
    // `active`, anyone already scoped to the use case (scopedAsset's own read
    // check, already passed above) may see it — that IS the point of this
    // feature: investor-facing diligence documents, not private ones.
    if (asset.status !== "active") {
      const canAct = await scopedToCaller(claims, asset.useCaseKey, deps.useCases);
      const isStaffRole = claims.role === "Issuer" || claims.role === "UseCaseAdmin" || claims.role === "PlatformAdmin";
      if (!canAct || !isStaffRole) return reply.code(403).send({ error: "FORBIDDEN", message: "this asset's diligence package is not yet public" });
    }
    const doc = await deps.documents.get(docId);
    if (!doc) return notFound(reply, "document not found");
    return reply
      .header("content-type", doc.contentType)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename="asset-diligence-${docId}"`)
      .send(doc.bytes);
  });
```

- [ ] **Step 6: Add the `GET /documents/:id` refusal**

In `apps/api/src/http/routes/shared.ts`, find the existing `if (doc.purpose === "kyc") { ... }` refusal inside `GET /documents/:id` and add a sibling right after it:

```typescript
    if (doc.purpose === "asset-diligence") {
      return reply.code(403).send({ error: "FORBIDDEN", message: "asset diligence documents are read through GET /assets/:id/diligence/documents/:docId" });
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd "apps/api" && pnpm exec vitest run test/asset-diligence-documents.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Typecheck and run the governance suites**

Run: `cd "apps/api" && pnpm exec tsc --noEmit`
Expected: clean.

Run: `cd "apps/api" && pnpm exec vitest run test/openapi-contract.test.ts test/openapi-snapshot.test.ts test/scope-coverage.test.ts test/persona-edges.test.ts`
Expected: some of these WILL fail until you register the two new routes — this codebase enforces 4 governance suites on every new route (confirmed present, same as the ones the KYC project satisfied): additivity/named-fields rules, a committed OpenAPI surface snapshot, an explicit-scope-or-listed-reason rule, and a persona-reachability rule. Both new routes here already carry `authScoped(...)`, so **no `scope-coverage.test.ts` entry is needed** (that suite only requires an entry for UNscoped routes). Fix any `openapi-contract.test.ts`/`openapi-snapshot.test.ts` failures by regenerating the snapshot (`pnpm --filter @tokenlayer/api openapi:snapshot` from the repo root) and reviewing the diff is purely additive. For `persona-edges.test.ts`: check `packages/core/src/shared/personas.ts`'s `STAFF_BASELINE` array (it already carries a blanket `/documents` rule for staff consoles) — add `{ prefix: "/assets/:id/diligence/documents", methods: "ALL", why: "attach and read due-diligence documents on a use case's own assets" }` if the existing `/assets` rules in each persona's own `allow` list don't already cover this sub-path (check: does `tokenization-issuer`'s and `tokenization-admin`'s own `{ prefix: "/assets", methods: "ALL", ... }` rule already admit `/assets/:id/diligence/documents` as a sub-path? If so, no new personas.ts entry is needed at all — verify by reading `coversPattern`'s matching logic in the same file before adding anything). Regenerate nginx configs via `pnpm gen:persona-edges` from the repo root if you do add an entry.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/persistence/types/shared.ts apps/api/src/http/routes/tokenization.ts apps/api/src/http/routes/shared.ts apps/api/src/http/schemas/tokenization.ts apps/api/test/asset-diligence-documents.test.ts apps/api/openapi.snapshot.json
git commit -m "feat(assets): add due-diligence document upload and a dedicated read gate"
```

(Add `packages/core/src/shared/personas.ts` and `deploy/persona-edges/*.conf` to the commit too, if Step 8 required changing them.)

---

### Task 3: Self-service submission — `POST /assets/:id/submit-for-review`

**Files:**
- Modify: `apps/api/src/http/routes/tokenization.ts`
- Modify: `apps/api/src/http/schemas/tokenization.ts`
- Test: `apps/api/test/asset-submit-for-review.test.ts`

**Interfaces:**
- Produces: `POST /assets/:id/submit-for-review` — a plain, unilateral, no-proposal state check. Does not itself change `status` (the asset is already `pending_approval` from creation, per Task 8) — it only validates the diligence package is complete enough to be looked at.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/asset-submit-for-review.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, issueAsset, loginAs, V1 } from "./helpers.js";

describe("POST /assets/:id/submit-for-review", () => {
  it("400s PROSPECTUS_REQUIRED when no prospectus is attached", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("PROSPECTUS_REQUIRED");
  });

  it("succeeds once a prospectus is attached (legal opinion / additional documents are optional)", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
    expect(res.statusCode).toBe(200);
  });

  it("works identically on a resubmission after rejection — same endpoint, same validation", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    await h.assets.setDueDiligence(assetId, { rejectionReason: "resubmit with a real prospectus" });
    await h.assets.setStatus(assetId, "rejected");
    const beforeDocs = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
    expect(beforeDocs.statusCode).toBe(400);
    await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/asset-submit-for-review.test.ts`
Expected: FAIL — 404 (route doesn't exist yet).

- [ ] **Step 3: Add the schema**

In `apps/api/src/http/schemas/tokenization.ts`:

```typescript
  submitAssetForReview: {
    tags: ["Assets"],
    summary: "Mark a pending asset's diligence package ready for review",
    security: eitherCredential,
    description: "Requires the `assets:issue` scope. Requires a prospectus to already be attached; the legal opinion and any additional documents are optional. Safe to call again after a rejection.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true, properties: { id: { type: "string" }, status: { type: "string" } } }, ...errs(400, 401, 403, 404) },
  },
```

- [ ] **Step 4: Add the route**

In `apps/api/src/http/routes/tokenization.ts`, add right after the two routes from Task 2:

```typescript
  app.post("/assets/:id/submit-for-review", { schema: S.submitAssetForReview, ...authScoped("assets:issue") }, async (request, reply) => {
    const asset = await scopedAsset(request, reply, "act");
    if (!asset) return reply;
    if (!asset.dueDiligence?.prospectus) {
      return reply.code(400).send({ error: "PROSPECTUS_REQUIRED", message: "attach a prospectus before submitting for review" });
    }
    return reply.code(200).send({ id: asset.id, status: asset.status });
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd "apps/api" && pnpm exec vitest run test/asset-submit-for-review.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and run the governance suites**

Run: `cd "apps/api" && pnpm exec tsc --noEmit`
Expected: clean.

Run: `cd "apps/api" && pnpm exec vitest run test/openapi-contract.test.ts test/openapi-snapshot.test.ts test/scope-coverage.test.ts test/persona-edges.test.ts`
Expected: clean after regenerating the OpenAPI snapshot (same procedure as Task 2's Step 8) — no `scope-coverage`/`persona-edges` entries are needed (same `authScoped("assets:issue")` gate, same `/assets` persona coverage already established in Task 2).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/routes/tokenization.ts apps/api/src/http/schemas/tokenization.ts apps/api/test/asset-submit-for-review.test.ts apps/api/openapi.snapshot.json
git commit -m "feat(assets): add the self-service submit-for-review endpoint"
```

---

### Task 4: Review decision — `POST /assets/:id/review-decision`

**Files:**
- Modify: `apps/api/src/http/routes/tokenization.ts`
- Modify: `apps/api/src/http/schemas/tokenization.ts`
- Modify: `apps/api/src/mail/templates.ts`
- Test: `apps/api/test/asset-review-decision.test.ts`

**Interfaces:**
- Consumes: `executeIssueActivation` (already imported into this file), `AssetDueDiligence` (Task 1).
- Produces: `POST /assets/:id/review-decision`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/asset-review-decision.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, issueAsset, loginAs, V1 } from "./helpers.js";

async function submittedAsset(h: Awaited<ReturnType<typeof buildTestAppWithRepos>>, platform: string): Promise<string> {
  const assetId = await issueAsset(h.app, platform, "carbon-credit");
  // issueAsset() issues via today's synchronous path (no use case has
  // workflow.approvals.issue set) and returns an already-active asset — the
  // review-decision route this task adds requires pending_approval, and
  // Task 8 is what makes that the universal default, not this task. Force
  // the state this task's own tests need directly, same as Task 2's fix.
  await h.assets.setStatus(assetId, "pending_approval");
  await h.app.inject({
    method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
    payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
  });
  await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
  return assetId;
}

describe("POST /assets/:id/review-decision", () => {
  it("a UseCaseAdmin approving with a risk tier activates the asset", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(res.statusCode).toBe(200);
    const asset = (await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(platform) })).json();
    expect(asset.status).toBe("active");
    expect(asset.dueDiligence.riskTier).toBe("low");
    expect(asset.dueDiligence.reviewedBy).toBeTruthy();
  });

  it("rejecting with a reason sets status rejected and stores the reason", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin),
      payload: { decision: "rejected", rejectionReason: "prospectus is incomplete" },
    });
    expect(res.statusCode).toBe(200);
    const asset = (await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(platform) })).json();
    expect(asset.status).toBe("rejected");
    expect(asset.dueDiligence.rejectionReason).toBe("prospectus is incomplete");
  });

  it("approving with no riskTier is refused", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin), payload: { decision: "approved" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("RISK_TIER_REQUIRED");
  });

  it("rejecting with no reason is refused", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin), payload: { decision: "rejected" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("REASON_REQUIRED");
  });

  it("a UseCaseAdmin from a DIFFERENT use case cannot decide", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const goldAdmin = await loginAs(h.app, "gold.admin@tokenlayer.dev", "gold123");
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(goldAdmin), payload: { decision: "approved", riskTier: "low" } });
    expect(res.statusCode).toBe(403);
  });

  it("the asset's own creator cannot decide it, even if they hold the UseCaseAdmin role", async () => {
    const h = await buildTestAppWithRepos();
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const assetId = await submittedAsset(h, carbonAdmin);
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin), payload: { decision: "approved", riskTier: "low" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("a machine principal is refused outright", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const org = await h.app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(platform), payload: { name: `Diligence Test Org ${Date.now()}`, orgType: "corporate" } });
    const key = await h.app.inject({ method: "POST", url: `${V1}/orgs/${org.json().id}/api-keys`, headers: auth(platform), payload: { name: "k", role: "UseCaseAdmin", scopes: ["assets:issue"] } });
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: { authorization: `Bearer ${key.json().secret}` }, payload: { decision: "approved", riskTier: "low" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("MACHINE_PRINCIPAL");
  });

  it("deciding on an asset that is not pending_approval is refused", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin), payload: { decision: "approved", riskTier: "low" } });
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin), payload: { decision: "approved", riskTier: "low" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NOT_PENDING");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/asset-review-decision.test.ts`
Expected: FAIL — 404 (route doesn't exist yet).

- [ ] **Step 3: Add the email template**

In `apps/api/src/mail/templates.ts`, add right after `kycDecisionEmail`:

```typescript
export function assetReviewDecisionEmail(a: { assetName: string; decision: "approved" | "rejected"; rejectionReason?: string }): EmailContent {
  const verb = a.decision === "approved" ? "approved" : "rejected";
  const reasonLine = a.decision === "rejected" && a.rejectionReason ? `\n\nReason: ${a.rejectionReason}` : "";
  const text = `Your asset "${a.assetName}" was ${verb} for listing.${reasonLine}`;
  const htmlParts = [esc(`Your asset "${a.assetName}" was ${verb} for listing.`)];
  if (a.decision === "rejected" && a.rejectionReason) htmlParts.push(`Reason: ${esc(a.rejectionReason)}`);
  return { subject: `Your asset "${a.assetName}" was ${verb}`, text, html: wrap(htmlParts) };
}
```

- [ ] **Step 4: Add the schema**

In `apps/api/src/http/schemas/tokenization.ts`:

```typescript
  decideAssetReview: {
    tags: ["Assets"],
    summary: "Decide a pending asset's due-diligence review — UseCaseAdmin of its own use case only",
    security: humanOnly,
    description: "A direct decision, not a maker-checker proposal: the reviewing UseCaseAdmin alone decides. No API key may ever call this. Approving requires a riskTier; rejecting requires a rejectionReason. The asset's own creator may never decide it.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      required: ["decision"],
      properties: {
        decision: { type: "string", enum: ["approved", "rejected"] },
        riskTier: { type: "string", enum: ["low", "medium", "high"] },
        rejectionReason: { type: "string" },
      },
    },
    response: { 200: { type: "object", additionalProperties: true, properties: { id: { type: "string" }, status: { type: "string" } } }, ...errs(400, 401, 403, 404, 409) },
  },
```

(Check this file's existing import from `./components.js` for `humanOnly` — if not already imported, add it alongside `eitherCredential`.)

- [ ] **Step 5: Add the route**

In `apps/api/src/http/routes/tokenization.ts`, add right after `POST /assets/:id/submit-for-review`. Add `assetReviewDecisionEmail` to this file's mail-template import (check the existing import line from `../../mail/templates.js` if one exists, or add one — search the file for any existing `mail/templates.js` import to match the pattern; if none exists yet, add `import { assetReviewDecisionEmail } from "../../mail/templates.js";`):

```typescript
  app.post("/assets/:id/review-decision", { schema: S.decideAssetReview, ...auth }, async (request, reply) => {
    if (machinePrincipal(request)) return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key may not decide an asset review" });
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const asset = await deps.assets.get(id);
    if (!asset) return notFound(reply, "asset not found");
    if (claims.role !== "UseCaseAdmin" || claims.useCaseKey !== asset.useCaseKey) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only a UseCaseAdmin of this asset's own use case may decide it" });
    }
    if (asset.createdBy === claims.id) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "you cannot decide a review of an asset you created" });
    }
    if (asset.status !== "pending_approval") {
      return reply.code(409).send({ error: "NOT_PENDING", message: `asset is ${asset.status}, not pending_approval` });
    }
    const b = request.body as { decision: "approved" | "rejected"; riskTier?: "low" | "medium" | "high"; rejectionReason?: string };
    if (b.decision === "rejected" && !b.rejectionReason) {
      return reply.code(400).send({ error: "REASON_REQUIRED", message: "a rejection requires a reason" });
    }
    if (b.decision === "approved" && !b.riskTier) {
      return reply.code(400).send({ error: "RISK_TIER_REQUIRED", message: "an approval requires a risk tier" });
    }
    const dd = { ...(asset.dueDiligence ?? {}) };
    if (b.decision === "approved") {
      dd.riskTier = b.riskTier;
      dd.reviewedBy = claims.id;
      dd.reviewedAt = new Date().toISOString();
      dd.rejectionReason = null;
      await deps.assets.setDueDiligence(asset.id, dd);
      const useCase = await deps.useCases.get(asset.useCaseKey);
      const treasury = useCase.treasuryAccountId ? (await deps.accounts.findById(useCase.treasuryAccountId))?.address ?? null : null;
      await executeIssueActivation(deps, { id: claims.id, role: claims.role }, asset, {
        initialSupply: dd.pendingInitialSupply ?? undefined,
        treasury,
        sale: dd.pendingSale ?? undefined,
      });
    } else {
      dd.rejectionReason = b.rejectionReason;
      dd.riskTier = null;
      dd.reviewedBy = null;
      dd.reviewedAt = null;
      await deps.assets.setDueDiligence(asset.id, dd);
      await deps.assets.setStatus(asset.id, "rejected");
    }
    const issuer = await deps.users.findById(asset.createdBy);
    if (issuer) {
      const notice = assetReviewDecisionEmail({ assetName: asset.name, decision: b.decision, rejectionReason: b.rejectionReason });
      await deps.mail.send(issuer.email, notice.subject, notice.text, notice.html).catch((err) => request.log.error({ err, assetId: asset.id }, "[mail] asset-review-decision send failed"));
    }
    const final = await deps.assets.get(asset.id);
    return reply.code(200).send({ id: final!.id, status: final!.status });
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd "apps/api" && pnpm exec vitest run test/asset-review-decision.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Typecheck and run the governance suites**

Run: `cd "apps/api" && pnpm exec tsc --noEmit`
Expected: clean.

Run: `cd "apps/api" && pnpm exec vitest run test/openapi-contract.test.ts test/openapi-snapshot.test.ts test/scope-coverage.test.ts test/persona-edges.test.ts`
Expected: `scope-coverage.test.ts` WILL need a new entry — this route explicitly refuses machine principals outright rather than carrying a scope, mirroring `kyc-decision`'s own entry exactly. In `apps/api/test/scope-coverage.test.ts`'s `DELIBERATELY_UNSCOPED` map, add, in the "refuse machine principals outright" section:

```typescript
  "POST /assets/:id/review-decision": "403 MACHINE_PRINCIPAL: platform/use-case governance (deciding whether an asset may be listed) — mirrors POST /users/:id/kyc/decision",
```

`persona-edges.test.ts`: this route needs to be reachable by `tokenization-issuer` and `tokenization-admin` (the two consoles a UseCaseAdmin actually uses) — check whether their existing `{ prefix: "/assets", methods: "ALL", ... }` rules in `packages/core/src/shared/personas.ts` already cover `/assets/:id/review-decision` as a sub-path (per `coversPattern`'s prefix-matching, they should) before adding anything new. Regenerate the OpenAPI snapshot the same way as prior tasks.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/http/routes/tokenization.ts apps/api/src/http/schemas/tokenization.ts apps/api/src/mail/templates.ts apps/api/test/asset-review-decision.test.ts apps/api/test/scope-coverage.test.ts apps/api/openapi.snapshot.json
git commit -m "feat(assets): add the direct review-decision endpoint (approve/reject, no proposal system)"
```

---

### Task 5: Web — Issuer's diligence upload + submission UI on `AssetDetail.tsx`

**Files:**
- Modify: `apps/web/src/types.ts` (`Asset` type)
- Modify: `apps/web/src/api.ts` (3 new calls)
- Modify: `apps/web/src/components/tokenization/AssetDetail.tsx`

**Interfaces:**
- Consumes: `POST /assets/:id/diligence/documents`, `POST /assets/:id/submit-for-review`, `GET /assets/:id/diligence/documents/:docId` (Tasks 2–3).
- Produces: a "Complete due diligence" panel visible to the asset's own issuer/use-case staff while `status === "pending_approval"` or `"rejected"`.

- [ ] **Step 1: Add `dueDiligence` to the web `Asset` type**

In `apps/web/src/types.ts`, add to `interface Asset` right after `treasuryAccount?: string | null;`:

```typescript
  dueDiligence?: {
    prospectus?: { id: string; sha256: string } | null;
    legalOpinion?: { id: string; sha256: string } | null;
    additionalDocuments?: { id: string; sha256: string; label: string }[];
    riskTier?: "low" | "medium" | "high" | null;
    reviewedBy?: string | null;
    reviewedAt?: string | null;
    rejectionReason?: string | null;
  } | null;
```

(`pendingInitialSupply`/`pendingSale` are deliberately omitted here — they are an internal activation-plumbing detail the web app never needs to read.)

- [ ] **Step 2: Add the API calls**

In `apps/web/src/api.ts`, add near `issue`/`setPrice`:

```typescript
  uploadAssetDiligenceDocument: (token: string, assetId: string, input: { slot: "prospectus" | "legalOpinion" | "additional"; label?: string; contentType: string; dataBase64: string }) =>
    request<{ id: string; sha256: string; size: number }>(`/assets/${assetId}/diligence/documents`, token, { method: "POST", body: JSON.stringify(input) }),
  submitAssetForReview: (token: string, assetId: string) =>
    request<{ id: string; status: string }>(`/assets/${assetId}/submit-for-review`, token, { method: "POST", body: JSON.stringify({}) }),
```

Also update `issue`'s existing doc comment (currently `// 201 → { asset }; 202 (maker-checker gated) → { proposal, asset }.`) to reflect that 201 no longer occurs: `// Always 202 now — every new asset starts pending_approval; see the due-diligence review flow.`

- [ ] **Step 3: Build the panel**

In `apps/web/src/components/tokenization/AssetDetail.tsx`, this codebase's file already has a `fileToBase64`-style pattern established by `KycSubmissionPanel.tsx` (`apps/web/src/components/shared/KycSubmissionPanel.tsx`) — read that file's `fileToBase64` helper and `busy`/`error` state conventions before writing this panel, and follow them exactly (do not invent a different pattern).

Add a new component in this file (or import it if you split it out — this codebase's existing convention in `AssetDetail.tsx` is to keep page-specific sub-components in the same file; follow that):

```typescript
function DueDiligencePanel({ asset, onChanged }: { asset: Asset; onChanged: () => void }): JSX.Element {
  const { token } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [additionalLabel, setAdditionalLabel] = useState("");

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function upload(slot: "prospectus" | "legalOpinion" | "additional", file: File): Promise<void> {
    if (!token) return;
    if (slot === "additional" && !additionalLabel.trim()) { setError("Give the additional document a label first."); return; }
    setBusy(true);
    setError(null);
    try {
      await api.uploadAssetDiligenceDocument(token, asset.id, {
        slot, label: slot === "additional" ? additionalLabel.trim() : undefined,
        contentType: file.type || "application/pdf", dataBase64: await fileToBase64(file),
      });
      setAdditionalLabel("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api.submitAssetForReview(token, asset.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit for review");
    } finally {
      setBusy(false);
    }
  }

  const dd = asset.dueDiligence;

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-3">
      <div className="text-sm font-semibold text-slate-800">Complete due diligence</div>
      <p className="text-xs text-slate-500">Attach a prospectus (required) and, optionally, a legal opinion and any supporting documents, then submit for review.</p>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <label className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-center cursor-pointer hover:border-brand-400">
          {dd?.prospectus ? "✓ Prospectus attached" : "Attach prospectus"}
          <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && void upload("prospectus", e.target.files[0])} />
        </label>
        <label className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-center cursor-pointer hover:border-brand-400">
          {dd?.legalOpinion ? "✓ Legal opinion attached" : "Attach legal opinion (optional)"}
          <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && void upload("legalOpinion", e.target.files[0])} />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <input className="rounded border border-slate-300 px-2 py-1 text-xs flex-1" placeholder="Label for an additional document" value={additionalLabel} onChange={(e) => setAdditionalLabel(e.target.value)} />
        <label className="text-xs rounded border border-slate-300 px-3 py-1.5 cursor-pointer hover:border-brand-400">
          Attach
          <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && void upload("additional", e.target.files[0])} />
        </label>
      </div>
      {dd?.additionalDocuments?.length ? (
        <ul className="text-xs text-slate-600 list-disc list-inside">
          {dd.additionalDocuments.map((d) => <li key={d.id}>{d.label}</li>)}
        </ul>
      ) : null}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button disabled={busy || !dd?.prospectus} onClick={() => void submit()} className="text-xs rounded bg-brand-600 text-white px-3 py-1.5 font-medium hover:bg-brand-700 disabled:opacity-40">
        Submit for review
      </button>
    </div>
  );
}
```

Add `useState` (if not already imported — check the file's existing React import), `ApiError`, and `api` to this file's existing imports (check the current `import { api, ApiError } from "../../api.js";`-style line and adjust if the exact names differ).

Wire it into the main `AssetDetail` component: find the existing block

```typescript
      {asset.status === "pending_approval" && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-2">
          ⏳ Pending approval — supply mints and the asset activates once approved in the Approvals tab.
        </div>
      )}
      {asset.status === "rejected" && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">
          ✕ Issuance rejected — this asset was never activated.
        </div>
      )}
```

and replace it with (the old copy is now inaccurate — there is no "Approvals tab" step in this flow anymore):

```typescript
      {asset.status === "pending_approval" && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-2">
          ⏳ Pending due-diligence review — complete the diligence package below and submit it.
        </div>
      )}
      {asset.status === "rejected" && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">
          ✕ Review rejected{asset.dueDiligence?.rejectionReason ? ` — ${asset.dueDiligence.rejectionReason}` : ""}. Attach the missing documents and resubmit below.
        </div>
      )}
      {can(role, "issue") && (asset.status === "pending_approval" || asset.status === "rejected") && (
        <DueDiligencePanel asset={asset} onChanged={() => void reload()} />
      )}
```

Gate this on `can(role, "issue")`, matching the sibling "List for sale" panel elsewhere in this same file — without it, a Buyer merely viewing a pending/rejected asset (this app's existing read-scoping already lets a same-use-case Buyer load the detail page regardless of status) would see an upload/submit UI that always 403s if used, since only `assets:issue` scope can call the routes behind it. `can` and `role` are already in scope in this component (used by the neighboring "List for sale"/"buy" gates in the same file).

(Use whatever this component's existing reload/refetch function is actually called — check the file for how it re-fetches `asset` after another mutating action, e.g. `setPrice`'s own success handler, and call the same function rather than inventing a new one.)

- [ ] **Step 4: Typecheck and run the web test suite**

Run: `cd "apps/web" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: clean, no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/components/tokenization/AssetDetail.tsx
git commit -m "feat(assets): add the issuer-facing due-diligence upload and submit-for-review UI"
```

---

### Task 6: Web — investor-facing display (`AssetDetail.tsx` documents panel, `AssetList.tsx` risk column)

**Files:**
- Modify: `apps/web/src/components/tokenization/AssetDetail.tsx`
- Modify: `apps/web/src/components/tokenization/AssetList.tsx`
- Modify: `apps/web/src/api.ts` (`API_BASE` export check)

**Interfaces:**
- Consumes: `GET /assets/:id/diligence/documents/:docId` (Task 2).
- Produces: a read-only "Due Diligence" section visible to anyone who can see the asset, and a risk-tier column in the asset list.

- [ ] **Step 1: Confirm `API_BASE` is exported**

`apps/web/src/api.ts` already exports `API_BASE` (used by `UserManagement.tsx`'s KYC document viewer) — no change needed here, just import it into `AssetDetail.tsx`.

- [ ] **Step 2: Add the investor-facing documents section**

In `apps/web/src/components/tokenization/AssetDetail.tsx`, add a second small component near `DueDiligencePanel` (Task 5):

```typescript
function DueDiligenceDisplay({ asset }: { asset: Asset }): JSX.Element | null {
  const { token } = useAuth();
  const dd = asset.dueDiligence;
  if (!dd?.prospectus && !dd?.legalOpinion && !dd?.additionalDocuments?.length) return null;

  // Same synchronous-window-then-redirect pattern as KycReviewPanel's
  // openDocument in UserManagement.tsx — a plain <a href> would not carry the
  // Bearer token this codebase uses for auth, and window.open after an await
  // is silently blocked by real browsers' popup blockers.
  async function openDocument(docId: string): Promise<void> {
    if (!token) return;
    const win = window.open("", "_blank");
    try {
      const res = await fetch(`${API_BASE}/assets/${asset.id}/diligence/documents/${docId}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) { win?.close(); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url; else window.open(url, "_blank");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      win?.close();
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800">Due diligence</div>
        {dd.riskTier && (
          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${dd.riskTier === "low" ? "bg-emerald-100 text-emerald-700" : dd.riskTier === "medium" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"}`}>
            {dd.riskTier} risk
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        {dd.prospectus && <button onClick={() => void openDocument(dd.prospectus!.id)} className="text-brand-600 hover:text-brand-700 font-medium">Prospectus ↗</button>}
        {dd.legalOpinion && <button onClick={() => void openDocument(dd.legalOpinion!.id)} className="text-brand-600 hover:text-brand-700 font-medium">Legal opinion ↗</button>}
        {dd.additionalDocuments?.map((d) => (
          <button key={d.id} onClick={() => void openDocument(d.id)} className="text-brand-600 hover:text-brand-700 font-medium">{d.label} ↗</button>
        ))}
      </div>
    </div>
  );
}
```

Add `API_BASE` to this file's existing `import { api, ApiError } from "../../api.js";` line.

Render it once, right after the header card (before the `pending_approval`/`rejected` banners):

```typescript
      <DueDiligenceDisplay asset={asset} />
```

- [ ] **Step 3: Add the risk-tier column to `AssetList.tsx`**

In `apps/web/src/components/tokenization/AssetList.tsx`, add a new `<th>` right after the existing `Available` column header:

```typescript
            <th className="text-left font-medium px-4 py-2.5">Risk</th>
```

And a matching `<td>` in the row-rendering, right after the availability `<td>` (find the cell that renders `avail`/the availability pill, and add this immediately after its closing `</td>`):

```typescript
                <td className="px-4 py-3">
                  {a.status === "pending_approval" ? (
                    <Pill tone="muted">Pending review</Pill>
                  ) : a.dueDiligence?.riskTier ? (
                    <Pill tone={a.dueDiligence.riskTier === "low" ? "ok" : a.dueDiligence.riskTier === "medium" ? "warn" : "danger"}>{a.dueDiligence.riskTier}</Pill>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
```

(Check `Pill`'s actual `tone` prop values in `apps/web/src/components/shared/ui.tsx` before using `"warn"`/`"danger"` literally — match whatever this component's real tone union already is; `ok`/`muted` are confirmed already in use in this same file.)

- [ ] **Step 4: Typecheck and run the web test suite**

Run: `cd "apps/web" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: clean, no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tokenization/AssetDetail.tsx apps/web/src/components/tokenization/AssetList.tsx
git commit -m "feat(assets): show due-diligence documents and risk tier on the asset detail and list pages"
```

---

### Task 7: Web — "Review Assets" screen for UseCaseAdmins

**Files:**
- Modify: `apps/web/src/api.ts` (1 new call)
- Create: `apps/web/src/components/tokenization/ReviewAssets.tsx`
- Modify: `apps/web/src/components/tokenization/AssetManagement.tsx` (add a new `"review"` tab, gated to `UseCaseAdmin`)

**Interfaces:**
- Consumes: `GET /assets` (existing, filterable by `status`), `POST /assets/:id/review-decision` (Task 4).
- Produces: a UseCaseAdmin-only screen listing their own use case's `pending_approval` assets with a review action.

- [ ] **Step 1: Confirm the mount point (already grounded)**

`apps/web/src/components/tokenization/AssetManagement.tsx` is the tokenization console shell — confirmed by direct read. It declares a `type Sub = "issuance" | "marketplace" | "holdings";`, builds a `subs: { id: Sub; label: string }[]` array conditionally (`canIssue`/`hasWallet` gate which tabs appear), renders a row of tab buttons from that array, then one of `IssuePanel`/`AssetList`/`MyHoldings` based on `sub`. Step 4 below adds a fourth tab, `"review"`, to this exact structure.

- [ ] **Step 2: Add the API call**

In `apps/web/src/api.ts`, add near `assets`:

```typescript
  decideAssetReview: (token: string, id: string, input: { decision: "approved" | "rejected"; riskTier?: "low" | "medium" | "high"; rejectionReason?: string }) =>
    request<{ id: string; status: string }>(`/assets/${id}/review-decision`, token, { method: "POST", body: JSON.stringify(input) }),
```

- [ ] **Step 3: Build the screen**

Create `apps/web/src/components/tokenization/ReviewAssets.tsx`, following the exact inline-expand-panel conventions established by `UserManagement.tsx`'s `KycReviewPanel` (busy/error state, a risk-tier `<select>` for approval, a required-reason `<input>` for rejection):

```typescript
import { useEffect, useState } from "react";
import { api, ApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { Asset } from "../../types.js";
import { Card, EmptyState, Skeleton } from "../shared/ui.js";

export function ReviewAssets(): JSX.Element {
  const { token, user } = useAuth();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState<string | null>(null);

  async function reload(): Promise<void> {
    if (!token) return;
    setLoading(true);
    const all = await api.assets(token, user?.useCaseKey ?? undefined);
    setAssets(all.filter((a) => a.status === "pending_approval"));
    setLoading(false);
  }
  useEffect(() => { void reload(); }, [token]);

  if (loading) return <Card><Skeleton lines={4} /></Card>;
  if (assets.length === 0) return <Card><EmptyState icon="shield-check" title="Nothing pending review" hint="Assets awaiting due-diligence review in your use case will appear here." /></Card>;

  return (
    <div className="space-y-3">
      {assets.map((a) => (
        <div key={a.id} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm">
          <div className="p-4 flex items-center justify-between cursor-pointer" onClick={() => setReviewing((v) => (v === a.id ? null : a.id))}>
            <div>
              <div className="font-medium text-slate-800">{a.name} <span className="text-slate-400 font-normal">{a.symbol}</span></div>
              <div className="text-xs text-slate-400">{a.dueDiligence?.prospectus ? "Submitted for review" : "Awaiting documents"}</div>
            </div>
          </div>
          {reviewing === a.id && <AssetReviewPanel asset={a} onDecided={() => { setReviewing(null); void reload(); }} />}
        </div>
      ))}
    </div>
  );
}

function AssetReviewPanel({ asset, onDecided }: { asset: Asset; onDecided: () => void }): JSX.Element {
  const { token } = useAuth();
  const [riskTier, setRiskTier] = useState<"low" | "medium" | "high">("low");
  const [rejectionReason, setRejectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dd = asset.dueDiligence;

  async function decide(decision: "approved" | "rejected"): Promise<void> {
    if (!token) return;
    if (decision === "rejected" && !rejectionReason.trim()) { setError("A rejection reason is required."); return; }
    setBusy(true);
    setError(null);
    try {
      await api.decideAssetReview(token, asset.id, decision === "approved" ? { decision, riskTier } : { decision, rejectionReason: rejectionReason.trim() });
      onDecided();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record that decision");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-slate-100 p-4 space-y-3 bg-slate-50/60">
      <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
        <div>Prospectus: {dd?.prospectus ? "attached" : "missing"}</div>
        <div>Legal opinion: {dd?.legalOpinion ? "attached" : "—"}</div>
      </div>
      {dd?.additionalDocuments?.length ? <div className="text-xs text-slate-600">Additional: {dd.additionalDocuments.map((d) => d.label).join(", ")}</div> : null}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <select className="rounded border border-slate-300 px-2 py-1 text-xs" value={riskTier} onChange={(e) => setRiskTier(e.target.value as "low" | "medium" | "high")}>
          <option value="low">Low risk</option>
          <option value="medium">Medium risk</option>
          <option value="high">High risk</option>
        </select>
        <button disabled={busy || !dd?.prospectus} onClick={() => void decide("approved")} className="text-xs rounded bg-emerald-600 text-white px-3 py-1.5 font-medium hover:bg-emerald-700 disabled:opacity-40">Approve</button>
        <input className="rounded border border-slate-300 px-2 py-1 text-xs flex-1" placeholder="Rejection reason" value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} />
        <button disabled={busy} onClick={() => void decide("rejected")} className="text-xs rounded border border-red-300 text-red-600 px-3 py-1.5 font-medium hover:bg-red-50 disabled:opacity-40">Reject</button>
      </div>
    </div>
  );
}
```

(Confirm `EmptyState`'s `icon` prop accepts `"shield-check"` — check `apps/web/src/components/shared/ui.tsx`'s icon set; substitute an existing icon name from that set if not.)

- [ ] **Step 4: Wire the tab into `AssetManagement.tsx`**

In `apps/web/src/components/tokenization/AssetManagement.tsx`:

1. Add the import, alongside the existing component imports:

```typescript
import { ReviewAssets } from "./ReviewAssets.js";
```

2. Widen the `Sub` type:

```typescript
type Sub = "issuance" | "marketplace" | "holdings" | "review";
```

3. Add one more entry to the `subs` array — reviewing is a UseCaseAdmin-only act, distinct from `canIssue` (which `UseCaseAdmin`, `Issuer`, `OrgAdmin`, and `PlatformAdmin` all satisfy per `rbac.ts`'s `can()` table) and from `hasWallet` (irrelevant here), so gate it directly on the role rather than adding a new `rbac.ts` action for a single screen:

```typescript
  const isUseCaseAdmin = user?.role === "UseCaseAdmin";
  const subs: { id: Sub; label: string }[] = [
    ...(canIssue ? [{ id: "issuance" as Sub, label: "Token Issuance" }] : []),
    { id: "marketplace" as Sub, label: "Marketplace" },
    ...(hasWallet ? [{ id: "holdings" as Sub, label: "My Holdings" }] : []),
    ...(isUseCaseAdmin ? [{ id: "review" as Sub, label: "Review Assets" }] : []),
  ];
```

4. Add the render branch, alongside the other three:

```typescript
      {sub === "review" && <ReviewAssets />}
```

- [ ] **Step 5: Typecheck and run the web test suite**

Run: `cd "apps/web" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: clean, no regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/components/tokenization/ReviewAssets.tsx apps/web/src/components/tokenization/AssetManagement.tsx
git commit -m "feat(assets): add a Review Assets screen for UseCaseAdmins"
```

---

### Task 8: Make due-diligence review mandatory — flip `issueAssetCore`, migrate every affected test

**Files:**
- Modify: `apps/api/src/http/routes/tokenization.ts` (`issueAssetCore`)
- Modify: `apps/api/src/http/schemas/tokenization.ts` (`issueAsset` response: 202 only)
- Modify: `apps/api/src/http/schemas/components.ts` (`Asset#` component: add `dueDiligence`)
- Modify: `apps/api/test/helpers.ts` (`issueAsset` helper)
- Modify: every test file identified in Step 3 below (mechanical fix, per-file)
- Test: extend `apps/api/test/asset-review-decision.test.ts` or add a new small test proving the flip itself

**Interfaces:**
- Produces: every new asset is `pending_approval` from birth, regardless of `workflow.approvals.issue`. `issueAssetCore` no longer calls `proposeIfGated` for issuance.

This is the single highest-risk task in this plan — read the Global Constraints' "Blast radius warning" again before starting, and do not attempt this alongside any other task.

- [ ] **Step 1: Change `issueAssetCore`**

In `apps/api/src/http/routes/tokenization.ts`, inside `issueAssetCore`, find this line:

```typescript
    const gatedIssue = !!useCase.workflow?.approvals?.issue;
```

Replace it with:

```typescript
    // Due-diligence review is now mandatory for every asset, superseding the
    // old opt-in workflow.approvals.issue gate for issuance specifically (see
    // this plan's Global Constraints and the spec's Non-goals for why running
    // both gates on the same asset was rejected as a design). `gatedIssue`
    // stays named the same below so the rest of this function's existing
    // branches (mint deferral, sale-terms deferral) need no further change —
    // only what feeds into them changes.
    const gatedIssue = true;
```

Then find the block that handles the gated branch:

```typescript
      if (gatedIssue) {
        // Defer supply mint + sale terms to approval; capture them in the proposal.
        // ...
        const wantsTreasury = wantsSupply || !!sale;
        const proposal = await proposeIfGated(input.request, useCase, "issue", id, {
          ...(wantsSupply ? { initialSupply } : {}),
          ...(wantsTreasury ? { treasury } : {}),
          ...(sale ? { sale } : {}),
          ...(issuanceFeeCharged ? { issuanceFee: { ...issuanceFeeCharged, payer: feePayer } } : {}),
        });
        // `gatedIssue` already established this use case gates "issue", so
        // proposeIfGated cannot have returned null here.
        return { ok: true, status: 202, body: { proposal: proposal ? proposalView(proposal) : null, asset: await deps.assets.get(id) } };
      }
```

Replace it with:

```typescript
      if (gatedIssue) {
        // No proposal — see this plan's Task 4 and the spec's section D for
        // why. Stash the deferred activation params on the asset itself
        // instead, for POST /assets/:id/review-decision to read back later.
        await deps.assets.setDueDiligence(id, {
          ...(wantsSupply ? { pendingInitialSupply: initialSupply } : {}),
          ...(sale ? { pendingSale: sale } : {}),
        });
        return { ok: true, status: 202, body: { asset: await deps.assets.get(id) } };
      }
```

(The `issuanceFeeCharged` value charged earlier in this same function is unaffected by this change — the fee is still charged at issuance time either way, matching today's behavior exactly; only the mint/sale-terms deferral mechanism changes.)

- [ ] **Step 2: Update the `issueAsset` response schema**

In `apps/api/src/http/schemas/tokenization.ts`, `issueAsset`'s `response` object currently has only a `201` entry. Change it to `202` (every issuance is now pending):

```typescript
    response: {
      202: {
        type: "object",
        properties: {
          asset: { $ref: "Asset#" },
          issuanceFee: { type: "object", additionalProperties: true, nullable: true },
        },
        required: ["asset"],
      },
      ...errs(400, 401, 403),
    },
```

- [ ] **Step 3: Add `dueDiligence` to the `Asset#` schema component**

In `apps/api/src/http/schemas/components.ts`, find the `Asset` component (`$id: "Asset"`) and add one property, right after `treasuryAccount: { type: "string", nullable: true },`:

```typescript
      dueDiligence: { type: "object", additionalProperties: true, nullable: true },
```

- [ ] **Step 4: Fix the shared `issueAsset` test helper**

In `apps/api/test/helpers.ts`, `issueAsset` currently throws if the response is not `201`. Update it to complete the full due-diligence flow before returning, so its 8 existing call sites keep getting back an `active` asset with no changes needed on their end. Replace the function body:

```typescript
/** Issue an asset for the given use case key, complete due diligence, and
 *  have the use case's own seeded UseCaseAdmin approve it — returns the new
 *  asset's id, already `active`. Every asset now starts `pending_approval`;
 *  this helper exists so the majority of this test suite, which only cares
 *  about having an active asset to test something ELSE, doesn't need to know
 *  that. A test that specifically wants to exercise the pending/review flow
 *  itself should call the underlying routes directly instead of this helper. */
export async function issueAsset(app: FastifyInstance, token: string, useCaseKey: string): Promise<string> {
  const meta: Record<string, Record<string, unknown>> = {
    "carbon-credit": { projectName: "P", registry: "Verra", vintage: 2024 },
    "gold-loan": { borrower: "R", goldWeightGrams: 1, loanAmountInr: 1 },
    "corporate-bond": { issuer: "ACME", isin: "X", faceValue: 1 },
  };
  const res = await app.inject({
    method: "POST",
    url: `${V1}/assets`,
    headers: { authorization: `Bearer ${token}` },
    payload: { useCaseKey, name: "T", symbol: "T", chainId: "fabric", metadata: meta[useCaseKey] ?? {} },
  });
  if (res.statusCode !== 202) throw new Error(`issueAsset(${useCaseKey}) failed: ${res.statusCode} ${res.body}`);
  const assetId = res.json().asset.id as string;
  await approveAssetForTest(app, assetId, useCaseKey);
  return assetId;
}

/** Attach a throwaway prospectus, submit for review, and approve as the use
 *  case's own seeded UseCaseAdmin — the mechanical fix every other test file
 *  in this suite that assumed synchronous active issuance also needs,
 *  applied here once so `issueAsset`'s own callers get it for free. */
export async function approveAssetForTest(app: FastifyInstance, assetId: string, useCaseKey: string): Promise<void> {
  const admins: Record<string, { email: string; password: string }> = {
    "carbon-credit": { email: "carbon.admin@tokenlayer.dev", password: "carbon123" },
    "gold-loan": { email: "gold.admin@tokenlayer.dev", password: "gold123" },
    "corporate-bond": { email: "bond.admin@tokenlayer.dev", password: "bond123" },
    "invoice-tokenization": { email: "m1.admin@tokenlayer.dev", password: "m1admin123" },
  };
  const admin = admins[useCaseKey];
  if (!admin) throw new Error(`approveAssetForTest: no seeded UseCaseAdmin known for use case '${useCaseKey}'`);
  const adminToken = await loginAs(app, admin.email, admin.password);
  const platformToken = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  await app.inject({
    method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: { authorization: `Bearer ${platformToken}` },
    payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 test fixture").toString("base64") },
  });
  await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: { authorization: `Bearer ${platformToken}` } });
  const decision = await app.inject({
    method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: { authorization: `Bearer ${adminToken}` },
    payload: { decision: "approved", riskTier: "low" },
  });
  if (decision.statusCode !== 200) throw new Error(`approveAssetForTest(${assetId}) failed: ${decision.statusCode} ${decision.body}`);
}
```

(This uses `platformToken` — not the original `token` param — to upload the document and submit, since the ORIGINAL caller's `token` might itself belong to the UseCaseAdmin who will decide it, and Task 4 refuses an asset's own creator from deciding it. `PlatformAdmin` can always call `assets:issue`-scoped routes per this codebase's existing RBAC, and is never the asset's `createdBy` in this path, so it is always eligible to complete the paperwork regardless of who the original issuer was.)

- [ ] **Step 5: Run the focused + governance tests so far**

Run: `cd "apps/api" && pnpm exec tsc --noEmit`
Expected: clean.

Run: `cd "apps/api" && pnpm exec vitest run test/asset-due-diligence-repo.test.ts test/asset-diligence-documents.test.ts test/asset-submit-for-review.test.ts test/asset-review-decision.test.ts test/openapi-contract.test.ts test/openapi-snapshot.test.ts test/scope-coverage.test.ts test/persona-edges.test.ts`
Expected: PASS after regenerating the OpenAPI snapshot (the `issueAsset` schema's `201`→`202` change is a real, reviewable surface change — read the diff).

- [ ] **Step 6: Run the full suite and find every remaining break**

Run: `cd "apps/api" && pnpm exec vitest run`
Expected: many failures — this is the point of this step. Every failure falls into one of these categories:

1. **Uses the shared `issueAsset()` helper** — already fixed by Step 4, should pass now. If one still fails, read why; it likely asserts something about the OLD synchronous 201 response shape directly rather than just using the returned asset id — fix that specific assertion.
2. **Has its own local "issue an asset" helper** (confirmed by name in this codebase today: `issuePricedCarbonAsset` in `apps/api/test/admin-issue-kyc.test.ts` and `apps/api/test/identity-gate.test.ts`; `issueGenericAsset` in `apps/api/test/api.test.ts`; `setupMarket()` in `apps/api/test/market.test.ts`, which issues inline rather than via a named helper; and others this repo-wide grep will surface: `grep -rln 'url: \`\${V1}/assets\`' apps/api/test/*.ts` before starting, to get the current, authoritative file list — the count in this plan's Global Constraints (21 files, 48 sites) was measured once and may have drifted slightly by the time you run it). For each: read the local helper, and add a call to the now-exported `approveAssetForTest(app, assetId, useCaseKey)` (from `./helpers.js`) immediately after the asset is created, **only if that test actually needs the asset `active`** — some tests exist specifically to test the `pending_approval` state itself (e.g. any test asserting `status === "pending_approval"` today) and must NOT be "fixed" into activating, since that would defeat the point of the test. Read each failing test before changing it.
3. **A test whose entire point is the OLD `workflow.approvals.issue` gated-issuance behavior** (search for `workflow.approvals.issue` or `gatedIssue` across `apps/api/test/*.ts`) — these tests are now testing dead code per this plan's Global Constraints (the flag is inert for new assets). Do not delete them silently: read what each one actually asserts, and if it's testing behavior this plan intentionally retired, replace its assertions with the new due-diligence flow's equivalent behavior (e.g. "an asset with `workflow.approvals.issue: true` still ends up `pending_approval` and still needs review" — true under the new system too, just via due diligence, not the old proposal), rather than leaving a test that silently no longer proves what its name claims.
4. **An assertion about `POST /assets` returning 201** anywhere (`grep -rn 'assets.*201\|201.*assets' apps/api/test/*.ts`) — change to 202, per Step 2.

- [ ] **Step 7: Iterate to a fully clean full suite**

Repeat: fix a category, re-run `pnpm exec vitest run`, until it reports 0 failures. Do not move on with any failure unaddressed — this task's entire purpose is to leave the suite green.

Run one final confirming pass: `cd "apps/api" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: clean, full pass.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/http/routes/tokenization.ts apps/api/src/http/schemas/tokenization.ts apps/api/src/http/schemas/components.ts apps/api/test/helpers.ts apps/api/openapi.snapshot.json
git commit -m "feat(assets): make due-diligence review mandatory for every new asset"
```

Then, in one or more FOLLOW-UP commits (do not bundle 40+ unrelated test-file diffs into the same commit as the core behavior change above — that makes the real change unreviewable):

```bash
git add apps/api/test/<each file you touched in Steps 6-7>
git commit -m "test(assets): migrate existing fixtures to the mandatory due-diligence review flow"
```

---

### Task 9: Deploy and live-verify

**Files:** none — deployment and browser verification only, no code changes expected (unless verification surfaces a bug, in which case fix it in the relevant file from Tasks 1–8 and re-verify).

- [ ] **Step 1: Redeploy**

Run: `bash scripts/stack-up.sh identity tokenization`
Expected: both stacks come up cleanly. If the tokenization API image appears stale (a repeat of the exact gotcha hit during this session's KYC deploy — verify with `docker exec xi-tokenization-tokenization-api-1 sh -c "grep -c review-decision /app/apps/api/src/http/routes/tokenization.ts"` before trusting the deploy), `docker rm -f`/`docker rmi` the tokenization-api container/image and rebuild.

- [ ] **Step 2: Verify the full flow end-to-end as a real Issuer**

1. Sign in to the tokenization issuer console as `carbon.issuer@tokenlayer.dev` / `carbon123`.
2. Issue a new asset. Confirm the response/UI reflects `pending_approval`, not immediate activation.
3. Open the asset's detail page. Confirm the "Complete due diligence" panel appears, upload a real PDF as the prospectus, confirm "Submit for review" is disabled until it's attached, then submit.

- [ ] **Step 3: Verify the review flow as the UseCaseAdmin**

1. Sign in as `carbon.admin@tokenlayer.dev` / `carbon123`.
2. Find the "Review Assets" screen, confirm the submitted asset appears with its prospectus visible/downloadable.
3. Approve it with a risk tier. Confirm the asset detail page now shows `active`, the risk badge, and the prospectus/legal-opinion links (open the prospectus and confirm it's the real uploaded file, not a blocked popup — this is the exact popup-blocker class of bug this session's KYC work already had to fix once).
4. Confirm `carbon.issuer@tokenlayer.dev` received a decision email (check Mailpit).
5. As `carbon.buyer@tokenlayer.dev`, confirm the asset now shows in the marketplace list with its risk tier, and its due-diligence documents are readable.

- [ ] **Step 4: Verify a rejection**

Repeat with a fresh asset, reject it with a reason as the UseCaseAdmin, confirm the asset detail page shows the rejection reason and the diligence panel reappears for a resubmission, and confirm the issuer's email includes the reason.

- [ ] **Step 5: Verify the security boundaries live**

1. As a UseCaseAdmin from a *different* use case (e.g. `gold.admin@tokenlayer.dev`), confirm attempting to decide the carbon-credit asset's review is refused.
2. As a Buyer scoped to a *different* use case, confirm the pending/rejected asset's diligence documents are not readable (404, matching `scopedAsset`'s own read-scoping).
3. Directly attempt `GET /documents/:id` on one of the uploaded diligence document ids (via the browser console, same technique as the KYC live-verify pass) and confirm it 403s.

- [ ] **Step 6: Clean up test data**

Per this project's established practice: deactivate (do not delete) any fresh test accounts or leave test assets in a clearly-labeled state; there is no analogous "test asset" cleanup concern beyond what the existing seeded demo accounts already provide.
