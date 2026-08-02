# Certificate Config in the Template Catalog (ID-J) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Templates (built-in + customer-saved) carry the ID-I `certificate` config; `instantiateTemplate` emits it with `${param}`-interpolated heading/subheading and a `claimOrder` filtered to `includeIf`-surviving claims; the education + domicile built-ins ship cert-enabled; save-as-template preserves the authored certificate.

**Architecture:** One optional field (`TemplateCredentialType.certificate?: CertificateConfig` — the ID-I type reused verbatim) + validation + emission in `packages/core/src/use-case-templates.ts`. Template bodies persist as opaque JSON and the web treats `body` as `unknown`, so there is **no persistence/schema/API-handler change and no web type change** — apps/api gets only an integration test, apps/web only a one-line `buildTemplate` fix + a wizard pill.

**Tech Stack:** packages/core (TS, vitest), apps/api (Fastify, vitest — test only), apps/web (React).

**Spec:** `docs/superpowers/specs/2026-08-01-template-certificate-config-design.md`

**Conventions:** tests from repo root — `pnpm -s --filter @tokenlayer/core test`, `pnpm -s --filter @tokenlayer/api test`, `pnpm -s --filter @tokenlayer/web typecheck` / `build`. Commit after each task. **Never touch `apps/api/prisma/dev.db*`.**

**Key facts already verified:**
- `TemplateCredentialType` at `packages/core/src/use-case-templates.ts:61-70` (`name,title,validityDays,requiredApprovals,required,properties,includeIf?`). `validateTemplate` at `:99-113` — currently NO per-credential-type loop (only a non-empty check at `:112`). `instantiateTemplate` at `:175-227`; the credential-type map's emit block is the `return { name, title: interp(...), validityDays: num(...), requiredApprovals: num(...), claimSchema: ... }` at `:200-206`; `interp(s, vals)` at `:160-163`; `properties`/`required` pruning (the `includeIf` filter) is at `:193-199`.
- `CertificateConfig` is exported from `packages/core/src/credential-use-cases.ts` (ID-I): `{ enabled: boolean; heading?; subheading?; claimOrder?: string[]; logoDocumentId? }`. `validateCredentialUseCase` already validates an emitted `certificate` (incl. `claimOrder ⊆ claimSchema.properties`).
- Built-ins in `TEMPLATE_CATALOG` (`:254+`): `education-certificate` → type `DegreeCredential`, properties `studentName, institution, degree, conferredYear, classification (includeIf: "includeClassification"), rollNumber`. `domicile-certificate` → type `DomicileCredential`, properties `holderName, state, district, continuousResidenceSinceYear`.
- Core test file: `packages/core/test/use-case-templates.test.ts`.
- Web: `UseCaseTemplate.body` is `unknown` (opaque, server-owned) — `apps/web/src/types.ts:450`. `buildTemplate` in `apps/web/src/components/CredentialUseCaseBuilder.tsx:193-218` maps `def.credentialTypes` listing fields explicitly (currently drops `ct.certificate`; `buildDefinition` DOES include it since ID-I). `ProvisionFromTemplate.tsx` review step renders the preview as raw `JSON.stringify(preview)` (`:309-312`); `Pill` is already imported (`:5`); `preview` state is `unknown` (`:80`).
- API template routes + provisioning pass the body through and call the core functions; provision test harness exists in `apps/api/test` (grep `provision` — the ID-G suite, e.g. the test hitting `POST /credential-use-cases/provision`) and the ID-I PDF test harness is `apps/api/test/credential-certificate.test.ts`.

---

## Task J1: Core — `certificate` on `TemplateCredentialType` + validation + emission

**Files:**
- Modify: `packages/core/src/use-case-templates.ts`
- Test: `packages/core/test/use-case-templates.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/use-case-templates.test.ts` (match its existing imports/builders — it already imports `instantiateTemplate`, `validateTemplate`, and a template fixture style; reuse or add a minimal fixture):

