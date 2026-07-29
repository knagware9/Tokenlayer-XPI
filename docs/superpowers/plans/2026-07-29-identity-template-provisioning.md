# Parameterized Templates + Enterprise Provisioning (ID-G) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parameterized, saveable credential-use-case templates + one-step enterprise provisioning (issuer org + use case + optional scoped Issuer/Holder/Verifier desk logins).

**Architecture:** A declarative `UseCaseTemplate` (serializable, so built-ins and saved templates share one representation) + a pure `instantiateTemplate` engine in core; a `CredentialUseCaseTemplate` persistence model for saved templates; template + provisioning API routes; an Identity-domain wizard. Reuses ID-F's org-bound issuance and scoped-desk onboarding.

**Tech Stack:** packages/core (TS, vitest), apps/api (Fastify + Prisma/SQLite, vitest), apps/web (React + Vite + Tailwind).

**Spec:** `docs/superpowers/specs/2026-07-29-identity-template-provisioning-design.md`

**Conventions:** tests from repo root: `pnpm -s --filter @tokenlayer/core test`, `... @tokenlayer/api test`, `... @tokenlayer/web typecheck`. Prisma: after schema edit `cd apps/api && DATABASE_URL="file:./dev.db" ./node_modules/.bin/prisma db push --skip-generate && ./node_modules/.bin/prisma generate`. Commit after each task. Do NOT touch `apps/api/prisma/dev.db*`.

---

## Task G1: Core — template model, instantiation engine, built-in catalog

**Files:**
- Create: `packages/core/src/use-case-templates.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./use-case-templates.js";`)
- Test: `packages/core/test/use-case-templates.test.ts`

Reuses `CredentialUseCaseDefinition`, `HolderPolicy`, `VerifierBinding`, `validateCredentialUseCase` from `credential-use-cases.ts`, and `MetadataSchema` from `types.ts`.

- [ ] **Step 1: Write failing tests**

`packages/core/test/use-case-templates.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { TEMPLATE_CATALOG, getBuiltInTemplate, validateTemplateParams, instantiateTemplate, validateCredentialUseCase } from "../src/index.js";

const edu = () => getBuiltInTemplate("education-certificate");

describe("validateTemplateParams", () => {
  it("rejects a missing required param and a bad enum/range", () => {
    const t = edu();
    const probs = validateTemplateParams(t.parameters, {});
    expect(probs.some((p) => /issuerOrgName/.test(p))).toBe(true);
    expect(validateTemplateParams(t.parameters, { issuerOrgName: "U", jurisdiction: "ZZ" }).some((p) => /jurisdiction/.test(p))).toBe(true);
  });
  it("accepts valid params (defaults fill optionals)", () => {
    expect(validateTemplateParams(edu().parameters, { issuerOrgName: "Acme University", jurisdiction: "IN" })).toEqual([]);
  });
});

describe("instantiateTemplate", () => {
  it("interpolates, derives a slug key, resolves numeric params, prunes includeIf-off claims", () => {
    const def = instantiateTemplate(edu(), { issuerOrgName: "Acme University", jurisdiction: "IN", includeClassification: false, requiredApprovals: 2 });
    expect(def.key).toMatch(/^[a-z0-9-]+$/);
    expect(def.name).toContain("Acme University");
    const ct = def.credentialTypes[0];
    expect(ct.requiredApprovals).toBe(2);
    expect(ct.claimSchema.properties.classification).toBeUndefined();       // pruned
    expect(ct.claimSchema.required).not.toContain("classification");
  });
  it("every built-in instantiates to a valid credential use case", () => {
    for (const t of TEMPLATE_CATALOG) {
      const params = Object.fromEntries(t.parameters.map((p) => [p.name, p.default ?? (p.type === "text" ? "Sample Org" : p.type === "enum" ? p.options?.[0] : p.type === "number" ? (p.min ?? 1) : true)]));
      const def = instantiateTemplate(t, params);
      expect(() => validateCredentialUseCase(def, { orgExists: () => true })).not.toThrow();
    }
  });
});
```
Run: `pnpm -s --filter @tokenlayer/core test use-case-templates` → FAIL.

