# KYC Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the platform's flat, admin-attested, one-click KYC with holder self-service submission (richer fields + real document upload), maker-checker review, and risk tiering + expiry.

**Architecture:** `KycDetails` (already a JSON blob on `User.kyc` — no schema migration) grows new optional fields. Two new self-service routes (`POST /users/me/kyc/documents`, `POST /users/me/kyc/submit`) let a holder submit their own application. A new `kyc-decision` proposal kind — following the exact maker-checker pattern already used for org-capability changes and credential issuance — replaces the one-click `PATCH /users/:id { kycStatus }` path. The web side adds a self-service panel to My Profile and an inline review panel to the existing User Management roster, mirroring that file's own `VerifyIdentityPanel` pattern exactly.

**Tech Stack:** Fastify, Prisma (SQLite, JSON-blob column — no migration needed), TypeScript, React, vitest.

**Spec:** [docs/superpowers/specs/2026-09-05-kyc-enhancement-design.md](../specs/2026-09-05-kyc-enhancement-design.md)

## Global Constraints

- `KycDetails` lives in `apps/api/src/persistence/types/shared.ts` — there is no shared type package; `apps/web/src/api.ts` and `apps/web/src/components/shared/UserManagement.tsx` each hand-duplicate their own copy of the shape (existing pattern in this codebase — not something to fix here).
- `User.kyc` is a Prisma `String?` column holding `JSON.stringify(KycDetails)` — adding optional fields to the TypeScript interface requires **no** Prisma schema change and **no** migration.
- New routes (`/users/me/kyc/*`, `/users/:id/kyc/decision`) need **no new entry** in `apps/api/src/http/route-domains.ts` — the existing `["/users", "shared"]` catch-all rule already classifies them correctly (verified: no more-specific `/users/:id/kyc*` or `/users/me/kyc*` prefix rule exists to shadow it).
- `POST /orgs/:id/approve` is this codebase's reference pattern for a PlatformAdmin-only, machine-principal-refused governance route — mirror its exact shape (`machinePrincipal` check, then `claims.role !== "PlatformAdmin"` check) rather than `authScoped(...)`.
- `apps/api/src/shared/org-kinds.ts`'s `orgCapabilityChangeKind` is this codebase's reference pattern for a PlatformAdmin-only proposal kind (`apiScope: null`, `canApprove: PlatformAdmin-only`) — mirror its exact shape for the new `kyc-decision` kind.
- `SELF_APPROVAL` (a proposer may not decide their own proposal) is enforced generically at the `/proposals/:id/approve` route level, not per-kind — the new kind gets this for free.
- Document access control for KYC documents is a **new, dedicated gate** (`doc.uploadedBy === caller.id || caller.role === "PlatformAdmin"`) — never reuse `canReadDoc`/the `"issue"` RBAC flag, which this codebase has already been burned by overloading once.
- `apps/web/src/components/shared/UserManagement.tsx`'s `VerifyIdentityPanel` (an inline-expanding `<tr>` row, toggled by a `useState<string|null>` holding the expanded row's user id) is the exact UI pattern to mirror for the new KYC review panel — not a separate page/route.
- Run `pnpm exec tsc --noEmit` in both `apps/api` and `apps/web` as an explicit verification step in every task that touches `src/` files in that package — a prior project in this codebase went 3 tasks with a broken build before anyone ran it, because `vitest run` alone (esbuild, no real type-checking) doesn't catch it.
- Run every test/typecheck/build command as a single, direct, blocking call with a generous explicit timeout (e.g. 400000ms for the full `apps/api` suite) — never `run_in_background`, and never assume a command finished within a tool's default timeout without checking its actual exit output.

---

### Task 1: Extend `KycDetails` with the new fields

**Files:**
- Modify: `apps/api/src/persistence/types/shared.ts` (the `KycDetails` interface)
- Modify: `apps/web/src/api.ts` (the inline `kyc` shape in `users()`'s return type)
- Modify: `apps/web/src/components/shared/UserManagement.tsx` (the `Summary` type's inline `kyc` shape)

**Interfaces:**
- Produces: `KycDetails` gains `dateOfBirth?: string`, `address?: { street: string; city: string; postalCode: string }`, `occupation?: string`, `sourceOfFunds?: string`, `pepDeclaration?: boolean`, `idDocument?: { id: string; sha256: string } | null`, `addressDocument?: { id: string; sha256: string } | null`, `riskTier?: "low" | "medium" | "high" | null`, `expiresAt?: string | null`, `rejectionReason?: string | null`. All later tasks read/write these exact field names.

- [ ] **Step 1: Extend the backend type**

In `apps/api/src/persistence/types/shared.ts`, replace the `KycDetails` interface:

```typescript
export interface KycDetails {
  legalName?: string;
  country?: string;
  idType?: string;
  idNumber?: string;
  documentRef?: string;
  issuerDid?: string;
  credentialId?: string;
  verifiedAt?: string;
  revokedAt?: string;
  revokeReason?: string;
  /** ISO date. */
  dateOfBirth?: string;
  address?: { street: string; city: string; postalCode: string };
  occupation?: string;
  sourceOfFunds?: string;
  /** Self-declared, not automated screening. */
  pepDeclaration?: boolean;
  idDocument?: { id: string; sha256: string } | null;
  addressDocument?: { id: string; sha256: string } | null;
  /** Set by the reviewer on approval. */
  riskTier?: "low" | "medium" | "high" | null;
  /** ISO date; null = grandfathered under the old rules, never expires. */
  expiresAt?: string | null;
  /** Set by the reviewer on rejection. */
  rejectionReason?: string | null;
}
```

- [ ] **Step 2: Typecheck the backend**

Run: `cd "apps/api" && pnpm exec tsc --noEmit`
Expected: no errors (every field is optional, so no existing code that builds a `KycDetails` object needs to change).

- [ ] **Step 3: Extend the two web type duplicates**

In `apps/web/src/api.ts`, find the `users:` entry (search for `kycStatus: "pending" | "approved" | "rejected"`) and replace its inline `kyc` object type:

```typescript
  users: (token: string) => request<{ id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null; active: boolean; kycStatus: "pending" | "approved" | "rejected"; kyc: {
    legalName?: string; country?: string; idType?: string; idNumber?: string; documentRef?: string;
    dateOfBirth?: string; address?: { street: string; city: string; postalCode: string }; occupation?: string; sourceOfFunds?: string; pepDeclaration?: boolean;
    idDocument?: { id: string; sha256: string } | null; addressDocument?: { id: string; sha256: string } | null;
    riskTier?: "low" | "medium" | "high" | null; expiresAt?: string | null; rejectionReason?: string | null;
  } | null; did: string | null }[]>("/users", token),
```

In `apps/web/src/components/shared/UserManagement.tsx`, replace the `Summary` type's `kyc` field with the identical shape (same object literal as above, substituted into the existing `type Summary = { ...; kyc: { ... } | null; ... }` line).

- [ ] **Step 4: Typecheck the web app**

Run: `cd "apps/web" && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/persistence/types/shared.ts apps/web/src/api.ts apps/web/src/components/shared/UserManagement.tsx
git commit -m "feat(kyc): extend KycDetails with the richer field set"
```

---

### Task 2: KYC document upload + dedicated read gate

**Files:**
- Modify: `apps/api/src/http/routes/shared.ts` (two new routes)
- Modify: `apps/api/src/http/schemas/shared.ts` (two new schemas)
- Test: `apps/api/test/kyc-documents.test.ts`

**Interfaces:**
- Consumes: `storeUploadedDocument` (existing, `apps/api/src/http/routes/common.ts`), `deps.documents` (existing `DocumentRepository`).
- Produces: `POST /users/me/kyc/documents` (any authenticated human), a dedicated document-read route `GET /users/me/kyc/documents/:id` gated to `uploadedBy === caller.id || caller.role === "PlatformAdmin"`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/kyc-documents.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

describe("KYC document upload and read gate", () => {
  it("an authenticated human can upload and then read back their own KYC document", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(buyer),
      payload: { contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 fake id doc").toString("base64") },
    });
    expect(upload.statusCode).toBe(201);
    const docId = upload.json().id as string;
    const read = await h.app.inject({ method: "GET", url: `${V1}/users/me/kyc/documents/${docId}`, headers: auth(buyer) });
    expect(read.statusCode).toBe(200);
    expect(read.payload).toContain("fake id doc");
  });

  it("a different non-admin user cannot read someone else's KYC document", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const other = await loginAs(h.app, "carbon.issuer@tokenlayer.dev", "carbon123");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(buyer),
      payload: { contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 private").toString("base64") },
    });
    const docId = upload.json().id as string;
    const read = await h.app.inject({ method: "GET", url: `${V1}/users/me/kyc/documents/${docId}`, headers: auth(other) });
    expect(read.statusCode).toBe(403);
  });

  it("a PlatformAdmin can read any KYC document", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(buyer),
      payload: { contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 reviewable").toString("base64") },
    });
    const docId = upload.json().id as string;
    const read = await h.app.inject({ method: "GET", url: `${V1}/users/me/kyc/documents/${docId}`, headers: auth(admin) });
    expect(read.statusCode).toBe(200);
  });

  it("a machine principal cannot upload a KYC document (no self to submit for)", async () => {
    const h = await buildTestAppWithRepos();
    // Real API-key minting path: an org, then POST /orgs/:id/api-keys — mirrors
    // apps/api/test/api-keys.test.ts's own makeOrg/mintKey helpers, reproduced
    // inline here since they're not exported from that file.
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await h.app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `KYC Doc Test Org ${Date.now()}`, orgType: "corporate" } });
    expect(org.statusCode).toBe(201);
    const orgId = org.json().id as string;
    const key = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(admin),
      payload: { name: "kyc-doc-test-key", role: "Issuer", scopes: ["users:onboard"] },
    });
    expect(key.statusCode).toBe(201);
    const secret = key.json().secret as string;
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/documents`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { contentType: "application/pdf", dataBase64: Buffer.from("x").toString("base64") },
    });
    expect(upload.statusCode).toBe(403);
    expect(upload.json().error).toBe("MACHINE_PRINCIPAL");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/kyc-documents.test.ts`
