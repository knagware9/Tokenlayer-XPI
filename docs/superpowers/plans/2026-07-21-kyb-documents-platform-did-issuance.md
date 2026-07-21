# KYB Documents + Platform DID Issuance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KYB document upload at corporate signup, approval as a platform-attributed DID issuance ceremony (on-chain registration + platform-signed OrganizationCredential), and a PlatformAdmin review experience with document downloads.

**Architecture:** Everything rides existing machinery. A public throttled wrapper over the invoice document store takes CIN/GSTIN certificate uploads; `POST /orgs/register` persists server-verified document refs inside `CompanyProfile`. `OrganizationCredential` joins the closed core credential catalog; the approve route composes chain-first `registerDid` → activate → membership → `issueCredentialFor` (platform org as issuer, LAST, anchor-before-persist so failure needs only the existing rollback). `orgView` gains org-held credentials so the web can attribute "Issued by TokenLayer Platform".

**Tech Stack:** Fastify + Prisma/SQLite + Vitest (apps/api), React + Vite + Tailwind (apps/web), existing FakeAnchor test double, live Besu E2E via `scripts/corporate-e2e.mjs`.

**Branch:** `feat/kyb-docs-platform-issuance` off main. Spec: `docs/superpowers/specs/2026-07-21-kyb-documents-platform-did-issuance-design.md`.

**Verified contracts (do NOT re-derive; reconcile only if the code disagrees):**
- `DocumentRepository.create({contentType, bytes: Buffer}) → {id, sha256, size}`; `get(id) → DocumentRecord|null` (apps/api/src/persistence/types.ts:232).
- `MAX_DOC_BYTES = 5*1024*1024` and `ALLOWED_DOC_TYPES = Set(["application/pdf","image/png","image/jpeg","image/webp","text/plain"])` are consts INSIDE the documents section of `registerRoutes` (routes.ts ~2060) — Task 2 hoists them to module scope so the public route can share them.
- `issueCredentialFor(deps, {issuerOrg, subjectDid, type, claims, proposalId})` signs → anchors (fail-closed if registry) → persists; **a throw leaves NO credential row** (apps/api/src/credential-issuance.ts).
- `ensurePlatformIssuerOrg(deps) → OrganizationRecord` (apps/api/src/platform-org.ts:15, `PLATFORM_ORG_NAME = "TokenLayer Platform"`).
- `credentialTypeDef(type)` throws `UNKNOWN_CREDENTIAL_TYPE` for anything not in `CREDENTIAL_TYPES` (packages/core/src/credential-types.ts:83).
- FakeAnchor: `failNext: string|null` (one-shot), ops `registerDid`/`anchorCredential`/…, maps `credentials` + `dids` (apps/api/test/fake-anchor.ts). Boot consumes one `registerDid` (`ensurePlatformIssuerOrg`) — arm `failNext` AFTER `buildTestApp`.
- Approve route (routes.ts ~1311): chain-first registerDid → setStatus/setVerified → `admin` via `listByOrg` → snapshot `priorDid`/`priorSeed` → try { mintMembership; users.update(active) } catch { restore admin, org→pending, 502 ADMIN_ACTIVATION_FAILED }.
- Web `api.ts`: `request<T>(path, token: string|null, init?)`; module-private `const BASE = \`${ORIGIN}/api/v1\``; `credentialStatus(id)` public client already exists (line ~173). `ApiError` is the exported error class — mirror how `request()` constructs it for the blob download helper.
- corporate.test.ts: shared `registerBody` const + helpers `registerAndId(app)` and `activeOrgAdmin(app)` — ALL register call sites must switch to the new `registerPayload(app)` helper (Task 2) because the schema will REQUIRE a CIN document.

---

### Task 1: Core — `OrganizationCredential` joins the credential catalog

**Files:**
- Modify: `packages/core/src/credential-types.ts`
- Test: the existing credential-catalog test file under `packages/core/test/` (find it: `grep -rln "CREDENTIAL_TYPES\|credentialTypeDef" packages/core/test/`; append there. If none exists, create `packages/core/test/credential-types.test.ts` following sibling test style.)

