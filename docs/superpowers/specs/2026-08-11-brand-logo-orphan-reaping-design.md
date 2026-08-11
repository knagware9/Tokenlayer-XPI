# Brand-logo orphan reaping — design

Date: 2026-08-11
Status: approved, not yet implemented
Origin: EN-E's final review raised this as LOW and deliberately deferred it out of that branch.

## The finding

`POST /orgs/:id/branding/logo` (`apps/api/src/http/routes.ts`) lets an OrgAdmin
store documents up to `MAX_DOC_BYTES` (5 MB) with no per-org quota, no rate limit
beyond the generic one, and no reaping of uploads that are never pinned as
`brandLogoDocumentId`. Every reconsidered logo pick leaves a 5 MB row behind
forever.

`POST /documents` has the same property but is gated on the `issue` capability.
This door deliberately opens document-store writes to the OrgAdmin role, which
holds `["read"]` alone in `MATRIX` — so the blast radius is new.

## What the exploration changed about the remedy

Two facts found while reading the code reshaped the options.

**There is no discriminator on a document row.** `Document` carries
`id / contentType / sha256 / size / bytes / createdAt / ownerOrgId` and nothing
else. Four upload sites write into it: asset attachments (`routes.ts:1735`),
public KYB (`routes.ts:3531`), the brand-logo door (`routes.ts:3996`), and the
general `POST /documents` (`routes.ts:6259`).

That defeats the naive form of both originally-proposed remedies. A cap counting
all `ownerOrgId = X` rows would let a year of invoice evidence and KYB
certificates refuse a 40 KB logo — a check answering the wrong question
confidently, which is the exact shape EN-E's reviews kept finding. And a sweep of
"org-owned documents no `brandLogoDocumentId` references" would delete
certificate artwork, asset attachments and KYB certificates, since none of those
are named by that column either.

**Certificate backgrounds are references that live inside JSON.** They are stored
in `CredentialUseCase.credentialTypes` (`schema.prisma:115`), not in a column,
and `checkBackgroundDocument` (`routes.ts:1116`) gates a pin on org ownership
alone — it never asks what the document was uploaded for. So an org can pin its
brand-logo document as certificate artwork, and no SQL "unreferenced" query would
ever see that reference.

Any deletion-based remedy therefore has to either scan JSON for references — a
completeness claim that rots silently the next time someone adds a JSON reference
site — or make the discriminator authoritative so the set of possible references
is closed by construction. This design does the latter.

## Decision

Add a `purpose` column, and make each upload replace its own predecessor. No cap,
no sweep, no cron.

Rejected alternatives:

- **Cap only, nothing deleted.** Safest — no reference analysis at all — but the
  garbage still accumulates up to the cap, and a cap with no reaping is a wall
  the honest OrgAdmin eventually hits, which then needs an escape-hatch route
  anyway.
- **Cap plus time-based sweep** (the finding's two originals). Closes the
  residual gap below, but costs a sweep trigger, a threshold, and a new admin
  surface — a lot of machinery for a tail bounded at 5 MB per org.
- **Reuse `ownerOrgId` plus a content-type filter** instead of a new column.
  Certificate artwork is also an org-owned PNG, so the cap would over-count and a
  sweep would delete artwork.

## Design

### 1. Data model

`Document.purpose String?` on the Prisma model. Null for every existing row and
every other upload site; stamped `"brand-logo"` only by the branding door. Typed
as `"brand-logo" | null` in `DocumentRecord` so a typo cannot invent a third
purpose.

`storeUploadedDocument` and `DocumentRepository.create` take `purpose` as a
**required** parameter, for the same reason `ownerOrgId` is required today: an
optional parameter is how an upload site forgets. All four call sites change;
three pass `null`.

Two new repository methods, on both the memory and Prisma implementations:

- `listByOwnerPurpose(ownerOrgId, purpose)` → `{ id, size, createdAt }[]`.
  **Deliberately no `bytes`** — loading 5 MB buffers to decide what to delete
  would be absurd.
- `remove(id)` → `void`. Matches the `remove` precedent already present in four
  other repositories.

Schema change ships via `prisma db push`; this repo keeps no migration files.

### 2. The invariant that makes deletion safe

`brandLogoDocumentId` becomes the **only** reference that can exist to a
`purpose = "brand-logo"` row. Two facts hold it up — plus a third this section
originally missed, and a corrective note on why.

1. Only the owning org can pin one. PATCH `/orgs/:id/branding` requires
   `orgOwnsDocument(doc, id)` (`routes.ts:3936`), so "is this pinned" is a
   single-org field read, not a store-wide scan.
2. **Every caller-supplied document-id door refuses a brand-logo document.**
   This section originally named exactly one such door —
   `checkBackgroundDocument`'s refusal of `certificate.background` — on the
   reasoning that it was the sole place a certificate references stored bytes.
   That reasoning was wrong: it conflated "the place I found while writing
   this design" with "every place a reference can be written," and code review
   after the first implementation found three more caller-supplied
   document-id doors that the same reference-visibility problem applies to:

   - `certificate.logoDocumentId` — the same `CredentialUseCase.credentialTypes`
     JSON, a different field, one `checkBackgroundDocument` never inspected.
     It is live: `certificateLogoDocumentId` (`certificate-fields.ts`) resolves
     it and the renderer draws it whenever a type carries no `background`.
   - The credential-use-case **template** door
     (`POST /credential-use-case-templates`) and, belt-and-suspenders, the
     **provision** path (`POST /credential-use-cases/provision`) — a template
     can carry `logoDocumentId` (unlike `background`, which
     `instantiateTemplate` always strips), and a template saved before a
     given refusal existed reaches `provision` with no revalidation.
   - `StagedInvoice.documentId`, written by `POST /use-cases/:key/invoices`,
     which checked only that the id existed — no ownership, no purpose.

   All four now share one predicate (`brandLogoRefusal` in `routes.ts`): does
   the resolved document carry `purpose = "brand-logo"`. Distinct error codes
   per door (`BACKGROUND_IS_BRAND_LOGO`, `CERTIFICATE_LOGO_IS_BRAND_LOGO`,
   `INVOICE_DOCUMENT_IS_BRAND_LOGO`) so each door's message names the right
   field, but the rule itself is stated once.

The refusal in `checkBackgroundDocument` is placed **after** the ownership
check and **before** the content-type check, preserving the ordering that
block's comment is built around — only a caller who already owns the bytes (or
a PlatformAdmin, on the doors where ownership is skipped by design) learns
anything from it, so it does not become an oracle over the document store.

