# PNG Certificate Designer (EN-F) — Design

**Goal:** Let an issuing organization upload their own certificate artwork and place credential fields onto it visually, so the PDF a holder downloads is their design rather than ours.

**Program context:** This is item (2) of the 2026-08-08 enterprise ask — "certificate templates that accept a PNG upload and let you configure which field prints at which placeholder" — and the last unbuilt piece of EN-A..F. EN-A gave organizations a capability envelope, EN-B org-scoped API keys, EN-C webhooks, EN-D1 the developer portal, EN-D2 sandbox mode. All of the plumbing this needs already exists: the document store accepts `image/png` up to 5 MB, `CertificateConfig` already rides through ID-J template provisioning, and `GET /credentials/{id}/certificate.pdf` already renders and serves a PDF.

**Tech stack:** `packages/core` (the field vocabulary, placement types and their validation), `apps/api` (a second renderer + a preview route), `apps/web` (the designer). No new dependencies: pdfkit already ships the fonts, and the drag surface is pointer events on absolutely-positioned divs.

---

## What exists, and what is actually missing

`apps/api/src/certificate.ts` is 89 lines: pdfkit, A4 portrait, a centred heading, "This certifies that", a subject name, a claim list, an issuer block, a QR to the public status URL bottom-right, and a rotated `REVOKED` / `EXPIRED` watermark. It is driven by `CertificateConfig` in `packages/core/src/credential-use-cases.ts`:

```ts
export interface CertificateConfig {
  enabled: boolean;
  heading?: string;
  subheading?: string;
  claimOrder?: string[];
  logoDocumentId?: string;
}
```

So artwork *upload* is solved (`logoDocumentId` already stores an image document and the web builder already uploads one). What is missing is **placement**: today the layout is ours and the customer gets a logo slot.

## The mode

**Artwork replaces the layout.** When a credential type has a `background`, none of the generated furniture prints — no heading, no "This certifies that", no claim list, no issuer block. Only the fields the designer placed are drawn onto the artwork. A customer who has paid for a design with its own title, borders and signature lines does not want ours printed on top of it.

Credential types with no `background` keep the current renderer, byte for byte. That is the whole back-compatibility story: **every existing certificate is produced by code this project does not touch.**

## Architecture: a pure draw list

The natural implementation grows `certificate.ts` into a two-mode file. Instead it splits around a pure middle:

```ts
// apps/api/src/certificate-fields.ts
resolveCertificateFields(input) → Map<CertificateFieldRef, string>   // what the values ARE

// apps/api/src/certificate-artwork.ts
certificateDrawList(config, fields, page, opts) → DrawOp[]           // what goes WHERE
drawCertificate(ops, artworkBytes) → Promise<Buffer>                 // the pdfkit adapter
```

`certificateDrawList` is pure — no pdfkit, no I/O, no clock beyond an injected `nowMs`. It is where every rule worth testing lives, and it turns assertions that would otherwise mean parsing a PDF into one-liners over an array:

```ts
expect(ops.filter((o) => o.kind === "qr")).toHaveLength(1);          // always exactly one
expect(ops.at(-1)?.kind).toBe("watermark");                          // drawn over everything
```

`DrawOp` is a small closed union:

```ts
type DrawOp =
  | { kind: "image"; x: number; y: number; w: number; h: number }               // the artwork itself
  | { kind: "text"; text: string; x: number; y: number; width: number | null;
      fontSize: number; font: CertificateFont; bold: boolean; color: string;
      align: "left" | "center" | "right" }
  | { kind: "qr"; url: string; x: number; y: number; size: number; caption: string | null }
  | { kind: "watermark"; label: string; detail: string | null }
  | { kind: "sample" };                                                          // preview only
```

Coordinates in a `DrawOp` are **absolute PDF points**, already resolved from the stored 0–1 fractions against the computed page. The adapter does no arithmetic; it executes.

The order is therefore: measure the artwork → `certificatePageSize(imageW, imageH)` → `certificateDrawList(...)` → `drawCertificate(ops, artworkBytes)`. The `image` op carries only geometry; the bytes are passed alongside, because a draw list that embedded a 5 MB buffer would be miserable to assert against — which is the entire point of having one.

**Rejected: a general layout engine** that the built-in layout is also expressed in. It would make the two paths one, and it would mean rewriting a working 89-line renderer as data — risk with no customer benefit, and a migration for every existing config.

## The placement model