- [ ] **Step 1: Write the failing test** (append to the catalog test file):

```ts
describe("OrganizationCredential", () => {
  it("is in the catalog: verifier-issued, 1 approval, KYB claim schema", () => {
    const def = credentialTypeDef("OrganizationCredential");
    expect(def.allowedIssuerOrgTypes).toEqual(["verifier"]);
    expect(def.requiredApprovals).toBe(1);
    expect(def.validityDays).toBe(365);
    expect(def.claimSchema.required).toEqual(["name", "cin", "pan"]);
    expect(Object.keys(def.claimSchema.properties)).toEqual(
      expect.arrayContaining(["name", "cin", "pan", "gstin", "state", "pincode", "dateOfIncorporation", "category", "orgType"]),
    );
    expect(def.selfIssuedOnly).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run → FAIL** — `cd packages/core && pnpm test` → `UNKNOWN_CREDENTIAL_TYPE`.

- [ ] **Step 3: Implement.** In `packages/core/src/credential-types.ts`: add `"OrganizationCredential"` to the `CredentialType` union and this entry to `CREDENTIAL_TYPES` (after `AuthorizedSignatory`):

```ts
  OrganizationCredential: {
    type: "OrganizationCredential",
    description: "Attests a legal entity's verified registration (KYB) and binds it to its organization DID.",
    // Issued by the platform (a verifier org) at corporate approval; also
    // requestable through the standard maker-checker path by verifier orgs.
    allowedIssuerOrgTypes: ["verifier"],
    requiredApprovals: 1,
    validityDays: 365,
    claimSchema: {
      type: "object",
      required: ["name", "cin", "pan"],
      properties: {
        name: { type: "string", description: "Registered legal name" },
        cin: { type: "string", description: "Corporate Identity Number" },
        pan: { type: "string", description: "Permanent Account Number" },
        gstin: { type: "string", description: "GST identification number" },
        state: { type: "string", description: "State of registration" },
        pincode: { type: "string", description: "Registered-office pincode" },
        dateOfIncorporation: { type: "string", description: "ISO date of incorporation" },
        category: { type: "string", description: "Legal structure (private-limited, llp, …)" },
        orgType: { type: "string", description: "Platform organization type" },
      },
    },
  },
```

- [ ] **Step 4: Run → PASS**: `cd packages/core && pnpm test` (all green — the catalog is additive; check no test asserts an exhaustive type list, fix such a test by adding the new type if one does).

- [ ] **Step 5: Commit** — `git add packages/core && git commit -m "feat(core): OrganizationCredential joins the credential catalog"`

---

### Task 2: API — public KYB document upload + register carries document refs

**Files:**
- Modify: `apps/api/src/persistence/types.ts` (CompanyProfile), `apps/api/src/http/routes.ts` (hoist doc consts; new public route; register), `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/corporate.test.ts` (helper change touches EVERY register call site)

- [ ] **Step 1: Types.** In `apps/api/src/persistence/types.ts`, add above `CompanyProfile`:

```ts
/** A stored KYB document reference — sha256 comes from the SERVER's document record. */
export interface KybDocumentRef {
  id: string;
  sha256: string;
}
```

and add to `CompanyProfile` (after `companyStatus`):

```ts
  /** Statutory certificates uploaded at registration. CIN required, GSTIN optional. */
  documents: {
    cinCertificate: KybDocumentRef;
    gstinCertificate: KybDocumentRef | null;
  };
```

- [ ] **Step 2: Failing tests.** In `apps/api/test/corporate.test.ts`, add ABOVE the first describe:

```ts
const pdfBase64 = (label: string): string => Buffer.from(`%PDF-1.4 fake ${label}`).toString("base64");