**The lesson, stated plainly: "the reference set is closed by construction"
was a claim about the code, not a claim about one field the author happened to
be looking at.** Upload *sites* — where a document gets a `purpose` stamped on
it — are four, unchanged, and enumerated in §1. Reference *sites* — where a
caller can hand back a document id and have it stored somewhere the prune
cannot see — are a **different list**, discovered by asking "where does a
caller-supplied document id get persisted," not "where does the artwork
pipeline read from." Conflating the two lists is exactly how the second and
third doors above were missed the first time.

Together these turn "I scanned everywhere I could think of" into "there is one
column, and every door that writes a caller-supplied document id checks it."

This does constrain a legitimate case: an org whose mark is also its certificate
letterhead must upload the file twice, once at each door. That is cheap, the two
doors are already separate, and it buys a provable invariant.

### 3. The prune

In `POST /orgs/:id/branding/logo`, **after** the new document is stored
successfully:

- list the org's `purpose = "brand-logo"` rows;
- delete every one except the row just created and `org.brandLogoDocumentId` if
  set;
- append one `brand-logo-pruned` audit entry, only when something was actually
  removed.

Ordering is load-bearing: store first, prune second. The old mark is never
dropped before the new bytes are safe.

The prune is best-effort — a failed delete does not fail the upload. The caller's
intent was to upload, the response is still 201, and the leak a failure leaves is
bounded.

Concurrency: two simultaneous uploads can each spare the other's row, and the
next upload collects both. The bound is "small", not "exactly two".

### 4. Deliberately not built

No cap, no dedicated per-route rate limit, no sweep, no cron, no admin route.
Under this design storage is bounded by org count rather than by request count,
so each of those would be a knob guarding nothing.

Two residuals, stated rather than papered over:

- An org that uploads exactly once and abandons it keeps that one row forever —
  bounded at 5 MB per org, not unbounded growth.
- Pre-existing rows carry `purpose = null`, so they are never listed and never
  pruned. There is no honest way to guess what they were.

### 5. Tests

New suite `apps/api/test/org-branding-prune.test.ts`:

- a second upload deletes the unpinned first;
- **the pinned mark survives an upload** — the core safety property;
- the prune is org-scoped: org A's upload leaves org B's rows alone;
- a PlatformAdmin uploading on an org's behalf prunes *that* org's rows, not the
  platform org's;
- documents from the other three doors survive untouched, including an org-owned
  certificate-artwork PNG (`purpose = null`);
- the just-uploaded document is still fetchable after the prune;
- a brand-logo document cannot be pinned as certificate artwork
  (`BACKGROUND_IS_BRAND_LOGO`).

`certificate-artwork.test.ts` and the existing branding suites must stay green.

Run with:

```
"<repo>/apps/api/node_modules/.bin/vitest" run --root "<repo>/apps/api" test/<file>
```

### 6. OpenAPI

The 201 response shape is unchanged — `purpose` is not added to it — so the diff
should be limited to the new error on the artwork and use-case doors. Regenerate
with `npm run openapi:snapshot` from `apps/api` and read the diff either way.

## Constraints

- Never touch `apps/api/prisma/dev.db*`.
- API tests live in `apps/api/test/`.
