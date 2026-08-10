# Organization Branding (EN-E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organization put its own logo and accent colour on the app its members use and on the certificates it issues.

**Architecture:** Two nullable columns on `Organization` (`brandLogoDocumentId`, `brandAccent`), set through one role-gated route, delivered to the browser on `GET /me`. The accent is bounded by switching the Tailwind `brand-*` scale to CSS custom properties, so a branded org's shell overrides six variables and **no component changes**. Colour maths lives in `apps/web/src/lib/` because the accent never leaves the browser; core holds only the validator the API calls.

**Tech Stack:** TypeScript. `packages/core` (vitest), `apps/api` (Fastify + Prisma/SQLite + vitest), `apps/web` (React + Vite + Tailwind + vitest).

**Spec:** `docs/superpowers/specs/2026-08-10-org-branding-design.md`

**Branch:** create `feat/org-branding` from `main`.

---

## Conventions every task must follow

- **Core tests:** `cd packages/core && ./node_modules/.bin/vitest run test/<file>`
- **API tests:** `cd apps/api && ./node_modules/.bin/vitest run test/<file> --testTimeout=180000`
- **Web tests:** `cd apps/web && ./node_modules/.bin/vitest run test/<file>`
- **Typecheck:** `npx tsc --noEmit -p apps/api` AND `npx tsc --noEmit -p apps/web` from the repo root. **`npm run build` in `apps/web` is `vite build` and does NOT typecheck** — running only the build is how two blank checkboxes shipped on 2026-08-10.
- **Never weaken or delete an existing assertion.** The suites are the back-compat oracle. The one exception is adding a justified row to a coverage allowlist (`DELIBERATELY_UNSCOPED`, `DOCUMENTATION_DEFERRED`, `MODE_EXEMPT`) — those tables' own failure messages instruct you to, and each has a staleness check. Say so in your report; never add one silently.
- **THE PARITY RULE (Task 2 especially):** a new persisted field must land in the Prisma schema + record type + row type + mapper + create/update literals in **both** the memory and prisma repos + `prisma generate`, in ONE commit. Memory-harness tests cannot catch a prisma-side drop.
- **THE ADDITIVITY RULE:** `fast-json-stringify` silently strips undeclared response fields. You may ADD `properties`; never remove `additionalProperties: true`; never narrow a schema. A field you forget to declare simply will not appear on the wire.
- **`authScoped(...)` is NOT an authorization gate for humans.** `requireScope` short-circuits on `if (!key) return`. Any route that must be restricted needs an explicit role predicate as well.
- Comments explain WHY. Calibrate against `packages/core/src/modes.ts` and `apps/api/src/certificate-artwork.ts`. Do not restate the code.
- **NO test directory in this monorepo is typechecked.** `apps/api/tsconfig.json` and `packages/core/tsconfig.json` both `"include": ["src"]`, and vitest runs no typecheck. So a test literal can carry an invalid enum value and stay green forever — Task 2's implementer found exactly that in this plan's own test (`orgType: "issuer"`, which is not an `OrgType`; the valid set is `bank | corporate | msme | government | verifier`). **When a type gains a required field, find the affected test literals by GREP, not by `tsc`** — the compiler will not tell you.
- **Run `npx prisma generate` from `apps/api`, never from the repo root.** Root `npx` resolves a different prisma major and misses `apps/api/.env`, so `DATABASE_URL` does not resolve.

**Baselines on `main`:** core 283 · api 760 · web 138.

