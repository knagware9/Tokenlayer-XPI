# Organization Branding (EN-E) — Design

**Goal:** Let an organization put its own logo and accent colour on the app its members use and on the certificates it issues, so the product reads as theirs rather than as ours with their name in a field.

**Program context:** The last piece of EN-A..F, the 2026-08-08 enterprise ask. EN-A gave organizations a capability envelope, EN-B org-scoped API keys, EN-C webhooks, EN-D1 the developer portal, EN-D2 sandbox mode, EN-F the certificate designer.

**Tech stack:** `apps/api` (two persisted columns, one route), `apps/web` (a Tailwind palette switched to CSS custom properties, the colour maths, a brand editor, and the shell that applies it), `packages/core` (the accent validator the API calls, and nothing more — see "How the accent works" for why the ramp deliberately does not live there). No new dependencies.

---

## Scope, and what is deliberately excluded

EN-E was recorded as three things. Only one of them is a project:

- **Organization branding** — does not exist at all. There is no logo, brand, theme or colour field anywhere in the Prisma schema. This spec.
- **Consistent empty/loading/error states** — mostly already done. `apps/web/src/components/ui.tsx` exports `Card`, `SectionHeader`, `Pill`, `StatCard`, `EmptyState`, `Skeleton`, and 16 components use `EmptyState`. **Eight still hand-roll a "No … yet" string** — find them with `grep -rl "No [a-z]* yet\|no [a-z]* found" apps/web/src/components/*.tsx` minus those already importing `EmptyState`; they adopt the primitive. A chore, folded in because it is an afternoon and closes the inconsistency for good.
- **A density/theming pass over all 45 components** — **excluded.** Unbounded, no persisted state, no customer-visible promise, and real regression risk across a UI that works. Not deferred pending anything; simply not worth doing.

## The brand

Two nullable columns on `Organization`:

```prisma
brandLogoDocumentId String?   // an image Document, same store as KYB docs and certificate artwork
brandAccent         String?   // #rrggbb
```

Null means today's appearance. **Every existing organization is unchanged and there is no migration** — the same shape that let EN-A's capability envelope ship without touching 420 tests.

These are persisted fields, so **THE PARITY RULE applies in full**: Prisma schema + `OrganizationRecord` + the prisma row type + the mapper + the create/update literals in **both** the memory and prisma repositories + `prisma generate`, all in ONE commit. The memory-harness tests cannot catch a prisma-side omission — that is the whole reason the rule exists.

## How the accent works, and why it is bounded

`apps/web/tailwind.config.js` currently hardcodes the palette:

```js
brand: { 50: "#e9f9f4", 100: "#cdeee6", 400: "#1AC8A9", 500: "#12b39a", 600: "#0E8C75", 700: "#0a6f5d" }
```

Each stop becomes `rgb(var(--brand-N) / <alpha-value>)`, with today's hexes moving to `:root` in `index.css` as the defaults. **Every existing `brand-*` class keeps working and not one component changes.** A branded organization's shell sets six custom properties on its root element and the whole application follows.

Six stops from one colour needs a ramp. Two pure functions carry the real logic:

```ts
brandRamp(accent: string): { 50: string; 100: string; 400: string; 500: string; 600: string; 700: string }
clampAccent(accent: string): string
```

`brandRamp` interpolates toward white for the light stops and toward black for the dark ones, so the scale stays monotonic in lightness — a scale that is not monotonic produces a hover state lighter than its rest state, which reads as a bug.

`clampAccent` darkens an accent until white text on it clears WCAG AA (contrast ≥ 4.5:1). **An organization must not be able to choose a colour that makes its own buttons unreadable**, and discovering that through a support ticket is worse than being quietly corrected. The clamp is applied at render, not at save: the stored value stays what the OrgAdmin chose, so the editor can show them their colour and the note that it was darkened for contrast.

**These two live in `apps/web/src/lib/branding.ts`, not in core**, and the split is deliberate. The accent never leaves the browser: the API stores a hex string, and the certificate PDF uses the LOGO, not the accent. So the ramp and the clamp are pure render concerns with exactly one consumer.

Putting them in core would create a third hand-copied mirror — the trap that has already cost this codebase two silent drifts and a pair of blank checkboxes. Core instead gets only what the API genuinely needs:

```ts
// packages/core/src/branding.ts
validateBrandAccent(value: unknown): string   // throws PolicyError("INVALID_BRAND_ACCENT")
```

One function, one caller, no vocabulary to keep in step.

## Who sets it

`PATCH /orgs/:id/branding` — body `{ brandLogoDocumentId?: string | null, brandAccent?: string | null }`, either field omitted meaning "leave alone" and explicit `null` meaning "clear".

**An OrgAdmin of that organization, or a PlatformAdmin.** Applied immediately, no approval queue. Branding is not a governance act: the certificate already carries the issuing organization's name and DID, and a logo confers no authority the organization did not have.

