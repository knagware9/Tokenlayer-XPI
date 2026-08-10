# Org-Scoped Certificate Artwork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an OrgAdmin upload certificate artwork and place fields on a credential use case their own organization owns, without widening anything else about that use case.

**Architecture:** Three new routes on `apps/api/src/http/routes.ts`, all `authScoped("usecases:provision")` and all behind one shared ownership gate (`ownedCredentialUseCase`) that pairs an explicit role predicate with an `ownerOrgId === claims.orgId` check — `requireScope` short-circuits for human sessions, so `authScoped` alone gates nothing. `PATCH /credential-use-cases/:key/certificate` writes only `background` + `placements` onto one named credential type of the stored definition; `POST`/`GET …/certificate/artwork` are the artwork doors, because `RbacPolicy` gives `OrgAdmin` only `read` and the general document store is gated on `issue`. `background` gains an optional `sha256` pin, required by the org route and verified wherever it is supplied.

**Tech Stack:** TypeScript, Fastify, vitest, React + Tailwind (apps/web), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-10-org-scoped-certificate-artwork-design.md`

**Baselines on `main`:** core 283 / api 760 / web 138 tests passing.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/credential-use-cases.ts` | `CertificateConfig.background` gains `sha256?`; its format validated. |
| `packages/core/src/use-case-templates.ts` | Same `sha256` format check in `validateTemplate`. |
| `packages/core/test/certificate-config.test.ts` | The `sha256` cases (existing file). |
| `apps/api/src/http/routes.ts` | `checkBackgroundDocument` helper + its four call sites; `ownedCredentialUseCase` gate; the three new routes. |
| `apps/api/src/http/schemas.ts` | Schemas for the three routes. |
| `apps/api/openapi.snapshot.json` | Regenerated. |
| `apps/api/test/certificate-org-design.test.ts` | **NEW.** Every gate and every write rule of the three routes. |
| `apps/web/src/types.ts` | `sha256?` on the mirrored `background`. |
| `apps/web/src/api.ts` | `updateCertificateDesign`, `uploadCertificateArtwork`, `certificateArtwork`. |
| `apps/web/src/lib/certificate-access.ts` | **NEW.** `canDesignCertificate(user, useCase)` — the pure mirror of the server's ownership rule. |
| `apps/web/test/certificate-access.test.ts` | **NEW.** That predicate. |
| `apps/web/src/components/CertificateDesignPanel.tsx` | **NEW.** The OrgAdmin-facing panel wrapping `CertificateDesigner`. |
| `apps/web/src/components/IdentityHome.tsx` | The per-credential-type "Design certificate" entry point. |
| `apps/web/src/components/CredentialUseCaseBuilder.tsx` | Carries `sha256` through the PlatformAdmin wizard too. |
| `docs/api/CHANGELOG.md` | Replaces the "configured BY THE PLATFORM OPERATOR" note. |

---

### Task 1: `background.sha256` in core

**Files:**
- Modify: `packages/core/src/credential-use-cases.ts:44`, `packages/core/src/credential-use-cases.ts:138-141`
- Modify: `packages/core/src/use-case-templates.ts:148-149`
- Test: `packages/core/test/certificate-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/certificate-config.test.ts` (inside the existing `describe("CertificateConfig carries artwork", …)` block, after the `rejects a non-string background.documentId` test):

```ts
  it("accepts a background with a 64-char lowercase hex sha256 pin", () => {
    expect(() => validateCredentialUseCase(def({
      enabled: true,
      background: { documentId: "doc_1", sha256: "a".repeat(64) },
    }), ctx)).not.toThrow();
  });

  it("rejects a malformed sha256 — too short, uppercase, or not hex", () => {
    for (const bad of ["abc", "A".repeat(64), "z".repeat(64), 7]) {
      expect(() => validateCredentialUseCase(def({
        enabled: true, background: { documentId: "doc_1", sha256: bad },
      }), ctx)).toThrow(/background\.sha256/);
    }
  });

  it("a template's background sha256 is held to the same format", () => {
    const t = {
      key: "sha-t", name: "T", category: "education",
      parameters: [],
      body: {
        keyTemplate: "t-key", nameTemplate: "T",
        credentialTypes: [{
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          required: ["fullName"], properties: { fullName: { type: "string" } },
          certificate: { enabled: true, background: { documentId: "doc_1", sha256: "nope" } },
        }],
        holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    } as unknown as UseCaseTemplate;
    expect(() => validateTemplate(t)).toThrow(/background\.sha256/);
  });
```

`validateTemplate` and `UseCaseTemplate` are already imported at the top of that file; `instantiateTemplate` is too. No new imports.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/core && npx vitest run test/certificate-config.test.ts
```

Expected: FAIL — the two `validateCredentialUseCase` cases fail because nothing rejects `sha256`, and the template case fails the same way.

- [ ] **Step 3: Widen the type**

In `packages/core/src/credential-use-cases.ts`, replace line 44:

```ts
  background?: { documentId: string; sha256?: string };
```

with the documented form:

```ts
  /**
   * EN-F follow-up: the digest of the artwork bytes, as `POST /documents`
   * reports it. OPTIONAL so every record written by EN-F stays valid, and the
   * org-scoped design route REQUIRES it: `documentId` alone is bound to
   * nothing, so a pin is what stops a caller naming a document id it merely
   * guessed. Verified wherever it is supplied.
   */
  background?: { documentId: string; sha256?: string };
```

- [ ] **Step 4: Validate its format in both validators**

In `packages/core/src/credential-use-cases.ts`, replace the `cert.background` block (lines 138–141):

```ts
      if (cert.background !== undefined) {
        if (!cert.background || typeof cert.background !== "object" || typeof cert.background.documentId !== "string" || !cert.background.documentId.trim())
          fail(`credential type '${ct.name}' certificate.background.documentId must be a non-empty string`);
        // Lowercase hex, 64 chars — exactly what `createHash("sha256").digest("hex")`
        // produces in the document store. A pin in any other shape can never
        // match a stored digest, so accepting it would store a check that
        // always fails at the door which enforces it.
        if (cert.background.sha256 !== undefined && (typeof cert.background.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(cert.background.sha256)))
          fail(`credential type '${ct.name}' certificate.background.sha256 must be a 64-character lowercase hex digest`);
      }
```

In `packages/core/src/use-case-templates.ts`, replace lines 148–149:

```ts
    if (cert.background !== undefined && (typeof cert.background !== "object" || cert.background === null || typeof cert.background.documentId !== "string"))
      fail(`credential type '${ct.name}' certificate.background.documentId must be a string`);
    // Both doors, same rule — the reason this file validates placements at all.
    if (cert.background?.sha256 !== undefined && (typeof cert.background.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(cert.background.sha256)))
      fail(`credential type '${ct.name}' certificate.background.sha256 must be a 64-character lowercase hex digest`);
```

If TypeScript complains that `sha256` is not on the template's certificate type, widen the template's certificate background type in the same file to `{ documentId: string; sha256?: string }` to match core's `CertificateConfig`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd packages/core && npx vitest run test/certificate-config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the whole core suite**

```bash
cd packages/core && npx vitest run
```

Expected: PASS, 283 + 3 = 286 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/credential-use-cases.ts packages/core/src/use-case-templates.ts packages/core/test/certificate-config.test.ts
git commit -m "feat(core): certificate background carries an optional sha256 pin"
```

---

### Task 2: `checkBackgroundDocument` and the three existing doors

The helper that turns "this background names a document" into a refusal at write time. Applied at `POST /credential-use-cases`, `PATCH /credential-use-cases/:key` and `POST /credential-use-cases/preview-certificate` in **lenient** mode: an absent document stays legal (a document can be deleted after a config is written, and `certificate-artwork.test.ts` pins that fallback deliberately), but a supplied `sha256` that mismatches and a stored non-image content type are refused.

**Files:**
- Modify: `apps/api/src/http/routes.ts` (new helper near `referencedOrgs`, ~line 980; call sites at ~1026, ~1052, ~1251)
- Test: `apps/api/test/certificate-org-design.test.ts` (new file — created here, grown by Tasks 3–5)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/certificate-org-design.test.ts`:

```ts
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/api-keys.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const TEST_ROUNDS = 4;

/** A real 2×1 RGB PNG whose pixel data actually inflates — the fixture the
 *  EN-F suites share, reused rather than re-typed. */
const PNG_2x1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGM4AwYAEMMEyWIMKSwAAAAASUVORK5CYII=";

/** An org, its OrgAdmin, and a credential use case the org OWNS. */
interface World {
  h: TestAppHandle;
  orgId: string;
  orgAdmin: string;
  platform: string;
  key: string;
}