Expected: FAIL — 404s (routes don't exist yet).

- [ ] **Step 3: Add the schemas**

In `apps/api/src/http/schemas/shared.ts`, add to `sharedSchemas`:

```typescript
  uploadKycDocument: {
    tags: ["Users"],
    summary: "Upload a KYC document (ID or address proof) for the caller's own submission",
    security: humanOnly,
    body: { type: "object", required: ["contentType", "dataBase64"], properties: { contentType: { type: "string" }, dataBase64: { type: "string" } } },
    response: { 201: { type: "object", properties: { id: { type: "string" }, sha256: { type: "string" }, size: { type: "number" } } }, ...errs(400, 401, 403, 413, 415) },
  },
  getKycDocument: {
    tags: ["Users"],
    summary: "Read a KYC document — the uploader themselves, or a PlatformAdmin",
    security: humanOnly,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { ...errs(401, 403, 404) },
  },
```

- [ ] **Step 4: Add the routes**

In `apps/api/src/http/routes/shared.ts`, add the two routes near the existing `/documents/:id` route (search for `app.get("/documents/:id"`, add these right after its closing `});`):

```typescript
  app.post("/users/me/kyc/documents", { schema: S.uploadKycDocument, ...auth }, async (request, reply) => {
    if (machinePrincipal(request)) return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key has no self to submit KYC for" });
    const claims = request.user as TokenClaims;
    const doc = await storeUploadedDocument(deps.documents, request.body as { contentType: string; dataBase64: string }, null, null, claims.id);
    return reply.code(201).send({ id: doc.id, sha256: doc.sha256, size: doc.size });
  });

  app.get("/users/me/kyc/documents/:id", { schema: S.getKycDocument, ...auth }, async (request, reply) => {
    if (machinePrincipal(request)) return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key has no KYC documents of its own" });
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const doc = await deps.documents.get(id);
    if (!doc) return notFound(reply, "document not found");
    // A dedicated gate — deliberately NOT canReadDoc/the "issue" RBAC flag,
    // which this codebase has already been burned by overloading once.
    if (doc.uploadedBy !== claims.id && claims.role !== "PlatformAdmin") {
      return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to read that document" });
    }
    return reply
      .header("content-type", doc.contentType)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename="kyc-document-${id}"`)
      .send(doc.bytes);
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd "apps/api" && pnpm exec vitest run test/kyc-documents.test.ts`
Expected: PASS (4 tests). If the `POST /api-keys` fixture in Step 1 needed adjusting against the real API, re-run after fixing it.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `cd "apps/api" && pnpm exec tsc --noEmit`
Expected: clean.

Run: `cd "apps/api" && pnpm exec vitest run`
Expected: all passing (no regressions).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/routes/shared.ts apps/api/src/http/schemas/shared.ts apps/api/test/kyc-documents.test.ts
git commit -m "feat(kyc): add self-service KYC document upload and a dedicated read gate"
```

---

### Task 3: Self-service KYC submission endpoint

**Files:**
- Modify: `apps/api/src/http/routes/shared.ts` (one new route)
- Modify: `apps/api/src/http/schemas/shared.ts` (one new schema)
- Test: `apps/api/test/kyc-submission.test.ts`

**Interfaces:**
- Consumes: `deps.documents.get`, `deps.users.update` (existing).
- Produces: `POST /users/me/kyc/submit` — sets `kycStatus: "pending"` and the caller's `kyc` field.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/kyc-submission.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

async function uploadDoc(app: import("fastify").FastifyInstance, token: string, label: string) {
  const res = await app.inject({
    method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(token),
    payload: { contentType: "application/pdf", dataBase64: Buffer.from(`%PDF-1.4 ${label}`).toString("base64") },
  });
  return res.json().id as string;
}

const SUBMISSION = {
  legalName: "Test Holder", country: "IN", idType: "passport", idNumber: "P1234567",
  dateOfBirth: "1990-01-01", address: { street: "1 Main St", city: "Mumbai", postalCode: "400001" },
  occupation: "Engineer", sourceOfFunds: "Salary", pepDeclaration: false,
};

