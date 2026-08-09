# Developer Portal & API Documentation (EN-D1) — Design

**Goal:** Turn an auto-generated OpenAPI dump into documentation an integrator can build against — correct about how to authenticate, honest about what each route returns, grouped and described, with three runnable integration guides and an in-app reference. **And make the documentation verifiable against the enforcement**, so it cannot quietly become wrong.

**Program context:** EN-A gave orgs a capability envelope. EN-B added org-scoped API keys so an external system can call in. EN-C added signed webhooks and a durable event log so the platform calls out. Those three built a real integration surface; nobody has yet written down how to use it. EN-D1 does that. **EN-D2 (sandbox / test mode) is a separate spec** — it changes where writes land, and it deserves its own review.

**Tech stack:** apps/api (OpenAPI configuration extracted from `app.ts`, additive response documentation in `schemas.ts`, a contract test suite, a committed spec snapshot), apps/web (a tabbed Developers surface: Overview · API keys · Webhooks · Reference · Guides). No new runtime dependency — `@fastify/swagger` and `@fastify/swagger-ui` are already installed.

---

## What is actually wrong today

The document exists and is served (`/openapi.json`, Swagger UI at `/docs`), covering 121 routes. Its problems are not cosmetic:

| Problem | Evidence | Consequence for an integrator |
|---|---|---|
| **The security scheme is wrong** | one scheme, `bearerAuth` with `bearerFormat: "JWT"` | The document tells them to send a JWT. EN-B keys are opaque `tl_live_…` strings, not JWTs. The single most important fact about machine access is misstated. |
| **No route says whether a key may call it** | every route shares one `security: bearer` const | "Can my integration call this?" is unanswerable from the docs, though the server knows exactly — `authScoped(scope)` decides it. |
| **Responses are opaque** | 153 `additionalProperties: true`, 120 response blocks | The reference says "returns an object" and names no field. |
| **No examples** | zero `example` keys | Nothing copyable. |
| **Almost no prose** | 16 `description` keys across 121 routes | Summaries only. |
| **17 of 23 tags undescribed** | `tags:` lists 6; schemas use 23 | Webhooks, API Keys, Credentials, Verification all appear ungrouped and unexplained. |
| **Version is a lie** | `info.version: "1.0.0"`, unchanged across EN-A/B/C | No way to tell which surface you are reading. |

## The organising idea: documentation verified against enforcement

Documentation drifts because nothing fails when it lies. This platform already has the mechanism to prevent that — EN-B's `scope-coverage.test.ts` made every route declare a scope or justify itself, and that test has since caught real holes. EN-D1 applies the same discipline to the docs:

**Every route's documented security is checked against the gate that actually runs.** `authScoped("credentials:issue")` means the route is callable by a key holding that scope; `...auth` alone means a human session only. That mapping is already machine-readable, so the contract test asserts the OpenAPI `security` block on each route matches it — including the scope name in the description. A route that changes from human-only to key-callable, and does not update its documentation, fails the build.

This is the difference between docs that are *currently accurate* and docs that *cannot become wrong*.

## Scope of change, by piece

### 1. `apps/api/src/http/openapi.ts` — the configuration, extracted

`app.ts` keeps a one-line registration; the document's content moves to its own module so it is reviewable and testable.

- **Two security schemes.** `bearerAuth` (`http`/`bearer`, `bearerFormat: "JWT"`) for human sessions, and `apiKeyAuth` (`http`/`bearer`, no `bearerFormat`) for `tl_live_…` keys, with a description stating the key is opaque, is sent as `Authorization: Bearer`, and that scopes only ever narrow what the bound service user could already do.
- **All 23 tags described**, in a deliberate order: the integration surface first (Auth, API Keys, Webhooks, Credentials, Credential Use Cases, Verification, Assets, Use Cases), then platform administration, then internal.
- **`info.version` read from `apps/api/package.json`**, not a literal, so it moves when the package does.
- **`info.description`** rewritten to say what the API is *now* — two domains, maker-checker on mutations, capability envelopes, machine keys, webhooks — and to link the three guides.
- **A `servers` block** so the reference shows a real base URL (`publicApiUrl`), rather than implying a path-relative one.

### 2. Response documentation, additively

The rule, and the reason it is not negotiable: **`fast-json-stringify` silently strips undeclared fields.** Declaring a response's `properties` while keeping `additionalProperties: true` documents the shape and provably cannot change what is serialized. Removing `additionalProperties: true` would turn a documentation task into a live-behaviour change across 120 routes, where every forgotten field vanishes from a production response. We do the additive half only.

Priority is the **integration surface** — the tags an external system actually calls: Auth, API Keys, Webhooks, Credentials, Credential Use Cases, Verification, Assets, Users, Organizations, Proposals, Config, Catalog. Governance and internal routes get a `description` but need not enumerate fields.

The contract test enforces this: every route under an integration-surface tag must declare at least one response property, or appear in a `DOCUMENTATION_DEFERRED` table with a written reason — the same shape as `DELIBERATELY_UNSCOPED`.

**The 202 problem gets its own treatment.** Almost every mutation on this platform returns `202` with a proposal, not the created object — maker-checker is the single most confusing thing about this API for a newcomer. Every route that can 202 documents both shapes and says plainly that the operation has *not* happened yet.

### 3. A committed OpenAPI snapshot

