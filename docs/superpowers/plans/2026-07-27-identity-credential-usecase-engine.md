# Identity Domain — Configurable Credential Use-Case Engine (ID-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DID/VC a first-class, configurable domain — author a *credential use case* low-code (custom credential types from editable templates + Issuer/Holder/Verifier bindings), parallel to how tokenization use cases are configured.

**Architecture:** A new `CredentialUseCase` config model lives beside the token `UseCase`, sharing the core primitives (orgs, DIDs, registries) but with an identity-shaped config. Core owns the typed shape + templates + validation; the API persists + exposes CRUD; the web adds an Identity section + a builder wizard reusing the token builder's field editor. Runtime issue/hold/verify is a later sub-project (ID-B) — ID-A ends at configuration.

**Tech Stack:** packages/core (TypeScript, Vitest), apps/api (Fastify + Prisma/SQLite + Vitest), apps/web (React + Vite + Tailwind).

**Spec:** `docs/superpowers/specs/2026-07-27-identity-domain-credential-usecase-engine-design.md`

---

## Verified contracts (read before starting)

- **Core exports** live in `packages/core/src/index.ts` (all via `export *` from module files). `validation.ts` has `validateMetadataSchema(schema, key, fail)` (line ~92) and `validatePropertySchema` — currently **internal**; Task 1 exports `validateMetadataSchema`. `PolicyError` is exported from `./errors.js`. `MetadataSchema`/`PropertySchema` are in `./types.js`.
- **Token use-case parallels:** `UseCaseDefinition` (`packages/core/src/types.ts:157`); `UseCaseRepository extends UseCaseSource { create; update }` (`apps/api/src/persistence/types.ts:149`); `MemoryUseCaseRepository` (`apps/api/src/persistence/memory.ts:175`); `PrismaUseCaseRepository` (in `apps/api/src/persistence/prisma.ts`); `AppDeps.useCases` (`apps/api/src/context.ts:28`). Prisma `UseCase` model uses `String` JSON columns (`apps/api/prisma/schema.prisma`).
- **DB uses `prisma db push`**, not migrations. After editing `schema.prisma`, run `DATABASE_URL="file:./dev.db" ./node_modules/.bin/prisma db push --skip-generate` from `apps/api`.
- **AppDeps construction sites** (must all wire a new repo): `apps/api/src/server.ts`, and the memory-backed ones in `apps/api/test/helpers.ts`, `apps/api/src/demo.ts`, `apps/api/src/e2e-buy.ts`, `apps/api/src/e2e-carbon.ts`, `apps/api/src/e2e-tenancy.ts`, `apps/api/src/e2e-usecases.ts`. (`apps/api/test/platform-org.test.ts` uses a bespoke partial-deps `makeDeps()` and is left untouched.)
- **Routes:** `apps/api/src/http/routes.ts` — `app.post/get/patch("<path>", { schema: S.x, ...auth }, handler)`. `request.user as TokenClaims` has `{ id, email, role, useCaseKey, orgId, did }`. `actorOf(request)`, `notFound(reply, msg)`, `deps.audit.append({...})` available. PlatformAdmin check: `claims.role === "PlatformAdmin"`.
- **Schemas:** `apps/api/src/http/schemas.ts` — `components` array (each `{ $id, ... }`) + `export const S = { ... }` with `errs(...)` helper for error responses. Follow the `useCase`/`registerOrg` entries.
- **Web builder to parallel + reuse:** `apps/web/src/components/UseCaseBuilder.tsx` — 5-step wizard; Step 3 "Asset fields" edits `FieldRow[]` (`{ name, kind, required, pattern? }`) → `MetadataSchema.properties`. Task 6 lifts that field editor into a shared `SchemaFieldEditor.tsx`. `apps/web/src/api.ts` exports `const api = {...}` calling `request<T>(path, token, init?)`; `apps/web/src/types.ts` holds shared types; `apps/web/src/components/ui.tsx` has `Card`, `SectionHeader`, `Pill`, `Icon`, `EmptyState`. Nav is in `apps/web/src/App.tsx` (role-computed `items` for `AppShell`).

---

## Task 1: Core — credential-use-case types, templates, validation

**Files:**
- Create: `packages/core/src/credential-use-cases.ts`
- Create: `packages/core/test/credential-use-cases.test.ts`
- Modify: `packages/core/src/validation.ts` (export `validateMetadataSchema`)
- Modify: `packages/core/src/index.ts` (export the new module)

- [ ] **Step 1: Export the schema validator.** In `packages/core/src/validation.ts`, change the declaration `function validateMetadataSchema(` to `export function validateMetadataSchema(`. Leave its body and callers unchanged. Confirm its signature is `(schema: unknown, key: string, fail: (msg: string) => never): void` (read the file to match the exact `fail` type; if it differs, use the real one in Task 1 Step 3).

