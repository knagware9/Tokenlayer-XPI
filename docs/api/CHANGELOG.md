# XI Tokenize API — changelog

Changes to the **public REST surface** under `/api/v1`, newest first. This file
is for people writing code against the API. Every entry tries to answer two
questions and nothing else: *what changed*, and *what must I do differently?*

Where a change could break a working integration it is marked **ACTION
REQUIRED**. Where we are not certain whether something was breaking, the entry
says what was checked rather than claiming a verdict.

The published reference is the OpenAPI document at `GET /openapi.json`, rendered
in the console under **Developers → Reference**. (Swagger UI is also mounted at
`/docs`, but only usefully outside production — see the EN-D1 entry below.) Its
machine-readable surface — which credentials each route
accepts, which scope a key needs, which status codes it can answer — is
committed at `apps/api/openapi.snapshot.json`, so any change to it appears in a
diff. That file is generated, not written by hand; see the header of
`apps/api/src/http/openapi-snapshot.ts` for what it does and does not promise.

---

## Unreleased — the treasury is the use case's, and you no longer send it

### **ACTION REQUIRED** — `treasuryAccount` is removed from three request bodies

Every use case now owns a treasury account that the platform provisions for it
and records on the use case itself. Issuance and pricing read it from there.
Nothing about who receives a mint or who sells on the marketplace has changed in
substance — what changed is that **you no longer name the account, and may no
longer name one.** A treasury address that a caller could choose was an address
a caller could point somewhere else.

The field is gone from all three bodies, and **every one of them silently
ignores it now** rather than rejecting it — including the two whose schemas
carry `additionalProperties: false`. Fastify's ajv compiler runs with its
default `removeAdditional: true`, which *strips* an undeclared property
before validation ever gets a chance to reject it; this app never overrides
that default. Check all three:

| Request body | Sending `treasuryAccount` today | Omitting it today |
| --- | --- | --- |
| `POST /assets` — top-level `treasuryAccount` | **Ignored.** The field is silently stripped and the mint goes to the use case's own treasury. | Fine — and now required behaviour. |
| `POST /assets` — `sale.treasuryAccount` | **Ignored**, despite `sale` being `additionalProperties: false` — stripped before validation runs. It was **required** before; sending it today no longer errors, it just does nothing. | Fine. |
| `POST /assets/{id}/actions/setPrice` — `treasuryAccount` | **Ignored**, same reason. | Fine. |
| `POST /use-cases/{key}/invoices/tokenize` — `treasuryAccount` | **Ignored.** | Fine. It was **required** before. |

So: nothing about sending this field errors anymore, on any of the four
spellings — which is the more important thing to know than a 400 would have
been. If your integration still sends a `treasuryAccount` address anywhere in
these three bodies, it now gets a `2xx` and the address it named does nothing;
the mint goes to the use case's own registered treasury regardless. Delete
the field from your integration rather than trusting a status code to tell you
it's unused.

**Nothing was added to any response.** `asset.treasuryAccount` is unchanged: it
is still the marketplace seller, still `null` until sale terms exist, and now
always the use case's registered treasury when it is set.

### New refusal: `400 MISSING_TREASURY`

`POST /assets` (with `initialSupply` or `sale`) and `setPrice` answer
`400 MISSING_TREASURY` when the use case has no registered treasury. This can
only happen to a use case created before this shipped on a deployment that has
not yet run the backfill; the upgraded API runs it at boot, so in practice you
should never see it. If you do, it is an operator action, not a client one.

### `PATCH /me/wallet` gains `409 ADDRESS_IS_ORG_TREASURY`

A use case's treasury address is visible to anyone who can read its assets, and
it has no user linked to it. Linking yourself to one is now refused — on this
route and on the `walletAddress` field of the user-creation routes (which answer
`400` with the same code). No legitimate integration links a wallet it does not
control, so this should be inert for you.

---

## Unreleased — an issuer's register says which programme

### `GET /orgs/{id}/credentials` gains `credentialUseCaseKey` and `acceptance`

Purely additive; no existing field changed and nothing was removed.

The register returned an undifferentiated pile. An authority running several
credential use cases — a domicile certificate and an income certificate, say —
could not tell which one a credential came from, so nothing could be counted,
filtered or reconciled per programme. Both facts were already on the row:

- **`credentialUseCaseKey`** — the use case the credential was issued under, or
  `null` for a platform-catalog credential (the `KycCredential` minted at
  onboarding, an organization credential). `null` means *no programme*, not
  "unknown": treat those rows as enrolment paperwork rather than folding them
  into a scheme's delivery numbers.
- **`acceptance`** — `accepted | pending | rejected | changes_requested`.
  **Issued is not in force.** A holder who never accepted has a credential that
  exists and does not apply, and an issuer's own register is exactly where that
  difference matters.

Who may read the register is unchanged: `credentials:read`, and an org may still
only read its own.

---

## Unreleased — deploying Tokenization and Identity apart

Two changes that turn "two products" from a menu into a boundary. Both are
additive for a deployment that serves both products, which is the default.

### `ENABLED_DOMAINS` is now enforced, not just displayed

`ENABLED_DOMAINS` previously reached one route — `GET /config`, which tells the
console which navigation to draw. Every identity route still answered on a
deployment that had switched identity off.

Now a deployment serves only the products it is configured for. On a
tokenization-only instance, identity routes answer **`404 DOMAIN_NOT_ENABLED`**
and are absent from `GET /openapi.json`; the mirror holds for identity-only.
Shared routes — `/auth`, `/me`, `/orgs`, `/users`, `/proposals`, `/audit`,
`/documents`, `/events`, `/chains`, `/config` — always answer, because without
them neither product works.

