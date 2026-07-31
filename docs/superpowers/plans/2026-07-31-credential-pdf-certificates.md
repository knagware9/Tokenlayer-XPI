# PDF Certificates for Issued Credentials (ID-I) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-credential-type `certificate` config on `CredentialTypeSpec`; when enabled, a credential of that type exposes a rendered PDF certificate at a public capability URL (`GET /credentials/:id/certificate.pdf`), generated on the fly from the credential's data + live revocation status, with a verification QR and a REVOKED/EXPIRED watermark.

**Architecture:** Three layers. **Core** adds the optional `certificate` field + validation (back-compatible; config rides inside the existing `credentialTypes` JSON blob — no persistence/schema migration). **API** adds a pure `pdfkit` renderer module + one public route + a `certificateAvailable` flag on the `mapHeld` projection. **Web** adds a builder sub-section (heading/subheading/claims/logo) per credential type and a Download-certificate control on the credential card.

**Tech Stack:** packages/core (TS, vitest), apps/api (Fastify + Prisma, vitest; new dep `pdfkit` + `@types/pdfkit`, reuses existing `qrcode`), apps/web (React + Vite).

**Spec:** `docs/superpowers/specs/2026-07-31-credential-pdf-certificates-design.md`

**Conventions:** tests from repo root — `pnpm -s --filter @tokenlayer/core test`, `pnpm -s --filter @tokenlayer/api test`, `pnpm -s --filter @tokenlayer/web typecheck`, `pnpm -s --filter @tokenlayer/web build`. Commit after each task. **Never touch `apps/api/prisma/dev.db*`.**

**Key facts already verified (do not re-litigate):**
- `CredentialTypeSpec` lives in `packages/core/src/credential-use-cases.ts:10-21`; `validateCredentialUseCase` at `:74-95`; `credentialUseCaseType` at `:99-104`.
- Credential-use-case create/get schemas use `additionalProperties: true` and `credentialTypes: { type: "array" }` (no item schema) — `apps/api/src/http/schemas.ts:189,567-569`. Configs persist as JSON blobs. So `certificate` round-trips in and out **with no schema or Prisma change**.
- `mapHeld` closure: `apps/api/src/http/routes.ts:2024-2036`. Public status route: `:2313-2337`. Documents serve pattern: `:2884-2898`. `storeUploadedDocument`/`ALLOWED_DOC_TYPES`(includes image/png,jpeg,webp)/`MAX_DOC_BYTES`: `:34,41-52`. `deps.documents.get(id)` returns `DocumentRecord{ contentType, bytes: Buffer, ... }` or null (`apps/api/src/persistence/types.ts:238-250`). `deps.publicApiUrl`, `deps.registry`, `deps.organizations.findByDid`, `deps.credentialUseCases.get`, `credentialUseCaseType` are all in scope in routes.ts.
- Credential `type` is stored comma-joined; `mapHeld` does `c.type.split(",")`. Match a type spec via `def.credentialTypes.find(t => c.type.split(",").includes(t.name))`.
- `qrcode` is already an apps/api dependency (QR-login SVG). Use `qrcode.toBuffer(url, { type: "png", margin: 1, width: 160 })`.
- Web: `BASE` const (`apps/web/src/api.ts:7`, not exported), `api.myCredentials`/`api.orgWallet` (`:200-201`), `api.uploadDocument(token, contentType, dataBase64)` → `{id,url,sha256,size}` (`:136`), `api.credentialTemplates` (used by builder `:94`). `HeldCredential` (`apps/web/src/types.ts:341`), web `CredentialTypeSpec` (`:438`), `CredentialUseCase` (`:443`). Builder: `CredTypeDraft` (`apps/web/src/components/CredentialUseCaseBuilder.tsx:14-21`), `emptyCredType` (`:51`), `patchCredType` (`:122`), `buildDefinition` (`:144-164`), `buildTemplate` (`:174+`).

---

## Task I1: Core — `certificate` config on `CredentialTypeSpec` + validation

**Files:**
- Modify: `packages/core/src/credential-use-cases.ts`
- Test: `packages/core/test/credential-use-cases.test.ts` (the existing file for this module — confirm the exact name by grep `validateCredentialUseCase` in `packages/core/test`; if none, create `packages/core/test/credential-use-cases.test.ts`)