async function world(opts: { ownerOrgId?: string | null } = {}): Promise<World> {
  const h = await buildTestAppWithRepos();
  const tag = Math.random().toString(36).slice(2, 10);
  const org = await h.organizations.create({
    name: `Design Co ${tag}`, orgType: "issuer", registrationId: null, jurisdiction: null,
    did: `did:key:zDC${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
    verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
  });
  const email = `design-admin-${tag}@tokenlayer.dev`;
  const password = `design-admin-${tag}`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync(password, TEST_ROUNDS), role: "OrgAdmin",
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId: org.id, kind: "human",
  });
  const key = `design-${tag}`;
  await h.deps.credentialUseCases.create({
    key, name: "Design Programme",
    credentialTypes: [{
      name: "CourseCompletion", title: "Course Completion", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" }, grade: { type: "string" } } },
      certificate: { enabled: true },
    }],
    issuer: { kind: "org", orgId: org.id },
    holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    ownerOrgId: opts.ownerOrgId === undefined ? org.id : opts.ownerOrgId,
  } as never);
  return {
    h, orgId: org.id, key,
    orgAdmin: await loginAs(h.app, email, password),
    platform: await loginAs(h.app, "admin@tokenlayer.dev", "admin123"),
  };
}

/** Store a document DIRECTLY through the repository — the point of several tests
 *  below is that the HTTP document store refuses an OrgAdmin. */
async function storeDoc(h: TestAppHandle, contentType: string, b64: string): Promise<{ id: string; sha256: string }> {
  const d = await h.deps.documents.create({ contentType, bytes: Buffer.from(b64, "base64") });
  return { id: d.id, sha256: d.sha256 };
}

describe("a supplied background sha256 is verified at every writing door", () => {
  it("POST /credential-use-cases refuses a background whose pin does not match the stored bytes", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    const res = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(w.platform),
      payload: {
        key: `pinned-${Math.random().toString(36).slice(2, 8)}`, name: "Pinned",
        credentialTypes: [{
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: doc.id, sha256: "b".repeat(64) } },
        }],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BACKGROUND_DOCUMENT_MISMATCH");
  });

  it("POST /credential-use-cases refuses a background naming a NON-IMAGE document", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "text/plain", Buffer.from("not a picture").toString("base64"));
    const res = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(w.platform),
      payload: {
        key: `texty-${Math.random().toString(36).slice(2, 8)}`, name: "Texty",
        credentialTypes: [{
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: doc.id } },
        }],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BACKGROUND_NOT_AN_IMAGE");
  });

  it("still accepts a bare documentId naming nothing — the render-time fallback is the guard there", async () => {
    // certificate-artwork.test.ts pins this on purpose: a deleted document must
    // degrade to the built-in layout, not turn every certificate into an error.
    // Tightening THIS door would break that, so it is deliberately not tightened.
    const w = await world();
    const res = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(w.platform),
      payload: {
        key: `ghost-${Math.random().toString(36).slice(2, 8)}`, name: "Ghost",
        credentialTypes: [{
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: "doc_does_not_exist" } },
        }],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("the preview route refuses a mismatched pin too", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    const res = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`, headers: auth(w.platform),
      payload: {
        credentialType: {
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: doc.id, sha256: "c".repeat(64) }, placements: [] },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BACKGROUND_DOCUMENT_MISMATCH");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && npx vitest run test/certificate-org-design.test.ts
```

Expected: FAIL — the three refusal tests get 201/200 instead of 400 (`BACKGROUND_*` codes do not exist yet). The "bare documentId" test already passes; that is the control.

- [ ] **Step 3: Add the helper**

In `apps/api/src/http/routes.ts`, immediately after `referencedOrgs` (which ends at line 980) and before the `credentialUseCaseCapabilityViolation` comment block, insert:

```ts
  /**
   * What a `certificate.background` may name, checked at the WRITE.
   *
   * `documentId` was bound to nothing: validation asked only for a non-empty
   * string, and both renderers read whatever id they were handed with no
   * content-type check. This is the write-time half of that; the render keeps
   * its fallback, because a document can be deleted long after a config was
   * written and a missing one must not turn every certificate of that type into
   * an error.
   *
   * `requirePin` is the difference between the two kinds of door. The
   * org-scoped design route sets it: `documentId` alone is a guessable
   * reference, and a pin is what proves the caller has actually seen the file.
   * The three pre-existing PlatformAdmin doors leave it false, so a bare
   * documentId — including one naming nothing — keeps working exactly as it did
   * before, which is what `certificate-artwork.test.ts` pins.
   *
   * Returns null when there is nothing to refuse; otherwise the coded 400 the
   * caller sends. Never replies itself: three of its four call sites are inside
   * loops over credential types, where a helper that had already answered would
   * be a second reply on the same request.
   */
  async function checkBackgroundDocument(
    background: { documentId?: unknown; sha256?: unknown } | null | undefined,
    opts: { requirePin: boolean },
  ): Promise<{ error: string; message: string } | null> {
    if (!background || typeof background.documentId !== "string") return null;
    const documentId = background.documentId;
    const pin = typeof background.sha256 === "string" ? background.sha256 : null;
    if (opts.requirePin && !pin) {
      return { error: "BACKGROUND_PIN_REQUIRED", message: `certificate background must carry the artwork's sha256 alongside documentId '${documentId}'` };
    }
    const doc = await deps.documents.get(documentId).catch(() => null);
    if (!doc) {
      if (!opts.requirePin) return null; // the render-time fallback is the guard on these doors
      return { error: "BACKGROUND_DOCUMENT_NOT_FOUND", message: `certificate background document '${documentId}' not found` };
    }
    if (!doc.contentType.startsWith("image/")) {
      return { error: "BACKGROUND_NOT_AN_IMAGE", message: `certificate background document '${documentId}' is ${doc.contentType}, not an image` };
    }
    if (pin && pin !== doc.sha256) {
      return { error: "BACKGROUND_DOCUMENT_MISMATCH", message: `certificate background document '${documentId}' does not match the supplied sha256` };
    }
    return null;
  }

  /** `checkBackgroundDocument` across every credential type of a definition. */
  async function checkDefinitionBackgrounds(
    def: { credentialTypes?: Array<{ certificate?: { background?: unknown } }> },
  ): Promise<{ error: string; message: string } | null> {
    for (const ct of def.credentialTypes ?? []) {
      const problem = await checkBackgroundDocument(ct.certificate?.background as never, { requirePin: false });
      if (problem) return problem;
    }
    return null;
  }
```

- [ ] **Step 4: Call it from the three existing doors**

In `POST /credential-use-cases`, after the `validateCredentialUseCase` try/catch and before the capability check (currently line 1030):

```ts
    const badBackground = await checkDefinitionBackgrounds(def);
    if (badBackground) return reply.code(400).send(badBackground);
```

In `PATCH /credential-use-cases/:key`, in the same position — after the `validateCredentialUseCase` try/catch, before `const ownerOrgId = …` (currently line 1056):

```ts
    const badBackground = await checkDefinitionBackgrounds(def);
    if (badBackground) return reply.code(400).send(badBackground);
```

In `POST /credential-use-cases/preview-certificate`, immediately after the `validateCertificatePlacements(…)` call (currently line 1251):

```ts
    const badBackground = await checkBackgroundDocument(spec.certificate?.background, { requirePin: false });
    if (badBackground) return reply.code(400).send(badBackground);
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run test/certificate-org-design.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Run the EN-F suites that could regress**

```bash
cd apps/api && npx vitest run test/certificate-artwork.test.ts test/certificate-preview.test.ts test/credential-certificate.test.ts test/credential-usecase.test.ts
```

Expected: PASS, no change in counts. If `certificate-artwork.test.ts`'s "missing background document falls back" case fails, `requirePin` has leaked into a PlatformAdmin door — fix the call site rather than the test.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/test/certificate-org-design.test.ts
git commit -m "feat(api): verify a certificate background's pin and content type at every write door"
```

---

### Task 3: The ownership gate and `PATCH /credential-use-cases/:key/certificate`

**Files:**
- Modify: `apps/api/src/http/routes.ts` (after the `preview-certificate` route, currently ending line 1325)
- Modify: `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/certificate-org-design.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/certificate-org-design.test.ts`:

```ts
const design = (w: World, token: string, payload: unknown) =>
  w.h.app.inject({ method: "PATCH", url: `${V1}/credential-use-cases/${w.key}/certificate`, headers: auth(token), payload });

const readBack = async (w: World) => {
  const res = await w.h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/${w.key}`, headers: auth(w.platform) });
  return res.json() as { credentialTypes: Array<{ name: string; certificate?: Record<string, unknown> }>; ownerOrgId?: string | null; issuer: { kind: string; orgId?: string }; sandbox?: boolean };
};

describe("PATCH /credential-use-cases/:key/certificate", () => {
  it("an owner OrgAdmin sets artwork and placements on their own use case", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    const res = await design(w, w.orgAdmin, {
      credentialType: "CourseCompletion",
      background: { documentId: doc.id, sha256: doc.sha256 },
      placements: [{ field: "claim:fullName", x: 0.5, y: 0.4, align: "center", fontSize: 22 }],
    });
    expect(res.statusCode).toBe(200);
    const cert = (await readBack(w)).credentialTypes[0].certificate as Record<string, unknown>;
    expect(cert.background).toEqual({ documentId: doc.id, sha256: doc.sha256 });
    expect(cert.placements).toHaveLength(1);
  });

  it("an OrgAdmin of a DIFFERENT org is refused", async () => {
    const w = await world();
    const res = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [] });
    expect(res.statusCode).toBe(200); // control: the owner still passes
    // The foreign admin must live in THIS app instance — a second `world()`
    // builds a separate app whose tokens this one has never issued, so a 403
    // from it would prove nothing about ownership.
    const tag = Math.random().toString(36).slice(2, 10);
    const foreignOrg = await w.h.organizations.create({
      name: `Foreign ${tag}`, orgType: "issuer", registrationId: null, jurisdiction: null,
      did: `did:key:zF${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
      verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
    });
    await w.h.users.create({
      email: `foreign-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`foreign-${tag}`, TEST_ROUNDS),
      role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved",
      kyc: null, orgId: foreignOrg.id, kind: "human",
    });
    const foreign = await loginAs(w.h.app, `foreign-${tag}@tokenlayer.dev`, `foreign-${tag}`);
    const denied = await design(w, foreign, { credentialType: "CourseCompletion", placements: [] });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("FORBIDDEN");
  });

  it("a use case with a NULL ownerOrgId refuses every OrgAdmin — null is not a match", async () => {
    // The recurring shape: `undefined === undefined` and `null === null` both
    // read as "owned by me" if the guard is written as a bare comparison.
    const w = await world({ ownerOrgId: null });
    const res = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [] });
    expect(res.statusCode).toBe(403);
    // CONTROL: a PlatformAdmin may still design it.
    expect((await design(w, w.platform, { credentialType: "CourseCompletion", placements: [] })).statusCode).toBe(200);
  });

  it("a role that is neither PlatformAdmin nor OrgAdmin is refused, though authScoped admits every human", async () => {
    const w = await world();
    const tag = Math.random().toString(36).slice(2, 10);
    await w.h.users.create({
      email: `holder-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`holder-${tag}`, TEST_ROUNDS),
      role: "Holder", useCaseKey: w.key, accountId: null, active: true, kycStatus: "approved",
      kyc: null, orgId: w.orgId, kind: "human",
    });
    const holder = await loginAs(w.h.app, `holder-${tag}@tokenlayer.dev`, `holder-${tag}`);
    const res = await design(w, holder, { credentialType: "CourseCompletion", placements: [] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("a key without usecases:provision is refused; one with it passes", async () => {
    const w = await world();
    const wrong = await orgKey(w.h, w.orgId, ["credentials:read"]);
    const denied = await design(w, wrong, { credentialType: "CourseCompletion", placements: [] });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "usecases:provision" } });

    const right = await orgKey(w.h, w.orgId, ["usecases:provision"]);
    expect((await design(w, right, { credentialType: "CourseCompletion", placements: [] })).statusCode).toBe(200);
  });

  it("a tl_test_ key may not design a LIVE use case", async () => {
    const w = await world();
    const testKey = await orgKey(w.h, w.orgId, ["usecases:provision"], "test");
    const res = await design(w, testKey, { credentialType: "CourseCompletion", placements: [] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("WRONG_MODE");
  });

  it("404s an unknown use case and an unknown credential type", async () => {
    const w = await world();
    const noKey = await w.h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/nope-nope/certificate`,
      headers: auth(w.orgAdmin), payload: { credentialType: "CourseCompletion", placements: [] },
    });
    expect(noKey.statusCode).toBe(404);
    const noType = await design(w, w.orgAdmin, { credentialType: "NotAType", placements: [] });
    expect(noType.statusCode).toBe(404);
    expect(noType.json().message).toContain("NotAType");
  });

  it("changes NOTHING but the certificate, whatever else the body carries", async () => {
    const w = await world();
    const before = await readBack(w);
    const res = await design(w, w.orgAdmin, {
      credentialType: "CourseCompletion",
      placements: [{ field: "claim:fullName", x: 0.2, y: 0.2 }],
      // Every one of these is a field the definition PATCH would honour.
      key: "hijacked", sandbox: true, ownerOrgId: "org_someone_else",
      issuer: { kind: "platform" }, holderPolicy: { who: "specific", orgIds: [] },
      credentialTypes: [], name: "Renamed",
    });
    expect(res.statusCode).toBe(200);
    const after = await readBack(w);
    expect(after.ownerOrgId).toBe(before.ownerOrgId);
    expect(after.issuer).toEqual(before.issuer);
    expect(after.sandbox ?? false).toBe(before.sandbox ?? false);
    expect(after.credentialTypes.map((c) => c.name)).toEqual(before.credentialTypes.map((c) => c.name));
    expect((await w.h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/hijacked`, headers: auth(w.platform) })).statusCode).toBe(404);
  });

  it("requires the pin, and refuses a mismatch, a missing document and a non-image", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    const text = await storeDoc(w.h, "text/plain", Buffer.from("nope").toString("base64"));

    const noPin = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: { documentId: doc.id } });
    expect(noPin.statusCode).toBe(400);
    expect(noPin.json().error).toBe("BACKGROUND_PIN_REQUIRED");

    const wrongPin = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: { documentId: doc.id, sha256: "d".repeat(64) } });
    expect(wrongPin.json().error).toBe("BACKGROUND_DOCUMENT_MISMATCH");

    const missing = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: { documentId: "doc_nope", sha256: "e".repeat(64) } });
    expect(missing.json().error).toBe("BACKGROUND_DOCUMENT_NOT_FOUND");

    const notImage = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: { documentId: text.id, sha256: text.sha256 } });
    expect(notImage.json().error).toBe("BACKGROUND_NOT_AN_IMAGE");
  });

  it("omitting a field leaves it alone; null background clears the artwork; [] clears placements", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    await design(w, w.orgAdmin, {
      credentialType: "CourseCompletion",
      background: { documentId: doc.id, sha256: doc.sha256 },
      placements: [{ field: "claim:fullName", x: 0.5, y: 0.4 }],
    });

    // Placements only — the artwork stays.
    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [{ field: "claim:grade", x: 0.6, y: 0.6 }] });
    let cert = (await readBack(w)).credentialTypes[0].certificate as Record<string, unknown>;
    expect((cert.background as { documentId: string }).documentId).toBe(doc.id);
    expect(cert.placements).toHaveLength(1);

    // Artwork cleared — placements survive, inert, exactly as an instantiated
    // template lands.
    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: null });
    cert = (await readBack(w)).credentialTypes[0].certificate as Record<string, unknown>;
    expect(cert.background).toBeUndefined();
    expect(cert.placements).toHaveLength(1);

    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [] });
    cert = (await readBack(w)).credentialTypes[0].certificate as Record<string, unknown>;
    expect(cert.placements).toEqual([]);
  });

  it("refuses a malformed placement with the placement code, naming the chip", async () => {
    const w = await world();
    const res = await design(w, w.orgAdmin, {
      credentialType: "CourseCompletion",
      placements: [{ field: "claim:fullName", x: 0.5, y: 0.5 }, { field: "claim:nope", x: 0.1, y: 0.1 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_CERTIFICATE_PLACEMENT");
    expect(res.json().message).toContain("[1]");
  });

  it("never toggles `enabled` on a type that has a certificate block, and creates one enabled when it does not", async () => {
    const w = await world();
    // The seeded type has { enabled: true }; turn it off through the platform
    // door, then design and confirm the design did not turn it back on.
    const full = (await readBack(w)) as unknown as Record<string, unknown>;
    const types = (full.credentialTypes as Array<Record<string, unknown>>).map((c) => ({ ...c, certificate: { enabled: false } }));
    const off = await w.h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${w.key}`, headers: auth(w.platform),
      payload: { ...full, credentialTypes: types },
    });
    expect(off.statusCode).toBe(200);
    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [{ field: "claim:fullName", x: 0.1, y: 0.1 }] });
    expect(((await readBack(w)).credentialTypes[0].certificate as { enabled: boolean }).enabled).toBe(false);

    // And with no block at all, designing creates one that is enabled —
    // otherwise the org has produced dead config it cannot turn on.
    const bare = (await readBack(w)) as unknown as Record<string, unknown>;
    const stripped = (bare.credentialTypes as Array<Record<string, unknown>>).map(({ certificate, ...rest }) => { void certificate; return rest; });
    expect((await w.h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${w.key}`, headers: auth(w.platform),
      payload: { ...bare, credentialTypes: stripped },
    })).statusCode).toBe(200);
    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [{ field: "claim:fullName", x: 0.1, y: 0.1 }] });
    expect(((await readBack(w)).credentialTypes[0].certificate as { enabled: boolean }).enabled).toBe(true);
  });
});
```

Add the org-key helper near `storeDoc` at the top of the file (it is used by two of the tests above and again in Task 4):

```ts
/** An org-scoped API key of the given mode, bound to a service OrgAdmin. */
async function orgKey(h: TestAppHandle, orgId: string, scopes: string[], mode: "live" | "test" = "live"): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 10);
  const svc = await h.users.create({
    email: `svc-design-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`unguessable-${tag}`, TEST_ROUNDS),
    role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved",
    kyc: null, orgId, kind: "service",
  });
  const minted = await mintSecret(TEST_ROUNDS, mode);
  await h.apiKeys.create({
    orgId, userId: svc.id, name: `key ${tag}`, prefix: minted.prefix, secretHash: minted.hash,
    scopes, expiresAt: null, createdBy: "test", mode,
  });
  return minted.secret;
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && npx vitest run test/certificate-org-design.test.ts
```

Expected: FAIL — every `PATCH …/certificate` call 404s, because the route does not exist.

- [ ] **Step 3: Add the shared ownership gate**

In `apps/api/src/http/routes.ts`, immediately after the `preview-certificate` route handler closes (currently line 1325) and before the `createCredentialUseCaseFromDef` comment, insert:

```ts
  /**
   * The credential use case a caller may DESIGN CERTIFICATES for, or null when
   * it has already been refused (this helper replies, so a caller that forgets
   * to act on the null cannot leak a second reply).
   *
   * THREE CHECKS, AND EACH ONE HAS BEEN THE MISSING ONE SOMEWHERE IN THIS FILE.
   *
   * 1. THE ROLE. `authScoped` composes `requireScope`, which short-circuits on
   *    `if (!key) return` — scopes are a property of API KEYS, so a human JWT
   *    session passes it unconditionally. Without an explicit role predicate
   *    these routes would be open to every authenticated user, which is exactly
   *    what the EN-F final review proved on `preview-certificate` by walking a
   *    seeded tokenization Buyer through it.
   *
   * 2. THE MODE. `modeGate` against the STORED record, so a `tl_test_` key
   *    cannot edit a live programme's certificates and vice versa.
   *
   * 3. THE OWNER, guarded on `claims.orgId` FIRST. A legacy or platform-owned
   *    record carries `ownerOrgId: null` and a caller without an org carries
   *    `orgId: undefined`/`null`; written as a bare `===` those two answer
   *    "owned by me" for a use case nobody owns. Null-as-allow is the shape
   *    EN-B, EN-D2 and EN-F each produced once, so the emptiness check comes
   *    before the comparison rather than being implied by it.
   */
  async function ownedCredentialUseCase(
    request: FastifyRequest, reply: FastifyReply, key: string,
  ): Promise<CredentialUseCaseDefinition | null> {
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin" && claims.role !== "OrgAdmin") {
      await reply.code(403).send({ error: "FORBIDDEN", message: "only a platform admin or org admin may design certificates" });
      return null;
    }
    const existing = await deps.credentialUseCases.get(key);
    if (!existing) { notFound(reply, "credential use case not found"); return null; }
    if (!modeGate(request, reply, existing)) return null;
    if (claims.role !== "PlatformAdmin") {
      const orgId = typeof claims.orgId === "string" ? claims.orgId.trim() : "";
      if (!orgId || existing.ownerOrgId !== orgId) {
        await reply.code(403).send({ error: "FORBIDDEN", message: `credential use case '${key}' is owned by another organization` });
        return null;
      }
    }
    return existing;
  }
```

- [ ] **Step 4: Add the route**

Directly below `ownedCredentialUseCase`, insert:

```ts
  /**
   * EN-F follow-up: THE ORG'S OWN DOOR ONTO ITS OWN CERTIFICATE DESIGN.
   *
   * EN-F shipped the designer and left `background` writable only through
   * `POST`/`PATCH /credential-use-cases`, both PlatformAdmin-only — while the
   * org self-service path (`provision`) instantiates a template, which drops
   * artwork on purpose. So "let an issuing organization upload their own
   * certificate artwork" was delivered as "the platform operator does it for
   * them". This is the missing door, and it is deliberately NOT the definition
   * PATCH opened up: issuer binding, holder policy and claim schemas stay
   * platform-governed.
   *
   * THE DEFINITION WRITTEN IS THE STORED ONE. Only
   * `credentialTypes[i].certificate.{background,placements}` is taken from the
   * body; `key`, `sandbox`, `ownerOrgId` and every binding are read back from
   * storage, so an extra field in the request is inert rather than trusted.
   *
   * Absent means UNCHANGED and explicit means CLEAR — `background: null` drops
   * the artwork (reverting to the built-in layout) and `placements: []` empties
   * the layout. Without the distinction there is no way to remove artwork here,
   * and reverting is a thing an org legitimately wants.
   */
  app.patch("/credential-use-cases/:key/certificate", { schema: S.updateCertificateDesign, ...authScoped("usecases:provision") }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const existing = await ownedCredentialUseCase(request, reply, key);
    if (!existing) return reply;
    const b = request.body as {
      credentialType: string;
      background?: { documentId: string; sha256?: string } | null;
      placements?: unknown;
    };
    const index = existing.credentialTypes.findIndex((t) => t.name === b.credentialType);
    if (index < 0) return notFound(reply, `unknown credential type '${b.credentialType}' in use case '${key}'`);
    const type = existing.credentialTypes[index] as CredentialTypeSpec;

    if (b.placements !== undefined) {
      // The same validator both existing doors call, so a design that saves
      // here cannot be one the definition PATCH would have refused.
      try {
        validateCertificatePlacements(b.placements, Object.keys(type.claimSchema.properties), type.name);
      } catch (err) {
        return reply.code(400).send({ error: "INVALID_CERTIFICATE_PLACEMENT", message: (err as Error).message });
      }
    }
    if (b.background) {
      const problem = await checkBackgroundDocument(b.background, { requirePin: true });
      if (problem) return reply.code(400).send(problem);
    }

    // `enabled` is preserved when a block exists and never toggled here. With
    // NO block, one is created enabled: the render route requires
    // `enabled === true`, an OrgAdmin cannot set it any other way, and refusing
    // would rebuild the dead end this route exists to remove.
    const current = type.certificate;
    const certificate = {
      ...(current ?? { enabled: true }),
      ...(b.background === undefined ? {} : b.background === null ? { background: undefined } : { background: b.background }),
      ...(b.placements === undefined ? {} : { placements: b.placements as CertificateFieldPlacement[] }),
    };
    if (certificate.background === undefined) delete (certificate as { background?: unknown }).background;

    const credentialTypes = existing.credentialTypes.map((t, i) => (i === index ? { ...t, certificate } : t));
    const def: CredentialUseCaseDefinition = { ...existing, credentialTypes };
    // The second door, unchanged: a narrow route that skipped the whole-
    // definition validator would be a cheaper way into the store than the front
    // one.
    const known = await referencedOrgs(def);
    try {
      validateCredentialUseCase(def, { orgExists: (id) => known.has(id) });
    } catch (err) {
      return reply.code(400).send({ error: "INVALID_CREDENTIAL_USECASE", message: (err as Error).message });
    }
    const updated = await deps.credentialUseCases.update(key, def);
    await deps.audit.append({
      actorId: (request.user as TokenClaims).id,
      action: "credential-usecase-updated" as LifecycleAction,
      payload: { key, credentialType: type.name, certificateDesign: true },
    });
    return reply.code(200).send(updated);
  });
```

`CredentialTypeSpec` and `validateCertificatePlacements` are already imported at the top of `routes.ts` for the preview route. If `CertificateFieldPlacement` is not, add it to that same `@tokenlayer/core` import.

- [ ] **Step 5: Add the schema**

In `apps/api/src/http/schemas.ts`, immediately after the `previewCertificate` entry (which ends at line 1263), insert:

```ts
  updateCertificateDesign: {
    tags: ["Credential Use Cases"], summary: "Set certificate artwork and field placements on a credential use case your organization owns", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope **and** a PlatformAdmin or an OrgAdmin whose organization OWNS this " +
      "credential use case (`ownerOrgId`). The narrow, org-facing counterpart of `PATCH /credential-use-cases/{key}`: " +
      "it writes `certificate.background` and `certificate.placements` on ONE named credential type and nothing " +
      "else — every other field of the definition is read from storage, so sending them changes nothing. Omit a " +
      "field to leave it unchanged; send `background: null` to drop the artwork (reverting to the built-in layout) " +
      "or `placements: []` to clear the layout. `background` must carry the artwork's `sha256` as returned by " +
      "`POST /credential-use-cases/{key}/certificate/artwork`, and the document must be an image: a `documentId` " +
      "alone is a guessable reference. Answers **400** `BACKGROUND_PIN_REQUIRED`, `BACKGROUND_DOCUMENT_NOT_FOUND`, " +
      "`BACKGROUND_DOCUMENT_MISMATCH`, `BACKGROUND_NOT_AN_IMAGE` or `INVALID_CERTIFICATE_PLACEMENT` (which names the " +
      "offending placement index).",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", additionalProperties: true, required: ["credentialType"],
      properties: {
        credentialType: { type: "string", description: "Name of the credential type within this use case." },
        background: {
          type: ["object", "null"], additionalProperties: false, required: ["documentId", "sha256"],
          properties: { documentId: { type: "string" }, sha256: { type: "string" } },
          description: "The stored artwork document and its digest. `null` clears the artwork.",
        },
        placements: { type: "array", items: { type: "object", additionalProperties: true }, description: "Where each field prints, in 0–1 fractions of the page." },
      },
    },
    response: { 200: { $ref: "CredentialUseCase#" }, ...errs(400, 401, 403, 404) },
  },
```

`additionalProperties: true` is deliberate: the route ignores everything it does not name, and a test asserts that. A `false` here would turn an inert field into a 400 and make the "changes nothing else" guarantee depend on the schema rather than on the handler.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run test/certificate-org-design.test.ts
```

Expected: PASS, 15 tests.

- [ ] **Step 7: Run the coverage oracles**

```bash
cd apps/api && npx vitest run test/scope-coverage.test.ts test/mode-coverage.test.ts test/openapi-contract.test.ts test/openapi-visibility.test.ts
```

Expected: PASS. `mode-coverage` recognises `ownedCredentialUseCase` as a helper that both resolves (`credentialUseCases.get(`) and gates (`modeGate(`). If it reports the new route as ungated, the helper's body is not being parsed — check it is declared as a plain `async function` inside `registerRoutes`, not an arrow assigned to a const.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/certificate-org-design.test.ts
git commit -m "feat(api): an org may set certificate artwork on a use case it owns"
```

---

### Task 4: `POST /credential-use-cases/:key/certificate/artwork`

`RbacPolicy` gives `OrgAdmin` only `read`, and `POST /documents` gates on `issue` — so without this door the route from Task 3 is one its target user can never populate. Widening `canReadDoc` is not an option: it is what keeps stored invoice evidence away from tenants.

**Files:**
- Modify: `apps/api/src/http/routes.ts` (after the route from Task 3)
- Modify: `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/certificate-org-design.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/certificate-org-design.test.ts`:

```ts
describe("POST /credential-use-cases/:key/certificate/artwork", () => {
  const upload = (w: World, token: string, payload: unknown) =>
    w.h.app.inject({ method: "POST", url: `${V1}/credential-use-cases/${w.key}/certificate/artwork`, headers: auth(token), payload });

  it("admits an owner OrgAdmin, who the general document store refuses", async () => {
    const w = await world();
    // THE CONTROL, and the reason this route exists: RbacPolicy grants OrgAdmin
    // only `read`, so the general store is closed to them in both directions.
    const store = await w.h.app.inject({
      method: "POST", url: `${V1}/documents`, headers: auth(w.orgAdmin),
      payload: { contentType: "image/png", dataBase64: PNG_2x1_B64 },
    });
    expect(store.statusCode).toBe(403);

    const res = await upload(w, w.orgAdmin, { contentType: "image/png", dataBase64: PNG_2x1_B64 });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { documentId: string; sha256: string; size: number };
    expect(body.documentId).toBeTruthy();
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);

    // And what it returns is directly usable as the pin.
    const set = await design(w, w.orgAdmin, {
      credentialType: "CourseCompletion",
      background: { documentId: body.documentId, sha256: body.sha256 },
    });
    expect(set.statusCode).toBe(200);
  });

  it("refuses a non-image upload — this door is for artwork only", async () => {
    const w = await world();
    const res = await upload(w, w.orgAdmin, { contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4").toString("base64") });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe("UNSUPPORTED_DOCUMENT_TYPE");
  });

  it("refuses a foreign org, an unknown key, and a non-admin role", async () => {
    const w = await world();
    const tag = Math.random().toString(36).slice(2, 10);
    const foreignOrg = await w.h.organizations.create({
      name: `Foreign U ${tag}`, orgType: "issuer", registrationId: null, jurisdiction: null,
      did: `did:key:zFU${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
      verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
    });
    await w.h.users.create({
      email: `foreign-u-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`foreign-u-${tag}`, TEST_ROUNDS),
      role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved",
      kyc: null, orgId: foreignOrg.id, kind: "human",
    });
    const foreign = await loginAs(w.h.app, `foreign-u-${tag}@tokenlayer.dev`, `foreign-u-${tag}`);
    expect((await upload(w, foreign, { contentType: "image/png", dataBase64: PNG_2x1_B64 })).statusCode).toBe(403);

    const unknown = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/nope-nope/certificate/artwork`,
      headers: auth(w.orgAdmin), payload: { contentType: "image/png", dataBase64: PNG_2x1_B64 },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && npx vitest run test/certificate-org-design.test.ts -t "certificate/artwork"
```

Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Add the route**

In `apps/api/src/http/routes.ts`, immediately after the `PATCH …/certificate` route from Task 3:

```ts
  /**
   * ARTWORK UPLOAD, SCOPED BY THE USE CASE IT IS FOR.
   *
   * `RbacPolicy` grants `OrgAdmin` exactly one action — `read` — so
   * `POST /documents` (gated on `issue`) and `GET /documents/:id` (gated on
   * `canReadDoc`) are both closed to the very role this feature is for.
   * Organizations reach the store today only through
   * `POST /orgs/register/documents`, which is public because it runs before the
   * org exists.
   *
   * WIDENING `canReadDoc` WAS THE WRONG FIX: it is what keeps stored off-ledger
   * invoice evidence away from tenants. So the capability is bounded by the use
   * case instead — you may upload artwork for a programme you own, and the
   * upload allowlist here is narrower than the store's (images only), because
   * this door exists for artwork and nothing else.
   */
  app.post("/credential-use-cases/:key/certificate/artwork", {
    schema: S.uploadCertificateArtwork,
    bodyLimit: DOC_UPLOAD_BODY_LIMIT,
    ...authScoped("usecases:provision"),
  }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const existing = await ownedCredentialUseCase(request, reply, key);
    if (!existing) return reply;
    const b = request.body as { contentType: string; dataBase64: string };
    if (!b?.contentType?.startsWith("image/")) {
      return reply.code(415).send({ error: "UNSUPPORTED_DOCUMENT_TYPE", message: "certificate artwork must be an image (image/png, image/jpeg, image/webp)" });
    }
    // Reuses the shared storer, so size caps, the empty-body refusal and the
    // store's own allowlist cannot drift from the general upload route.
    const doc = await storeUploadedDocument(deps.documents, b);
    return reply.code(201).send({ documentId: doc.id, sha256: doc.sha256, size: doc.size });
  });
```

- [ ] **Step 4: Add the schema**

In `apps/api/src/http/schemas.ts`, after `updateCertificateDesign`:

```ts
  uploadCertificateArtwork: {
    tags: ["Credential Use Cases"], summary: "Upload certificate artwork for a credential use case your organization owns", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope **and** a PlatformAdmin or an OrgAdmin whose organization OWNS this " +
      "credential use case. Stores an image and returns the `documentId` + `sha256` to pass to " +
      "`PATCH /credential-use-cases/{key}/certificate`. This door exists because the general document store " +
      "(`POST /documents`) is restricted to issue-capable roles, which an Org Admin is not; the capability here is " +
      "bounded by the use case you own. Images only — anything else answers **415** " +
      "`UNSUPPORTED_DOCUMENT_TYPE`.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["contentType", "dataBase64"],
      properties: {
        contentType: { type: "string", description: "`image/png`, `image/jpeg` or `image/webp`." },
        dataBase64: { type: "string", description: "The image bytes, base64-encoded. Max 5 MB decoded." },
      },
    },
    response: {
      201: {
        type: "object",
        properties: { documentId: { type: "string" }, sha256: { type: "string" }, size: { type: "integer" } },
      },
      ...errs(400, 401, 403, 404, 413, 415),
    },
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run test/certificate-org-design.test.ts
```

Expected: PASS, 18 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/certificate-org-design.test.ts
git commit -m "feat(api): scoped artwork upload for a credential use case an org owns"
```

---

### Task 5: `GET /credential-use-cases/:key/certificate/artwork`

The designer canvas has to display artwork already saved on a use case when the panel is reopened. `GET /documents/:id` is closed to OrgAdmins, so this serves the bytes of the document **that credential type's `background` currently names** — no document id is accepted from the caller, which is what keeps an unreferenced document unreachable.

**Files:**
- Modify: `apps/api/src/http/routes.ts` (after the route from Task 4)
- Modify: `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/certificate-org-design.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/certificate-org-design.test.ts`:

```ts
describe("GET /credential-use-cases/:key/certificate/artwork", () => {
  const fetchArt = (w: World, token: string, type: string) =>
    w.h.app.inject({
      method: "GET",
      url: `${V1}/credential-use-cases/${w.key}/certificate/artwork?credentialType=${encodeURIComponent(type)}`,
      headers: auth(token),
    });

  it("serves the artwork the type currently names, pinned and un-sniffable", async () => {
    const w = await world();
    const up = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${w.key}/certificate/artwork`,
      headers: auth(w.orgAdmin), payload: { contentType: "image/png", dataBase64: PNG_2x1_B64 },
    });
    const { documentId, sha256 } = up.json() as { documentId: string; sha256: string };
    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: { documentId, sha256 } });

    const res = await fetchArt(w, w.orgAdmin, "CourseCompletion");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.rawPayload.equals(Buffer.from(PNG_2x1_B64, "base64"))).toBe(true);
  });

  it("404s when the type carries no artwork, and when the type is unknown", async () => {
    const w = await world();
    expect((await fetchArt(w, w.orgAdmin, "CourseCompletion")).statusCode).toBe(404);
    expect((await fetchArt(w, w.orgAdmin, "NotAType")).statusCode).toBe(404);
  });

  it("refuses a foreign org — the use case you own IS the capability", async () => {
    const w = await world();
    const up = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${w.key}/certificate/artwork`,
      headers: auth(w.orgAdmin), payload: { contentType: "image/png", dataBase64: PNG_2x1_B64 },
    });
    const { documentId, sha256 } = up.json() as { documentId: string; sha256: string };
    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: { documentId, sha256 } });

    const tag = Math.random().toString(36).slice(2, 10);
    const foreignOrg = await w.h.organizations.create({
      name: `Foreign G ${tag}`, orgType: "issuer", registrationId: null, jurisdiction: null,
      did: `did:key:zFG${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
      verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
    });
    await w.h.users.create({
      email: `foreign-g-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`foreign-g-${tag}`, TEST_ROUNDS),
      role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved",
      kyc: null, orgId: foreignOrg.id, kind: "human",
    });
    const foreign = await loginAs(w.h.app, `foreign-g-${tag}@tokenlayer.dev`, `foreign-g-${tag}`);
    expect((await fetchArt(w, foreign, "CourseCompletion")).statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && npx vitest run test/certificate-org-design.test.ts -t "GET /credential-use-cases"
```

Expected: FAIL — 404 from a missing route (the "404s when the type carries no artwork" case passes for the wrong reason; the first test's 200 is what proves the route exists).

- [ ] **Step 3: Add the route**

In `apps/api/src/http/routes.ts`, immediately after the artwork POST from Task 4:

```ts
  /**
   * The artwork back, for the designer canvas when a saved design is reopened.
   *
   * IT ACCEPTS NO DOCUMENT ID. The caller names a credential type, and what is
   * served is whatever that type's `background` currently points at — so the
   * use case you own is the whole capability, and a stored document that no
   * design references is unreachable through this route. Handing it an id
   * instead would rebuild, behind an ownership check, the same
   * "any id, no ownership" read that made `background.documentId` worth pinning.
   *
   * A just-uploaded file needs no round trip: the browser still holds the
   * `File` and can render it from a local object URL.
   */
  app.get("/credential-use-cases/:key/certificate/artwork", { schema: S.getCertificateArtwork, ...authScoped("usecases:provision") }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const existing = await ownedCredentialUseCase(request, reply, key);
    if (!existing) return reply;
    const typeName = (request.query as { credentialType?: string }).credentialType ?? "";
    const type = existing.credentialTypes.find((t) => t.name === typeName);
    if (!type) return notFound(reply, `unknown credential type '${typeName}' in use case '${key}'`);
    const documentId = type.certificate?.background?.documentId;
    if (!documentId) return notFound(reply, `credential type '${typeName}' has no certificate artwork`);
    const doc = await deps.documents.get(documentId).catch(() => null);
    if (!doc) return notFound(reply, "certificate artwork document not found");
    // Same headers `GET /documents/:id` sends: pin the stored (allowlisted)
    // type and forbid sniffing, so stored bytes can never execute as the API
    // origin. Served INLINE rather than as an attachment — this one is meant to
    // be rendered into an <img>.
    return reply
      .header("content-type", doc.contentType)
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `inline; filename="artwork-${documentId}"`)
      .send(doc.bytes);
  });
```

- [ ] **Step 4: Add the schema**

In `apps/api/src/http/schemas.ts`, after `uploadCertificateArtwork`:

```ts
  getCertificateArtwork: {
    tags: ["Credential Use Cases"], summary: "Fetch the certificate artwork a credential type currently uses", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope **and** a PlatformAdmin or an OrgAdmin whose organization OWNS this " +
      "credential use case. Returns the image bytes that credential type's `certificate.background` names. It takes " +
      "no document id: the use case you own is the capability, so a stored document that no design references is " +
      "not reachable here. **404** when the type carries no artwork.",
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    querystring: {
      type: "object", required: ["credentialType"],
      properties: { credentialType: { type: "string", description: "Name of the credential type within this use case." } },
    },
    // The 200 is opaque image bytes, so there is no field to name — the same
    // deferral `credentialCertificate` and `previewCertificate` already record.
    response: { ...errs(401, 403, 404) },
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run test/certificate-org-design.test.ts
```

Expected: PASS, 21 tests.

- [ ] **Step 6: Regenerate the committed public surface**

```bash
cd apps/api && npx tsx scripts/write-openapi-snapshot.ts
```

Then read the diff and confirm it contains exactly the three new operations and nothing else:

```bash
git diff --stat apps/api/openapi.snapshot.json && git diff apps/api/openapi.snapshot.json | head -80
```

- [ ] **Step 7: Run the full api suite**

```bash
cd apps/api && npx vitest run
```

Expected: PASS, 760 + 21 = 781 tests.

- [ ] **Step 8: Typecheck**

```bash
cd apps/api && npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/certificate-org-design.test.ts apps/api/openapi.snapshot.json
git commit -m "feat(api): serve a credential type's own certificate artwork to its owner"
```

---

### Task 6: The web client — types, api functions, and the access predicate

**Files:**
- Modify: `apps/web/src/types.ts:797`
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/lib/certificate-access.ts`
- Test: `apps/web/test/certificate-access.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/certificate-access.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canDesignCertificate } from "../src/lib/certificate-access.js";

const useCase = (ownerOrgId: string | null | undefined) => ({ ownerOrgId }) as never;

describe("canDesignCertificate — the web mirror of the server's ownership gate", () => {
  it("a PlatformAdmin may design any use case, owned or not", () => {
    expect(canDesignCertificate({ role: "PlatformAdmin", orgId: null }, useCase(null))).toBe(true);
    expect(canDesignCertificate({ role: "PlatformAdmin", orgId: "org_1" }, useCase("org_2"))).toBe(true);
  });

  it("an OrgAdmin may design only their own org's use case", () => {
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: "org_1" }, useCase("org_1"))).toBe(true);
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: "org_1" }, useCase("org_2"))).toBe(false);
  });

  it("a null owner is nobody's — the null-as-allow shape the server guards against", () => {
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: "org_1" }, useCase(null))).toBe(false);
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: null }, useCase(null))).toBe(false);
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: undefined }, useCase(undefined))).toBe(false);
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: "  " }, useCase("  "))).toBe(false);
  });

  it("no other role, and no user at all", () => {
    expect(canDesignCertificate({ role: "Issuer", orgId: "org_1" }, useCase("org_1"))).toBe(false);
    expect(canDesignCertificate({ role: "Holder", orgId: "org_1" }, useCase("org_1"))).toBe(false);
    expect(canDesignCertificate(null, useCase("org_1"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && npx vitest run test/certificate-access.test.ts
```

Expected: FAIL — cannot resolve `../src/lib/certificate-access.js`.

- [ ] **Step 3: Write the predicate**

Create `apps/web/src/lib/certificate-access.ts`:

```ts
import type { CredentialUseCase, Role } from "../types.js";

/**
 * May this user open the certificate designer for this credential use case?
 *
 * The mirror of the server's gate on
 * `PATCH /credential-use-cases/:key/certificate` — INCLUDING the emptiness
 * check before the comparison. A use case with `ownerOrgId: null` (legacy, or
 * platform-owned) belongs to nobody, and a user with no `orgId` matches nobody;
 * written as a bare `===`, those two agree that a use case nobody owns is
 * theirs. Showing the control would only produce a 403 on save, but the same
 * mistake on the server is a cross-tenant write, so the shape is kept identical
 * on both sides rather than approximated here.
 */
export function canDesignCertificate(
  user: { role: Role | string; orgId?: string | null } | null | undefined,
  useCase: Pick<CredentialUseCase, "ownerOrgId">,
): boolean {
  if (!user) return false;
  if (user.role === "PlatformAdmin") return true;
  if (user.role !== "OrgAdmin") return false;
  const orgId = typeof user.orgId === "string" ? user.orgId.trim() : "";
  const owner = typeof useCase.ownerOrgId === "string" ? useCase.ownerOrgId.trim() : "";
  return orgId !== "" && owner !== "" && orgId === owner;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && npx vitest run test/certificate-access.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Mirror `sha256` into the web types**

In `apps/web/src/types.ts`, replace line 797:

```ts
  background?: { documentId: string; sha256?: string };
```

- [ ] **Step 6: Add the three api functions**

In `apps/web/src/api.ts`, immediately after `previewCertificate` (which ends at line 132), insert:

```ts
  /** Set artwork + placements on ONE credential type of a use case the caller's
   *  org owns. Writes nothing else on the definition — see the route's own
   *  comment for why that is the point. */
  updateCertificateDesign: (
    token: string,
    key: string,
    body: { credentialType: string; background?: { documentId: string; sha256: string } | null; placements?: CertificateFieldPlacement[] },
  ) =>
    request<CredentialUseCase>(`/credential-use-cases/${encodeURIComponent(key)}/certificate`, token, {
      method: "PATCH", body: JSON.stringify(body),
    }),
  /** Store certificate artwork for a use case the caller's org owns.
   *  `POST /documents` is closed to an OrgAdmin (it is gated on `issue`), so
   *  this is the door an organization actually has. */
  uploadCertificateArtwork: (token: string, key: string, contentType: string, dataBase64: string) =>
    request<{ documentId: string; sha256: string; size: number }>(
      `/credential-use-cases/${encodeURIComponent(key)}/certificate/artwork`, token,
      { method: "POST", body: JSON.stringify({ contentType, dataBase64 }) },
    ),
  /** The artwork a saved design currently uses, for the designer canvas. */
  certificateArtwork: async (token: string, key: string, credentialType: string): Promise<Blob> => {
    const res = await fetch(
      `${BASE}/credential-use-cases/${encodeURIComponent(key)}/certificate/artwork?credentialType=${encodeURIComponent(credentialType)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const text = await res.text();
      let body: { message?: string; error?: string } | null = null;
      try { body = text ? (JSON.parse(text) as { message?: string; error?: string }) : null; } catch { /* non-JSON error body */ }
      throw new ApiError(body?.message ?? body?.error ?? res.statusText, res.status, body?.error);
    }
    return res.blob();
  },
```

If `CertificateFieldPlacement` is not already imported in `apps/web/src/api.ts`, add it to the existing `./types.js` import.

- [ ] **Step 7: Typecheck and run the web suite**

```bash
cd apps/web && npx tsc --noEmit && npx vitest run
```

Expected: no tsc output; vitest PASS, 138 + 4 = 142 tests.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/lib/certificate-access.ts apps/web/test/certificate-access.test.ts
git commit -m "feat(web): api client and access predicate for org-scoped certificate design"
```

---

### Task 7: The `CertificateDesignPanel` component

**Files:**
- Create: `apps/web/src/components/CertificateDesignPanel.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/CertificateDesignPanel.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import { withoutStalePlacements } from "../lib/certificate-layout.js";
import type { CertificateFieldPlacement, CredentialUseCase } from "../types.js";
import { CertificateDesigner } from "./CertificateDesigner.js";
import { Card, SectionHeader } from "./ui.js";

export interface CertificateDesignPanelProps {
  useCase: CredentialUseCase;
  credentialTypeName: string;
  onSaved: () => void;
  onClose: () => void;
}

/**
 * The org-facing certificate designer: artwork + placements on ONE credential
 * type of a use case the caller's organization owns.
 *
 * Distinct from `CredentialUseCaseBuilder`, which hosts the same designer
 * inside a PlatformAdmin-only create wizard whose save writes the whole
 * definition. This one edits a SAVED use case through the narrow route, so an
 * OrgAdmin can change their artwork without being able to change their issuer
 * binding.
 */
export function CertificateDesignPanel(props: CertificateDesignPanelProps): JSX.Element {
  const { token } = useAuth();
  const { useCase, credentialTypeName } = props;
  const type = useCase.credentialTypes.find((t) => t.name === credentialTypeName);
  const cert = type?.certificate;

  const [placements, setPlacements] = useState<CertificateFieldPlacement[]>(cert?.placements ?? []);
  const [background, setBackground] = useState<{ documentId: string; sha256: string } | null>(
    cert?.background?.documentId && cert.background.sha256
      ? { documentId: cert.background.documentId, sha256: cert.background.sha256 }
      : null,
  );
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const claimKeys = Object.keys(type?.claimSchema?.properties ?? {});

  /**
   * Every object URL pins its blob until revoked, and this panel can outlive
   * several uploads. The ref mirrors the current URL so the UNMOUNT cleanup
   * revokes the latest one — an effect depending on the state would instead
   * revoke each URL the moment the next upload replaced it, while the canvas was
   * still displaying it. (Same reasoning as `CredentialUseCaseBuilder`.)
   */
  const artworkUrlRef = useRef<string | null>(null);
  artworkUrlRef.current = artworkUrl;
  useEffect(() => () => { if (artworkUrlRef.current) URL.revokeObjectURL(artworkUrlRef.current); }, []);

  // Reopening a SAVED design: the bytes come from the scoped artwork route,
  // because `GET /documents/:id` is closed to an OrgAdmin. A just-uploaded file
  // never goes through here — the browser still holds it.
  const fetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!token || !cert?.background?.documentId) return;
    if (fetchedFor.current === cert.background.documentId) return;
    fetchedFor.current = cert.background.documentId;
    void api
      .certificateArtwork(token, useCase.key, credentialTypeName)
      .then((b) => setArtworkUrl(URL.createObjectURL(b)))
      // Retryable: a dangling reference renders the empty canvas rather than an
      // error, and clearing the mark lets a later render try again.
      .catch(() => { fetchedFor.current = null; });
  }, [token, useCase.key, credentialTypeName, cert?.background?.documentId]);

  async function uploadArtwork(file: File): Promise<void> {
    if (!token) return;
    setError(null);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let n = 0; n < bytes.length; n++) bin += String.fromCharCode(bytes[n] as number);
    try {
      const r = await api.uploadCertificateArtwork(token, useCase.key, file.type, btoa(bin));
      setBackground({ documentId: r.documentId, sha256: r.sha256 });
      // Shown from the local File: no round trip, and it is the same bytes.
      if (artworkUrlRef.current) URL.revokeObjectURL(artworkUrlRef.current);
      setArtworkUrl(URL.createObjectURL(file));
      setSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "artwork upload failed");
    }
  }

  async function preview(): Promise<void> {
    if (!token || !type) return;
    setError(null);
    try {
      const blob = await api.previewCertificate(token, {
        credentialType: {
          ...type,
          certificate: {
            ...(cert ?? { enabled: true }),
            ...(background ? { background } : {}),
            placements: withoutStalePlacements(placements, claimKeys),
          },
        },
      });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      // Revoking immediately would race the new tab's own load of the blob.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "preview failed");
    }
  }

  async function save(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateCertificateDesign(token, useCase.key, {
        credentialType: credentialTypeName,
        background,
        // A placement whose claim was renamed or deleted after it was placed
        // would make the server refuse the whole design; it could not print
        // anything either way. The designer warns about these, so dropping them
        // here is never the first the author hears of it.
        placements: withoutStalePlacements(placements, claimKeys),
      });
      setSaved(true);
      props.onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  if (!type) {
    return (
      <Card>
        <p className="text-xs text-slate-500">This use case has no credential type named “{credentialTypeName}”.</p>
      </Card>
    );
  }

  return (
    <div>
      <SectionHeader
        title={`Certificate design — ${type.title || type.name}`}
        description={`Artwork and field placement for ${useCase.name}. The certificate PDF a holder downloads is your design; only the fields you place are printed on it.`}
        actions={
          <button
            onClick={props.onClose}
            className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700"
          >
            ← Back to list
          </button>
        }
      />
      <Card>
        <CertificateDesigner
          backgroundDocumentId={background?.documentId ?? null}
          artworkObjectUrl={artworkUrl}
          placements={placements}
          claimKeys={claimKeys}
          onChange={setPlacements}
          onUploadArtwork={(file) => { void uploadArtwork(file); }}
          onPreview={() => { void preview(); }}
        />
        <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => { void save(); }}
            className="rounded-lg bg-brand-600 text-white px-3.5 py-1.5 text-xs font-semibold hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save design"}
          </button>
          {background && (
            <button
              type="button"
              disabled={busy}
              onClick={() => { setBackground(null); setArtworkUrl(null); fetchedFor.current = null; setSaved(false); }}
              className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700"
            >
              Remove artwork
            </button>
          )}
          {saved && <span className="text-[11px] text-emerald-600">Saved.</span>}
          {error && <span className="text-[11px] text-rose-600">{error}</span>}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Removing the artwork reverts this credential type to the built-in certificate layout. Your placements are
          kept and simply stop printing until artwork is uploaded again.
        </p>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Confirm the helpers this file imports actually exist**

```bash
cd apps/web && grep -n "export function withoutStalePlacements" src/lib/certificate-layout.ts && grep -n "export function Card\|export function SectionHeader" src/components/ui.tsx
```

Expected: one hit each. If `withoutStalePlacements` is not exported from `lib/certificate-layout.ts`, find its real name with `grep -n "^export" src/lib/certificate-layout.ts` and use that; do not re-implement it.

- [ ] **Step 3: Typecheck**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: no output. `npm run build` is `vite build` and does NOT typecheck — this command is the check.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/CertificateDesignPanel.tsx
git commit -m "feat(web): a certificate design panel for a use case an org owns"
```

---

### Task 8: The entry point in `IdentityHome`

**Files:**
- Modify: `apps/web/src/components/IdentityHome.tsx`

- [ ] **Step 1: Import the panel and the predicate**

At the top of `apps/web/src/components/IdentityHome.tsx`, add to the existing imports:

```tsx
import { canDesignCertificate } from "../lib/certificate-access.js";
import { CertificateDesignPanel } from "./CertificateDesignPanel.js";
```

- [ ] **Step 2: Add the state and the full-width branch**

After `const [expandedKey, setExpandedKey] = useState<string | null>(null);` (line 30), add:

```tsx
  // The designer needs the full width, so it replaces the list the way the
  // builder and the provisioner do rather than expanding inside a card.
  const [designing, setDesigning] = useState<{ key: string; typeName: string } | null>(null);
```

Then, immediately before the `if (showBuilder) {` block (line 52), add:

```tsx
  const designingUseCase = designing ? useCases?.find((u) => u.key === designing.key) : undefined;
  if (designing && designingUseCase) {
    return (
      <CertificateDesignPanel
        useCase={designingUseCase}
        credentialTypeName={designing.typeName}
        onSaved={reload}
        onClose={() => setDesigning(null)}
      />
    );
  }
```

- [ ] **Step 3: Add the per-credential-type control**

In the card body, replace the credential-type pill row (currently lines 161–165):

```tsx
              <div className="flex flex-wrap gap-1 mt-3">
                {u.credentialTypes.map((ct) => (
                  <Pill key={ct.name} tone="info">{ct.name}</Pill>
                ))}
              </div>
```

with:

```tsx
              <div className="flex flex-wrap items-center gap-1 mt-3">
                {u.credentialTypes.map((ct) => (
                  <span key={ct.name} className="inline-flex items-center gap-1">
                    <Pill tone="info">{ct.name}</Pill>
                    {/* EN-F follow-up: artwork is the ORG's to set on a use case
                        the org owns. Mirrors the server's ownership gate — see
                        `canDesignCertificate`. */}
                    {canDesignCertificate(user, u) && (
                      <button
                        onClick={() => setDesigning({ key: u.key, typeName: ct.name })}
                        title={`Design the ${ct.name} certificate`}
                        className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:border-brand-400 hover:text-brand-700"
                      >
                        Design certificate
                      </button>
                    )}
                  </span>
                ))}
              </div>
```

- [ ] **Step 4: Typecheck and run the web suite**

```bash
cd apps/web && npx tsc --noEmit && npx vitest run
```

Expected: no tsc output; vitest PASS, 142 tests.

- [ ] **Step 5: Build**

```bash
cd apps/web && npm run build
```

Expected: a successful `vite build`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/IdentityHome.tsx
git commit -m "feat(web): an org admin can open the certificate designer from Identity"
```

---

### Task 9: Carry `sha256` through the PlatformAdmin wizard

The create wizard uploads artwork and drops the digest, so a design authored there stores an unpinned `background`. Nothing breaks — the pin is optional on that door — but the two paths should write the same record.

**Files:**
- Modify: `apps/web/src/components/CredentialUseCaseBuilder.tsx` (the `CredTypeDraft` type, `emptyCredType`, `seedFromTemplate` ~line 220, `uploadArtwork` ~line 225, `previewCertificate` ~line 260, `buildDefinition` ~line 300)

- [ ] **Step 1: Find every site that touches `certBackgroundDocumentId`**

```bash
cd apps/web && grep -n "certBackgroundDocumentId" src/components/CredentialUseCaseBuilder.tsx
```

Expected: the draft type, `emptyCredType`, the template seed, `uploadArtwork`, the artwork-fetch effect, `previewCertificate`, `buildDefinition`, and the `CertificateDesigner` props.

- [ ] **Step 2: Add the field beside it at every one of those sites**

- In the `CredTypeDraft` interface, beside `certBackgroundDocumentId: string;` add `certBackgroundSha256: string;`
- In `emptyCredType()`, beside `certBackgroundDocumentId: ""` add `certBackgroundSha256: ""`
- In the template seed (`patchCredType(i, { … certBackgroundDocumentId: cert?.background?.documentId ?? "", … })`) add `certBackgroundSha256: cert?.background?.sha256 ?? "",`
- In `uploadArtwork`, replace `patchCredType(i, { certBackgroundDocumentId: r.id });` with:

```ts
      patchCredType(i, { certBackgroundDocumentId: r.id, certBackgroundSha256: r.sha256 });
```

- In `previewCertificate`, replace the background spread with:

```ts
            ...(c.certBackgroundDocumentId
              ? { background: { documentId: c.certBackgroundDocumentId, ...(c.certBackgroundSha256 ? { sha256: c.certBackgroundSha256 } : {}) } }
              : {}),
```

- In `buildDefinition`, apply the identical spread wherever it builds `background` from `certBackgroundDocumentId`.

- [ ] **Step 3: Typecheck**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: no output. A missing site shows up here as "Property 'certBackgroundSha256' is missing".

- [ ] **Step 4: Run the web suite and build**

```bash
cd apps/web && npx vitest run && npm run build
```

Expected: PASS, 142 tests; successful build.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/CredentialUseCaseBuilder.tsx
git commit -m "feat(web): the create wizard pins artwork by sha256 too"
```

---

### Task 10: Changelog

**Files:**
- Modify: `docs/api/CHANGELOG.md:66-70`

- [ ] **Step 1: Replace the known-gap note**

In `docs/api/CHANGELOG.md`, replace the paragraph that currently begins **"Today this is configured BY THE PLATFORM OPERATOR."** (lines 66–70) with:

```markdown
**New: `PATCH /credential-use-cases/{key}/certificate`** — `usecases:provision`
plus a PlatformAdmin, or an OrgAdmin whose organization **owns** the use case
(`ownerOrgId`). This is how an organization sets its own artwork. It writes
`certificate.background` and `certificate.placements` on ONE named credential
type and nothing else: every other field of the definition is read from storage,
so sending `issuer`, `sandbox`, `ownerOrgId` or `key` alongside changes none of
them. Omit a field to leave it unchanged; `background: null` drops the artwork
(reverting to the built-in layout) and `placements: []` clears the layout.
Editing the rest of a credential use case remains PlatformAdmin-only.

**New: `POST` / `GET /credential-use-cases/{key}/certificate/artwork`** — same
scope, same ownership rule. `POST` stores an image (images only — anything else
is **415**) and returns `{documentId, sha256}`; `GET ?credentialType=<name>`
returns the bytes that type's design currently uses. These exist because
`POST /documents` and `GET /documents/{id}` are restricted to issue-capable
roles, which an Org Admin is not — the general document store holds off-ledger
invoice evidence, so the capability is bounded by the use case you own rather
than granted over the store.

**`background` now takes an optional `sha256`.** The org route above **requires**
it, and refuses a document that does not exist, does not hash to it, or is not
an image — `documentId` alone is a guessable reference. The three older doors
(`POST`/`PATCH /credential-use-cases` and `preview-certificate`) verify a
`sha256` you supply and refuse a non-image, but still accept a bare
`documentId`, including one naming a document that has since been deleted: that
case degrades to the built-in layout at render time, and that behaviour is
unchanged.
```

- [ ] **Step 2: Check the file still reads correctly around the edit**

```bash
sed -n 55,100p docs/api/CHANGELOG.md
```

Expected: the templates paragraph, then the three new paragraphs, then the `---` and the next entry.

- [ ] **Step 3: Commit**

```bash
git add docs/api/CHANGELOG.md
git commit -m "docs(api): changelog for org-scoped certificate artwork"
```

---

### Task 11: Full verification and the live walkthrough

- [ ] **Step 1: Every suite, from the repo root**

```bash
cd packages/core && npx vitest run
```

Expected: PASS, 286 tests (283 baseline + 3).

```bash
cd apps/api && npx vitest run
```

Expected: PASS, 781 tests (760 baseline + 21).

```bash
cd apps/web && npx vitest run
```

Expected: PASS, 142 tests (138 baseline + 4).

- [ ] **Step 2: Typecheck both apps — `vite build` does not do this**

```bash
npx tsc --noEmit -p apps/api && npx tsc --noEmit -p apps/web
```

Expected: no output from either.

- [ ] **Step 3: Build the web app**

```bash
cd apps/web && npm run build
```

Expected: a successful build.

- [ ] **Step 4: Start the API for the walkthrough**

```bash
cd apps/api && CHAIN_STRICT=0 npx tsx src/server.ts
```

`CHAIN_STRICT=0` skips the boot connectivity probe, which is the fast path when no chain is running. To stop it later, kill by PORT (`lsof -ti:3000 | xargs kill`), never `pkill -f tsx` — that takes down unrelated watchers.

- [ ] **Step 5: Walk it as a real OrgAdmin**

In the browser preview, with the web dev server running:

1. Log in as an OrgAdmin whose org owns a credential use case (provision one from a template first if needed — "Provision from template" on the Identity screen).
2. On the Identity list, confirm **Design certificate** appears next to the credential type for a use case the org owns, and does **not** appear on one it does not.
3. Open it, upload real artwork, place the holder name, one claim, the issue date and the QR.
4. **Preview PDF** — confirm it renders over the artwork and is stamped `SAMPLE — NOT A CREDENTIAL`.
5. **Save design**, reload the page, reopen the panel — the artwork and every chip must come back (this is the scoped `GET …/artwork` doing its job).
6. Issue a credential of that type to a holder, download `certificate.pdf`, and look at it: the design must be the org's, with the QR present.
7. Revoke it and download again — the `REVOKED` watermark must be drawn over the artwork.
8. **Remove artwork**, save, download once more — the built-in layout returns.

- [ ] **Step 6: Prove the refusal by hand**

With the OrgAdmin's bearer token, against a use case owned by a DIFFERENT org:

```bash
curl -i -X PATCH "http://localhost:3000/api/v1/credential-use-cases/<foreign-key>/certificate" \
  -H "authorization: Bearer <org-admin-token>" -H "content-type: application/json" \
  -d '{"credentialType":"<TypeName>","placements":[]}'
```

Expected: `HTTP/1.1 403` with `{"error":"FORBIDDEN", …}`.

- [ ] **Step 7: Commit anything the walkthrough changed, then finish the branch**

Use the `superpowers:finishing-a-development-branch` skill. The whole-branch review comes first and must hunt independently — on every EN sub-project so far it found a real defect, and the recurring shape is a check that answers the wrong question confidently.

---

## Notes for the implementer

- **`authScoped` gates nothing on its own for a human session.** `requireScope` returns early when `request.apiKey` is undefined. Every one of the three new routes therefore goes through `ownedCredentialUseCase`, which carries the role predicate. If you add a fourth, do the same.
- **Never compare `ownerOrgId` to `claims.orgId` without checking both are non-empty first.** `null === null` and `undefined === undefined` are the whole bug.
- **`apps/web` has no DOM test environment.** Put logic in `src/lib/` and test it there; components are verified in the browser.
- **`npm run build` in `apps/web` is `vite build` and does not typecheck.** Run `npx tsc --noEmit -p apps/web` separately, every time.
- **Do not edit `apps/api/test/credential-certificate.test.ts`.** It is the back-compat oracle for the built-in renderer.
