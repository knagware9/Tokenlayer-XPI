# Developer Portal & API Documentation (EN-D1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the auto-generated OpenAPI dump into documentation an integrator can build against — correct about authentication, honest about responses, grouped and described — plus three runnable guides and an in-app reference, with the documentation *verified against the enforcement* so it cannot quietly go wrong.

**Architecture:** The OpenAPI configuration moves out of `app.ts` into its own module with two security schemes and all 23 tags. Per-route security is declared in `schemas.ts` and **cross-checked against the `authScoped(...)` gate in `routes.ts`** by a contract test that extends the parser `scope-coverage.test.ts` already uses. Response documentation is additive only. The web app gains a tabbed Developers surface with a reference rendered from `/openapi.json` and three guides.

**Tech Stack:** apps/api (Fastify + `@fastify/swagger`, already installed), apps/web (React + Vite), vitest.

**Spec:** `docs/superpowers/specs/2026-08-09-developer-portal-design.md`

---

## Ground rules for every task

1. **No existing behavioural test may be edited.** The suite is the back-compat oracle (599 api / 248 core / 31 web). If one genuinely encodes a bug, say so with the name and reason rather than changing it quietly.
2. **Mutation-check every guard you add.** Break it, confirm a *named* test fails, restore. Report each. If a mutation survives, the test was passing for the wrong reason — strengthen it and say so. On EN-C this happened three times.
3. **THE ADDITIVITY RULE — the one that matters most here.** `fast-json-stringify` **silently strips undeclared response fields**. You may ADD `properties` to a response schema. You may never remove `additionalProperties: true`, and you may never narrow an existing schema. A documentation task must not change a byte of what the API serializes. Task D1-3 adds a test that enforces this mechanically.
4. **No test directory in this repo is typechecked** (`"include": ["src"]`, vitest runs no typecheck) — a `@ts-expect-error` in a test file is inert, never treat one as evidence.
5. **Never touch `apps/api/prisma/dev.db*`.** Throwaway DBs are `apps/api/prisma/dev-<name>.db`, deleted after use. Kill APIs by port (`lsof -ti tcp:4000 | xargs kill -9`), never `pkill`.
6. Run the api suite **once with `apps/api/.env` moved aside** before claiming it green — EN-C shipped 16 tests that silently did not collect without it.

## File Structure

**Create**
| File | Responsibility |
|---|---|
| `apps/api/src/http/openapi.ts` | The document's identity: info, version, servers, security schemes, tag descriptions. No route knowledge. |
| `apps/api/test/openapi-contract.test.ts` | Tag coverage · security-vs-gate consistency · response documentation coverage · additivity · snapshot. |
| `apps/api/openapi.snapshot.json` | Committed public-surface snapshot, so a surface change is visible in review. |
| `docs/api/CHANGELOG.md` | What an integrator must do differently, per release. |
| `docs/api/guides/{issue-a-credential,tokenize-an-asset,receive-webhooks}.md` | The three guides, repo-readable. |
| `apps/web/src/components/ApiReference.tsx` | Renders `/openapi.json` grouped by tag, with credential + scope per route, and GET-only Try it. |
| `apps/web/src/components/Guides.tsx` | Renders the three guides with copy buttons. |
| `apps/web/src/lib/openapi.ts` | Pure helpers: group by tag, derive the credential/scope line, decide Try-it eligibility. |
| `apps/web/test/openapi-view.test.ts` | Tests for those pure helpers. |

**Modify**
| File | Change |
|---|---|
| `apps/api/src/app.ts` | Register swagger unconditionally; gate `/openapi.json` + `/docs` behind auth in production |
| `apps/api/src/http/schemas.ts` | Two security constants + per-route security + additive response properties |
| `apps/api/test/scope-coverage.test.ts` | Export its route parser so the contract test reuses one parser, not two |
| `apps/web/src/components/Developers.tsx` | Becomes a tabbed shell |

---

## Task D1-1: The OpenAPI document's identity