```ts
const certTemplate = (certificate?: unknown): UseCaseTemplate => ({
  key: "cert-tpl", name: "Cert Tpl", category: "test", parameters: [
    { name: "issuerOrgName", label: "Issuer", type: "text", required: true },
    { name: "includeExtra", label: "Extra?", type: "boolean", required: false, default: true },
  ],
  body: {
    keyTemplate: "cert-${issuerOrgNameSlug}", nameTemplate: "${issuerOrgName} Certs",
    holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    credentialTypes: [{
      name: "DemoCredential", title: "Demo", validityDays: 365, requiredApprovals: 1,
      required: ["fullName"],
      properties: { fullName: { type: "string" }, extra: { type: "string", includeIf: "includeExtra" } },
      ...(certificate !== undefined ? { certificate } : {}),
    }],
  },
} as UseCaseTemplate);

describe("template certificate config", () => {
  const cert = { enabled: true, heading: "Demo Certificate — ${issuerOrgName}", subheading: "${issuerOrgName}", claimOrder: ["fullName", "extra"] };

  it("emits an interpolated certificate on instantiation", () => {
    const def = instantiateTemplate(certTemplate(cert), { issuerOrgName: "Acme" });
    const c = def.credentialTypes[0].certificate;
    expect(c?.enabled).toBe(true);
    expect(c?.heading).toBe("Demo Certificate — Acme");
    expect(c?.subheading).toBe("Acme");
    expect(c?.claimOrder).toEqual(["fullName", "extra"]);
  });

  it("filters claimOrder to includeIf-surviving claims", () => {
    const def = instantiateTemplate(certTemplate(cert), { issuerOrgName: "Acme", includeExtra: false });
    expect(def.credentialTypes[0].certificate?.claimOrder).toEqual(["fullName"]);
  });

  it("emits undefined claimOrder when filtering empties it, and undefined heading when interpolation is blank", () => {
    const t = certTemplate({ enabled: true, heading: "${missing}", claimOrder: ["extra"] });
    const def = instantiateTemplate(t, { issuerOrgName: "Acme", includeExtra: false });
    expect(def.credentialTypes[0].certificate?.claimOrder).toBeUndefined();
    expect(def.credentialTypes[0].certificate?.heading).toBeUndefined();
  });

  it("emits no certificate when the template has none (back-compat)", () => {
    const def = instantiateTemplate(certTemplate(), { issuerOrgName: "Acme" });
    expect(def.credentialTypes[0].certificate).toBeUndefined();
  });

  it("validateTemplate accepts a valid certificate and rejects bad ones", () => {
    expect(() => validateTemplate(certTemplate(cert))).not.toThrow();
    expect(() => validateTemplate(certTemplate({ enabled: "yes" }))).toThrow(/enabled/);
    expect(() => validateTemplate(certTemplate({ enabled: true, claimOrder: ["ghost"] }))).toThrow(/ghost|claimOrder/);
    expect(() => validateTemplate(certTemplate({ enabled: true, heading: 5 }))).toThrow(/heading/);
  });
});
```

