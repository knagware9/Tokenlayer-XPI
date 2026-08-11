# Brand-Logo Orphan Reaping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `POST /orgs/:id/branding/logo` leaking a 5 MB document row for every reconsidered logo pick, by marking brand-logo uploads with a `purpose` and having each upload delete its own superseded predecessors.

**Architecture:** Add a nullable `purpose` column to `Document`, stamped `"brand-logo"` by the branding door alone. Make that marking authoritative by refusing brand-logo documents at the certificate-artwork pin, so `Organization.brandLogoDocumentId` becomes the only reference that can exist to such a row. The upload route then prunes, after storing, every brand-logo row of that org except the one just created and the one currently pinned. No cap, no sweep, no cron.

**Tech Stack:** TypeScript, Fastify, Prisma (SQLite, `db push` — this repo keeps no migration files), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-11-brand-logo-orphan-reaping-design.md`

---

## File Structure

**Create:**
- `apps/api/src/brand-logo-prune.ts` — the prune, as its own unit. `routes.ts` is already ~6,500 lines; a self-contained, separately-testable function does not belong in it.
- `apps/api/test/brand-logo-prune.test.ts` — unit tests for that function against the memory repository.
- `apps/api/test/org-branding-prune.test.ts` — HTTP-level tests for the prune and for the artwork refusal that makes it sound.

**Modify:**
- `apps/api/prisma/schema.prisma:224-238` — `Document.purpose`
- `apps/api/src/persistence/types.ts:256-278` — `DocumentPurpose`, `DocumentSummary`, `DocumentRecord.purpose`, two new `DocumentRepository` methods
- `apps/api/src/persistence/memory.ts:449-460` — memory implementation
- `apps/api/src/persistence/prisma.ts:294-306` — Prisma implementation
- `apps/api/src/http/routes.ts` — `storeUploadedDocument` signature + four call sites; the `checkBackgroundDocument` refusal; the prune wiring
- `apps/api/src/http/schemas.ts:1298-1299` — document the new error code
- `apps/api/test/certificate-org-design.test.ts:57-60`, `apps/api/test/org-branding-upload.test.ts:237`, `apps/api/test/org-branding-route.test.ts` — existing direct `documents.create` calls gain `purpose`

## Conventions

Run one API test file:

```bash
"/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api/node_modules/.bin/vitest" run --root "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" test/brand-logo-prune.test.ts
```

**Never touch `apps/api/prisma/dev.db*`.** No task below runs `prisma db push` against it; the schema edit is committed as source and applied by whoever runs `db:setup`.

---

### Task 1: `purpose` on the document row

> **Amended after code review.** The code as shipped differs from the blocks
> below in six ways, all tightenings: `remove(id)` became
> `removeByOwnerPurpose(id, ownerOrgId, purpose)` so the only delete path on
> `Document` structurally cannot reach a KYB certificate; the schema gained
> `@@index([ownerOrgId, purpose])`; the Prisma `create` binds its `data` to a
> type that makes `purpose` required, because Prisma's generated input has it
> optional and omitting it would have compiled; `listByOwnerPurpose` is ordered
> oldest-first on both sides; the Prisma read narrows `purpose` instead of
> casting it; and two comments were corrected. Task 3 below already reflects the
> new delete signature.

**Files:**
- Modify: `apps/api/prisma/schema.prisma:224-238`
- Modify: `apps/api/src/persistence/types.ts:256-278`
- Modify: `apps/api/src/persistence/memory.ts:449-460`
- Modify: `apps/api/src/persistence/prisma.ts:294-306`
- Test: `apps/api/test/brand-logo-prune.test.ts`

- [ ] **Step 1: Write the failing repository test**

Create `apps/api/test/brand-logo-prune.test.ts` with only this block for now:

```ts
import { describe, expect, it } from "vitest";
import { MemoryDocumentRepository } from "../src/persistence/memory.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=", "base64");