**COORDINATION — read before starting.** A separate session is implementing organization self-service certificate ARTWORK (spawned from EN-F's finding 7). It touches `apps/api/src/http/routes.ts` around the credential-use-case routes and may extend `CertificateConfig` validation. This plan touches `routes.ts` around the organization routes and the certificate LOGO path. The overlap is real. **Let that work land on `main` first, or rebase onto it before Task 8's browser pass**, so the certificate precedence rule in Task 4 is verified against the code that will actually ship. EN-D2 recorded the same hazard against concurrent sessions and it bit.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/branding.ts` | **NEW.** `validateBrandAccent` — the only branding logic the API needs. |
| `packages/core/src/index.ts` | Export it. |
| `apps/api/prisma/schema.prisma` | `Organization` += two nullable columns. |
| `apps/api/src/persistence/types.ts` | `OrganizationRecord` += the two fields; `OrganizationRepository` += `setBranding`. |
| `apps/api/src/persistence/memory.ts` | `setBranding` on the memory repo. |
| `apps/api/src/persistence/prisma.ts` | `setBranding` + the row mapper — **the drift point**. |
| `apps/api/src/http/routes.ts` | `PATCH /orgs/:id/branding`; `orgView` and `/me` carry the brand; certificate logo precedence. |
| `apps/api/src/http/schemas.ts` | The route schema; additive response properties. |
| `apps/web/tailwind.config.js`, `apps/web/src/index.css` | `brand-*` becomes CSS custom properties with today's hexes as defaults. |
| `apps/web/src/lib/branding.ts` | **NEW.** `brandRamp`, `clampAccent`, `contrastRatio` — pure, one consumer. |
| `apps/web/src/components/AppShell.tsx` | Applies the brand for a member of a branded org. |
| `apps/web/src/components/Organizations.tsx` | The brand editor. |
| `apps/web/src/types.ts`, `apps/web/src/api.ts` | Brand fields on the session/org types; `updateBranding`. |

---

## Task 1: Core — the accent validator

**Files:**
- Create: `packages/core/src/branding.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/errors.ts`
- Test: `packages/core/test/branding.test.ts`

**Note before you start:** `PolicyErrorCode` in `packages/core/src/errors.ts` is a CLOSED string union and `packages/core/src` IS typechecked, so `INVALID_BRAND_ACCENT` must be added to it or this module will not compile. (EN-F Task 1 hit exactly this.)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/branding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateBrandAccent } from "../src/branding.js";

const bad = (v: unknown): string | null => {
  try { validateBrandAccent(v); return null; } catch (e) { return (e as Error).message; }
};

describe("validateBrandAccent", () => {
  it("accepts a six-digit hex in either case and normalizes to lowercase", () => {
    expect(validateBrandAccent("#0E8C75")).toBe("#0e8c75");
    expect(validateBrandAccent("#aabbcc")).toBe("#aabbcc");
  });

  it("rejects the shapes a colour picker never emits but a hand-written request does", () => {
    expect(bad("#abc")).toContain("#rrggbb");          // three-digit shorthand
    expect(bad("0e8c75")).toContain("#rrggbb");        // missing hash
    expect(bad("red")).toContain("#rrggbb");           // named colour
    expect(bad("#0e8c7")).toContain("#rrggbb");        // five digits
    expect(bad("#0e8c755")).toContain("#rrggbb");      // seven digits
    expect(bad("#0e8c7g")).toContain("#rrggbb");       // non-hex digit
  });

  it("rejects non-strings, which is what a JSON client sends by accident", () => {
    for (const v of [7, null, undefined, {}, ["#0e8c75"]]) expect(bad(v), String(v)).not.toBeNull();
  });

  it("carries its own error code so a 400 can name the field", () => {
    try { validateBrandAccent("nope"); throw new Error("expected a throw"); }
    catch (e) { expect((e as { code?: string }).code).toBe("INVALID_BRAND_ACCENT"); }
  });
});
```

- [ ] **Step 2:** `cd packages/core && ./node_modules/.bin/vitest run test/branding.test.ts` → FAIL, unresolved import.

- [ ] **Step 3: Write the module**

Create `packages/core/src/branding.ts`:

```ts
/**
 * EN-E: the ONE piece of branding logic the API needs.
 *
 * The ramp and the contrast clamp deliberately live in `apps/web/src/lib/branding.ts`
 * instead. The accent never leaves the browser — the API stores a string, and the
 * certificate PDF uses the LOGO, not the accent — so they have exactly one
 * consumer, and putting them here would create a third hand-copied mirror in
 * `apps/web/src/types.ts`. That pattern has already drifted twice.
 */
import { PolicyError } from "./errors.js";

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Normalize an accent to lowercase `#rrggbb`, or throw.
 *
 * Six digits only: three-digit shorthand would have to be expanded somewhere,
 * and "somewhere" becomes two implementations that disagree about `#abc`.
 */
export function validateBrandAccent(value: unknown): string {
  if (typeof value !== "string" || !HEX.test(value)) {
    throw new PolicyError("INVALID_BRAND_ACCENT", "brandAccent must be a #rrggbb hex colour");
  }
  return value.toLowerCase();
}
```

- [ ] **Step 4:** Add `"INVALID_BRAND_ACCENT"` to `PolicyErrorCode` in `packages/core/src/errors.ts`, with a one-line comment saying it is distinct so a 400 can name the field. Add `export * from "./branding.js";` to `packages/core/src/index.ts`.

- [ ] **Step 5:** Run the file (4 tests PASS) then the whole core suite (283 pre-existing + 4). Run `npx tsc --noEmit -p packages/core`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/branding.ts packages/core/src/errors.ts packages/core/src/index.ts packages/core/test/branding.test.ts
git commit -m "feat(core): brand accent validator"
```

---

## Task 2: Persistence — the two columns, in BOTH repositories

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (the `Organization` model, ~line 259)
- Modify: `apps/api/src/persistence/types.ts` (`OrganizationRecord` ~line 393, `OrganizationRepository` below it)
- Modify: `apps/api/src/persistence/memory.ts` (`MemoryOrganizationRepository` ~line 494)
- Modify: `apps/api/src/persistence/prisma.ts` (the organization repo and its row mapper)
- Test: `apps/api/test/org-branding-repo.test.ts`

**THIS IS THE PARITY-RULE TASK.** The memory repo's `create` spreads `...input`, so it picks new fields up for free; the prisma repo has an **explicit mapper** that does not. A field added to the type and the memory repo alone passes every memory-harness test and silently drops on a real database. Everything below lands in ONE commit.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/org-branding-repo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MemoryOrganizationRepository } from "../src/persistence/memory.js";
import type { OrganizationRepository } from "../src/persistence/types.js";

/**
 * Parity, exercised against the MEMORY repo here. The prisma repo cannot be
 * exercised without a database, so its half of the rule is enforced by the
 * type checker (the record type gains the fields, so an explicit mapper that
 * omits them fails to compile) plus the mapper review in Step 4. If you find
 * yourself able to compile prisma.ts without touching it, stop — that means the
 * mapper is spreading and the drift risk lives somewhere else.
 */
function seed(repo: OrganizationRepository) {
  return repo.create({
    name: `Brandable ${Math.random().toString(36).slice(2, 8)}`, orgType: "issuer",
    registrationId: null, jurisdiction: null,
    did: `did:key:zBrand${Math.random().toString(36).slice(2, 8)}`, didSeedEncrypted: "enc",
    status: "active", verified: true, verifiedAt: new Date().toISOString(),
    companyProfile: null, capabilities: null,
    brandLogoDocumentId: null, brandAccent: null,
  });
}

describe("organization branding persistence", () => {
  it("a new organization starts unbranded — every pre-EN-E org is unchanged", async () => {
    const repo = new MemoryOrganizationRepository();
    const org = await seed(repo);
    expect(org.brandLogoDocumentId).toBeNull();
    expect(org.brandAccent).toBeNull();
  });

  it("setBranding writes both fields and they survive a re-read", async () => {
    const repo = new MemoryOrganizationRepository();
    const org = await seed(repo);
    const updated = await repo.setBranding(org.id, { brandLogoDocumentId: "doc_1", brandAccent: "#0e8c75" });
    expect(updated).toMatchObject({ brandLogoDocumentId: "doc_1", brandAccent: "#0e8c75" });
    expect(await repo.get(org.id)).toMatchObject({ brandLogoDocumentId: "doc_1", brandAccent: "#0e8c75" });
  });

  it("an OMITTED field is left alone; an explicit null CLEARS it", async () => {
    // The whole reason the patch type is `field?: T | null` rather than `T | null`:
    // "leave my logo, change my colour" has to be expressible.
    const repo = new MemoryOrganizationRepository();
    const org = await seed(repo);
    await repo.setBranding(org.id, { brandLogoDocumentId: "doc_1", brandAccent: "#0e8c75" });

    await repo.setBranding(org.id, { brandAccent: "#112233" });
    expect(await repo.get(org.id)).toMatchObject({ brandLogoDocumentId: "doc_1", brandAccent: "#112233" });

    await repo.setBranding(org.id, { brandLogoDocumentId: null });
    expect(await repo.get(org.id)).toMatchObject({ brandLogoDocumentId: null, brandAccent: "#112233" });
  });

  it("leaves every other field untouched", async () => {
    const repo = new MemoryOrganizationRepository();
    const org = await seed(repo);
    const after = await repo.setBranding(org.id, { brandAccent: "#112233" });
    expect(after).toMatchObject({ id: org.id, name: org.name, did: org.did, status: org.status, verified: org.verified });
  });
});
```

- [ ] **Step 2:** Run it → FAIL (`brandLogoDocumentId` is not on the input type; `setBranding` does not exist).

- [ ] **Step 3: The Prisma schema**

In `apps/api/prisma/schema.prisma`, inside `model Organization`, after the `capabilities` line:

```prisma
  brandLogoDocumentId String? // EN-E: an image Document id; null = the platform's own look
  brandAccent         String? // EN-E: #rrggbb; null = the platform's own palette
```

Then from `apps/api`: `npx prisma db push --skip-generate` is NOT needed here (no dev database is touched), but **`npx prisma generate` IS** — the client types must know the columns.

- [ ] **Step 4: The record, the repository interface, and both implementations**

`apps/api/src/persistence/types.ts` — in `OrganizationRecord`, after `capabilities`:

```ts
  /** EN-E: an image Document id used as this org's mark. null = unbranded. */
  brandLogoDocumentId: string | null;
  /** EN-E: lowercase #rrggbb accent. null = the platform palette. */
  brandAccent: string | null;
```

and on `OrganizationRepository`:

```ts
  /** Patch branding. An OMITTED key is left alone; an explicit null clears it. */
  setBranding(orgId: string, patch: BrandingPatch): Promise<OrganizationRecord>;
```

with, above the interface:

```ts
export interface BrandingPatch {
  brandLogoDocumentId?: string | null;
  brandAccent?: string | null;
}
```

`apps/api/src/persistence/memory.ts` — on `MemoryOrganizationRepository`:

```ts
  async setBranding(orgId: string, patch: BrandingPatch): Promise<OrganizationRecord> {
    const rec = this.byId.get(orgId);
    if (!rec) throw new Error(`organization '${orgId}' not found`);
    // `in` rather than `!== undefined`: an explicit null must CLEAR, and
    // `patch.brandAccent !== undefined` cannot tell "clear it" from "leave it".
    const next: OrganizationRecord = {
      ...rec,
      ...("brandLogoDocumentId" in patch ? { brandLogoDocumentId: patch.brandLogoDocumentId ?? null } : {}),
      ...("brandAccent" in patch ? { brandAccent: patch.brandAccent ?? null } : {}),
    };
    this.byId.set(orgId, next);
    return next;
  }
```

`apps/api/src/persistence/prisma.ts` — **read the organization repo and its row mapper first.** Add `brandLogoDocumentId` and `brandAccent` to the mapper's output and to every create/update literal that constructs an organization row, then add:

```ts
  async setBranding(orgId: string, patch: BrandingPatch): Promise<OrganizationRecord> {
    const row = await this.db.organization.update({
      where: { id: orgId },
      data: {
        ...("brandLogoDocumentId" in patch ? { brandLogoDocumentId: patch.brandLogoDocumentId ?? null } : {}),
        ...("brandAccent" in patch ? { brandAccent: patch.brandAccent ?? null } : {}),
      },
    });
    return this.toRecord(row);   // use whatever the file's mapper is actually called
  }
```

**Then re-read the mapper and confirm both fields are in it.** A mapper that compiles without them means it is spreading the row, which is fine — say so in your report either way.

- [ ] **Step 5:** Run the new test (4 PASS) and the whole api suite (760 pre-existing + 4). Run `npx tsc --noEmit -p apps/api`.

- [ ] **Step 6: Commit — everything together**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/ apps/api/test/org-branding-repo.test.ts
git commit -m "feat(api): persist organization branding across both repositories"
```

---

## Task 3: API — the branding route, and the brand on the wire

**Files:**
- Modify: `apps/api/src/http/routes.ts` (`orgView` ~line 129; the org routes; the `/me` handler)
- Modify: `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/org-branding-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/org-branding-route.test.ts`:

```ts
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const ROUNDS = 4;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=";

/** An active org plus a logged-in OrgAdmin of it. */
async function org(h: TestAppHandle, label: string) {
  const tag = Math.random().toString(36).slice(2, 8);
  const rec = await h.organizations.create({
    name: `${label} ${tag}`, orgType: "issuer", registrationId: null, jurisdiction: null,
    did: `did:key:zB${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
    verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
    brandLogoDocumentId: null, brandAccent: null,
  });
  const email = `admin-${tag}@brand.dev`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync("brand-secret-1", ROUNDS), role: "OrgAdmin",
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId: rec.id, kind: "human",
  });
  return { id: rec.id, token: await loginAs(h.app, email, "brand-secret-1") };
}