- [ ] **Step 2: Implement `use-case-templates.ts`**

```ts
import { PolicyError } from "./errors.js";
import type { CredentialUseCaseDefinition, CredentialTypeSpec, HolderPolicy, VerifierBinding } from "./credential-use-cases.js";
import type { MetadataSchema } from "./types.js";

export type TemplateParamType = "text" | "number" | "enum" | "boolean";
export interface TemplateParam {
  name: string; label: string; type: TemplateParamType; required: boolean;
  default?: string | number | boolean; options?: string[]; min?: number; max?: number; help?: string;
}
type NumOrParam = number | { param: string };
export interface TemplateClaimProp { type: "string" | "number"; enum?: string[]; pattern?: string; min?: number; max?: number; includeIf?: string; }
export interface TemplateCredentialType { name: string; title: string; validityDays: NumOrParam; requiredApprovals: NumOrParam; required: string[]; properties: Record<string, TemplateClaimProp>; }
export interface UseCaseTemplate {
  key: string; name: string; category: string; description?: string;
  parameters: TemplateParam[];
  body: { keyTemplate: string; nameTemplate: string; descriptionTemplate?: string; credentialTypes: TemplateCredentialType[]; holderPolicy: HolderPolicy; verifier: VerifierBinding | { param: string }; };
  builtIn?: boolean;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48) || "org";

/** Structural validation of a template (built-in or saved). Throws PolicyError. */
export function validateTemplate(t: UseCaseTemplate): void {
  const fail = (m: string): never => { throw new PolicyError("INVALID_TEMPLATE", m); };
  if (!t.key || !/^[a-z0-9-]+$/.test(t.key)) fail("template key must be a lowercase slug");
  if (!t.name?.trim()) fail("template name is required");
  const names = new Set<string>();
  for (const p of t.parameters) { if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(p.name)) fail(`bad param name '${p.name}'`); if (names.has(p.name)) fail(`duplicate param '${p.name}'`); names.add(p.name); if (p.type === "enum" && !(p.options?.length)) fail(`enum param '${p.name}' needs options`); }
  if (!t.body?.credentialTypes?.length) fail("template needs at least one credential type");
}

/** Validate a set of param VALUES against the declared parameters. Returns a list of problems (empty = ok). */
export function validateTemplateParams(params: TemplateParam[], values: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const p of params) {
    const v = values[p.name];
    if (v === undefined || v === "" || v === null) { if (p.required && p.default === undefined) problems.push(`missing required parameter '${p.name}'`); continue; }
    if (p.type === "number") { if (typeof v !== "number" || Number.isNaN(v)) { problems.push(`'${p.name}' must be a number`); continue; } if (p.min !== undefined && v < p.min) problems.push(`'${p.name}' must be >= ${p.min}`); if (p.max !== undefined && v > p.max) problems.push(`'${p.name}' must be <= ${p.max}`); }
    else if (p.type === "boolean") { if (typeof v !== "boolean") problems.push(`'${p.name}' must be a boolean`); }
    else if (p.type === "enum") { if (!p.options?.includes(String(v))) problems.push(`'${p.name}' must be one of: ${p.options?.join(", ")}`); }
    else { if (typeof v !== "string") problems.push(`'${p.name}' must be text`); }
  }
  return problems;
}

const resolved = (params: TemplateParam[], values: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const p of params) out[p.name] = values[p.name] ?? p.default;
  return out;
};
const interp = (s: string, vals: Record<string, unknown>): string =>
  s.replace(/\$\{(\w+)\}/g, (_, name: string) => name.endsWith("Slug") ? slug(String(vals[name.slice(0, -4)] ?? "")) : String(vals[name] ?? ""));
const num = (v: NumOrParam, vals: Record<string, unknown>): number => typeof v === "number" ? v : Number(vals[v.param]);

/** Materialize a template into a concrete CredentialUseCaseDefinition. Validates params first. */
export function instantiateTemplate(t: UseCaseTemplate, values: Record<string, unknown>): CredentialUseCaseDefinition {
  const probs = validateTemplateParams(t.parameters, values);
  if (probs.length) throw new PolicyError("INVALID_TEMPLATE_PARAMS", `template parameter errors: ${probs.join("; ")}`, { problems: probs });
  const vals = resolved(t.parameters, values);
  const credentialTypes: CredentialTypeSpec[] = t.body.credentialTypes.map((ctpl) => {
    const properties: MetadataSchema["properties"] = {};
    const required: string[] = [];
    for (const [key, prop] of Object.entries(ctpl.properties)) {
      if (prop.includeIf && !vals[prop.includeIf]) continue;                // gated off → drop
      const { includeIf, ...schemaProp } = prop; properties[key] = schemaProp;
      if (ctpl.required.includes(key)) required.push(key);
    }
    return { name: ctpl.name, title: interp(ctpl.title, vals), validityDays: num(ctpl.validityDays, vals), requiredApprovals: num(ctpl.requiredApprovals, vals), claimSchema: { type: "object", required, properties } };
  });
  const verifier: VerifierBinding = "param" in t.body.verifier ? (String(vals[(t.body.verifier as { param: string }).param]) === "any" ? { kind: "any" } : { kind: "orgs", orgIds: [] }) : t.body.verifier;
  return { key: interp(t.body.keyTemplate, vals), name: interp(t.body.nameTemplate, vals), description: t.body.descriptionTemplate ? interp(t.body.descriptionTemplate, vals) : undefined, credentialTypes, holderPolicy: t.body.holderPolicy, verifier };
}

export const TEMPLATE_CATALOG: UseCaseTemplate[] = [ /* see Step 3 */ ];
export function getBuiltInTemplate(key: string): UseCaseTemplate { const t = TEMPLATE_CATALOG.find((x) => x.key === key); if (!t) throw new PolicyError("UNKNOWN_TEMPLATE", `no built-in template '${key}'`); return t; }
```
Confirm `MetadataSchema["properties"]` is the right shape (it holds `Record<string, {type,...}>`); if the exported name differs, use the actual metadata-prop type. `CredentialTypeSpec` requires `{name,title,claimSchema,validityDays,requiredApprovals}`.