describe("MemoryDocumentRepository — purpose", () => {
  it("stores the purpose and reads it back on the record", async () => {
    const docs = new MemoryDocumentRepository();
    const made = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    expect((await docs.get(made.id))?.purpose).toBe("brand-logo");

    const plain = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: null });
    expect((await docs.get(plain.id))?.purpose).toBeNull();
  });

  it("listByOwnerPurpose filters on BOTH owner and purpose, and never returns bytes", async () => {
    const docs = new MemoryDocumentRepository();
    const mine = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    // Same org, different purpose — this is the certificate-artwork / invoice-evidence
    // case that a naive `ownerOrgId`-only query would have swept up.
    await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: null });
    // Same purpose, different org — the cross-tenant half.
    await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_b", purpose: "brand-logo" });

    const rows = await docs.listByOwnerPurpose("org_a", "brand-logo");
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
    // Deciding what to delete must not drag 5MB buffers into memory.
    expect(rows[0]).not.toHaveProperty("bytes");
    expect(rows[0]).toMatchObject({ id: mine.id, size: PNG.length, createdAt: expect.any(String) });
  });

  it("remove deletes the row, and removing an absent id is not an error", async () => {
    const docs = new MemoryDocumentRepository();
    const made = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    await docs.remove(made.id);
    expect(await docs.get(made.id)).toBeNull();
    await expect(docs.remove("doc_never_existed")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
"/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api/node_modules/.bin/vitest" run --root "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" test/brand-logo-prune.test.ts
```

Expected: FAIL — TypeScript rejects the `purpose` property on `create`, and `listByOwnerPurpose` / `remove` do not exist on `MemoryDocumentRepository`.

- [ ] **Step 3: Add the Prisma column**

In `apps/api/prisma/schema.prisma`, inside `model Document`, after the `ownerOrgId` field and its comment block (line 237):

```prisma
  // WHAT THESE BYTES WERE UPLOADED FOR, and NULL means "an ordinary document" —
  // every upload site except the brand-logo door writes null, as does every row
  // written before this column existed. It is not decoration: it is the only
  // thing that distinguishes an organization's mark from its certificate
  // artwork, its KYB certificates and its invoice evidence, all of which are
  // also org-owned PNGs. `brand-logo` rows are the ONLY ones the prune in
  // `brand-logo-prune.ts` may delete, and a null row is therefore never swept —
  // there is no honest way to guess what a legacy row was for.
  purpose     String?
```

- [ ] **Step 4: Extend the repository contract**

In `apps/api/src/persistence/types.ts`, replace the `DocumentRecord` interface and `DocumentRepository` interface (lines 255-278) with:

```ts
/**
 * What a stored document was uploaded FOR. A closed union rather than a free
 * string so a typo cannot invent a third purpose that no gate knows about.
 */
export type DocumentPurpose = "brand-logo";

/** An uploaded document (bytes + content-type), referenced from asset metadata. */
export interface DocumentRecord {
  id: string;
  contentType: string;
  sha256: string;
  size: number;
  bytes: Buffer;
  createdAt: string;
  /**
   * The organization these bytes belong to, or null when nobody owns them (a
   * platform upload, a pre-org KYB registration, a pre-column row). NULL IS NOT
   * "SHARED": every gate requires a non-null match, so a null-owned document is
   * referenceable by a PlatformAdmin and by no one else.
   */
  ownerOrgId: string | null;
  /**
   * What the upload was for, or null for an ordinary document. Only
   * `POST /orgs/{id}/branding/logo` writes a non-null value today.
   */
  purpose: DocumentPurpose | null;
}

/**
 * A document row WITHOUT its bytes. The prune decides what to delete from this
 * shape alone — loading 5MB buffers to compare ids would be absurd.
 */
export interface DocumentSummary {
  id: string;
  size: number;
  createdAt: string;
}

export interface DocumentRepository {
  /** `ownerOrgId` and `purpose` are both REQUIRED, not optional: an upload site
   *  that forgets who owns the bytes writes a document nobody can later be
   *  refused access to on ownership grounds, and one that forgets the purpose
   *  writes a mark the prune cannot see. An optional parameter is how both get
   *  forgotten. */
  create(input: { contentType: string; bytes: Buffer; ownerOrgId: string | null; purpose: DocumentPurpose | null }): Promise<{ id: string; sha256: string; size: number }>;
  get(id: string): Promise<DocumentRecord | null>;
  /** Every document this org owns with this purpose, WITHOUT bytes. */
  listByOwnerPurpose(ownerOrgId: string, purpose: DocumentPurpose): Promise<DocumentSummary[]>;
  /** Delete one document. IDEMPOTENT — an absent id is not an error, because
   *  the prune is best-effort and may race another prune of the same row. */
  remove(id: string): Promise<void>;
}
```

- [ ] **Step 5: Implement in the memory repository**

In `apps/api/src/persistence/memory.ts`, replace `MemoryDocumentRepository` (lines 449-460) with:

```ts
export class MemoryDocumentRepository implements DocumentRepository {
  private readonly docs = new Map<string, DocumentRecord>();
  async create({ contentType, bytes, ownerOrgId, purpose }: { contentType: string; bytes: Buffer; ownerOrgId: string | null; purpose: DocumentPurpose | null }) {
    const docId = randomUUID();
    const sha256 = "0x" + createHash("sha256").update(bytes).digest("hex");
    this.docs.set(docId, { id: docId, contentType, sha256, size: bytes.length, bytes, createdAt: now(), ownerOrgId, purpose });
    return { id: docId, sha256, size: bytes.length };
  }
  async get(docId: string): Promise<DocumentRecord | null> {
    return this.docs.get(docId) ?? null;
  }
  async listByOwnerPurpose(ownerOrgId: string, purpose: DocumentPurpose): Promise<DocumentSummary[]> {
    // Projected to a summary, mirroring the Prisma `select` — a test that passed
    // here while the real repository loaded every buffer would prove nothing.
    return [...this.docs.values()]
      .filter((d) => d.ownerOrgId === ownerOrgId && d.purpose === purpose)
      .map((d) => ({ id: d.id, size: d.size, createdAt: d.createdAt }));
  }
  async remove(docId: string): Promise<void> {
    this.docs.delete(docId); // `Map.delete` on an absent key is already a no-op
  }
}
```

Add `DocumentPurpose` and `DocumentSummary` to the existing `import type { ... } from "./types.js"` block near the top of the file (it already imports `DocumentRecord` and `DocumentRepository`).

- [ ] **Step 6: Implement in the Prisma repository**

In `apps/api/src/persistence/prisma.ts`, replace `PrismaDocumentRepository` (lines 294-306) with:

```ts
export class PrismaDocumentRepository implements DocumentRepository {
  async create({ contentType, bytes, ownerOrgId, purpose }: { contentType: string; bytes: Buffer; ownerOrgId: string | null; purpose: DocumentPurpose | null }): Promise<{ id: string; sha256: string; size: number }> {
    const sha256 = "0x" + createHash("sha256").update(bytes).digest("hex");
    const row = await prisma.document.create({ data: { contentType, sha256, size: bytes.length, bytes, ownerOrgId, purpose } });
    return { id: row.id, sha256, size: bytes.length };
  }
  async get(id: string): Promise<DocumentRecord | null> {
    const r = await prisma.document.findUnique({ where: { id } });
    return r
      ? { id: r.id, contentType: r.contentType, sha256: r.sha256, size: r.size, bytes: Buffer.from(r.bytes), createdAt: r.createdAt.toISOString(), ownerOrgId: r.ownerOrgId ?? null, purpose: (r.purpose as DocumentPurpose | null) ?? null }
      : null;
  }
  async listByOwnerPurpose(ownerOrgId: string, purpose: DocumentPurpose): Promise<DocumentSummary[]> {
    // `select` WITHOUT `bytes`, deliberately: this runs on every logo upload and
    // must not pull megabytes out of the database to compare identifiers.
    const rows = await prisma.document.findMany({
      where: { ownerOrgId, purpose },
      select: { id: true, size: true, createdAt: true },
    });
    return rows.map((r) => ({ id: r.id, size: r.size, createdAt: r.createdAt.toISOString() }));
  }
  async remove(id: string): Promise<void> {
    // `deleteMany`, not `delete`: `delete` throws P2025 when the row is already
    // gone, and this must be idempotent for a best-effort, racing prune.
    await prisma.document.deleteMany({ where: { id } });
  }
}
```

Add `DocumentPurpose` and `DocumentSummary` to the existing `import type { ... } from "./types.js"` block near the top of the file.

- [ ] **Step 7: Fix the four production callers and the three test callers**

In `apps/api/src/http/routes.ts`, change `storeUploadedDocument` (lines 95-107) to take the purpose:

```ts
async function storeUploadedDocument(
  documents: AppDeps["documents"],
  body: { contentType: string; dataBase64: string },
  ownerOrgId: string | null,
  purpose: DocumentPurpose | null,
): Promise<{ id: string; sha256: string; size: number }> {
  if (!ALLOWED_DOC_TYPES.has(body.contentType)) {
    throw coded(415, "UNSUPPORTED_DOCUMENT_TYPE", `contentType must be one of: ${[...ALLOWED_DOC_TYPES].join(", ")}`);
  }
  const bytes = Buffer.from(body.dataBase64, "base64");
  if (bytes.length === 0) throw coded(400, "BAD_DOCUMENT", "empty document");
  if (bytes.length > MAX_DOC_BYTES) throw coded(413, "DOCUMENT_TOO_LARGE", `max ${MAX_DOC_BYTES} bytes`);
  return documents.create({ contentType: body.contentType, bytes, ownerOrgId, purpose });
}
```

Add `type DocumentPurpose` to the existing `import type { ... } from "../persistence/types.js"` line at the top of `routes.ts`.

Then the four call sites — three pass `null`, one passes `"brand-logo"`:

- Line 1735 (certificate artwork): `await storeUploadedDocument(deps.documents, b, existing.ownerOrgId ?? null, null)`
- Line 3531 (public KYB): `await storeUploadedDocument(deps.documents, request.body as { contentType: string; dataBase64: string }, null, null)`
- Line 3996 (brand logo): `await storeUploadedDocument(deps.documents, b, id, "brand-logo")`
- Line 6259 (general store): `await storeUploadedDocument(deps.documents, request.body as { contentType: string; dataBase64: string }, (request.user as TokenClaims).orgId ?? null, null)`

Three test files call `documents.create` directly and must pass `purpose` too. All three are storing ordinary documents, so all three pass `null`:

- `apps/api/test/certificate-org-design.test.ts:58` — `h.deps.documents.create({ contentType, bytes: Buffer.from(b64, "base64"), ownerOrgId, purpose: null })`
- `apps/api/test/org-branding-upload.test.ts:237` — `h.deps.documents.create({ contentType: "image/webp", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: a.id, purpose: null })`
- `apps/api/test/org-branding-route.test.ts:45` — `h.deps.documents.create({ contentType, bytes: Buffer.from(dataBase64, "base64"), ownerOrgId, purpose: null })`

- [ ] **Step 8: Run the new test plus everything that touches documents**

```bash
"/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api/node_modules/.bin/vitest" run --root "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" test/brand-logo-prune.test.ts test/documents.test.ts test/certificate-org-design.test.ts test/certificate-artwork.test.ts test/org-branding-upload.test.ts test/org-branding-route.test.ts
```

Expected: PASS, all files.

- [ ] **Step 9: Typecheck**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" && npx tsc --noEmit
```

Expected: no errors. If `prisma.document.purpose` is unknown to the client, run `npm run prisma:generate` from `apps/api` — that regenerates the client from the schema and does **not** touch `dev.db`.

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types.ts apps/api/src/persistence/memory.ts apps/api/src/persistence/prisma.ts apps/api/src/http/routes.ts apps/api/test/brand-logo-prune.test.ts apps/api/test/certificate-org-design.test.ts apps/api/test/org-branding-upload.test.ts apps/api/test/org-branding-route.test.ts
git commit -m "feat(api): record what a document was uploaded for

A document row carried no discriminator, so nothing could tell an org's
mark from its certificate artwork, its KYB certificates or its invoice
evidence — all of which are org-owned PNGs too. \`purpose\` is required
on create for the same reason \`ownerOrgId\` is: an optional parameter is
how an upload site forgets."
```

---

### Task 2: a brand logo may not be pinned as certificate artwork

This is what makes Task 3 sound. Without it, a brand-logo document can be
referenced from inside `CredentialUseCase.credentialTypes` JSON, where no
"is it pinned" query can see it, and the prune would delete bytes a
certificate still draws.

> **Amended after code review.** The steps below, as originally written,
> closed exactly one door: `certificate.background` inside
> `checkBackgroundDocument`. Code review found the reference set is wider:
> `certificate.logoDocumentId` (a different field of the same JSON, which
> `checkDefinitionBackgrounds` never inspected), the credential-use-case
> template save door and the provision path (a template carries
> `logoDocumentId` where it strips `background`), and `StagedInvoice.documentId`
> at `POST /use-cases/:key/invoices` (existence-checked only, no ownership, no
> purpose). All four now share one predicate, `brandLogoRefusal` in
> `routes.ts`, with a distinct error code per door. See the design doc's
> "The invariant that makes deletion safe" for the corrected enumeration and
> the reasoning error that produced the first, incomplete one: upload *sites*
> (four, in Task 1) are a different list from reference *sites* (now five),
> and treating the first list as though it answered the second is what missed
> three of them.

**Files:**
- Modify: `apps/api/src/http/routes.ts:1147-1152` (inside `checkBackgroundDocument`)
- Modify: `apps/api/src/http/schemas.ts:1298-1299`
- Test: `apps/api/test/org-branding-prune.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/org-branding-prune.test.ts`:

```ts
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const ROUNDS = 4;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=";

/** An active org plus a logged-in OrgAdmin of it. Same eleven-line fixture as
 *  org-branding-upload.test.ts, copied for the reason stated there: it is a
 *  fixture, not shared logic. */
async function org(h: TestAppHandle, label: string) {
  const tag = Math.random().toString(36).slice(2, 8);
  const rec = await h.organizations.create({
    name: `${label} ${tag}`, orgType: "corporate", registrationId: null, jurisdiction: null,
    did: `did:key:zB${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
    verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
    brandLogoDocumentId: null, brandAccent: null,
  });
  const email = `admin-${tag}@brandprune.dev`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync("brand-secret-1", ROUNDS), role: "OrgAdmin",
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId: rec.id, kind: "human",
  });
  return { id: rec.id, token: await loginAs(h.app, email, "brand-secret-1") };
}