```ts
// packages/core/src/certificate-fields.ts  (NEW)

/** A value that can be printed onto certificate artwork. */
export type CertificateFieldRef =
  | `claim:${string}`      // any key in the credential type's claimSchema
  | "subject.name" | "subject.did"
  | "credential.id" | "credential.type" | "credential.issuedAt" | "credential.expiresAt"
  | "issuer.name" | "issuer.did"
  | "config.heading" | "config.subheading"
  | "qr";

export type CertificateFont = "sans" | "serif" | "mono";

export interface CertificateFieldPlacement {
  field: CertificateFieldRef;
  /** 0–1 of page width / height. The ANCHOR point; `align` decides which edge
   *  of the text sits on it, and `y` is the TOP of the text box. */
  x: number;
  y: number;
  /** 0–1 of page width. Text wraps inside it; for `qr` it is the square's edge. */
  width?: number;
  fontSize?: number;                       // points, 4–96, default 11
  font?: CertificateFont;                  // default "sans"
  bold?: boolean;                          // default false
  color?: string;                          // #rrggbb, default "#0f172a"
  align?: "left" | "center" | "right";     // default "left"
}
```

**Defaults, stated once.** Omitted `width` means no wrapping — the text runs from its anchor as one line. For a `qr` placement `width` is the square's edge and defaults to `0.14` of page width; `fontSize`, `font`, `bold`, `color` and `align` are meaningless on a `qr` and are ignored rather than rejected, so a designer who set them on a text field and switched it to the QR loses nothing. An auto-inserted QR (no placement at all) uses `x: 0.82, y: 0.82, width: 0.14` with the "Scan to verify" caption.

`config.heading` / `config.subheading` are placeable so that a **parameterised template heading still prints in artwork mode** — ID-J templates substitute `{{orgName}}` into `certificate.heading`, and that would otherwise become dead config the moment artwork is uploaded.

`CertificateConfig` gains exactly two optional fields:

```ts
background?: { documentId: string };          // an image/* document; its PRESENCE selects the mode
placements?: CertificateFieldPlacement[];
```

**No stored image dimensions.** The renderer measures the artwork (`doc.openImage(bytes)` gives `.width`/`.height`), and the browser measures the loaded `<img>`. Storing width/height would create a second source of truth for the aspect ratio that nothing keeps in step — and the aspect ratio decides the page, so a stale copy is a misprinted certificate.

**Placements are allowed without a background** and are simply inert: the built-in renderer ignores them. This is load-bearing rather than lax, because it is exactly the state a template instantiation lands in (see below).

## Page geometry

The page **is** the artwork:

```
long edge  = 841.89 pt            (A4's long edge — a familiar physical size)
short edge = long × (min(w,h) / max(w,h))
orientation follows the image
```

No letterboxing, ever, and one coordinate space: 0–1 over the page is 0–1 over the image, so what the designer drags is where it prints. Printing onto A4 paper scales and centres — the print dialog's job.

The cost, stated plainly: artwork that is not A4-shaped produces a non-standard page size, which some print shops dislike. The alternatives were worse — fitting inside A4 puts white bands on a design the customer paid for, and filling A4 crops it.

## The rules that configuration cannot override

These are the reason this feature needs a design rather than a form.

1. **A QR is always drawn.** If no `qr` placement exists, `certificateDrawList` appends one at the bottom-right with its "Scan to verify" caption, exactly where the built-in layout puts it. You choose where; you never choose whether. The certificate route is public and unauthenticated, and a certificate with no path back to its status is an assertion with no way to check it.

2. **The revoked / expired watermark is appended last**, after every placement, from `certificateStatusBanner()` — the existing function, unchanged. It consults no placement and no config. A certificate that can be designed to hide its own revocation is a forgery kit.

3. **Preview PDFs are stamped `SAMPLE — NOT A CREDENTIAL`** on the diagonal. The preview route accepts a draft config and arbitrary sample claims from any OrgAdmin; without the stamp it is a certificate generator for made-up facts, rendered by the same code that renders real ones. This does slightly break the WYSIWYG promise the preview exists to keep — accepted deliberately, and the stamp is the only difference between a preview and the real render.

4. **An unreadable background falls back to the built-in layout.** Deleted document, unsupported bytes, pdfkit throwing on a malformed PNG — all produce the old certificate, not a blank page and not a 500. Logged at `error`, because it means a document went missing under a live config.

## Surfaces

**`POST /credential-use-cases/preview-certificate`** — new. `authScoped("usecases:provision")`: this is a configuration-authoring act, and `usecases:provision` is already the scope for authoring credential use cases and templates. Body carries the **draft** `CredentialTypeSpec` plus optional sample claims, because the designer runs before the use case is saved:

```jsonc
{ "credentialType": { /* a full CredentialTypeSpec, certificate included */ },
  "sampleClaims": { "legalName": "Ada Lovelace", "country": "IN" } }
```

Missing sample values are filled from the claim key (`humanizeKey`) so an empty preview still shows every placement's position. Responds `application/pdf`, `content-disposition: inline`. `bodyLimit: 256 KB` — the body is a JSON credential-type spec, not artwork (the artwork is already stored and referenced by id), so the default 1 MB is loose rather than generous.

**`GET /credentials/{id}/certificate.pdf`** — unchanged except for a dispatch on `spec.certificate?.background`. Its public exposure, its acceptance gate, its on-chain status read and its sandbox short-circuit all stay as they are.

**Templates carry placements, never artwork.** `instantiate()` in `packages/core/src/use-case-templates.ts` drops `background` and keeps `placements`. `GET /credential-use-case-templates` is open to any authenticated user and `GET /documents/{id}` is gated by role rather than by organization, so a template carrying Org A's artwork id would hand Org B a pixel-exact impersonation of A's certificates — on a route that needs no credential to read. The layout is the reusable part anyway: a "Certificate of Completion" arrangement is generic, a letterhead is not. An instantiated use case therefore has placements and no artwork, and renders the built-in layout until its new owner uploads their own.

## Validation

In `packages/core`, called from the existing `validateCredentialUseCaseDefinition` and the template validator, so both doors enforce the same rules:

- `background.documentId` — non-empty string.
- Each placement: `field` parses to a known ref; a `claim:<k>` names a key present in that type's `claimSchema.properties` (the rule `claimOrder` already carries); `x`, `y` in `[0,1]`; `width` in `(0,1]`; `fontSize` in `[4,96]`; `color` matches `/^#[0-9a-fA-F]{6}$/`; `font` and `align` in their enums.
- At most **40 placements** per credential type — bounds the draw loop and the payload, and is far above any real certificate.
- Duplicate `field` values are allowed (the same claim may legitimately print twice), except `qr`, which may appear at most once.

Failures throw `PolicyError("INVALID_CERTIFICATE_PLACEMENT", …)` naming the credential type and the offending index, so a 400 tells the designer which chip is wrong.

## Web

**`apps/web/src/components/CertificateDesigner.tsx`** — new, launched from a "Design certificate →" control in the existing certificate block of `CredentialUseCaseBuilder`. Too large to live inline in that block, and it needs the full width.

- **Artwork**: file input → `api.uploadDocument` (existing) → `background.documentId`. Accepts `image/png,image/jpeg,image/webp`.
- **Canvas**: the artwork `<img>` at its natural aspect inside a max-width box, with one absolutely-positioned chip per placement at `left: x*100%`, `top: y*100%`. Dragging is `pointerdown`/`pointermove`/`pointerup` on the chip, writing back normalized coordinates clamped to `[0,1]`. No drag library.
- **Palette**: every unplaced field as a click-to-add chip, dropped at the canvas centre.
- **Properties**: the selected placement's font, size, weight, colour, alignment, wrap width, and a remove button.
- **Preview PDF**: posts the draft type to the preview route and opens the returned blob.

The canvas is an approximation — a browser laying out HTML text is not pdfkit laying out PDF text, and wrapping and metrics will differ slightly. That is what the preview button is for, and the panel says so in one line rather than pretending otherwise.

**Mirror drift.** The field catalog must be copied into `apps/web/src/types.ts`, on the same terms as `API_SCOPES` and `EVENT_TYPES` — the web app has no dependency on core. That mirror has now silently drifted twice, most recently costing two webhook scopes that were added to core by EN-C and never mirrored, which shipped as blank checkboxes on a green build. So this one gets **an api test that reads `apps/web/src/types.ts` as text, extracts the mirrored catalog and asserts it equals core's** — the api package can import core and read the file, which the web package cannot. Scoped to this catalog; generalising the same check to `API_SCOPES` and `EVENT_TYPES` is a worthwhile follow-up and is not this branch.

## File structure