- [ ] **Step 3: Populate `TEMPLATE_CATALOG` (5 built-ins)**

Author five `UseCaseTemplate` entries (all `builtIn: true`), each generalizing the committed `scripts/seed-identity-usecases.mjs` configs into parameterized form. Minimum params on each: `issuerOrgName` (text, required), `requiredApprovals` (number, default 1, min 1). Per template:
- **education-certificate** (category "Education"): params + `jurisdiction` (enum, options `["IN","US","EU","Other"]`, default "IN"), `degreeValidityDays` (number, default 10950), `includeClassification` (boolean, default true). One credential type `DegreeCredential` with claims studentName/institution/degree/conferredYear(number)/rollNumber and a `classification` string prop `includeIf: "includeClassification"`; `keyTemplate: "education-${issuerOrgNameSlug}"`, `nameTemplate: "${issuerOrgName} — Education Certificate"`.
- **invoice-financing** (category "Finance"): `InvoiceCredential` + `AcceptanceCredential` (claims from the seed script); `keyTemplate: "invoice-financing-${issuerOrgNameSlug}"`.
- **domicile-certificate** (category "Government"): `DomicileCredential`; param `state` (text) used in claims and description.
- **egovernance-certificate** (category "Government"): four credential types each gated by a boolean param — `includeIncome`/`includeCaste`/`includeBirth`/`includeTradeLicence` (defaults true) — via a claim `includeIf`? NOTE `includeIf` prunes a *claim property*, not a whole credential type. To gate whole credential types, filter `body.credentialTypes` in `instantiateTemplate` by an optional `ctpl.includeIf` too — add that: in Step 2's `.map`, first `.filter((ct) => !ct.includeIf || vals[ct.includeIf])`. Add `includeIf?: string` to `TemplateCredentialType`. Update the test to cover a credential-type gated off.
- **generic-credential** (category "Generic"): a single credential type with a customizable `credentialLabel` (text) and one required `subjectName` claim — the minimal starting point.