const upload = (h: TestAppHandle, orgId: string, token: string) =>
  h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/branding/logo`, headers: auth(token), payload: { contentType: "image/png", dataBase64: PNG_B64 } });

const patchBranding = (h: TestAppHandle, orgId: string, token: string, body: unknown) =>
  h.app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/branding`, headers: auth(token), payload: body });

/**
 * THE REFUSAL THAT MAKES THE PRUNE SOUND, tested here rather than beside the
 * other certificate tests because it exists for this feature and nothing else.
 *
 * Certificate backgrounds live inside `CredentialUseCase.credentialTypes` JSON,
 * not in a column, and `checkBackgroundDocument` gated a pin on org ownership
 * alone. So an org could pin its own brand logo as artwork, that reference would
 * be invisible to any "is this document still pinned" query, and the prune would
 * delete bytes a certificate still draws. Refusing here closes the set of
 * possible references by construction: `Organization.brandLogoDocumentId` is
 * then the only one that can exist.
 */
describe("a brand logo is not certificate artwork", () => {
  it("refuses a brand-logo document at the certificate design door", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const tag = Math.random().toString(36).slice(2, 8);
    const key = `prune-${tag}`;
    await h.deps.credentialUseCases.create({
      key, name: "Prune Programme",
      credentialTypes: [{
        name: "CourseCompletion", title: "Course Completion", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
        certificate: { enabled: true },
      }],
      issuer: { kind: "org", orgId: a.id },
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      ownerOrgId: a.id,
    } as never);

    const up = await upload(h, a.id, a.token);
    expect(up.statusCode).toBe(201);
    const logo = up.json();

    const pinned = await h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${key}/certificate`, headers: auth(a.token),
      payload: { credentialType: "CourseCompletion", background: { documentId: logo.id, sha256: logo.sha256 } },
    });
    expect(pinned.statusCode).toBe(400);
    expect(pinned.json().error).toBe("BACKGROUND_IS_BRAND_LOGO");
  });

  it("still accepts artwork uploaded through the artwork door", async () => {
    // The refusal must bite brand logos and nothing else — artwork uploaded the
    // ordinary way carries `purpose: null` and is unaffected.
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const tag = Math.random().toString(36).slice(2, 8);
    const key = `prune-ok-${tag}`;
    await h.deps.credentialUseCases.create({
      key, name: "Prune Programme",
      credentialTypes: [{
        name: "CourseCompletion", title: "Course Completion", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
        certificate: { enabled: true },
      }],
      issuer: { kind: "org", orgId: a.id },
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      ownerOrgId: a.id,
    } as never);

    const art = await h.deps.documents.create({ contentType: "image/png", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: a.id, purpose: null });
    const pinned = await h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${key}/certificate`, headers: auth(a.token),
      payload: { credentialType: "CourseCompletion", background: { documentId: art.id, sha256: art.sha256 } },
    });
    expect(pinned.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
"/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api/node_modules/.bin/vitest" run --root "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" test/org-branding-prune.test.ts
```

Expected: the first test FAILS — the pin currently succeeds with 200, so `expect(400)` fails. The second test should already pass.

If the design route answers 403 rather than 200/400, the OrgAdmin is not being read as the use case's owner: check that `ownerOrgId: a.id` was passed to `credentialUseCases.create`.

- [ ] **Step 3: Add the refusal**

In `apps/api/src/http/routes.ts`, inside `checkBackgroundDocument`, between the ownership check (ending line 1149) and the `isRenderableArtwork` check (line 1150), insert:

```ts
    // A MARK IS NOT ARTWORK, and this refusal is what makes the brand-logo prune
    // safe rather than merely plausible.
    //
    // `POST /orgs/{id}/branding/logo` stamps `purpose = "brand-logo"`, and
    // `brand-logo-prune.ts` deletes such a row once a newer upload supersedes it.
    // That is sound only while `Organization.brandLogoDocumentId` is the ONLY
    // reference that can exist to one. A certificate background is stored inside
    // `CredentialUseCase.credentialTypes` JSON, so a pin here would be invisible
    // to the prune's "is it still pinned" test and it would delete bytes a
    // certificate still draws. Closing the reference set by construction beats
    // scanning JSON for references, which is a completeness claim that rots the
    // next time someone adds a reference site.
    //
    // AFTER the ownership check, deliberately. Only a caller who already owns
    // these bytes reaches this line, so it discloses nothing an unauthorized
    // caller could use — the same reasoning that puts `BACKGROUND_NOT_AN_IMAGE`
    // below the ownership check rather than above it.
    //
    // The cost is that an org whose mark IS its letterhead uploads the file
    // twice, once at each door. The doors are already separate; a provable
    // invariant is worth two uploads.
    if (doc.purpose === "brand-logo") {
      return { error: "BACKGROUND_IS_BRAND_LOGO", message: `document '${documentId}' was uploaded as an organization brand logo and cannot be used as certificate artwork; upload it through POST /credential-use-cases/{key}/certificate/artwork instead` };
    }
```

- [ ] **Step 4: Document the code in the OpenAPI description**

In `apps/api/src/http/schemas.ts`, lines 1298-1299, extend the listed 400 codes:

```ts
      "alone is a guessable reference. Answers **400** `BACKGROUND_PIN_REQUIRED`, `BACKGROUND_DOCUMENT_NOT_FOUND`, " +
      "`BACKGROUND_DOCUMENT_MISMATCH`, `BACKGROUND_NOT_AN_IMAGE`, `BACKGROUND_IS_BRAND_LOGO` (a document uploaded " +
      "through `POST /orgs/{id}/branding/logo` is an organization's mark, not artwork — upload it again through the " +
      "artwork door) or `INVALID_CERTIFICATE_PLACEMENT` (which names the " +
```

- [ ] **Step 5: Run the test to verify it passes, plus the certificate suites**

```bash
"/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api/node_modules/.bin/vitest" run --root "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" test/org-branding-prune.test.ts test/certificate-org-design.test.ts test/certificate-artwork.test.ts test/certificate-preview.test.ts test/certificate-mirror.test.ts
```

Expected: PASS, all files. The certificate suites store artwork with `purpose: null`, so none of them should trip the new refusal — if one does, that suite is pinning a brand-logo document and the finding is real, not a test bug.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/org-branding-prune.test.ts
git commit -m "feat(api): a brand logo may not be pinned as certificate artwork

Certificate backgrounds live inside CredentialUseCase JSON, invisible to
any query asking whether a document is still referenced. Refusing the pin
makes Organization.brandLogoDocumentId the only reference that can exist
to a brand-logo row — which is what lets the next commit delete one."
```

---

### Task 3: the prune

**Files:**
- Create: `apps/api/src/brand-logo-prune.ts`
- Modify: `apps/api/src/http/routes.ts:3964-3998` (the upload route)
- Test: `apps/api/test/brand-logo-prune.test.ts` (unit), `apps/api/test/org-branding-prune.test.ts` (HTTP)

- [ ] **Step 1: Write the failing unit test**

Append to `apps/api/test/brand-logo-prune.test.ts`:

```ts
import { pruneSupersededBrandLogos } from "../src/brand-logo-prune.js";

describe("pruneSupersededBrandLogos", () => {
  it("deletes the org's other brand logos, sparing the new one and the pinned one", async () => {
    const docs = new MemoryDocumentRepository();
    const make = () => docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" as const });
    const pinned = await make();
    const abandoned = await make();
    const fresh = await make();

    const removed = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, pinned: pinned.id });

    expect(removed).toEqual([abandoned.id]);
    expect(await docs.get(abandoned.id)).toBeNull();
    // The two that must survive.
    expect(await docs.get(pinned.id)).not.toBeNull();
    expect(await docs.get(fresh.id)).not.toBeNull();
  });

  it("spares nothing but the new upload when the org has no logo pinned", async () => {
    const docs = new MemoryDocumentRepository();
    const make = () => docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" as const });
    const first = await make();
    const second = await make();

    const removed = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: second.id, pinned: null });

    expect(removed).toEqual([first.id]);
    expect(await docs.get(second.id)).not.toBeNull();
  });

  it("never touches another org's rows, or this org's non-brand-logo documents", async () => {
    const docs = new MemoryDocumentRepository();
    const mine = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    const fresh = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    const artwork = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: null });
    const theirs = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_b", purpose: "brand-logo" });

    const removed = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, pinned: null });

    expect(removed).toEqual([mine.id]);
    expect(await docs.get(artwork.id)).not.toBeNull();
    expect(await docs.get(theirs.id)).not.toBeNull();
  });

  it("is best-effort: one failing delete does not stop the others, and nothing throws", async () => {
    // The upload already succeeded by the time this runs. A repository hiccup
    // must not turn a stored logo into a 500 — the leak it leaves is bounded.
    const docs = new MemoryDocumentRepository();
    const doomed = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    const other = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    const fresh = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });

    const realRemove = docs.removeByOwnerPurpose.bind(docs);
    docs.removeByOwnerPurpose = async (id: string, ownerOrgId: string, purpose: "brand-logo") => {
      if (id === doomed.id) throw new Error("database is on fire");
      await realRemove(id, ownerOrgId, purpose);
    };

    const removed = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, pinned: null });

    expect(removed).toEqual([other.id]);
    expect(await docs.get(doomed.id)).not.toBeNull();
  });

  it("returns an empty list when listing itself fails", async () => {
    const docs = new MemoryDocumentRepository();
    const fresh = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    docs.listByOwnerPurpose = async () => { throw new Error("database is on fire"); };

    await expect(pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, pinned: null })).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
"/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api/node_modules/.bin/vitest" run --root "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" test/brand-logo-prune.test.ts
```

Expected: FAIL — `../src/brand-logo-prune.js` does not exist.

- [ ] **Step 3: Write the prune**

Create `apps/api/src/brand-logo-prune.ts`:

```ts
import type { DocumentRepository } from "./persistence/types.js";

/**
 * DELETE THE ORGANIZATION'S SUPERSEDED BRAND LOGOS.
 *
 * `POST /orgs/{id}/branding/logo` may store up to 5MB, and before this existed
 * every reconsidered pick left a row behind forever. There is no cap and no
 * scheduled sweep: each upload cleans up after the ones before it, so the steady
 * state is at most two rows per organization — the live mark and the one in
 * flight — with no threshold to tune and no cron to run.
 *
 * WHY DELETING IS SAFE HERE. Exactly one reference to a `purpose = "brand-logo"`
 * row can exist anywhere in the system:
 *
 *   1. Only the owning org can pin one. `PATCH /orgs/{id}/branding` requires
 *      `orgOwnsDocument(doc, id)`, so "is it pinned" is one organization's field,
 *      not a store-wide scan.
 *   2. Every caller-supplied document-id door refuses a brand-logo document,
 *      via the shared `brandLogoRefusal` predicate in `routes.ts`: the
 *      certificate-artwork pin (`checkBackgroundDocument`), a credential
 *      type's own `logoDocumentId` (both whole-definition doors, the
 *      template-save door and the provision path), and a staged invoice's
 *      `documentId`. Without ALL of these, a brand-logo id smuggled into any
 *      one of them would be invisible here and this function would delete
 *      bytes something else still draws or attaches. (Task 2 shipped only the
 *      first of these; code review after that commit found the other three —
 *      see the design doc's "The invariant that makes deletion safe" for the
 *      full list and why the first pass missed them.)
 *
 * Change any of these and this function becomes unsafe.
 *
 * BEST-EFFORT BY DESIGN. The upload has already succeeded when this runs; the
 * caller's bytes are stored and their intent is served. A repository failure
 * must not turn that into a 500, and what it leaves behind is one bounded row,
 * which the next upload collects. Returns the ids actually removed, for the
 * audit entry — empty when there was nothing to do or nothing could be done.
 *
 * CONCURRENCY. Two simultaneous uploads can each spare the other's row, and the
 * next upload collects both. The bound is "small", not "exactly two".
 */
export async function pruneSupersededBrandLogos(
  documents: DocumentRepository,
  orgId: string,
  keep: { justUploaded: string; pinned: string | null },
): Promise<string[]> {
  const removed: string[] = [];
  try {
    for (const row of await documents.listByOwnerPurpose(orgId, "brand-logo")) {
      if (row.id === keep.justUploaded || row.id === keep.pinned) continue;
      try {
        // The owner and purpose are passed again on the DELETE, not just the id:
        // the repository refuses a row that does not match both, so a bug here
        // cannot reach a KYB certificate or an invoice PDF.
        await documents.removeByOwnerPurpose(row.id, orgId, "brand-logo");
        removed.push(row.id);
      } catch {
        // One row that will not delete is not worth failing an upload over, and
        // it must not stop the rest of the sweep either.
      }
    }
  } catch {
    // Listing failed. The upload still stands; nothing was removed.
  }
  return removed;
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

```bash
"/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api/node_modules/.bin/vitest" run --root "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" test/brand-logo-prune.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing HTTP test**

Append to `apps/api/test/org-branding-prune.test.ts`:

```ts
const getDoc = (h: TestAppHandle, id: string) => h.deps.documents.get(id);

describe("POST /orgs/:id/branding/logo prunes superseded uploads", () => {
  it("a second upload deletes the unpinned first", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");

    const first = (await upload(h, a.id, a.token)).json();
    const second = (await upload(h, a.id, a.token)).json();

    expect(await getDoc(h, first.id)).toBeNull();
    // The one just uploaded must survive its own prune.
    expect(await getDoc(h, second.id)).not.toBeNull();
  });

  it("THE SAFETY PROPERTY: the pinned mark survives an upload", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");

    const live = (await upload(h, a.id, a.token)).json();
    expect((await patchBranding(h, a.id, a.token, { brandLogoDocumentId: live.id })).statusCode).toBe(200);

    // The admin reconsiders twice without applying either pick.
    const tryOne = (await upload(h, a.id, a.token)).json();
    const tryTwo = (await upload(h, a.id, a.token)).json();

    expect(await getDoc(h, live.id)).not.toBeNull();
    expect(await getDoc(h, tryOne.id)).toBeNull();
    expect(await getDoc(h, tryTwo.id)).not.toBeNull();

    // And the live mark is still served, which is the thing a user would notice.
    const served = await h.app.inject({ method: "GET", url: `${V1}/orgs/${a.id}/branding/logo`, headers: auth(a.token) });
    expect(served.statusCode).toBe(200);
  });

  it("is org-scoped: one org's upload leaves another's rows alone", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const b = await org(h, "Globex");

    const bLogo = (await upload(h, b.id, b.token)).json();
    await upload(h, a.id, a.token);
    await upload(h, a.id, a.token);

    expect(await getDoc(h, bLogo.id)).not.toBeNull();
  });

  it("a PlatformAdmin uploading on an org's behalf prunes THAT org's rows", async () => {
    // The document is stamped with the org being branded, not the caller's own
    // org, so the prune must follow the same owner — a PlatformAdmin's uploads
    // for Acme supersede Acme's rows.
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");

    const first = (await upload(h, a.id, admin)).json();
    const second = (await upload(h, a.id, admin)).json();

    expect(await getDoc(h, first.id)).toBeNull();
    expect(await getDoc(h, second.id)).not.toBeNull();
  });

  it("leaves documents from the other upload doors untouched", async () => {
    // The whole reason for the `purpose` column: an org's certificate artwork
    // and its invoice evidence are org-owned PNGs too, and a prune that counted
    // by owner alone would have deleted them.
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const artwork = await h.deps.documents.create({ contentType: "image/png", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: a.id, purpose: null });

    await upload(h, a.id, a.token);
    await upload(h, a.id, a.token);

    expect(await getDoc(h, artwork.id)).not.toBeNull();
  });

  it("records what it removed in the audit log", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const first = (await upload(h, a.id, a.token)).json();
    await upload(h, a.id, a.token);

    const entries = await h.audit.list();
    const pruned = entries.filter((e) => e.action === "brand-logo-pruned");
    expect(pruned).toHaveLength(1);
    expect(pruned[0]!.payload).toMatchObject({ orgId: a.id, removed: [first.id] });
  });

  it("writes no audit entry when there was nothing to prune", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await upload(h, a.id, a.token);

    const entries = await h.audit.list();
    expect(entries.filter((e) => e.action === "brand-logo-pruned")).toHaveLength(0);
  });
});
```

(`h.audit.list()` is the memory audit repository's reader — `api-keys.test.ts:700`
uses exactly this call.)

- [ ] **Step 6: Run it to verify it fails**

```bash
"/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api/node_modules/.bin/vitest" run --root "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" test/org-branding-prune.test.ts
```

Expected: the prune tests FAIL — the first upload is still present, so `toBeNull()` fails. The Task 2 tests still pass.

- [ ] **Step 7: Wire the prune into the upload route**

In `apps/api/src/http/routes.ts`, replace the last two lines of the
`POST /orgs/:id/branding/logo` handler (lines 3996-3997, the
`storeUploadedDocument` call and the `return reply.code(201)`) with:

```ts
    const doc = await storeUploadedDocument(deps.documents, b, id, "brand-logo");

    // THE PRUNE RUNS AFTER THE STORE, NEVER BEFORE. The old mark is not dropped
    // until the new bytes are safely written — a prune-first ordering would, on
    // a failed upload, leave the org with no logo at all.
    //
    // `brandLogoDocumentId` is RE-READ here rather than taken from the `org`
    // fetched at the top of the handler: the upload of a multi-megabyte body sits
    // between the two, and a mark pinned during that window must not be deleted
    // by this call.
    const fresh = await deps.organizations.get(id);
    const removed = await pruneSupersededBrandLogos(deps.documents, id, {
      justUploaded: doc.id,
      pinned: fresh?.brandLogoDocumentId ?? null,
    });
    // Only when something actually went, so the log records deletions rather
    // than every upload.
    if (removed.length) {
      await deps.audit.append({
        actorId: claims.id,
        action: "brand-logo-pruned" as LifecycleAction,
        payload: { orgId: id, removed, kept: doc.id, pinned: fresh?.brandLogoDocumentId ?? null },
      });
    }
    return reply.code(201).send(doc);
```

Add the import near the other local imports at the top of `routes.ts`:

```ts
import { pruneSupersededBrandLogos } from "../brand-logo-prune.js";
```

- [ ] **Step 8: Run the HTTP tests to verify they pass**

```bash
"/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api/node_modules/.bin/vitest" run --root "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" test/org-branding-prune.test.ts test/brand-logo-prune.test.ts test/org-branding-upload.test.ts test/org-branding-route.test.ts test/org-branding-logo-read.test.ts test/org-branding-certificate.test.ts test/org-branding-repo.test.ts
```

Expected: PASS, all files.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/brand-logo-prune.ts apps/api/src/http/routes.ts apps/api/test/brand-logo-prune.test.ts apps/api/test/org-branding-prune.test.ts
git commit -m "feat(api): each brand-logo upload prunes the ones it supersedes

Bounds an org's brand-logo storage at the live mark plus the one in
flight, with no cap to hit and no sweep to schedule. Runs after the store
so a failed upload never leaves an org unbranded, re-reads the pinned id
so a mark applied during the upload window survives, and is best-effort
because the bytes are already stored by the time it runs."
```

---

### Task 4: OpenAPI snapshot and the full suite

**Files:**
- Modify: whatever `npm run openapi:snapshot` writes (the committed snapshot under `apps/api`)

- [ ] **Step 1: Regenerate the snapshot**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" && npm run openapi:snapshot
```

- [ ] **Step 2: Read the diff and confirm it is only what was intended**

```bash
git -C "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27" diff --stat && git -C "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27" diff
```

Expected: the only change is the `BACKGROUND_IS_BRAND_LOGO` sentence added to
the `PATCH /credential-use-cases/{key}/certificate` description. The
201 response of `POST /orgs/{id}/branding/logo` is unchanged — `purpose` was
deliberately not added to it. **Anything else in the diff is a mistake to
investigate, not to commit.**

- [ ] **Step 3: Run the whole API suite**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27/apps/api" && "./node_modules/.bin/vitest" run
```

Expected: all tests pass. Pay particular attention to `openapi-snapshot.test.ts`,
`openapi-contract.test.ts` and `openapi-visibility.test.ts` — those compare
against the regenerated file.

- [ ] **Step 4: Typecheck the workspace**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/.claude/worktrees/wizardly-robinson-741b27" && npm run build --workspaces --if-present
```

Expected: no errors. If `apps/web` fails, check whether it calls
`documents.create` — the grep in Task 1 found no web call site, so it should not.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(api): openapi snapshot for BACKGROUND_IS_BRAND_LOGO"
```

---

## Out of scope, deliberately

Recorded so a later reader does not mistake these for oversights. All three are
argued in the spec:

- **No cap or quota**, and no `BRAND_LOGO_QUOTA_EXCEEDED` error. Storage is
  bounded by organization count rather than request count once the prune exists,
  so a cap would be a wall with nothing behind it.
- **No dedicated rate limit** on the upload route beyond the generic one, for the
  same reason.
- **No sweep, cron, or admin route.**

Two residuals ship knowingly: an org that uploads exactly once and abandons it
keeps that row forever (≤5 MB, not unbounded), and pre-existing rows carry
`purpose = null` so they are never listed and never pruned — there is no honest
way to guess what a legacy row was for.