describe("self-service KYC submission", () => {
  it("submitting sets kycStatus pending and stores the full field set plus both documents", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const idDocId = await uploadDoc(h.app, buyer, "id");
    const addressDocId = await uploadDoc(h.app, buyer, "address");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(buyer),
      payload: { ...SUBMISSION, idDocumentId: idDocId, addressDocumentId: addressDocId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kycStatus).toBe("pending");
    const list = await h.app.inject({ method: "GET", url: `${V1}/users`, headers: auth(await loginAs(h.app, "admin@tokenlayer.dev", "admin123")) });
    const row = (list.json() as { email: string; kycStatus: string; kyc: Record<string, unknown> }[]).find((u) => u.email === "carbon.buyer@tokenlayer.dev");
    expect(row?.kycStatus).toBe("pending");
    expect(row?.kyc?.legalName).toBe("Test Holder");
    expect((row?.kyc?.idDocument as { id: string }).id).toBe(idDocId);
  });

  it("rejects a submission referencing a document uploaded by someone else", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const other = await loginAs(h.app, "carbon.issuer@tokenlayer.dev", "carbon123");
    const idDocId = await uploadDoc(h.app, other, "not-yours");
    const addressDocId = await uploadDoc(h.app, buyer, "address");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(buyer),
      payload: { ...SUBMISSION, idDocumentId: idDocId, addressDocumentId: addressDocId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("DOCUMENT_NOT_YOURS");
  });

  it("rejects a submission missing a required document", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const addressDocId = await uploadDoc(h.app, buyer, "address");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(buyer),
      payload: { ...SUBMISSION, addressDocumentId: addressDocId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a re-submission after rejection works the same way", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    await h.users.update(user!.id, { kycStatus: "rejected", kyc: { ...SUBMISSION, rejectionReason: "blurry document" } });
    const idDocId = await uploadDoc(h.app, buyer, "id-2");
    const addressDocId = await uploadDoc(h.app, buyer, "address-2");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(buyer),
      payload: { ...SUBMISSION, idDocumentId: idDocId, addressDocumentId: addressDocId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kycStatus).toBe("pending");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/kyc-submission.test.ts`
Expected: FAIL — 404 (route doesn't exist yet).

- [ ] **Step 3: Add the schema**

In `apps/api/src/http/schemas/shared.ts`, add:

```typescript
  submitKyc: {
    tags: ["Users"],
    summary: "Submit (or re-submit) the caller's own KYC application",
    security: humanOnly,
    body: {
      type: "object",
      required: ["legalName", "country", "idType", "idNumber", "idDocumentId", "addressDocumentId"],
      properties: {
        legalName: { type: "string" }, country: { type: "string" }, idType: { type: "string" }, idNumber: { type: "string" },
        dateOfBirth: { type: "string" },
        address: { type: "object", properties: { street: { type: "string" }, city: { type: "string" }, postalCode: { type: "string" } } },
        occupation: { type: "string" }, sourceOfFunds: { type: "string" }, pepDeclaration: { type: "boolean" },
        idDocumentId: { type: "string" }, addressDocumentId: { type: "string" },
      },
    },
    response: { 200: { type: "object", properties: { id: { type: "string" }, kycStatus: { type: "string" } } }, ...errs(400, 401, 403) },
  },
```

- [ ] **Step 4: Add the route**

In `apps/api/src/http/routes/shared.ts`, add right after the `POST /users/me/kyc/documents` / `GET .../:id` routes from Task 2:

```typescript
  app.post("/users/me/kyc/submit", { schema: S.submitKyc, ...auth }, async (request, reply) => {
    if (machinePrincipal(request)) return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key has no self to submit KYC for" });
    const claims = request.user as TokenClaims;
    const b = request.body as {
      legalName: string; country: string; idType: string; idNumber: string;
      dateOfBirth?: string; address?: { street: string; city: string; postalCode: string };
      occupation?: string; sourceOfFunds?: string; pepDeclaration?: boolean;
      idDocumentId: string; addressDocumentId: string;
    };
    const idDoc = await deps.documents.get(b.idDocumentId);
    const addressDoc = await deps.documents.get(b.addressDocumentId);
    if (!idDoc || !addressDoc) return reply.code(400).send({ error: "DOCUMENT_NOT_FOUND", message: "one or both documents were not found" });
    if (idDoc.uploadedBy !== claims.id || addressDoc.uploadedBy !== claims.id) {
      return reply.code(400).send({ error: "DOCUMENT_NOT_YOURS", message: "both documents must have been uploaded by you" });
    }
    const kyc: KycDetails = {
      legalName: b.legalName, country: b.country, idType: b.idType, idNumber: b.idNumber,
      dateOfBirth: b.dateOfBirth, address: b.address, occupation: b.occupation, sourceOfFunds: b.sourceOfFunds,
      pepDeclaration: b.pepDeclaration ?? false,
      idDocument: { id: idDoc.id, sha256: idDoc.sha256 }, addressDocument: { id: addressDoc.id, sha256: addressDoc.sha256 },
      // A fresh submission clears any stale decision from a prior round.
      riskTier: null, expiresAt: null, rejectionReason: null,
    };
    const updated = await deps.users.update(claims.id, { kycStatus: "pending", kyc });
    return reply.code(200).send({ id: updated.id, kycStatus: updated.kycStatus });
  });
```

Confirm `KycDetails` is already imported in this file (it is, per the existing `PATCH /users/:id` handler's usage) — if the import list needs the new type re-exported from the same module, no change is needed since it's the same interface, just with more optional fields (Task 1).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd "apps/api" && pnpm exec vitest run test/kyc-submission.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck and run the full suite**

Run: `cd "apps/api" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/routes/shared.ts apps/api/src/http/schemas/shared.ts apps/api/test/kyc-submission.test.ts
git commit -m "feat(kyc): add self-service KYC submission"
```

---

### Task 4: `kyc-decision` maker-checker proposal kind

**Files:**
- Create: `apps/api/src/shared/kyc-kinds.ts`
- Modify: `apps/api/src/shared/proposal-kinds.ts` (register the new kind)
- Modify: `apps/api/src/http/routes/shared.ts` (the propose route)
- Modify: `apps/api/src/http/schemas/shared.ts` (the propose route's schema)
- Modify: `apps/api/src/mail/templates.ts` (extend `kycDecisionEmail` with an optional rejection reason)
- Test: `apps/api/test/kyc-decision.test.ts`

**Interfaces:**
- Consumes: `ProposalKindHandler`, `registerProposalKind` (`apps/api/src/shared/proposal-kinds.ts`), `createProposalAndNotify` (`apps/api/src/shared/proposal-notify.ts`, from the email-integration branch), `kycDecisionEmail` (`apps/api/src/mail/templates.ts`).
- Produces: proposal kind `"kyc-decision"` with payload `{ userId: string; decision: "approved" | "rejected"; riskTier?: "low" | "medium" | "high"; rejectionReason?: string }`; route `POST /users/:id/kyc/decision`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/kyc-decision.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, PLATFORM_ADMIN_2, V1 } from "./helpers.js";

async function submitPendingKyc(app: import("fastify").FastifyInstance, token: string): Promise<void> {
  const up1 = await app.inject({ method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(token), payload: { contentType: "application/pdf", dataBase64: Buffer.from("id").toString("base64") } });
  const up2 = await app.inject({ method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(token), payload: { contentType: "application/pdf", dataBase64: Buffer.from("addr").toString("base64") } });
  const res = await app.inject({
    method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(token),
    payload: { legalName: "T H", country: "IN", idType: "passport", idNumber: "P1", idDocumentId: up1.json().id, addressDocumentId: up2.json().id },
  });
  expect(res.statusCode).toBe(200);
}

describe("kyc-decision proposal kind", () => {
  it("propose approve, then a second PlatformAdmin approves: sets approved + riskTier + a ~1-year expiresAt", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    await submitPendingKyc(h.app, buyer);
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    const draft = await h.app.inject({
      method: "POST", url: `${V1}/users/${user!.id}/kyc/decision`, headers: auth(platform),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(draft.statusCode).toBe(202);
    const approve = await h.app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(checker), payload: {} });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().proposal.status).toBe("executed");
    const updated = await h.users.findById(user!.id);
    expect(updated!.kycStatus).toBe("approved");
    expect(updated!.kyc!.riskTier).toBe("low");
    const expiresAt = new Date(updated!.kyc!.expiresAt!);
    const daysOut = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(daysOut).toBeGreaterThan(360);
    expect(daysOut).toBeLessThan(370);
  });

  it("propose reject with a reason: sets rejected + rejectionReason, no expiresAt", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    await submitPendingKyc(h.app, buyer);
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    const draft = await h.app.inject({
      method: "POST", url: `${V1}/users/${user!.id}/kyc/decision`, headers: auth(platform),
      payload: { decision: "rejected", rejectionReason: "ID document illegible" },
    });
    expect(draft.statusCode).toBe(202);
    await h.app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(checker), payload: {} });
    const updated = await h.users.findById(user!.id);
    expect(updated!.kycStatus).toBe("rejected");
    expect(updated!.kyc!.rejectionReason).toBe("ID document illegible");
    expect(updated!.kyc!.expiresAt).toBeFalsy();
  });

  it("a non-PlatformAdmin cannot propose a KYC decision", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const nonAdmin = await loginAs(h.app, "carbon.issuer@tokenlayer.dev", "carbon123");
    await submitPendingKyc(h.app, buyer);
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/${user!.id}/kyc/decision`, headers: auth(nonAdmin),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("the proposing admin cannot also approve their own proposal (SELF_APPROVAL)", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await submitPendingKyc(h.app, buyer);
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    const draft = await h.app.inject({
      method: "POST", url: `${V1}/users/${user!.id}/kyc/decision`, headers: auth(platform),
      payload: { decision: "approved", riskTier: "low" },
    });
    const selfApprove = await h.app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(platform), payload: {} });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().error).toBe("SELF_APPROVAL");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/kyc-decision.test.ts`
Expected: FAIL — 404 (route doesn't exist yet).

- [ ] **Step 3: Extend `kycDecisionEmail` with an optional rejection reason**

In `apps/api/src/mail/templates.ts`, replace `kycDecisionEmail`:

```typescript
export function kycDecisionEmail(a: { decision: "approved" | "rejected"; rejectionReason?: string }): EmailContent {
  const verb = a.decision === "approved" ? "approved" : "rejected";
  const reasonLine = a.decision === "rejected" && a.rejectionReason ? `\n\nReason: ${a.rejectionReason}` : "";
  const text = `Your KYC verification was ${verb}.${reasonLine}`;
  const htmlParts = [esc(`Your KYC verification was ${verb}.`)];
  if (a.decision === "rejected" && a.rejectionReason) htmlParts.push(`Reason: ${esc(a.rejectionReason)}`);
  return { subject: `Your KYC verification was ${verb}`, text, html: wrap(htmlParts) };
}
```

(`esc`/`wrap` already exist in this file from the email-integration branch — confirm both are still defined above this function before editing.)

- [ ] **Step 4: Write the proposal kind**

Create `apps/api/src/shared/kyc-kinds.ts`:

```typescript
/**
 * KYC decision proposal kind (maker-checker replacement for the old one-click
 * `PATCH /users/:id { kycStatus }`). PlatformAdmin-only on both sides — a KYC
 * decision is platform governance, not org- or use-case-scoped, so this
 * mirrors org-kinds.ts's orgCapabilityChangeKind exactly: no API-key approval
 * (a machine principal cannot decide someone's identity verification), and
 * `canApprove` narrower than a generic "who may see proposals" rule would give.
 */
import type { LifecycleAction } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import { coded } from "./executors.js";
import type { TokenClaims } from "../http/support.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "../persistence/types/index.js";
import { kycDecisionEmail } from "../mail/templates.js";

const platformOnlyView = async (_deps: AppDeps, claims: TokenClaims, _p: ProposalRecord): Promise<boolean> => claims.role === "PlatformAdmin";

export interface KycDecisionPayload {
  userId: string;
  decision: "approved" | "rejected";
  riskTier?: "low" | "medium" | "high";
  rejectionReason?: string;
}

const KYC_VALIDITY_DAYS = 365;

export const kycDecisionKind: ProposalKindHandler = {
  kind: "kyc-decision",
  apiScope: null,
  canView: platformOnlyView,
  canApprove: platformOnlyView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as KycDecisionPayload;
    const target = await ctx.deps.users.findById(pl.userId);
    if (!target) throw coded(404, "NOT_FOUND", "user missing");
    // Re-check at execution time: the submission may have been withdrawn or
    // re-submitted between propose and approve.
    if (target.kycStatus !== "pending") throw coded(409, "NOT_PENDING", `user's KYC is ${target.kycStatus}, not pending`);
    const kyc = target.kyc ?? {};
    if (pl.decision === "approved") {
      const expiresAt = new Date(Date.now() + KYC_VALIDITY_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await ctx.deps.users.update(target.id, { kycStatus: "approved", kyc: { ...kyc, riskTier: pl.riskTier ?? null, expiresAt, rejectionReason: null } });
    } else {
      await ctx.deps.users.update(target.id, { kycStatus: "rejected", kyc: { ...kyc, rejectionReason: pl.rejectionReason ?? null, riskTier: null, expiresAt: null } });
    }
    await ctx.deps.audit.append({ actorId: p.proposerId, action: "kyc-verified" as LifecycleAction, payload: { userId: target.id, decision: pl.decision, riskTier: pl.riskTier ?? null } });
    const notice = kycDecisionEmail({ decision: pl.decision, rejectionReason: pl.rejectionReason });
    await ctx.deps.mail.send(target.email, notice.subject, notice.text, notice.html).catch((err) => ctx.log.error({ err, userId: target.id }, "[mail] kyc-decision send failed"));
  },
};
```

- [ ] **Step 5: Register the kind**

In `apps/api/src/shared/proposal-kinds.ts`, add the import and registration:

```typescript
import { kycDecisionKind } from "./kyc-kinds.js";
```

and, alongside the other `registerProposalKind(...)` calls:

```typescript
registerProposalKind(kycDecisionKind);
```

- [ ] **Step 6: Add the schema and route**

In `apps/api/src/http/schemas/shared.ts`, add:

```typescript
  proposeKycDecision: {
    tags: ["Users"],
    summary: "Propose a KYC decision (maker-checker) — PlatformAdmin only",
    security: humanOnly,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object",
      required: ["decision"],
      properties: { decision: { type: "string", enum: ["approved", "rejected"] }, riskTier: { type: "string", enum: ["low", "medium", "high"] }, rejectionReason: { type: "string" } },
    },
    response: { 202: { type: "object", additionalProperties: true } , ...errs(400, 401, 403, 404, 409) },
  },
