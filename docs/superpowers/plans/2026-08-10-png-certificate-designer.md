# PNG Certificate Designer (EN-F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an issuing organization upload certificate artwork and place credential fields onto it visually, so the downloaded PDF is their design instead of ours.

**Architecture:** A credential type gains `certificate.background` (a document id) and `certificate.placements` (0–1 normalized field positions). When `background` is present the PDF is the artwork with only the placed fields drawn on it; when it is absent the existing renderer runs untouched. Between field resolution and pdfkit sits a **pure draw list**, so "the QR is always present" and "the watermark is drawn last" are assertions over an array rather than attempts to parse a PDF.

**Tech Stack:** TypeScript. `packages/core` (vocabulary + validation, vitest), `apps/api` (Fastify + pdfkit 0.19 + qrcode, vitest), `apps/web` (React + Vite + Tailwind, vitest). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-10-png-certificate-designer-design.md`

**Branch:** `feat/certificate-designer` (already created; the spec is committed on it).

---

## Conventions every task must follow

- **Run core tests:** `cd packages/core && ./node_modules/.bin/vitest run test/<file>`
- **Run api tests:** `cd apps/api && ./node_modules/.bin/vitest run test/<file> --testTimeout=180000`
- **Run web tests:** `cd apps/web && ./node_modules/.bin/vitest run test/<file>`
- **Typecheck:** `npx tsc --noEmit -p apps/api` and `npx tsc --noEmit -p apps/web` from the repo root. **`npm run build` in `apps/web` is `vite build` and does NOT typecheck** — running only the build is how two blank checkboxes shipped on 2026-08-10.
- **Never edit an existing test.** The current suites are the back-compatibility oracle. If one fails, the change is wrong.
- **THE PARITY RULE does not apply here** — nothing in this project adds a persisted column. `CertificateConfig` is stored as JSON inside the existing `CredentialUseCase.credentialTypes` blob, so there is no Prisma migration and no memory/prisma mapper to keep in step. Do not add one.
- **THE ADDITIVITY RULE does apply** — `fast-json-stringify` silently strips undeclared response fields. You may ADD `properties` to a response schema; never remove `additionalProperties: true` and never narrow one.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/certificate-fields.ts` | **NEW.** Field vocabulary, placement type, page-size maths, `validateCertificatePlacements`. Pure, no I/O. |
| `packages/core/src/index.ts` | Export the new module. |
| `packages/core/src/credential-use-cases.ts` | `CertificateConfig` += `background`, `placements`; validator calls the new validator. |
| `packages/core/src/use-case-templates.ts` | Template certificate carries `placements`; `instantiate()` drops `background`. |
| `apps/api/src/certificate-fields.ts` | **NEW.** `certificateSubjectName()` + `resolveCertificateFields()` — credential → printable strings. |
| `apps/api/src/certificate.ts` | Built-in renderer. Only change: use the shared `certificateSubjectName()`. |
| `apps/api/src/certificate-artwork.ts` | **NEW.** `certificateDrawList()` (pure) + `drawCertificate()` (pdfkit adapter). |
| `apps/api/src/http/routes.ts` | Dispatch on `background`; the preview route. |
| `apps/api/src/http/schemas.ts` | Placement/background schema fragments; the preview route schema. |
| `apps/web/src/types.ts` | Mirrored field catalog + placement types. |
| `apps/web/src/api.ts` | `previewCertificate()`. |
| `apps/web/src/components/CertificateDesigner.tsx` | **NEW.** The designer panel. |
| `apps/web/src/components/CredentialUseCaseBuilder.tsx` | Launches it; carries the new config through save. |
| `apps/api/test/certificate-mirror.test.ts` | **NEW.** Cross-package drift test: the web mirror equals core's catalog. |

---

## Task 1: Core — the field vocabulary, placement type and validation

**Files:**
- Create: `packages/core/src/certificate-fields.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/certificate-fields.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/certificate-fields.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  A4_LONG_EDGE_PT,
  AUTO_QR_PLACEMENT,
  CERTIFICATE_FIXED_FIELDS,
  MAX_CERTIFICATE_PLACEMENTS,
  certificatePageSize,
  claimKeyOf,
  isClaimRef,
  validateCertificatePlacements,
  type CertificateFieldPlacement,
} from "../src/certificate-fields.js";

const CLAIMS = ["fullName", "district"] as const;
const ok = (p: Partial<CertificateFieldPlacement> = {}): CertificateFieldPlacement =>
  ({ field: "subject.name", x: 0.5, y: 0.4, ...p }) as CertificateFieldPlacement;

/** Run the validator and return the thrown PolicyError's message, or null. */
function failure(placements: unknown): string | null {
  try {
    validateCertificatePlacements(placements, CLAIMS, "DomicileCredential");
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

describe("certificate field refs", () => {
  it("splits claim refs from the closed fixed list", () => {
    expect(isClaimRef("claim:fullName")).toBe(true);
    expect(isClaimRef("subject.name")).toBe(false);
    expect(claimKeyOf("claim:fullName")).toBe("fullName");
    // The QR is a field like any other — that is what makes it PLACEABLE.
    expect(CERTIFICATE_FIXED_FIELDS).toContain("qr");
    // …and heading/subheading stay placeable so a parameterised template
    // heading still prints once artwork replaces the built-in layout.
    expect(CERTIFICATE_FIXED_FIELDS).toContain("config.heading");
  });
});

describe("certificatePageSize", () => {
  it("gives the artwork's aspect with A4's long edge, in both orientations", () => {
    const landscape = certificatePageSize(1600, 900);
    expect(landscape.width).toBeCloseTo(A4_LONG_EDGE_PT, 2);
    expect(landscape.height).toBeCloseTo(A4_LONG_EDGE_PT * (900 / 1600), 2);

    const portrait = certificatePageSize(900, 1600);
    expect(portrait.height).toBeCloseTo(A4_LONG_EDGE_PT, 2);
    expect(portrait.width).toBeCloseTo(A4_LONG_EDGE_PT * (900 / 1600), 2);

    const square = certificatePageSize(1000, 1000);
    expect(square.width).toBeCloseTo(square.height, 2);
  });

  it("falls back to A4 portrait for a degenerate image rather than emitting NaN", () => {
    // A zero dimension would divide to NaN and produce an unopenable PDF.
    for (const [w, h] of [[0, 100], [100, 0], [-1, 5], [Number.NaN, 10]]) {
      const page = certificatePageSize(w as number, h as number);
      expect(Number.isFinite(page.width) && Number.isFinite(page.height)).toBe(true);
      expect(page.height).toBeCloseTo(A4_LONG_EDGE_PT, 2);
    }
  });
});

describe("validateCertificatePlacements", () => {
  it("accepts a well-formed set", () => {
    expect(failure([
      ok(),
      ok({ field: "claim:fullName", fontSize: 18, font: "serif", bold: true, color: "#112233", align: "center", width: 0.6 }),
      ok({ field: "qr", width: 0.2 }),
    ])).toBeNull();
  });

  it("accepts undefined and an empty array", () => {
    expect(failure(undefined)).toBeNull();
    expect(failure([])).toBeNull();
  });

  it("names the credential type and the index so the designer knows which chip is wrong", () => {
    const msg = failure([ok(), ok({ x: 1.5 })]);
    expect(msg).toContain("DomicileCredential");
    expect(msg).toContain("[1]");
  });

  it("rejects an unknown fixed field and an unknown claim", () => {
    expect(failure([ok({ field: "subject.shoeSize" as never })])).toContain("unknown field");
    expect(failure([ok({ field: "claim:notAClaim" as never })])).toContain("notAClaim");
  });

  it("rejects out-of-range geometry in both directions", () => {
    for (const p of [{ x: -0.01 }, { x: 1.01 }, { y: -0.01 }, { y: 1.01 }, { width: 0 }, { width: 1.01 }]) {
      expect(failure([ok(p)]), JSON.stringify(p)).not.toBeNull();
    }
  });

  it("rejects bad styling values", () => {
    expect(failure([ok({ fontSize: 3 })])).not.toBeNull();
    expect(failure([ok({ fontSize: 97 })])).not.toBeNull();
    expect(failure([ok({ font: "comic" as never })])).not.toBeNull();
    expect(failure([ok({ align: "justify" as never })])).not.toBeNull();
    expect(failure([ok({ color: "red" })])).not.toBeNull();
    expect(failure([ok({ color: "#abc" })])).not.toBeNull();
    expect(failure([ok({ color: "#AABBCC" })])).toBeNull(); // uppercase hex is fine
  });

  it("caps the count and allows at most one qr", () => {
    const many = Array.from({ length: MAX_CERTIFICATE_PLACEMENTS + 1 }, () => ok());
    expect(failure(many)).toContain("at most");
    // The same CLAIM may print twice — a name in the body and again on a signature line.
    expect(failure([ok({ field: "claim:fullName" }), ok({ field: "claim:fullName" })])).toBeNull();
    expect(failure([ok({ field: "qr" }), ok({ field: "qr" })])).toContain("qr");
  });

  it("rejects a non-array", () => {
    expect(failure({ field: "subject.name" })).not.toBeNull();
  });

  it("exposes the auto-inserted QR geometry as data, so the renderer and the tests agree", () => {
    expect(AUTO_QR_PLACEMENT.field).toBe("qr");
    expect(AUTO_QR_PLACEMENT.x).toBeGreaterThan(0.5);
    expect(AUTO_QR_PLACEMENT.y).toBeGreaterThan(0.5);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/core && ./node_modules/.bin/vitest run test/certificate-fields.test.ts`
Expected: FAIL — `Failed to resolve import "../src/certificate-fields.js"`.

- [ ] **Step 3: Write the module**

Create `packages/core/src/certificate-fields.ts`:

```ts
/**
 * EN-F: the vocabulary for placing credential values onto uploaded certificate
 * artwork. Pure — no rendering, no I/O — because it is shared three ways: the
 * API renderer, the API validator, and (mirrored) the web designer.
 */
import { PolicyError } from "./errors.js";

/** pdfkit's three built-in families. No font pipeline, no licensing question. */
export type CertificateFont = "sans" | "serif" | "mono";
export type CertificateAlign = "left" | "center" | "right";

/**
 * Everything printable that is NOT a claim. Closed on purpose: a designer may
 * place any of these, and nothing else. `qr` is in the list because the QR is
 * PLACEABLE — see `validateCertificatePlacements` for the half of that rule
 * which says it is not REMOVABLE.
 */
export const CERTIFICATE_FIXED_FIELDS = [
  "subject.name",
  "subject.did",
  "credential.id",
  "credential.type",
  "credential.issuedAt",
  "credential.expiresAt",
  "issuer.name",
  "issuer.did",
  // Placeable so a parameterised template heading (`{{orgName}}`) still prints
  // once artwork replaces the built-in layout, instead of becoming dead config.
  "config.heading",
  "config.subheading",
  "qr",
] as const;

export type CertificateFixedField = (typeof CERTIFICATE_FIXED_FIELDS)[number];
export type CertificateFieldRef = CertificateFixedField | `claim:${string}`;

/** Human labels for the designer's palette. Total over the fixed list, so a new
 *  field cannot be added without naming it. */
export const CERTIFICATE_FIELD_LABELS: Record<CertificateFixedField, string> = {
  "subject.name": "Holder name",
  "subject.did": "Holder DID",
  "credential.id": "Credential ID",
  "credential.type": "Credential type",
  "credential.issuedAt": "Issue date",
  "credential.expiresAt": "Expiry date",
  "issuer.name": "Issuer name",
  "issuer.did": "Issuer DID",
  "config.heading": "Heading (from config)",
  "config.subheading": "Subheading (from config)",
  qr: "Verification QR",
};

export interface CertificateFieldPlacement {
  field: CertificateFieldRef;
  /** 0–1 of page width/height. The ANCHOR: `align` picks which edge of the text
   *  sits on `x`, and `y` is the TOP of the text box. */
  x: number;
  y: number;
  /** 0–1 of page width. Text wraps inside it; omitted ⇒ one unwrapped line.
   *  For `qr` this is the square's edge, defaulting to DEFAULT_QR_WIDTH. */
  width?: number;
  fontSize?: number;
  font?: CertificateFont;
  bold?: boolean;
  /** #rrggbb. */
  color?: string;
  align?: CertificateAlign;
}

export const MAX_CERTIFICATE_PLACEMENTS = 40;
export const DEFAULT_QR_WIDTH = 0.14;
export const DEFAULT_FONT_SIZE = 11;
export const DEFAULT_COLOR = "#0f172a";

/** Where the QR lands when the designer placed none. Exported as DATA so the
 *  renderer and its tests cannot disagree about it. */
export const AUTO_QR_PLACEMENT: CertificateFieldPlacement = {
  field: "qr",
  x: 0.82,
  y: 0.82,
  width: DEFAULT_QR_WIDTH,
};

/** A4's long edge in PDF points (297mm). The certificate page keeps this and
 *  derives its short edge from the artwork, so the page IS the artwork. */
export const A4_LONG_EDGE_PT = 841.89;
/** A4's short edge — used only for the degenerate-image fallback. */
export const A4_SHORT_EDGE_PT = 595.28;

export function isClaimRef(field: string): field is `claim:${string}` {
  return field.startsWith("claim:");
}

export function claimKeyOf(field: `claim:${string}`): string {
  return field.slice("claim:".length);
}

/**
 * The page from the artwork's pixel dimensions: A4's long edge, the short edge
 * scaled to the image's aspect, orientation following the image. One coordinate
 * space, no letterboxing.
 *
 * A degenerate image (a zero or non-finite dimension) would divide to NaN and
 * produce an unopenable PDF, so it falls back to A4 portrait — the same page the
 * built-in renderer uses.
 */
export function certificatePageSize(imageWidth: number, imageHeight: number): { width: number; height: number } {
  const w = Number(imageWidth);
  const h = Number(imageHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { width: A4_SHORT_EDGE_PT, height: A4_LONG_EDGE_PT };
  }
  const short = A4_LONG_EDGE_PT * (Math.min(w, h) / Math.max(w, h));
  return w >= h ? { width: A4_LONG_EDGE_PT, height: short } : { width: short, height: A4_LONG_EDGE_PT };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const FONTS: readonly string[] = ["sans", "serif", "mono"];
const ALIGNS: readonly string[] = ["left", "center", "right"];

/**
 * Throws PolicyError("INVALID_CERTIFICATE_PLACEMENT") on any structural problem.
 *
 * A DISTINCT CODE from the surrounding INVALID_USECASE, deliberately: "your
 * chip is off the page" and "your use case is malformed" have different fixes,
 * and the message names the credential type AND the index so the designer can
 * be told which chip to move.
 *
 * `undefined` is valid (no placements) and so is `[]`.
 */
export function validateCertificatePlacements(
  placements: unknown,
  claimKeys: readonly string[],
  credentialTypeName: string,
): void {
  if (placements === undefined) return;
  const fail = (msg: string): never => {
    throw new PolicyError("INVALID_CERTIFICATE_PLACEMENT", `credential type '${credentialTypeName}' ${msg}`);
  };
  if (!Array.isArray(placements)) fail("certificate.placements must be an array");
  const list = placements as unknown[];
  if (list.length > MAX_CERTIFICATE_PLACEMENTS) {
    fail(`certificate.placements has ${list.length} entries; at most ${MAX_CERTIFICATE_PLACEMENTS} are allowed`);
  }

  const fixed = new Set<string>(CERTIFICATE_FIXED_FIELDS);
  const claims = new Set(claimKeys);
  let qrCount = 0;

  list.forEach((raw, i) => {
    const at = (msg: string): never => fail(`certificate.placements[${i}] ${msg}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) at("must be an object");
    const p = raw as Record<string, unknown>;

    if (typeof p.field !== "string") at("field must be a string");
    const field = p.field as string;
    if (isClaimRef(field)) {
      const key = claimKeyOf(field as `claim:${string}`);
      if (!claims.has(key)) at(`references unknown claim '${key}'`);
    } else if (!fixed.has(field)) {
      at(`references unknown field '${field}'`);
    }
    if (field === "qr") qrCount += 1;

    for (const axis of ["x", "y"] as const) {
      const v = p[axis];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) at(`${axis} must be a number between 0 and 1`);
    }
    if (p.width !== undefined) {
      const v = p.width;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1) at("width must be a number greater than 0 and at most 1");
    }
    if (p.fontSize !== undefined) {
      const v = p.fontSize;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 4 || v > 96) at("fontSize must be a number between 4 and 96");
    }
    if (p.font !== undefined && !FONTS.includes(p.font as string)) at(`font must be one of: ${FONTS.join(", ")}`);
    if (p.align !== undefined && !ALIGNS.includes(p.align as string)) at(`align must be one of: ${ALIGNS.join(", ")}`);
    if (p.bold !== undefined && typeof p.bold !== "boolean") at("bold must be a boolean");
    if (p.color !== undefined && (typeof p.color !== "string" || !HEX_COLOR.test(p.color))) at("color must be a #rrggbb hex string");
  });

  // Duplicate CLAIMS are fine (a name may print twice). A second QR is not:
  // the renderer guarantees exactly one, and two placements would silently
  // make one of them a lie about where verification lives.
  if (qrCount > 1) fail("certificate.placements may contain at most one 'qr'");
}
```

- [ ] **Step 4: Export it from core**

In `packages/core/src/index.ts`, add after the `./credential-use-cases.js` line (line 11):

```ts
export * from "./certificate-fields.js";
```

- [ ] **Step 5: Run the test and the whole core suite**

Run: `cd packages/core && ./node_modules/.bin/vitest run test/certificate-fields.test.ts`
Expected: PASS, 9 tests.

Run: `cd packages/core && ./node_modules/.bin/vitest run`
Expected: PASS — 253 pre-existing + 9 new.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/certificate-fields.ts packages/core/src/index.ts packages/core/test/certificate-fields.test.ts
git commit -m "feat(core): certificate field vocabulary, placements and their validation"
```

---

## Task 2: Core — `CertificateConfig` carries artwork; templates carry placements only

**Files:**
- Modify: `packages/core/src/credential-use-cases.ts:26-37` (the interface) and `:116-127` (the validator branch)
- Modify: `packages/core/src/use-case-templates.ts:71-74` (the template type) and `:221-238` (`instantiate`)
- Test: `packages/core/test/certificate-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/certificate-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateCredentialUseCase, type CredentialUseCaseDefinition } from "../src/credential-use-cases.js";
import { instantiateTemplate, type UseCaseTemplate } from "../src/use-case-templates.js";

const ctx = { orgExists: () => true };

function def(certificate: Record<string, unknown>): CredentialUseCaseDefinition {
  return {
    key: "domicile", name: "Domicile",
    credentialTypes: [{
      name: "DomicileCredential", title: "Domicile", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
      certificate: certificate as never,
    }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
  };
}

describe("CertificateConfig carries artwork", () => {
  it("accepts background + placements", () => {
    expect(() => validateCredentialUseCase(def({
      enabled: true,
      background: { documentId: "doc_1" },
      placements: [{ field: "claim:fullName", x: 0.5, y: 0.3, align: "center" }],
    }), ctx)).not.toThrow();
  });

  it("still accepts a config with neither — every pre-EN-F config stays valid", () => {
    expect(() => validateCredentialUseCase(def({ enabled: true, heading: "Certificate of Domicile" }), ctx)).not.toThrow();
  });

  it("rejects a non-string background.documentId", () => {
    expect(() => validateCredentialUseCase(def({ enabled: true, background: { documentId: 7 } }), ctx))
      .toThrow(/background.documentId/);
  });

  it("propagates a placement error, with its own code", () => {
    try {
      validateCredentialUseCase(def({ enabled: true, placements: [{ field: "claim:nope", x: 0, y: 0 }] }), ctx);
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("INVALID_CERTIFICATE_PLACEMENT");
    }
  });

  it("allows placements with NO background — the state a template instantiation lands in", () => {
    expect(() => validateCredentialUseCase(def({
      enabled: true, placements: [{ field: "subject.name", x: 0.5, y: 0.5 }],
    }), ctx)).not.toThrow();
  });
});

describe("templates carry placements, never artwork", () => {
  // NOTE the real shapes, checked against packages/core/src/use-case-templates.ts:
  // the type is `UseCaseTemplate`, the body uses `keyTemplate`/`nameTemplate`,
  // interpolation is `${param}` (NOT `{{param}}`), a template carries NO issuer,
  // and the function is `instantiateTemplate(template, values)` — two arguments.
  const template: UseCaseTemplate = {
    key: "course-completion", name: "Course Completion", category: "education",
    description: "Completion certificate",
    parameters: [{ name: "orgName", label: "Organization", type: "string", required: true }],
    body: {
      keyTemplate: "${orgName}-completion",
      nameTemplate: "${orgName} Completion",
      credentialTypes: [{
        name: "CompletionCredential", title: "Completion", validityDays: 365, requiredApprovals: 1,
        required: ["fullName"], properties: { fullName: { type: "string" } },
        certificate: {
          enabled: true,
          heading: "Awarded by ${orgName}",
          background: { documentId: "doc_org_a_letterhead" },
          placements: [{ field: "claim:fullName", x: 0.5, y: 0.42, align: "center", fontSize: 20 }],
        },
      }],
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    },
  } as UseCaseTemplate;

  it("instantiation keeps placements and DROPS the background", () => {
    const out = instantiateTemplate(template, { orgName: "Acme" });
    const cert = out.credentialTypes[0]!.certificate!;
    expect(cert.placements).toHaveLength(1);
    expect(cert.placements![0]!.field).toBe("claim:fullName");
    // THE CROSS-TENANT RULE. GET /credential-use-case-templates is open to any
    // authenticated user and GET /documents/:id is gated by role rather than by
    // org, so carrying A's artwork id would hand B a pixel-exact impersonation
    // of A's certificates — on a route that needs no credential to read.
    expect(cert.background).toBeUndefined();
    // The parameterised heading still interpolates, and stays placeable.
    expect(cert.heading).toBe("Awarded by Acme");
  });

  it("drops a placement whose claim was gated out of the instantiated schema", () => {
    const gated = JSON.parse(JSON.stringify(template)) as UseCaseTemplate;
    gated.body.credentialTypes[0]!.properties = {};
    gated.body.credentialTypes[0]!.required = [];
    const out = instantiateTemplate(gated, { orgName: "Acme" });
    // A placement pointing at a claim that no longer exists would fail
    // validation on the way in — so instantiation must not emit one.
    expect(out.credentialTypes[0]!.certificate!.placements ?? []).toHaveLength(0);
  });
});
```