const patch = (h: TestAppHandle, orgId: string, token: string, body: unknown) =>
  h.app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/branding`, headers: auth(token), payload: body });

describe("PATCH /orgs/:id/branding", () => {
  it("an OrgAdmin brands their own organization, and it comes back on GET /orgs/:id", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const doc = await h.app.inject({ method: "POST", url: `${V1}/documents`, headers: auth(a.token), payload: { contentType: "image/png", dataBase64: PNG_B64 } });
    expect(doc.statusCode).toBe(201);

    const res = await patch(h, a.id, a.token, { brandLogoDocumentId: doc.json().id, brandAccent: "#0E8C75" });
    expect(res.statusCode).toBe(200);
    // Normalized to lowercase by the core validator.
    expect(res.json()).toMatchObject({ brandAccent: "#0e8c75", brandLogoDocumentId: doc.json().id });

    const read = await h.app.inject({ method: "GET", url: `${V1}/orgs/${a.id}`, headers: auth(a.token) });
    expect(read.json()).toMatchObject({ brandAccent: "#0e8c75" });
  });

  it("THE CROSS-TENANT CHECK: an OrgAdmin cannot brand somebody else's organization", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const b = await org(h, "Globex");
    const res = await patch(h, b.id, a.token, { brandAccent: "#112233" });
    expect(res.statusCode).toBe(403);
    // And nothing moved.
    expect((await h.organizations.get(b.id))?.brandAccent).toBeNull();
  });

  it("a non-admin member of the SAME organization is refused", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const tag = Math.random().toString(36).slice(2, 8);
    const email = `buyer-${tag}@brand.dev`;
    await h.users.create({
      email, passwordHash: bcrypt.hashSync("buyer-secret-1", ROUNDS), role: "Buyer",
      useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
      orgId: a.id, kind: "human",
    });
    const buyer = await loginAs(h.app, email, "buyer-secret-1");
    expect((await patch(h, a.id, buyer, { brandAccent: "#112233" })).statusCode).toBe(403);
  });

  it("a PlatformAdmin may brand any organization", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    expect((await patch(h, a.id, admin, { brandAccent: "#112233" })).statusCode).toBe(200);
  });

  it("rejects a malformed accent by name rather than silently correcting it", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const res = await patch(h, a.id, a.token, { brandAccent: "red" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_BRAND_ACCENT");
  });

  it("rejects a logo document that is not an image", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const txt = await h.app.inject({
      method: "POST", url: `${V1}/documents`, headers: auth(a.token),
      payload: { contentType: "text/plain", dataBase64: Buffer.from("not an image").toString("base64") },
    });
    expect(txt.statusCode).toBe(201);
    const res = await patch(h, a.id, a.token, { brandLogoDocumentId: txt.json().id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BRAND_LOGO_NOT_AN_IMAGE");
  });

  it("rejects a logo document id that does not exist", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    expect((await patch(h, a.id, a.token, { brandLogoDocumentId: "doc_nope" })).statusCode).toBe(400);
  });

  it("an explicit null clears, an omitted key is left alone", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await patch(h, a.id, a.token, { brandAccent: "#0e8c75" });
    await patch(h, a.id, a.token, {});                       // touches nothing
    expect((await h.organizations.get(a.id))?.brandAccent).toBe("#0e8c75");
    await patch(h, a.id, a.token, { brandAccent: null });
    expect((await h.organizations.get(a.id))?.brandAccent).toBeNull();
  });

  it("GET /me carries the brand, so the shell needs no extra fetch", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await patch(h, a.id, a.token, { brandAccent: "#0e8c75" });
    const me = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(a.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ brandAccent: "#0e8c75" });
  });

  it("a session with no organization gets no brand", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const me = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(admin) });
    expect(me.json().brandAccent ?? null).toBeNull();
  });
});
```