- [ ] **Step 1: Write the failing tests**

Add to the credential-use-cases test file. A helper to build a minimal valid def, then certificate cases:

```ts
import { describe, it, expect } from "vitest";
import { validateCredentialUseCase, type CredentialUseCaseDefinition } from "../src/credential-use-cases.js";

const baseDef = (certificate?: unknown): CredentialUseCaseDefinition => ({
  key: "domicile", name: "Domicile", credentialTypes: [{
    name: "DomicileCredential", title: "Domicile Certificate", validityDays: 365, requiredApprovals: 1,
    claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" }, district: { type: "string" } } },
    ...(certificate !== undefined ? { certificate } : {}),
  }],
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
} as CredentialUseCaseDefinition);
const ctx = { orgExists: () => true };

describe("certificate config validation", () => {
  it("accepts a valid certificate config", () => {
    expect(() => validateCredentialUseCase(baseDef({ enabled: true, heading: "Certificate of Domicile", subheading: "Govt of X", claimOrder: ["fullName", "district"] }), ctx)).not.toThrow();
  });
  it("accepts a type with no certificate (back-compat)", () => {
    expect(() => validateCredentialUseCase(baseDef(), ctx)).not.toThrow();
  });
  it("rejects a non-boolean enabled", () => {
    expect(() => validateCredentialUseCase(baseDef({ enabled: "yes" }), ctx)).toThrow(/enabled/);
  });
  it("rejects a non-string heading", () => {
    expect(() => validateCredentialUseCase(baseDef({ enabled: true, heading: 5 }), ctx)).toThrow(/heading/);
  });
  it("rejects a claimOrder entry not in the claim schema", () => {
    expect(() => validateCredentialUseCase(baseDef({ enabled: true, claimOrder: ["fullName", "ghost"] }), ctx)).toThrow(/ghost|claimOrder/);
  });
});
```

- [ ] **Step 2: Run → verify FAIL**

Run: `pnpm -s --filter @tokenlayer/core test`
Expected: the new cases fail (the accept-config case fails only if TS errors on the unknown field — so do Step 3's type change first if the test file won't compile; otherwise expect the reject cases to fail because no validation exists yet).

- [ ] **Step 3: Add the type** (`credential-use-cases.ts`, after the `CredentialTypeSpec` interface, ~line 21)

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
}
```

Then add to the `CredentialTypeSpec` interface (after `requiredApprovals: number;`):

```ts
  /** Optional PDF-certificate configuration for this credential type. */
  certificate?: CertificateConfig;
```

- [ ] **Step 4: Add validation** (`validateCredentialUseCase`, inside the `for (const ct of def.credentialTypes)` loop, after the `validateMetadataSchema(...)` call at ~line 90)

```ts
    if (ct.certificate !== undefined) {
      const cert = ct.certificate;
      if (typeof cert.enabled !== "boolean") fail(`credential type '${ct.name}' certificate.enabled must be a boolean`);
      for (const [f, v] of [["heading", cert.heading], ["subheading", cert.subheading], ["logoDocumentId", cert.logoDocumentId]] as const)
        if (v !== undefined && typeof v !== "string") fail(`credential type '${ct.name}' certificate.${f} must be a string`);
      if (cert.claimOrder !== undefined) {
        if (!Array.isArray(cert.claimOrder) || cert.claimOrder.some((k) => typeof k !== "string"))
          fail(`credential type '${ct.name}' certificate.claimOrder must be an array of strings`);
        for (const k of cert.claimOrder)
          if (!(k in ct.claimSchema.properties)) fail(`credential type '${ct.name}' certificate.claimOrder references unknown claim '${k}'`);
      }
    }
```

- [ ] **Step 5: Run → verify PASS + typecheck**

Run: `pnpm -s --filter @tokenlayer/core test` (green) and `pnpm -s --filter @tokenlayer/core typecheck` (clean).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/credential-use-cases.ts packages/core/test/credential-use-cases.test.ts
git commit -m "feat(core): optional per-type certificate config on CredentialTypeSpec + validation"
```

---

## Task I2: API — pdfkit renderer + public certificate route + `certificateAvailable`