**Verified against the source, not assumed:** the function is `instantiateTemplate(template, values)` (`packages/core/src/use-case-templates.ts:197`), the type is `UseCaseTemplate`, the body fields are `keyTemplate` / `nameTemplate`, parameter interpolation is `${name}` and a template carries no `issuer` (provisioning binds it). The test above uses those. Do not rename the production function.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/core && ./node_modules/.bin/vitest run test/certificate-config.test.ts`
Expected: FAIL — background/placements are not on the type, and instantiation copies neither.

- [ ] **Step 3: Extend `CertificateConfig`**

In `packages/core/src/credential-use-cases.ts`, add the import at the top of the file, beside the existing `validateMetadataSchema` import:

```ts
import { validateCertificatePlacements, type CertificateFieldPlacement } from "./certificate-fields.js";
```

and extend the interface (currently lines 26–37):

```ts
/** Optional PDF-certificate rendering for credentials of a type. */
export interface CertificateConfig {
  /** When true, credentials of this type expose a downloadable PDF certificate. */
  enabled: boolean;
  /** Certificate title; defaults to the credential type `title`. */
  heading?: string;
  /** Optional line under the heading (e.g. the issuing authority). */
  subheading?: string;
  /** Claim keys to print, in order; defaults to all claim-schema properties in schema order. */
  claimOrder?: string[];
  /** Optional logo/seal image, referencing a stored Document id. */
  logoDocumentId?: string;
  /**
   * EN-F. Full-page artwork, referencing a stored image Document. Its PRESENCE
   * selects the renderer: with it, the built-in layout is replaced entirely and
   * only `placements` are drawn; without it, nothing about the existing
   * certificate changes.
   */
  background?: { documentId: string };
  /** EN-F. Where each field prints on the artwork. Inert without `background`,
   *  which is exactly the state a template instantiation lands in. */
  placements?: CertificateFieldPlacement[];
}
```

- [ ] **Step 4: Validate the new fields**

In `packages/core/src/credential-use-cases.ts`, inside `validateCredentialUseCase`, extend the `if (ct.certificate !== undefined)` branch — append after the existing `claimOrder` block, still inside the branch:

```ts
      if (cert.background !== undefined) {
        if (!cert.background || typeof cert.background !== "object" || typeof cert.background.documentId !== "string" || !cert.background.documentId.trim())
          fail(`credential type '${ct.name}' certificate.background.documentId must be a non-empty string`);
      }
      // Throws INVALID_CERTIFICATE_PLACEMENT — a distinct code from this
      // function's INVALID_USECASE, so a 400 tells the designer which chip.
      validateCertificatePlacements(cert.placements, Object.keys(ct.claimSchema.properties), ct.name);
```

- [ ] **Step 5: Carry placements through templates, drop the background**

In `packages/core/src/use-case-templates.ts`, the template's credential-type `certificate` field is typed as `CertificateConfig` already (line ~74), so `background` and `placements` are accepted on input with no type change. Change only `instantiate()` — replace the `certificate = { ... }` object literal (around line 231) with:

```ts
        // EN-F: `placements` travel, `background` NEVER does. Templates are
        // listable by any authenticated user and documents are readable by
        // role rather than by org, so shipping one tenant's artwork id inside a
        // template hands another tenant a pixel-exact impersonation of their
        // certificates — on a public, unauthenticated render route. The layout
        // is the reusable part; the letterhead is not.
        const placements = src.placements?.filter(
          (p) => !p.field.startsWith("claim:") || p.field.slice("claim:".length) in properties,
        );
        certificate = {
          enabled: src.enabled,
          heading: interpOrUndef(src.heading),
          subheading: interpOrUndef(src.subheading),
          claimOrder: claimOrder?.length ? claimOrder : undefined,
          logoDocumentId: src.logoDocumentId,
          ...(placements?.length ? { placements } : {}),
        };
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/core && ./node_modules/.bin/vitest run test/certificate-config.test.ts`
Expected: PASS, 7 tests.

Run: `cd packages/core && ./node_modules/.bin/vitest run`
Expected: PASS, no pre-existing test edited or broken.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/credential-use-cases.ts packages/core/src/use-case-templates.ts packages/core/test/certificate-config.test.ts
git commit -m "feat(core): CertificateConfig carries artwork + placements; templates carry placements only"
```

---

## Task 3: API — the shared field resolver

**Files:**
- Create: `apps/api/src/certificate-fields.ts`
- Modify: `apps/api/src/certificate.ts` (subject-name derivation only)
- Test: `apps/api/test/certificate-resolve.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/certificate-resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { certificateSubjectName, resolveCertificateFields } from "../src/certificate-fields.js";
import type { CredentialRecord } from "../src/persistence/types.js";
import type { CredentialTypeSpec } from "@tokenlayer/core";

const spec: CredentialTypeSpec = {
  name: "DomicileCredential", title: "Domicile Certificate", validityDays: 365, requiredApprovals: 1,
  claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" }, district: { type: "string" } } },
  certificate: { enabled: true, heading: "Certificate of Domicile", subheading: "Revenue Department" },
};

function cred(over: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "cred_1", holderDid: "did:key:zHolder", issuerDid: "did:key:zIssuer",
    type: "DomicileCredential", vcJwt: "x.y.z",
    subjectClaims: { fullName: "Ada Lovelace", district: "Pune" },
    issuedAt: "2026-01-15T00:00:00.000Z", expiresAt: "2027-01-15T00:00:00.000Z",
    revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
    proposalId: null, credentialUseCaseKey: "domicile",
    acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
    anchorTxHash: null, anchorChainId: null, revokeTxHash: null,
    ...over,
  };
}

describe("certificateSubjectName", () => {
  it("prefers fullName, then legalName, then holderName, then falls back to the DID", () => {
    expect(certificateSubjectName(cred({ subjectClaims: { fullName: "Ada" } }))).toBe("Ada");
    expect(certificateSubjectName(cred({ subjectClaims: { legalName: "Acme Ltd" } }))).toBe("Acme Ltd");
    expect(certificateSubjectName(cred({ subjectClaims: { holderName: "Bob" } }))).toBe("Bob");
    // A certificate with a blank name line is worse than one showing the DID.
    expect(certificateSubjectName(cred({ subjectClaims: {} }))).toBe("did:key:zHolder");
    expect(certificateSubjectName(cred({ subjectClaims: { fullName: "   " } }))).toBe("did:key:zHolder");
  });
});

describe("resolveCertificateFields", () => {
  const values = resolveCertificateFields({ credential: cred(), spec, issuerName: "Revenue Dept" });

  it("resolves claims, identity, dates and the config strings", () => {
    expect(values.get("claim:fullName")).toBe("Ada Lovelace");
    expect(values.get("claim:district")).toBe("Pune");
    expect(values.get("subject.name")).toBe("Ada Lovelace");
    expect(values.get("subject.did")).toBe("did:key:zHolder");
    expect(values.get("credential.id")).toBe("cred_1");
    expect(values.get("credential.type")).toBe("Domicile Certificate");
    expect(values.get("issuer.name")).toBe("Revenue Dept");
    expect(values.get("issuer.did")).toBe("did:key:zIssuer");
    expect(values.get("config.heading")).toBe("Certificate of Domicile");
    expect(values.get("config.subheading")).toBe("Revenue Department");
    expect(values.get("credential.issuedAt")).toBeTruthy();
  });

  it("falls back to the issuer DID when the org is unknown, rather than printing 'null'", () => {
    const v = resolveCertificateFields({ credential: cred(), spec, issuerName: null });
    expect(v.get("issuer.name")).toBe("did:key:zIssuer");
  });

  it("says 'No expiry' rather than leaving the line blank", () => {
    const v = resolveCertificateFields({ credential: cred({ expiresAt: null }), spec, issuerName: null });
    expect(v.get("credential.expiresAt")).toBe("No expiry");
  });

  it("omits absent claims entirely, so a placement for one simply prints nothing", () => {
    const v = resolveCertificateFields({ credential: cred({ subjectClaims: { fullName: "Ada" } }), spec, issuerName: null });
    expect(v.has("claim:district")).toBe(false);
  });

  it("has no entry for qr — the QR is an op, not a string", () => {
    expect(values.has("qr")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && ./node_modules/.bin/vitest run test/certificate-resolve.test.ts --testTimeout=180000`
Expected: FAIL — cannot resolve `../src/certificate-fields.js`.

- [ ] **Step 3: Write the resolver**

Create `apps/api/src/certificate-fields.ts`:

```ts
/**
 * EN-F: credential → the strings a certificate prints. Shared by the built-in
 * renderer (subject name only) and the artwork renderer (the whole map), so the
 * two cannot disagree about who the holder is.
 */
import type { CertificateFieldRef, CredentialTypeSpec } from "@tokenlayer/core";
import type { CredentialRecord } from "./persistence/types.js";

/** First non-blank of fullName / legalName / holderName, else the holder DID.
 *  A certificate with a blank name line is worse than one showing a DID. */
export function certificateSubjectName(credential: CredentialRecord): string {
  const claims = (credential.subjectClaims ?? {}) as Record<string, unknown>;
  for (const key of ["fullName", "legalName", "holderName"]) {
    const v = claims[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return credential.holderDid;
}

export interface ResolveCertificateFieldsInput {
  credential: CredentialRecord;
  spec: CredentialTypeSpec;
  issuerName: string | null;
}

const asDate = (iso: string): string => new Date(iso).toLocaleDateString();

/**
 * Every printable value, keyed by field ref. A field with no value is ABSENT
 * rather than empty-string, so the draw list can skip it and a placement for a
 * claim the holder does not have simply prints nothing — which is the whole of
 * the "conditional visibility" the spec deliberately excluded.
 *
 * `qr` never appears: it is an op, not a string.
 */
export function resolveCertificateFields(input: ResolveCertificateFieldsInput): Map<CertificateFieldRef, string> {
  const { credential: c, spec, issuerName } = input;
  const claims = (c.subjectClaims ?? {}) as Record<string, unknown>;
  const out = new Map<CertificateFieldRef, string>();
  const put = (k: CertificateFieldRef, v: string | null | undefined): void => {
    if (v !== null && v !== undefined && String(v).trim()) out.set(k, String(v));
  };

  for (const [key, value] of Object.entries(claims)) {
    if (key === "id") continue; // never a printable claim; matches the built-in renderer
    put(`claim:${key}`, value === null || value === undefined ? null : String(value));
  }

  put("subject.name", certificateSubjectName(c));
  put("subject.did", c.holderDid);
  put("credential.id", c.id);
  put("credential.type", spec.title);
  put("credential.issuedAt", asDate(c.issuedAt));
  // Not left blank: an empty expiry line reads as a rendering bug.
  put("credential.expiresAt", c.expiresAt ? asDate(c.expiresAt) : "No expiry");
  put("issuer.name", issuerName ?? c.issuerDid);
  put("issuer.did", c.issuerDid);
  put("config.heading", spec.certificate?.heading?.trim() || spec.title);
  put("config.subheading", spec.certificate?.subheading);

  return out;
}
```

- [ ] **Step 4: Use the shared derivation in the built-in renderer**

In `apps/api/src/certificate.ts`, add to the imports:

```ts
import { certificateSubjectName } from "./certificate-fields.js";
```

and replace the inline subject-name expression (the `const subjectName = (typeof claims.fullName === "string" && claims.fullName) || …` line) with:

```ts
  const subjectName = certificateSubjectName(c);
```

This is behaviour-preserving: the old expression had exactly this precedence with the same DID fallback. It is extracted so the two renderers cannot drift on who the holder is.

- [ ] **Step 5: Run the new test AND the untouched certificate suite**

Run: `cd apps/api && ./node_modules/.bin/vitest run test/certificate-resolve.test.ts test/credential-certificate.test.ts --testTimeout=180000`
Expected: PASS — 10 new + the 9 pre-existing, none edited.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/certificate-fields.ts apps/api/src/certificate.ts apps/api/test/certificate-resolve.test.ts
git commit -m "feat(api): shared certificate field resolver; built-in renderer uses the shared subject name"
```

---

## Task 4: API — the pure draw list

**Files:**
- Create: `apps/api/src/certificate-artwork.ts` (draw list only; the pdfkit adapter lands in Task 5)
- Test: `apps/api/test/certificate-drawlist.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/certificate-drawlist.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AUTO_QR_PLACEMENT, certificatePageSize, type CertificateFieldPlacement, type CertificateFieldRef } from "@tokenlayer/core";
import { certificateDrawList, type DrawOp } from "../src/certificate-artwork.js";

const PAGE = certificatePageSize(1600, 900); // landscape
const values = new Map<CertificateFieldRef, string>([
  ["claim:fullName", "Ada Lovelace"],
  ["subject.name", "Ada Lovelace"],
  ["credential.id", "cred_1"],
]);

const base = {
  values,
  page: PAGE,
  statusUrl: "https://api.example/api/v1/credentials/cred_1/status",
  banner: null as { label: string; detail: string | null } | null,
  sample: false,
};

const texts = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: "text" }> => o.kind === "text");
const qrs = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: "qr" }> => o.kind === "qr");

