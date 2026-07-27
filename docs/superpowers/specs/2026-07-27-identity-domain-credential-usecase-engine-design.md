# Identity Domain — Configurable Credential Use-Case Engine (ID-A) — Design

**Goal:** Make DID/VC a first-class, configurable domain of XI. Configure a **credential use case** low-code — define custom credential types (name + claim fields, from a template or from scratch) and bind **Issuer / Holder / Verifier** — exactly the way tokenization use cases are configured today. ID-A delivers the *configuration engine* and its surfacing; the runtime that actually issues/holds/verifies against a configured credential use case is **ID-B**.

**Program context:** ID-A is the foundation of a 5-part "Identity platform" program (one XI app, two pluggable domains — Tokenization + Identity, sharing one core): **ID-A** configurable credential use-case engine · **ID-B** issuer/holder/verifier runtime · **ID-C** entity wallet + My Credentials · **ID-D** QR-code login · **ID-E** pluggable domain shell. This spec covers **ID-A only**. It supersedes the earlier narrow "government trade credentials" spec — MCA/GSTIN/IEC/PAN become one *seeded template + example credential use case* built through this engine, not a hardcoded feature.

**Tech stack:** packages/core (config types, templates, validation), apps/api (Fastify + Prisma/SQLite + Vitest), apps/web (React + Vite + Tailwind). Parallels the tokenization use-case machinery: `UseCaseDefinition`/`UseCase` model, `loadDefaultUseCaseDefinitions`/`seedUseCases`, the `UseCaseBuilder` wizard + its field editor, `MetadataSchema`/`PropertySchema` + `validateMetadata`, the `Organization` registry, and the closed `CREDENTIAL_TYPES` catalog (repackaged as templates).

---

## Scope