/** Upload a CIN certificate to the public endpoint and return a register payload referencing it. */
async function registerPayload(app: import("fastify").FastifyInstance, overrides?: { gstinToo?: boolean }) {
  const up = await app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "application/pdf", dataBase64: pdfBase64("cin") } });
  expect(up.statusCode).toBe(201);
  const cin = up.json() as { id: string; sha256: string };
  let gstin: { id: string; sha256: string } | undefined;
  if (overrides?.gstinToo) {
    const up2 = await app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "image/png", dataBase64: pdfBase64("gstin") } });
    gstin = up2.json();
  }
  return {
    body: {
      ...registerBody,
      company: { ...registerBody.company, documents: { cinCertificate: { id: cin.id }, ...(gstin ? { gstinCertificate: { id: gstin.id } } : {}) } },
    },
    cin, gstin,
  };
}
```

Then a new describe block:

```ts
describe("KYB document upload (public)", () => {
  it("uploads → 201 with sha256; register persists SERVER-side refs; reviewer can download", async () => {
    const app = await buildTestApp();
    const { body, cin, gstin } = await registerPayload(app, { gstinToo: true });
    const res = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: body });
    expect(res.statusCode).toBe(202);
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const mine = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json()
      .find((o: { id: string }) => o.id === res.json().organizationId);
    expect(mine.companyProfile.documents.cinCertificate).toEqual({ id: cin.id, sha256: cin.sha256 });
    expect(mine.companyProfile.documents.gstinCertificate).toEqual({ id: gstin!.id, sha256: gstin!.sha256 });
    const dl = await app.inject({ method: "GET", url: `${V1}/documents/${cin.id}`, headers: { authorization: `Bearer ${platform}` } });
    expect(dl.statusCode).toBe(200);
    const anon = await app.inject({ method: "GET", url: `${V1}/documents/${cin.id}` });
    expect(anon.statusCode).toBe(401);
  });
  it("refuses bad uploads and bad references", async () => {
    const app = await buildTestApp();
    const badType = await app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "application/zip", dataBase64: pdfBase64("x") } });
    expect(badType.statusCode).toBe(415);
    const tooBig = await app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "application/pdf", dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") } });
    expect(tooBig.statusCode).toBe(413);
    const noDocs = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody });
    expect(noDocs.statusCode).toBe(400); // schema: documents.cinCertificate required
    const badRef = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, company: { ...registerBody.company, documents: { cinCertificate: { id: "nope" } } } } });
    expect(badRef.statusCode).toBe(400);
    expect(badRef.json().error).toBe("DOCUMENT_NOT_FOUND");
  });
});
```

**AND update every existing register call site** in this file (`registerAndId`, `activeOrgAdmin`, the self-registration + duplicate tests): replace `payload: registerBody` with `payload: (await registerPayload(app)).body` (in the duplicates test, reuse ONE `const p = await registerPayload(app)` and spread `p.body` for the variants; each app instance needs its own upload because the document store is per-app).

- [ ] **Step 3: Run → FAIL** — `cd apps/api && ./node_modules/.bin/vitest run test/corporate.test.ts` (404 on the new route; schema not yet requiring documents).

- [ ] **Step 4: Implement.** In `apps/api/src/http/routes.ts`:
  (a) HOIST `MAX_DOC_BYTES` and `ALLOWED_DOC_TYPES` from inside the documents section (~line 2060) to module scope (top of file, near other consts) unchanged in value.
  (b) Add the public route directly ABOVE `POST /orgs/register`:

```ts
  // Public: a registrant uploads a statutory certificate BEFORE registering. Same
  // limits as the authenticated store; throttled like /orgs/register. The caller
  // cannot read the document back — only authenticated reviewers can.
  app.post("/orgs/register/documents", { schema: S.uploadKybDocument, bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    if (loginThrottled(request.ip)) return reply.code(429).send({ error: "TOO_MANY_REQUESTS", message: "too many attempts; try again later" });
    const { contentType, dataBase64 } = request.body as { contentType: string; dataBase64: string };
    if (!ALLOWED_DOC_TYPES.has(contentType)) {
      return reply.code(415).send({ error: "UNSUPPORTED_DOCUMENT_TYPE", message: `contentType must be one of: ${[...ALLOWED_DOC_TYPES].join(", ")}` });
    }
    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.length === 0) return reply.code(400).send({ error: "BAD_DOCUMENT", message: "empty document" });
    if (bytes.length > MAX_DOC_BYTES) return reply.code(413).send({ error: "DOCUMENT_TOO_LARGE", message: `max ${MAX_DOC_BYTES} bytes` });
    const doc = await deps.documents.create({ contentType, bytes });
    return reply.code(201).send({ id: doc.id, sha256: doc.sha256, size: doc.size });
  });