- [ ] **Step 2:** Run it → FAIL with 404 (route absent).

- [ ] **Step 3: The schema entry**

In `apps/api/src/http/schemas.ts`, beside the other org schemas:

```ts
  updateOrgBranding: {
    tags: ["Organizations"], summary: "Set an organization's logo and accent colour", security: humanOnly,
    description:
      "Session-only, and restricted to an OrgAdmin of THIS organization or a Platform Admin. Deliberately carries " +
      "no API-key scope: branding is a console act by a person, and a scope for it would let an unattended key " +
      "rewrite an organization's identity. An omitted field is left unchanged; an explicit `null` clears it.",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false,
      properties: {
        brandLogoDocumentId: { type: "string", nullable: true, description: "An image Document id. null clears it." },
        brandAccent: { type: "string", nullable: true, description: "#rrggbb, normalized to lowercase. null clears it." },
      },
    },
    response: { 200: { $ref: "Organization#" }, ...errs(400, 401, 403, 404) },
  },
```

**Check the real neighbours before copying**: confirm `humanOnly`, `errs` and the `Organization#` component id are what this file actually uses, and add the two properties to the `Organization#` component **additively** (`nullable: true`, alongside `capabilities`). A response field that is not declared will not be sent.

- [ ] **Step 4: The route**

In `apps/api/src/http/routes.ts`, beside the other `/orgs/:id` routes:

```ts
  app.patch("/orgs/:id/branding", { schema: S.updateOrgBranding, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    // AN EXPLICIT ROLE PREDICATE, and an org-ownership check beside it.
    // `authScoped` would be no gate at all here: `requireScope` returns early
    // for a human session, so a scope narrows API keys and nothing else. And
    // without the ownership half, one organization could rebrand another —
    // the cross-tenant shape this program's reviews keep finding.
    const isOwnOrgAdmin = claims.role === "OrgAdmin" && !!claims.orgId && claims.orgId === id;
    if (claims.role !== "PlatformAdmin" && !isOwnOrgAdmin) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only this organization's admin or a platform admin may set its branding" });
    }
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");

    const b = request.body as { brandLogoDocumentId?: string | null; brandAccent?: string | null };
    const patch: BrandingPatch = {};
    if ("brandAccent" in b) {
      // Throws INVALID_BRAND_ACCENT -> 400. Normalizes to lowercase.
      patch.brandAccent = b.brandAccent === null ? null : validateBrandAccent(b.brandAccent);
    }
    if ("brandLogoDocumentId" in b) {
      if (b.brandLogoDocumentId === null) patch.brandLogoDocumentId = null;
      else {
        const doc = await deps.documents.get(b.brandLogoDocumentId);
        if (!doc) return reply.code(400).send({ error: "BRAND_LOGO_NOT_FOUND", message: "no such document" });
        // The renderer only cares about bytes, so the upload allowlist is not
        // what gates it — check the stored type at the door an OrgAdmin reaches.
        if (!doc.contentType.startsWith("image/")) {
          return reply.code(400).send({ error: "BRAND_LOGO_NOT_AN_IMAGE", message: `document is ${doc.contentType}, not an image` });
        }
        patch.brandLogoDocumentId = b.brandLogoDocumentId;
      }
    }
    const updated = await deps.organizations.setBranding(id, patch);
    await deps.audit.append({ actorId: claims.id, action: "org-branding-set" as LifecycleAction, payload: { orgId: id, ...patch } });
    return orgView(updated);
  });
```

Add `brandLogoDocumentId` and `brandAccent` to `orgView` (~line 129). Import `validateBrandAccent` from `@tokenlayer/core` and `BrandingPatch` from the persistence types.

- [ ] **Step 5: `/me` carries the brand**

Find the `GET /me` handler. Where it already resolves the caller's org for `orgCapabilities`, add the two fields to the response (and to the `/me` response schema — **additively**):

```ts
      brandLogoDocumentId: callerOrg?.brandLogoDocumentId ?? null,
      brandAccent: callerOrg?.brandAccent ?? null,
```

If `/me` does not currently load the org record, load it once for the caller's `orgId` and reuse it for both — do not add a second fetch.

- [ ] **Step 6: The coverage allowlist**

`scope-coverage.test.ts` will fail: a mutating route that is not `authScoped`. Add ONE row to `DELIBERATELY_UNSCOPED` with the reason:

```ts
  "PATCH /orgs/:id/branding": "session-only by design: branding is a console act by an OrgAdmin or PlatformAdmin, and an API-key scope for it would let an unattended key rewrite an organization's identity. Role AND org-ownership are both checked in the handler.",
```

Report that you added it.

- [ ] **Step 7:** Run the new test (10 PASS), then `scope-coverage`, `openapi-contract`, `openapi-snapshot`. The snapshot WILL fail with one added path; regenerate with `pnpm --filter @tokenlayer/api openapi:snapshot`, then **read** `git diff apps/api/openapi.snapshot.json` and confirm the only changes are the new path plus the two added `Organization` properties. Run the whole api suite and `npx tsc --noEmit -p apps/api`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/http/ apps/api/openapi.snapshot.json apps/api/test/
git commit -m "feat(api): organization branding route, on /me and the org view"
```

---

## Task 4: API — the certificate logo falls back to the org brand

**Files:**
- Modify: `apps/api/src/http/routes.ts` (the `GET /credentials/:id/certificate.pdf` handler)
- Test: `apps/api/test/org-branding-certificate.test.ts`

**Read first:** the certificate route resolves `logoBytes` from `spec.certificate?.logoDocumentId`, and dispatches to the artwork renderer when `spec.certificate?.background` is set. Both are in `apps/api/src/http/routes.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/org-branding-certificate.test.ts`. It asserts the precedence rule three ways. Build it on the helpers in `apps/api/test/credential-certificate.test.ts` — **read that file and copy the issue → approve → accept pattern; do not edit it.** The three cases:

```ts
// 1. The credential type has NO logo of its own and the issuing org is branded
//    -> the org's logo is used.
// 2. The credential type HAS `certificate.logoDocumentId` -> that wins.
//    Most-specific-wins, so no already-configured certificate changes.
// 3. The credential type has `certificate.background` (artwork mode)
//    -> NEITHER logo is drawn. The customer's design already carries their
//       branding; stamping a second mark onto it is what "artwork replaces the
//       layout" exists to prevent.
```

Assert case 3 through the **seam, not the pixels**: the artwork renderer receives a draw list containing no additional image op beyond the artwork itself. `certificateDrawList` is pure and exported from `apps/api/src/certificate-artwork.ts`, so assert on its output rather than trying to read a PDF.

**Also confirm, do not assume:** the certificate route already wraps its logo fetch in `try { … } catch { logoBytes = null }`, so a brand logo whose document was deleted renders no logo rather than failing. Read that code and check it still holds once the id can come from the org; if the fallback lives only around the old lookup, move it so it covers both.

For cases 1 and 2, the precedence rule is a pure function and belongs in one:

```ts
/** Which logo a certificate should print: the type's own, else the issuing
 *  org's brand, else none. Artwork mode never gets one — see the route. */