(Note on the blank-heading test: `${missing}` interpolates to `""` because `interp` stringifies `vals[name] ?? ""` — asserting the emit-undefined-when-blank rule. `validateTemplate` intentionally does NOT reject `${param}` names it can't resolve — interpolation is lenient by design, matching `nameTemplate` behavior.)

- [ ] **Step 2: Run → verify FAIL**

Run: `pnpm -s --filter @tokenlayer/core test` — the new describe fails (no `certificate` on the emitted types; `validateTemplate` accepts everything).

- [ ] **Step 3: Type** (`use-case-templates.ts`)

Import the type (top of file, extend the existing import from `./credential-use-cases.js`):
```ts
import type { CertificateConfig, ... } from "./credential-use-cases.js";
```
(Check the existing import line — `CredentialUseCaseDefinition`, `CredentialTypeSpec`, `HolderPolicy`, `VerifierBinding` already come from there; add `CertificateConfig`.)

Add to `TemplateCredentialType` (after `includeIf?: string;` at `:69`):
```ts
  /** Optional ID-I PDF-certificate config. `heading`/`subheading` may contain
   *  `${param}` references (interpolated at instantiation); `claimOrder` is
   *  filtered to claims that survive `includeIf` pruning. */
  certificate?: CertificateConfig;
```

- [ ] **Step 4: Validation** (`validateTemplate`, after the `:112` non-empty check)

```ts
  for (const ct of t.body.credentialTypes) {
    const cert = ct.certificate;
    if (cert === undefined) continue;
    if (typeof cert.enabled !== "boolean") fail(`credential type '${ct.name}' certificate.enabled must be a boolean`);
    for (const [f, v] of [["heading", cert.heading], ["subheading", cert.subheading], ["logoDocumentId", cert.logoDocumentId]] as const)
      if (v !== undefined && typeof v !== "string") fail(`credential type '${ct.name}' certificate.${f} must be a string`);
    if (cert.claimOrder !== undefined) {
      if (!Array.isArray(cert.claimOrder) || cert.claimOrder.some((k) => typeof k !== "string"))
        fail(`credential type '${ct.name}' certificate.claimOrder must be an array of strings`);
      for (const k of cert.claimOrder)
        if (!(k in ct.properties)) fail(`credential type '${ct.name}' certificate.claimOrder references unknown claim '${k}'`);
    }
  }
```

- [ ] **Step 5: Emission** (`instantiateTemplate` — inside the credential-type `.map`, the emit block at `:200-206`)

The map callback already builds `properties` (the pruned set). Before the `return`, add:

```ts
      let certificate: CertificateConfig | undefined;
      if (ctpl.certificate) {
        const src = ctpl.certificate;
        const interpOrUndef = (s: string | undefined): string | undefined => {
          if (s === undefined) return undefined;
          const out = interp(s, vals).trim();
          return out || undefined;
        };
        const claimOrder = src.claimOrder?.filter((k) => k in properties);
        certificate = {
          enabled: src.enabled,
          heading: interpOrUndef(src.heading),
          subheading: interpOrUndef(src.subheading),
          claimOrder: claimOrder?.length ? claimOrder : undefined,
          logoDocumentId: src.logoDocumentId,
        };
      }
```

and extend the returned object:
```ts
      return {
        name: ctpl.name,
        title: interp(ctpl.title, vals),
        validityDays: num(ctpl.validityDays, vals),
        requiredApprovals: num(ctpl.requiredApprovals, vals),
        claimSchema: { type: "object", required, properties } satisfies MetadataSchema,
        ...(certificate ? { certificate } : {}),
      };
```

- [ ] **Step 6: Run → PASS + typecheck + commit**

`pnpm -s --filter @tokenlayer/core test` green (new + all existing); `pnpm -s --filter @tokenlayer/core typecheck` clean.

```bash
git add packages/core/src/use-case-templates.ts packages/core/test/use-case-templates.test.ts
git commit -m "feat(core): certificate config on template credential types — validate + interpolated emission"
```

---

## Task J2: Core — enable certificates on the education + domicile built-ins

**Files:**
- Modify: `packages/core/src/use-case-templates.ts` (`TEMPLATE_CATALOG`)
- Test: `packages/core/test/use-case-templates.test.ts`

- [ ] **Step 1: Failing tests**

```ts
describe("built-in certificate defaults", () => {
  it("education-certificate instantiates cert-enabled and valid", () => {
    const t = TEMPLATE_CATALOG.find((x) => x.key === "education-certificate")!;
    const def = instantiateTemplate(t, { issuerOrgName: "Acme University" });
    const c = def.credentialTypes[0].certificate;
    expect(c?.enabled).toBe(true);
    expect(c?.subheading).toBe("Acme University");
    expect(() => validateCredentialUseCase(def, { orgExists: () => true })).not.toThrow();
  });
  it("education claimOrder drops classification when toggled off", () => {
    const t = TEMPLATE_CATALOG.find((x) => x.key === "education-certificate")!;
    const def = instantiateTemplate(t, { issuerOrgName: "Acme University", includeClassification: false });
    expect(def.credentialTypes[0].certificate?.claimOrder).not.toContain("classification");
  });
  it("domicile-certificate instantiates cert-enabled and valid", () => {
    const t = TEMPLATE_CATALOG.find((x) => x.key === "domicile-certificate")!;
    const def = instantiateTemplate(t, { issuerOrgName: "Tehsildar Office" });
    expect(def.credentialTypes[0].certificate?.enabled).toBe(true);
    expect(() => validateCredentialUseCase(def, { orgExists: () => true })).not.toThrow();
  });
  it("the other built-ins stay certificate-free", () => {
    for (const key of ["invoice-financing", "egovernance-certificate", "generic-credential"]) {
      const t = TEMPLATE_CATALOG.find((x) => x.key === key)!;
      for (const ct of (t.body.credentialTypes)) expect(ct.certificate).toBeUndefined();
    }
  });
});
```
(Import `validateCredentialUseCase` from `../src/credential-use-cases.js` and `TEMPLATE_CATALOG` if not already imported.) Run → FAIL.

- [ ] **Step 2: Catalog edits**

In `TEMPLATE_CATALOG`, add to the **education-certificate** `DegreeCredential` entry (after its `properties` object):
```ts
          certificate: {
            enabled: true,
            heading: "Degree Certificate",
            subheading: "${issuerOrgName}",
            claimOrder: ["studentName", "institution", "degree", "conferredYear", "classification"],
          },
```
And to the **domicile-certificate** `DomicileCredential` entry:
```ts
          certificate: {
            enabled: true,
            heading: "Certificate of Domicile",
            subheading: "${issuerOrgName}",
            claimOrder: ["holderName", "state", "district", "continuousResidenceSinceYear"],
          },
```
Touch nothing else in the catalog.

- [ ] **Step 3: Run → PASS + commit**

Core suite green + typecheck clean.
```bash
git add packages/core/src/use-case-templates.ts packages/core/test/use-case-templates.test.ts
git commit -m "feat(core): education + domicile built-in templates ship PDF certificates enabled"
```

---

## Task J3: API — integration test: provision from template → live PDF

**Files:**
- Test: `apps/api/test/template-certificate.test.ts` (new)

No production api code changes are expected — this task PROVES the pass-through. If a handler/schema strips `certificate` anywhere (save, get, preview, provision), that is a bug to fix minimally in that handler (report it in the task output).

- [ ] **Step 1: Write the test**

Model the harness on the ID-G provision test (grep `credential-use-cases/provision` under `apps/api/test` and copy its buildTestApp/login/provision flow) and the ID-I PDF assertions (`apps/api/test/credential-certificate.test.ts`). Cases:

1. **Provision from the domicile built-in:** `POST /credential-use-cases/provision` with `templateKey: "domicile-certificate"`, `params: { issuerOrgName: "Tehsildar <unique>" }`, `provisioning: { issuerOrgType: "government", createDeskUsers: true, deskEmailDomain: "<unique>.gov" }` → 201; the returned `useCase.credentialTypes[0].certificate.enabled === true` and `subheading === "Tehsildar <unique>"`.
2. **Issue → PDF:** log in as the provisioned Issuer desk (or use the platform-admin path the ID-G test uses), issue a `DomicileCredential` to the provisioned Holder (claims incl. `holderName`), approve → `GET /credentials/:id/certificate.pdf` → 200, body starts `%PDF-`, length > 800. Also `GET /me/credentials` as the Holder shows `certificateAvailable: true`.
3. **Saved-template round-trip:** `POST /credential-use-case-templates` with a minimal template whose type carries `certificate` (`parameters: []`, literal key/name templates — mirror the web `buildTemplate` shape) → 201; `GET /credential-use-case-templates/:key` returns the body with `certificate` intact; `POST .../preview` (or provision) emits the certificate on the previewed definition.
4. **Invalid template certificate:** saving a template whose `certificate.claimOrder` references an unknown claim → 400 `INVALID_TEMPLATE`.

Run: `pnpm -s --filter @tokenlayer/api test` → the new file should PASS if pass-through holds (test-first here means: write it, run it; a failure localizes the stripping bug — fix minimally and rerun).

- [ ] **Step 2: Full api suite + commit**

`pnpm -s --filter @tokenlayer/api test` all green.
```bash
git add apps/api/test/template-certificate.test.ts
git commit -m "test(api): template certificate pass-through — provision from built-in to live PDF"
```
(Include any minimal handler fix in the same commit and note it in the message.)

---

## Task J4: Web — buildTemplate carries certificate + wizard review pill

**Files:**
- Modify: `apps/web/src/components/CredentialUseCaseBuilder.tsx` (`buildTemplate`)
- Modify: `apps/web/src/components/ProvisionFromTemplate.tsx` (review step)

- [ ] **Step 1: buildTemplate** (`CredentialUseCaseBuilder.tsx:204-211` — the `credentialTypes.map((ct) => ({ ... }))` inside `buildTemplate`)

`buildDefinition()` already includes `certificate` on each type (ID-I). The template map lists fields explicitly and drops it — add one line:
```ts
        credentialTypes: def.credentialTypes.map((ct) => ({
          name: ct.name,
          title: ct.title,
          validityDays: ct.validityDays,
          requiredApprovals: ct.requiredApprovals,
          required: ct.claimSchema.required ?? [],
          properties: ct.claimSchema.properties,
          ...(ct.certificate ? { certificate: ct.certificate } : {}),
        })),
```
Also update the function's doc comment: remove/adjust the sentence implying certificates are excluded (the ID-G follow-up TODO about `${param}` placeholders stays). No web type change — `UseCaseTemplate.body` is `unknown`.

- [ ] **Step 2: Review pill** (`ProvisionFromTemplate.tsx`, the review step around `:309-312` where `preview` renders as JSON)

Above the `<pre>{JSON.stringify(preview, null, 2)}</pre>`, derive and show cert-enabled types (defensive — `preview` is `unknown`):
```tsx
{(() => {
  const types = (preview as { credentialTypes?: { name: string; certificate?: { enabled?: boolean } }[] })?.credentialTypes ?? [];
  const certTypes = types.filter((t) => t.certificate?.enabled).map((t) => t.name);
  return certTypes.length ? (
    <div className="mb-2 flex items-center gap-1.5 flex-wrap">
      <Pill tone="info">PDF certificate</Pill>
      <span className="text-[11px] text-slate-500">{certTypes.join(", ")}</span>
    </div>
  ) : null;
})()}
```
(`Pill` is already imported. Place it inside the existing `preview !== null` branch so it only renders with a successful preview.)

- [ ] **Step 3: Verify + commit**

`pnpm -s --filter @tokenlayer/web typecheck` clean; `pnpm -s --filter @tokenlayer/web build` succeeds.
```bash
git add apps/web/src/components/CredentialUseCaseBuilder.tsx apps/web/src/components/ProvisionFromTemplate.tsx
git commit -m "feat(web): save-as-template carries certificate config + PDF-certificate pill in provisioning review"
```

---

## Task J5: Verify — suites + live walkthrough + review + finish

- [ ] **Step 1: Full suites**
```bash
pnpm -s typecheck
pnpm -s --filter @tokenlayer/core test
pnpm -s --filter @tokenlayer/api test
pnpm -s --filter @tokenlayer/web build
```
All green.

- [ ] **Step 2: Live walkthrough** (fast-boot: throwaway DB + `prisma db push`, `CHAIN_STRICT=0`, `CHAIN=""`, unset MST env for fast boot, `LOGIN_RATE_LIMIT_MAX=1000`; **never touch `dev.db`**; kill the API + delete the throwaway DB after)

Script or browser: ① `POST /credential-use-cases/provision` from `domicile-certificate` (built-in) → the created use case's type is cert-enabled with the issuer-org subheading, **zero manual certificate config**; ② issue a `DomicileCredential` to the provisioned Holder via the scoped Issuer desk → `certificateAvailable: true` → download the public `certificate.pdf` (assert `%PDF-`, open/screenshot it — the subheading shows the provisioned org name); ③ save a cert-enabled template via `POST /credential-use-case-templates` (buildTemplate shape) → provision/preview from it → certificate carried; ④ (if browser) the wizard review step shows the "PDF certificate" pill.

- [ ] **Step 3: Final review** — whole-implementation review (spec compliance + quality; focus: back-compat of certificate-free templates, the claimOrder filter vs the strict ID-I validator, blank-interpolation → undefined, built-ins limited to the two chosen, no api handler drift). Fix findings.

- [ ] **Step 4: Finish** — `superpowers:finishing-a-development-branch` (merge `feat/template-certificate-config` → main).

---

## Notes / risks

- **`validateTemplate` gains its first per-type loop** — keep it after the existing `:112` non-empty check so `t.body.credentialTypes` is known non-null.
- **The claimOrder filter runs against the PRUNED `properties`** built inside the map callback — the filter must sit after that loop (Step J1-5 places it just before the `return`).
- **Blank interpolation → `undefined`** (not `""`): ID-I's renderer falls back `heading ?? spec.title` only on undefined; an empty-string heading would render blank.
- **J3 is test-first pass-through proof**: expect zero api prod changes; if `certificate` is stripped anywhere, fix that handler minimally and say so.
- **Web `body` stays `unknown`** — do not introduce a web-side template body type; the one-line spread in `buildTemplate` is the entire carry.
- **Saved-template snapshot semantics**: `buildTemplate` saves heading/subheading verbatim (no `${param}`) — consistent with its existing unparameterized-snapshot design; interpolation is a no-op on literal strings.