**In scope (ID-A):**
- A `CredentialUseCase` domain model (config), parallel to the token `UseCase` — credential types (custom claim schemas) + Issuer/Holder/Verifier bindings.
- `CREDENTIAL_TEMPLATES` (KYC, Company/MCA, GSTIN, Employment, Membership) as starting points.
- Core validation of a credential use case; persistence (model + repo); CRUD routes; a seeded example.
- Web: a **Credential Use-Case Builder** wizard (reusing the token builder's field editor) + an **Identity** section listing configured credential use cases.

**Out of scope (later):** actually issuing/holding/verifying against a configured use case (ID-B); entity wallet UI (ID-C); QR login (ID-D); the Identity/Tokenization domain selector + per-deployment enablement (ID-E). Maker-checker gating of OrgAdmin-authored credential use cases is a follow-up; ID-A authors them as **PlatformAdmin** (direct), matching how platform-level config is created.

---

## Architecture

Four components:
1. **Config model + templates + validation (core)** — the typed shape of a credential use case, the starter templates, and `validateCredentialUseCase`.
2. **Persistence (api)** — `CredentialUseCase` Prisma model + memory/prisma repos + `AppDeps.credentialUseCases`.
3. **Routes (api)** — create / list / get / update + templates + a seeded example at boot.
4. **Web** — the builder wizard + the Identity list, reusing existing primitives.

---

## 1. Config model + templates + validation (core)

New `packages/core/src/credential-use-cases.ts`:

```ts
export interface CredentialTypeSpec {
  name: string;                 // e.g. "MCACredential" — unique within the use case
  title: string;                // human label, e.g. "MCA Company Master"
  claimSchema: MetadataSchema;  // same shape the token builder produces for metadataSchema
  validityDays: number;         // default 365
}
export type IssuerBinding =
  | { kind: "platform" }                       // the platform issuer org signs
  | { kind: "org"; orgId: string };            // a specific registered org signs
export type HolderPolicy =
  | { who: "any-onboarded" }                   // any onboarded user/org may hold
  | { who: "orgType"; orgTypes: OrgType[] }    // holders limited by org type
  | { who: "specific"; orgIds: string[] };
export type VerifierBinding =
  | { kind: "any" }                            // any verifier org may request
  | { kind: "orgs"; orgIds: string[] };

export interface CredentialUseCaseDefinition {
  key: string;                 // slug, unique across BOTH domains
  name: string;
  description?: string;
  credentialTypes: CredentialTypeSpec[];   // >= 1
  issuer: IssuerBinding;
  holderPolicy: HolderPolicy;
  verifier: VerifierBinding;
}
```

`CREDENTIAL_TEMPLATES: Record<string, CredentialTypeSpec>` — KYC, Company/MCA, GSTIN, Employment, Membership — each a ready `{name,title,claimSchema,validityDays}` the builder loads and the configurer edits. Seeded from the existing catalog claim shapes so the closed catalog remains expressible.

`validateCredentialUseCase(def, { orgExists })` throws `PolicyError` on: empty/duplicate `key`; zero credential types; duplicate credential-type `name`; malformed `claimSchema` (reuse the token metadata-schema validator); an `issuer`/`verifier`/`holderPolicy` referencing an org id that does not exist. Pure; no I/O (org existence passed in as a predicate).

## 2. Persistence (api)

Prisma `CredentialUseCase` (JSON columns like the token `UseCase`):
```
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
`CredentialUseCaseRepository`: `create`, `get(key)`, `has(key)`, `list()`, `update(key, patch)`. Memory + Prisma implementations (Prisma mapper JSON-(de)serialises the four config columns). Wired into `AppDeps.credentialUseCases`. Key uniqueness is checked against BOTH `useCases` and `credentialUseCases` so a slug is unambiguous across domains.

## 3. Routes (api)

All `...auth`; authoring is **PlatformAdmin** (RBAC-gated); reads are broader.
- `GET /credential-templates` — the `CREDENTIAL_TEMPLATES` set (any authed user).
- `POST /credential-use-cases` — PlatformAdmin only. Body = `CredentialUseCaseDefinition`. `validateCredentialUseCase` (400 on failure); 409 `KEY_TAKEN` if the key exists in either domain; else create → 201.
- `GET /credential-use-cases` (+ `GET /credential-use-cases/:key`) — list/read configured credential use cases (any authed user; the Identity section renders these).
- `PATCH /credential-use-cases/:key` — PlatformAdmin; re-validate; 200.

Schemas in `schemas.ts` (a `CredentialUseCase` component + per-route request/response). Audit-append create/update.

**Seed:** at boot (non-production) seed one example credential use case — **"Corporate Trade Credentials"** — built from the MCA/GSTIN/IEC/PAN templates, `issuer: { kind: "platform" }` (or the configured Govt org once ID-B lands), `holderPolicy: any-onboarded`, `verifier: any` — so the Identity section is non-empty and demonstrates the engine. Idempotent (skip if key exists).

## 4. Web

- **Identity section** — a new nav area listing configured credential use cases (parallel to the tokenization use-case list), each showing its credential types + issuer/holder/verifier bindings. Visible to PlatformAdmin (authoring) and any role for read. (The full domain toggle is ID-E; ID-A adds the section unconditionally for now.)
- **Credential Use-Case Builder** — a wizard modelled on `UseCaseBuilder`:
  1. **Basics** — key, name, description.
  2. **Credential types** — add one or more credential types; each starts from a **template** (dropdown of `CREDENTIAL_TEMPLATES`) or blank, then edit fields with the **existing field-editor component** extracted/reused from `UseCaseBuilder` (name, kind, required, pattern).
  3. **Roles** — pick Issuer (platform / an org), Holder policy (any-onboarded / org types / specific), Verifier (any / specific orgs) from the org registry.
  4. **Review** — summary → `POST /credential-use-cases`.
- **api.ts / types.ts** — client methods for the four routes + `CredentialUseCase`, `CredentialTypeSpec`, `IssuerBinding`, `HolderPolicy`, `VerifierBinding`, `CredentialTemplate` types.

Reuse: the field-editor from `UseCaseBuilder` should be lifted into a shared component so both builders use one implementation (targeted refactor, not a rewrite).

## Data flow

Author (PlatformAdmin) opens the Credential Use-Case Builder → picks/edits credential types from templates → binds Issuer/Holder/Verifier → `POST /credential-use-cases` (validated, persisted) → it appears in the Identity list. ID-B later reads this config to drive issuance (issuer signs a configured credential type to a holder's DID) and verification (verifier requests configured types).

## Error handling

`PolicyError`-coded: `INVALID_CREDENTIAL_USECASE` (400, with the specific reason), `KEY_TAKEN` (409), `FORBIDDEN` (403, non-PlatformAdmin authoring), `NOT_FOUND` (404). Web surfaces the coded message inline in the builder.

## Testing

- **core**: `validateCredentialUseCase` (happy path; each failure mode — dup key, no types, dup type name, bad claim schema, unknown org id); templates are well-formed; key-uniqueness helper spans both domains.
- **api** (behavioural): create → list/get round-trips the config faithfully; PlatformAdmin-only authoring (Issuer/OrgAdmin/Buyer get 403); `KEY_TAKEN` across domains; `PATCH` update; templates endpoint; the seeded example is present at boot.
- **web**: tsc + build; a browser walkthrough — open the builder, load a template, edit a field, bind roles, save, and see the new credential use case in the Identity list.

## Verification / done

Full api suite green (with the new tests) + web tsc/build clean + a live browser walkthrough of authoring a credential use case, then finish the branch. ID-B (runtime) picks up from the config this produces.