```

  (c) In `POST /orgs/register`: extend the body type with `documents: { cinCertificate: { id: string }; gstinCertificate?: { id: string } }` on `company`; after the EMAIL_TAKEN guard, resolve the refs (server-side sha256, never from the client):

```ts
    const cinDoc = await deps.documents.get(b.company.documents.cinCertificate.id);
    if (!cinDoc) return reply.code(400).send({ error: "DOCUMENT_NOT_FOUND", message: "CIN certificate upload not found" });
    let gstinRef: KybDocumentRef | null = null;
    if (b.company.documents.gstinCertificate) {
      const g = await deps.documents.get(b.company.documents.gstinCertificate.id);
      if (!g) return reply.code(400).send({ error: "DOCUMENT_NOT_FOUND", message: "GSTIN certificate upload not found" });
      gstinRef = { id: g.id, sha256: g.sha256 };
    }
```

  and add to the built `companyProfile`: `documents: { cinCertificate: { id: cinDoc.id, sha256: cinDoc.sha256 }, gstinCertificate: gstinRef }`. Import `KybDocumentRef` type. (Check `DocumentRecord` exposes `sha256` — it does via the store; if the record field differs, use the field the repo returns.)
  (d) In `apps/api/src/http/schemas.ts`: clone `uploadDocument` as `uploadKybDocument` WITHOUT `security: bearer` (201 props `{id, sha256, size}` — no `url`), and in `registerOrg` add to `company.properties`:

```ts
            documents: {
              type: "object", additionalProperties: false, required: ["cinCertificate"],
              properties: {
                cinCertificate: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 1 } } },
                gstinCertificate: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 1 } } },
              },
            },