```

In `apps/api/src/http/routes/shared.ts`, add the import:

```typescript
import type { KycDecisionPayload } from "../../shared/kyc-kinds.js";
```

(merge into the existing multi-import from `"../../shared/kyc-kinds.js"` if a later task in this plan already added one — check the file first.)

Add the route right after the KYC submission route from Task 3:

```typescript
  app.post("/users/:id/kyc/decision", { schema: S.proposeKycDecision, ...auth }, async (request, reply) => {
    if (machinePrincipal(request)) return reply.code(403).send({ error: "MACHINE_PRINCIPAL", message: "an API key may not decide KYC" });
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may decide KYC" });
    const { id } = request.params as { id: string };
    const b = request.body as { decision: "approved" | "rejected"; riskTier?: "low" | "medium" | "high"; rejectionReason?: string };
    const target = await deps.users.findById(id);
    if (!target) return notFound(reply, "user not found");
    if (target.kycStatus !== "pending") return reply.code(409).send({ error: "NOT_PENDING", message: `user's KYC is ${target.kycStatus}, not pending` });
    if (b.decision === "rejected" && !b.rejectionReason) return reply.code(400).send({ error: "REASON_REQUIRED", message: "a rejection requires a reason" });
    const payload: KycDecisionPayload = { userId: id, decision: b.decision, riskTier: b.riskTier, rejectionReason: b.rejectionReason };
    const proposal = await createProposalAndNotify(deps, {
      useCaseKey: null, orgId: target.orgId ?? null, assetId: null, kind: "kyc-decision",
      payload: payload as unknown as Record<string, unknown>,
      proposerId: claims.id, proposerLabel: claims.email, required: 1,
    }, request.log);
    return reply.code(202).send({ proposal: proposalView(proposal) });
  });
```

`createProposalAndNotify` and `proposalView` are already imported/destructured in this file from the email-integration branch — confirm both names are in scope before adding the route (search the top of the file and the `const { ... } = ctx;` destructure).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd "apps/api" && pnpm exec vitest run test/kyc-decision.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Typecheck and run the full suite**

Run: `cd "apps/api" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: both clean. Also re-run `test/kyc-notification.test.ts` (from the email-integration branch) specifically — it exercises `kycDecisionEmail` and must still pass with the signature now taking an optional second field.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/shared/kyc-kinds.ts apps/api/src/shared/proposal-kinds.ts apps/api/src/http/routes/shared.ts apps/api/src/http/schemas/shared.ts apps/api/src/mail/templates.ts apps/api/test/kyc-decision.test.ts
git commit -m "feat(kyc): add the kyc-decision maker-checker proposal kind"
```

---

### Task 5: Remove the one-click `kycStatus` path from `PATCH /users/:id`

**Files:**
- Modify: `apps/api/src/http/routes/shared.ts`
- Modify: `apps/api/src/http/schemas/shared.ts`
- Test: `apps/api/test/kyc-notification.test.ts` (from the email-integration branch — one test needs replacing)

**Interfaces:**
- Produces: `PATCH /users/:id` no longer accepts `kycStatus`; sending it is a 400.

- [ ] **Step 1: Update the failing/changing test**

`apps/api/test/kyc-notification.test.ts` has a test named `"PATCH /users/:id with kycStatus emails the affected user"` that currently expects a 200. Replace it with:

```typescript
  it("PATCH /users/:id rejects a request that includes kycStatus (the one-click path is removed)", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    const email = `kyc-removed-${Date.now()}@x.com`;
    const created = await onboardUser(h.app, platform, checker, { email, password: "whatever-123", role: "Buyer", useCaseKey: "carbon-credit" });
    const res = await h.app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: auth(platform), payload: { kycStatus: "approved" } });
    expect(res.statusCode).toBe(400);
  });
```

The file's second test (`"PATCH /users/:id without a kycStatus field sends no KYC email"`) is unaffected and should be left as-is — it already never sent `kycStatus`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/kyc-notification.test.ts`
Expected: FAIL — the route currently returns 200, not 400.

- [ ] **Step 3: Update the schema**

In `apps/api/src/http/schemas/shared.ts`'s `updateUser` schema, remove `kycStatus` from `body.properties`:

```typescript
    body: {
      type: "object",
      properties: { password: { type: "string", minLength: 6 }, active: { type: "boolean" } },
    },
```

- [ ] **Step 4: Update the route handler**

In `apps/api/src/http/routes/shared.ts`'s `PATCH /users/:id` handler, replace the body-typing line and the whole kycStatus-handling block:

```typescript
    const b = request.body as { password?: string; active?: boolean; kycStatus?: unknown };
```

Right after the existing `const target = await deps.users.findById(id);` / `canAdministerUser` check, before building `patch`, add:

```typescript
    if (b.kycStatus !== undefined) {
      return reply.code(400).send({ error: "KYC_STATUS_NOT_PATCHABLE", message: "KYC decisions are made through POST /users/:id/kyc/decision (maker-checker), not this endpoint" });
    }
```

Then delete the entire `kycDecision`/`kycDecisionEmail` block this route used to contain (the `const kycDecision = ...`, `if (kycDecision) patch.kycStatus = kycDecision;`, and the `if (kycDecision) { const notice = kycDecisionEmail(...); ... }` block, plus the now-unused `kycDecisionEmail` import IF this file has no other user of it — check first, since Task 4 did NOT add a new import of `kycDecisionEmail` to this file, it stayed only in `kyc-kinds.ts`). Also remove `kycStatus?: KycStatus` from the `patch` object's type declaration, since it's never set here anymore.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd "apps/api" && pnpm exec vitest run test/kyc-notification.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Migrate every other test file that used the one-click PATCH as fixture setup**