- [ ] **Step 2: Write the failing test** — `packages/core/test/credential-use-cases.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TEMPLATES,
  validateCredentialUseCase,
  type CredentialUseCaseDefinition,
} from "../src/credential-use-cases.js";
import { PolicyError } from "../src/errors.js";

const KNOWN_ORG = "org_1";
const orgExists = (id: string) => id === KNOWN_ORG;

function base(): CredentialUseCaseDefinition {
  return {
    key: "corp-trade-credentials",
    name: "Corporate Trade Credentials",
    description: "Government trade credentials for corporates.",
    credentialTypes: [
      { name: "MCACredential", title: "MCA Company Master", validityDays: 365,
        claimSchema: { type: "object", required: ["cin", "companyName"],
          properties: { cin: { type: "string" }, companyName: { type: "string" } } } },
    ],
    issuer: { kind: "platform" },
    holderPolicy: { who: "any-onboarded" },
    verifier: { kind: "any" },
  };
}

describe("CREDENTIAL_TEMPLATES", () => {
  it("exposes well-formed starter templates including KYC and MCA", () => {
    expect(Object.keys(CREDENTIAL_TEMPLATES)).toEqual(
      expect.arrayContaining(["KycCredential", "MCACredential", "GSTINCredential", "EmploymentCredential", "OrganizationMembership"]),
    );
    for (const t of Object.values(CREDENTIAL_TEMPLATES)) {
      expect(t.name).toBeTruthy();
      expect(t.claimSchema.type).toBe("object");
      expect(t.validityDays).toBeGreaterThan(0);
    }
  });
});

describe("validateCredentialUseCase", () => {
  it("accepts a well-formed definition", () => {
    expect(() => validateCredentialUseCase(base(), { orgExists })).not.toThrow();
  });
  it("rejects an empty key", () => {
    expect(() => validateCredentialUseCase({ ...base(), key: "" }, { orgExists })).toThrow(PolicyError);
  });
  it("rejects zero credential types", () => {
    expect(() => validateCredentialUseCase({ ...base(), credentialTypes: [] }, { orgExists })).toThrow(/at least one/i);
  });
  it("rejects duplicate credential-type names", () => {
    const d = base(); d.credentialTypes = [d.credentialTypes[0], { ...d.credentialTypes[0] }];
    expect(() => validateCredentialUseCase(d, { orgExists })).toThrow(/duplicate/i);
  });
  it("rejects a malformed claim schema", () => {
    const d = base(); (d.credentialTypes[0].claimSchema as { type: string }).type = "array";
    expect(() => validateCredentialUseCase(d, { orgExists })).toThrow(PolicyError);
  });
  it("rejects an issuer org that does not exist", () => {
    expect(() => validateCredentialUseCase({ ...base(), issuer: { kind: "org", orgId: "ghost" } }, { orgExists }))
      .toThrow(/unknown issuer org/i);
  });
  it("rejects a verifier org that does not exist", () => {
    expect(() => validateCredentialUseCase({ ...base(), verifier: { kind: "orgs", orgIds: ["ghost"] } }, { orgExists }))
      .toThrow(/unknown verifier org/i);
  });
  it("accepts an org issuer that exists", () => {
    expect(() => validateCredentialUseCase({ ...base(), issuer: { kind: "org", orgId: KNOWN_ORG } }, { orgExists })).not.toThrow();
  });
});
```

- [ ] **Step 3: Run it — expect FAIL** (module missing).
Run: `cd "/Users/kamleshnagware/Tokenlayer XPI/packages/core" && ./node_modules/.bin/vitest run test/credential-use-cases.test.ts`
Expected: FAIL, cannot resolve `../src/credential-use-cases.js`.

- [ ] **Step 4: Implement** — `packages/core/src/credential-use-cases.ts`:

