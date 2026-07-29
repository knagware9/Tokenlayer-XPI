# Parameterized Templates + Enterprise Provisioning (ID-G) — Design

**Goal:** Turn the hand-authored Decentralized-Identity use cases (and the two seed scripts that provision them) into a **configurable, parameterized, enterprise-grade** capability: a catalog of **declarative parameterized templates** that an enterprise customer instantiates by filling declared parameters, and a **one-step provisioning** flow that stands up the whole bundle — issuer org + credential use case + optional Issuer/Holder/Verifier desk logins.

**Program context:** Builds on the Identity program (ID-A configurable credential use cases · ID-B issuer/holder/verifier runtime · ID-C wallet · ID-D QR login · ID-E domain shell · **ID-F credential use-case desk users**, all merged). ID-G generalizes the ad-hoc `scripts/seed-identity-usecases.mjs` + `scripts/seed-identity-desk-users.mjs` (which hardcode orgs, use cases and desk users) into a parameterized, in-product feature.

**Tech stack:** packages/core (the declarative template model + instantiation engine + built-in catalog), apps/api (Fastify — saved-template persistence + 3 routes + the provisioning executor), apps/web (React — the provisioning wizard + save-as-template). Reuses ID-F's org-bound issuance, scoped desk users, and domain-aware onboarding wholesale.

---

## Why declarative (the load-bearing decision)

Templates are **customer-saveable**, so a template must be **serializable data**, not code. Built-in and saved templates therefore share ONE representation (`UseCaseTemplate`) and ONE instantiation engine (`instantiateTemplate`). The five built-ins are just seed data in that declarative form; a saved template is the same shape persisted. This is the single most important constraint driving the model below.

---

## Scope

**In scope (ID-G):**
- A declarative `UseCaseTemplate` model + typed `TemplateParam` inputs + `instantiateTemplate(template, values) → CredentialUseCaseDefinition` (validates values, then materializes the body).
- A code-defined `TEMPLATE_CATALOG` of five built-ins (Education, Invoice Financing, Domicile, e-Governance — the deck four generalized — plus a generic single-claim template).
- Persistence for **customer-saved** templates; the catalog endpoint merges built-in + saved.
- Full-bundle **provisioning**: `POST /credential-use-cases/provision` → issuer org + use case (bound to it) + optional scoped desk users, idempotent.
- API: `GET /credential-templates`, `GET /credential-templates/:key`, `POST /credential-templates` (save custom), `POST /credential-templates/:key/preview` (instantiate, no persistence — powers the wizard Review), `POST /credential-use-cases/provision`.
- Web: a "Provision from template" wizard (catalog → parameter form → provisioning options → review → provision) + "Save as template".

**Out of scope (deferred / YAGNI):**
- Template versioning / publishing workflow (a saved template is mutable in place; no version history).
- Editing an already-provisioned use case *through* its template (provisioning is one-shot; the resulting use case is edited via the existing PATCH).
- A distinct "enterprise customer / tenant" persistence entity — the customer is expressed as the issuer org + the naming of its bundle, not a new tenant row (matches the current org-as-tenant model).
- Parameter types beyond `text | number | enum | boolean` (no nested/array params, no cross-param computed values other than the documented slug derivation).
- Any tokenization-domain or ledger change.

---

## Architecture

Four layers, each building on ID-A/ID-F:

1. **Template engine (core)** — the declarative `UseCaseTemplate` + `TemplateParam` types, a pure `instantiateTemplate`, a `validateTemplate` (structural) + `validateTemplateParams` (values vs declared params), and the built-in `TEMPLATE_CATALOG`.
2. **Saved templates (persistence + api)** — a `CredentialUseCaseTemplate` row (JSON body) + repo; `GET /credential-templates` merges built-ins with saved; `POST /credential-templates` validates + persists.
3. **Provisioning executor (api)** — `POST /credential-use-cases/provision`: resolve/instantiate the template → ensure issuer org → create the use case (reusing the existing create path + cross-type key guard) → optionally onboard scoped Issuer/Holder/Verifier via the ID-F gated flow → return the full result including any generated desk-user credentials.
4. **Wizard (web)** — a stepper in the Identity domain that renders the parameter form from `parameters`, collects provisioning options, previews the instantiated definition, and calls `/provision`; plus a save-as-template action.

---

