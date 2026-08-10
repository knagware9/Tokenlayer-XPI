# Org-Scoped Certificate Artwork (EN-F follow-up) — Design

**Goal:** Let an OrgAdmin set certificate artwork and field placements on a
credential use case **their own organization owns**, without widening anything
else about that use case.

**Why this exists:** EN-F shipped the designer (merged at `84e9806`) and its
spec's opening promise is "let an issuing organization upload their own
certificate artwork". Today `certificate.background` is writable only through
`POST /credential-use-cases` and `PATCH /credential-use-cases/:key`, both
PlatformAdmin-gated. The org self-service path is
`POST /credential-use-cases/provision`, which runs through `instantiateTemplate`
— and that deliberately drops `background`, because templates are readable by
any authenticated user and one tenant's letterhead must not become another's.
So the delivered feature is "the platform operator does it for them", which
`docs/api/CHANGELOG.md` records as a known gap. This is finding 7 of the EN-F
final review.

The console makes the gap concrete: `IdentityHome` renders
`CredentialUseCaseBuilder` — the only host of `CertificateDesigner` — behind
`isPlatformAdmin`. An OrgAdmin's path is "Provision from template", which lands
them a use case with `placements` and no artwork, and no affordance anywhere to
add it.

**Tech stack:** `packages/core` (the `background` shape and its validation),
`apps/api` (one new route plus a shared document-resolution helper),
`apps/web` (an OrgAdmin entry point onto the existing designer). No new
dependencies and no schema migration.

---

## What this is NOT

Not a general "OrgAdmins may edit credential use cases". The definition PATCH
stays PlatformAdmin-only. This adds one narrow door onto two fields of one
credential type's certificate block, and everything else on the stored
definition is read from storage rather than from the request body.

## The route

```
PATCH /credential-use-cases/:key/certificate
```

`authScoped("usecases:provision")` — the scope that already governs authoring
credential use cases and templates, and the one
`POST /credential-use-cases/preview-certificate` uses for the same act.

```jsonc
{
  "credentialType": "Course Completion",                  // required
  "background": { "documentId": "doc_x", "sha256": "…" }, // omit = unchanged, null = clear
  "placements": [ /* CertificateFieldPlacement[] */ ]     // omit = unchanged, [] = clear
}
```

Responds `200` with the updated `CredentialUseCase`, the same shape
`PATCH /credential-use-cases/:key` returns.

**Three-state fields, stated once.** `undefined` means *leave as stored*, and an
explicit `null` (for `background`) or `[]` (for `placements`) means *clear*.
Without the distinction there is no way to remove artwork through this route,
and reverting to the built-in layout is a thing an org will legitimately want.

### The gates, in order

1. `principal` + `requireScope("usecases:provision")` — narrows machine callers
   only.
2. **`role ∈ {PlatformAdmin, OrgAdmin}`** → else 403 `FORBIDDEN`.
3. Use case exists → else 404.
4. `modeGate(request, reply, existing)` → `WRONG_MODE` when a `tl_test_` key
   acts on a live use case, or a `tl_live_` key on a sandbox one.
5. **Ownership.** A PlatformAdmin passes. Otherwise `claims.orgId` must be a
   non-empty string **and** `existing.ownerOrgId === claims.orgId` → else 403
   `FORBIDDEN`.
6. The named credential type exists in the definition → else 404 naming it.

Step 2 is not decoration. `requireScope` short-circuits on `if (!key) return` —
scopes are a property of API keys, so for a human JWT session the gate passes
unconditionally and **`authScoped` alone gates nothing**. This is the exact
shape the EN-F final review proved on `preview-certificate`, where a seeded
tokenization Buyer got a 403 from `GET /documents/:id` and a 200 from a route
that embedded the same document's bytes in a PDF.

Step 5 is written truthiness-first for the same family of reason. A legacy or
platform-owned record has `ownerOrgId: null`; a caller whose claims carry no
`orgId` has `undefined`. Comparing them directly is the null-as-allow shape that
EN-B, EN-D2 and EN-F each produced once, so the guard on `claims.orgId` comes
before the comparison, and a `null` owner therefore refuses every non-platform
caller.

### What it writes

The definition written is **the stored one**, with exactly
`credentialTypes[i].certificate.{background,placements}` replaced. `key`,
`sandbox`, `ownerOrgId`, the issuer/holder/verifier bindings, `holderAcceptance`
and every claim schema are read from storage and never from the body, so extra
fields in the request are inert rather than trusted. An api test asserts that
directly by posting `issuer`, `sandbox`, `ownerOrgId` and `key` alongside a
legitimate design and reading the definition back unchanged.