```ts
/**
 * The Identity domain's configurable "credential use case": custom credential
 * types (claim schemas) plus Issuer / Holder / Verifier bindings. Parallel to
 * the tokenization UseCaseDefinition, sharing the metadata-schema validator.
 */
import { PolicyError } from "./errors.js";
import type { MetadataSchema, OrgType } from "./types.js";
import { validateMetadataSchema } from "./validation.js";

export interface CredentialTypeSpec {
  /** Machine name, unique within the use case, e.g. "MCACredential". */
  name: string;
  /** Human label, e.g. "MCA Company Master". */
  title: string;
  /** Claim shape (same schema the token builder emits for metadataSchema). */
  claimSchema: MetadataSchema;
  /** Days the issued credential remains valid. */
  validityDays: number;
}

export type IssuerBinding = { kind: "platform" } | { kind: "org"; orgId: string };
export type HolderPolicy =
  | { who: "any-onboarded" }
  | { who: "orgType"; orgTypes: OrgType[] }
  | { who: "specific"; orgIds: string[] };
export type VerifierBinding = { kind: "any" } | { kind: "orgs"; orgIds: string[] };

export interface CredentialUseCaseDefinition {
  key: string;
  name: string;
  description?: string;
  credentialTypes: CredentialTypeSpec[];
  issuer: IssuerBinding;
  holderPolicy: HolderPolicy;
  verifier: VerifierBinding;
  /** Owning organization id (null/undefined for platform-owned). */
  ownerOrgId?: string | null;
}

/** Editable starter templates surfaced by the builder. */
export const CREDENTIAL_TEMPLATES: Record<string, CredentialTypeSpec> = {
  KycCredential: {
    name: "KycCredential", title: "KYC Verification", validityDays: 365,
    claimSchema: { type: "object", required: ["legalName", "country"], properties: {
      legalName: { type: "string" }, country: { type: "string", pattern: "^[A-Z]{2}$" },
      idType: { type: "string" }, idNumber: { type: "string" } } },
  },
  MCACredential: {
    name: "MCACredential", title: "MCA Company Master", validityDays: 365,
    claimSchema: { type: "object", required: ["cin", "companyName"], properties: {
      cin: { type: "string" }, companyName: { type: "string" },
      incorporationDate: { type: "string" }, companyStatus: { type: "string" } } },
  },
  GSTINCredential: {
    name: "GSTINCredential", title: "GSTIN Registration", validityDays: 365,
    claimSchema: { type: "object", required: ["gstin", "legalName"], properties: {
      gstin: { type: "string" }, legalName: { type: "string" }, stateCode: { type: "string" } } },
  },
  EmploymentCredential: {
    name: "EmploymentCredential", title: "Employment", validityDays: 365,
    claimSchema: { type: "object", required: ["employeeName", "employer"], properties: {
      employeeName: { type: "string" }, employer: { type: "string" }, title: { type: "string" } } },
  },
  OrganizationMembership: {
    name: "OrganizationMembership", title: "Organization Membership", validityDays: 365,
    claimSchema: { type: "object", required: ["organization", "role"], properties: {
      organization: { type: "string" }, role: { type: "string" }, memberSince: { type: "string" } } },
  },
};

/** Throws PolicyError on any structural problem. `orgExists` checks org ids. */
export function validateCredentialUseCase(
  def: CredentialUseCaseDefinition,
  ctx: { orgExists: (id: string) => boolean },
): void {
  const fail = (msg: string): never => { throw new PolicyError("INVALID_CREDENTIAL_USECASE", msg); };
  if (!def.key || !/^[a-z0-9-]+$/.test(def.key)) fail("key must be a non-empty lowercase slug");
  if (!def.name?.trim()) fail("name is required");
  if (!Array.isArray(def.credentialTypes) || def.credentialTypes.length === 0) fail("at least one credential type is required");
  const seen = new Set<string>();
  for (const ct of def.credentialTypes) {
    if (!ct.name?.trim()) fail("each credential type needs a name");
    if (seen.has(ct.name)) fail(`duplicate credential-type name '${ct.name}'`);
    seen.add(ct.name);
    if (!(ct.validityDays > 0)) fail(`credential type '${ct.name}' needs a positive validityDays`);
    validateMetadataSchema(ct.claimSchema, `${def.key}:${ct.name}`, fail);
  }
  if (def.issuer.kind === "org" && !ctx.orgExists(def.issuer.orgId)) fail(`unknown issuer org '${def.issuer.orgId}'`);
  if (def.holderPolicy.who === "specific") for (const id of def.holderPolicy.orgIds) if (!ctx.orgExists(id)) fail(`unknown holder org '${id}'`);
  if (def.verifier.kind === "orgs") for (const id of def.verifier.orgIds) if (!ctx.orgExists(id)) fail(`unknown verifier org '${id}'`);
}
```

If `validateMetadataSchema`'s real `fail` parameter type differs (e.g. returns `never` vs `void`), adjust the local `fail` signature to match so the call typechecks.

- [ ] **Step 5: Export from core.** In `packages/core/src/index.ts` add `export * from "./credential-use-cases.js";` after the `credential-types.js` line.

- [ ] **Step 6: Run tests — expect PASS.**
Run: `cd "/Users/kamleshnagware/Tokenlayer XPI/packages/core" && ./node_modules/.bin/vitest run test/credential-use-cases.test.ts && pnpm -s typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 7: Commit.**
```bash
git add packages/core/src/credential-use-cases.ts packages/core/test/credential-use-cases.test.ts packages/core/src/validation.ts packages/core/src/index.ts
git commit -m "feat(core): credential use-case types, templates, validation"
```

---

## Task 2: Persistence — CredentialUseCase model, repos, AppDeps wiring

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/persistence/types.ts`
- Modify: `apps/api/src/persistence/memory.ts`
- Modify: `apps/api/src/persistence/prisma.ts`
- Modify: `apps/api/src/context.ts`
- Modify: construction sites (server.ts + 5 e2e/demo files + test/helpers.ts)
- Create: `apps/api/test/credential-usecase-repo.test.ts`