**Files:** Create `apps/api/src/http/openapi.ts`; modify `apps/api/src/app.ts`; test in `apps/api/test/openapi-contract.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";

describe("the OpenAPI document's identity", () => {
  it("declares BOTH credentials, and does not call an API key a JWT", async () => {
    const app = await buildTestApp();
    const doc = app.swagger() as { components: { securitySchemes: Record<string, { scheme: string; bearerFormat?: string; description?: string }> } };
    const s = doc.components.securitySchemes;

    expect(s.bearerAuth).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    // An API key is an OPAQUE string. Declaring bearerFormat JWT here is what
    // the document did before EN-D1, and it is the single most misleading
    // thing a machine integrator could read.
    expect(s.apiKeyAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(s.apiKeyAuth.bearerFormat).toBeUndefined();
    expect(s.apiKeyAuth.description).toMatch(/tl_live_/);
    expect(s.apiKeyAuth.description).toMatch(/narrow/i); // scopes only narrow
  });

  it("describes EVERY tag any route actually uses", async () => {
    const app = await buildTestApp();
    const doc = app.swagger() as { tags?: { name: string }[]; paths: Record<string, Record<string, { tags?: string[] }>> };
    const used = new Set<string>();
    for (const ops of Object.values(doc.paths)) for (const op of Object.values(ops)) for (const t of op.tags ?? []) used.add(t);
    const described = new Set((doc.tags ?? []).map((t) => t.name));
    const missing = [...used].filter((t) => !described.has(t)).sort();
    expect(missing, `tags used by routes but never described: ${missing.join(", ")}`).toEqual([]);
  });

  it("reports the package version, not a frozen literal", async () => {
    const app = await buildTestApp();
    const doc = app.swagger() as { info: { version: string }; servers?: { url: string }[] };
    expect(doc.info.version).not.toBe("1.0.0");
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(doc.servers?.[0]?.url).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

```bash
pnpm --filter @tokenlayer/api test -- --run openapi-contract --testTimeout=180000
```

Expected: FAIL — `apiKeyAuth` undefined, 17 tags missing, version is `1.0.0`.

- [ ] **Step 3: Write `apps/api/src/http/openapi.ts`**

```ts
/**
 * The OpenAPI document's IDENTITY — who the API is, how you authenticate, and
 * what the tag groups mean. Route-level truth lives in schemas.ts; this file
 * knows nothing about individual routes.
 *
 * TWO CREDENTIALS, and the distinction is the whole point of EN-B: a human
 * session presents a JWT, a machine presents an OPAQUE `tl_live_…` key. Before
 * EN-D1 this document declared one scheme, `bearerFormat: "JWT"`, which told
 * every integrator the wrong thing about the only credential they would use.
 */
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

export const securitySchemes = {
  bearerAuth: {
    type: "http", scheme: "bearer", bearerFormat: "JWT",
    description: "A human session token from POST /auth/login. Service accounts cannot log in.",
  },
  apiKeyAuth: {
    type: "http", scheme: "bearer",
    // No bearerFormat: the value is opaque, not a JWT.
    description:
      "An organization API key, sent as `Authorization: Bearer tl_live_…`. The key authenticates as its bound " +
      "service user, so the user's role, the organization's capability envelope and maker-checker all still apply. " +
      "Scopes only ever NARROW what that user could already do — a scope can never grant authority the role lacks.",
  },
} as const;

/** Integration surface first, then administration, then internal. */
export const tags = [
  { name: "Auth", description: "Obtaining and using a credential." },
  { name: "API Keys", description: "Machine credentials: mint, rotate and revoke org-scoped keys." },
  { name: "Webhooks", description: "Register endpoints, inspect deliveries, and read the durable event log." },
  { name: "Credentials", description: "Issue, accept, revoke and publicly verify verifiable credentials." },
  { name: "Credential Use Cases", description: "Configure credential programmes: types, claims, issuer and verifier policy." },
  { name: "Verification", description: "Ask a holder to present credentials and read the outcome." },
  { name: "Identity", description: "DIDs, device login keys and identity proofs." },
  { name: "Assets", description: "Tokenized asset issuance and queries." },
  { name: "Use Cases", description: "Low-code asset-type definitions and their deployed contracts." },
  { name: "Lifecycle", description: "Mint, transfer, burn, freeze and allow." },
  { name: "Marketplace", description: "Secondary-market listings and escrowed settlement." },
  { name: "Invoice Register", description: "Staged invoices imported from an ERP before tokenization." },
  { name: "Cashflows", description: "Scheduled coupon, redemption and settlement flows." },
  { name: "Proposals", description: "The maker-checker queue. Most mutations land here as a 202 before they happen." },
  { name: "Organizations", description: "Tenants: registration, approval, members and capability envelopes." },
  { name: "Users", description: "Scoped user provisioning and onboarding." },
  { name: "Documents", description: "Opaque document storage referenced by assets and KYB." },
  { name: "Audit", description: "The per-asset hash-chained audit trail and its on-chain anchors." },
  { name: "Analytics", description: "Cross-ledger aggregates." },
  { name: "Investor", description: "A holder's own portfolio and activity." },
  { name: "Cash", description: "Fiat and CBDC balances used for settlement." },
  { name: "Catalog", description: "Chains, currencies and accounts available to this deployment." },
  { name: "Config", description: "What this deployment has enabled." },
];