**ACTION REQUIRED only if you set `ENABLED_DOMAINS` to a single product AND
called the other's routes.** The default (`tokenization,identity`) is unchanged
and publishes exactly the surface it did before. An unauthenticated request is
also unchanged: it still gets `401`, so the gate is not an oracle for which
products an instance runs.

### New: `POST /identity/assertions`

Answers one question for another SERVICE: does this subject hold a valid,
unrevoked credential of this type?

```
POST /api/v1/identity/assertions
{ "subject": "did:key:z6Mk…", "credentialType": "KycCredential" }
→ 200 { "subject": "…", "credentialType": "KycCredential",
        "holds": true, "checkedAt": "2026-08-13T…" }
```

This is what a separately-deployed Tokenization instance calls before letting an
account receive a token from a use case with
`compliance.requireVerifiedIdentity`. In a single deployment the engine answers
it in-process; both paths run the same predicate, so **splitting the deployment
cannot change who may hold a token**.

- **New scope `identity:assert`.** A PEER scope, not a customer one: a key
  holding it may ask about ANY subject, because the caller is a peer platform
  rather than a tenant. Grant it to a trusted peer only. Every call is written
  to the audit log — that visibility is what a scope this broad is traded for.
- **Machine-only.** A human session is refused with **`403 SESSION_PRINCIPAL`**,
  even a platform admin's. Scopes are a property of API keys, so a scope check
  alone passes every interactive session; without this the route would let any
  signed-in user enumerate who is KYC'd.
- **A verdict, never the credential.** No claims, no issuer, no credential id.
  Those stay behind the holder's consent in the presentation exchange
  (`POST /verification-requests`) — an assertion that returned contents would be
  a back door around consent.
- **POST rather than GET** deliberately: the subject DID stays out of URLs,
  proxy logs and referrers.

### **ACTION REQUIRED** — an expired credential no longer passes the identity gate

Previously, `compliance.requireVerifiedIdentity` accepted a KYC credential that
had passed its `expiresAt`: the gate deciding whether an account may receive a
token treated a lapsed credential as valid. Three other components did not — the
verification exchange reports `notExpired: false`, the certificate renderer
stamps **EXPIRED**, and the identity dashboard counts it in the "expired"
bucket. Four components, two answers, and the dissenter was the one enforcing
compliance.

They now agree. Expiry is part of validity in the one predicate the in-process
gate and `POST /identity/assertions` share.

**What changes for you:** an account whose KYC credential has lapsed is now
refused with `IDENTITY_NOT_VERIFIED` on mint/transfer/buy into a use case with
`requireVerifiedIdentity`, and `POST /identity/assertions` answers
`holds: false` for it. If you rely on long-lived eligibility, either re-issue
before expiry or issue with `expiresAt: null` (no expiry), which is unchanged
and still valid forever. Nothing else about issuance, revocation or acceptance
moved.

The boundary is **strictly after**: a credential is valid up to and including
its expiry instant, matching the certificate renderer exactly. Comparison is on
instants (`Date.parse`), not strings, so a timestamp carrying an offset is not
mistaken for a later one.

### Where the verified-identity answer comes from is now a deployment choice

`compliance.requireVerifiedIdentity` used to be answered one way: read this
process's own credential table. A tokenization-only deployment has no such
table, so the rule was unenforceable there. It now has three sources, picked
once at boot:

| Configuration | Where "does this DID hold a KycCredential?" is answered |
|---|---|
| `ENABLED_DOMAINS` includes `identity` | this deployment's own credential store |
| `IDENTITY_SERVICE_URL` + `IDENTITY_SERVICE_KEY` set | `POST /identity/assertions` on that deployment |
| neither | nowhere — the mint is refused, loudly (below) |

Only a **DID** crosses the wire. Resolving a wallet address to its user and DID
stays on tokenization's side, because a wallet is a tokenization concept.

**New error code `IDENTITY_SERVICE_UNAVAILABLE` (503).** A timeout, a refused
connection, a 5xx or a rejected peer key answers this — deliberately NOT
`IDENTITY_NOT_VERIFIED`, and deliberately not a `4xx`. "This holder has no valid
credential" and "we could not find out" have different fixes, and answering
`false` on a transport failure would send an operator to the holder's
credentials instead of to the network. Treat it as retryable; nothing about the
request needs to change.

**Two configurations now refuse to boot**, because both fail silently in
production: `IDENTITY_SERVICE_URL` without `IDENTITY_SERVICE_KEY` (or the
reverse), and a remote identity service on a deployment that *also* runs the
identity domain — where the desk would write credentials into one database while
the gate read another, and a just-verified holder would be refused with nothing
in any log to say why.

No change for a deployment that serves both products, which is the default.

### Each product now owns its own tables — and its own database

`ENABLED_DOMAINS` stopped a deployment ANSWERING for a product it does not
sell. It did not stop it WRITING that product's data, and those are not the same
door: `POST /proposals/{id}/approve` is a **shared** route on every deployment,
and a `create-use-case` proposal approved through it wrote a tokenization use
case an identity-only instance had no route to serve. Boot was worse — it seeded
tokenization use cases and attempted their contract deploys regardless.

Every table now names its owner, in `prisma/schema.prisma` (a `/// domain:` line
per model, checked against the runtime table by a test) and enforced at the
repository seam:

| Owner | Tables |
|---|---|
| tokenization | `UseCase` `Asset` `Listing` `Account` `CashBalance` `Cashflow` `StagedInvoice` |
| identity | `CredentialUseCase` `CredentialUseCaseTemplate` `VerificationRequest` |
| shared | `User` `ApiKey` `Organization` `Credential` `LoginKey` `Proposal` `AuditLog` `AuditAnchor` `Document` `Event` `WebhookEndpoint` `WebhookDelivery` `RegistryDeployment` |