Keep `verifier: { kind: "any" }`, `holderPolicy: { who: "any-onboarded" }` for all (a `verifierScope` enum param is optional polish; include it only if trivial).

- [ ] **Step 4: Export + run**

`packages/core/src/index.ts`: add `export * from "./use-case-templates.js";`. Run `pnpm -s --filter @tokenlayer/core test` (all green) + `typecheck`. Commit: `feat(core): declarative use-case template model + engine + catalog`.

---

## Task G2: Persistence — CredentialUseCaseTemplate model + repo + AppDeps

**Files:** `apps/api/prisma/schema.prisma`; the credential-use-case repo file(s) (mirror `CredentialUseCaseRepository` — grep `class .*CredentialUseCaseRepository` / the memory+prisma impls); `apps/api/src/context.ts` (`AppDeps` + the 6 construction sites: context.ts default, demo.ts, e2e-buy/carbon/tenancy/usecases.ts, and `test/helpers.ts`).

- [ ] **Step 1: Prisma model** (mirror `CredentialUseCase` at schema.prisma:80):
```prisma
model CredentialUseCaseTemplate {
  key         String   @id
  name        String
  category    String
  description String?
  parameters  String   // JSON: TemplateParam[]
  body        String   // JSON: UseCaseTemplate["body"]
  ownerOrgId  String?
  createdAt   DateTime @default(now())
}
```
Run the prisma db push + generate (against a scratch DB or the dev DB per the repo's convention — do NOT commit `dev.db`).

- [ ] **Step 2: Repo** — add `CredentialUseCaseTemplateRepository` interface `{ list(): Promise<UseCaseTemplate[]>; get(key): Promise<UseCaseTemplate | null>; create(t): Promise<UseCaseTemplate>; }` with a Memory impl and a Prisma impl (JSON-serialize `parameters`/`body`), mirroring the existing credential-use-case repos exactly.

- [ ] **Step 3: AppDeps** — add `credentialTemplates: CredentialUseCaseTemplateRepository;` to `AppDeps` (context.ts). Wire it at ALL construction sites (the 6 listed) — memory repo in tests/demo/e2e, prisma repo in the server build. `tsc` proves completeness.

- [ ] **Step 4: run** — `pnpm -s --filter @tokenlayer/api typecheck` clean; `pnpm -s --filter @tokenlayer/api test` green (no behavior change yet). Commit: `feat(api): CredentialUseCaseTemplate persistence + AppDeps`.

---

## Task G3: API — template routes (list / get / save / preview)

**Files:** `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`; test `apps/api/test/template-provisioning.test.ts` (new).

- [ ] **Step 1: Failing tests** — `GET /credential-templates` includes all 5 built-ins (`builtIn:true`) merged with saved; `POST /credential-templates` saves a custom template (201) and a duplicate/built-in-collision → 409 `TEMPLATE_KEY_TAKEN`; `POST /credential-templates/education-certificate/preview` with valid params returns an instantiated def whose `name` contains the org name; bad params → 400 `INVALID_TEMPLATE_PARAMS`. (Use `buildTestApp`/`loginAs`/`auth`/`V1`.)

- [ ] **Step 2: Routes** (import `TEMPLATE_CATALOG`, `getBuiltInTemplate`, `validateTemplate`, `instantiateTemplate` from core):
  - `GET /credential-templates` (authed): `const saved = await deps.credentialTemplates.list(); return { templates: [...TEMPLATE_CATALOG, ...saved].map(({ body, ...meta }) => meta) }` (list omits `body`).
  - `GET /credential-templates/:key`: built-in (getBuiltInTemplate) or saved (repo.get) → full template; 404 if neither.
  - `POST /credential-templates` (PlatformAdmin/OrgAdmin): `validateTemplate(body)`; reject if key is a built-in or `await deps.credentialTemplates.get(key)` exists → 409; persist; 201.
  - `POST /credential-templates/:key/preview` (authed): resolve template; `try { return { definition: instantiateTemplate(t, body.params) } } catch (e) { 400 with e.detail.problems }`.
  - Schemas in `schemas.ts` (loose responses, `bearer`, `errs(...)` per the file's conventions).

- [ ] **Step 3: run + commit** — api suite green. `feat(api): credential-template list/get/save/preview routes`.

---

## Task G4: API — provisioning executor

**Files:** `apps/api/src/http/routes.ts` (+ a helper module if the executor is large), `schemas.ts`; extend `template-provisioning.test.ts`.

- [ ] **Step 1: Failing tests** — `POST /credential-use-cases/provision` with `{ templateKey:"education-certificate", params:{issuerOrgName:"Acme University",jurisdiction:"IN"}, provisioning:{ issuerOrgType:"government", createDeskUsers:true, deskEmailDomain:"acme.edu" } }` → 201 returning `{ org, useCase, deskUsers:[Issuer,Holder,Verifier] }`; each returned desk user logs in (its `useCaseDomain==="identity"`, `useCaseKey===useCase.key`, correct role). A second identical call (idempotent) reuses the org + rebinds the use case (no duplicate org). `createDeskUsers:false` → `deskUsers:[]`. Missing required param → 400. An OrgAdmin may only provision with their own org as issuer (403 otherwise).

- [ ] **Step 2: Executor** — `POST /credential-use-cases/provision` (PlatformAdmin; OrgAdmin scoped):
  1. Resolve template (built-in/saved); `def = instantiateTemplate(t, params)`; then set `def.issuer` after the org exists.
  2. **Org**: `const org = (await deps.organizations.list()).find(o => o.name === issuerOrgName) ?? await <create-org internals>` — factor the create logic already in `POST /orgs` (routes.ts:1740) into a shared `ensureOrg(name, orgType)` helper and call it from both. `def.issuer = { kind:"org", orgId: org.id }`.
  3. **Use case**: if `deps.credentialUseCases.get(def.key)` exists → PATCH (rebind issuer) unless `failIfExists` → 409; else run the same create path as `POST /credential-use-cases` (validate + cross-type key guard + persist).
  4. **Desk users** (if `createDeskUsers`): for each of Issuer/Holder/Verifier, email `${role.toLowerCase()}@${deskEmailDomain}`, a generated password; create the scoped user directly (executor auto-approves as platform — reuse the onboard executor/user-creation path with `useCaseKey: def.key`, bypassing the two-step proposal since this is a single platform action; mirror how the seed script's approve step resolves). Collect `{email,password,role}`.
  5. Return `201 { org:{id,name,did}, useCase, deskUsers }`.
- Keep the VC-signer invariant (issuer is the bound org) and all ID-F gates intact — provisioning composes existing paths, adds no new gate.

- [ ] **Step 3: run + commit** — api suite green (full). `feat(api): enterprise template provisioning executor`.

---

## Task G5: Web — client + types

**Files:** `apps/web/src/types.ts`, `apps/web/src/api.ts`.

- [ ] Add types `TemplateParam`, `UseCaseTemplate` (meta + optional body), `ProvisionResult { org; useCase; deskUsers: {email;password;role}[] }`. Add client methods: `credentialTemplates(token)` → list; `credentialTemplate(token,key)` → full; `previewTemplate(token,key,params)` → `{definition}`; `saveTemplate(token,body)`; `provision(token,body)` → `ProvisionResult`. Typecheck. Commit `feat(web): template + provisioning client and types`.

---

## Task G6: Web — provisioning wizard

**Files:** `apps/web/src/components/ProvisionFromTemplate.tsx` (new); reuse `ui.tsx` primitives.

- [ ] Build a 4-step stepper: (1) template cards from `credentialTemplates` grouped by `category` (built-in badge); (2) a parameter form generated from the selected template's `parameters` (text/number/enum/boolean inputs, defaults prefilled, required marked); (3) provisioning options (`issuerOrgName`, `issuerOrgType` select, `createDeskUsers` checkbox, `deskEmailDomain`); (4) review — call `previewTemplate` and render the instantiated definition, then a **Provision** button → `provision(...)`. On success render a result panel: created org + use case, and a **copyable desk-credentials table** (shown once). Handle 400 param errors inline. Typecheck + build. Commit `feat(web): enterprise provisioning wizard`.

---

## Task G7: Web — wire into Identity home + save-as-template

**Files:** `apps/web/src/components/IdentityHome.tsx`, `apps/web/src/App.tsx` (if a nav id is needed).

- [ ] Add a **"Provision from template"** action next to "New credential use case" in `IdentityHome` (PlatformAdmin/OrgAdmin) that mounts `ProvisionFromTemplate`. Add a **"Save as template"** affordance: from `CredentialUseCaseBuilder` (or the wizard review), let the user persist the current parameterized config via `saveTemplate` so it appears in the catalog. Keep the existing freehand builder intact. Typecheck + build. Commit `feat(web): identity-home provisioning entry + save-as-template`.

---

## Task G8: Verify — suites + live wizard walkthrough + finish branch

- [ ] `pnpm -s typecheck` (5 pkgs); `pnpm -s --filter @tokenlayer/core test`; `pnpm -s --filter @tokenlayer/api test`; `pnpm -s --filter @tokenlayer/web build`. All green.
- [ ] **Live walkthrough** (fast-boot: throwaway DB, `CHAIN_STRICT=0`, no chain env): as PlatformAdmin open Identity → Provision from template → Education Certificate → params (issuerOrgName "Acme University", jurisdiction IN) → enable desk logins (domain acme.edu) → review → provision. Confirm the org, use case, and three desk users exist; log in as `issuer@acme.edu` and see its scoped Education desk. Save a custom template and confirm it appears in the catalog. Screenshots.
- [ ] **Final review** — whole-implementation code review (spec compliance + quality; security focus on the provision executor's org/user creation and OrgAdmin scoping); fix findings.
- [ ] **Finish** — `superpowers:finishing-a-development-branch` (merge `feat/identity-template-provisioning` to main).

---

## Notes / risks

- **The instantiation engine (G1) is the crux.** Cover `${param}`/`${paramSlug}` interpolation, numeric-param resolution, claim-`includeIf` pruning (property AND its `required` entry), and whole-credential-type `includeIf` filtering. Every catalog entry must instantiate to a def that passes `validateCredentialUseCase`.
- **Provisioning idempotency** hinges on matching the issuer org by name and treating an existing use-case key as a rebind — mirror the seed scripts' semantics exactly.
- **Desk-user creation in the executor**: prefer reusing the existing user-creation/onboard path with `useCaseKey` set; if the gated proposal path is awkward for a single server action, create-and-auto-approve as platform (document it). Never weaken the ID-F role/domain gate.
- **Returned credentials** (desk-user passwords) are shown once in the response/UI — do not persist them in plaintext anywhere else.
- **AppDeps completeness**: every new required field must be wired at all construction sites or `tsc` fails — do it in G2.