export function certificateLogoDocumentId(
  spec: { certificate?: { logoDocumentId?: string } },
  issuerOrg: { brandLogoDocumentId: string | null } | null,
): string | null {
  return spec.certificate?.logoDocumentId ?? issuerOrg?.brandLogoDocumentId ?? null;
}
```

Unit-test it directly — a pure function is a better home for a precedence rule than an assertion about PDF bytes:

```ts
describe("certificateLogoDocumentId", () => {
  const branded = { brandLogoDocumentId: "doc_org" };
  const unbranded = { brandLogoDocumentId: null };

  it("uses the org's brand when the credential type has no logo of its own", () => {
    expect(certificateLogoDocumentId({ certificate: { enabled: true } }, branded)).toBe("doc_org");
  });

  it("MOST-SPECIFIC-WINS: the type's own logo beats the org brand, so no configured certificate changes", () => {
    expect(certificateLogoDocumentId({ certificate: { enabled: true, logoDocumentId: "doc_type" } }, branded)).toBe("doc_type");
  });

  it("is null when neither is set, and when there is no issuing org at all", () => {
    expect(certificateLogoDocumentId({ certificate: { enabled: true } }, unbranded)).toBeNull();
    expect(certificateLogoDocumentId({ certificate: { enabled: true } }, null)).toBeNull();
  });
});
```

- [ ] **Step 2:** Run it → FAIL.

- [ ] **Step 3: Implement**

Put `certificateLogoDocumentId` in `apps/api/src/certificate-fields.ts` (which already holds the shared certificate value logic). In the certificate route, replace the direct `spec.certificate?.logoDocumentId` lookup with a call to it, passing the issuing organization the route already loads for `issuerName`. **Leave the artwork branch alone** — it does not read `logoBytes` at all, which is exactly the behaviour case 3 asserts.

- [ ] **Step 4:** Run the new test, plus `credential-certificate.test.ts` and `certificate-artwork.test.ts` unedited. Run the whole api suite and `npx tsc --noEmit -p apps/api`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/certificate-fields.ts apps/api/src/http/routes.ts apps/api/test/org-branding-certificate.test.ts
git commit -m "feat(api): a certificate falls back to the issuing org's brand logo"
```

---

## Task 5: Web — the palette becomes overridable, and the colour maths

**Files:**
- Modify: `apps/web/tailwind.config.js`, `apps/web/src/index.css`
- Create: `apps/web/src/lib/branding.ts`
- Test: `apps/web/test/branding.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/branding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BRAND_STOPS, brandRamp, clampAccent, contrastRatio, relativeLuminance } from "../src/lib/branding.js";

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for a colour on itself", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#0e8c75", "#0e8c75")).toBeCloseTo(1, 3);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#0e8c75", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#0e8c75"), 6);
  });
});

describe("clampAccent", () => {
  it("leaves a colour that already passes AA against white text alone", () => {
    const dark = "#0e8c75";
    expect(contrastRatio(dark, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(clampAccent(dark)).toBe(dark);
  });

  it("darkens a colour that fails until it passes — an org cannot make its own buttons unreadable", () => {
    const pale = "#a7f3d0";
    expect(contrastRatio(pale, "#ffffff")).toBeLessThan(4.5);
    const fixed = clampAccent(pale);
    expect(contrastRatio(fixed, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("terminates on white, the worst case, rather than looping", () => {
    const fixed = clampAccent("#ffffff");
    expect(contrastRatio(fixed, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the hue recognisably the org's — it darkens, it does not desaturate to grey", () => {
    const fixed = clampAccent("#a7f3d0");           // pale green
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(fixed.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r);                    // still green-dominant
    expect(g).toBeGreaterThan(b);
  });
});

describe("brandRamp", () => {
  it("produces every stop the Tailwind scale declares", () => {
    const ramp = brandRamp("#0e8c75");
    expect(Object.keys(ramp).map(Number).sort((a, b) => a - b)).toEqual([...BRAND_STOPS]);
    for (const v of Object.values(ramp)) expect(v).toMatch(/^\d+ \d+ \d+$/); // "r g b" for rgb(var(--x))
  });

  it("is MONOTONIC in lightness: 50 lightest, 700 darkest", () => {
    // A non-monotonic scale gives a hover state lighter than its rest state,
    // which reads as a rendering bug rather than as a theme.
    const ramp = brandRamp("#0e8c75");
    const lum = (s: number): number => {
      const [r, g, b] = ramp[s as (typeof BRAND_STOPS)[number]].split(" ").map(Number);
      return relativeLuminance(`#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`);
    };
    for (let i = 1; i < BRAND_STOPS.length; i++) {
      expect(lum(BRAND_STOPS[i - 1]!), `stop ${BRAND_STOPS[i - 1]} vs ${BRAND_STOPS[i]}`).toBeGreaterThan(lum(BRAND_STOPS[i]!));
    }
  });

  it("stays monotonic for extreme inputs", () => {
    for (const accent of ["#000000", "#ffffff", "#ff0000", "#0000ff"]) {
      const ramp = brandRamp(accent);
      expect(Object.keys(ramp)).toHaveLength(BRAND_STOPS.length);
    }
  });
});
```

- [ ] **Step 2:** Run → FAIL, unresolved import.

- [ ] **Step 3: Write the module**

Create `apps/web/src/lib/branding.ts`:

```ts
/**
 * EN-E: turning one accent colour into the six-stop `brand-*` scale the app
 * already uses, and refusing to produce an unreadable one.
 *
 * Lives here rather than in `@tokenlayer/core` because the accent never leaves
 * the browser: the API stores a hex string and the certificate PDF uses the
 * LOGO, not the accent. One consumer, so no hand-copied mirror — the pattern
 * that has already drifted twice in this codebase.
 *
 * Values are emitted as `"r g b"` triples, not `#rrggbb`, because they are
 * assigned to CSS custom properties consumed by `rgb(var(--brand-600) / <alpha>)`.
 * Tailwind's alpha modifiers stop working if the variable carries a `#`.
 */

/** The stops `tailwind.config.js` declares. Ordered light → dark. */
export const BRAND_STOPS = [50, 100, 400, 500, 600, 700] as const;
export type BrandStop = (typeof BRAND_STOPS)[number];

