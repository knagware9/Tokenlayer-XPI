# Certificate Config in the Template Catalog (ID-J) — Design

**Goal:** Carry the ID-I `certificate` config through the ID-G template catalog so a use case provisioned from a template (built-in or customer-saved) issues PDF-certificate-enabled credentials **immediately**, with no post-provision edit. Heading/subheading support `${param}` interpolation; the fitting built-ins ship with certificates enabled.

**Program context:** ID-G gave the Identity domain a declarative template catalog (`UseCaseTemplate` with a serializable `body`, one `instantiateTemplate` engine shared by built-ins and customer-saved templates, `POST /credential-use-cases/provision`). ID-I gave `CredentialTypeSpec` an optional `certificate` config (`{ enabled, heading?, subheading?, claimOrder?, logoDocumentId? }`) rendered on the fly at the public certificate route. ID-I deliberately left templates out of scope; ID-J closes that gap.

**Tech stack:** packages/core (`use-case-templates.ts` — the template shape, validation, and instantiation) + apps/web (`CredentialUseCaseBuilder.buildTemplate` save-as-template + a provisioning-preview indicator). apps/api is pass-through (template bodies persist as JSON; save/preview/provision already call the core functions) — verification only, no handler changes expected.

---

## The seam

`instantiateTemplate(t, values)` already emits concrete `CredentialTypeSpec[]` from `TemplateCredentialType[]`, interpolating `${param}` strings via `interp()` and pruning `includeIf`-gated claim properties. ID-J adds one optional field to `TemplateCredentialType` — `certificate?: CertificateConfig` (the ID-I type, reused as-is; no separate template shape) — and teaches instantiation to emit it:

- `enabled` and `logoDocumentId` copy through verbatim.
- `heading` / `subheading` run through `interp(…, vals)` — so a template can say `subheading: "${issuerOrgName}"` or `heading: "Certificate of Domicile — ${jurisdiction}"` and each provisioning localizes it.
- `claimOrder` is **filtered to the claim keys that survived `includeIf` pruning**. This is the one subtle rule: a template may gate a claim off with a boolean param; a verbatim `claimOrder` would then reference a pruned key and the ID-I `validateCredentialUseCase` would reject the emitted definition. Filtering keeps the emitted config always-valid. An emptied `claimOrder` is emitted as `undefined` (falls back to "all claims", matching ID-I semantics).

Because template bodies persist as opaque JSON (`CredentialUseCaseTemplate` Prisma column) and the template routes' schemas are permissive, the new field round-trips through save/get/preview/provision with **no persistence or schema migration and no API handler change** — the provision executor already validates and stores whatever `instantiateTemplate` returns, and ID-I's core validator now covers the certificate.

## Scope

**In scope (ID-J):**
- **Core:** `TemplateCredentialType.certificate?: CertificateConfig`; `validateTemplate` checks it (enabled boolean, string fields, every `claimOrder` entry ∈ that type's template `properties`); `instantiateTemplate` emits it with interpolation + `claimOrder` filtering; built-in catalog updates (below).
- **Built-ins:** enable certificates on **education-certificate** (heading "Degree Certificate", subheading `${issuerOrgName}`, claimOrder of its degree claims) and **domicile-certificate** (heading "Certificate of Domicile", subheading `${issuerOrgName}`, claimOrder of its domicile claims). invoice-financing, egovernance-certificate, and generic-credential stay off.
- **Web:** `buildTemplate` in `CredentialUseCaseBuilder` carries the authored certificate draft into the saved template body (reversing ID-I's deliberate omission — now in scope); the web `TemplateCredentialType` type gains `certificate?`; the ProvisionFromTemplate review step shows a small "PDF certificate" pill on previewed types that have one enabled.
- **API:** verification only — an integration test proving provision-from-template → cert-enabled use case → 200 PDF from the ID-I route.

**Out of scope (YAGNI / later):**
- Parameterizing `logoDocumentId` (stays a static document reference; a saved template snapshots the author's uploaded logo id).
- `${param}` in `claimOrder` or `enabled` (structural fields stay literal; `includeIf` already handles conditionality).
- A certificate-preview thumbnail in the provisioning wizard.
- Any change to the ID-I renderer, route, or `certificateAvailable` logic.

## Architecture & data flow

1. **Author time (saved templates):** an admin builds a use case in `CredentialUseCaseBuilder` with "Issue PDF certificate" configured, clicks *Save as template* → `buildTemplate` now includes `certificate` on each `TemplateCredentialType` (heading/subheading saved verbatim — the unparameterized snapshot semantics `buildTemplate` already has; parameters list stays `[]`).
2. **Catalog time (built-ins):** `TEMPLATE_CATALOG`'s education + domicile entries carry `certificate` with `${issuerOrgName}` in the subheading.
3. **Provision time:** `POST /credential-use-cases/provision` (or preview) → `instantiateTemplate` interpolates and emits `certificate` on the concrete `CredentialTypeSpec` → the existing create/rebind path runs ID-I's `validateCredentialUseCase` (which now validates the emitted certificate) and persists the use case → issued credentials are immediately `certificateAvailable` and the public `certificate.pdf` route serves them.

## Error handling

- A template `certificate` with a bad shape fails **at save time** (`validateTemplate` → 400 `INVALID_TEMPLATE`, same surface as other template problems) — never at provision time.
- `claimOrder` referencing a template property that doesn't exist ⇒ save-time failure; referencing one that exists but is `includeIf`-pruned at instantiation ⇒ silently filtered (documented behavior, tested).
- Templates without `certificate` (all existing saved templates, the untouched built-ins) instantiate byte-identically to today — full back-compat.
- An interpolated heading that resolves empty (param absent) falls back at render time to the type title (ID-I already defaults `heading ?? spec.title` — emit `undefined` when the interpolated string is empty/whitespace).

## Testing

- **core:** `instantiateTemplate` emits an interpolated certificate (`${issuerOrgName}` subheading resolves); `claimOrder` drops `includeIf`-pruned keys (and emits `undefined` when emptied); a template without `certificate` emits none (back-compat, existing template tests untouched); `validateTemplate` accepts a valid certificate and rejects non-boolean `enabled` / unknown `claimOrder` keys; the education + domicile built-ins instantiate with `certificate.enabled === true` and pass `validateCredentialUseCase`.
- **api:** provision from `domicile-certificate` → the created use case's type has `certificate.enabled`; issue a credential → `GET /credentials/:id/certificate.pdf` → 200 `%PDF-` (proves the whole chain through ID-I).
- **web:** tsc + build; live walkthrough — provision from the Domicile built-in via the wizard (review step shows the PDF-certificate pill), issue a credential to the provisioned Holder, download the certificate with zero manual certificate config; save-as-template from a cert-enabled builder draft → provision from the saved template → same result.

## Verification / done

Full core + api suites green + web tsc/build + the live walkthrough above, then finish the branch (`feat/template-certificate-config` → main).

## Alternatives considered

- **A template-specific certificate shape** (heading as `{ template: string }` etc.) — unnecessary; the ID-I `CertificateConfig` is already serializable and `interp()` is a no-op on strings without `${…}`, so reusing the concrete type keeps one shape everywhere (the ID-G design principle).
- **Enable certificates on all five built-ins** — a KYC-style or generic credential rarely wants a public printable certificate; enabling only the document-like built-ins (education, domicile) keeps the default privacy-lean.
- **Verbatim `claimOrder` + relaxed validation** — would let instantiated configs carry dangling claim keys and push the failure to render time; filtering at instantiation keeps ID-I's strict validator intact and the emitted config always-valid.