- [ ] **Step 1: Prisma model.** Add to `apps/api/prisma/schema.prisma`:
```prisma
// A configured credential (DID/VC) use case — the Identity-domain parallel of
// the tokenization UseCase. JSON columns hold the structured config.
model CredentialUseCase {
  key             String   @id
  name            String
  description     String?
  credentialTypes String   // JSON: CredentialTypeSpec[]
  issuer          String   // JSON: IssuerBinding
  holderPolicy    String   // JSON: HolderPolicy
  verifier        String   // JSON: VerifierBinding
  ownerOrgId      String?
  status          String   @default("active")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```
Then: `cd "/Users/kamleshnagware/Tokenlayer XPI/apps/api" && DATABASE_URL="file:./dev.db" ./node_modules/.bin/prisma db push --skip-generate && ./node_modules/.bin/prisma generate`

- [ ] **Step 2: Repo interface.** In `apps/api/src/persistence/types.ts`, import the core type at the top (`import type { CredentialUseCaseDefinition } from "@tokenlayer/core";` — add to the existing core import) and add:
```ts
export interface CredentialUseCaseRepository {
  create(def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition>;
  get(key: string): Promise<CredentialUseCaseDefinition | null>;
  has(key: string): Promise<boolean>;
  list(): Promise<CredentialUseCaseDefinition[]>;
  update(key: string, def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition>;
}
```

- [ ] **Step 3: Write the failing repo test** — `apps/api/test/credential-usecase-repo.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { CredentialUseCaseDefinition } from "@tokenlayer/core";
import { MemoryCredentialUseCaseRepository } from "../src/persistence/memory.js";

const def: CredentialUseCaseDefinition = {
  key: "kyc-onboarding", name: "KYC Onboarding",
  credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365,
    claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
};

describe("MemoryCredentialUseCaseRepository", () => {
  it("creates, reads, lists, updates, and reports existence", async () => {
    const repo = new MemoryCredentialUseCaseRepository();
    expect(await repo.has("kyc-onboarding")).toBe(false);
    const created = await repo.create(def);
    expect(created.key).toBe("kyc-onboarding");
    expect((await repo.get("kyc-onboarding"))?.name).toBe("KYC Onboarding");
    expect(await repo.has("kyc-onboarding")).toBe(true);
    expect(await repo.list()).toHaveLength(1);
    const updated = await repo.update("kyc-onboarding", { ...def, name: "KYC v2" });
    expect(updated.name).toBe("KYC v2");
    expect((await repo.get("kyc-onboarding"))?.name).toBe("KYC v2");
    expect(await repo.get("missing")).toBeNull();
  });
});
```
Run it — expect FAIL (class missing): `cd "/Users/kamleshnagware/Tokenlayer XPI/apps/api" && ./node_modules/.bin/vitest run test/credential-usecase-repo.test.ts`

- [ ] **Step 4: Memory repo.** In `apps/api/src/persistence/memory.ts` add (import `CredentialUseCaseRepository` + `CredentialUseCaseDefinition` types as the file does for others):
```ts
export class MemoryCredentialUseCaseRepository implements CredentialUseCaseRepository {
  private store = new Map<string, CredentialUseCaseDefinition>();
  async create(def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    this.store.set(def.key, { ...def }); return { ...def };
  }
  async get(key: string): Promise<CredentialUseCaseDefinition | null> {
    const d = this.store.get(key); return d ? { ...d } : null;
  }
  async has(key: string): Promise<boolean> { return this.store.has(key); }
  async list(): Promise<CredentialUseCaseDefinition[]> { return [...this.store.values()].map((d) => ({ ...d })); }
  async update(key: string, def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    this.store.set(key, { ...def }); return { ...def };
  }
}
```