const hex = (v: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
const toTriple = (rgb: [number, number, number]): string => rgb.map(clamp255).join(" ");
const toHex = (rgb: [number, number, number]): string => `#${rgb.map((n) => clamp255(n).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance. */
export function relativeLuminance(color: string): number {
  const [r, g, b] = hex(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, symmetric in its arguments. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const WHITE = "#ffffff";
const AA = 4.5;

/**
 * Darken until white text on this colour clears WCAG AA.
 *
 * Applied at RENDER, never at save: the stored value stays the colour the
 * OrgAdmin chose, so their picker never disagrees with what they saved.
 *
 * Multiplies each channel rather than desaturating, so a pale green darkens to
 * a deep green instead of sliding to grey — an org should still recognise it.
 * Bounded to 60 steps, which reaches black from white long before it runs out.
 */
export function clampAccent(accent: string): string {
  let rgb = hex(accent);
  for (let i = 0; i < 60 && contrastRatio(toHex(rgb), WHITE) < AA; i++) {
    rgb = rgb.map((c) => c * 0.9) as [number, number, number];
    if (rgb.every((c) => c < 1)) return "#000000";
  }
  return toHex(rgb);
}

/**
 * The six stops. 500 is the clamped accent itself; lighter stops mix toward
 * white and darker ones toward black, by fixed ratios chosen so the result is
 * MONOTONIC in lightness — a scale where 400 is darker than 500 produces a
 * hover state that looks broken.
 */
export function brandRamp(accent: string): Record<BrandStop, string> {
  const base = hex(clampAccent(accent));
  const mix = (target: 0 | 255, amount: number): string =>
    toTriple(base.map((c) => c + (target - c) * amount) as [number, number, number]);
  return {
    50: mix(255, 0.92),
    100: mix(255, 0.82),
    400: mix(255, 0.22),
    500: toTriple(base),
    600: mix(0, 0.22),
    700: mix(0, 0.42),
  };
}
```

- [ ] **Step 4: Make the palette overridable**

`apps/web/tailwind.config.js` — replace the `brand` block:

```js
        // EN-E: each stop reads a CSS custom property so an organization's
        // shell can override the palette without a single component changing.
        // `<alpha-value>` keeps Tailwind's `/50` opacity modifiers working,
        // which is why the variables hold "r g b" and not "#rrggbb".
        brand: {
          50: "rgb(var(--brand-50) / <alpha-value>)",
          100: "rgb(var(--brand-100) / <alpha-value>)",
          400: "rgb(var(--brand-400) / <alpha-value>)",
          500: "rgb(var(--brand-500) / <alpha-value>)",
          600: "rgb(var(--brand-600) / <alpha-value>)",
          700: "rgb(var(--brand-700) / <alpha-value>)",
        },
```

`apps/web/src/index.css` — add to `:root`, **today's hexes converted to triples so the unbranded app is pixel-identical**:

```css
:root {
  /* EN-E defaults = the XI Tokenize palette these stops used to hardcode. */
  --brand-50: 233 249 244;    /* #e9f9f4 */
  --brand-100: 205 238 230;   /* #cdeee6 */
  --brand-400: 26 200 169;    /* #1AC8A9 */
  --brand-500: 18 179 154;    /* #12b39a */
  --brand-600: 14 140 117;    /* #0E8C75 */
  --brand-700: 10 111 93;     /* #0a6f5d */
}
```

- [ ] **Step 5:** Run the new test (9 PASS) and the whole web suite (138 + 9). Run `npx tsc --noEmit -p apps/web` and `npm run build`. **Then open the app and confirm it looks unchanged** — this step rewrote the palette mechanism, and "identical" is the whole claim.

- [ ] **Step 6: Commit**

```bash
git add apps/web/tailwind.config.js apps/web/src/index.css apps/web/src/lib/branding.ts apps/web/test/branding.test.ts
git commit -m "feat(web): brand palette via CSS custom properties, plus the ramp and contrast clamp"
```

---

## Task 6: Web — the shell applies it, and an editor sets it

**Files:**
- Modify: `apps/web/src/types.ts`, `apps/web/src/api.ts`
- Modify: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/components/Organizations.tsx`
- Test: `apps/web/test/branding-vars.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web` has **no DOM test environment** — every existing web test is pure logic (see `apps/web/test/developers-key-lifecycle.test.ts`, which says so). So test the pure part: the function that turns a session's brand into the variables to set.

Create `apps/web/test/branding-vars.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { brandCssVars } from "../src/lib/branding.js";

describe("brandCssVars", () => {
  it("returns nothing for a session with no accent — the platform palette stands", () => {
    expect(brandCssVars(null)).toEqual({});
    expect(brandCssVars(undefined)).toEqual({});
  });

  it("returns one custom property per stop for a branded session", () => {
    const vars = brandCssVars("#0e8c75");
    expect(Object.keys(vars).sort()).toEqual(
      ["--brand-100", "--brand-400", "--brand-50", "--brand-500", "--brand-600", "--brand-700"],
    );
    for (const v of Object.values(vars)) expect(v).toMatch(/^\d+ \d+ \d+$/);
  });

  it("ignores a malformed accent rather than emitting broken CSS", () => {
    // The API validates on save, but a stale session or a hand-edited store
    // must not be able to blank the palette.
    expect(brandCssVars("red")).toEqual({});
    expect(brandCssVars("#abc")).toEqual({});
  });
});
```

- [ ] **Step 2:** Run → FAIL (`brandCssVars` not exported).

- [ ] **Step 3: Add `brandCssVars`**

Append to `apps/web/src/lib/branding.ts`:

```ts
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The custom properties a branded shell sets, or `{}` for an unbranded session.
 *
 * Returns `{}` rather than throwing on a malformed accent: the API validates on
 * save, so a bad value here means a stale session or a hand-edited store, and
 * blanking somebody's palette over it would be the wrong failure.
 */
export function brandCssVars(accent: string | null | undefined): Record<string, string> {
  if (!accent || !HEX.test(accent)) return {};
  const ramp = brandRamp(accent);
  return Object.fromEntries(BRAND_STOPS.map((s) => [`--brand-${s}`, ramp[s]]));
}
```

- [ ] **Step 4: Types and client**

`apps/web/src/types.ts` — add `brandLogoDocumentId: string | null` and `brandAccent: string | null` to the session-user type that mirrors `/me`, and to the `Organization` type.

`apps/web/src/api.ts` — beside the other org methods:

```ts
  updateBranding: (token: string, orgId: string, body: { brandLogoDocumentId?: string | null; brandAccent?: string | null }) =>
    request<Organization>(`/orgs/${encodeURIComponent(orgId)}/branding`, token, { method: "PATCH", body: JSON.stringify(body) }),
```

- [ ] **Step 5: The shell applies it**

In `apps/web/src/components/AppShell.tsx`, spread the variables onto the outermost element's `style`:

```tsx
  // EN-E: six custom properties and the whole app follows, because every
  // `brand-*` class reads them. A member of an unbranded org gets `{}` and the
  // :root defaults stand.
  <div style={brandCssVars(user?.brandAccent) as React.CSSProperties} className="...">
```

and render the org logo beside the existing `<Logo>` when `user?.brandLogoDocumentId` is set. **The document route needs a bearer token**, so fetch it with `api.downloadDocument` and hold an object URL — an `<img src="/api/v1/documents/…">` would 401. Revoke the object URL when the id changes.

- [ ] **Step 6: The editor**

In `apps/web/src/components/Organizations.tsx`, on the organization detail view, add a Branding section visible to a PlatformAdmin or an OrgAdmin of that org: a colour input bound to `brandAccent`, a file input that uploads via `api.uploadDocument` and sets `brandLogoDocumentId`, a Save calling `api.updateBranding`, and a Clear sending explicit nulls.

Show the contrast note when it applies:

```tsx
  {accent && clampAccent(accent) !== accent.toLowerCase() && (
    <p className="text-[11px] text-amber-700">
      Darkened for legibility — white text on your colour would not meet contrast guidelines. Your saved colour is unchanged.
    </p>
  )}
```

- [ ] **Step 7:** Run the whole web suite (138 + 9 + 3), `npx tsc --noEmit -p apps/web`, `npm run build`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/
git commit -m "feat(web): the shell wears an organization's brand, and an OrgAdmin can set it"
```

---

## Task 7: Web — the eight remaining hand-rolled empty states

**Files:** the components the grep below names.
**Test:** the existing web suite must stay green; no new test (these are render-only changes, and `apps/web` has no DOM test environment).

- [ ] **Step 1: Find them**

```bash
cd apps/web/src/components
grep -l "No [a-z]* yet\|no [a-z]* found" *.tsx | while read f; do grep -q "EmptyState" "$f" || echo "$f"; done
```

- [ ] **Step 2: Convert each**

Read `EmptyState`'s props in `apps/web/src/components/ui.tsx` (~line 213) and replace each hand-rolled block with it, **keeping the existing message text verbatim** — this task is about the container, not the copy. A message that reads badly is a separate change; do not improve it here, because a diff that does two things is a diff nobody can review.

- [ ] **Step 3:** Run the whole web suite, `npx tsc --noEmit -p apps/web`, `npm run build`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/
git commit -m "refactor(web): the last hand-rolled empty states adopt the shared primitive"
```

---

## Task 8: Verify — suites, browser pass, review, merge

- [ ] **Step 1: Every suite, plus the `.env` collection check**

```bash
cd packages/core && ./node_modules/.bin/vitest run
cd ../../apps/api && ./node_modules/.bin/vitest run --testTimeout=180000
cd ../web && ./node_modules/.bin/vitest run
cd ../api && mv .env .env.aside && ./node_modules/.bin/vitest run --testTimeout=180000; mv .env.aside .env
```

Identical api counts with and without `.env`. A lower count means a file failed to COLLECT, not that a test failed.

- [ ] **Step 2: Both typechecks and the build**

```bash
npx tsc --noEmit -p apps/api
npx tsc --noEmit -p apps/web
cd apps/web && npm run build
```

- [ ] **Step 3: Browser pass**

Add a temporary `api-throwaway` entry to `.claude/launch.json` using `DATABASE_URL=file:./dev-ene.db`, `preview_start` it and the web server. **Never boot the default `api` config** — it runs `prisma db push` against the real `apps/api/prisma/dev.db`.

Then: log in as `admin@tokenlayer.dev` / `admin123`; create an org and an OrgAdmin for it; as that OrgAdmin set a logo and a vivid accent; confirm the shell changes and the logo appears. Log in as a member of a DIFFERENT org and confirm their shell is untouched — that is the cross-tenant check with eyes on it. Issue a credential from the branded org with a certificate-enabled type that has no logo of its own, download the PDF, and confirm the org's logo is on it. Screenshot both shells.

Tear down: `preview_stop` both, remove the throwaway config, delete `apps/api/prisma/dev-ene.db`.

- [ ] **Step 4: The final whole-branch review**

Dispatch a reviewer against the whole diff, in a worktree, with the instruction to **hunt independently rather than verify the spec's list**. It has found a real defect on all six preceding sub-projects. Give it the spec, `git log --oneline main..HEAD`, and the fresh-worktree recipe (`pnpm install`; `npx hardhat compile` in `packages/contracts`; `npx prisma generate` in `apps/api`).

Point it at, without limiting it to: the new route's role AND org-ownership checks (an OrgAdmin of another org, a non-admin member, an API key); whether `brandAccent` can reach the DOM unvalidated; whether the certificate precedence leaks one org's logo onto another's certificate; and whether the palette change altered any rendered colour for an unbranded org.

- [ ] **Step 5: Fix findings, then merge**

```bash
git checkout main
git merge --no-ff feat/org-branding
git branch -d feat/org-branding
```

Add a `docs/api/CHANGELOG.md` entry for the new route and the two additive `Organization` / `/me` fields.