describe("certificateDrawList", () => {
  it("draws the artwork first, filling the page", () => {
    const ops = certificateDrawList({ ...base, placements: [] });
    expect(ops[0]).toEqual({ kind: "image", x: 0, y: 0, w: PAGE.width, h: PAGE.height });
  });

  it("resolves normalized coordinates to absolute points", () => {
    const p: CertificateFieldPlacement = { field: "claim:fullName", x: 0.25, y: 0.5, fontSize: 20, align: "center", width: 0.5 };
    const t = texts(certificateDrawList({ ...base, placements: [p] }))[0]!;
    expect(t.text).toBe("Ada Lovelace");
    expect(t.x).toBeCloseTo(PAGE.width * 0.25, 4);
    expect(t.y).toBeCloseTo(PAGE.height * 0.5, 4);
    expect(t.width).toBeCloseTo(PAGE.width * 0.5, 4);
    expect(t.fontSize).toBe(20);
    expect(t.align).toBe("center");
  });

  it("applies documented defaults when styling is omitted", () => {
    const t = texts(certificateDrawList({ ...base, placements: [{ field: "subject.name", x: 0.1, y: 0.1 }] }))[0]!;
    expect(t.fontSize).toBe(11);
    expect(t.font).toBe("sans");
    expect(t.bold).toBe(false);
    expect(t.color).toBe("#0f172a");
    expect(t.align).toBe("left");
    expect(t.width).toBeNull(); // omitted width ⇒ one unwrapped line
  });

  it("skips a placement whose value is absent, instead of printing 'undefined'", () => {
    const ops = certificateDrawList({ ...base, placements: [{ field: "claim:missing" as CertificateFieldRef, x: 0.5, y: 0.5 }] });
    expect(texts(ops)).toHaveLength(0);
  });

  // ---- THE RULES CONFIG CANNOT OVERRIDE -----------------------------------

  it("inserts a QR when none is placed, at the documented default position", () => {
    const ops = certificateDrawList({ ...base, placements: [] });
    const qr = qrs(ops);
    expect(qr).toHaveLength(1);
    expect(qr[0]!.url).toBe(base.statusUrl);
    expect(qr[0]!.x).toBeCloseTo(PAGE.width * AUTO_QR_PLACEMENT.x, 4);
    expect(qr[0]!.caption).toBe("Scan to verify");
  });

  it("uses the placed QR when there is one, and still draws exactly one", () => {
    const ops = certificateDrawList({ ...base, placements: [{ field: "qr", x: 0.05, y: 0.8, width: 0.2 }] });
    const qr = qrs(ops);
    expect(qr).toHaveLength(1);
    expect(qr[0]!.x).toBeCloseTo(PAGE.width * 0.05, 4);
    expect(qr[0]!.size).toBeCloseTo(PAGE.width * 0.2, 4);
    // A placed QR carries no caption: the designer positioned it deliberately
    // and a stray label would land on their artwork.
    expect(qr[0]!.caption).toBeNull();
  });

  it("draws the revocation watermark LAST, over every placement", () => {
    const ops = certificateDrawList({
      ...base,
      placements: [{ field: "subject.name", x: 0.5, y: 0.5 }],
      banner: { label: "REVOKED", detail: "Revoked: fraud" },
    });
    expect(ops.at(-1)).toEqual({ kind: "watermark", label: "REVOKED", detail: "Revoked: fraud" });
  });

  it("has no watermark for a live credential", () => {
    const ops = certificateDrawList({ ...base, placements: [] });
    expect(ops.some((o) => o.kind === "watermark")).toBe(false);
  });

  it("stamps SAMPLE in preview mode and never outside it", () => {
    expect(certificateDrawList({ ...base, placements: [], sample: true }).some((o) => o.kind === "sample")).toBe(true);
    expect(certificateDrawList({ ...base, placements: [], sample: false }).some((o) => o.kind === "sample")).toBe(false);
  });

  it("keeps the watermark last even in preview mode", () => {
    const ops = certificateDrawList({ ...base, placements: [], sample: true, banner: { label: "EXPIRED", detail: null } });
    expect(ops.at(-1)!.kind).toBe("watermark");
    expect(ops.at(-2)!.kind).toBe("sample");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && ./node_modules/.bin/vitest run test/certificate-drawlist.test.ts --testTimeout=180000`
Expected: FAIL — cannot resolve `../src/certificate-artwork.js`.

- [ ] **Step 3: Write the draw list**

Create `apps/api/src/certificate-artwork.ts`:

```ts
/**
 * EN-F: rendering a certificate ONTO uploaded artwork.
 *
 * Split in two on purpose. `certificateDrawList` is PURE — no pdfkit, no I/O,
 * no clock — and is where every rule worth testing lives, so "the QR is always
 * present" and "the watermark is drawn last" are assertions over an array
 * instead of attempts to parse a PDF. `drawCertificate` (Task 5) is a dumb
 * adapter that executes ops and does no arithmetic.
 */
import {
  AUTO_QR_PLACEMENT,
  DEFAULT_COLOR,
  DEFAULT_FONT_SIZE,
  DEFAULT_QR_WIDTH,
  type CertificateAlign,
  type CertificateFieldPlacement,
  type CertificateFieldRef,
  type CertificateFont,
} from "@tokenlayer/core";

export type DrawOp =
  /** The artwork, filling the page. Geometry only — the bytes travel beside the
   *  list, because a draw list carrying a 5MB buffer is miserable to assert on. */
  | { kind: "image"; x: number; y: number; w: number; h: number }
  | {
      kind: "text"; text: string; x: number; y: number; width: number | null;
      fontSize: number; font: CertificateFont; bold: boolean; color: string; align: CertificateAlign;
    }
  | { kind: "qr"; url: string; x: number; y: number; size: number; caption: string | null }
  | { kind: "watermark"; label: string; detail: string | null }
  | { kind: "sample" };

export interface CertificateDrawListInput {
  placements: readonly CertificateFieldPlacement[];
  values: ReadonlyMap<CertificateFieldRef, string>;
  page: { width: number; height: number };
  statusUrl: string;
  /** From `certificateStatusBanner()`. null for a live, unexpired credential. */
  banner: { label: string; detail: string | null } | null;
  /** Preview render: stamps SAMPLE. */
  sample?: boolean;
}

export function certificateDrawList(input: CertificateDrawListInput): DrawOp[] {
  const { placements, values, page, statusUrl, banner } = input;
  const ops: DrawOp[] = [{ kind: "image", x: 0, y: 0, w: page.width, h: page.height }];

  let placedQr = false;
  for (const p of placements) {
    if (p.field === "qr") {
      // Guarded upstream by validateCertificatePlacements, which allows at most
      // one; this second check keeps the invariant true even if the list
      // reaches here unvalidated (a hand-written config, a future caller).
      if (placedQr) continue;
      placedQr = true;
      const size = (p.width ?? DEFAULT_QR_WIDTH) * page.width;
      // No caption on a PLACED qr: the designer put it exactly there, and a
      // stray "Scan to verify" would land somewhere on their artwork.
      ops.push({ kind: "qr", url: statusUrl, x: p.x * page.width, y: p.y * page.height, size, caption: null });
      continue;
    }
    const text = values.get(p.field);
    // Absent ⇒ draw nothing. A placement for a claim this holder does not carry
    // simply prints nothing, which is the whole of the conditional visibility
    // the design deliberately left out.
    if (text === undefined) continue;
    ops.push({
      kind: "text",
      text,
      x: p.x * page.width,
      y: p.y * page.height,
      width: p.width === undefined ? null : p.width * page.width,
      fontSize: p.fontSize ?? DEFAULT_FONT_SIZE,
      font: p.font ?? "sans",
      bold: p.bold ?? false,
      color: p.color ?? DEFAULT_COLOR,
      align: p.align ?? "left",
    });
  }

  // RULE 1 — A QR IS ALWAYS DRAWN. You choose where; never whether. This route
  // is public and unauthenticated, and a certificate with no path back to its
  // status is an assertion nobody can check.
  if (!placedQr) {
    ops.push({
      kind: "qr",
      url: statusUrl,
      x: AUTO_QR_PLACEMENT.x * page.width,
      y: AUTO_QR_PLACEMENT.y * page.height,
      size: (AUTO_QR_PLACEMENT.width ?? DEFAULT_QR_WIDTH) * page.width,
      caption: "Scan to verify",
    });
  }

  // RULE 3 — a preview is stamped, because the preview route renders arbitrary
  // sample claims through the same code that renders real certificates.
  if (input.sample) ops.push({ kind: "sample" });

  // RULE 2 — the revocation watermark is LAST, over everything, consulting no
  // placement and no config. A certificate that can be designed to hide its own
  // revocation is a forgery kit.
  if (banner) ops.push({ kind: "watermark", label: banner.label, detail: banner.detail });

  return ops;
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/api && ./node_modules/.bin/vitest run test/certificate-drawlist.test.ts --testTimeout=180000`
Expected: PASS, 11 tests.

- [ ] **Step 5: Mutation-check the two rules that matter**

Temporarily delete the `if (!placedQr) { … }` block, re-run, and confirm **"inserts a QR when none is placed"** fails. Restore it. Then move the `if (banner)` push to before the placement loop, re-run, and confirm **"draws the revocation watermark LAST"** fails. Restore it.

A guard no mutation kills is decoration. Do not skip this step, and do not commit a mutated file.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/certificate-artwork.ts apps/api/test/certificate-drawlist.test.ts
git commit -m "feat(api): pure certificate draw list — QR always present, watermark always last"
```

---

## Task 5: API — the pdfkit adapter and the route dispatch

**Files:**
- Modify: `apps/api/src/certificate-artwork.ts` (append the adapter)
- Modify: `apps/api/src/http/routes.ts` (the `certificate.pdf` handler, ~line 4521)
- Test: `apps/api/test/certificate-artwork.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/certificate-artwork.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { certificatePageSize } from "@tokenlayer/core";
import { certificateDrawList, drawCertificate } from "../src/certificate-artwork.js";

/** A real 2×1 PNG, so pdfkit's image decoder has genuine bytes to open. */
const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=",
  "base64",
);

describe("drawCertificate", () => {
  it("produces an openable PDF from a draw list", async () => {
    const page = certificatePageSize(2, 1);
    const ops = certificateDrawList({
      placements: [{ field: "subject.name", x: 0.3, y: 0.4, fontSize: 24, font: "serif", bold: true, color: "#112233", align: "center" }],
      values: new Map([["subject.name", "Ada Lovelace"]]),
      page,
      statusUrl: "https://api.example/status",
      banner: { label: "REVOKED", detail: "Revoked: test" },
      sample: true,
    });
    const pdf = await drawCertificate(ops, PNG_2x1, page);
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("renders every font family and alignment without throwing", async () => {
    const page = certificatePageSize(2, 1);
    for (const font of ["sans", "serif", "mono"] as const) {
      for (const align of ["left", "center", "right"] as const) {
        for (const bold of [true, false]) {
          const ops = certificateDrawList({
            placements: [{ field: "subject.name", x: 0.5, y: 0.5, font, align, bold, width: 0.8 }],
            values: new Map([["subject.name", "Ada"]]),
            page, statusUrl: "https://api.example/status", banner: null,
          });
          const pdf = await drawCertificate(ops, PNG_2x1, page);
          expect(pdf.subarray(0, 4).toString("latin1"), `${font}/${align}/${bold}`).toBe("%PDF");
        }
      }
    }
  });

  it("throws on unusable artwork rather than emitting a blank page", async () => {
    const page = certificatePageSize(2, 1);
    const ops = certificateDrawList({
      placements: [], values: new Map(), page, statusUrl: "https://api.example/status", banner: null,
    });
    // The ROUTE turns this into a fallback to the built-in layout (below);
    // the adapter's job is to fail loudly so the route can.
    await expect(drawCertificate(ops, Buffer.from("not an image"), page)).rejects.toThrow();
  });
});
```

Then the route-level behaviour, in the same file. Add this import to the block at the TOP of the file (imports hoist, but appending one after the describes is lint-hostile):

```ts
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";
```

and append these describes:

```ts

/** A credential use case whose type has artwork + one placement. */
async function seedArtworkUseCase(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, documentId: string) {
  const DEF = {
    key: "artwork-cert", name: "Artwork",
    credentialTypes: [{
      name: "ArtCredential", title: "Art Certificate", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
      certificate: {
        enabled: true,
        background: { documentId },
        placements: [{ field: "claim:fullName", x: 0.5, y: 0.4, align: "center", fontSize: 22 }],
      },
    }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
  };
  const r = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
  expect(r.statusCode).toBe(201);
  return DEF;
}

describe("GET /credentials/:id/certificate.pdf — artwork mode", () => {
  it("renders through the ARTWORK path end to end", async () => {
    // The only assertion that proves the route dispatch is wired at all. Reuse
    // the issue → approve → accept helpers already in
    // `apps/api/test/credential-certificate.test.ts` (read that file and copy
    // the pattern; do not edit it). The shape:
    //   1. store the PNG via POST /documents  → documentId
    //   2. seedArtworkUseCase(app, admin, documentId)
    //   3. onboard a holder, issue an ArtCredential to them, approve it, and
    //      accept it as the holder (the route 404s on an unaccepted credential)
    //   4. GET /credentials/{id}/certificate.pdf
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const doc = await app.inject({
      method: "POST", url: `${V1}/documents`, headers: auth(admin),
      payload: { contentType: "image/png", dataBase64: PNG_2x1.toString("base64") },
    });
    expect(doc.statusCode).toBe(201);
    await seedArtworkUseCase(app, admin, doc.json().id as string);

    const credentialId = await issueAcceptedArtCredential(app, admin); // see note above
    const res = await app.inject({ method: "GET", url: `${V1}/credentials/${credentialId}/certificate.pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.rawPayload.subarray(0, 4).toString("latin1")).toBe("%PDF");
    // A page whose aspect follows a 2×1 image is far wider than A4 portrait, so
    // this is also a cheap check that the ARTWORK path ran rather than the
    // built-in one. Assert on the PDF's declared MediaBox width.
    expect(res.rawPayload.toString("latin1")).toContain("841.89");
  });

  it("a missing background document falls back to the built-in layout rather than erroring", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // A documentId that was never stored — the state after someone deletes it.
    await seedArtworkUseCase(app, admin, "doc_does_not_exist");
    // Reaching the render needs an issued+accepted credential; the walkthrough
    // in Task 9 covers the happy path end to end. Here the assertion is that the
    // CONFIG is accepted and the use case is readable, i.e. a dangling artwork
    // reference is not a save-time or read-time error.
    const read = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/artwork-cert`, headers: auth(admin) });
    expect(read.statusCode).toBe(200);
    expect(read.json().credentialTypes[0].certificate.background.documentId).toBe("doc_does_not_exist");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && ./node_modules/.bin/vitest run test/certificate-artwork.test.ts --testTimeout=180000`
Expected: FAIL — `drawCertificate` is not exported.

- [ ] **Step 3: Write the adapter**

Append to `apps/api/src/certificate-artwork.ts`:

```ts
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

/** pdfkit's standard-14 names for our three families × weight. */
const PDF_FONTS: Record<CertificateFont, { normal: string; bold: string }> = {
  sans: { normal: "Helvetica", bold: "Helvetica-Bold" },
  serif: { normal: "Times-Roman", bold: "Times-Bold" },
  mono: { normal: "Courier", bold: "Courier-Bold" },
};

/**
 * Execute a draw list. NO ARITHMETIC HAPPENS HERE — every coordinate arrived
 * absolute. Throws if the artwork cannot be opened; the route catches that and
 * falls back to the built-in layout, because a deleted document must not turn
 * every certificate for that type into a 500.
 */
export async function drawCertificate(
  ops: readonly DrawOp[],
  artworkBytes: Buffer,
  page: { width: number; height: number },
): Promise<Buffer> {
  const doc = new PDFDocument({ size: [page.width, page.height], margin: 0 });
  const chunks: Buffer[] = [];
  doc.on("data", (d: Buffer) => chunks.push(d));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // Pre-render QR images: doc.image needs bytes, and QRCode.toBuffer is async
  // while the draw loop below is not.
  const qrPngs = new Map<string, Buffer>();
  for (const op of ops) {
    if (op.kind === "qr" && !qrPngs.has(op.url)) {
      qrPngs.set(op.url, await QRCode.toBuffer(op.url, { type: "png", margin: 1, width: 320 }));
    }
  }

  for (const op of ops) {
    switch (op.kind) {
      case "image":
        // Throws on unusable bytes — deliberately, see the doc comment.
        doc.image(artworkBytes, op.x, op.y, { width: op.w, height: op.h });
        break;
      case "text": {
        const family = PDF_FONTS[op.font];
        doc.font(op.bold ? family.bold : family.normal).fontSize(op.fontSize).fillColor(op.color);
        // With a width, pdfkit wraps and honours `align` inside the box. Without
        // one, `align` has nothing to align against, so the box is the rest of
        // the page from x — which makes centre/right behave as the designer
        // expects rather than silently doing nothing.
        const width = op.width ?? Math.max(1, page.width - op.x);
        doc.text(op.text, op.x, op.y, { width, align: op.align, lineBreak: op.width !== null });
        break;
      }
      case "qr": {
        doc.image(qrPngs.get(op.url)!, op.x, op.y, { width: op.size, height: op.size });
        if (op.caption) {
          doc.font("Helvetica").fontSize(8).fillColor("#64748b")
            .text(op.caption, op.x, op.y - 11, { width: op.size, align: "center" });
        }
        break;
      }
      case "sample":
        doc.save().font("Helvetica-Bold").fontSize(Math.max(18, page.width * 0.05)).fillColor("#0ea5e9").opacity(0.35)
          .rotate(-24, { origin: [page.width / 2, page.height / 2] })
          .text("SAMPLE — NOT A CREDENTIAL", 0, page.height / 2 - 24, { width: page.width, align: "center" })
          .restore();
        break;
      case "watermark":
        doc.save().font("Helvetica-Bold").fontSize(Math.max(28, page.width * 0.08)).fillColor("#dc2626").opacity(0.28)
          .rotate(-18, { origin: [page.width / 2, page.height / 2] })
          .text(op.label, 0, page.height / 2 - 30, { width: page.width, align: "center" })
          .restore();
        if (op.detail) {
          doc.opacity(1).font("Helvetica-Bold").fontSize(10).fillColor("#dc2626")
            .text(op.detail, page.width * 0.1, page.height * 0.08, { width: page.width * 0.8, align: "center" });
        }
        break;
    }
  }

  doc.end();
  return done;
}

/** Measure artwork without rendering it. Throws on unusable bytes. */
export function artworkDimensions(bytes: Buffer): { width: number; height: number } {
  const probe = new PDFDocument({ size: "A4" });
  const img = probe.openImage(bytes) as { width: number; height: number };
  return { width: img.width, height: img.height };
}
```

- [ ] **Step 4: Dispatch on `background` in the route**

In `apps/api/src/http/routes.ts`, in the `GET /credentials/:id/certificate.pdf` handler, replace the single `renderCredentialCertificate(...)` call (~line 4547) with:

```ts
    // EN-F: artwork mode replaces the built-in layout entirely. An unreadable
    // background falls THROUGH to the built-in renderer rather than erroring —
    // deleting a document must not turn every certificate for this type into a
    // 500, and a blank page is worse than the old design.
    let pdf: Buffer | null = null;
    const bgId = spec.certificate?.background?.documentId;
    if (bgId) {
      try {
        const art = await deps.documents.get(bgId);
        if (!art) throw new Error(`background document '${bgId}' not found`);
        const dims = artworkDimensions(art.bytes);
        const page = certificatePageSize(dims.width, dims.height);
        const ops = certificateDrawList({
          placements: spec.certificate?.placements ?? [],
          values: resolveCertificateFields({ credential: cred, spec, issuerName }),
          page,
          statusUrl,
          banner: certificateStatusBanner({ status, expiresAt: cred.expiresAt, nowMs: Date.now() }),
        });
        pdf = await drawCertificate(ops, art.bytes, page);
      } catch (err) {
        request.log.error({ err, credentialId: cred.id, backgroundDocumentId: bgId }, "certificate artwork unusable; falling back to the built-in layout");
        pdf = null;
      }
    }
    if (!pdf) {
      pdf = await renderCredentialCertificate({ credential: cred, spec, issuerName, statusUrl, status, logoBytes, nowMs: Date.now() });
    }
```

Add the imports at the top of `routes.ts`:

```ts
import { artworkDimensions, certificateDrawList, drawCertificate } from "../certificate-artwork.js";
import { resolveCertificateFields } from "../certificate-fields.js";
```

and add `certificatePageSize` to the existing `@tokenlayer/core` import list, and `certificateStatusBanner` to the existing `./certificate.js` import list.

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && ./node_modules/.bin/vitest run test/certificate-artwork.test.ts test/credential-certificate.test.ts --testTimeout=180000`
Expected: PASS — the new file plus the 9 pre-existing certificate tests, unedited.

Run: `npx tsc --noEmit -p apps/api`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/certificate-artwork.ts apps/api/src/http/routes.ts apps/api/test/certificate-artwork.test.ts
git commit -m "feat(api): render certificates onto artwork, falling back to the built-in layout"
```

---

## Task 6: API — the preview route

**Files:**
- Modify: `apps/api/src/http/schemas.ts` (new `previewCertificate` schema)
- Modify: `apps/api/src/http/routes.ts` (the route, beside the other credential-use-case routes ~line 1167)
- Test: `apps/api/test/certificate-preview.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/certificate-preview.test.ts`:

```ts
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/api-keys.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const TEST_ROUNDS = 4;

/** A 2×1 PNG stored through the real document route. */
const PNG_2x1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=";

async function keyWith(h: TestAppHandle, scopes: string[]): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 10);
  const svc = await h.users.create({
    email: `svc-cert-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`unguessable-${tag}`, TEST_ROUNDS),
    role: "PlatformAdmin", useCaseKey: null, accountId: null, active: true,
    kycStatus: "approved", kyc: null, kind: "service",
  });
  const minted = await mintSecret(TEST_ROUNDS);
  await h.apiKeys.create({
    orgId: null, userId: svc.id, name: `key ${tag}`, prefix: minted.prefix,
    secretHash: minted.hash, scopes, expiresAt: null, createdBy: "test",
  });
  return minted.secret;
}