Removing the one-click path breaks 5 other test files that never tested `PATCH /users/:id` itself — they used it purely to get a Buyer into `kycStatus: "approved"` state as setup for an unrelated test (a market purchase, a holder-acceptance flow, an identity-gate check). Each of these files imports `buildTestApp` (the app-only helper — `buildTestApp = (opts) => (await buildTestAppWithRepos(opts)).app`, confirmed in `helpers.ts`), which throws away the `users` repository handle the fixture needs. The mechanical fix at every site below is the same: swap the local `const app = await buildTestApp(...)` for `const { app, users } = await buildTestAppWithRepos(...)` (carrying over any options object unchanged), then replace the PATCH-based approval with a direct `await users.update(<id>, { kycStatus: "approved" });`. One site (`api.test.ts:974`) already uses `buildTestAppWithRepos` and already has `users` in scope — it only needs the PATCH replaced, no signature change.

**`apps/api/test/admin-issue-kyc.test.ts`** — one site, PATCH at line 56, `app` declared at line 41. Change the import line:
```typescript
import { buildTestApp, V1, loginAs, auth, onboardUser } from "./helpers.js";
```
to:
```typescript
import { buildTestApp, buildTestAppWithRepos, V1, loginAs, auth, onboardUser } from "./helpers.js";
```
Change:
```typescript
    const app = await buildTestApp();
```
to:
```typescript
    const { app, users } = await buildTestAppWithRepos();
```
Then change:
```typescript
    const patchRes = await app.inject({ method: "PATCH", url: `${V1}/users/${buyer.id}`, headers: auth(platform), payload: { kycStatus: "approved" } });
    expect(patchRes.statusCode).toBe(200);
```
to:
```typescript
    await users.update(buyer.id, { kycStatus: "approved" });
```

**`apps/api/test/holder-acceptance.test.ts`** — one site, PATCH at line 332, `app` declared at line 320. Change the import line:
```typescript
import { auth, buildTestApp, loginAs, onboardUser, V1 } from "./helpers.js";
```
to:
```typescript
import { auth, buildTestApp, buildTestAppWithRepos, loginAs, onboardUser, V1 } from "./helpers.js";
```
Then: `const app = await buildTestApp();` → `const { app, users } = await buildTestAppWithRepos();`, and replace:
```typescript
    const patchRes = await app.inject({ method: "PATCH", url: `${V1}/users/${buyer.id}`, headers: auth(platform), payload: { kycStatus: "approved" } });
    expect(patchRes.statusCode).toBe(200);
```
with:
```typescript
    await users.update(buyer.id, { kycStatus: "approved" });
```

**`apps/api/test/identity-gate.test.ts`** — two sites, each in its own test. Change the import line once (covers both sites):
```typescript
import { buildTestApp, V1, loginAs, auth, onboardUser } from "./helpers.js";
```
to:
```typescript
import { buildTestApp, buildTestAppWithRepos, V1, loginAs, auth, onboardUser } from "./helpers.js";
```
Then at both sites:
- PATCH at line 77, `app` declared at line 64.
- PATCH at line 132, `app` declared at line 122.

At each: `const app = await buildTestApp();` → `const { app, users } = await buildTestAppWithRepos();`, and replace:
```typescript
    const patchRes = await app.inject({ method: "PATCH", url: `${V1}/users/${buyer.id}`, headers: auth(platform), payload: { kycStatus: "approved" } });
    expect(patchRes.statusCode).toBe(200);
```
with:
```typescript
    await users.update(buyer.id, { kycStatus: "approved" });
```

**`apps/api/test/market.test.ts`** — three sites, all reachable only through the shared `setupMarket()` fixture and the `onboardBuyer()` helper it feeds. Add a new import line right after the existing `./helpers.js` import:
```typescript
import { buildTestApp, V1, loginAs, auth, onboardUser, treasuryAddressOf, TEST_MARKET_ESCROW } from "./helpers.js";
```
becomes:
```typescript
import { buildTestApp, buildTestAppWithRepos, V1, loginAs, auth, onboardUser, treasuryAddressOf, TEST_MARKET_ESCROW } from "./helpers.js";
import { MemoryUserRepository } from "../src/persistence/memory/index.js";
```

1. In `setupMarket()`, change:
```typescript
  const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
```
to:
```typescript
  const { app, users } = await buildTestAppWithRepos({ platformFeeAccount: FEE_ACCOUNT });
```
Then change its `b2` approval (currently `await app.inject({ method: "PATCH", url: \`${V1}/users/${b2.id}\`, headers: auth(carbonAdmin), payload: { kycStatus: "approved" } });`) to:
```typescript
  await users.update(b2.id, { kycStatus: "approved" });
```
Add `users` to `setupMarket()`'s return statement: `return { app, users, platform, carbonAdmin, seller, buyer2, assetId, treasury };`.

2. The `it("guards: over-take, own listing, unfunded buyer, over-list, and disabled market", ...)` test destructures `setupMarket()`'s result — change `const { app, platform, carbonAdmin, seller, buyer2, assetId } = await setupMarket();` to `const { app, users, platform, carbonAdmin, seller, buyer2, assetId } = await setupMarket();`, then change the `b3` approval (`await app.inject({ method: "PATCH", url: \`${V1}/users/${b3.id}\`, headers: auth(carbonAdmin), payload: { kycStatus: "approved" } });`) to:
```typescript
    await users.update(b3.id, { kycStatus: "approved" });
```

3. `onboardBuyer()`'s signature currently takes `ctx: { app: FastifyInstance; platform: string; carbonAdmin: string; assetId: string }`. Add `users: MemoryUserRepository` to that type, then destructure it (`const { app, users, platform, carbonAdmin, assetId } = ctx;`) and change its `u` approval (`await app.inject({ method: "PATCH", url: \`${V1}/users/${u.id}\`, headers: auth(carbonAdmin), payload: { kycStatus: "approved" } });`) to:
```typescript
  await users.update(u.id, { kycStatus: "approved" });
```
`onboardBuyer`'s two call sites (`onboardBuyer(ctx, ...)` at both call sites) already pass the whole `setupMarket()` result as `ctx`, so once `users` is in that result they need no change themselves.

**`apps/api/test/api.test.ts`** — five sites need the signature swap, one (`:974`) does not.

- Test `"KYC: onboard pending, gate allowlist until approved, ungated for unlinked wallets"` (app declared line 552, approval at line 566, variable `created`): change `const app = await buildTestApp();` → `const { app, users } = await buildTestAppWithRepos();`. This site's PATCH result is asserted on (`const appr = await app.inject(...); expect(appr.json().kycStatus).toBe("approved");`), so replace both lines together:
```typescript
    const appr = await app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { kycStatus: "approved" } });
    expect(appr.json().kycStatus).toBe("approved");
```
with:
```typescript
    await users.update(created.id, { kycStatus: "approved" });
    expect((await users.findById(created.id))?.kycStatus).toBe("approved");
```
- Test `"happy path: issue with sale terms, fund buyer, buy → token delivered + cash moved"` (app declared line 619, approval at line 658, variable `createdBuyer`): same swap; replace the PATCH with `await users.update(createdBuyer.id, { kycStatus: "approved" });`.
- Test `"buy blocked when buyer NOT allowlisted → cash refunded (compensation ran)"` (app declared line 702, approval at line 724, variable `createdBuyer`): same swap and replacement.
- Test `"buy 400 INSUFFICIENT_FUNDS when buyer funded less than cost"` (app declared line 791, approval at line 811, variable `createdBuyer`): same swap and replacement.
- Test `"buy 400 INSUFFICIENT_TREASURY when treasury holds fewer tokens than requested"` (app declared line 826, approval at line 846, variable `createdBuyer`): same swap and replacement.
- Test `"buy 400 NO_WALLET when buyer has no linked wallet"` (line 974): this test already declares `const { app, users } = await buildTestAppWithRepos();` — no signature change needed. Just replace:
```typescript
    await app.inject({
      method: "PATCH",
      url: `${V1}/users/${createdBuyer.id}`,
      headers: { authorization: `Bearer ${carbonAdmin}` },
      payload: { kycStatus: "approved" },
    });
```
with:
```typescript
    await users.update(createdBuyer.id, { kycStatus: "approved" });
```

`api.test.ts` already imports `buildTestAppWithRepos` (used elsewhere in the file), so no import change is needed there — only add it to the other 4 files if not already present.

- [ ] **Step 7: Typecheck and run the full suite**