**Session-only — no API scope.** Branding is a console act by a human; no integration needs to automate it, and minting an `org:write` scope would invite keys to hold write access to organization identity. That means one justified row in `DELIBERATELY_UNSCOPED` with a written reason, which is that table's designed purpose and carries its own staleness check.

**The route needs an EXPLICIT ROLE PREDICATE, not `authScoped` alone.** `requireScope` short-circuits on `if (!key) return` — scopes narrow API keys, so for a human session `authScoped` gates authentication and nothing else. EN-F's final review proved the consequence on a route that had exactly this shape. The org-ownership check (`claims.orgId === :id`) matters just as much: a cross-tenant write here would let one organization rebrand another.

## Where it renders

**How the web learns the brand:** it rides on `GET /me`, beside `orgCapabilities`, which the session already loads at boot and refreshes through `refreshSession()`. An extra fetch on every page load to render a logo would be the wrong trade, and `/me` is already the place a session's org-derived facts live. `GET /orgs/:id` also returns the two fields, additively, for the editor. Both are schema ADDITIONS — `fast-json-stringify` strips undeclared response fields, so a field not added to the schema simply will not appear.

**The app shell**, for members of that organization only. A PlatformAdmin and a desk user with no `orgId` see the platform's own look — branding follows membership, not the page.

**Certificates the organization issues**, as the logo in the built-in layout. Precedence is **most-specific-wins**: a credential type's own `certificate.logoDocumentId` still beats the organization brand, so no already-configured certificate changes appearance. The organization brand is the default, not an override.

**In artwork mode the organization brand does not apply.** A customer who uploaded a full-page design already has their branding in it; stamping a second logo onto their artwork is the exact thing EN-F's "artwork replaces the layout" decision exists to prevent.

This does partly answer EN-F's finding 7: an organization can finally get its own mark onto its own certificates without a platform admin acting for them.

## Error handling

- **A missing or undecodable brand logo renders no logo** — never a broken image, never a failed certificate. Same posture as certificate artwork, and for the same reason: a deleted document must not break every certificate an organization has issued.
- **A malformed accent is rejected at the route** (400, naming the field), not silently corrected. The contrast clamp is a rendering decision; a value that is not a colour at all is an error the OrgAdmin should see.
- **A `brandLogoDocumentId` naming a document that is not an image** is rejected at save by checking the stored `contentType`. This is the cheap half of a gap EN-F's review flagged and left open, and it is worth taking here because this route is the one an OrgAdmin actually reaches.

## Testing

**core** — `validateBrandAccent` accepting `#0E8C75` and `#AABBCC`, rejecting `#abc`, `red`, `0E8C75` and a non-string.

**web (pure lib)** — `brandRamp` monotonicity across the six stops for a spread of hues including near-black and near-white inputs; `clampAccent` darkening a failing colour until it passes and leaving a passing one alone; hex validation rejecting `#abc`, `red`, and a missing hash.

**api** — parity: an organization round-trips both fields through the memory repo AND the prisma repo (the second is the one that silently drops); the route refuses an OrgAdmin of a *different* organization (the cross-tenant shape this program keeps finding), refuses a non-admin member, and accepts a PlatformAdmin; a non-image document id is refused; certificate precedence — per-type logo beats org brand, org brand applies when the type has none, and **artwork mode gets neither**.

**web** — the shell sets custom properties for a branded organization and leaves them at their defaults otherwise; the eight adopted `EmptyState` call sites still render their message.

**Browser pass** — a real logo and a real accent on a real organization: the shell, then a certificate PDF carrying that logo, then a second organization confirming its shell is untouched.

Then the final whole-branch review, which hunts independently.

## Coordination note

A separate session is implementing **organization self-service certificate artwork** (spawned from EN-F's finding 7). It touches `apps/api/src/http/routes.ts` around the credential-use-case routes, and may extend `CertificateConfig` validation. EN-E touches `routes.ts` around the organization routes, the `Organization` model, and the certificate renderer's logo resolution.

The overlap is `routes.ts` and the certificate logo path. **Let that work land first, or rebase onto it before the browser pass**, so the certificate precedence rule is verified against the code that will actually ship. This is the same hazard EN-D2 recorded against three concurrent sessions, and it was real then.

## Alternatives considered

- **A full overridable palette** (background, surface, text, accent) — genuinely white-label, and it is the excluded 45-component theming pass under another name, with every combination a contrast bug we would own.
- **Logo only** — zero theming risk, and the shell still reads as our product with their mark in the corner, which is the thing an enterprise buyer notices.
- **A PlatformAdmin approval queue for brand assets** — strongest against a logo that impersonates the platform or another company, and it puts a human in the loop on every cosmetic change forever. Rejected because the certificate already names its issuer, so the logo adds no authority.
- **Storing the clamped accent** instead of the chosen one — simpler render path, and the OrgAdmin's colour picker would then disagree with what they saved, which reads as the product losing their input.