- [ ] **Step 5: Prisma repo.** In `apps/api/src/persistence/prisma.ts` add a mapper + class (mirror `PrismaUseCaseRepository`; `prisma` client + `CredentialUseCaseRepository`/`CredentialUseCaseDefinition` imports as the file already does):
```ts
function toCredentialUseCase(r: {
  key: string; name: string; description: string | null;
  credentialTypes: string; issuer: string; holderPolicy: string; verifier: string; ownerOrgId: string | null;
}): CredentialUseCaseDefinition {
  return {
    key: r.key, name: r.name, description: r.description ?? undefined,
    credentialTypes: JSON.parse(r.credentialTypes), issuer: JSON.parse(r.issuer),
    holderPolicy: JSON.parse(r.holderPolicy), verifier: JSON.parse(r.verifier),
    ownerOrgId: r.ownerOrgId,
  };
}
export class PrismaCredentialUseCaseRepository implements CredentialUseCaseRepository {
  async create(def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    const r = await prisma.credentialUseCase.create({ data: {
      key: def.key, name: def.name, description: def.description ?? null,
      credentialTypes: JSON.stringify(def.credentialTypes), issuer: JSON.stringify(def.issuer),
      holderPolicy: JSON.stringify(def.holderPolicy), verifier: JSON.stringify(def.verifier),
      ownerOrgId: def.ownerOrgId ?? null } });
    return toCredentialUseCase(r);
  }
  async get(key: string): Promise<CredentialUseCaseDefinition | null> {
    const r = await prisma.credentialUseCase.findUnique({ where: { key } });
    return r ? toCredentialUseCase(r) : null;
  }
  async has(key: string): Promise<boolean> { return (await prisma.credentialUseCase.count({ where: { key } })) > 0; }
  async list(): Promise<CredentialUseCaseDefinition[]> {
    return (await prisma.credentialUseCase.findMany({ orderBy: { createdAt: "asc" } })).map(toCredentialUseCase);
  }
  async update(key: string, def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    const r = await prisma.credentialUseCase.update({ where: { key }, data: {
      name: def.name, description: def.description ?? null,
      credentialTypes: JSON.stringify(def.credentialTypes), issuer: JSON.stringify(def.issuer),
      holderPolicy: JSON.stringify(def.holderPolicy), verifier: JSON.stringify(def.verifier),
      ownerOrgId: def.ownerOrgId ?? null } });
    return toCredentialUseCase(r);
  }
}
```

- [ ] **Step 6: AppDeps.** In `apps/api/src/context.ts` add to the `AppDeps` interface: `credentialUseCases: CredentialUseCaseRepository;` (import the type). 

- [ ] **Step 7: Wire construction sites.** Add `credentialUseCases: new PrismaCredentialUseCaseRepository()` to the deps object in `apps/api/src/server.ts` (import it), and `credentialUseCases: new MemoryCredentialUseCaseRepository()` in each of: `apps/api/test/helpers.ts`, `apps/api/src/demo.ts`, `apps/api/src/e2e-buy.ts`, `apps/api/src/e2e-carbon.ts`, `apps/api/src/e2e-tenancy.ts`, `apps/api/src/e2e-usecases.ts` (import from `./persistence/memory.js`). Do NOT touch `apps/api/test/platform-org.test.ts`.

- [ ] **Step 8: Run repo test + typecheck — expect PASS.**
Run: `cd "/Users/kamleshnagware/Tokenlayer XPI/apps/api" && ./node_modules/.bin/vitest run test/credential-usecase-repo.test.ts && pnpm -s typecheck`
Expected: PASS, typecheck clean (all construction sites satisfied).

- [ ] **Step 9: Commit.**
```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence apps/api/src/context.ts apps/api/src/server.ts apps/api/src/demo.ts apps/api/src/e2e-*.ts apps/api/test/helpers.ts apps/api/test/credential-usecase-repo.test.ts
git commit -m "feat(api): CredentialUseCase model + repos + AppDeps wiring"
```

---

## Task 3: API — routes, schemas, seeded example

**Files:**
- Modify: `apps/api/src/http/schemas.ts`
- Modify: `apps/api/src/http/routes.ts`
- Modify: `apps/api/src/server.ts` (seed example at boot)
- Create: `apps/api/test/credential-usecase.test.ts`