export function openapiConfig(publicApiUrl: string) {
  return {
    openapi: {
      info: {
        title: "XI Tokenize API",
        version: pkg.version,
        description:
          "Chain-agnostic tokenization and identity REST API.\n\n" +
          "**Two domains.** Tokenization (assets across ERC-20/721/3643 and Fabric) and Identity (W3C verifiable " +
          "credentials anchored on-chain).\n\n" +
          "**Most mutations return 202, not the created object.** They enter a maker-checker queue as a proposal " +
          "and happen on approval. Read the Proposals tag before assuming a 2xx means the work is done.\n\n" +
          "**Two credentials.** A human session JWT, or an organization API key (see Security). Every request is " +
          "additionally bounded by the organization's capability envelope.\n\n" +
          "Start with the guides in the in-app Developer portal: issue a credential, tokenize an asset, receive webhooks.",
      },
      servers: [{ url: publicApiUrl, description: "This deployment" }],
      components: { securitySchemes },
      tags,
    },
  };
}
```

- [ ] **Step 4: Register it unconditionally, and gate exposure instead**

In `apps/api/src/app.ts`, replace the `if (!deps.isProduction) { … }` block. The document must always be *generated* — the portal renders from it and the contract test reads it — but exposure stays controlled:

```ts
// The document is ALWAYS generated: the in-app Developer portal renders from
// it, and the contract test asserts it matches the gates that actually run.
// What changes in production is EXPOSURE. An unauthenticated spec is a recon
// aid; an authenticated one is the product. So outside production both stay
// open for convenience, and in production both require a session.
await app.register(swagger, openapiConfig(deps.publicApiUrl));
await app.register(swaggerUi, { routePrefix: "/docs" });

const specGuard = deps.isProduction ? { preHandler: principalOnly } : {};
app.get("/openapi.json", { schema: { hide: true }, ...specGuard }, async () => app.swagger());
```

`principalOnly` is the existing authentication preHandler with no scope gate. If wiring it at this point in `app.ts` is awkward (the guard lives in `routes.ts`), say so in your report and put the gate wherever the authentication seam is actually reachable — do not skip it and do not invent a second auth path.

Note the existing CSP hook already skips `/docs`; leave that alone.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @tokenlayer/api test -- --run openapi-contract --testTimeout=180000
```

Expected: PASS.

- [ ] **Step 6: Mutation-check**

Delete one tag from the `tags` array — the tag-coverage test must fail naming it. Restore. Set `apiKeyAuth.bearerFormat = "JWT"` — the first test must fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/openapi.ts apps/api/src/app.ts apps/api/test/openapi-contract.test.ts
git commit -m "feat(api): correct OpenAPI identity — two credentials, all tags, real version (EN-D1)"
```

---

## Task D1-2: Documentation verified against enforcement

**This is the centrepiece.** The server already knows which routes a key may call — `authScoped("credentials:issue")` says so. The document must say the same thing, and a test must make disagreement impossible.

**Files:** Modify `apps/api/test/scope-coverage.test.ts` (export the parser), `apps/api/src/http/schemas.ts`; extend `apps/api/test/openapi-contract.test.ts`.

- [ ] **Step 1: Export the existing parser**

`scope-coverage.test.ts` already parses `routes.ts`. Extend its regex to also capture the schema name and export the result, so **one parser** serves both tests:

```ts
/** `app.post("/path", { schema: S.name, ...authScoped("x") }` */
const ROUTE_RE = /app\.(get|post|put|patch|delete)\("([^"]+)",\s*\{([^}]*)\}/g;

export interface RouteDecl { method: string; path: string; scope: string | null; authed: boolean; schema: string | null }