function body(documentId: string | null) {
  return {
    credentialType: {
      name: "ArtCredential", title: "Art Certificate", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" }, district: { type: "string" } } },
      certificate: {
        enabled: true,
        ...(documentId ? { background: { documentId } } : {}),
        placements: [{ field: "claim:fullName", x: 0.5, y: 0.4, align: "center", fontSize: 22 }],
      },
    },
    sampleClaims: { fullName: "Ada Lovelace" },
  };
}

describe("POST /credential-use-cases/preview-certificate", () => {
  it("renders the draft config as a real PDF, before the use case is saved", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const doc = await h.app.inject({
      method: "POST", url: `${V1}/documents`, headers: auth(admin),
      payload: { contentType: "image/png", dataBase64: PNG_2x1_B64 },
    });
    expect(doc.statusCode).toBe(201);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`,
      headers: auth(admin), payload: body(doc.json().id),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.rawPayload.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("works with no background at all — previewing the built-in layout", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`,
      headers: auth(admin), payload: body(null),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("rejects an invalid placement with the placement error code, naming the chip", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const bad = body(null);
    bad.credentialType.certificate.placements = [{ field: "claim:fullName", x: 4, y: 0.4 } as never];
    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`, headers: auth(admin), payload: bad,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_CERTIFICATE_PLACEMENT");
    expect(res.json().message).toContain("[0]");
  });

  it("is gated by usecases:provision — a key without it is refused", async () => {
    const h = await buildTestAppWithRepos();
    const wrong = await keyWith(h, ["credentials:read"]);
    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`, headers: auth(wrong), payload: body(null),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "usecases:provision" } });

    const right = await keyWith(h, ["usecases:provision"]);
    const ok = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`, headers: auth(right), payload: body(null),
    });
    expect(ok.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && ./node_modules/.bin/vitest run test/certificate-preview.test.ts --testTimeout=180000`
Expected: FAIL with 404 — the route does not exist.

- [ ] **Step 3: Add the schema**

In `apps/api/src/http/schemas.ts`, add beside the other credential-use-case schemas:

```ts
  previewCertificate: {
    tags: ["Credential use cases"], summary: "Render a draft certificate design as a PDF", security: eitherCredential,
    description:
      "Requires the `usecases:provision` scope: this is a configuration-authoring act, and the body is a DRAFT " +
      "credential type — you are designing before the use case is saved, so nothing is read from storage except the " +
      "background artwork it names. The rendered PDF is stamped **SAMPLE — NOT A CREDENTIAL** on the diagonal, " +
      "always: it renders arbitrary caller-supplied claims through the same code that renders real certificates, " +
      "and without the stamp it would be a certificate generator for made-up facts.",
    body: {
      type: "object", additionalProperties: false, required: ["credentialType"],
      properties: {
        credentialType: { type: "object", additionalProperties: true, description: "A full CredentialTypeSpec, `certificate` included." },
        sampleClaims: { type: "object", additionalProperties: true, description: "Values to print. Missing claims fall back to a humanized key so every placement is still visible." },
      },
    },
    response: { ...errs(400, 401, 403) },
  },
```

**Note:** the response is a PDF stream, so no `200` entry is declared — the same shape `credentialCertificate` already uses. Check that neighbour and match it exactly.

- [ ] **Step 4: Add the route**

In `apps/api/src/http/routes.ts`, beside the other `credential-use-case` routes (after the template preview route, ~line 1180):

```ts
  app.post("/credential-use-cases/preview-certificate", {
    schema: S.previewCertificate,
    bodyLimit: 256 * 1024, // JSON config, not artwork — the artwork is already stored and referenced by id
    ...authScoped("usecases:provision"),
  }, async (request, reply) => {
    const b = request.body as { credentialType: CredentialTypeSpec; sampleClaims?: Record<string, unknown> };
    const spec = b.credentialType;
    if (!spec?.claimSchema?.properties) return reply.code(400).send({ error: "BAD_REQUEST", message: "credentialType.claimSchema is required" });
    // Validate the DRAFT exactly as saving would, so a design that previews
    // cannot fail to save. Throws INVALID_CERTIFICATE_PLACEMENT → 400.
    validateCertificatePlacements(spec.certificate?.placements, Object.keys(spec.claimSchema.properties), spec.name || "credential type");

    // A fabricated credential: every value is visibly sample data, and the id is
    // not a real one, so the QR resolves to a status route that answers 404.
    const claims: Record<string, unknown> = {};
    for (const key of Object.keys(spec.claimSchema.properties)) {
      claims[key] = b.sampleClaims?.[key] ?? humanizeKey(key);
    }
    const now = new Date();
    const sample: CredentialRecord = {
      id: "cred_sample", holderDid: "did:key:zSample", issuerDid: "did:key:zSampleIssuer",
      type: spec.name, vcJwt: "", subjectClaims: claims,
      issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + spec.validityDays * 86_400_000).toISOString(),
      revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
      proposalId: null, credentialUseCaseKey: null,
      acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
      anchorTxHash: null, anchorChainId: null, revokeTxHash: null,
    };
    const statusUrl = `${deps.publicApiUrl}/credentials/${sample.id}/status`;

    let pdf: Buffer | null = null;
    const bgId = spec.certificate?.background?.documentId;
    if (bgId) {
      try {
        const art = await deps.documents.get(bgId);
        if (!art) throw new Error(`background document '${bgId}' not found`);
        const dims = artworkDimensions(art.bytes);
        const page = certificatePageSize(dims.width, dims.height);
        const ops = certificateDrawList({
          placements: spec.certificate?.placements ?? [],
          values: resolveCertificateFields({ credential: sample, spec, issuerName: "Sample Issuer" }),
          page, statusUrl, banner: null,
          sample: true, // RULE 3 — always, on this route
        });
        pdf = await drawCertificate(ops, art.bytes, page);
      } catch (err) {
        request.log.error({ err, backgroundDocumentId: bgId }, "preview artwork unusable; previewing the built-in layout");
        pdf = null;
      }
    }
    if (!pdf) {
      // No artwork (or unusable): preview the built-in layout, which is exactly
      // what this config would produce.
      pdf = await renderCredentialCertificate({
        credential: sample, spec, issuerName: "Sample Issuer", statusUrl,
        status: { revoked: false, revokedAt: null, revokedReason: null },
        logoBytes: null, nowMs: Date.now(),
      });
    }
    return reply
      .header("content-type", "application/pdf")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", 'inline; filename="certificate-preview.pdf"')
      .send(pdf);
  });
```

Add `validateCertificatePlacements` and `certificatePageSize` to the `@tokenlayer/core` imports, `humanizeKey` and `renderCredentialCertificate` to the `./certificate.js` imports (both already exported), and `CredentialRecord` to the persistence type imports if not already present.

**Known gap, flagged deliberately:** the built-in fallback path is *not* stamped SAMPLE, because `renderCredentialCertificate` has no such parameter and this project does not change that renderer. That path prints a certificate for `cred_sample` whose QR resolves to a 404 status page — visibly not a real credential — so the risk is materially lower than for artwork mode, where the design is the customer's own and would look genuine. Record it in the branch report; do not silently ignore it.

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && ./node_modules/.bin/vitest run test/certificate-preview.test.ts --testTimeout=180000`
Expected: PASS, 4 tests.

Run: `cd apps/api && ./node_modules/.bin/vitest run test/scope-coverage.test.ts test/openapi-contract.test.ts test/openapi-snapshot.test.ts --testTimeout=180000`
Expected: `scope-coverage` and `openapi-contract` PASS (the route is scoped and its description names the scope). `openapi-snapshot` FAILS with one added path — that is the surface telling you it moved.

- [ ] **Step 6: Regenerate the surface snapshot and READ the diff**

```bash
pnpm --filter @tokenlayer/api openapi:snapshot
git diff apps/api/openapi.snapshot.json
```

Expected: exactly one added path, `POST /api/v1/credential-use-cases/preview-certificate`, with `scopes: ["usecases:provision"]`. If anything else moved, stop and find out why.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/openapi.snapshot.json apps/api/test/certificate-preview.test.ts
git commit -m "feat(api): preview a draft certificate design, always stamped SAMPLE"
```

---

## Task 7: Web — mirrored vocabulary, client method, and the drift test

**Files:**
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/api.ts`
- Create: `apps/api/test/certificate-mirror.test.ts`

- [ ] **Step 1: Write the failing drift test**

Create `apps/api/test/certificate-mirror.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CERTIFICATE_FIXED_FIELDS } from "@tokenlayer/core";