Run: `cd "apps/api" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: both clean — confirm zero remaining hits with `grep -rn "PATCH.*users.*kycStatus\|kycStatus:.*approved\|kycStatus:.*rejected" apps/api/test/*.ts` other than inside `kyc-notification.test.ts`, `kyc-decision.test.ts`, or `kyc-submission.test.ts` (the new/updated files this plan owns) — every other hit found by that grep must have been migrated by Step 6.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/http/routes/shared.ts apps/api/src/http/schemas/shared.ts apps/api/test/kyc-notification.test.ts apps/api/test/admin-issue-kyc.test.ts apps/api/test/holder-acceptance.test.ts apps/api/test/identity-gate.test.ts apps/api/test/market.test.ts apps/api/test/api.test.ts
git commit -m "feat(kyc): remove the one-click kycStatus path from PATCH /users/:id

Migrate the 5 other test files that used the removed PATCH purely as
fixture setup to approve KYC directly via the users repository instead."
```

---

### Task 6: Web — self-service KYC submission panel in My Profile

**Files:**
- Create: `apps/web/src/components/shared/KycSubmissionPanel.tsx`
- Modify: `apps/web/src/components/shared/MyProfile.tsx`
- Modify: `apps/web/src/api.ts` (3 new calls)
- Modify: `apps/web/src/types.ts` (`SessionUser` gains `kycStatus`)
- Modify: `apps/api/src/http/routes/shared.ts` (`POST /auth/login` and `GET /me` both start returning `kycStatus`)
- Modify: `apps/api/src/http/schemas/shared.ts` (`S.login` and `S.me`)
- Test: `apps/api/test/me-kyc-status.test.ts`

**Interfaces:**
- Consumes: `POST /users/me/kyc/documents`, `POST /users/me/kyc/submit` (Tasks 2–3), `useAuth()` (existing).
- Produces: `<KycSubmissionPanel />`, rendered inside `MyProfile`; `deps.users.findById` freshly re-read inside `GET /me` (new — that route currently builds its response from JWT claims alone, with no DB read at all).

**A prerequisite this task discovered:** `SessionUser` (the object both `POST /auth/login` and `GET /me` return) has no `kycStatus` field today — neither route exposes it. `/me`'s own doc comment is explicit that it must never return something login didn't ("Do not expect `/me` to be a fuller record than login gave you"), so `kycStatus` is added to **both** routes together, exactly like `orgCapabilities`/`brandAccent` already are — values that can legitimately change mid-session and so are worth refreshing via `/me`, not just present at login.

- [ ] **Step 1: Write the failing backend test**

Create `apps/api/test/me-kyc-status.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

describe("kycStatus on the session (login + /me)", () => {
  it("POST /auth/login includes the caller's kycStatus", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "carbon.buyer@tokenlayer.dev", password: "carbon123" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.kycStatus).toBeTruthy();
  });

  it("GET /me includes the caller's CURRENT kycStatus, refreshed from the DB (not the stale JWT)", async () => {
    const h = await buildTestAppWithRepos();
    const token = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    const before = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(token) });
    expect(before.json().kycStatus).toBe(user!.kycStatus);
    // Change kycStatus directly (simulating a decision made mid-session) —
    // /me must reflect it without a fresh login, proving it re-reads the DB.
    await h.users.update(user!.id, { kycStatus: "approved" });
    const after = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(token) });
    expect(after.json().kycStatus).toBe("approved");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/me-kyc-status.test.ts`
Expected: FAIL — `kycStatus` is `undefined` in both responses.

- [ ] **Step 3: Add `kycStatus` to the login response**

In `apps/api/src/http/routes/shared.ts`'s `POST /auth/login` handler, the full `user` record (from `deps.users.findByEmail(email)`) is already in scope under the name `user` (confirm the exact local variable name by reading the handler — it's used a few lines above to build `claims`). Add `kycStatus: user.kycStatus` to the response object literal:

```typescript
    return {
      token: app.jwt.sign(claims),
      user: {
        ...claims, walletAddress: wallet?.address ?? null, useCaseDomain,
        orgCapabilities: org?.capabilities ?? null,
        brandLogoDocumentId: org?.brandLogoDocumentId ?? null,
        brandAccent: org?.brandAccent ?? null,
        kycStatus: user.kycStatus,
      },
    };
```

- [ ] **Step 4: Add `kycStatus` to `/me`, with a fresh DB read**

In the same file, `GET /me`'s handler currently builds its whole response from JWT claims (`actorOf(request)`) plus an org lookup — it never reads the user's own row. Add that read:

```typescript
  app.get("/me", { schema: S.me, ...auth }, async (request) => {
    const base = actorOf(request);
    const claims = request.user as TokenClaims;
    const useCaseDomain = await resolveUseCaseDomain(claims.useCaseKey);
    const org = claims.orgId ? await deps.organizations.get(claims.orgId) : null;
    const self = await deps.users.findById(claims.id);
    return {
      ...base, useCaseKey: claims.useCaseKey ?? null, useCaseDomain, orgCapabilities: org?.capabilities ?? null,
      brandLogoDocumentId: org?.brandLogoDocumentId ?? null,
      brandAccent: org?.brandAccent ?? null,
      kycStatus: self?.kycStatus ?? null,
    };
  });
```

- [ ] **Step 5: Update both schemas**

In `apps/api/src/http/schemas/shared.ts`'s `me` schema, add to `response.200.properties`:

```typescript
          kycStatus: { type: "string", enum: ["pending", "approved", "rejected"], nullable: true, description: "The caller's own current KYC status, freshly re-read (not cached from the JWT)." },
```

In the same file's `login` schema, add the identical property line to its `response.200.properties.user.properties` block.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd "apps/api" && pnpm exec vitest run test/me-kyc-status.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck and run the full backend suite**

Run: `cd "apps/api" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: both clean.

- [ ] **Step 8: Add `kycStatus` to the web `SessionUser` type**

In `apps/web/src/types.ts`'s `SessionUser` interface, add:

```typescript
  kycStatus?: "pending" | "approved" | "rejected" | null;
```

- [ ] **Step 9: Add the API calls**

In `apps/web/src/api.ts`, add:

```typescript
  uploadKycDocument: (token: string, contentType: string, dataBase64: string) =>
    request<{ id: string; sha256: string; size: number }>("/users/me/kyc/documents", token, { method: "POST", body: JSON.stringify({ contentType, dataBase64 }) }),
  submitKyc: (token: string, body: {
    legalName: string; country: string; idType: string; idNumber: string;
    dateOfBirth?: string; address?: { street: string; city: string; postalCode: string };
    occupation?: string; sourceOfFunds?: string; pepDeclaration?: boolean;
    idDocumentId: string; addressDocumentId: string;
  }) => request<{ id: string; kycStatus: string }>("/users/me/kyc/submit", token, { method: "POST", body: JSON.stringify(body) }),
```

- [ ] **Step 10: Create the submission panel component**

Create `apps/web/src/components/shared/KycSubmissionPanel.tsx`:

```typescript
import { useState } from "react";
import { api, ApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import { Card, SectionHeader } from "./ui.js";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

/** Self-service KYC submission — any authenticated user. Shown in My Profile
 *  when the caller's own kycStatus is "pending" (no submission yet, or a
 *  fresh one after rejection/expiry) or "rejected". */