```

  and append `"documents"` to `company.required`. Add errs 413/415/429 to `uploadKybDocument`'s responses.

- [ ] **Step 5: Run → PASS** — corporate tests green, then `pnpm -s typecheck` clean. (organizations-repo.test.ts is untouched: `companyProfile: null` stays valid.)

- [ ] **Step 6: Commit** — `git add apps/api && git commit -m "feat(api): public KYB document upload + register carries verified document refs"`

---

### Task 3: API — approval issues the OrganizationCredential; orgView exposes org-held credentials

**Files:**
- Modify: `apps/api/src/http/routes.ts` (approve route, orgView call sites, imports), `apps/api/src/http/schemas.ts` (approveOrg response note — response is `additionalProperties: true`, no change needed; only touch if strict)
- Test: `apps/api/test/corporate.test.ts` (append)

- [ ] **Step 1: Failing tests** — append a describe:

```ts
describe("DID issuance ceremony", () => {
  it("approve → platform org issues an anchored OrganizationCredential to the org DID", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgId = ((await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: (await registerPayload(app)).body })).json()).organizationId;
    const appr = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.statusCode).toBe(200);
    const { issuerDid, orgCredentialId, did } = appr.json();
    const platformOrg = (await app.inject({ method: "GET", url: `${V1}/orgs`, headers: { authorization: `Bearer ${platform}` } })).json()
      .find((o: { name: string }) => o.name === "TokenLayer Platform");
    expect(issuerDid).toBe(platformOrg.did);
    expect(anchor.credentials.has(orgCredentialId)).toBe(true); // genuinely anchored
    const view = (await app.inject({ method: "GET", url: `${V1}/orgs/${orgId}`, headers: { authorization: `Bearer ${platform}` } })).json();
    const oc = view.credentials.find((c: { type: string }) => c.type === "OrganizationCredential");
    expect(oc).toMatchObject({ id: orgCredentialId, issuerDid: platformOrg.did, revoked: false });
    expect(view.did).toBe(did);
  });
  it("anchor failure rolls EVERYTHING back — org pending, admin locked, no credential", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgId = ((await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: (await registerPayload(app)).body })).json()).organizationId;
    anchor.failNext = "anchorCredential"; // armed post-boot; consumed only by the org-credential issuance
    const appr = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.statusCode).toBe(502);
    const pending = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json();
    expect(pending.some((o: { id: string }) => o.id === orgId)).toBe(true);
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } });
    expect(login.statusCode).toBe(401);
    const view = (await app.inject({ method: "GET", url: `${V1}/orgs/${orgId}`, headers: { authorization: `Bearer ${platform}` } })).json();
    expect(view.credentials.filter((c: { type: string }) => c.type === "OrganizationCredential")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run → FAIL** (no `issuerDid`/`orgCredentialId` in response; no `credentials` in orgView).

- [ ] **Step 3: Implement.** In `apps/api/src/http/routes.ts`:
  (a) Imports: `import { issueCredentialFor } from "../credential-issuance.js";` and `import { ensurePlatformIssuerOrg } from "../platform-org.js";` (reconcile paths against existing imports of these modules elsewhere).
  (b) Async org view with credentials — add beside `orgView`:

```ts
/** orgView + the credentials HELD by the org's parent DID (issuance attribution). */
async function orgViewWithCreds(o: OrganizationRecord) {
  const held = await deps.credentials.listByHolder(o.did);
  return { ...orgView(o), credentials: held.map((c) => ({ id: c.id, type: c.type, issuerDid: c.issuerDid, issuedAt: c.issuedAt, revoked: c.revoked })) };
}
```

  NOTE: `orgView` is module-scope but `deps` is not — define `orgViewWithCreds` INSIDE `registerRoutes` (where `deps` is in scope), or thread `deps` as a parameter; match how sibling helpers in the file handle this. Use it in `GET /orgs` (`Promise.all(rows.map(orgViewWithCreds))`) and `GET /orgs/:id`.
  (c) Approve route — inside the existing `if (admin) { try { ... } }`, AFTER `users.update(admin.id, { active: true })`, add the ceremony (declare `let issuerDid: string | null = null; let orgCredentialId: string | null = null;` before the `if (admin)`):

```ts
        // The issuance ceremony: the PLATFORM org attests the corporate's KYB
        // facts with a signed, anchored OrganizationCredential. Deliberately
        // LAST: issueCredentialFor persists nothing on a throw, so a failure
        // here needs only the rollback below — no credential compensation.
        const platformOrg = await ensurePlatformIssuerOrg(deps);
        const p = org.companyProfile;
        const claims: Record<string, unknown> = {
          name: org.name, orgType: org.orgType,
          ...(p ? {
            cin: p.cin, pan: p.pan, state: p.state, pincode: p.pincode,
            dateOfIncorporation: p.dateOfIncorporation, category: p.category,
            ...(p.gstin ? { gstin: p.gstin } : {}),
          } : {}),
        };
        const cred = await issueCredentialFor(deps, { issuerOrg: platformOrg, subjectDid: org.did, type: "OrganizationCredential", claims, proposalId: null });
        issuerDid = platformOrg.did;
        orgCredentialId = cred.id;
```

  Keep the catch EXACTLY as-is (admin snapshot restore + org→pending + 502 `ADMIN_ACTIVATION_FAILED`) but update its message to "could not complete the issuance ceremony — reverted to pending".
  (d) Audit + response: `deps.audit.append({ ..., payload: { orgId: org.id, did: org.did, orgCredentialId, issuerDid } })`; response `return reply.code(200).send({ id: active.id, name: active.name, did: active.did, orgType: active.orgType, status: "active", verified: true, issuerDid, orgCredentialId });`.

- [ ] **Step 4: Run → PASS** — corporate file green, then the FULL api suite `./node_modules/.bin/vitest run` (the approve path changed: earlier corporate tests now also issue org credentials — the chain-first registerDid test still passes because it fails BEFORE issuance) and `pnpm -s typecheck`.

- [ ] **Step 5: Commit** — `git add apps/api && git commit -m "feat(api): approval issues a platform-signed OrganizationCredential; orgs expose held credentials"`

---

### Task 4: Web — client + signup wizard documents section

**Files:**
- Modify: `apps/web/src/types.ts`, `apps/web/src/api.ts`, `apps/web/src/components/Signup.tsx`

- [ ] **Step 1: types.ts.** Add above `CompanyProfile`:

```ts
export interface KybDocumentRef { id: string; sha256: string }
```

Add to `CompanyProfile`: `documents?: { cinCertificate: KybDocumentRef; gstinCertificate: KybDocumentRef | null };` (OPTIONAL — rows registered before this cycle lack it; render defensively). Add to `Organization`: `credentials?: { id: string; type: string; issuerDid: string; issuedAt: string; revoked: boolean }[];`.

- [ ] **Step 2: api.ts.** Extend `registerOrg`'s `company` param with `documents: { cinCertificate: { id: string }; gstinCertificate?: { id: string } }`. Add (mirroring the real unauthenticated/authenticated idioms):

```ts
  // Public: upload a KYB certificate before registering (no auth, throttled).
  uploadKybDocument: (contentType: string, dataBase64: string) =>
    request<{ id: string; sha256: string; size: number }>("/orgs/register/documents", null, { method: "POST", body: JSON.stringify({ contentType, dataBase64 }) }),
  // Authenticated raw download for the reviewer (returns a Blob, not JSON).
  downloadDocument: async (token: string, id: string): Promise<Blob> => {
    const res = await fetch(`${BASE}/documents/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new ApiError(/* mirror how request() builds ApiError for a failed response */);
    return res.blob();
  },