**Files:**
- Create: `apps/api/src/certificate.ts` (pure renderer + status-banner helper)
- Modify: `apps/api/package.json` (add `pdfkit` dep + `@types/pdfkit` devDep)
- Modify: `apps/api/src/http/routes.ts` (new public route + `mapHeld` flag)
- Modify: `apps/api/src/http/schemas.ts` (a minimal schema for the new route)
- Test: `apps/api/test/credential-certificate.test.ts` (new)

- [ ] **Step 1: Add the dependency**

Run from repo root:
```bash
pnpm --filter @tokenlayer/api add pdfkit && pnpm --filter @tokenlayer/api add -D @types/pdfkit
```
Expected: `pdfkit` in `dependencies`, `@types/pdfkit` in `devDependencies`. (pdfkit bundles its standard Helvetica fonts — no font files needed.)

- [ ] **Step 2: Write the renderer module** (`apps/api/src/certificate.ts`)

Pure: bytes/data in → Buffer out. Keep the status logic in a separately-exported helper so it is unit-testable without parsing PDF bytes.

```ts
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import type { CredentialRecord } from "./persistence/types.js";
import type { CredentialTypeSpec } from "@tokenlayer/core";

export interface CertificateStatus { revoked: boolean; revokedAt: string | null; revokedReason: string | null; }

/** The prominent banner to stamp, or null when the credential is live & unexpired. */
export function certificateStatusBanner(
  input: { status: CertificateStatus; expiresAt: string | null; nowMs: number },
): { label: string; detail: string | null } | null {
  if (input.status.revoked)
    return { label: "REVOKED", detail: input.status.revokedReason ? `Revoked: ${input.status.revokedReason}` : "This credential has been revoked." };
  if (input.expiresAt && Date.parse(input.expiresAt) < input.nowMs)
    return { label: "EXPIRED", detail: `Expired on ${new Date(input.expiresAt).toLocaleDateString()}` };
  return null;
}

/** Turn a claim key into a human label (camelCase / snake / kebab → Title Case). */
export function humanizeKey(k: string): string {
  return k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface RenderCertificateInput {
  credential: CredentialRecord;
  spec: CredentialTypeSpec;
  issuerName: string | null;
  statusUrl: string;
  status: CertificateStatus;
  logoBytes: Buffer | null;
  nowMs: number;
}

export async function renderCredentialCertificate(input: RenderCertificateInput): Promise<Buffer> {
  const { credential: c, spec, issuerName, statusUrl, logoBytes } = input;
  const cert = spec.certificate;
  const heading = cert?.heading?.trim() || spec.title;
  const claims = c.subjectClaims ?? {};
  const orderedKeys = (cert?.claimOrder && cert.claimOrder.length ? cert.claimOrder : Object.keys(spec.claimSchema.properties))
    .filter((k) => k !== "id" && k in claims);
  const descOf = (k: string): string => {
    const p = spec.claimSchema.properties[k] as { description?: string } | undefined;
    return p?.description?.trim() || humanizeKey(k);
  };
  const banner = certificateStatusBanner({ status: input.status, expiresAt: c.expiresAt, nowMs: input.nowMs });
  const qrPng = await QRCode.toBuffer(statusUrl, { type: "png", margin: 1, width: 160 });

  const doc = new PDFDocument({ size: "A4", margin: 56 });
  const chunks: Buffer[] = [];
  doc.on("data", (d: Buffer) => chunks.push(d));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // Logo (never fail on a bad image)
  if (logoBytes) { try { doc.image(logoBytes, doc.page.width / 2 - 40, 48, { fit: [80, 80], align: "center" }); doc.moveDown(4); } catch { /* ignore */ } }
  doc.moveDown(logoBytes ? 3 : 1);
  doc.fontSize(22).font("Helvetica-Bold").text(heading, { align: "center" });
  if (cert?.subheading?.trim()) doc.moveDown(0.2).fontSize(12).font("Helvetica").text(cert.subheading.trim(), { align: "center" });
  doc.moveDown(1).fontSize(11).font("Helvetica").fillColor("#334155").text("This certifies that", { align: "center" });
  const subjectName = (typeof claims.fullName === "string" && claims.fullName) || (typeof claims.legalName === "string" && claims.legalName) || (typeof claims.holderName === "string" && claims.holderName) || c.holderDid;
  doc.moveDown(0.3).fontSize(16).font("Helvetica-Bold").fillColor("#0f172a").text(String(subjectName), { align: "center" });
  doc.moveDown(1);

  // Claims table
  doc.fillColor("#0f172a");
  for (const k of orderedKeys) {
    doc.fontSize(10).font("Helvetica-Bold").text(`${descOf(k)}: `, { continued: true }).font("Helvetica").text(String(claims[k]));
  }
  doc.moveDown(1);
  doc.fontSize(9).fillColor("#475569").font("Helvetica")
    .text(`Issuer: ${issuerName ?? c.issuerDid}`)
    .text(`Issuer DID: ${c.issuerDid}`)
    .text(`Credential type: ${spec.title}`)
    .text(`Issued: ${new Date(c.issuedAt).toLocaleDateString()}`)
    .text(`Expires: ${c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "No expiry"}`)
    .text(`Credential ID: ${c.id}`);

  // QR + verification URL
  doc.image(qrPng, doc.page.width - 56 - 96, doc.page.height - 56 - 96, { width: 96 });
  doc.fontSize(8).fillColor("#64748b").text("Scan to verify", doc.page.width - 56 - 96, doc.page.height - 56 - 96 - 12, { width: 96, align: "center" });
  doc.fontSize(7).fillColor("#94a3b8").text(statusUrl, 56, doc.page.height - 56 - 12, { width: doc.page.width - 112 });

  // Status banner (drawn last, on top)
  if (banner) {
    doc.save().fontSize(48).font("Helvetica-Bold").fillColor("#dc2626").opacity(0.28)
      .rotate(-18, { origin: [doc.page.width / 2, doc.page.height / 2] })
      .text(banner.label, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: "center" }).restore();
    if (banner.detail) doc.opacity(1).fillColor("#dc2626").fontSize(10).font("Helvetica-Bold").text(banner.detail, 56, 120, { width: doc.page.width - 112, align: "center" });
  }

  doc.end();
  return done;
}
```