`apps/api/openapi.snapshot.json`, regenerated by a test that fails with instructions when the surface changes. This does not prevent change; it makes change **visible in a diff during review**, which is the only reliable way to notice that a route quietly became public, a scope moved, or a response field disappeared. It is the docs equivalent of the audit chain.

### 4. `docs/api/CHANGELOG.md`

Human-written, one entry per release, recording what an integrator must do differently. Seeded with the surface EN-A, EN-B and EN-C introduced.

### 5. The three guides

Written as content in the web app (so they render in the portal) and mirrored in `docs/api/guides/` for anyone reading the repo. Each is runnable start to finish with copyable calls against a real deployment.

- **Issue and verify a credential** — mint a key, provision or pick a credential use case, draft an issuance (202), approve it, watch the holder accept, run a verification, read the result. This is the guide that has to teach maker-checker properly.
- **Tokenize and transfer an asset** — configure a use case, issue, transfer, read holders and the audit trail.
- **Receive and verify webhooks** — register an endpoint, verify a signature over the raw bytes, handle at-least-once and out-of-order delivery, recover a missed window with `GET /events?after=`.

Each guide states its prerequisites (which scopes, which capabilities the org needs) up front, because a 403 twenty minutes in is the worst way to learn you needed `credentials:issue`.

### 6. The in-app portal

Developers becomes a **tabbed surface**: Overview · API keys · Webhooks · Reference · Guides. Tabs, not a new nav item, so there is no new domain classification to get wrong — the ID-N self-lockout came from exactly that, an item classified into a domain and vanishing along with the control that could fix it.

- **Reference** renders from `/openapi.json`: grouped by tag, each route showing method, path, summary, description, parameters, request body, response shapes, and — prominently — **which credentials may call it and which scope is required**. Not Swagger UI: it is a megabyte, looks nothing like the app, and cannot show the scope information that matters most here.
- **Guides** renders the three walkthroughs with copy buttons on every call.

### Try-it: reads only, and why

The Reference gets a **Try it** control on `GET` routes only, executing with the signed-in session and showing the real response.

Mutating routes show a copyable `curl` instead. A one-click button that issues a credential, transfers tokens, or onboards a user against **live** data is a footgun in a documentation surface — the user is there to read, not to act, and 202-returning routes would additionally leave real proposals in a real approval queue. Interactive mutation belongs with **EN-D2's sandbox**, where a test key writes to a mock ledger and nothing durable happens. The UI says so, rather than silently omitting the button.

## Error handling

- `/openapi.json` unreachable or malformed → the Reference tab shows a clear failure with a retry, never a blank pane.
- A route present in the spec but absent from the tag map → the contract test fails; the UI groups it under "Other" rather than dropping it, so a rendering gap can never hide a route.
- Try-it on a route the caller's role cannot reach → render the real 403 including `ORG_CAPABILITY_MISSING` or `INSUFFICIENT_SCOPE` details. Seeing the actual refusal is more instructive than a disabled button.

## Testing

- **Contract (`apps/api/test/openapi-contract.test.ts`)** — the substance of this sub-project:
  - every tag used in `schemas.ts` has a description in `openapi.ts`;
  - every route's documented `security` matches its actual gate: `authScoped(scope)` → both schemes, with the scope named; `...auth` → `bearerAuth` only; unauthenticated → none. Derived from the same source `scope-coverage.test.ts` parses, so the two cannot disagree;
  - every integration-surface route declares at least one response property or is listed in `DOCUMENTATION_DEFERRED` with a reason;
  - every route that can return 202 documents the proposal shape;
  - the generated document matches `openapi.snapshot.json`, with a failure message saying how to update it.
- **Additivity proof** — a test asserting no response schema lost `additionalProperties: true` in this branch. This is the guarantee that documentation did not change behaviour; without it the claim is decoration.
- **Web** — the Reference groups every route the spec contains (none dropped); Try-it is offered on GET and withheld elsewhere; guides render with working copy actions.
- **Live walkthrough** — follow each of the three guides verbatim against a live Besu deployment, as an integrator would, and confirm every documented call behaves as written. A guide is only true if someone has run it.

## Verification / done

Full core + api + web suites, both builds, the contract suite green, the three guides executed end to end against live Besu, a browser pass on the portal, then the final whole-branch review — which, per EN-A, EN-B and EN-C, hunts independently rather than re-checking this document's list. Then finish the branch (`feat/developer-portal` → main).

## Alternatives considered

- **Embed Swagger UI in-app** — free, but it is a megabyte of third-party UI that looks nothing like the product and cannot surface the scope-and-credential information that is the most useful thing we know about each route. Keeping it at `/docs` for raw inspection costs nothing.
- **Strict response schemas with validation** — a stronger long-term guarantee, but it changes what 120 live routes serialize, and fast-json-stringify's silent stripping means the failure mode is a field disappearing in production with nothing raising an error. Rejected for this sub-project; revisit deliberately, route by route, if response validation is wanted for its own sake.
- **A public documentation site** — better for evaluation before signup, but it publishes the complete surface including governance and org management. Revisit when there is a reason to court unauthenticated readers.
- **Hand-written reference instead of generated** — prettier, and wrong within a release. Generation plus a snapshot keeps it honest.
- **Examples recorded from live traffic** — attractive, but they encode real ids and real payloads, and the redaction burden is the same class of problem EN-C's payload redaction solved. Hand-written examples in guides, verified by running them, are safer.
