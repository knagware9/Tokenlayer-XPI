# PDF Certificates for Issued Credentials (ID-I) — Design

**Goal:** Let an Identity use case issue a **rendered, human-readable PDF certificate** for the credentials it issues (e.g. a Domicile Certificate), configurable per credential type. The certificate is distinct from the machine-readable VC-JWT the wallet already exports: it is a printable document a holder can keep, an issuer can re-send, and a verifier can pull from a link — with a QR code back to the live on-chain verification page.

**Program context:** The Identity domain is complete through ID-H. Credentials are issued via a maker-checker flow (`POST /credential-use-cases/:key/credentials` → `issue-usecase-credential` proposal → `issueCredentialFor`), stored as `CredentialRecord` (holderDid, issuerDid, type, `vcJwt`, `subjectClaims`, issued/expiry, revocation), and surfaced to the wallet via `mapHeld` (`GET /me/credentials`, `GET /orgs/:id/wallet`). A public `GET /credentials/:id/status` route already reports live revocation + on-chain anchoring. ID-I adds a rendered-PDF view over exactly this data.

**Tech stack:** packages/core (the per-type `certificate` config + validation) + apps/api (a `pdfkit`-based generation module + one public route + a `mapHeld` flag) + apps/web (a builder sub-section per credential type + a download control on the credential card). New dependency: `pdfkit` in `apps/api`. The QR code reuses the existing `qrcode` package (already used for QR login).

---

## The seam

A certificate is a **rendered projection of an already-issued credential**, generated **on the fly** per request. It needs no new persistence model of its own: every field it prints already exists on the `CredentialRecord` (issuerDid, holderDid, `subjectClaims`, issuedAt, expiresAt, revocation) or is derivable (issuer org name via `findByDid`; live status via the same registry read the status route uses). The one new piece of stored state is **configuration** — how a given credential type wants its certificate to look — which attaches to the existing `CredentialTypeSpec` inside the `CredentialUseCaseDefinition`. The optional logo/seal reuses the existing `Document` store (`deps.documents`) rather than inventing a new blob path.

Generating on the fly (not snapshotting a PDF at issuance) is deliberate: the certificate always reflects **live** revocation/expiry state, there is nothing to store or invalidate, and re-rendering after a config edit is automatic.

---

## Scope

**In scope (ID-I):**
- **Core:** an optional `certificate?` object on `CredentialTypeSpec`; `validateCredentialUseCase` validates it (back-compatible: absent ⇒ no certificate, every existing use case unchanged).
- **API:** a `certificate.ts` module that renders a credential + its type's `certificate` config + live status into a PDF `Buffer`; one **public** route `GET /credentials/:id/certificate.pdf`; a `certificateAvailable: boolean` added to the `mapHeld` projection.
- **Web:** a per-credential-type "Issue PDF certificate" sub-section in `CredentialUseCaseBuilder` (heading, subheading, claim selection/order, optional logo upload); a **Download certificate** control on `CredentialCard` when available.