- [ ] **Step 3: Write the failing API test** (`apps/api/test/credential-certificate.test.ts`)

Model it on `apps/api/test/credential-usecase.test.ts` (the existing credential-use-case issue→approve suite) — reuse its imports (`buildTestApp` from `apps/api/test/helpers.ts`), its login/onboarding calls, and its create-use-case + issue + approve flow via `app.inject`. Copy that harness rather than inventing one. The test must:
1. Create a credential use case whose type has `certificate: { enabled: true, heading: "Certificate of Domicile", claimOrder: ["fullName","district"] }`.
2. Onboard a holder with a DID; issue a credential of that type; approve it → obtain the credential id.
3. `GET /credentials/:id/certificate.pdf` → `200`, header `content-type` startsWith `application/pdf`, body (Buffer) starts with the ASCII bytes `%PDF-` and `.length > 800`.
4. A credential whose type has **no** certificate config → `GET …/certificate.pdf` → `404`.
5. An unknown id → `404`.
6. `GET /me/credentials` (or `/orgs/:id/wallet`) for the holder → the cert-enabled credential has `certificateAvailable === true`; a non-cert one has `certificateAvailable === false`.
7. After revoking the credential, `GET …/certificate.pdf` still returns `200` (watermark path — bytes remain a valid PDF).

Assert PDF bytes via: `const buf = res.rawPayload ?? Buffer.from(res.payload, "binary"); expect(buf.subarray(0,5).toString("latin1")).toBe("%PDF-")`. (Use `res.rawPayload` from `app.inject`; if the helper returns a Response, read the ArrayBuffer.) Do NOT try to parse PDF text — assert magic bytes + size only.

Also add renderer unit tests (no app needed) for the pure helpers:
```ts
import { certificateStatusBanner, humanizeKey } from "../src/certificate.js";
expect(humanizeKey("fullName")).toBe("Full Name");
expect(certificateStatusBanner({ status: { revoked: true, revokedAt: null, revokedReason: "fraud" }, expiresAt: null, nowMs: 0 })?.label).toBe("REVOKED");
expect(certificateStatusBanner({ status: { revoked: false, revokedAt: null, revokedReason: null }, expiresAt: "2000-01-01T00:00:00Z", nowMs: Date.parse("2020-01-01") })?.label).toBe("EXPIRED");
expect(certificateStatusBanner({ status: { revoked: false, revokedAt: null, revokedReason: null }, expiresAt: null, nowMs: 0 })).toBeNull();
```