## 1. Template model (core) — `packages/core/src/use-case-templates.ts` (new)

```ts
export type TemplateParamType = "text" | "number" | "enum" | "boolean";
export interface TemplateParam {
  name: string;            // machine name, referenced by ${name} / includeIf / resolvers
  label: string;           // form label
  type: TemplateParamType;
  required: boolean;
  default?: string | number | boolean;
  options?: string[];      // enum only
  min?: number; max?: number; // number only
  help?: string;
}

// A claim property may be gated on a boolean param (dropped when false).
type TemplateClaimProp = MetadataProp & { includeIf?: string };
interface TemplateCredentialType {
  name: string; title: string;           // ${param} interpolation allowed in title
  validityDays: number | { param: string };
  requiredApprovals: number | { param: string };
  required: string[];                    // claim keys; a key gated off is also removed here
  properties: Record<string, TemplateClaimProp>;
}
export interface UseCaseTemplate {
  key: string; name: string; category: string; description?: string;
  parameters: TemplateParam[];
  body: {
    keyTemplate: string;                 // e.g. "education-${jurisdictionSlug}" (slug-safe)
    nameTemplate: string;                // "${issuerOrgName} — Education Certificate"
    descriptionTemplate?: string;
    credentialTypes: TemplateCredentialType[];
    holderPolicy: HolderPolicy;          // literal for MVP (any-onboarded)
    verifier: VerifierBinding | { param: string }; // enum param → any | orgs
  };
  builtIn?: boolean;                     // true for catalog, absent for saved
}
```

- **`instantiateTemplate(t, values) → CredentialUseCaseDefinition`**: (1) `validateTemplateParams(t.parameters, values)` — required present, types match, enum in options, number in min/max; missing optionals fall back to `default`. (2) Materialize: interpolate `${name}` in text fields (plus a derived `${<name>Slug}` = lowercased/hyphenated form for the key), resolve `{ param }` numerics, drop claim properties whose `includeIf` param is false (and prune them from `required`), resolve the verifier param. (3) Return a `CredentialUseCaseDefinition`; the caller runs the existing `validateCredentialUseCase`.
- **`TEMPLATE_CATALOG: UseCaseTemplate[]`** — the five built-ins. Each declares sensible params: e.g. Education → `issuerOrgName` (text, required), `jurisdiction` (enum), `degreeValidityDays` (number, default 10950), `requiredApprovals` (number, default 1), `includeClassification` (boolean, default true). e-Governance → toggles for which of Income/Caste/Birth/TradeLicence credential types to include.
- `getTemplate(key)` resolves from catalog; the API overlays saved templates.

## 2. Saved templates (persistence + api)

- **Prisma** `CredentialUseCaseTemplate { id, key @unique, name, category, description?, body Json, parameters Json, ownerOrgId?, createdAt }` — `prisma db push` (no migration). Repo `credentialTemplates` on `AppDeps` (memory + prisma), wired at all construction sites.
- **`GET /credential-templates`** (authed) → `{ templates: [...builtIns, ...saved] }`, each `{ key, name, category, description, parameters, builtIn }` (body omitted from the list; a `GET /credential-templates/:key` returns the full body for preview/edit).
- **`POST /credential-templates`** (PlatformAdmin/OrgAdmin) → `validateTemplate(body)` then persist; a key colliding with a built-in or existing saved template → `409 TEMPLATE_KEY_TAKEN`.

## 3. Provisioning executor (api)