Before writing:

- `validateCertificatePlacements(placements, Object.keys(type.claimSchema.properties), type.name)`
  → 400 `INVALID_CERTIFICATE_PLACEMENT`, naming the offending index. The same
  validator both existing doors call.
- `validateCredentialUseCase(spliced, …)` over the whole definition — the second
  door, unchanged. A narrow route that skipped it would be a cheaper way onto
  the store than the front one.

Then `credentialUseCases.update(key, { ...spliced, ownerOrgId: existing.ownerOrgId, sandbox: existing.sandbox })`
and an audit append carrying `{ key, credentialType }`.

### `certificate.enabled`

If the named type already has a `certificate` block, `enabled` is preserved
exactly as stored — this route never toggles it.

If the type has **no** `certificate` block at all, the route creates
`{ enabled: true, background, placements }`. Refusing would be a dead end: the
render route requires `certificate.enabled === true`, an OrgAdmin cannot set it
any other way (the definition PATCH is PlatformAdmin-only), and the whole point
of this work is to remove that dead end. Uploading artwork for a credential type
is unambiguous intent to have a certificate for it.

## Binding `background.documentId`

Today `background.documentId` is bound to nothing: core checks only that it is a
non-empty string, and both renderers read whatever document id they are handed
with no ownership check and no content-type check. Letting OrgAdmins write it
makes that materially worse, so the binding is tightened as part of this work.

**Core.** `background?: { documentId: string; sha256?: string }`. `sha256` stays
optional so every record written by EN-F remains valid; when present it must
match `/^[0-9a-f]{64}$/` (the store's `createHash("sha256").digest("hex")`
casing). Enforced in `validateCredentialUseCaseDefinition` and in
`validateTemplate`, so both doors agree.

**API.** One helper, two strictnesses:

- **The org route requires the pin.** `sha256` is mandatory in its body, and the
  stored document must exist, hash to it, and carry an `image/*` `contentType`
  → 400 `BACKGROUND_DOCUMENT_NOT_FOUND`, `BACKGROUND_DOCUMENT_MISMATCH`, or
  `BACKGROUND_NOT_AN_IMAGE`.
- **The three existing doors verify what they are given.**
  `POST /credential-use-cases`, `PATCH /credential-use-cases/:key` and
  `POST /credential-use-cases/preview-certificate` refuse a *supplied* `sha256`
  that mismatches, and a stored `contentType` that is not `image/*`. A
  documentId naming a document that does not exist stays legal on those doors,
  exactly as today — which keeps `certificate-artwork.test.ts`'s deliberate
  "a missing background document falls back to the built-in layout" case intact
  and changes no shipped PlatformAdmin behaviour.

Render-time behaviour is unchanged: unreadable or missing artwork still degrades
to the built-in layout at `error`, never a blank page and never a 500. That
resilience is deliberate (a document can be deleted long after a config is
written) and write-time strictness does not replace it.

**Residual risk, stated rather than papered over.** `model Document` has no
owner column (id / contentType / sha256 / size / bytes), so this does not make
cross-tenant document reads impossible — it makes them require the hash, which
you obtain only by uploading the file yourself or by already being allowed to
read it. Real per-document ownership is a schema change and its own piece of
work; this design does not pretend to close that hole, it raises the cost of the
one path this route would otherwise open.

## Web

`IdentityHome`'s expanded use-case row gains a **Design certificate** action per
credential type, opening a panel that reuses `CertificateDesigner` unchanged.

- **Visibility:** `PlatformAdmin || (OrgAdmin && useCase.ownerOrgId === user.orgId)`,
  mirroring the server's step 5 including its truthiness guard. It lives in
  `apps/web/src/lib/` as a pure predicate so it is unit-tested — `apps/web` has
  no DOM test environment, which is why `lib/certificate-layout.ts` already
  holds every calculation the designer performs.
- **Artwork upload:** `api.uploadDocument` already returns `{ id, sha256 }`, so
  the panel carries both into `background` with no new plumbing.
- **Save:** a new `api.updateCertificateDesign(token, key, body)` onto the new
  route.
- **Preview:** unchanged — `preview-certificate` already admits OrgAdmin, and
  the draft it posts now carries `sha256` alongside `documentId`.
- **Mirror:** `apps/web/src/types.ts` gains `sha256?: string` on `background`.
  `certificate-mirror.test.ts` guards the field catalog against drift; the
  background shape is kept in step by hand as the rest of that file is.

## File structure