Run: `pnpm -s --filter @tokenlayer/api test` → FAIL (route 404s / not found).

- [ ] **Step 4: Add `certificateAvailable` to `mapHeld`** (`apps/api/src/http/routes.ts:2024-2036`)

Add a memoised use-case lookup beside the `names` map, and compute the flag. Replace the `mapHeld` body:

```ts
  async function mapHeld(rows: CredentialRecord[]) {
    const names = new Map<string, Promise<string | null>>();
    const nameOf = (did: string): Promise<string | null> => {
      if (!names.has(did)) names.set(did, deps.organizations.findByDid(did).then((o) => o?.name ?? null));
      return names.get(did)!;
    };
    const ucs = new Map<string, Promise<CredentialUseCaseDefinition | null>>();
    const ucOf = (key: string): Promise<CredentialUseCaseDefinition | null> => {
      if (!ucs.has(key)) ucs.set(key, deps.credentialUseCases.get(key).catch(() => null));
      return ucs.get(key)!;
    };
    const certOk = async (c: CredentialRecord): Promise<boolean> => {
      if (!c.credentialUseCaseKey) return false;
      const def = await ucOf(c.credentialUseCaseKey);
      if (!def) return false;
      const typeNames = c.type.split(",");
      return def.credentialTypes.some((t) => typeNames.includes(t.name) && t.certificate?.enabled === true);
    };
    return Promise.all(rows.map(async (c) => ({
      id: c.id, type: c.type.split(","), credentialUseCaseKey: c.credentialUseCaseKey,
      issuerDid: c.issuerDid, issuerName: await nameOf(c.issuerDid), holderDid: c.holderDid,
      claims: c.subjectClaims, issuedAt: c.issuedAt, expiresAt: c.expiresAt,
      revoked: c.revoked, revokedAt: c.revokedAt, revokedReason: c.revokedReason, vcJwt: c.vcJwt,
      certificateAvailable: await certOk(c),
    })));
  }
```

Note: `CredentialUseCaseDefinition` is already imported in routes.ts (`type CredentialUseCaseDefinition`). `deps.credentialUseCases.get` may throw on missing (repos' `.get` throws per ID-B notes) → the `.catch(() => null)` guard handles it.

- [ ] **Step 5: Add the public certificate route** (`apps/api/src/http/routes.ts`, immediately AFTER the `GET /credentials/:id/status` route at ~line 2337)

```ts
  // PUBLIC capability URL (the unguessable credential id is the token, same
  // posture as /status). Renders a human-readable PDF certificate on the fly
  // when the credential's type has certificate.enabled. Reflects live status.
  app.get("/credentials/:id/certificate.pdf", { schema: S.credentialCertificate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const cred = await deps.credentials.get(id);
    if (!cred) return notFound(reply, "credential not found");
    if (!cred.credentialUseCaseKey) return notFound(reply, "no certificate for this credential");
    const def = await deps.credentialUseCases.get(cred.credentialUseCaseKey).catch(() => null);
    const typeNames = cred.type.split(",");
    const spec = def?.credentialTypes.find((t) => typeNames.includes(t.name) && t.certificate?.enabled === true);
    if (!def || !spec) return notFound(reply, "no certificate for this credential");

    const issuerName = (await deps.organizations.findByDid(cred.issuerDid))?.name ?? null;
    const statusUrl = `${deps.publicApiUrl}/credentials/${cred.id}/status`;
    // Live status: reuse the same three-way resolution as /status (DB, else chain).
    let status = { revoked: cred.revoked, revokedAt: cred.revokedAt, revokedReason: cred.revokedReason };
    if (deps.registry) {
      try {
        const onChain = await deps.registry.anchor.credentialStatusOf(deps.registry.vcRegistry, cred.id);
        if (onChain.exists) status = { revoked: onChain.revoked, revokedAt: onChain.revokedAt ? new Date(onChain.revokedAt * 1000).toISOString() : null, revokedReason: cred.revokedReason };
      } catch (err) { request.log.error({ err }, "cert on-chain status read failed"); }
    }
    let logoBytes: Buffer | null = null;
    if (spec.certificate?.logoDocumentId) { try { logoBytes = (await deps.documents.get(spec.certificate.logoDocumentId))?.bytes ?? null; } catch { logoBytes = null; } }

    const pdf = await renderCredentialCertificate({ credential: cred, spec, issuerName, statusUrl, status, logoBytes, nowMs: Date.now() });
    const fname = `${(spec.name || "credential").replace(/[^a-zA-Z0-9._-]/g, "_")}-${cred.id}.pdf`;
    return reply
      .header("content-type", "application/pdf")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename="${fname}"`)
      .send(pdf);
  });