- [ ] **Step 1: Schemas.** In `apps/api/src/http/schemas.ts` add a permissive `CredentialUseCase` component (`{ $id: "CredentialUseCase", type: "object", additionalProperties: true, required: ["key","name","credentialTypes","issuer","holderPolicy","verifier"], properties: { key:{type:"string"}, name:{type:"string"}, description:{type:"string"}, credentialTypes:{type:"array"}, issuer:{type:"object",additionalProperties:true}, holderPolicy:{type:"object",additionalProperties:true}, verifier:{type:"object",additionalProperties:true}, ownerOrgId:{type:"string",nullable:true}, status:{type:"string"} } }`) and add to `S`:
```ts
  credentialTemplates: { response: { 200: { type: "object", additionalProperties: true } }, ...bearer },
  listCredentialUseCases: { response: { 200: { type: "array", items: { $ref: "CredentialUseCase#" } } }, ...bearer },
  getCredentialUseCase: { params: { type: "object", required: ["key"], properties: { key: { type: "string" } } }, response: { 200: { $ref: "CredentialUseCase#" }, ...errs(404) }, ...bearer },
  createCredentialUseCase: { body: { type: "object", additionalProperties: true, required: ["key","name","credentialTypes","issuer","holderPolicy","verifier"] }, response: { 201: { $ref: "CredentialUseCase#" }, ...errs(400,403,409) }, ...bearer },
  updateCredentialUseCase: { params: { type: "object", required: ["key"], properties: { key: { type: "string" } } }, body: { type: "object", additionalProperties: true }, response: { 200: { $ref: "CredentialUseCase#" }, ...errs(400,403,404) }, ...bearer },
```
(Match the exact `bearer`/`errs` idiom already in the file — read the top of `schemas.ts` for their names; if it's `...errs(...)` inline and `security`-style bearer, mirror that.)

- [ ] **Step 2: Write the failing behavioural test** — `apps/api/test/credential-usecase.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

const DEF = {
  key: "kyc-onboarding", name: "KYC Onboarding", description: "Onboarding KYC.",
  credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365,
    claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
};

describe("credential use-case config API", () => {
  it("PlatformAdmin creates → lists → gets → updates", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const c = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
    expect(c.statusCode).toBe(201);
    expect(c.json().credentialTypes[0].name).toBe("KycCredential");
    const list = await app.inject({ method: "GET", url: `${V1}/credential-use-cases`, headers: auth(admin) });
    expect((list.json() as unknown[]).some((u: { key: string }) => u.key === "kyc-onboarding")).toBe(true);
    const got = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/kyc-onboarding`, headers: auth(admin) });
    expect(got.json().name).toBe("KYC Onboarding");
    const upd = await app.inject({ method: "PATCH", url: `${V1}/credential-use-cases/kyc-onboarding`, headers: auth(admin), payload: { ...DEF, name: "KYC v2" } });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().name).toBe("KYC v2");
  });
  it("rejects a duplicate key and an invalid definition", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
    const dup = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
    expect(dup.statusCode).toBe(409);
    // key collides with an existing TOKEN use case too
    const tokenKeyDup = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: { ...DEF, key: "invoice-tokenization" } });
    expect(tokenKeyDup.statusCode).toBe(409);
    const bad = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: { ...DEF, key: "no-types", credentialTypes: [] } });
    expect(bad.statusCode).toBe(400);
  });
  it("is PlatformAdmin-only to author; templates + reads are open to authed users", async () => {
    const app = await buildTestApp();
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const forbidden = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(issuer), payload: DEF });
    expect(forbidden.statusCode).toBe(403);
    const tpl = await app.inject({ method: "GET", url: `${V1}/credential-templates`, headers: auth(issuer) });
    expect(tpl.statusCode).toBe(200);
    expect(Object.keys(tpl.json())).toContain("KycCredential");
  });
});
```
Run — expect FAIL (routes 404): `cd "/Users/kamleshnagware/Tokenlayer XPI/apps/api" && ./node_modules/.bin/vitest run test/credential-usecase.test.ts`

- [ ] **Step 3: Implement routes.** In `apps/api/src/http/routes.ts` (near the token use-case routes), import `validateCredentialUseCase, CREDENTIAL_TEMPLATES, type CredentialUseCaseDefinition` from `@tokenlayer/core`, then add:
```ts
  app.get("/credential-templates", { schema: S.credentialTemplates, ...auth }, async () => CREDENTIAL_TEMPLATES);

  app.get("/credential-use-cases", { schema: S.listCredentialUseCases, ...auth }, async () => deps.credentialUseCases.list());

  app.get("/credential-use-cases/:key", { schema: S.getCredentialUseCase, ...auth }, async (request, reply) => {
    const cuc = await deps.credentialUseCases.get((request.params as { key: string }).key);
    if (!cuc) return notFound(reply, "credential use case not found");
    return cuc;
  });

  app.post("/credential-use-cases", { schema: S.createCredentialUseCase, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only a platform admin may author credential use cases" });
    const def = request.body as CredentialUseCaseDefinition;
    if (await deps.credentialUseCases.has(def.key) || await deps.useCases.has(def.key)) {
      return reply.code(409).send({ error: "KEY_TAKEN", message: `use-case key '${def.key}' already exists` });
    }
    const orgExists = async (id: string) => !!(await deps.organizations.get(id).catch(() => null));
    // Resolve org existence up-front (validator is sync): collect referenced ids.
    const ids = new Set<string>();
    if (def.issuer.kind === "org") ids.add(def.issuer.orgId);
    if (def.holderPolicy.who === "specific") def.holderPolicy.orgIds.forEach((i) => ids.add(i));
    if (def.verifier.kind === "orgs") def.verifier.orgIds.forEach((i) => ids.add(i));
    const known = new Set<string>();
    for (const id of ids) if (await orgExists(id)) known.add(id);
    try {
      validateCredentialUseCase(def, { orgExists: (id) => known.has(id) });
    } catch (err) {
      return reply.code(400).send({ error: "INVALID_CREDENTIAL_USECASE", message: (err as Error).message });
    }
    const created = await deps.credentialUseCases.create({ ...def, ownerOrgId: def.ownerOrgId ?? null });
    await deps.audit.append({ actorId: claims.id, action: "credential-usecase-created" as LifecycleAction, payload: { key: def.key } });
    return reply.code(201).send(created);
  });

  app.patch("/credential-use-cases/:key", { schema: S.updateCredentialUseCase, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only a platform admin may edit credential use cases" });
    const key = (request.params as { key: string }).key;
    const existing = await deps.credentialUseCases.get(key);
    if (!existing) return notFound(reply, "credential use case not found");
    const def = { ...(request.body as CredentialUseCaseDefinition), key };
    const ids = new Set<string>();
    if (def.issuer.kind === "org") ids.add(def.issuer.orgId);
    if (def.holderPolicy.who === "specific") def.holderPolicy.orgIds.forEach((i) => ids.add(i));
    if (def.verifier.kind === "orgs") def.verifier.orgIds.forEach((i) => ids.add(i));
    const known = new Set<string>();
    for (const id of ids) if (await deps.organizations.get(id).catch(() => null)) known.add(id);
    try {
      validateCredentialUseCase(def, { orgExists: (id) => known.has(id) });
    } catch (err) {
      return reply.code(400).send({ error: "INVALID_CREDENTIAL_USECASE", message: (err as Error).message });
    }
    const updated = await deps.credentialUseCases.update(key, { ...def, ownerOrgId: def.ownerOrgId ?? existing.ownerOrgId ?? null });
    await deps.audit.append({ actorId: claims.id, action: "credential-usecase-updated" as LifecycleAction, payload: { key } });
    return reply.code(200).send(updated);
  });