A single-product deployment's database needs its own tables plus the shared
ones. Touching another product's table answers **`404 DOMAIN_NOT_ENABLED`** —
the same code and status the route gate already uses, because "this route is not
served here" and "this table is not kept here" are one fact from the outside.

Two entries in that table are worth stating outright:

- **`Credential` is shared.** Organization membership is built on VCs — adding a
  member mints a sub-DID and a membership credential through `/orgs/{id}/members`,
  a shared route. Making it identity-owned would mean a tokenization deployment
  could not add an org member without a round trip to the identity service. The
  credentials the identity PRODUCT issues still live only where it runs.
- **`Account` is tokenization's.** A wallet is a tokenization concept, the same
  line drawn at the assertion API, where only a DID crosses the wire.

**What changes for you on a single-product deployment.** Supplying a
`walletAddress` to `POST /users` on an identity-only instance is now refused
with `404 DOMAIN_NOT_ENABLED` rather than accepted and silently dropped, and
sign-in reports `walletAddress: null` instead of failing (it used to read that
table and error). Creating a use case no longer consults the other product's
slug namespace — on separate databases they cannot collide.

**Nothing changes on a deployment that serves both products.** The guard is
literally the same repository objects there; no proxy, no wrapper.

### `POST /users` takes a `did` — for a holder whose identity lives elsewhere

The last thing standing between the split and a working deployment. Onboarding
mints a custodial DID, so the same person onboarded on the identity deployment
and on the tokenization deployment ended up with **two**, and
`requireVerifiedIdentity` asked the identity service about one it had never
issued anything to. Every holder failed the gate, and it looked like policy.

```
POST /api/v1/users
{ "email": "…", "password": "…", "role": "Buyer", "useCaseKey": "…",
  "walletAddress": "0x…", "did": "did:key:z6Mk…" }   ← issued by the identity service
```

- **Optional and additive.** Omit it and onboarding mints a DID exactly as
  before, seed and all.
- **Refused with `400 DID_NOT_ACCEPTED` by a deployment that runs the identity
  product** — there it mints its own, and accepting a caller's would be a way to
  point a wallet at somebody else's verified identity.
- **Refused together with `kyc`** (same code). One links an identity issued
  elsewhere; the other asks *this* deployment to issue one.
- **No custodial seed is stored** for a linked DID. This deployment does not
  hold that key and must never be able to sign as the holder.

### Also fixed: sign-in on a single-product deployment

`POST /auth/login`, the QR poll and `GET /me` resolved a session's use-case
domain by listing BOTH catalogues, and login additionally read the user's wallet
— tables a single-product deployment does not keep. Sign-in failed outright for
any user carrying an `accountId`. Each now consults only what its deployment
owns; a combined deployment is unaffected.

---

## Unreleased — a verifier can list the requests it raised

Purely additive; no existing route, response or scope changed.

- **New: `GET /verification-requests`** — the requests **you raised**, newest
  first. It is the mirror of `GET /me/verification-requests`, which returns the
  requests addressed **to** you. Same `verifications:read` scope, same
  `VerificationRequest` shape.

  Until now the id returned by `POST /verification-requests` was the only handle
  on a request, and nothing gave it back: an integration that lost it (a crashed
  process, a restarted worker, an operator who closed the tab) could not reach
  `/consent`'s outcome or `/verify`, while the request itself stayed open. If
  you have been persisting request ids purely to work around that, you no longer
  have to.

  Scoped exactly as `GET /verification-requests/{id}` is — an organization admin
  sees their organization's, a use-case-scoped Verifier desk sees its own use
  case's, a platform admin sees all. A caller with no verifier scope gets `200`
  with an empty array rather than `403`. A `tl_test_` key sees sandbox rows only,
  the same narrowing every other list applies.

  It does **not** carry the verifier's verdict — that still needs
  `verifications:verify` via `GET /verification-requests/{id}/verify` — and
  `eligibleCredentials` remains the holder inbox's field alone.

---

## Unreleased — an organization wears its own logo and colour (EN-E)

An organization can now set a logo and one accent colour, and its members see
both across the console. Everything here is additive: **an organization that
sets nothing behaves exactly as it did**, and the platform look is unchanged.

- **`Organization` gains `brandLogoDocumentId` and `brandAccent`**, both
  nullable, on `GET /orgs/{id}` and `GET /orgs`. `brandAccent` is a six-digit
  hex string (`#rrggbb`), normalized to lowercase on write.
- **New: `PATCH /orgs/{id}/branding`** — a PlatformAdmin, or **this
  organization's own OrgAdmin**. Send only what you are changing: an omitted key
  leaves the column alone, an explicit `null` clears it. A malformed accent is
  `400 INVALID_BRAND_ACCENT` rather than a silent correction.
- **New: `POST /orgs/{id}/branding/logo`** — the organization's own upload door.
  `POST /documents` requires the `issue` capability, which an OrgAdmin does not
  have, so without this the feature would have been unusable by the exact role
  it is for. `{contentType, dataBase64}` → `201 {id, sha256, size}`.
- **New: `GET /orgs/{id}/branding/logo`** — the mark itself, readable by **any
  member** of that organization (the whole roster renders it, not just admins).
  The URL carries **no document id**: the route reads the organization's own
  `brandLogoDocumentId`, so it cannot become a second way into the document
  store.
- **`GET /me`, `POST /auth/login` and the QR-login poll** now carry
  `brandLogoDocumentId` and `brandAccent` on the session principal, so a branded
  console paints correctly on first paint instead of after a follow-up fetch.

**A logo must be PNG or JPEG, and must be a document your organization owns.**
Both doors refuse anything else. `image/webp` is refused deliberately: it is a
perfectly good image that the certificate renderer cannot draw, and accepting it
would mean a mark that appears in the console and silently never on a
certificate. A document another organization owns is refused with the same
answer as one that does not exist — telling the two apart would make the route
an existence oracle over the store.