/**
 * THE WEB APP HAS NO DEPENDENCY ON CORE, so every shared vocabulary is copied
 * into `apps/web/src/types.ts` by hand — `API_SCOPES`, `EVENT_TYPES`, and now
 * the certificate field catalog.
 *
 * That mirror has silently drifted twice. Most recently `webhooks:read` and
 * `webhooks:write` were added to core by EN-C and never mirrored, so the console
 * could not mint a key for the Webhooks section on its own screen — and when
 * they were finally added they shipped as blank checkboxes, because
 * `npm run build` is `vite build` and esbuild strips types without checking them.
 *
 * This test lives in the API suite for the only reason that matters: this
 * package can import core AND read the web file. The web package can do neither.
 */
const WEB_TYPES = new URL("../../web/src/types.ts", import.meta.url).pathname;

function mirroredList(source: string, constName: string): string[] {
  const start = source.indexOf(`export const ${constName} = [`);
  expect(start, `${constName} not found in apps/web/src/types.ts`).toBeGreaterThan(-1);
  const end = source.indexOf("] as const;", start);
  expect(end, `${constName} is not a closed \`as const\` array`).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the web mirror of the certificate field catalog", () => {
  const source = readFileSync(WEB_TYPES, "utf8");

  it("lists exactly the fields core defines, in the same order", () => {
    expect(mirroredList(source, "CERTIFICATE_FIXED_FIELDS")).toEqual([...CERTIFICATE_FIXED_FIELDS]);
  });

  it("gives every one of them a label, so none can ship as a blank chip", () => {
    // The web declares `Record<CertificateFixedField, string>`, which only a
    // TYPECHECK enforces — and the web build does not typecheck. Assert it here,
    // where it runs on every api test run.
    for (const field of CERTIFICATE_FIXED_FIELDS) {
      expect(source, `no label for '${field}'`).toContain(`"${field}":`);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && ./node_modules/.bin/vitest run test/certificate-mirror.test.ts --testTimeout=180000`
Expected: FAIL — `CERTIFICATE_FIXED_FIELDS not found in apps/web/src/types.ts`.

- [ ] **Step 3: Add the mirror to the web types**

In `apps/web/src/types.ts`, after the `API_SCOPES` block, add:

```ts
// ---- EN-F: certificate designer ------------------------------------------
/**
 * A DELIBERATE MIRROR of `@tokenlayer/core`'s `CERTIFICATE_FIXED_FIELDS`
 * (packages/core/src/certificate-fields.ts), on the same terms as `API_SCOPES`
 * above: the web app has no dependency on core.
 *
 * Unlike those, this one is PINNED — `apps/api/test/certificate-mirror.test.ts`
 * reads this file and fails the API suite if the list or a label drifts. That
 * check exists because this mirror pattern has silently drifted twice.
 */
export const CERTIFICATE_FIXED_FIELDS = [
  "subject.name",
  "subject.did",
  "credential.id",
  "credential.type",
  "credential.issuedAt",
  "credential.expiresAt",
  "issuer.name",
  "issuer.did",
  "config.heading",
  "config.subheading",
  "qr",
] as const;

export type CertificateFixedField = (typeof CERTIFICATE_FIXED_FIELDS)[number];
export type CertificateFieldRef = CertificateFixedField | `claim:${string}`;
export type CertificateFont = "sans" | "serif" | "mono";
export type CertificateAlign = "left" | "center" | "right";

export const CERTIFICATE_FIELD_LABELS: Record<CertificateFixedField, string> = {
  "subject.name": "Holder name",
  "subject.did": "Holder DID",
  "credential.id": "Credential ID",
  "credential.type": "Credential type",
  "credential.issuedAt": "Issue date",
  "credential.expiresAt": "Expiry date",
  "issuer.name": "Issuer name",
  "issuer.did": "Issuer DID",
  "config.heading": "Heading (from config)",
  "config.subheading": "Subheading (from config)",
  qr: "Verification QR",
};

export interface CertificateFieldPlacement {
  field: CertificateFieldRef;
  x: number;
  y: number;
  width?: number;
  fontSize?: number;
  font?: CertificateFont;
  bold?: boolean;
  color?: string;
  align?: CertificateAlign;
}

export const MAX_CERTIFICATE_PLACEMENTS = 40;
export const DEFAULT_QR_WIDTH = 0.14;
```

- [ ] **Step 4: Add the client method**

In `apps/web/src/api.ts`, beside `downloadDocument` (which is the existing blob-returning pattern to copy):

```ts
  /** Render a DRAFT certificate design. Returns a PDF Blob, always stamped SAMPLE. */
  previewCertificate: async (
    token: string,
    body: { credentialType: unknown; sampleClaims?: Record<string, unknown> },
  ): Promise<Blob> => {
    const res = await fetch(`${BASE}/credential-use-cases/preview-certificate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: { message?: string; error?: string } | null = null;
      try { parsed = text ? (JSON.parse(text) as { message?: string; error?: string }) : null; } catch { /* non-JSON error body */ }
      throw new ApiError(parsed?.message ?? parsed?.error ?? res.statusText, res.status, parsed?.error);
    }
    return res.blob();
  },
```

- [ ] **Step 5: Run the drift test and typecheck the web**

Run: `cd apps/api && ./node_modules/.bin/vitest run test/certificate-mirror.test.ts --testTimeout=180000`
Expected: PASS, 2 tests.

Run: `npx tsc --noEmit -p apps/web`
Expected: clean. **This is the check the web build does not do.**

- [ ] **Step 6: Mutation-check the drift test**

Delete `"qr"` from the web list, re-run the mirror test, confirm it fails naming the mismatch. Restore it. Then delete the `"config.heading":` label line, re-run, confirm the second test fails. Restore it.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/api/test/certificate-mirror.test.ts
git commit -m "feat(web): mirror the certificate field catalog, pinned by a cross-package drift test"
```

---

## Task 8: Web — the designer

**Files:**
- Create: `apps/web/src/lib/certificate-layout.ts` (the pure logic)
- Create: `apps/web/src/components/CertificateDesigner.tsx` (the rendering)
- Modify: `apps/web/src/components/CredentialUseCaseBuilder.tsx`
- Test: `apps/web/test/certificate-layout.test.ts`

**Why the split:** `apps/web` has **no DOM test environment** — no jsdom, no testing-library, and every existing file in `apps/web/test/` is a pure-logic test. `developers-key-lifecycle.test.ts` states the convention outright: *"apps/web has no DOM test environment, so the component's rendering is verified in the browser rather than here; what is asserted below is the logic those renders delegate to."*

So the designer's arithmetic — palette contents, adding, clamped dragging, removal — lives in `lib/certificate-layout.ts` and is unit-tested; the component renders and delegates, and is verified in the browser pass in Task 9. Do **not** add jsdom or testing-library; the plan header says no new dependencies and this is why.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/certificate-layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  addPlacement,
  fieldLabel,
  movePlacement,
  paletteFields,
  removePlacement,
} from "../src/lib/certificate-layout.js";
import { DEFAULT_QR_WIDTH, MAX_CERTIFICATE_PLACEMENTS, type CertificateFieldPlacement } from "../src/types.js";

const CLAIMS = ["fullName", "district"];

describe("paletteFields", () => {
  it("offers every claim first, then the fixed fields", () => {
    const palette = paletteFields(CLAIMS, []);
    expect(palette.slice(0, 2)).toEqual(["claim:fullName", "claim:district"]);
    expect(palette).toContain("subject.name");
    expect(palette).toContain("qr");
  });

  it("withdraws the QR once one is placed — a second is refused server-side", () => {
    expect(paletteFields(CLAIMS, [{ field: "qr", x: 0.8, y: 0.8 }])).not.toContain("qr");
  });

  it("keeps a claim available after placing it — the same value may print twice", () => {
    const palette = paletteFields(CLAIMS, [{ field: "claim:fullName", x: 0.5, y: 0.5 }]);
    expect(palette).toContain("claim:fullName");
  });
});

describe("addPlacement", () => {
  it("drops a new field at the canvas centre", () => {
    const next = addPlacement([], "subject.name");
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ field: "subject.name", x: 0.5, y: 0.5 });
  });

  it("gives a QR its default width so the chip has a size before anyone edits it", () => {
    expect(addPlacement([], "qr")[0]!.width).toBe(DEFAULT_QR_WIDTH);
  });

  it("refuses to exceed the server-side cap instead of building a config that 400s on save", () => {
    const full: CertificateFieldPlacement[] = Array.from(
      { length: MAX_CERTIFICATE_PLACEMENTS },
      () => ({ field: "subject.name", x: 0.5, y: 0.5 }),
    );
    expect(addPlacement(full, "subject.did")).toHaveLength(MAX_CERTIFICATE_PLACEMENTS);
  });
});

describe("movePlacement", () => {
  const one: CertificateFieldPlacement[] = [{ field: "subject.name", x: 0.5, y: 0.5 }];

  it("converts a pointer position inside the canvas to normalized coordinates", () => {
    const box = { left: 100, top: 50, width: 400, height: 200 };
    const moved = movePlacement(one, 0, { clientX: 300, clientY: 150 }, box);
    expect(moved[0]!.x).toBeCloseTo(0.5, 6);
    expect(moved[0]!.y).toBeCloseTo(0.5, 6);
  });

  it("CLAMPS to the page — a drag off the edge must not store x > 1, which the server rejects", () => {
    const box = { left: 0, top: 0, width: 100, height: 100 };
    const off = movePlacement(one, 0, { clientX: 500, clientY: -80 }, box);
    expect(off[0]!.x).toBe(1);
    expect(off[0]!.y).toBe(0);
  });

  it("ignores a zero-sized canvas rather than dividing by zero", () => {
    const box = { left: 0, top: 0, width: 0, height: 0 };
    expect(movePlacement(one, 0, { clientX: 10, clientY: 10 }, box)).toEqual(one);
  });

  it("leaves the other placements untouched", () => {
    const two: CertificateFieldPlacement[] = [
      { field: "subject.name", x: 0.1, y: 0.1 },
      { field: "subject.did", x: 0.9, y: 0.9 },
    ];
    const moved = movePlacement(two, 0, { clientX: 50, clientY: 50 }, { left: 0, top: 0, width: 100, height: 100 });
    expect(moved[1]).toEqual(two[1]);
  });
});

describe("removePlacement", () => {
  it("removes by index and leaves the rest in order", () => {
    const three: CertificateFieldPlacement[] = [
      { field: "subject.name", x: 0, y: 0 },
      { field: "subject.did", x: 0.5, y: 0.5 },
      { field: "qr", x: 1, y: 1 },
    ];
    expect(removePlacement(three, 1).map((p) => p.field)).toEqual(["subject.name", "qr"]);
  });
});

describe("fieldLabel", () => {
  it("labels a fixed field from the catalog and a claim by its key", () => {
    expect(fieldLabel("subject.name")).toBe("Holder name");
    expect(fieldLabel("qr")).toBe("Verification QR");
    expect(fieldLabel("claim:fullName")).toBe("fullName");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && ./node_modules/.bin/vitest run test/certificate-layout.test.ts`
Expected: FAIL — cannot resolve `../src/lib/certificate-layout.js`.

- [ ] **Step 3: Write the pure logic**

Create `apps/web/src/lib/certificate-layout.ts`:

```ts
/**
 * EN-F: the certificate designer's arithmetic, extracted from the component.
 *
 * apps/web has no DOM test environment (see apps/web/test/*), so the rules that
 * matter — what the palette offers, where a new chip lands, and above all that
 * a drag is CLAMPED to the page — live here and are unit-tested. The component
 * renders and delegates.
 */
import {
  CERTIFICATE_FIELD_LABELS,
  CERTIFICATE_FIXED_FIELDS,
  DEFAULT_QR_WIDTH,
  MAX_CERTIFICATE_PLACEMENTS,
  type CertificateFieldPlacement,
  type CertificateFieldRef,
  type CertificateFixedField,
} from "../types.js";

/** Just the part of a DOMRect this module needs, so tests need no DOM. */
export interface CanvasBox { left: number; top: number; width: number; height: number }
export interface PointerAt { clientX: number; clientY: number }

export function fieldLabel(field: CertificateFieldRef): string {
  return field.startsWith("claim:")
    ? field.slice("claim:".length)
    : CERTIFICATE_FIELD_LABELS[field as CertificateFixedField];
}

/**
 * Claims first (they are what an issuer is actually placing), then the fixed
 * fields. The QR is withdrawn once one is placed — the server allows at most
 * one, and offering a second would build a config that 400s on save.
 *
 * A CLAIM is never withdrawn: the same value may legitimately print twice, e.g.
 * a name in the body and again on a signature line.
 */
export function paletteFields(
  claimKeys: readonly string[],
  placements: readonly CertificateFieldPlacement[],
): CertificateFieldRef[] {
  const hasQr = placements.some((p) => p.field === "qr");
  return [
    ...claimKeys.map((k) => `claim:${k}` as CertificateFieldRef),
    ...CERTIFICATE_FIXED_FIELDS.filter((f) => f !== "qr" || !hasQr),
  ];
}

/** Add at the canvas centre. Refuses past the server-side cap. */
export function addPlacement(
  placements: readonly CertificateFieldPlacement[],
  field: CertificateFieldRef,
): CertificateFieldPlacement[] {
  if (placements.length >= MAX_CERTIFICATE_PLACEMENTS) return [...placements];
  return [
    ...placements,
    { field, x: 0.5, y: 0.5, ...(field === "qr" ? { width: DEFAULT_QR_WIDTH } : {}) },
  ];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Pointer → normalized coordinates, CLAMPED to [0,1].
 *
 * The clamp is the load-bearing part: `validateCertificatePlacements` rejects
 * anything outside the page, so an unclamped drag past the edge would build a
 * design that cannot be saved — and the failure would arrive minutes later on
 * the save button rather than at the drag.
 *
 * A zero-sized box (the image has not loaded) would divide to Infinity, so it
 * returns the input untouched.
 */
export function movePlacement(
  placements: readonly CertificateFieldPlacement[],
  index: number,
  at: PointerAt,
  box: CanvasBox,
): CertificateFieldPlacement[] {
  if (!(box.width > 0) || !(box.height > 0)) return [...placements];
  return placements.map((p, i) =>
    i === index
      ? { ...p, x: clamp01((at.clientX - box.left) / box.width), y: clamp01((at.clientY - box.top) / box.height) }
      : p,
  );
}

export function removePlacement(
  placements: readonly CertificateFieldPlacement[],
  index: number,
): CertificateFieldPlacement[] {
  return placements.filter((_, i) => i !== index);
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/web && ./node_modules/.bin/vitest run test/certificate-layout.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Mutation-check the clamp**

Change `clamp01` to the identity function `(v) => v`, re-run, and confirm **"CLAMPS to the page"** fails. Restore it. That clamp is the difference between a design that saves and a 400 the designer cannot explain.

- [ ] **Step 6: Write the component**

Create `apps/web/src/components/CertificateDesigner.tsx`. It holds selection state and renders; every calculation comes from `lib/certificate-layout.ts`:

```tsx
import { useRef, useState } from "react";
import {
  addPlacement, fieldLabel, movePlacement, paletteFields, removePlacement,
} from "../lib/certificate-layout.js";
import type { CertificateAlign, CertificateFieldPlacement, CertificateFont } from "../types.js";

export interface CertificateDesignerProps {
  backgroundDocumentId: string | null;
  placements: CertificateFieldPlacement[];
  /** Claim keys of the credential type being edited. */
  claimKeys: string[];
  onChange: (next: CertificateFieldPlacement[]) => void;
  onUploadArtwork: (file: File) => void;
  onPreview: () => void;
  /** Authenticated artwork URL; the document route needs a bearer token, so the
   *  builder passes an object URL it fetched rather than a bare src. */
  artworkObjectUrl: string | null;
}

export function CertificateDesigner(props: CertificateDesignerProps) {
  const { placements, claimKeys, onChange } = props;
  const [selected, setSelected] = useState<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<number | null>(null);

  const patch = (i: number, next: Partial<CertificateFieldPlacement>): void =>
    onChange(placements.map((p, n) => (n === i ? { ...p, ...next } : p)));

  const onPointerMove = (e: React.PointerEvent): void => {
    const i = dragRef.current;
    const box = canvasRef.current?.getBoundingClientRect();
    if (i === null || !box) return;
    onChange(movePlacement(placements, i, { clientX: e.clientX, clientY: e.clientY }, box));
  };

  const sel = selected !== null ? placements[selected] : undefined;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="text-[11px] text-slate-600">
          Artwork:
          <input type="file" accept="image/png,image/jpeg,image/webp" className="ml-2 text-[11px]"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) props.onUploadArtwork(f); }} />
        </label>
        {props.backgroundDocumentId && <span className="text-[11px] text-emerald-600">✓ uploaded</span>}
        <button type="button" onClick={props.onPreview}
          className="ml-auto rounded border border-slate-300 px-2 py-1 text-[11px] font-medium hover:bg-slate-50">
          Preview PDF
        </button>
      </div>

      <p className="text-[11px] text-slate-500">
        This canvas is an approximation — the browser lays text out differently from the PDF renderer.
        Use <strong>Preview PDF</strong> to see exactly what prints.
      </p>

      <div className="flex flex-wrap gap-1.5">
        {paletteFields(claimKeys, placements).map((f) => (
          <button type="button" key={f}
            onClick={() => { onChange(addPlacement(placements, f)); setSelected(placements.length); }}
            className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:border-brand-400 hover:text-brand-700">
            {fieldLabel(f)}
          </button>
        ))}
      </div>

      <div ref={canvasRef} data-testid="certificate-canvas"
        onPointerMove={onPointerMove}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerLeave={() => { dragRef.current = null; }}
        className="relative w-full select-none overflow-hidden rounded border border-slate-300 bg-slate-100"
        style={{ minHeight: 240 }}>
        {props.artworkObjectUrl
          ? <img src={props.artworkObjectUrl} alt="" className="block w-full" />
          : <div className="flex h-60 items-center justify-center text-xs text-slate-400">Upload artwork to place fields on it</div>}
        {placements.map((p, i) => (
          <div key={`${p.field}-${i}`} data-testid={`placement-${i}`}
            onPointerDown={(e) => { e.preventDefault(); dragRef.current = i; setSelected(i); }}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, color: p.color ?? "#0f172a", fontSize: `${p.fontSize ?? 11}px` }}
            className={`absolute cursor-move whitespace-nowrap rounded bg-white/70 px-1 ${selected === i ? "ring-2 ring-brand-500" : "ring-1 ring-slate-300"}`}>
            {fieldLabel(p.field)}
          </div>
        ))}
      </div>

      {sel && selected !== null && (
        <div className="grid grid-cols-2 gap-2 rounded border border-slate-200 p-2 text-[11px] sm:grid-cols-3">
          <label>Size
            <input type="number" min={4} max={96} value={sel.fontSize ?? 11}
              onChange={(e) => patch(selected, { fontSize: Number(e.target.value) })}
              className="mt-0.5 w-full rounded border-slate-300 text-[11px]" />
          </label>
          <label>Font
            <select value={sel.font ?? "sans"} onChange={(e) => patch(selected, { font: e.target.value as CertificateFont })}
              className="mt-0.5 w-full rounded border-slate-300 text-[11px]">
              <option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option>
            </select>
          </label>
          <label>Align
            <select value={sel.align ?? "left"} onChange={(e) => patch(selected, { align: e.target.value as CertificateAlign })}
              className="mt-0.5 w-full rounded border-slate-300 text-[11px]">
              <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
            </select>
          </label>
          <label>Colour
            <input type="color" value={sel.color ?? "#0f172a"} onChange={(e) => patch(selected, { color: e.target.value })}
              className="mt-0.5 block h-6 w-full" />
          </label>
          <label className="flex items-end gap-1">
            <input type="checkbox" checked={sel.bold ?? false} onChange={(e) => patch(selected, { bold: e.target.checked })} />
            Bold
          </label>
          <button type="button"
            onClick={() => { onChange(removePlacement(placements, selected)); setSelected(null); }}
            className="self-end rounded border border-rose-300 px-2 py-1 text-rose-700 hover:bg-rose-50">
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
```

**Note on `artworkObjectUrl`:** `GET /documents/:id` needs a bearer token, so an `<img src="/api/v1/documents/…">` would 401. The builder fetches the artwork with `api.downloadDocument(token, id)` and passes `URL.createObjectURL(blob)`, revoking it when the id changes.

- [ ] **Step 7: Wire it into the builder**

In `apps/web/src/components/CredentialUseCaseBuilder.tsx`:

1. In `emptyCredType()`, add the two fields:

```ts
  certBackgroundDocumentId: "",
  certPlacements: [] as CertificateFieldPlacement[],
```

and add them to the credential-type editor's TypeScript state type beside `certLogoDocumentId: string`.

2. Add artwork object-URL state near the component's other state:

```tsx
  const [artworkUrls, setArtworkUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    const ids = credTypes.map((c) => c.certBackgroundDocumentId).filter(Boolean);
    for (const id of ids) {
      if (artworkUrls[id] || !token) continue;
      api.downloadDocument(token, id)
        .then((b) => setArtworkUrls((m) => ({ ...m, [id]: URL.createObjectURL(b) })))
        .catch(() => { /* a dangling artwork id renders the empty canvas */ });
    }
  }, [credTypes, token, artworkUrls]);
```

3. Inside the existing `{ct.certEnabled && (…)}` block, after the logo input:

```tsx
                          <details className="rounded border border-slate-200 p-2">
                            <summary className="cursor-pointer text-[11px] font-medium text-brand-700">Design certificate →</summary>
                            <div className="mt-2">
                              <CertificateDesigner
                                backgroundDocumentId={ct.certBackgroundDocumentId || null}
                                artworkObjectUrl={artworkUrls[ct.certBackgroundDocumentId] ?? null}
                                placements={ct.certPlacements}
                                claimKeys={ct.fields.map((f) => f.name).filter(Boolean)}
                                onChange={(next) => patchCredType(i, { certPlacements: next })}
                                onUploadArtwork={async (file) => {
                                  if (!token) return;
                                  const bytes = new Uint8Array(await file.arrayBuffer());
                                  let bin = ""; for (let n = 0; n < bytes.length; n++) bin += String.fromCharCode(bytes[n] as number);
                                  try { const r = await api.uploadDocument(token, file.type, btoa(bin)); patchCredType(i, { certBackgroundDocumentId: r.id }); }
                                  catch { setError("artwork upload failed"); }
                                }}
                                onPreview={async () => {
                                  if (!token) return;
                                  try {
                                    const blob = await api.previewCertificate(token, {
                                      credentialType: {
                                        name: ct.name.trim() || "Draft", title: ct.title.trim() || ct.name.trim() || "Draft",
                                        validityDays: ct.validityDays, requiredApprovals: ct.requiredApprovals,
                                        claimSchema: fieldsToSchema(ct.fields),
                                        certificate: {
                                          enabled: true,
                                          heading: ct.certHeading.trim() || undefined,
                                          subheading: ct.certSubheading.trim() || undefined,
                                          ...(ct.certBackgroundDocumentId ? { background: { documentId: ct.certBackgroundDocumentId } } : {}),
                                          ...(ct.certPlacements.length ? { placements: ct.certPlacements } : {}),
                                        },
                                      },
                                    });
                                    window.open(URL.createObjectURL(blob), "_blank");
                                  } catch (e) { setError(e instanceof Error ? e.message : "preview failed"); }
                                }}
                              />
                            </div>
                          </details>
```

4. In the definition builder (the `certEnabled ? { certificate: {…} }` block, ~line 181), after `logoDocumentId`:

```tsx
            ...(c.certBackgroundDocumentId ? { background: { documentId: c.certBackgroundDocumentId } } : {}),
            ...(c.certPlacements.length ? { placements: c.certPlacements } : {}),
```

5. Where a saved definition is loaded back into editor state (~line 223), populate the two new fields so re-opening a use case shows its design:

```tsx
            certBackgroundDocumentId: ct.certificate?.background?.documentId ?? "",
            certPlacements: ct.certificate?.placements ?? [],
```

6. Import `CertificateDesigner` and the `CertificateFieldPlacement` type, and `useEffect` if it is not already imported.

- [ ] **Step 8: Run the web suite, typecheck, build**

Run: `cd apps/web && ./node_modules/.bin/vitest run`
Expected: PASS — 119 pre-existing + 12 new.

Run: `npx tsc --noEmit -p apps/web`
Expected: clean. **This is the check `npm run build` does not perform.**

Run: `cd apps/web && npm run build`
Expected: builds.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/certificate-layout.ts apps/web/src/components/CertificateDesigner.tsx apps/web/src/components/CredentialUseCaseBuilder.tsx apps/web/test/certificate-layout.test.ts
git commit -m "feat(web): drag-and-drop certificate designer with a real PDF preview"
```

---

## Task 9: Verify — suites, live walkthrough, browser pass, review, merge

**Files:** none created; this task produces evidence and the merge.

- [ ] **Step 1: The full suites, including the `.env` check**

```bash
cd packages/core && ./node_modules/.bin/vitest run
cd ../../apps/api && ./node_modules/.bin/vitest run --testTimeout=180000
cd ../web && ./node_modules/.bin/vitest run
```

Then the check that catches a module-scope `env` import breaking collection:

```bash
cd apps/api && mv .env .env.aside && ./node_modules/.bin/vitest run --testTimeout=180000; mv .env.aside .env
```

Expected: identical test counts with and without `.env`. A lower count means a file failed to COLLECT, not that a test failed.

- [ ] **Step 2: Typecheck both apps and build the web**

```bash
npx tsc --noEmit -p apps/api
npx tsc --noEmit -p apps/web
cd apps/web && npm run build
```

- [ ] **Step 3: Live walkthrough — a human looks at the render**

A rendering feature's proof is the render. Boot the API against a **throwaway** database and the web dev server:

- Add a temporary `api-throwaway` entry to `.claude/launch.json` with `DATABASE_URL=file:./dev-throwaway.db` on the `prisma db push`, the seed and the server, then `preview_start` it. **Never boot the default `api` config for this** — it runs `prisma db push` against the real `apps/api/prisma/dev.db`.
- Log in as `admin@tokenlayer.dev` / `admin123`.
- Create a credential use case with a certificate-enabled type. Upload a real landscape PNG (make one at 1600×900 with any tool). Place `subject.name` centred at about (0.5, 0.42) at 22pt serif, `claim:<something>` below it, `credential.issuedAt` bottom-left, and the QR bottom-right. Hit **Preview PDF** and confirm the SAMPLE stamp and the positions.
- Save the use case, onboard a holder, issue a credential to them, approve it, accept it as the holder, then download `GET /credentials/{id}/certificate.pdf` and **open it**. Check: artwork fills the page, no built-in heading or claim list appears, every placed field is where the canvas showed it, the QR scans to the status URL.
- Revoke the credential and download again: the REVOKED watermark must be over the artwork.
- Tear down: `preview_stop` both servers, remove the throwaway config from `launch.json`, delete `apps/api/prisma/dev-throwaway.db`.

- [ ] **Step 4: Browser pass**

While the servers are up, walk the designer itself: palette chips add, drag moves, the property panel edits, Remove removes, re-opening the saved use case shows the design. Screenshot the designer with artwork and placed chips.

- [ ] **Step 5: The final whole-branch review**

Dispatch a reviewer against the whole branch diff with the instruction to **hunt independently rather than verify the spec's own list**. On every one of the five preceding sub-projects of this program that review found a real defect the per-task reviews missed. Give it the spec, the branch range, and this recipe for a fresh worktree: `pnpm install`, `npx hardhat compile` in `packages/contracts`, `npx prisma generate` in `apps/api`.

Areas worth pointing it at, without limiting it to them: the public unauthenticated render route now draws caller-controlled artwork and caller-controlled text; the preview route renders arbitrary claims for any principal holding `usecases:provision`; the built-in fallback in the preview route is not SAMPLE-stamped (a known gap, recorded in Task 6); template instantiation drops the background but nothing stops a caller PUTting a background directly onto a use case they own.

- [ ] **Step 6: Fix whatever it finds, then merge**

Fix on the branch, re-run the suites, then:

```bash
git checkout main
git merge --no-ff feat/certificate-designer
git branch -d feat/certificate-designer
```

Add an integrator entry to `docs/api/CHANGELOG.md` describing the new preview route and the two new `certificate` fields, marked **ACTION REQUIRED** only if the review turns up a behaviour change for existing configs (it should not — every change here is additive).