```

Add the import at the top of routes.ts (near the other local imports):
```ts
import { renderCredentialCertificate } from "../certificate.js";
```

- [ ] **Step 6: Add the route schema** (`apps/api/src/http/schemas.ts`, beside `credentialStatus`)

```ts
  credentialCertificate: {
    tags: ["Credentials"], summary: "Public: download a credential's PDF certificate (when its type enables one)",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "string", format: "binary" }, ...errs(404) },
  },
```
(Match the `errs(...)` helper + `tags`/`summary` style used by the neighbouring `credentialStatus` / `getDocument` schema entries. A `format: "binary"` string response tells Swagger it's a file; Fastify still sends the Buffer as-is.)

- [ ] **Step 7: Run → verify PASS**

Run: `pnpm -s --filter @tokenlayer/api test` (all green — new cert tests + every existing test untouched) and `pnpm -s --filter @tokenlayer/api typecheck` (clean). If an existing snapshot of `mapHeld`'s shape exists in another test, update it to include `certificateAvailable`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/certificate.ts apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/package.json apps/api/test/credential-certificate.test.ts pnpm-lock.yaml
git commit -m "feat(api): on-the-fly PDF certificate route + certificateAvailable projection"
```

---

## Task I3: Web — builder certificate sub-section + card download control

**Files:**
- Modify: `apps/web/src/types.ts` (`HeldCredential`, web `CredentialTypeSpec`)
- Modify: `apps/web/src/api.ts` (a `certificateUrl` helper)
- Modify: `apps/web/src/components/CredentialCard.tsx` (Download-certificate control)
- Modify: `apps/web/src/components/CredentialUseCaseBuilder.tsx` (per-type certificate sub-section + logo upload)

- [ ] **Step 1: Types** (`apps/web/src/types.ts`)

Add to `HeldCredential` (`:341`):
```ts
  certificateAvailable?: boolean;
```
Add a certificate shape and extend web `CredentialTypeSpec` (`:438`):
```ts
export interface CertificateConfig { enabled: boolean; heading?: string; subheading?: string; claimOrder?: string[]; logoDocumentId?: string; }
```
and add `certificate?: CertificateConfig;` to the `CredentialTypeSpec` interface fields.

- [ ] **Step 2: api helper** (`apps/web/src/api.ts`, inside the `api` object)

```ts
  certificateUrl: (id: string): string => `${BASE}/credentials/${encodeURIComponent(id)}/certificate.pdf`,
```

- [ ] **Step 3: Card download control** (`apps/web/src/components/CredentialCard.tsx`)

Import `api` (`import { api } from "../api.js";` if not already imported). In the button row (the `<div className="flex gap-2">` holding Copy/Download at the bottom of the details block), add — only when available:
```tsx
            {c.certificateAvailable && (
              <a className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700 hover:border-brand-400"
                href={api.certificateUrl(c.id)} target="_blank" rel="noopener noreferrer">Download certificate</a>
            )}
```

- [ ] **Step 4: Builder — certificate sub-section per credential type** (`apps/web/src/components/CredentialUseCaseBuilder.tsx`)

4a. Extend `CredTypeDraft` (`:14-21`) with a certificate draft:
```ts
  certEnabled: boolean;
  certHeading: string;
  certSubheading: string;
  certClaimKeys: string[];      // which claim keys to show (empty ⇒ all)
  certLogoDocumentId: string;   // "" when none
```
Extend `emptyCredType()` (`:51`):
```ts
const emptyCredType = (): CredTypeDraft => ({ name: "", title: "", validityDays: 365, requiredApprovals: 1, fields: [], templateKey: "", certEnabled: false, certHeading: "", certSubheading: "", certClaimKeys: [], certLogoDocumentId: "" });
```
(`applyTemplate` at `:131` spreads a patch — leave the cert fields untouched there; they retain their defaults.)