```
(If `LifecycleAction` is a closed union that rejects new strings, use the file's existing pattern for ad-hoc audit actions — check how other new actions are appended; if needed, cast `as never` or extend the action type in core per the existing convention.)

- [ ] **Step 4: Seed the example at boot.** In `apps/api/src/server.ts`, inside the existing `if (env.nodeEnv !== "production")` block (after the desk provisioning), add:
```ts
    if (!(await credentialUseCases.has("corp-trade-credentials"))) {
      const { CREDENTIAL_TEMPLATES } = await import("@tokenlayer/core");
      await credentialUseCases.create({
        key: "corp-trade-credentials", name: "Corporate Trade Credentials",
        description: "Government-issued trade credentials (MCA, GSTIN) for registered corporates.",
        credentialTypes: [CREDENTIAL_TEMPLATES.MCACredential, CREDENTIAL_TEMPLATES.GSTINCredential],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
        ownerOrgId: null,
      });
    }
```
(Ensure `credentialUseCases` is in scope where the repo is constructed — it is the `PrismaCredentialUseCaseRepository` instance from Task 2; reference that local variable.)

- [ ] **Step 5: Run the behavioural test + full api suite — expect PASS.**
Run: `cd "/Users/kamleshnagware/Tokenlayer XPI/apps/api" && ./node_modules/.bin/vitest run test/credential-usecase.test.ts && ./node_modules/.bin/vitest run && pnpm -s typecheck`
Expected: new tests pass; full suite green; typecheck clean.

- [ ] **Step 6: Commit.**
```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/src/server.ts apps/api/test/credential-usecase.test.ts
git commit -m "feat(api): credential use-case CRUD routes + templates + seeded example"
```

---

## Task 4: Web — shared field editor, builder wizard, Identity list, client

**Files:**
- Create: `apps/web/src/components/SchemaFieldEditor.tsx`
- Modify: `apps/web/src/components/UseCaseBuilder.tsx` (use the shared editor)
- Create: `apps/web/src/components/CredentialUseCaseBuilder.tsx`
- Create: `apps/web/src/components/IdentityHome.tsx`
- Modify: `apps/web/src/api.ts`, `apps/web/src/types.ts`, `apps/web/src/App.tsx`

- [ ] **Step 1: Types + client.** In `apps/web/src/types.ts` add:
```ts
export interface CredentialTypeSpec { name: string; title: string; claimSchema: { type: "object"; required?: string[]; properties: Record<string, { type: string; pattern?: string; enum?: string[] }> }; validityDays: number; }
export type IssuerBinding = { kind: "platform" } | { kind: "org"; orgId: string };
export type HolderPolicy = { who: "any-onboarded" } | { who: "orgType"; orgTypes: string[] } | { who: "specific"; orgIds: string[] };
export type VerifierBinding = { kind: "any" } | { kind: "orgs"; orgIds: string[] };
export interface CredentialUseCase { key: string; name: string; description?: string; credentialTypes: CredentialTypeSpec[]; issuer: IssuerBinding; holderPolicy: HolderPolicy; verifier: VerifierBinding; ownerOrgId?: string | null; status?: string; }
```
In `apps/web/src/api.ts` (import the new types) add to the `api` object:
```ts
  credentialTemplates: (token: string) => request<Record<string, CredentialTypeSpec>>("/credential-templates", token),
  credentialUseCases: (token: string) => request<CredentialUseCase[]>("/credential-use-cases", token),
  credentialUseCase: (token: string, key: string) => request<CredentialUseCase>(`/credential-use-cases/${encodeURIComponent(key)}`, token),
  createCredentialUseCase: (token: string, def: CredentialUseCase) => request<CredentialUseCase>("/credential-use-cases", token, { method: "POST", body: JSON.stringify(def) }),
  updateCredentialUseCase: (token: string, key: string, def: CredentialUseCase) => request<CredentialUseCase>(`/credential-use-cases/${encodeURIComponent(key)}`, token, { method: "PATCH", body: JSON.stringify(def) }),