**Certificates.** A credential type that names its own `certificate.logoDocumentId`
is unaffected. One that does not now prints the **issuing organization's** brand
logo. Most-specific-wins: branding an organization never overrides a type that
already chose. Artwork mode is untouched — a certificate rendered from your own
artwork prints only your placements.

**These are session-only routes.** All three refuse an API key with
`403 MACHINE_PRINCIPAL`, whatever its scopes — including an empty scope list.
Setting a brand is a console act; no scope grants it.

---

## Unreleased — certificate artwork: place your own fields on your own design (EN-F)

A credential type's certificate can now be YOUR artwork with the fields placed
where you want them, instead of our layout with your logo in a slot. Everything
here is additive: **a credential type with no `background` renders exactly as it
did**, through code this release does not touch.

- **`CertificateConfig` gains two optional fields.** `background:
  {documentId}` names a stored image document, and its PRESENCE selects the
  mode: with it, none of the generated furniture prints (no heading, no "This
  certifies that", no claim list, no issuer block) and only your `placements`
  are drawn onto the artwork. `placements[]` positions each field in **0–1
  fractions of the page**, so re-uploading the same design at a higher
  resolution does not move anything.
- **The page becomes your artwork's shape** — its aspect ratio with A4's long
  edge (841.89 pt). No letterboxing, and one coordinate space. Artwork that is
  not A4-shaped therefore produces a non-standard page size; printing onto A4
  paper scales and centres.
- **`x` is an ANCHOR, not a left edge.** `align` decides which part of the text
  sits on it: `left` starts there, `center` straddles it, `right` ends on it.
- **Two things configuration cannot switch off.** A verification QR is always
  drawn — you choose where (and it must fit on the page, at least 0.06 of page
  width), never whether; and the REVOKED/EXPIRED watermark is drawn over
  everything regardless of any placement. A certificate that could be designed
  to hide its own revocation would be a forgery kit, and this render route is
  public and unauthenticated.
- **Unusable artwork falls back to the built-in layout**, never a blank page and
  never a 500. Deleting a document does not break every certificate for a type.

**New: `POST /credential-use-cases/preview-certificate`** — `usecases:provision`
plus a PlatformAdmin or OrgAdmin session. Renders a DRAFT credential type (you
are designing before the use case is saved) and returns the PDF. **Always
stamped `SAMPLE — NOT A CREDENTIAL`** when artwork is used: it renders
caller-supplied claims through the same code that renders real certificates.

**Limits worth knowing.** Artwork is capped at 35 megapixels and its
decompressed size is bounded; interlaced PNGs are refused (the render falls
back). At most 40 placements per credential type, and at most one QR.

**Templates carry the layout, never the artwork.** A design saved as a
credential-use-case template keeps its `placements` and has `background`
stripped when it is stored — templates are readable by any authenticated user,
and one tenant's letterhead must not become another's. The instantiating
organization uploads their own.

**New: `PATCH /credential-use-cases/{key}/certificate`** — `usecases:provision`
plus a PlatformAdmin, or an OrgAdmin whose organization **owns** the use case
(`ownerOrgId`). This is how an organization sets its own artwork. It writes
`certificate.background` and `certificate.placements` on ONE named credential
type and nothing else: every other field of the definition is read from storage,
so sending `issuer`, `sandbox`, `ownerOrgId` or `key` alongside changes none of
them. Omit a field to leave it unchanged; `background: null` drops the artwork
(reverting to the built-in layout) and `placements: []` clears the layout.
Editing the rest of a credential use case remains PlatformAdmin-only.

**New: `POST` / `GET /credential-use-cases/{key}/certificate/artwork`** — same
scope, same ownership rule. `POST` stores the artwork and returns
`{documentId, sha256}`; `GET ?credentialType=<name>` returns the bytes that
type's design currently uses, and takes **no document id** — the use case you
own is the capability, so a stored document no design references is not
reachable through it. These exist because `POST /documents` and
`GET /documents/{id}` are restricted to issue-capable roles, which an Org Admin
is not: the general document store holds off-ledger invoice evidence, so the
capability is bounded by the use case you own rather than granted over the
store.

**Artwork must be `image/png` or `image/jpeg`** — **415** otherwise. This is
narrower than `image/*` on purpose: the renderer is pdfkit's `openImage`, which
draws nothing else, so a `image/webp` background would have stored with a 201,
looked right in the designer, and then silently printed the built-in layout on
every certificate.

**`background` now takes an optional `sha256`** — the digest the document store
recorded for those exact bytes, `0x`-prefixed. The org route above **requires**
it and refuses a document that does not exist, does not hash to it, or is not
renderable artwork. The three older doors (`POST`/`PATCH /credential-use-cases`
and `preview-certificate`) verify a `sha256` you supply and refuse a
non-renderable one, but still accept a bare `documentId`, including one naming a
document that has since been deleted: that case degrades to the built-in layout
at render time, and that behaviour is unchanged.

### Follow-up: a digest was never a capability

An adversarial review of the above found that the pin did not do the job claimed
for it, and these are the corrections. **ACTION REQUIRED if you reference
documents across organizations.**

- **A certificate background must now name a document YOUR ORGANIZATION
  UPLOADED.** Documents carry an owner (`Document.ownerOrgId`), set from the
  uploader — for `POST /credential-use-cases/{key}/certificate/artwork`, from the
  organization that owns the use case. A background naming a document owned by
  anyone else is refused **exactly as if the document did not exist**, so the
  refusal discloses nothing about ids you do not own. Rows written before this
  release have no owner and can be referenced only by a PlatformAdmin: re-upload
  the artwork through the artwork route to make it yours.
  *Why:* `GET /credential-use-cases` is open to any authenticated user and
  serialised the whole certificate block, digest included. Reading another
  tenant's `{documentId, sha256}` there, pinning it onto a use case you do own,
  and fetching your own artwork returned their file byte for byte. A digest
  answers "are these the bytes I meant", never "may I have them".
- **`POST /credential-use-cases/preview-certificate` will not render a document
  your organization does not own.** It previews the built-in layout instead —
  the same answer as a background naming nothing, deliberately, so the two are
  indistinguishable. This door never required a pin, so it was open to every
  OrgAdmin.
- **`GET /credential-use-cases` and `GET /credential-use-cases/{key}` no longer
  include `certificate.background` or `certificate.logoDocumentId`** for callers
  who are neither a PlatformAdmin nor the owning organization. Every other field
  is unchanged, and owners see their design in full.
- **Creating a certificate on a type that has none now requires `enabled:
  true`** in the body of `PATCH /credential-use-cases/{key}/certificate`;
  otherwise **400 `CERTIFICATE_NOT_ENABLED`**. Designing a layout used to create
  the block implicitly — and because `GET /credentials/{id}/certificate.pdf` is
  public and unauthenticated, that turned every already-issued credential of
  that type into a downloadable PDF of its subject's claims. Publishing is a
  decision, so it is now stated. This route still never switches an existing
  certificate off.

**ACTION REQUIRED only if you wrote `background` before this release and want to
edit it through the new org route.** A stored background with no `sha256` can be
kept or removed, but not edited in place — the org route will not accept a
pinless background, and nothing can honestly produce a digest for bytes the
caller did not upload. Re-upload the artwork to pin it. Existing certificates
render exactly as before either way.

---

## Unreleased — consenting to a verification needs its own scope

**ACTION REQUIRED if a machine key consents to verification requests on a
holder's behalf.** `POST /verification-requests/{id}/consent` required
`credentials:read`. It now requires **`credentials:present`**, a new scope.

The route is not a read. It decrypts the holder's custodial signing key, signs a
Verifiable Presentation **as them**, and releases the selected credentials'
contents to a third-party verifier — and the disclosure cannot be recalled. A
key minted for a dashboard, an expiry sweep or a reconciliation job wants
`credentials:read` and has no business doing any of that.

- **Who is affected:** a key whose grant list contains `credentials:read` (or
  any other exact scope) but not `credentials:present`. It now gets **403
  `INSUFFICIENT_SCOPE`** with `details: { required: "credentials:present" }`.
- **Who is not:** a key granted `credentials:*` or `*` is unaffected — the
  wildcard covers the new scope, and since the scope is new nobody could have
  been granted it explicitly before now. Human sessions are unaffected; scopes
  are a property of keys only.
- **What to do:** rotate the key with `credentials:present` added, or grant
  `credentials:*` if the key legitimately acts for the holder end to end.
  `credentials:present` is deliberately **not** implied by `credentials:issue`
  either: issuing speaks for the ISSUER, presenting speaks for the HOLDER.

Separately, the Developers console's scope picker was missing `webhooks:read`
and `webhooks:write` — added by EN-C to the server but never mirrored into the
web app, so you could not mint a webhook-managing key from the same screen that
manages webhooks. Both now appear. Server-side validation was always correct;
this only affects what the console offers.

---

## Unreleased — every sandbox boundary, not just the ones with a use case (EN-D2 review)

The mode gate was written for routes that name a use case. The final review
walked the rest of the surface by hand and found four places where a `tl_test_`
key still reached live data — each one a door beside a door that *was* gated.
All four are closed. **Nothing here changes what a human session or a
`tl_live_` key can do**; the entire effect is on `tl_test_` keys, which were
never meant to reach any of this.

- **ACTION REQUIRED if a `tl_test_` key manages webhook endpoints.** Only
  registration was mode-scoped, so a test key could list, repoint (`PATCH`),
  rotate the signing secret of, and delete a **live** endpoint. Every
  per-endpoint route (`PATCH`, rotate, `DELETE`, test-ping, deliveries, replay)
  now answers **404** for an endpoint of the other mode, and `GET
  /orgs/{id}/webhooks` returns only the caller's own environment. 404 rather
  than 403 deliberately: an endpoint in the other environment should not be
  distinguishable from one that does not exist.

- **A `tl_test_` key can no longer decide a proposal that names no use case.**
  Closed-catalog credential issuance and revocation (`issue-credential`,
  `revoke-credential`), an org capability change and an unscoped onboarding all
  carry `useCaseKey: null`, and the gate read that as "nothing to compare" —
  so approving one **executed** it, including real writes to the platform's
  on-chain registry. An unresolvable target now reads as **live**, matching what
  the gate has always done everywhere else. `GET /proposals` narrows the same
  way, so a test key no longer sees those rows or their `payload` at all.
  A revocation of a genuinely *sandbox* credential is still approvable by a test
  key: it now resolves through the credential's own use case.

- **`POST /credentials/requests` refuses a `tl_test_` key with 403
  `WRONG_MODE`.** The closed catalog has no sandbox variant, so this is a
  refusal at the door rather than a proposal that could be drafted and never
  approved.

- **Verification requests are mode-scoped on every route, not only creation.**
  Reading, consenting, rejecting and verifying now answer 404 for a request
  belonging to the other environment. `/verify` in particular is a one-way
  transition that stamps a result on the row, so a sandbox key reaching it would
  have decided a live verification.

- **`POST /users/{id}/revoke-identity`** is gated for the same reason: its
  executor revokes every credential the subject holds.

---

## Unreleased — a sandbox act never touches a chain (EN-D2)

Sandbox mode lets you exercise the platform with a `tl_test_` key against
`sandbox: true` use cases. Its whole promise is that nothing you do there is
real. A walkthrough against a real network showed that promise was not being
kept for credentials: a sandbox issuance was anchoring in the platform's
on-chain VC registry — a real transaction, real gas — because anchoring goes to
the platform registry rather than to the use case's own chain, and nothing on
that path consulted the sandbox flag. It does now.

- **A sandbox credential is not anchored, and never will be.** Issuing and
  revoking in a sandbox use case writes nothing to any chain. `anchorTxHash`,
  `anchorChainId` and `revokeTxHash` on the credential reflect that:
  `anchorChainId` reads `"sandbox"` and the two tx hashes stay `null`.
  Live issuance and revocation are unchanged — they still anchor.

- **`GET /credentials/:id/status` has a third `source`: `"sandbox"`,** alongside
  a new `sandbox: true` boolean. Additive; no existing field changed. Read it as
  "unanchored **by design**" — deliberately distinct from `"database"`, which
  also covers an anchor that was meant to land and did not. If your verifier
  requires on-chain proof it already requires `source === "chain"` and is
  unaffected. A verifier that treated everything-not-`"chain"` as one bucket
  still behaves correctly.

- **An organization created by `POST /credential-use-cases/provision` with
  `sandbox: true` has an unregistered DID.** Provisioning still creates it and
  still returns 201 — nothing about the call changed — but registering a DID on
  the platform's on-chain registry is a real transaction, so a sandbox
  provision does not make one. The organization is otherwise entirely real: it
  signs credentials, it owns programmes, it appears in every list. What it lacks
  is the public on-chain claim to its DID, so `GET /dids/{did}/resolve` reports
  `registered: false`, and a third-party verifier that requires on-chain issuer
  trust will not trust it **yet**. The first LIVE provision naming that same
  organization registers the DID. Organizations created any other way
  (`POST /orgs`, KYB approval, self-registration) are unaffected.

- **`proposal.executed` for a sandbox proposal is now `mode: "test"`.** It was
  `"live"`, because a credential-use-case proposal is org-scoped and names its
  programme only inside its payload. Consequences of the old behaviour: the
  event was delivered to your **production** webhook endpoints, and the
  `tl_test_` key that drafted the proposal could not read its own approval back
  from `GET /events`. If you have a live endpoint that was receiving these, it
  will stop; subscribe a `test` endpoint instead. Live proposals are unchanged.

---

## Unreleased — proposal reads: a null key stops being `""`, and the listing narrows

Two fixes to `Proposal`, both visible to anyone reading proposals.

- **ACTION REQUIRED if you match on `useCaseKey === ""`.** A proposal that belongs
  to an organization rather than a use case — the credential and governance
  kinds, and a mixed-desk onboarding batch — has no use-case key, and the 202
  body that creates one has always said `null`. `GET /proposals` and the
  approve/reject response said **`""`** for the same proposal: the component
  declared the field as a non-nullable string, and the serializer coerces null to
  the empty string for one of those. All three surfaces now say `null`.

  If you branch on `if (p.useCaseKey)` nothing changes — both values are falsy.
  If you compare against `""`, that comparison stops matching. Note that this is
  a change to a *value*, not to the surface projection, so it does **not** appear
  in `openapi.snapshot.json`, which records field names and shapes and not
  nullability.

  `orgId` is now declared on the component as well. It was already on the wire
  and its value is unchanged; only the documentation was missing.

- **`GET /proposals` returns fewer rows to callers who were never approvers.** The
  listing narrowed by index — every proposal at your desk, every proposal of your
  org — while each proposal kind admits a much narrower audience: `onboard-user`
  only a UseCaseAdmin of that desk, the credential and governance kinds only an
  OrgAdmin of that organization. So an Issuer, Trader, Auditor or Holder could
  list proposals whose approval answered 404, and whose `payload` carries the
  subject's KYC details. The listing now applies the same visibility rule the
  fetch and decide paths already applied.

  Nothing you could act on has been removed: every row that disappears is one
  whose `POST /proposals/{id}/approve` already answered `404`. Token-operation
  proposals (mint, transfer, burn, freeze, cashflow) are unaffected — they remain
  visible to everyone scoped to the use case. A PlatformAdmin still sees every
  kind. For a key principal the scope filter is unchanged and this check is
  additional.

---

## Unreleased — documentation corrections (EN-D1)

No behaviour changed. The **document** changed, and in one place it had been
telling you something false.

- **`bearerFormat: "JWT"` was declared for all access.** The document described a
  single credential, `bearerAuth`, with `bearerFormat: JWT`. That is correct for
  a human session token from `POST /auth/login`, and **wrong for an organization
  API key**: `tl_live_…` values are opaque secrets. There is no payload to
  decode, no expiry to read out of them, and no claims inside. If you wrote code
  that base64-decodes a key, or that reads an expiry from one to decide when to
  rotate, that code was never going to work — the document told you it would.

  There are now two schemes. `bearerAuth` (human session JWT) keeps
  `bearerFormat: JWT`. `apiKeyAuth` (org API key) deliberately declares **no**
  `bearerFormat`. Both still travel in the same `Authorization: Bearer …` header.

- **Per-route credentials are now documented.** Previously every route advertised
  `bearerAuth` alone, so the document said machine access did not exist while the
  server was serving it. Each route now advertises the credentials it actually
  accepts, and every key-callable route names the scope it requires in its
  description. These are now checked against the server's own scope gate on every
  build, so the document cannot silently drift from it again.

- **Response shapes are documented.** Most routes previously published "returns an
  object" and named no field. The integration surface now enumerates what it
  returns. This was additive only — no response schema was narrowed, and that is
  enforced by a test, because narrowing one would silently strip fields from live
  responses.

- **Tags, version, server.** All 23 tag groups are described (API Keys, Webhooks,
  Credentials and Verification previously rendered ungrouped); `info.version` is
  read from the package rather than frozen at `1.0.0`; the document now carries a
  `servers` entry, so generated clients and the "Try it" button have a base URL.

- **`/docs` and `/openapi.json` now exist in production**, behind a session or an
  API key. Previously they were registered only outside production, so a
  production deployment answered 404. If you were relying on that 404 as a
  signal, it is now a 401 for an anonymous caller.

  **`/docs` is not browser-usable in production, and that is not a bug.** The
  gate is *header* authentication — `Authorization: Bearer …` — and a browser
  navigating to a URL cannot send one, so Swagger UI in production answers 401
  to the page load and never gets as far as rendering. Nothing is going to make
  it work short of a cookie session we deliberately do not have. Use one of:

  - **the in-app reference** (console → Developers → Reference), which is the
    product here: it fetches `/openapi.json` with the session you are already
    signed in with, and adds the per-route credential-and-scope line the raw
    document has no field for;
  - **`GET /openapi.json` directly**, with a session token or an API key, and
    point your own tooling at it.

  The route stays registered so an authenticated *tool* — one that does send the
  header — gets the UI rather than a 404, and so the production and development
  surfaces do not differ in shape. What changed alongside this note: the strict
  `Content-Security-Policy` is no longer skipped for `/docs` **in production**.
  It was skipped because Swagger UI needs a relaxed policy, which is true only
  where Swagger UI can actually run.

- **Try it is refused on one GET.** The reference's read-only "Try it" button is
  offered on GET routes. `GET /verification-requests/{id}/verify` is a GET that
  *mutates*: it consumes the request, writes an entry to the append-only audit
  chain, and delivers a `verification.completed` event to every webhook endpoint
  your organization has registered. It now gets the copyable `curl` and a stated
  reason instead of a button. **This changes nothing about the API** — the route,
  its credentials and its behaviour are unchanged; only the documentation page
  stopped offering to fire it for you.

---

## 2026-08-09 — Webhooks & events (EN-C)

Merge `b2555b0`. You no longer have to poll. The platform records what happened
in a durable, globally ordered event log and pushes it to your endpoints.

**New endpoints** (all org-scoped; `:id` is your organization id):

| Method | Path | Scope |
|---|---|---|
| `POST` | `/orgs/:id/webhooks` | `webhooks:write` |
| `GET` | `/orgs/:id/webhooks` | `webhooks:read` |
| `PATCH` | `/orgs/:id/webhooks/:whId` | `webhooks:write` |
| `POST` | `/orgs/:id/webhooks/:whId/rotate` | `webhooks:write` |
| `DELETE` | `/orgs/:id/webhooks/:whId` | `webhooks:write` |
| `POST` | `/orgs/:id/webhooks/:whId/test` | `webhooks:write` |
| `GET` | `/orgs/:id/webhooks/:whId/deliveries` | `webhooks:read` |
| `POST` | `/orgs/:id/webhooks/:whId/deliveries/:dId/replay` | `webhooks:write` |
| `GET` | `/events?after=<seq>` | `webhooks:read` |

Two new API-key scopes, `webhooks:read` and `webhooks:write`. They are split so
that an integration which only consumes the cursor cannot rotate a signing secret
or repoint a delivery URL. **Keys minted before this release do not carry them** —
mint or rotate a key with the scopes you need.

### Verifying a delivery

Every delivery carries these headers:

```
Tokenlayer-Event-Id:    <cuid>     the stable event id — dedupe on this
Tokenlayer-Delivery-Id: <cuid>     this attempt chain
Tokenlayer-Event-Type:  asset.issued
Tokenlayer-Signature:   t=<unix-seconds>,v1=<hex hmac-sha256>
```

`v1` is `HMAC-SHA256(secret, "<t>.<raw request body>")`, hex-encoded.

**Verify over the RAW body — the exact bytes you received.** If your framework
parses JSON and you re-serialize it to check the signature, key order or number
formatting will differ and every delivery will fail verification. Capture the raw
body before parsing.

Parse the header **by parameter name, not by position**: `v1=` is a version
prefix, and a future scheme may add parameters. Ignore ones you do not know.

Check that `t` is within your tolerance of now (we use 300 seconds, a clock-skew
budget). The timestamp is inside the signed material, so it cannot be re-stamped
by an attacker who captured a delivery — but a captured delivery **can** be
replayed verbatim inside that window, which is why the next point matters.

The signing secret is returned **once**, in the response to create or rotate. It
is never retrievable afterwards. Store it before you acknowledge the call.

### Delivery semantics — read this before you write your handler

- **At least once, not exactly once.** Deduplicate on `Tokenlayer-Event-Id` and
  make your handler idempotent. Verify the signature *first*, then ignore an id
  you have already processed.
- **Ordering is not guaranteed.** Deliveries are retried independently, so a
  later event can arrive before an earlier one. If you need order, sort by the
  `seq` in the payload, or reconcile from `GET /events?after=`.
- Respond **2xx** to acknowledge. Anything else — including a 3xx redirect — is
  a failed attempt. Retries back off at roughly 30s, 2m, 10m, 1h, 6h (6 attempts
  total), then the delivery is dead-lettered and visible in the deliveries list.
- An endpoint that keeps failing is auto-disabled and says so; re-enable it with
  `PATCH`.

### The payload and the cursor

The delivery body is the event itself:
`{ id, seq, type, occurredAt, orgId, useCaseKey, subjectId, data }`.

`GET /events?after=<seq>` returns `{ events, nextAfter }` — pass `nextAfter` back
as `after` to advance. It is the recovery path for anything you missed while
offline, and it is org-grained: you see your organization's events, including
those of use cases you cannot otherwise read. `seq` is a global counter, so the
gaps between your own rows are not an error — they are other tenants' events,
which you never see.

v1 event types: `credential.issued`, `credential.accepted`, `credential.rejected`,
`credential.revoked`, `verification.requested`, `verification.completed`,
`asset.issued`, `asset.transferred`, `asset.redeemed`, `proposal.executed`.
Subscribe with `["*"]` or an explicit list; an unknown type is rejected at
registration with `400 UNKNOWN_EVENT_TYPE`, so a typo fails immediately rather
than silently never firing. Organization, membership and API-key governance
events are deliberately **not** in v1.

---

## 2026-08-09 — Org-scoped API keys (EN-B)

Merge `7aef94c`. Machine access, without a human password.

Before this release the only way in was `POST /auth/login` with a person's
credentials. Now an OrgAdmin can mint a key:

```
Authorization: Bearer tl_live_…
```

The value is an **opaque secret**. It is not a JWT: nothing in it is decodable,
there is no readable expiry, and it is shown exactly once at creation or
rotation — we store only a hash. If you lose it, rotate.

**Managing keys is a human act.** `POST /orgs/:id/api-keys`, its `…/rotate` and
`DELETE /orgs/:id/api-keys/:keyId` accept a **session only**; calling them with a
key returns `403 MACHINE_PRINCIPAL`. A key can never mint another key, which is
the one path that could widen access. Relatedly, the service user a key is bound
to cannot log in: `POST /auth/login` refuses it with `403 SERVICE_ACCOUNT`.

### ACTION REQUIRED — scopes gate READS, not just writes

This is the one that will surprise you. A key carries coarse scopes, and **reads
require a read scope**:

```
credentials:read   credentials:issue    credentials:revoke
verifications:read verifications:request verifications:verify
assets:read        assets:issue         assets:transfer
users:read         users:onboard
org:read
webhooks:read      webhooks:write        (added by EN-C)
usecases:provision
```

A key minted with `assets:issue` alone **cannot** call `GET /assets`,
`GET /assets/:id` or `GET /analytics`; it gets `403 INSUFFICIENT_SCOPE` with
`details: { required, granted }`. The same applies to `credentials:read`,
`users:read`, `org:read` and `verifications:read`. If you mint keys
least-privilege — and you should — enumerate the *reads* your integration makes,
not only its writes. `*` grants everything the bound service user is allowed.

*What was verified:* read-gating landed in commit `424f875` **on the EN-B branch
before it was merged** (merge `7aef94c`), so no released version of the API ever
served ungated reads to a key. Nothing broke retroactively. It is flagged here
because "scopes gate mutations" is the reasonable assumption, and acting on it
produces a key that 403s on its first `GET`. The published document now names the
required scope in each route's description, and `openapi.snapshot.json` records
it per route.

### Scopes can only narrow

Authorization is `role AND organization capability envelope AND key scope`. A
scope never grants anything the bound service user could not already do, so a
`credentials:issue` key attached to a user who may not issue still cannot issue.
Every check that applies to that person applies to the key: their role, their
organization's envelope (see EN-A), and maker-checker on anything that mutates.

Practical consequence: if a key returns `403` and the scope is right, look at the
service user's role and the organization's capabilities next.

### Other things to expect

- **Maker-checker still applies.** Most mutations answer **`202` with a
  proposal**, not with the object you asked to create. Read `proposal.id` and
  follow it to a terminal state. A checker can reject it, in which case the
  object never exists. Treating a 202 as a completed create is the most common
  mistake made against this API.
- **Rate limiting.** Per key, default 600 requests/minute, `429 RATE_LIMITED`
  with `Retry-After`. Honest limitation: the counter is per API instance, not
  cluster-wide.
- **Revocation is immediate**, and rotation kills the old secret at once.

---

## 2026-08-08 — Organization capability envelope (EN-A)

Merge `ddcced3`. Each organization now has an explicit, auditable grant of what
it may do: which **domains** it operates (`tokenization`, `identity`) and which
**operating roles** it plays (`Issuer`, `Holder`, `Verifier`).

An act outside that envelope is refused with **`403 ORG_CAPABILITY_MISSING`**,
and the message names the missing capability. It applies regardless of how
privileged the caller is — a PlatformAdmin acting for an org without the `Issuer`
role still cannot issue on its behalf. It is enforced at the existing gates
rather than by new middleware, so it applies uniformly to sessions and (since
EN-B) to API keys.

**Existing integrations were not affected.** An organization with no envelope has
`capabilities: null`, which means *unrestricted* — the two predicates that decide
every check return `true` for `null`
(`packages/core/src/org-capabilities.ts`). No data migration ran and no
organization was tightened by the release itself. An envelope arrives only when a
PlatformAdmin sets one, or when a new organization requests one at signup.

The one distinction worth knowing: **`[]` is not `null`.** An explicit empty
array is fully restrictive, not "unset". An org set to `roles: []` can do nothing
that needs an operating role.

Surface changes:

- `POST /orgs/register` accepts an optional `capabilities: { domains, roles }`.
  Absent means `null`, so older clients keep working unchanged. Unknown or
  duplicated entries are rejected with `INVALID_CAPABILITIES`.
- `PATCH /orgs/:id/capabilities` — PlatformAdmin only; sets or replaces the
  envelope directly, audited as `org-capabilities-set`.
- `POST /orgs/:id/capabilities/request` — an OrgAdmin asks for a different
  envelope; this creates a proposal (`202`) that a PlatformAdmin approves. The
  requester cannot approve their own.
- Organization responses now carry `capabilities`, and the login/session response
  carries `orgCapabilities`, so a client can hide what the org may not do rather
  than discovering it as a 403.

If you receive `403 ORG_CAPABILITY_MISSING`, no retry and no scope change will
help: the organization needs the capability granted.