4b. In `buildDefinition()` (`:157-159`), emit the certificate when enabled. Replace the `.map((c) => ({ ... claimSchema: fieldsToSchema(c.fields) }))` with one that appends `certificate`:
```ts
        .map((c) => ({
          name: c.name.trim(), title: c.title.trim() || c.name.trim(),
          validityDays: c.validityDays, requiredApprovals: c.requiredApprovals,
          claimSchema: fieldsToSchema(c.fields),
          ...(c.certEnabled ? { certificate: {
            enabled: true,
            heading: c.certHeading.trim() || undefined,
            subheading: c.certSubheading.trim() || undefined,
            claimOrder: c.certClaimKeys.length ? c.certClaimKeys : undefined,
            logoDocumentId: c.certLogoDocumentId || undefined,
          } } : {}),
        }))
```
**Leave `buildTemplate()` unchanged** — carrying certificate config through the saved-template catalog is explicitly out of scope (spec §Scope, deferred). The `TemplateCredentialType` body shape (`properties`, not `claimSchema`) does not include `certificate`; do not add it here. Only `buildDefinition` (the direct create/PATCH path) emits `certificate`.

4c. In the Step-2 credential-type editor UI (the JSX block that renders each `credTypes[i]` — find the `SchemaFieldEditor` usage and the validity/approvals inputs), add a certificate sub-panel below the fields editor for that type. The claim keys come from the type's current field names (`c.fields.map(f => f.name).filter(Boolean)`):
```tsx
              <div className="mt-3 rounded-lg border border-slate-200 p-3 space-y-2">
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input type="checkbox" checked={c.certEnabled} onChange={(e) => patchCredType(i, { certEnabled: e.target.checked })} />
                  Issue PDF certificate for this credential type
                </label>
                {c.certEnabled && (
                  <div className="space-y-2 pl-1">
                    <input className="w-full rounded border-slate-300 text-xs" placeholder="Certificate heading (e.g. Certificate of Domicile)"
                      value={c.certHeading} onChange={(e) => patchCredType(i, { certHeading: e.target.value })} />
                    <input className="w-full rounded border-slate-300 text-xs" placeholder="Subheading (e.g. issuing authority)"
                      value={c.certSubheading} onChange={(e) => patchCredType(i, { certSubheading: e.target.value })} />
                    <div className="text-[11px] text-slate-500">Claims to show (none selected ⇒ all):</div>
                    <div className="flex flex-wrap gap-1.5">
                      {c.fields.map((f) => f.name).filter(Boolean).map((k) => (
                        <button type="button" key={k}
                          className={`rounded-full border px-2 py-0.5 text-[11px] ${c.certClaimKeys.includes(k) ? "border-brand-400 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-500"}`}
                          onClick={() => patchCredType(i, { certClaimKeys: toggle(c.certClaimKeys, k) })}>{k}</button>
                      ))}
                    </div>
                    <label className="block text-[11px] text-slate-500">
                      Logo / seal (optional):
                      <input type="file" accept="image/png,image/jpeg,image/webp" className="mt-1 block text-[11px]"
                        onChange={async (e) => {
                          const file = e.target.files?.[0]; if (!file || !token) return;
                          const b64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
                          try { const r = await api.uploadDocument(token, file.type, b64); patchCredType(i, { certLogoDocumentId: r.id }); }
                          catch { setError("logo upload failed"); }
                        }} />
                      {c.certLogoDocumentId && <span className="ml-2 text-emerald-600">✓ uploaded</span>}
                    </label>
                  </div>
                )}
              </div>
```
(`toggle` already exists at `:142`; `patchCredType` at `:122`; `api` and `token` are already in scope. For large images the `btoa(String.fromCharCode(...))` spread can overflow the call stack — logos are small, but if the reviewer prefers, chunk the conversion or use a FileReader `readAsDataURL` and strip the `data:...;base64,` prefix. Keep it simple; note the 5 MB server cap.)