```

- [ ] **Step 2: Lift the shared field editor.** Create `apps/web/src/components/SchemaFieldEditor.tsx` exporting `type FieldRow = { name: string; kind: "string" | "number" | "boolean" | "document"; required: boolean; pattern?: string }`, a `fieldsToSchema(fields: FieldRow[]): MetadataSchema`-style helper producing `{ type:"object", required:[...], properties:{...} }`, and a `<SchemaFieldEditor fields onChange />` component. Move the field-row add/edit/remove JSX + the `properties` build loop out of `UseCaseBuilder.tsx` (Step 3 "Asset fields", around lines 167-306) into this component **without changing behaviour**. Then in `UseCaseBuilder.tsx` replace that inline block with `<SchemaFieldEditor fields={fields} onChange={setFields} />` and use `fieldsToSchema(fields)` where it built `properties`. Run `pnpm --filter @tokenlayer/web exec tsc --noEmit` — expect clean (behaviour-preserving refactor; the token builder still works).

- [ ] **Step 3: Credential Use-Case Builder.** Create `apps/web/src/components/CredentialUseCaseBuilder.tsx`: a 4-step wizard (Basics → Credential types → Roles → Review). State: `key,name,description`; `credentialTypes: { name; title; validityDays; fields: FieldRow[] }[]` (each with a template picker populating `fields` from `api.credentialTemplates`, plus a `<SchemaFieldEditor>`); `issuer` (radio platform/org + org select from `api.orgs`), `holderPolicy` (any-onboarded / orgType / specific), `verifier` (any / orgs). On submit build the `CredentialUseCase` (each type = `{ name, title, validityDays, claimSchema: fieldsToSchema(fields) }`) and call `api.createCredentialUseCase`. Show coded errors inline. Reuse `Card`, `SectionHeader`, the wizard step styling from `UseCaseBuilder`.

- [ ] **Step 4: Identity list.** Create `apps/web/src/components/IdentityHome.tsx`: fetches `api.credentialUseCases(token)`, renders a list (name, credential types as `Pill`s, issuer/holder/verifier summary), an EmptyState when none, and a "New credential use case" button (PlatformAdmin only) that mounts `CredentialUseCaseBuilder`. Reuse the `PlatformHome` visual patterns.

- [ ] **Step 5: Nav wiring.** In `apps/web/src/App.tsx`, for **PlatformAdmin (no active use case)** add an `Identity` nav item (icon `shield`) rendering `IdentityHome`; add it to the `platViews` mapping and `PlatformHome`'s `view` union OR render `IdentityHome` directly in the platform-home branch when `view === "identity"`. Keep all existing predicates unchanged. (Full domain selector is ID-E; here Identity is one more platform-home section.)

- [ ] **Step 6: Verify web.**
Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: tsc clean, build clean.

- [ ] **Step 7: Commit.**
```bash
git add apps/web/src
git commit -m "feat(web): credential use-case builder + Identity section + shared field editor"
```

---

## Task 5: Verify — full suite, live browser walkthrough, finish branch

**Files:** none (verification + integration).

- [ ] **Step 1: Full api suite + core + web build.**
Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && (cd packages/core && ./node_modules/.bin/vitest run) && (cd apps/api && ./node_modules/.bin/vitest run) && pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: all green.

- [ ] **Step 2: Live browser walkthrough.** Boot the API (`bash scripts/dev-boot.sh` in its own terminal; DB reset first if the `CredentialUseCase` table is new: from `apps/api`, `DATABASE_URL="file:./dev.db" ./node_modules/.bin/prisma db push`), log in as `admin@tokenlayer.dev`, open the **Identity** section: confirm the seeded "Corporate Trade Credentials" use case shows (MCA + GSTIN). Click **New credential use case** → Basics → add a credential type from the **KYC** template, edit a field → bind Issuer=platform, Holder=any-onboarded, Verifier=any → Review → Create. Confirm it appears in the Identity list. Screenshot both the list and the builder.

- [ ] **Step 3: Finish the branch.** Use `superpowers:finishing-a-development-branch` (merge to main after tests pass on the merged result). ID-B (runtime) resumes from the config this produces.

---

## Notes for the implementer

- **DRY:** the field editor is shared (Task 4 Step 2) — do not duplicate it into the credential builder.
- **YAGNI:** ID-A stops at *configuration*. Do not implement credential issuance, holder wallets, verifier requests, or the domain selector here — those are ID-B..E.
- **Key uniqueness** spans both domains (a slug is either a token or a credential use case, never both) — enforced in the create route (Task 3 Step 3).
- **Tenancy safety:** credential use cases carry `ownerOrgId` but ID-A authors them as PlatformAdmin with `ownerOrgId: null`; no `claims.orgId` is set on any user, so no RBAC/onboarding paths change.