| File | Responsibility |
|---|---|
| `packages/core/src/certificate-fields.ts` | **NEW.** `CertificateFieldRef`, `CertificateFieldPlacement`, the catalog with labels, `validateCertificatePlacements()`. No I/O. |
| `packages/core/src/credential-use-cases.ts` | `CertificateConfig` += `background`, `placements`; validation calls the new validator. |
| `packages/core/src/use-case-templates.ts` | Template `certificate` carries `placements`; `instantiate()` drops `background`. |
| `apps/api/src/certificate-fields.ts` | **NEW.** `resolveCertificateFields()` — credential + spec + issuer → printable strings. Shared by both renderers. |
| `apps/api/src/certificate.ts` | Built-in renderer, **unchanged behaviour**; its inline claim/subject resolution moves to the shared resolver. |
| `apps/api/src/certificate-artwork.ts` | **NEW.** `certificateDrawList()` (pure) + `drawCertificate()` (pdfkit adapter) + `certificatePageSize()`. |
| `apps/api/src/http/routes.ts` | Dispatch on `background`; the preview route. |
| `apps/api/src/http/schemas.ts` | Placement/background schema fragments; the preview route's schema and documented scope. |
| `apps/web/src/components/CertificateDesigner.tsx` | **NEW.** The designer panel. |
| `apps/web/src/components/CredentialUseCaseBuilder.tsx` | Launches it; carries `background`/`placements` through save. |
| `apps/web/src/types.ts`, `apps/web/src/api.ts` | Mirrored catalog + placement types; `previewCertificate()`. |

## Testing

**core** — every validation rule in both directions (a valid placement passes, each malformed one throws with its index); `claim:` refs checked against a real `claimSchema`; the 40 cap; at most one `qr`.

**draw list (pure, the bulk of the value)** — a QR op is present when no `qr` placement exists and when one does, and exactly once either way; the watermark op is last for a revoked credential and absent for a live one; `sample` appears only in preview mode; normalized coordinates resolve to the expected points for both orientations; alignment and wrap width reach the op; an unknown claim ref cannot appear (validation is upstream, so this asserts the resolver skips rather than throws).

**api** — artwork mode returns a PDF (`%PDF` magic, non-trivial length) and built-in mode still does; a missing background document falls back to the built-in layout rather than erroring; the preview route is refused without `usecases:provision` and stamped when granted.

Back-compat is asserted two ways, and **not** by comparing bytes against `main`: pdfkit stamps `CreationDate` from the wall clock, so two runs of identical input differ anyway, and a suite cannot execute the other branch's code. Instead — the existing `apps/api/test/credential-certificate.test.ts` is **not edited** (it is the oracle), and a new test asserts that a config with no `background` never reaches the artwork renderer, through a seam rather than through output.

**templates** — a template carrying `placements` instantiates with them; a template built from a use case with `background` instantiates **without** it, asserted on the produced definition.

**web** — the designer renders placed chips at the right percentages; a pointer drag writes back clamped normalized coordinates; the preview button posts the draft config; the mirrored catalog matches core (the cross-package drift test lives in the api suite).

**live walkthrough** — upload real artwork, place a name, two claims, the issue date and the QR, save the use case, issue a credential to a holder, download the PDF and look at it; then revoke and download again and confirm the watermark is over the artwork. A rendering feature's proof is a human looking at the render.

## Verification / done

Full core + api + web suites (including one api run with `.env` moved aside, counts identical), `tsc --noEmit` for api **and web** (`npm run build` is `vite build` and does not typecheck — this bit us on 2026-08-10), the web build, the live walkthrough above, a browser pass over the designer, then the final whole-branch review, which hunts independently. Then finish the branch (`feat/certificate-designer` → main).

## What is deliberately excluded

- **Rotated or letter-spaced text.** Angled ribbon text is a real design idiom and is not needed to fill in the blanks on a certificate; both add renderer surface and preview-fidelity risk.
- **Custom font upload.** pdfkit's three built-in families cover serif/sans/mono. A font pipeline means storage, licensing and embedding decisions that deserve their own design.
- **Multi-page certificates.** One artwork, one page.
- **Per-placement conditional visibility** ("only print this claim when non-empty"). An empty value simply prints nothing, which handles the common case without a rule language.
- **Artwork for tokenization assets.** `generic-certificate` is a tokenized asset, not a PDF; certificates remain a credential feature.

## Alternatives considered

- **Artwork as a background under the current layout** — cheapest to build, and it forces the customer to design around a layout they do not control. Rejected with the mode decision.
- **Absolute PDF points on a fixed A4 page** — matches pdfkit's native units and breaks the moment the artwork is not A4-shaped, drifting every placement relative to the art it was aligned to.
- **Pixel coordinates at the artwork's natural size** — intuitive while dragging, and re-uploading the same design at 2× resolution invalidates every placement.
- **Canvas-only preview** — no round trip, and the gap between the browser's text layout and pdfkit's surfaces as a customer complaint after the first hundred certificates.
- **Artwork travelling with templates** — one code path instead of two, and it hands one tenant's branding to another on a public route.