- [ ] **Step 5: Run → verify**

Run: `pnpm -s --filter @tokenlayer/web typecheck` (clean) and `pnpm -s --filter @tokenlayer/web build` (succeeds).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/components/CredentialCard.tsx apps/web/src/components/CredentialUseCaseBuilder.tsx
git commit -m "feat(web): certificate config in credential-use-case builder + download control on card"
```

---

## Task I4: Verify — suites + live walkthrough + review + finish

- [ ] **Step 1: Full suites**

Run and confirm all green:
```bash
pnpm -s typecheck
pnpm -s --filter @tokenlayer/core test
pnpm -s --filter @tokenlayer/api test
pnpm -s --filter @tokenlayer/web build
```

- [ ] **Step 2: Live walkthrough** (fast-boot recipe — throwaway DB, `CHAIN_STRICT=0`, no chain env, `LOGIN_RATE_LIMIT_MAX=1000`; boot with `exec ... tsx src/server.ts`, no trailing inner `&`; **never touch `dev.db`**)

Either drive it via the browser preview OR a short HTTP script (mirror `scripts/full-platform-e2e.mjs`):
1. As PlatformAdmin, author a credential use case with a Domicile type; enable **Issue PDF certificate**, set heading "Certificate of Domicile", pick 2–3 claims, upload a small PNG logo.
2. Onboard a holder (with a DID); issue a Domicile credential to them; approve it.
3. `GET /credentials/:id/certificate.pdf` (holder token AND no token — same public URL) → save both to the scratchpad; confirm each is a valid PDF (`%PDF-` header, opens, shows heading + claims table + QR + issuer). Confirm `GET /me/credentials` shows `certificateAvailable: true` and the wallet renders a **Download certificate** button.
4. Revoke the credential; re-fetch the certificate → still 200, now carries the **REVOKED** watermark.
5. Screenshots of the rendered PDF (and the builder toggle + card button if driven via browser).

- [ ] **Step 3: Final review**

Whole-implementation review (spec compliance + quality). Focus: certificate config is truly optional/back-compatible (existing use cases untouched, every existing test green); the route 404s cleanly for no-config/unknown types; the public route leaks nothing beyond what the holder's certificate intentionally contains; revocation/expiry watermark is honoured from live status; a dangling `logoDocumentId` never fails the render; no `dev.db` writes; `certificateAvailable` correct in both wallet routes. Fix findings via the implementer.

- [ ] **Step 4: Finish**

Use `superpowers:finishing-a-development-branch` to merge `feat/credential-pdf-certificates` → main.

---

## Notes / risks

- **No persistence or schema migration**: `certificate` rides inside the `credentialTypes` JSON blob; create/get schemas are `additionalProperties: true`. Confirm at runtime that a POSTed `certificate` survives a round-trip (`GET /credential-use-cases/:key` returns it) — if any intermediate normalizer (`normalizeUseCaseDefinition` is tokenization-only; credential use cases are stored as-is) strips it, that is a bug to fix in the credential-use-case create/patch handler, not the schema.
- **Logo upload RBAC**: `POST /documents` is gated by `rbac.can(role, "issue")`. PlatformAdmin qualifies; confirm an OrgAdmin authoring their own use case also has `issue` (grep the rbac matrix). If not, the logo upload 403s for OrgAdmins — surface a clear inline error (the try/catch already sets one) and note it; do not widen RBAC in this task.
- **PDF assertions**: never parse PDF text in tests — assert `%PDF-` magic bytes + non-trivial size for the route, and unit-test the pure `certificateStatusBanner`/`humanizeKey` helpers for the status/label logic.
- **`deps.credentialUseCases.get` throwing on missing**: both new call sites (`mapHeld`, the route) wrap it in `.catch(() => null)` and treat null as "no certificate" (404 / flag false).
- **PII on a public URL** is an accepted, user-chosen trade-off (spec §Error handling). The mitigation is the unguessable `randomUUID` id, identical to the existing `/status` exposure. Do not add auth to the route (it would break the "anyone with the link" audience).
- **pdfkit fonts**: pdfkit bundles Helvetica/Helvetica-Bold — no external font files. Do not switch to a custom font (would need a bundled `.ttf`).