export function KycSubmissionPanel({ onSubmitted }: { onSubmitted: () => void }): JSX.Element {
  const { token } = useAuth();
  const [legalName, setLegalName] = useState("");
  const [country, setCountry] = useState("");
  const [idType, setIdType] = useState("passport");
  const [idNumber, setIdNumber] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [occupation, setOccupation] = useState("");
  const [sourceOfFunds, setSourceOfFunds] = useState("");
  const [pepDeclaration, setPepDeclaration] = useState(false);
  const [idFile, setIdFile] = useState<File | null>(null);
  const [addressFile, setAddressFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = legalName && country && idType && idNumber && idFile && addressFile;

  async function submit(): Promise<void> {
    if (!token || !idFile || !addressFile) return;
    setBusy(true);
    setError(null);
    try {
      const idBase64 = await fileToBase64(idFile);
      const idUpload = await api.uploadKycDocument(token, idFile.type, idBase64);
      const addressBase64 = await fileToBase64(addressFile);
      const addressUpload = await api.uploadKycDocument(token, addressFile.type, addressBase64);
      await api.submitKyc(token, {
        legalName, country, idType, idNumber,
        dateOfBirth: dateOfBirth || undefined,
        address: street && city && postalCode ? { street, city, postalCode } : undefined,
        occupation: occupation || undefined, sourceOfFunds: sourceOfFunds || undefined, pepDeclaration,
        idDocumentId: idUpload.id, addressDocumentId: addressUpload.id,
      });
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit your KYC application.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionHeader title="Complete your KYC" description="Submit your identity details and documents for review." />
      <div className="grid gap-3 sm:grid-cols-2 mt-3">
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Legal name" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Country" value={country} onChange={(e) => setCountry(e.target.value)} />
        <select className="rounded-lg border border-slate-300 px-3 py-2 text-sm" value={idType} onChange={(e) => setIdType(e.target.value)}>
          <option value="passport">Passport</option>
          <option value="national-id">National ID</option>
          <option value="drivers-license">Driver's license</option>
        </select>
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="ID number" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
        <input type="date" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Date of birth" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Occupation" value={occupation} onChange={(e) => setOccupation(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Street address" value={street} onChange={(e) => setStreet(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Postal code" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm sm:col-span-2" placeholder="Source of funds" value={sourceOfFunds} onChange={(e) => setSourceOfFunds(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-slate-600 sm:col-span-2">
          <input type="checkbox" checked={pepDeclaration} onChange={(e) => setPepDeclaration(e.target.checked)} />
          I am a politically exposed person (PEP)
        </label>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Government-issued ID</label>
          <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setIdFile(e.target.files?.[0] ?? null)} className="text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Proof of address</label>
          <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setAddressFile(e.target.files?.[0] ?? null)} className="text-sm" />
        </div>
      </div>
      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      <button
        onClick={() => void submit()}
        disabled={!canSubmit || busy}
        className="mt-4 rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
      >
        {busy ? "Submitting…" : "Submit for review"}
      </button>
    </Card>
  );
}
```

- [ ] **Step 11: Wire it into My Profile**

In `apps/web/src/components/shared/MyProfile.tsx`, add the import:

```typescript
import { KycSubmissionPanel } from "./KycSubmissionPanel.js";
```

Find where the profile's read-only account summary is rendered (near the wallet-linking card) and add, right after it, rendering the submission panel when the caller's own `kycStatus` is `"pending"` (no decision yet — including a fresh first-time submission) or `"rejected"` — both now reliably present on `user` per Steps 1–8 above:

```typescript
      {(user?.kycStatus === "pending" || user?.kycStatus === "rejected") && (
        <KycSubmissionPanel onSubmitted={() => window.location.reload()} />
      )}
```

- [ ] **Step 12: Typecheck and run the web test suite**

Run: `cd "apps/web" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: clean, no regressions. This task adds no new web unit tests of its own (exercised live in the final deploy/verify task).

- [ ] **Step 13: Commit**

```bash
git add apps/api/src/http/routes/shared.ts apps/api/src/http/schemas/shared.ts apps/api/test/me-kyc-status.test.ts apps/web/src/components/shared/KycSubmissionPanel.tsx apps/web/src/components/shared/MyProfile.tsx apps/web/src/api.ts apps/web/src/types.ts
git commit -m "feat(kyc): expose kycStatus on the session, add self-service KYC submission panel to My Profile"
```

---

### Task 7: Web — KYC review panel in User Management (Platform Admin)

**Files:**
- Modify: `apps/web/src/components/shared/UserManagement.tsx`
- Modify: `apps/web/src/api.ts` (1 new call)

**Interfaces:**
- Consumes: `POST /users/:id/kyc/decision` (Task 4), the existing document-read endpoint (Task 2) for displaying the two documents.
- Produces: a "Review KYC" button + `KycReviewPanel` inline-expand row, mirroring `VerifyIdentityPanel`'s exact existing pattern in this same file.

- [ ] **Step 1: Add the API call**

In `apps/web/src/api.ts`, add:

```typescript
  proposeKycDecision: (token: string, userId: string, body: { decision: "approved" | "rejected"; riskTier?: "low" | "medium" | "high"; rejectionReason?: string }) =>
    request<{ proposal: { id: string; status: string } }>(`/users/${userId}/kyc/decision`, token, { method: "POST", body: JSON.stringify(body) }),
```

- [ ] **Step 2: Add the "Review KYC" button and expand-state**

In `apps/web/src/components/shared/UserManagement.tsx`, find `const [verifying, setVerifying] = useState<string | null>(null);` (the state backing `VerifyIdentityPanel`'s expand/collapse) and add a sibling right after it:

```typescript
  const [reviewingKyc, setReviewingKyc] = useState<string | null>(null);
```

Add, near `const identityIssuerEdge = ...`:

```typescript
  const isPlatformAdmin = user?.role === "PlatformAdmin";
```

In the table row's actions cell, right after the existing `{identityIssuerEdge && manageable(u) && u.kycStatus === "pending" && <button ...>Verify identity (DID/VC)</button>}` line, add:

```typescript
                    {isPlatformAdmin && manageable(u) && u.kycStatus === "pending" && <button onClick={() => setReviewingKyc((v) => (v === u.id ? null : u.id))} className="text-xs text-brand-600 hover:text-brand-700 font-medium">Review KYC</button>}
```

Right after the existing `{verifying === u.id && ( <tr>...<VerifyIdentityPanel .../></tr> )}` block, add the sibling expand row:

```typescript
                {reviewingKyc === u.id && (
                  <tr className="border-t border-slate-100 bg-slate-50/60">
                    <td colSpan={6} className="px-4 py-3">
                      <KycReviewPanel user={u} onClose={() => setReviewingKyc(null)} onDecided={() => { setReviewingKyc(null); reload(); }} />
                    </td>
                  </tr>
                )}
```

- [ ] **Step 3: Write the `KycReviewPanel` component**

In the same file, add near `function VerifyIdentityPanel(...)`:

```typescript
function KycReviewPanel({ user, onClose, onDecided }: { user: Summary; onClose: () => void; onDecided: () => void }): JSX.Element {
  const { token } = useAuth();
  const [riskTier, setRiskTier] = useState<"low" | "medium" | "high">("low");
  const [rejectionReason, setRejectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approved" | "rejected"): Promise<void> {
    if (!token) return;
    if (decision === "rejected" && !rejectionReason.trim()) {
      setError("A rejection reason is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.proposeKycDecision(token, user.id, decision === "approved" ? { decision, riskTier } : { decision, rejectionReason: rejectionReason.trim() });
      onDecided();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not propose that decision");
    } finally {
      setBusy(false);
    }
  }

  const kyc = user.kyc;

  // A plain `<a href>` would not carry the Bearer token this codebase uses for
  // auth (there is no auth cookie), so the document read would 401. Fetch with
  // the token attached and open the result as a blob URL instead. `API_BASE`
  // (exported from api.ts) is the same versioned root every other call in this
  // file goes through — never hardcode `/api/v1` separately.
  async function openDocument(docId: string): Promise<void> {
    if (!token) return;
    const res = await fetch(`${API_BASE}/users/me/kyc/documents/${docId}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) { setError("Could not load that document"); return; }
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), "_blank");
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Review KYC · {user.email}</h3>
        <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
        <div>Legal name: {kyc?.legalName ?? "—"}</div>
        <div>Country: {kyc?.country ?? "—"}</div>
        <div>ID: {kyc?.idType ?? "—"} {kyc?.idNumber ?? ""}</div>
        <div>Date of birth: {kyc?.dateOfBirth ?? "—"}</div>
        <div>Address: {kyc?.address ? `${kyc.address.street}, ${kyc.address.city} ${kyc.address.postalCode}` : "—"}</div>
        <div>Occupation: {kyc?.occupation ?? "—"}</div>
        <div>Source of funds: {kyc?.sourceOfFunds ?? "—"}</div>
        <div>PEP: {kyc?.pepDeclaration ? "Yes" : "No"}</div>
      </div>
      <div className="flex gap-3">
        {kyc?.idDocument && <button onClick={() => void openDocument(kyc.idDocument!.id)} className="text-xs text-brand-600 hover:text-brand-700 font-medium">View ID document ↗</button>}
        {kyc?.addressDocument && <button onClick={() => void openDocument(kyc.addressDocument!.id)} className="text-xs text-brand-600 hover:text-brand-700 font-medium">View address document ↗</button>}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex items-center gap-3 pt-2 border-t border-slate-100">
        <select className="rounded border border-slate-300 px-2 py-1 text-xs" value={riskTier} onChange={(e) => setRiskTier(e.target.value as "low" | "medium" | "high")}>
          <option value="low">Low risk</option>
          <option value="medium">Medium risk</option>
          <option value="high">High risk</option>
        </select>
        <button disabled={busy} onClick={() => void decide("approved")} className="text-xs rounded bg-emerald-600 text-white px-3 py-1.5 font-medium hover:bg-emerald-700 disabled:opacity-40">Propose approve</button>
        <input className="rounded border border-slate-300 px-2 py-1 text-xs flex-1" placeholder="Rejection reason" value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} />
        <button disabled={busy} onClick={() => void decide("rejected")} className="text-xs rounded border border-red-300 text-red-600 px-3 py-1.5 font-medium hover:bg-red-50 disabled:opacity-40">Propose reject</button>
      </div>
      <p className="text-[11px] text-slate-400">Proposing a decision requires a second Platform Admin to approve it in Approvals before it takes effect.</p>
    </div>
  );
}
```

Add `API_BASE` to this file's existing `import { api, ApiError } from "../../api.js";` line, changing it to `import { API_BASE, api, ApiError } from "../../api.js";`.

- [ ] **Step 4: Typecheck and run the web test suite**

Run: `cd "apps/web" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: clean, no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/shared/UserManagement.tsx apps/web/src/api.ts
git commit -m "feat(kyc): add an inline KYC review panel to User Management"
```

---

### Task 8: Web — KYC status filter (Pending / Expiring / Expired) in User Management

**Files:**
- Create: `apps/web/src/lib/shared/kyc-expiry.ts`
- Test: `apps/web/test/kyc-expiry.test.ts`
- Modify: `apps/web/src/components/shared/UserManagement.tsx`

**Interfaces:**
- Consumes: the already-fetched `rows: Summary[]` (no new backend endpoint — pure client-side filter on data already in hand).
- Produces: `isExpiringOrExpired(expiresAt: string | null | undefined, nowMs?: number): boolean`, an exported pure function other tasks/tests can import directly — following this codebase's established pattern (`apps/web/src/lib/shared/key-hygiene.ts`'s `healthOf(key, nowMs = Date.now())`) of extracting date-window logic out of the component into a testable module, rather than leaving it as an inline arrow function only reachable through a full component render.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/kyc-expiry.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { isExpiringOrExpired } from "../src/lib/shared/kyc-expiry.js";

const NOW = Date.parse("2026-09-05T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("isExpiringOrExpired", () => {
  it("a null expiresAt (grandfathered approval) never counts as expiring", () => {
    expect(isExpiringOrExpired(null, NOW)).toBe(false);
  });

  it("an undefined expiresAt never counts as expiring", () => {
    expect(isExpiringOrExpired(undefined, NOW)).toBe(false);
  });

  it("a past expiresAt counts as expired", () => {
    expect(isExpiringOrExpired(new Date(NOW - DAY).toISOString(), NOW)).toBe(true);
  });

  it("an expiresAt within the 30-day warning window counts as expiring", () => {
    expect(isExpiringOrExpired(new Date(NOW + 10 * DAY).toISOString(), NOW)).toBe(true);
  });

  it("an expiresAt outside the 30-day warning window does not count as expiring", () => {
    expect(isExpiringOrExpired(new Date(NOW + 60 * DAY).toISOString(), NOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/web" && pnpm exec vitest run test/kyc-expiry.test.ts`