`POST /credential-use-cases/provision` (PlatformAdmin; OrgAdmin restricted to their own org as issuer). Body:
```jsonc
{ "templateKey": "education-certificate",
  "params": { "issuerOrgName": "Acme University", "jurisdiction": "IN", "requiredApprovals": 1 },
  "provisioning": { "issuerOrgType": "government", "createDeskUsers": true, "deskEmailDomain": "acme.edu" } }
```
Steps (each idempotent, matching the seed scripts' semantics):
1. Resolve template (catalog or saved); `instantiateTemplate(t, params)` → def; `validateCredentialUseCase(def)`.
2. **Issuer org**: find by `issuerOrgName`, else create (`POST /orgs` internals) → gives its DID. Bind `def.issuer = { kind: "org", orgId }`.
3. **Use case**: create via the existing credential-use-case create path (cross-type key guard applies); if the key exists, treat as re-provision (PATCH the binding) — or 409 if the caller set `failIfExists`.
4. **Desk users** (when `createDeskUsers`): onboard scoped `Issuer`/`Holder`/`Verifier` (useCaseKey = def.key) through the ID-F gated maker-checker path, generating emails from `deskEmailDomain` + a password each. (For a single-actor API call, the executor auto-approves as the platform, mirroring the seed scripts.)
5. Return `{ org, useCase, deskUsers: [{ email, password, role }] }` — the generated credentials are returned once, in the response.

Reuses ID-F wholesale: org-bound issuance, scoped-desk onboarding, domain resolution. No new gate.

## 4. Web wizard (Identity domain)

`ProvisionFromTemplate` component reached from the Identity home ("Provision from template", alongside "New credential use case"):
- **Step 1 — Template**: cards from `GET /credential-templates` (built-in badge + saved), grouped by `category`.
- **Step 2 — Parameters**: a form generated from `parameters` — text input, number (min/max), enum (select), boolean (checkbox); defaults prefilled; required enforced client-side.
- **Step 3 — Provisioning**: issuer-org name/type, "create desk logins" toggle + email domain.
- **Step 4 — Review**: shows the instantiated definition via `POST /credential-templates/:key/preview { params }` (server runs `instantiateTemplate` — the engine is NOT duplicated in the client) + what will be created.
- **Provision** → `POST /credential-use-cases/provision`; on success show created org/use-case and, if any, the desk-user credentials table (copyable, shown once).
- **Save as template**: from the builder or the wizard, `POST /credential-templates` persists a custom parameterized template that then appears in the catalog.

## Data flow

Enterprise admin opens **Identity → Provision from template**, picks *Education Certificate*, fills `issuerOrgName = "Acme University"`, `jurisdiction = IN`, toggles `includeClassification`, enables desk logins with domain `acme.edu`, reviews the materialized use case, and clicks Provision. The API creates the *Acme University* org (its DID), the `education-…` use case bound to it, and `issuer@acme.edu` / `holder@acme.edu` / `verifier@acme.edu` scoped desks — returning their one-time credentials. A saved custom template authored earlier appears in Step 1 next to the built-ins.

## Error handling

- Param validation failure → `400 INVALID_TEMPLATE_PARAMS` listing each problem (missing required, wrong type, enum/range).
- Instantiated def failing `validateCredentialUseCase` → `400 INVALID_USECASE` (as today).
- Use-case key already exists → re-provision (rebind) by default, or `409 KEY_TAKEN` when `failIfExists`.
- Template key collision on save → `409 TEMPLATE_KEY_TAKEN`.
- Partial provisioning: steps run in order; a failure after the org is created leaves the org (idempotent re-run reuses it) and reports which steps completed — no half-created use case (create is the atomic pivot).

## Testing

- **core:** `validateTemplateParams` matrix (required/type/enum/range/defaults); `instantiateTemplate` (interpolation, slug derivation, numeric-param resolution, `includeIf` pruning of a claim + its required entry, verifier-param resolution); each `TEMPLATE_CATALOG` entry instantiates to a def that passes `validateCredentialUseCase`.
- **api:** `GET /credential-templates` merges built-in + saved; save + collision (409); `provision` full bundle (org + use case + 3 desk users, each logs in scoped/identity), `createDeskUsers:false` path, re-provision idempotency, OrgAdmin issuer-scope restriction, bad params → 400.
- **web:** tsc + build; a live wizard walkthrough — provision *Education Certificate* for a new org with desk logins, confirm the org/use-case/users exist and a desk user logs into its scoped desk; save a custom template and see it in the catalog.

## Verification / done

Full core + api suites green (new template/provisioning tests) + web tsc/build + a live wizard walkthrough (built-in provision end-to-end, and a saved-template round-trip), then finish the branch.

## Alternatives considered

- **Code-function templates (a `build(params)` per template)** — simplest to write, but a saved template can't be a function; rejected in favour of one declarative representation shared by built-ins and saved templates.
- **A first-class tenant/customer entity** — heavier multi-tenancy; rejected for now: the issuer org already is the tenant boundary, and provisioning names the bundle after it.
- **Extending the flat `CREDENTIAL_TEMPLATES` (credential-type presets)** — that map is per-credential-type starters for the freehand builder, not whole-use-case parameterized templates; ID-G adds a new concept beside it rather than overloading it.