**Out of scope (deferred / YAGNI):**
- Certificate config in the **template catalog** (`use-case-templates.ts`) / the ID-G provisioning path — a provisioned use case enables certificates by editing the use case for now; carrying cert config through templates is a clean later extension of the same field.
- A **full template designer** (custom sections, multiple images, fonts, multi-page).
- **Digitally signing the PDF** itself (PAdES/PKCS#7). Authenticity is established by the QR/verification-URL back to the live status page + on-chain anchor, matching the platform's existing verification model.
- **Snapshotting / archiving** generated PDFs.
- Gating the certificate behind fresh consent or a VP ceremony — the credential's own issuance already gated it.

---

## Configuration model (core)

Add to `CredentialTypeSpec` (in `packages/core/src/credential-use-cases.ts`):

```ts
export interface CertificateConfig {
  /** When true, credentials of this type expose a downloadable PDF certificate. */
  enabled: boolean;
  /** Certificate title. Defaults to the credential type `title`. */
  heading?: string;
  /** Optional line under the heading (e.g. the issuing authority). */
  subheading?: string;
  /** Claim keys to print, in order. Defaults to all claim-schema properties, schema order. */
  claimOrder?: string[];
  /** Optional logo/seal image, referencing a stored Document id. */
  logoDocumentId?: string;
}

export interface CredentialTypeSpec {
  name: string;
  title: string;
  claimSchema: MetadataSchema;
  validityDays: number;
  requiredApprovals: number;
  certificate?: CertificateConfig;   // NEW — optional, back-compatible
}
```

`validateCredentialUseCase` (in the same file) adds, for any type with a `certificate`:
- `enabled` must be a boolean.
- `heading`/`subheading`/`logoDocumentId`, when present, must be strings.
- `claimOrder`, when present, must be an array of strings and every entry must be a key in that type's `claimSchema.properties` (fail-fast on a claim key that does not exist).

Absent `certificate` is always valid (existing stored configs and every current use case pass untouched).

---

## Generation engine (api)

A new module `apps/api/src/certificate.ts` exports one function, e.g.:

```ts
renderCredentialCertificate(input: {
  credential: CredentialRecord;
  spec: CredentialTypeSpec;          // resolved type, carries certificate config
  issuerName: string | null;         // resolved org name (findByDid), may be null
  statusUrl: string;                 // public /credentials/:id/status URL for the QR
  status: { revoked: boolean; revokedAt: string | null; revokedReason: string | null };
  logoBytes: Buffer | null;          // pre-fetched from the Document store, or null
}): Promise<Buffer>
```

It uses `pdfkit` to draw a standard, single-page A4 certificate:
1. **Logo** (if `logoBytes`) centered at the top.
2. **Heading** (`certificate.heading ?? spec.title`) and optional **subheading**.
3. A **"This certifies that"** block naming the holder (holder DID; a `holderName`/`subjectName` claim if present is used as the display name).
4. A **claims table**: rows for the keys in `certificate.claimOrder` (or all `claimSchema.properties` in order), skipping the internal `id` claim; label = the property's `claimSchema` `description` if set, else the humanized claim key (the schema has no per-property `title`); value = the claim value. Only claims present on the credential are shown.
5. **Metadata footer**: issuer name + issuer DID, credential type, issued date, expiry date (or "No expiry"), and the credential id.
6. A **QR code** (PNG buffer from `qrcode.toBuffer(statusUrl)`) bottom-corner, with the `statusUrl` printed beneath it and a short "Scan to verify" caption.
7. **Status banner:** if `status.revoked` → a bold red **REVOKED** banner (with `revokedAt`/`revokedReason`); else if `expiresAt` is in the past → an **EXPIRED** banner. Drawn as a prominent diagonal/top watermark so a printed copy cannot hide it.

The module is pure (bytes in → Buffer out); all IO (loading the credential, resolving issuer name, reading live status, fetching the logo) happens in the route so the renderer stays unit-testable.

---

## Route & access

One **public capability-URL** endpoint serves all three audiences (the holder, the issuing desk/org, and anyone given the link). The unguessable `randomUUID` credential id is the capability token — the same posture as the existing public `GET /credentials/:id/status`.

`GET /credentials/:id/certificate.pdf` (in `apps/api/src/http/routes.ts`, unauthenticated):
1. Load the credential (`deps.credentials.get(id)`); `404` if not found.
2. Resolve its use case (`credentialUseCaseKey`) and the matching `CredentialTypeSpec` (`credentialUseCaseType`). If there is no use case / type, or the type has no `certificate?.enabled === true` → **`404`** (this credential has no certificate).
3. Resolve issuer name (`findByDid(issuerDid)`), build the `statusUrl` (`${deps.publicApiUrl}/credentials/${id}/status`), read live status (reuse the existing status logic used by `GET /credentials/:id/status` — DB revocation ± chain), and, if `logoDocumentId` set, fetch bytes via `deps.documents.get(...)` (missing/broken ⇒ `null`, never fail).
4. `renderCredentialCertificate(...)` → Buffer.
5. Reply with `content-type: application/pdf`, `content-disposition: attachment; filename="<type>-<id>.pdf"`, `x-content-type-options: nosniff`, and `.send(buffer)`.

**Web download** links straight to this URL (holder wallet + issuer views), so no authenticated variant is needed. `mapHeld` gains `certificateAvailable: boolean` (true iff the credential's type resolves and `certificate?.enabled`), so the wallet shows the button only when a certificate exists.

---

## Web

- **`CredentialUseCaseBuilder.tsx`** — in the Credential-types step, each type editor gains an "Issue PDF certificate" checkbox. When checked, reveal: a **heading** text field, a **subheading** text field, a **claim selector** (multi-select over that type's claim keys defining which to show and their order; empty ⇒ all), and an optional **logo upload** (POST the file to the existing `/documents`, store the returned id as `logoDocumentId`; show the current logo's presence). The `certificate` object is included in the POSTed/PATCHed use-case config.
- **`CredentialCard.tsx`** — when `credential.certificateAvailable`, render a **Download certificate** control (a link to `${BASE}/credentials/${c.id}/certificate.pdf`) beside the existing "Copy VC-JWT" / "Download" controls. Add `certificateAvailable?: boolean` to the web `HeldCredential` type.
- **api client / types** — add `certificate?` to the web `CredentialTypeSpec`/use-case types; add an upload helper for the logo if one is not already present (mirror the existing `downloadDocument` fetch pattern in reverse).

---

## Data flow

An OrgAdmin/PlatformAdmin authoring a use case ticks **Issue PDF certificate** on the Domicile type, sets a heading ("Certificate of Domicile"), picks the claims to show, and (optionally) uploads a seal. The `certificate` config persists on that `CredentialTypeSpec`. Later a Domicile credential is issued through the normal maker-checker flow — unchanged. The holder opens My Identity, sees a **Download certificate** button (because `certificateAvailable` is true), and downloads a PDF; the issuing desk can pull the same PDF; a verifier handed the link gets it too. The PDF's QR resolves to the live status page. If the issuer later revokes the credential, the very next render of the certificate carries a **REVOKED** banner and the QR's status page shows revoked — no snapshot to chase.

---

## Error handling

- Type has no `certificate.enabled` (or no resolvable use case/type) ⇒ **`404`** from the certificate route; the web never shows the button (`certificateAvailable` false).
- **Missing or unreadable logo** document ⇒ render the certificate **without** the logo; never fail the request.
- **Revoked / expired** credential ⇒ certificate still renders (200), stamped with the status banner; the QR/status page is the source of truth.
- **PII:** the certificate embeds the holder's claims and is served from an unauthenticated capability URL by explicit design choice. The spec records this trade-off; the mitigation is the unguessable `randomUUID` id (identical exposure to the existing public status route, which already returns per-credential state).
- Renderer failure (unexpected) ⇒ 500 via the normal error path; the renderer is defensive about optional fields (null issuer name, empty claims, absent expiry).

---

## Testing

- **core:** `validateCredentialUseCase` accepts a valid `certificate` (enabled, heading, claimOrder ⊆ properties); rejects a non-boolean `enabled`, a non-string heading, and a `claimOrder` entry not in the schema; a type with no `certificate` still validates. Existing credential-use-case tests stay green.
- **api:** create a use case whose type has `certificate.enabled`; issue a credential of it (reuse the issuance helper); `GET /credentials/:id/certificate.pdf` → `200`, `content-type: application/pdf`, body begins with `%PDF-` and is non-trivial in size; a credential whose type lacks certificate config → `404`; an unknown id → `404`; a **revoked** credential → still `200` (renderer invoked with revoked status — assert via the renderer unit test that the banner text is drawn, since the PDF bytes are opaque); `mapHeld` sets `certificateAvailable` correctly for both cases. A `logoDocumentId` pointing at a stored image renders; a dangling id still renders (200). Keep the renderer's status/label logic unit-testable so assertions do not depend on parsing PDF bytes.
- **web:** `typecheck` + `build`. Live walkthrough (fast-boot: throwaway DB, `CHAIN_STRICT=0`, no chain env): author a use case with a Domicile type + certificate enabled (heading + claim selection + a small uploaded logo); issue a Domicile credential to a holder; as the holder, Download certificate → open the PDF and confirm heading, claims table, issuer, QR; open the certificate via the raw public URL (no login) → same PDF; revoke the credential → re-download → **REVOKED** banner present. Screenshots.

## Verification / done

Full core + api suites green (new certificate tests + all existing identity/compliance tests untouched) + web tsc/build + the live walkthrough above (issue → download as holder → download via public link → revoke → watermark), then finish the branch (`feat/credential-pdf-certificates` → main).

## Alternatives considered

- **Snapshot a PDF at issuance** (store bytes in the Document store) — avoids per-request rendering but goes stale on revocation/expiry and on any config edit, and needs invalidation. On-the-fly rendering is simpler and always live.
- **Client-side PDF generation** (jsPDF/@react-pdf in the browser) — keeps the server thin but cannot embed the server's live status/anchor read cleanly, duplicates the layout across audiences (public link would need its own page), and complicates the "anyone with the link" path. Server-side one-route generation serves all three audiences identically.
- **Separate authenticated routes per audience** (holder / issuer / public) — more surface area for the same bytes. Since the user chose to allow the public link, a single public capability-URL is the minimal correct design; the id is the capability token.
- **Config on the use case (not per type)** — simpler, but a use case can define multiple credential types with different claim shapes; per-type config (the chosen granularity) lets each type carry its own heading/claims/logo.
- **`pdf-lib` / headless-Chrome (`puppeteer`)** — `pdf-lib` is lower-level for text/table drawing; `puppeteer` pulls a full browser into the API image. `pdfkit` is pure-Node, embeds PNG (the QR) and the logo, and draws text/tables directly.