Expected: FAIL — `../src/lib/shared/kyc-expiry.js` doesn't exist yet.

- [ ] **Step 3: Implement the pure function**

Create `apps/web/src/lib/shared/kyc-expiry.ts`:

```typescript
export const KYC_EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

/** True if `expiresAt` is already past, or falls within the 30-day warning window. Null/undefined (grandfathered, never-expiring) is always false. */
export function isExpiringOrExpired(expiresAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - nowMs < KYC_EXPIRY_WARNING_MS;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "apps/web" && pnpm exec vitest run test/kyc-expiry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the filter into `UserManagement.tsx`**

Add the import (near this file's other `../../lib/shared/...` imports, e.g. alongside wherever `key-hygiene.js` or another `lib/shared` module is already imported — if none is yet imported in this file, add a new line: `import { isExpiringOrExpired } from "../../lib/shared/kyc-expiry.js";`).

Near `const [sub, setSub] = useState<Sub>("manage");`, add:

```typescript
  const [kycFilter, setKycFilter] = useState<"all" | "pending" | "expiring">("all");

  const filteredRows = rows.filter((u) => {
    if (kycFilter === "pending") return u.kycStatus === "pending";
    if (kycFilter === "expiring") return u.kycStatus === "approved" && isExpiringOrExpired(u.kyc?.expiresAt);
    return true;
  });
```

Right above the roster `<table>` (immediately after the `{notice && ...}` line), add:

```typescript
      <div className="flex gap-1">
        {(["all", "pending", "expiring"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setKycFilter(f)}
            className={`px-3 py-1 rounded-lg text-xs font-medium ${kycFilter === f ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}
          >
            {f === "all" ? "All users" : f === "pending" ? "Pending KYC" : "KYC expiring/expired"}
          </button>
        ))}
      </div>
```

Change `{rows.map((u) => (` to `{filteredRows.map((u) => (` in the table body.

- [ ] **Step 6: Typecheck and run the full web test suite**

Run: `cd "apps/web" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: clean, no regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/shared/kyc-expiry.ts apps/web/test/kyc-expiry.test.ts apps/web/src/components/shared/UserManagement.tsx
git commit -m "feat(kyc): add a tested Pending/Expiring KYC filter to User Management"
```

---

### Task 9: Web — `ApprovalsPanel` summary line for `kyc-decision`

**Files:**
- Modify: `apps/web/src/components/shared/ApprovalsPanel.tsx`

**Interfaces:**
- Consumes: nothing new — this is a pure display addition to the existing generic `summarize(p: Proposal)` function.

- [ ] **Step 1: Add the `kyc-decision` case**

In `apps/web/src/components/shared/ApprovalsPanel.tsx`'s `summarize` function, add a case (placed with the other `if (p.kind === "...")` branches, order doesn't matter since kinds are mutually exclusive):

```typescript
  if (p.kind === "kyc-decision") {
    const decision = String(pl.decision ?? "");
    const detail = decision === "approved" ? `approve (${String(pl.riskTier ?? "no tier")} risk)` : `reject — ${String(pl.rejectionReason ?? "no reason given")}`;
    return `KYC decision: ${detail}`;
  }
```

- [ ] **Step 2: Typecheck and run the web test suite**

Run: `cd "apps/web" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: clean, no regressions.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/shared/ApprovalsPanel.tsx
git commit -m "feat(kyc): summarize kyc-decision proposals in the Approvals inbox"
```

---

### Task 10: Deploy and live-verify

**Files:** none — deployment and browser verification only, no code changes expected (unless verification surfaces a bug, in which case fix it in the relevant file from Tasks 1–9 and re-verify).

- [ ] **Step 1: Redeploy both stacks**

Run: `bash scripts/stack-up.sh identity tokenization`
Expected: both stacks come up cleanly with the new backend routes and web build.

- [ ] **Step 2: Verify self-service submission end-to-end**

1. Sign in to the tokenization issuer console (`http://localhost:8100` or the marketplace console `:8101`) as an existing Buyer/Investor persona (check `docs/demo-credentials.md` for a current login) whose `kycStatus` is not already `"approved"` — if none exists, use `carbon.buyer@tokenlayer.dev`.
2. Go to My Profile, confirm the "Complete your KYC" panel appears.
3. Fill the form, upload two small real files (any PDF/PNG under 5MB) as the two documents, submit.
4. Confirm the panel's submission succeeds and (after the page reloads) the user's status reflects `pending`.

- [ ] **Step 3: Verify the review flow end-to-end**

1. Sign in to the Platform Admin console (`http://localhost:8102`) as `admin@tokenlayer.dev`.
2. Go to User Management, filter to "Pending KYC," find the user from Step 2, click "Review KYC."
3. Confirm the full field set renders, and both "View ID document"/"View address document" buttons open the actual uploaded files in a new tab with the real content.
4. Propose an approval with a risk tier.
5. Go to Approvals, confirm the `kyc-decision` proposal appears with a sensible one-line summary, sign in as `admin2@tokenlayer.dev` (the second seeded PlatformAdmin — check `docs/demo-credentials.md`) in a different session/incognito context (or via a second browser profile) and approve it there — a single PlatformAdmin cannot approve their own proposal.
6. Confirm (via User Management or `GET /users`) the user's `kycStatus` is now `approved`, `riskTier` is set, and `expiresAt` is roughly a year out.
7. Check Mailpit (`http://localhost:8025`) for the KYC-approved notification email.

- [ ] **Step 4: Verify a rejection**

Repeat submission with a fresh test account, propose a rejection with a reason, approve the proposal as the second admin, confirm the user's status is `rejected` with the reason stored, and confirm the notification email includes the reason.

- [ ] **Step 5: Verify the removed one-click path**

Attempt `PATCH /users/:id { kycStatus: "approved" }` directly (e.g. via the browser's dev console against the API, or confirm via the already-passing `apps/api/test/kyc-notification.test.ts` test from Task 5 that this 400s) — confirm it no longer works.

- [ ] **Step 6: Clean up test accounts**

Per this project's established practice, deactivate (do not delete) any fresh test accounts created purely for this verification pass, the same way prior verification passes in this codebase have been cleaned up.