```

Widen `approveOrg`'s return type to `Organization & { issuerDid: string | null; orgCredentialId: string | null }`. (Reconcile the `ApiError` constructor against the file's real `request()` implementation.)

- [ ] **Step 3: Signup.tsx documents section.** Add state `const [cinDoc, setCinDoc] = useState<{ id: string; sha256: string; name: string } | null>(null);` (same for `gstinDoc`) plus `docBusy: "cin" | "gstin" | null`. Add a file-read helper + upload handler:

```ts
  async function pickDocument(kind: "cin" | "gstin", file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    if (!["application/pdf", "image/png", "image/jpeg"].includes(file.type)) { setError("Use a PDF, PNG, or JPG"); return; }
    if (file.size > 5 * 1024 * 1024) { setError("File too large (max 5 MB)"); return; }
    setDocBusy(kind);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const up = await api.uploadKybDocument(file.type, dataBase64);
      (kind === "cin" ? setCinDoc : setGstinDoc)({ id: up.id, sha256: up.sha256, name: file.name });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setDocBusy(null);
    }
  }
```

In Step 1 of the wizard (after Company status) add a "Documents" sub-section: CIN certificate `<input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => void pickDocument("cin", e.target.files?.[0])} />` styled like the house inputs, showing `cinDoc.name + " · " + cinDoc.sha256.slice(0, 12) + "…"` with a ✓ when uploaded (and "Uploading…" while `docBusy === "cin"`); the GSTIN picker renders ONLY when `f.gstin.trim()` is non-empty. `validate(0)` gains `if (!cinDoc) return "CIN certificate is required";`. The Review step's Company section gains `<Row label="CIN certificate" value={cinDoc?.name ?? "—"} />` and, when present, the GSTIN row. `submit()` passes `documents: { cinCertificate: { id: cinDoc!.id }, ...(gstinDoc ? { gstinCertificate: { id: gstinDoc.id } } : {}) }`.

- [ ] **Step 4: Verify** — `pnpm --filter @tokenlayer/web exec tsc --noEmit` and `pnpm --filter @tokenlayer/web build` → clean.

- [ ] **Step 5: Commit** — `git add apps/web && git commit -m "feat(web): KYB document uploads in the corporate signup wizard"`

---

### Task 5: Web — PlatformAdmin review expansion + issuance attribution

**Files:**
- Modify: `apps/web/src/components/Organizations.tsx`

- [ ] **Step 1: Review expansion + downloads in `PendingOrgs`.** Add `const [open, setOpen] = useState<string | null>(null);` and an `issued` success state `useState<{ name: string; did: string } | null>(null)`. Each row header gains a "Review" toggle button (`open === o.id ? "Hide" : "Review"`). The KYB `<dl>` grid moves INSIDE `{open === o.id && (...)}` and gains a Documents row after the grid:

```tsx
                  {p?.documents && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <DocLink token={token!} label="CIN certificate" doc={p.documents.cinCertificate} />
                      {p.documents.gstinCertificate && <DocLink token={token!} label="GSTIN certificate" doc={p.documents.gstinCertificate} />}
                    </div>
                  )}