| File | Change |
|---|---|
| `packages/core/src/credential-use-cases.ts` | `background` gains `sha256?`; validate its format. |
| `packages/core/src/use-case-templates.ts` | Same format check in `validateTemplate`. |
| `apps/api/src/http/routes.ts` | The new route; a shared `resolveBackgroundDocument` helper applied at all four doors. |
| `apps/api/src/http/schemas.ts` | The route's schema, its documented scope and its error codes. |
| `apps/api/openapi.snapshot.json` | Regenerated. |
| `apps/web/src/lib/certificate-access.ts` | **NEW.** The pure visibility predicate. |
| `apps/web/src/components/IdentityHome.tsx` | The per-type "Design certificate" action + panel. |
| `apps/web/src/api.ts`, `apps/web/src/types.ts` | `updateCertificateDesign`; `sha256?` on the mirrored background. |
| `docs/api/CHANGELOG.md` | Replace the "configured BY THE PLATFORM OPERATOR" note with the new route. |

## Testing

**core** — `sha256` absent is valid; malformed (short, uppercase, non-hex) is
refused at both the definition and the template validator.

**api** (a new suite):

- owner OrgAdmin 200, and the design reads back on `GET /credential-use-cases/:key`;
- OrgAdmin of a different org 403; `ownerOrgId: null` + OrgAdmin 403; Issuer /
  Holder / Verifier / Buyer roles 403; no principal 401;
- a key without `usecases:provision` 403 `INSUFFICIENT_SCOPE`;
- unknown use-case key 404; unknown credential type name 404;
- a `tl_test_` key against a live use case `WRONG_MODE`;
- a body carrying `issuer`, `sandbox`, `ownerOrgId` and `key` changes none of
  them;
- `background` with a mismatched `sha256`, a missing document, and a
  `text/plain` document each 400 with their own code;
- `background: null` clears artwork and the next render is the built-in layout;
- omitted `placements` leaves stored placements untouched; `[]` clears them;
- a malformed placement 400 `INVALID_CERTIFICATE_PLACEMENT` naming the index;
- `enabled` preserved when a block exists, created `true` when none does.

`scope-coverage.test.ts`, `mode-coverage.test.ts` and the openapi snapshot all
take the new route as-is — no allowlist entry, because it is scoped and it mode-
gates.

**web** — the visibility predicate: platform admin always; owner OrgAdmin yes;
non-owner OrgAdmin no; `ownerOrgId: null` no; a user with no `orgId` no.

**live walkthrough** — log in as a real OrgAdmin, provision from a template,
open Design certificate, upload artwork, place the holder name and the QR,
preview, save, issue a credential, download the PDF and look at it. Then attempt
the same route against another org's use case and confirm the 403.

## Verification / done

Full core / api / web suites against the `main` baselines (283 / 760 / 138),
`npx tsc --noEmit -p apps/api` **and** `-p apps/web` (`npm run build` in
`apps/web` is `vite build` and does not typecheck), the web build, the live
walkthrough above, then the whole-branch review, which hunts independently
rather than confirming this document.

## What is deliberately excluded

- **Per-document ownership.** A `Document.ownerOrgId` column would let the org
  route (and the render, and the preview) refuse a foreign document outright.
  It is a migration plus a backfill decision for every document already stored,
  and it belongs to its own piece of work.
- **Opening the definition PATCH to OrgAdmins.** Issuer binding, holder policy
  and claim schemas are platform-governed; artwork is not.
- **Letting this route toggle `certificate.enabled`** on a type that already has
  a certificate block, or edit `heading` / `subheading` / `claimOrder` /
  `logoDocumentId`. Narrow on purpose; each is a separate ask with a separate
  blast radius.
- **An org-scoped document list.** Useful for re-selecting artwork uploaded
  earlier, and it needs the ownership column above to be safe.

## Alternatives considered

- **Type named in the path** (`…/credential-types/:name/certificate`) — most
  RESTful, and credential type names are free text, so it adds a URL-encoding
  surface for no gain over naming the type in the body.
- **All types in one call** (`{ types: [...] }`) — atomic across a multi-type
  use case, and an omitted type becomes ambiguous between "leave alone" and
  "clear". The designer edits one type at a time, so the per-type call also has
  the smaller lost-update window.
- **Unhide `CredentialUseCaseBuilder` for OrgAdmins** — one line of web, and its
  save calls the PlatformAdmin-gated definition PATCH, so everything except the
  artwork would 403. A visible dead end is worse than the current invisible one.
- **Require `sha256` at every door** — strongest binding, and it changes a
  shipped PlatformAdmin contract and edits an EN-F test that stores a
  non-existent document id on purpose to prove the render falls back.