export function declaredRoutes(): RouteDecl[] {
  const src = readFileSync(ROUTES_TS, "utf8");
  const out: RouteDecl[] = [];
  for (const m of src.matchAll(ROUTE_RE)) {
    const [, method, path, opts] = m as unknown as [string, string, string, string];
    out.push({
      method: method.toUpperCase(), path,
      scope: /\.\.\.authScoped\("([^"]+)"\)/.exec(opts)?.[1] ?? null,
      authed: opts.includes("...auth"),
      schema: /schema:\s*S\.(\w+)/.exec(opts)?.[1] ?? null,
    });
  }
  return out;
}
```

Keep every existing assertion in that file unchanged — you are exporting, not rewriting.

- [ ] **Step 2: Write the failing consistency test**

Add to `openapi-contract.test.ts`:

```ts
import { declaredRoutes } from "./scope-coverage.test.js";
import * as S from "../src/http/schemas.js";

/**
 * THE POINT OF THIS FILE. Documentation drifts because nothing fails when it
 * lies. `authScoped(scope)` already encodes exactly which routes an API key may
 * call and with which scope — so the document has no excuse for disagreeing.
 *
 * A route that becomes key-callable and does not update its documentation fails
 * here, the same way an ungated route fails scope-coverage.
 */
describe("documented security matches the gate that actually runs", () => {
  it("every scoped route documents BOTH credentials and names its scope", () => {
    const wrong: string[] = [];
    for (const r of declaredRoutes()) {
      if (!r.scope || !r.schema) continue;
      const schema = (S as Record<string, { security?: { bearerAuth?: unknown; apiKeyAuth?: unknown }[]; description?: string }>)[r.schema];
      const schemes = new Set((schema?.security ?? []).flatMap((s) => Object.keys(s)));
      if (!schemes.has("apiKeyAuth") || !schemes.has("bearerAuth")) {
        wrong.push(`${r.method} ${r.path} is authScoped("${r.scope}") but documents [${[...schemes].join(", ") || "nothing"}]`);
      } else if (!schema?.description?.includes(r.scope)) {
        wrong.push(`${r.method} ${r.path} requires "${r.scope}" but its description never says so`);
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("a human-only route does NOT advertise API-key access", () => {
    const wrong: string[] = [];
    for (const r of declaredRoutes()) {
      if (r.scope || !r.authed || !r.schema) continue;
      const schema = (S as Record<string, { security?: Record<string, unknown>[] }>)[r.schema];
      const schemes = new Set((schema?.security ?? []).flatMap((s) => Object.keys(s)));
      // A key CAN authenticate here, but the route either refuses machine
      // principals outright or is gated dynamically — see DELIBERATELY_UNSCOPED.
      // Advertising apiKeyAuth would promise an integrator something the server
      // may well refuse.
      if (schemes.has("apiKeyAuth")) wrong.push(`${r.method} ${r.path} advertises apiKeyAuth but carries no scope gate`);
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it, watch it fail**

Expected: FAIL, listing ~28 scoped routes that document only `bearerAuth`.

- [ ] **Step 4: Add the security constants and apply them**

In `schemas.ts`, alongside the existing `bearer` const:

```ts
/** A human session only. A key may authenticate but the route will refuse or re-gate it. */
const humanOnly = [{ bearerAuth: [] }];
/** Either credential. Use for any route carrying `authScoped(...)`. */
const eitherCredential = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
```

Then, for every route the test names: set `security: eitherCredential` and make the `description` state the scope in words an integrator can act on, e.g.

```ts
  issueUsecaseCredential: {
    tags: ["Credentials"],
    summary: "Draft an issuance for a configured credential type",
    description:
      "Requires the `credentials:issue` scope. Returns **202 with a proposal** — the credential is not issued " +
      "until a second authorized principal approves it (see Proposals). The approver needs the same scope.",
    security: eitherCredential,
    // …
  },
```

Leave unscoped routes on `humanOnly` (or no `security` for public ones).

- [ ] **Step 5: Run, then mutation-check**

Both tests must pass. Then:
1. Change one scoped route's `security` back to `humanOnly` — test 1 must fail naming that route.
2. Add `apiKeyAuth` to an unscoped route — test 2 must fail naming it.
3. Remove the scope name from one description — test 1 must fail on the description arm.

Report all three.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http/schemas.ts apps/api/test/scope-coverage.test.ts apps/api/test/openapi-contract.test.ts
git commit -m "feat(api): document per-route credentials, verified against the scope map (EN-D1)"
```

---

## Task D1-3: Response documentation, additively

**Files:** Modify `apps/api/src/http/schemas.ts`; extend `apps/api/test/openapi-contract.test.ts`.

- [ ] **Step 1: Write the additivity proof FIRST**

This test is the guarantee that a documentation task did not change behaviour. Write it before touching a schema.

```ts
/**
 * THE ADDITIVITY RULE. fast-json-stringify silently STRIPS undeclared response
 * fields, so narrowing a response schema does not fail a test — it deletes a
 * field from a live response and says nothing. EN-D1 may only ADD `properties`.
 *
 * `additionalProperties: true` is what keeps serialization unchanged, so this
 * test counts them and refuses a decrease. The number is a floor, not a target.
 */
const ADDITIVE_FLOOR = 153; // measured on main before EN-D1

it("never removes additionalProperties: true from a response schema", () => {
  const src = readFileSync(SCHEMAS_TS, "utf8");
  const count = (src.match(/additionalProperties:\s*true/g) ?? []).length;
  expect(count, "a response schema was narrowed — that STRIPS fields from live responses").toBeGreaterThanOrEqual(ADDITIVE_FLOOR);
});
```

- [ ] **Step 2: Write the coverage test**

```ts
/** The tags an external system actually calls. */
const INTEGRATION_SURFACE = new Set([
  "Auth", "API Keys", "Webhooks", "Credentials", "Credential Use Cases",
  "Verification", "Assets", "Users", "Organizations", "Proposals", "Config", "Catalog",
]);

/** Routes on the integration surface whose response is deliberately not enumerated. */
const DOCUMENTATION_DEFERRED: Record<string, string> = {
  "GET /documents/:id": "returns opaque bytes, not a JSON object",
};

it("every integration-surface route documents at least one response field", async () => {
  const app = await buildTestApp();
  const doc = app.swagger() as { paths: Record<string, Record<string, { tags?: string[]; responses?: Record<string, { content?: Record<string, { schema?: { properties?: object; $ref?: string } }> }> }>> };
  const undocumented: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!(op.tags ?? []).some((t) => INTEGRATION_SURFACE.has(t))) continue;
      const id = `${method.toUpperCase()} ${path}`;
      if (id in DOCUMENTATION_DEFERRED) continue;
      const ok = Object.entries(op.responses ?? {}).some(([code, r]) => {
        if (!code.startsWith("2")) return false;
        const schema = r.content?.["application/json"]?.schema;
        return !!schema && (!!schema.$ref || Object.keys(schema.properties ?? {}).length > 0);
      });
      if (!ok) undocumented.push(id);
    }
  }
  expect(undocumented, `integration-surface routes with an opaque response:\n${undocumented.join("\n")}`).toEqual([]);
});

it("every route that can 202 documents the proposal shape and says the work has not happened", async () => {
  const app = await buildTestApp();
  const doc = app.swagger() as { paths: Record<string, Record<string, { description?: string; responses?: Record<string, unknown> }>> };
  const bad: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!op.responses?.["202"]) continue;
      if (!/proposal/i.test(op.description ?? "")) bad.push(`${method.toUpperCase()} ${path}`);
    }
  }
  expect(bad, `202 routes that never mention the proposal:\n${bad.join("\n")}`).toEqual([]);
});
```

- [ ] **Step 3: Run, watch both coverage tests fail**

Expected: a long list of opaque responses. That list is your work queue.

- [ ] **Step 4: Document the responses**

For each named route, ADD a `properties` block describing the fields the route actually returns — read the route body in `routes.ts` to get this right; do not guess. Keep every `additionalProperties: true` exactly where it is. Prefer a `$ref` to an existing component in `components` when one fits, and add new components for shapes used more than twice (`ApiKeyView`, `WebhookEndpoint`, `WebhookDelivery`, `EventRecord`, `ProposalView`).

For the 202 routes, document both the 202 proposal shape and the eventual object, and say plainly in the description that the operation has not happened yet.

- [ ] **Step 5: Verify nothing changed on the wire**

The additivity test is the mechanical proof. Also run the whole suite: any response-shape change would break existing behavioural tests, which are the oracle.

```bash
pnpm --filter @tokenlayer/api test -- --run --testTimeout=180000
```

- [ ] **Step 6: Mutation-check**

1. Remove `additionalProperties: true` from one response schema → the additivity test must fail.
2. Delete the `properties` block you added to one integration-surface route → the coverage test must fail naming it.
3. Remove "proposal" from one 202 description → the 202 test must fail.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/schemas.ts apps/api/test/openapi-contract.test.ts
git commit -m "feat(api): document response shapes additively across the integration surface (EN-D1)"
```

---

## Task D1-4: The snapshot and the changelog

**Files:** Create `apps/api/openapi.snapshot.json`, `docs/api/CHANGELOG.md`; extend the contract test.

- [ ] **Step 1: Write the snapshot test**

```ts
/**
 * The public surface, committed. This does not PREVENT change — it makes change
 * visible in a diff during review, which is the only reliable way to notice
 * that a route quietly became public, a scope moved, or a response field
 * disappeared. Regenerate deliberately, and read the diff.
 */
const SNAPSHOT = fileURLToPath(new URL("../openapi.snapshot.json", import.meta.url));

it("matches the committed snapshot of the public surface", async () => {
  const app = await buildTestApp();
  const doc = app.swagger() as Record<string, unknown>;
  // Only the surface, not the prose: a description edit must not force a churn diff.
  const surface = Object.fromEntries(
    Object.entries((doc as { paths: Record<string, Record<string, { tags?: string[]; security?: unknown }>> }).paths)
      .map(([path, ops]) => [path, Object.fromEntries(Object.entries(ops).map(([m, op]) => [m, { tags: op.tags, security: op.security }]))]),
  );
  const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as unknown;
  expect(surface, "The public surface changed. If that is intended, regenerate:\n  pnpm --filter @tokenlayer/api openapi:snapshot\nand review the diff as part of your change.").toEqual(expected);
});
```

- [ ] **Step 2: Add the regeneration script**

In `apps/api/package.json`:

```json
"openapi:snapshot": "tsx scripts/write-openapi-snapshot.ts"
```

with a small script that builds the app, extracts the same surface projection, and writes it pretty-printed. **The projection must be shared with the test** — put it in one module both import, or the snapshot and the check will diverge, which is exactly the class of bug this branch exists to prevent.

- [ ] **Step 3: Generate, inspect, commit the snapshot**

Read the generated file before committing it. Every route in it should be one you expect to be public, and every `security` block should match what task D1-2 asserted.

- [ ] **Step 4: Write `docs/api/CHANGELOG.md`**

Seed it with the surface the enterprise program introduced, written for someone integrating — what changed, and what they must do:

```markdown
# XI Tokenize API — changelog

## Unreleased
- **Documentation**: every route now states which credential may call it and which scope it needs.
  The OpenAPI security scheme previously declared `bearerFormat: JWT` for all access; API keys are
  opaque strings and were never JWTs.

## EN-C — webhooks & events
- **Added** `POST/GET/PATCH/DELETE /orgs/:id/webhooks`, delivery inspection, replay, and `GET /events?after=`.
- **Added** scopes `webhooks:read`, `webhooks:write`.
- Deliveries are signed `t=<unix>,v1=<hmac>`; verify over the RAW body. At-least-once, order not guaranteed.

## EN-B — machine API access
- **Added** org-scoped API keys. `Authorization: Bearer tl_live_…`.
- Scopes only narrow what the bound service user could already do.
- **Behaviour change**: read routes are now scope-gated. A key needs `assets:read`, `credentials:read` etc.

## EN-A — organization capability envelope
- **Added** `capabilities` on an organization; acts outside it return 403 `ORG_CAPABILITY_MISSING`.
- Absent capabilities means unrestricted, so existing integrations were unaffected.
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/openapi.snapshot.json apps/api/scripts apps/api/package.json docs/api/CHANGELOG.md apps/api/test/openapi-contract.test.ts
git commit -m "feat(api): commit the public API surface snapshot + integrator changelog (EN-D1)"
```

---

## Task D1-5: The three guides

**Files:** Create `docs/api/guides/issue-a-credential.md`, `tokenize-an-asset.md`, `receive-webhooks.md`.

- [ ] **Step 1: Write them**

Each guide must: state prerequisites first (which scopes, which capabilities the org needs — a 403 twenty minutes in is the worst way to learn you needed `credentials:issue`); number every step; show a real `curl` with a real request body; show the real response including the 202-and-proposal shape; and end with how to verify the result independently.

**`issue-a-credential.md`** — mint a key with `credentials:issue` + `credentials:read`; pick or provision a credential use case; draft the issuance (202 + proposal); approve as a second principal; the holder accepts; run a verification; read the outcome. **This guide has to teach maker-checker properly** — that a 202 is a request, that the approver must be a different principal, and that an `Issuer`-role principal cannot approve issuance proposals at all (only OrgAdmin/PlatformAdmin can view them).

**`tokenize-an-asset.md`** — configure a use case, issue an asset, transfer it, read holders and the audit trail; note which use cases gate transfers behind maker-checker.

**`receive-webhooks.md`** — register an endpoint; verify a signature over the raw bytes (the mistake almost everyone makes is verifying a re-serialized object); handle at-least-once (dedupe on `Tokenlayer-Event-Id`) and out-of-order delivery; recover a missed window with `GET /events?after=`; and what an auto-disabled endpoint means and how to re-enable it.

- [ ] **Step 2: Do NOT claim they work yet**

They are verified by execution in task D1-7. Until then they are drafts. Say so in the commit message.

- [ ] **Step 3: Commit**

```bash
git add docs/api/guides
git commit -m "docs(api): three integration guides (unverified drafts — executed in D1-7) (EN-D1)"
```

---

## Task D1-6: The in-app portal

**Files:** Create `apps/web/src/lib/openapi.ts`, `apps/web/src/components/ApiReference.tsx`, `apps/web/src/components/Guides.tsx`, `apps/web/test/openapi-view.test.ts`; modify `apps/web/src/components/Developers.tsx`.

- [ ] **Step 1: Write the pure-helper tests first**

```ts
import { describe, expect, it } from "vitest";
import { canTryIt, credentialLine, groupByTag } from "../src/lib/openapi.js";

describe("Try it eligibility", () => {
  it("is offered for GET and withheld for everything else", () => {
    expect(canTryIt("get")).toBe(true);
    for (const m of ["post", "patch", "put", "delete"]) expect(canTryIt(m)).toBe(false);
  });
});

describe("the credential line — the most useful thing we know about a route", () => {
  it("names both credentials and the scope when a key may call it", () => {
    const line = credentialLine({ security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], description: "Requires the `credentials:issue` scope." });
    expect(line).toMatch(/API key/i);
    expect(line).toMatch(/credentials:issue/);
  });
  it("says session-only when no key may call it", () => {
    const line = credentialLine({ security: [{ bearerAuth: [] }], description: "" });
    expect(line).toMatch(/session/i);
    expect(line).not.toMatch(/API key/i);
  });
  it("says public when a route needs no credential", () => {
    expect(credentialLine({ security: [], description: "" })).toMatch(/public/i);
  });
});

describe("grouping", () => {
  it("never drops a route: an untagged operation lands under Other", () => {
    const groups = groupByTag({ "/x": { get: { tags: [] } }, "/y": { get: { tags: ["Assets"] } } } as never);
    expect(groups.flatMap((g) => g.routes)).toHaveLength(2);
    expect(groups.find((g) => g.tag === "Other")?.routes).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement the helpers, then the components**

`ApiReference.tsx` fetches `/openapi.json`, groups by tag in the order the document declares, and for each route shows method, path, summary, description, parameters, request body, response fields, and **the credential line prominently**. Try it on GET only; every other method shows a copyable `curl` plus one line: *"Interactive calls are read-only here — a documentation page should not issue a credential or move tokens against live data. Sandbox keys arrive with test mode."* A fetch failure renders a clear message with a retry, never a blank pane.

`Guides.tsx` renders the three guides with a copy button on every call.

`Developers.tsx` becomes a tabbed shell — Overview · API keys · Webhooks · Reference · Guides — keeping the existing keys and webhooks panels as tab contents, unchanged. **No new nav item**, so there is no domain classification to get wrong.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit -p apps/web && pnpm --filter @tokenlayer/web test && pnpm --filter @tokenlayer/web build
```

- [ ] **Step 4: Mutation-check**

1. `canTryIt` returns true for `post` → the eligibility test must fail.
2. `groupByTag` drops untagged operations → the never-drops test must fail.
3. `credentialLine` ignores `apiKeyAuth` → the both-credentials test must fail.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "feat(web): developer portal — reference with credential lines, guides, read-only try-it (EN-D1)"
```

---

## Task D1-7: Verify, execute the guides, review, merge

- [ ] **Step 1: Full suites, including the no-`.env` run**

```bash
pnpm --filter @tokenlayer/core test -- --run
pnpm --filter @tokenlayer/api test -- --run --testTimeout=180000
mv apps/api/.env apps/api/.env.bak && pnpm --filter @tokenlayer/api test -- --run --testTimeout=180000; mv apps/api/.env.bak apps/api/.env
pnpm --filter @tokenlayer/web test && pnpm --filter @tokenlayer/web build
npx tsc --noEmit -p apps/api && npx tsc --noEmit -p apps/web
```

The two api runs must report the **same** count. A difference means a test file failed to collect without configuration — exactly what hid 16 dispatcher tests on EN-C.

- [ ] **Step 2: Boot against live Besu on a throwaway DB**

```bash
cd apps/api && DATABASE_URL="file:./dev-docs.db" npx prisma db push --skip-generate \
  && DATABASE_URL="file:./dev-docs.db" ../../node_modules/.bin/tsx src/seed.ts
```

Then the standard live-Besu boot recipe with `DATABASE_URL="file:./dev-docs.db"` and `WEBHOOKS_ALLOW_INSECURE=1`.

- [ ] **Step 3: EXECUTE the three guides verbatim**

Follow each guide as an integrator would, copying its commands, and record the actual responses. **A guide is only true if someone has run it.** Every divergence is a bug in the guide — fix the guide, not the transcript. Confirm in particular that each stated prerequisite is really sufficient: mint a key with exactly the scopes the guide names and nothing more.

- [ ] **Step 4: Browser pass**

Open Developers → Reference: confirm every tag group renders, credential lines are correct on a scoped route and a human-only route, Try it works on a GET and is absent on a POST. Then Guides: confirm copy buttons work.

- [ ] **Step 5: Teardown**

```bash
lsof -ti tcp:4000 | xargs kill -9
rm -f apps/api/prisma/dev-docs.db*
ls -la apps/api/prisma/dev.db apps/api/prisma/dev.db.freshkey.bak   # mtimes MUST be unchanged
git status --porcelain                                              # expect clean
```

- [ ] **Step 6: Final whole-branch review**

Dispatch a reviewer in an **isolated worktree**, told to **hunt independently** rather than re-check this plan. The final review has found a HIGH on every sub-project of this program. Point it at, but do not limit it to: whether the production exposure gate on `/openapi.json` actually holds; whether any documented response now differs from what the route serializes; whether the security documentation is complete rather than merely consistent (a route both tests skip is documented by neither); whether the reference can render a route the caller may not call in a way that leaks its existence; and whether the guides instruct an integrator to do anything unsafe (over-broad scopes, secrets in shell history, verifying a signature the wrong way).

- [ ] **Step 7: Finish the branch**

Use `superpowers:finishing-a-development-branch` (standing choice: merge locally, `--no-ff`), delete the branch, then update `enterprise-program.md`: EN-D1 merged with its sha, EN-D2 (sandbox) next, plus any new gotchas.

---

## Self-review

**Spec coverage.** Security schemes → D1-1. Tag descriptions → D1-1. Version + servers → D1-1. Production exposure → D1-1 step 4. Verified-against-enforcement → D1-2. Additive response docs + the additivity guarantee → D1-3. The 202 problem → D1-3. Snapshot → D1-4. Changelog → D1-4. Three guides → D1-5, executed in D1-7. In-app tabbed portal + reference + GET-only try-it → D1-6. Error handling (fetch failure, untagged route under "Other") → D1-6. Live execution + review + finish → D1-7.

**Placeholder scan.** No TBD/TODO; every code step carries its code; the response-documentation queue is generated by a failing test rather than hand-listed, which is deliberate — the test knows the current truth and a hand-list would go stale before the task started.

**Type consistency.** `declaredRoutes()`/`RouteDecl` exported once from `scope-coverage.test.ts` and imported by the contract test; `canTryIt`/`credentialLine`/`groupByTag` are named identically in the tests and the implementation step; `INTEGRATION_SURFACE` and `DOCUMENTATION_DEFERRED` mirror EN-B's `DELIBERATELY_UNSCOPED` naming; the snapshot projection is explicitly shared between the test and the regeneration script.