```

with a small component in the same file:

```tsx
function DocLink({ token, label, doc }: { token: string; label: string; doc: KybDocumentRef }): JSX.Element {
  const [busy, setBusy] = useState(false);
  async function download(): Promise<void> {
    setBusy(true);
    try {
      const blob = await api.downloadDocument(token, doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = label.toLowerCase().replace(/\s+/g, "-");
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button onClick={() => void download()} disabled={busy} className="text-xs rounded border border-slate-300 text-slate-600 px-2.5 py-1 font-medium hover:bg-slate-50 disabled:opacity-40">
      ⬇ {label} <span className="text-slate-400 font-normal">{doc.sha256.slice(0, 10)}…</span>
    </button>
  );
}
```

`approve()` captures the response: `const res = await api.approveOrg(token, id); setIssued({ name: res.name, did: res.did });` and the Card renders, above the rows, when `issued`:

```tsx
      {issued && (
        <p className="mb-3 text-sm rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-2">
          <span className="font-semibold">{issued.name}</span> approved — DID issued by TokenLayer Platform
          <span className="font-mono text-xs"> {issued.did.slice(0, 24)}…</span> · registered on-chain · OrganizationCredential anchored.
        </p>
      )}
```

Import `KybDocumentRef` from types.

- [ ] **Step 2: Corporate-side attribution in `OrgCard`.** Locate where the card renders the DID (the truncated `did:key:…` + on-chain pill). Change to: when `org.status !== "active"` render `<Pill tone="warn">DID pending issuance</Pill>` INSTEAD of the did; when active, keep the did and add, when `org.credentials?.some((c) => c.type === "OrganizationCredential" && !c.revoked)`:

```tsx
                <span className="text-xs text-slate-500">Issued by <span className="font-medium text-slate-700">TokenLayer Platform</span></span>
                <CredStatusPill id={org.credentials.find((c) => c.type === "OrganizationCredential" && !c.revoked)!.id} />
```

with:

```tsx
function CredStatusPill({ id }: { id: string }): JSX.Element | null {
  const [status, setStatus] = useState<CredentialStatusInfo | null>(null);
  useEffect(() => { void api.credentialStatus(id).then(setStatus).catch(() => setStatus(null)); }, [id]);
  if (!status) return null;
  return <Pill tone={status.revoked ? "danger" : "ok"}>{status.revoked ? "revoked" : status.source === "chain" ? "anchored on-chain" : "issued"}</Pill>;
}
```

(Reconcile `CredentialStatusInfo` field names — `source`/`anchored`/`revoked` — against `apps/web/src/types.ts`; reuse an existing status-pill component if one already exists in CredentialsPanel/MyIdentity instead of duplicating.)

- [ ] **Step 3: Verify** — `pnpm --filter @tokenlayer/web exec tsc --noEmit` && build → clean.

- [ ] **Step 4: Commit** — `git add apps/web && git commit -m "feat(web): registration review with document downloads + platform issuance attribution"`

---

### Task 6: Verify — suite, live Besu E2E, browser, finish

**Files:**
- Modify: `scripts/corporate-e2e.mjs`

- [ ] **Step 1: Full verification** — from repo root: `pnpm -r test` (core/contracts/adapters/api all green) and `pnpm --filter @tokenlayer/web build`.

- [ ] **Step 2: Extend `scripts/corporate-e2e.mjs`.**
  (a) Before register: upload both docs and reference them:

```js
const upload = async (label, contentType) => (await call("POST", "/orgs/register/documents", { contentType, dataBase64: Buffer.from(`%PDF-1.4 ${label} ${runId}`).toString("base64") }, null)).json;
console.log("== 1a) KYB documents upload (public) ==");
const cinDoc = await upload("cin-cert", "application/pdf");
const gstinDoc = await upload("gstin-cert", "image/png");
ok(cinDoc?.id && cinDoc?.sha256, `CIN certificate stored (${cinDoc?.sha256?.slice(0, 12)}…)`, cinDoc);
```

  and add to `registerBody.company`: `documents: { cinCertificate: { id: cinDoc.id }, gstinCertificate: { id: gstinDoc.id } }`.
  (b) In the pending-queue section assert `pending.find(o => o.id === orgId)?.companyProfile?.documents?.cinCertificate?.sha256 === cinDoc.sha256`.
  (c) After approve, capture `const { issuerDid, orgCredentialId } = appr.json;` and assert both truthy plus `issuerDid !== orgDid`.
  (d) NEW independent proof section after the DidRegistry proof — reuse the `statusOf` VcRegistry pattern from `scripts/onboarding-e2e.mjs` (Interface `"function statusOf(bytes32) view returns (bool exists, bool revoked, uint64 revokedAt, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt)"`, `keccak256(toUtf8Bytes(orgCredentialId))`, eth_call against `reg.vcRegistry`):

```js
console.log("\n== 4b) INDEPENDENT proof — the OrganizationCredential is anchored on real Besu ==");
const vcIface = new Interface(["function statusOf(bytes32) view returns (bool exists, bool revoked, uint64 revokedAt, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt)"]);
const st = vcIface.decodeFunctionResult("statusOf", await rpc("eth_call", [{ to: reg.vcRegistry, data: vcIface.encodeFunctionData("statusOf", [keccak256(toUtf8Bytes(orgCredentialId))]) }, "latest"]));
ok(st.exists === true && st.revoked === false, "eth_call statusOf(orgCredentialId) → exists:true, revoked:false (platform-issued KYB attestation on-chain)");
```

- [ ] **Step 3: Run live** — `make besu-up`; wait for RPC; reset+seed the api DB; boot `BESU_RPC_URL=http://localhost:8545 BESU_OPERATOR_KEY=0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63 REGISTRY_CHAIN_ID=besu DID_MASTER_KEY=<64-hex> JWT_SECRET=<any> PORT=4000 ./node_modules/.bin/tsx src/server.ts`; then `node scripts/corporate-e2e.mjs` → ALL checks pass (exit 0).

- [ ] **Step 4: Browser verify** (dev web against the same API, `LOGIN_RATE_LIMIT_MAX=1000 CORS_ORIGINS=http://localhost:5173`): signup wizard with two file uploads (✓ + sha256 shown) → Review step lists them → submit → PlatformAdmin → Organizations → Review expansion shows KYB grid + both download buttons (download works) → Approve → success notice "DID issued by TokenLayer Platform … OrganizationCredential anchored" → sign out → corporate admin login → Organizations card shows DID + "Issued by TokenLayer Platform" + anchored pill. Confirm no fresh console errors.

- [ ] **Step 5: Commit + finish** — `git add -A && git commit -m "feat(scripts): corporate e2e proves the anchored OrganizationCredential"`; then use superpowers:finishing-a-development-branch (full-suite gate → merge choice).

---

## Self-review notes
- Spec coverage: component 0 → Task 1; component 1 → Task 2; component 2 → Tasks 2+4; component 3 → Task 3; component 4 → Tasks 3+5; component 5 → Task 5; testing section → Tasks 2/3/6. No gaps.
- The `ADMIN_ACTIVATION_FAILED` code is kept for BOTH membership and issuance failures (single catch) with an updated message — a deliberate, documented narrowing of the spec's "or ISSUANCE_FAILED" alternative.
- Type-consistency: `KybDocumentRef {id, sha256}` used identically in api types, web types, and the register handler; `orgViewWithCreds` returns the same credential shape asserted in Task 3 tests and consumed in Task 5.
