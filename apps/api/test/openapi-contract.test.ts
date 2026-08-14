import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { components, S } from "../src/http/schemas/index.js";
import { buildTestApp, loginAs, V1 } from "./helpers.js";
import { allRouteDeclarations, declaredRoutes, routeKey, type RouteDecl } from "./route-decls.js";

/**
 * ONE FILE PER PRODUCT since schemas.ts was split. The count below is over ALL
 * of them: `additionalProperties: true` moving from one product's file to
 * another is not a narrowing, but losing one anywhere is.
 */
const SCHEMAS_DIR = fileURLToPath(new URL("../src/http/schemas", import.meta.url));
const readAllSchemaSources = (): string => {
  const files = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".ts")).sort();
  if (files.length < 4) throw new Error(`expected the split schema files in ${SCHEMAS_DIR}, found ${files.join(", ")}`);
  return files.map((f) => readFileSync(`${SCHEMAS_DIR}/${f}`, "utf8")).join("\n");
};

/**
 * EN-D1: the OpenAPI document is a PRODUCT SURFACE, not a by-product.
 *
 * Everything a machine integrator knows about this API — which credential to
 * send, what the groups mean, which version they are reading — comes from this
 * document and nowhere else. A wrong statement here is not a typo; it is a
 * wrong instruction delivered at scale. These tests pin the three claims the
 * document had been getting wrong: the shape of the API-key credential, the
 * completeness of the tag list, and the version.
 */
describe("the OpenAPI document's identity", () => {
  it("declares BOTH credentials, and does not call an API key a JWT", async () => {
    const app = await buildTestApp();
    await app.ready(); // @fastify/swagger builds the document at ready(); calling swagger() before it throws.
    const doc = app.swagger() as unknown as { components: { securitySchemes: Record<string, { type: string; scheme: string; bearerFormat?: string; description?: string }> } };
    const s = doc.components.securitySchemes;
    expect(s.bearerAuth).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    // An API key is an OPAQUE string. Declaring bearerFormat JWT here is what
    // the document did before EN-D1, and it is the single most misleading thing
    // a machine integrator could read.
    expect(s.apiKeyAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(s.apiKeyAuth.bearerFormat).toBeUndefined();
    expect(s.apiKeyAuth.description).toMatch(/tl_live_/);
    expect(s.apiKeyAuth.description).toMatch(/narrow/i);
  });

  it("describes EVERY tag any route actually uses", async () => {
    const app = await buildTestApp();
    await app.ready(); // @fastify/swagger builds the document at ready(); calling swagger() before it throws.
    const doc = app.swagger() as unknown as { tags?: { name: string }[]; paths: Record<string, Record<string, { tags?: string[] }>> };
    const used = new Set<string>();
    for (const ops of Object.values(doc.paths)) for (const op of Object.values(ops)) for (const t of op.tags ?? []) used.add(t);
    const described = new Set((doc.tags ?? []).map((t) => t.name));
    const missing = [...used].filter((t) => !described.has(t)).sort();
    expect(missing, `tags used by routes but never described: ${missing.join(", ")}`).toEqual([]);
  });

  it("reports the package version, not a frozen literal", async () => {
    const app = await buildTestApp();
    await app.ready(); // @fastify/swagger builds the document at ready(); calling swagger() before it throws.
    const doc = app.swagger() as unknown as { info: { version: string }; servers?: { url: string }[]; paths: Record<string, unknown> };
    expect(doc.info.version).not.toBe("1.0.0");
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(doc.servers?.[0]?.url).toBeTruthy();
    // The server URL and the paths must COMPOSE back to the real endpoint.
    // Naming the versioned root (…/api/v1) as the server makes @fastify/swagger
    // strip `/api/v1` off all 121 paths, producing a document that still looks
    // plausible but no longer matches the routes the rest of the suite pins.
    // deps.publicApiUrl here is "http://test.local/api/v1".
    expect(doc.servers?.[0]?.url).toBe("http://test.local");
    expect(Object.keys(doc.paths)).toContain("/api/v1/assets");
  });
});

/**
 * The document is now ALWAYS generated — the in-app portal renders from it and
 * the contract tests above read it — so what production changes is EXPOSURE,
 * not existence. An unauthenticated spec is a recon aid; an authenticated one
 * is the product.
 */
describe("the OpenAPI document's exposure", () => {
  it("is open outside production", async () => {
    const app = await buildTestApp({ isProduction: false });
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toMatch(/^3\./);
  });

  it("requires a session in production", async () => {
    const app = await buildTestApp({ isProduction: true });
    const anon = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(anon.statusCode).toBe(401);

    const token = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const authed = await app.inject({ method: "GET", url: "/openapi.json", headers: { authorization: `Bearer ${token}` } });
    expect(authed.statusCode).toBe(200);
    expect(authed.json().info.title).toBeTruthy();
  });

  it("gates the Swagger UI in production too", async () => {
    const app = await buildTestApp({ isProduction: true });
    const anon = await app.inject({ method: "GET", url: "/docs" });
    expect(anon.statusCode).toBe(401);

    const open = await buildTestApp({ isProduction: false });
    const dev = await open.inject({ method: "GET", url: "/docs" });
    // Swagger UI answers /docs with a redirect to /docs/static/index.html.
    expect(dev.statusCode).toBeLessThan(400);
  });

  it("still serves the v1 API to an anonymous caller's public routes in production", async () => {
    // Guards the gate's ENCAPSULATION: the docs preHandler lives in its own
    // plugin, so it must not reach the API. A root-scope hook would have
    // broken login itself, which by definition carries no credential.
    const app = await buildTestApp({ isProduction: true });
    const res = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "admin@tokenlayer.dev", password: "admin123" } });
    expect(res.statusCode).toBe(200);
  });
});

/**
 * EN-D1: DOCUMENTATION DRIFTS BECAUSE NOTHING FAILS WHEN IT LIES.
 *
 * This API already knows, mechanically, which routes an API key may call and
 * with which scope — `authScoped("x")` IS that statement, and EN-B's
 * scope-coverage test makes every route carry one or an explicit exemption.
 * The published document is a second, hand-written copy of the same fact, and
 * a second copy of a fact is a fact that can be wrong. Before this test all
 * 121 routes advertised `bearerAuth` alone: the document told every integrator
 * that machine access did not exist, while the server happily served it.
 *
 * So the two are compared, not merely both maintained. The gate is the truth;
 * the document must agree; disagreement fails the build.
 */
type Documented = { security?: ReadonlyArray<Record<string, readonly string[]>>; description?: string };

const docOf = (r: RouteDecl): Documented | undefined => (r.schema ? (S[r.schema] as Documented | undefined) : undefined);

/** The security scheme NAMES an operation advertises, flattened across alternatives. */
const schemesOf = (d: Documented | undefined): string[] => (d?.security ?? []).flatMap((alt) => Object.keys(alt));

describe("documented security matches the gate that actually runs", () => {
  it("every scoped route documents BOTH credentials and names its scope", () => {
    // authScoped(scope) => the route IS key-callable with that scope. The
    // document must say so, and must name the scope in prose an integrator can
    // act on: "you may use a key here" is useless without "…which needs THIS
    // scope", because scopes are chosen when the key is minted and a key
    // cannot be widened afterwards.
    const failures: string[] = [];
    for (const r of declaredRoutes().filter((x) => x.scope !== null)) {
      const doc = docOf(r);
      if (!doc) {
        failures.push(`${routeKey(r)} — declares schema S.${r.schema} but schemas.ts has no such export`);
        continue;
      }
      const names = schemesOf(doc);
      if (!names.includes("bearerAuth") || !names.includes("apiKeyAuth")) {
        failures.push(
          `${routeKey(r)} (S.${r.schema}) documents [${names.join(", ") || "no security at all"}] — ` +
            `but authScoped("${r.scope}") makes it callable with an API key. Use \`security: eitherCredential\`.`,
        );
      }
      if (!(doc.description ?? "").includes(r.scope!)) {
        failures.push(
          `${routeKey(r)} (S.${r.schema}) never names the \`${r.scope}\` scope in its description — ` +
            `an integrator cannot tell which scope to mint the key with.`,
        );
      }
    }
    // Collected rather than thrown one at a time: one run should print the
    // whole work queue, not just whichever route sorts first.
    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });

  it("a human-only route does NOT advertise API-key access", () => {
    // No scope gate => either the route refuses machine principals outright
    // (403 MACHINE_PRINCIPAL) or it is gated dynamically at runtime — see
    // DELIBERATELY_UNSCOPED in scope-coverage.test.ts, which records which.
    // Advertising apiKeyAuth would promise an integrator something the server
    // may refuse, and the refusal would look like a bug in OUR document rather
    // than a deliberate boundary.
    const failures: string[] = [];
    for (const r of declaredRoutes().filter((x) => x.scope === null)) {
      const names = schemesOf(docOf(r));
      if (names.includes("apiKeyAuth")) {
        failures.push(
          `${routeKey(r)} (S.${r.schema}) advertises apiKeyAuth, but it carries no authScoped(...) gate — ` +
            `it is session-only or dynamically gated. Use \`security: humanOnly\`, or add the scope gate.`,
        );
      }
    }
    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });
});

/**
 * A ROUTE BOTH TESTS SKIP IS DOCUMENTED BY NEITHER.
 *
 * The pair above iterates what the parser FINDS. A declaration the regex
 * cannot read, or one with no `schema:` to look up, would be silently exempt
 * from both — green, and undocumented. EN-C shipped exactly that shape: 16
 * dispatcher tests that never ran, and nothing said so. So the parser's
 * coverage is itself asserted, in both directions.
 */
describe("the consistency check has no blind spot", () => {
  it("the parser reads EVERY route declaration in routes.ts", () => {
    const parsed = new Set(declaredRoutes().map(routeKey));
    const unreadable = allRouteDeclarations().filter((k) => !parsed.has(k));
    // A declaration the parser gives up on — an unbalanced brace, a shape it
    // does not model — lands here, invisible to both checks above AND to EN-B's
    // scope coverage. Widen the parser; do not delete this test. (Nested braces
    // in the options object no longer land here: they used to TRUNCATE the
    // capture silently, hiding a trailing authScoped(...), which is why
    // route-decls.ts now balances braces instead of stopping at the first `}`.)
    expect(unreadable, `route declarations the parser could not read: ${unreadable.join(", ")}`).toEqual([]);
    expect(parsed.size).toBeGreaterThan(100);
  });

  it("every declaration names a schema that exists in schemas.ts", () => {
    const orphans = declaredRoutes()
      .filter((r) => r.schema === null || !S[r.schema])
      .map((r) => `${routeKey(r)} → ${r.schema === null ? "no schema: at all" : `missing S.${r.schema}`}`);
    expect(orphans, `routes with nothing to document: ${orphans.join(", ")}`).toEqual([]);
  });

  it("no schema object is shared by a scoped and an unscoped route", () => {
    // The two checks above make OPPOSITE demands of the same object. One
    // schema serving both kinds of route could not satisfy them, and the pair
    // would deadlock on a contradiction rather than on a defect.
    const byName = new Map<string, RouteDecl[]>();
    for (const r of declaredRoutes()) if (r.schema) byName.set(r.schema, [...(byName.get(r.schema) ?? []), r]);
    const conflicted = [...byName.entries()]
      .filter(([, rs]) => rs.some((r) => r.scope !== null) && rs.some((r) => r.scope === null))
      .map(([name, rs]) => `S.${name}: ${rs.map((r) => `${routeKey(r)}${r.scope ? ` (${r.scope})` : " (unscoped)"}`).join(" vs ")}`);
    expect(conflicted, `contradictory shared schemas: ${conflicted.join("; ")}`).toEqual([]);
  });

  it("every operation in the published document traces back to a declaration", async () => {
    const app = await buildTestApp();
    await app.ready(); // @fastify/swagger builds the document at ready(); calling swagger() before it throws.
    const doc = app.swagger() as unknown as { paths: Record<string, Record<string, unknown>> };
    // Fastify params (`:id`) are OpenAPI templates (`{id}`), and every route in
    // routes.ts is mounted under the versioned prefix.
    const declared = new Set(declaredRoutes().map((r) => `${r.method} ${V1}${r.path.replace(/:(\w+)/g, "{$1}")}`));
    const untraceable: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) {
        // HEAD is synthesised by Fastify from the GET route; it is not a declaration.
        if (method.toLowerCase() === "head") continue;
        const k = `${method.toUpperCase()} ${path}`;
        if (!declared.has(k)) untraceable.push(k);
      }
    }
    // A documented operation the parser never returned is an operation neither
    // consistency check above can police.
    expect(untraceable, `operations in the document with no matching declaration: ${untraceable.join(", ")}`).toEqual([]);
  });
});

/**
 * ═══ THE ADDITIVITY RULE, ENFORCED ═══
 *
 * `fast-json-stringify` serialises every response against its declared schema
 * and SILENTLY STRIPS anything the schema does not declare. So narrowing a
 * response schema does not fail a test — it deletes a field from a live
 * response and says nothing at all. There is no error, no warning, and no
 * broken assertion unless some test happened to read that exact field.
 *
 * EN-D1 documents what routes return. It may only ever ADD.
 *
 * Two checks, deliberately of different kinds:
 *
 *  1. A coarse whole-file floor. Cheap, and it covers request bodies and
 *     components alike, but it is blind to one schema losing the flag while
 *     another gains it.
 *  2. A PRECISE structural walk of the live schema objects — the very objects
 *     Fastify compiles — which names the exact schema path that narrowed. This
 *     is the check that actually protects the wire; the floor is its backstop.
 *
 * MEASURED, not assumed: removing `additionalProperties: true` from a single
 * component was caught by (2) and SURVIVED (1), because EN-D1 raised the raw
 * count well clear of the floor. Do not read a green floor as "nothing
 * narrowed" — (2) is the check that means that.
 *
 * The floor stays at its PRE-EN-D1 measurement rather than ratcheting up to
 * today's count, deliberately: a later refactor that replaces two inline
 * objects with one shared component legitimately lowers the raw count while
 * narrowing nothing, and a ratchet would fail it for no reason. The floor
 * guards against wholesale removal; (2) guards against everything else.
 */
const ADDITIVE_FLOOR = 153;

/**
 * Object nodes that do NOT carry `additionalProperties: true` and predate
 * EN-D1. Each is a pre-existing narrowing, recorded rather than fixed: opening
 * one up would CHANGE what the API serialises, which is exactly what a
 * documentation task must not do. The list may shrink; every addition to it is
 * a field being stripped and needs its own justification.
 */
const PRE_EXISTING_NARROWING: Record<string, string> = {
  "S.login.response.200": "predates EN-D1 — token+user only, and `user` itself is open",
  "S.issueAsset.response.201": "predates EN-D1",
  "S.action.response.200.oneOf[1]": "predates EN-D1 — explicit additionalProperties:false on the 202 arm",
  "S.listCashflows.response.200": "predates EN-D1",
  "S.listCashflows.response.200.preview.split.items": "predates EN-D1",
  "S.uploadDocument.response.201": "predates EN-D1",
  "S.uploadKybDocument.response.201": "predates EN-D1",
  "Error#": "the error envelope is a closed contract by design",
  "Pagination#": "closed by design",
  "ContractCode#.constructorArgs.items": "predates EN-D1",
  "MetadataSchema#.properties": "a schema-of-schemas; its additionalProperties is a $ref, not `true`",
  "UseCase#.contracts": "a map whose additionalProperties is the value schema, not `true`",
  "AssetList#": "predates EN-D1",
  "AccountState#": "predates EN-D1",
  "TokenInfo#": "predates EN-D1",
  "Currency#": "predates EN-D1",
  "AuditList#": "predates EN-D1",
};

type SchemaNode = Record<string, unknown>;

/** Every object node under `root`, keyed by a stable path. `$ref` nodes are the
 * boundary — the component they name is walked separately, once. */
function objectNodes(root: unknown, path: string, into: Map<string, SchemaNode>): void {
  if (!root || typeof root !== "object") return;
  if (Array.isArray(root)) {
    root.forEach((child, i) => objectNodes(child, `${path}[${i}]`, into));
    return;
  }
  const n = root as SchemaNode;
  if (n.$ref) return;
  if (n.type === "object" || (n.properties !== undefined && n.type === undefined)) into.set(path, n);
  if (n.properties && typeof n.properties === "object") {
    for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) objectNodes(v, `${path}.${k}`, into);
  }
  for (const k of ["items", "allOf", "anyOf", "oneOf"] as const) if (n[k]) objectNodes(n[k], `${path}.${k}`, into);
}

/** Every object node reachable from a RESPONSE schema, plus every component
 * (components are what responses `$ref`, so narrowing one strips fields too). */
function allResponseObjectNodes(): Map<string, SchemaNode> {
  const found = new Map<string, SchemaNode>();
  for (const [name, schema] of Object.entries(S)) {
    const response = (schema as { response?: Record<string, unknown> }).response;
    if (!response) continue;
    for (const [code, node] of Object.entries(response)) objectNodes(node, `S.${name}.response.${code}`, found);
  }
  for (const c of components) objectNodes(c, `${(c as { $id: string }).$id}#`, found);
  return found;
}

describe("the additivity rule", () => {
  it("never removes additionalProperties: true from a response schema", () => {
    const src = readAllSchemaSources();
    const count = (src.match(/additionalProperties:\s*true/g) ?? []).length;
    expect(count, "a response schema was narrowed — that STRIPS fields from live responses").toBeGreaterThanOrEqual(
      ADDITIVE_FLOOR,
    );
  });

  it("every object node in every response is still open", () => {
    // The precise half. A whole-file count cannot tell "one schema lost the
    // flag while another gained it" from "nothing happened"; this can, and it
    // names the path.
    const narrowed: string[] = [];
    for (const [path, node] of allResponseObjectNodes()) {
      if (node.additionalProperties === true) continue;
      if (path in PRE_EXISTING_NARROWING) continue;
      narrowed.push(
        `${path} — additionalProperties is ${JSON.stringify(node.additionalProperties)}, not true. ` +
          `fast-json-stringify will STRIP every field this node does not declare.`,
      );
    }
    expect(narrowed, `\n${narrowed.join("\n")}\n`).toEqual([]);
  });

  it("the pre-existing-narrowing list has no stale entries", () => {
    const stillNarrow = new Set(
      [...allResponseObjectNodes()].filter(([, n]) => n.additionalProperties !== true).map(([p]) => p),
    );
    const stale = Object.keys(PRE_EXISTING_NARROWING).filter((p) => !stillNarrow.has(p));
    expect(stale, `no longer narrowed (or renamed) — drop from PRE_EXISTING_NARROWING: ${stale.join(", ")}`).toEqual([]);
  });
});

/**
 * ═══ WHAT A ROUTE RETURNS ═══
 *
 * Before EN-D1's third task, 153 response schemas were `{ type: "object",
 * additionalProperties: true }` with no `properties` at all. The published
 * reference therefore said, of most of this API, "returns an object" — and
 * named not one field. An integrator cannot write a client against that; they
 * have to call the thing and read the JSON, which is precisely the work the
 * document exists to save.
 *
 * So the routes an external system actually calls must enumerate what they
 * return, or say in writing why they do not.
 */
/** The tags an external system actually calls. */
const INTEGRATION_SURFACE = new Set([
  "Auth",
  "API Keys",
  "Webhooks",
  "Credentials",
  "Credential Use Cases",
  "Verification",
  "Assets",
  "Users",
  "Organizations",
  "Proposals",
  "Config",
  "Catalog",
]);

/** Integration-surface routes whose response is deliberately not enumerated. */
const DOCUMENTATION_DEFERRED: Record<string, string> = {
  "GET /credentials/:id/certificate.pdf": "returns opaque PDF bytes, not a JSON object",
  // EN-F's designer preview. Same answer as the route above and for the same
  // reason: the 200 is a rendered PDF. Declaring a JSON 2xx here would be a
  // false statement about the response, not a more complete one.
  "POST /credential-use-cases/preview-certificate": "returns opaque PDF bytes, not a JSON object",
  // A MAP keyed by credential-type NAME, so its keys are data rather than a
  // fixed field set — there is nothing to put in `properties`. Enumerating
  // today's built-in keys would pin a core constant into the response schema
  // and, worse, declaring their value shape would let fast-json-stringify
  // coerce it. The route's `description` documents the map and its value shape
  // instead; that is the honest form of this particular answer.
  "GET /credential-templates": "a map keyed by credential-type name — data-shaped keys, not enumerable properties",
  // EN-E Task 6b's brand-logo read. Same answer as the two PDF routes above:
  // the 200 is the stored image's raw bytes. `GET /documents/:id` returns the
  // same kind of body and escapes this check only because "Documents" is not an
  // integration-surface tag — this route is filed under "Organizations" beside
  // the two branding routes it completes, which is where a reader looks for it.
  "GET /orgs/:id/branding/logo": "returns opaque image bytes, not a JSON object",
  // The org's own artwork, served back to the designer canvas. The 200 is the
  // stored image itself, so there is no field to name; declaring a JSON 2xx
  // would let fast-json-stringify take an interest in bytes it must pass
  // through untouched.
  "GET /credential-use-cases/:key/certificate/artwork": "returns opaque image bytes, not a JSON object",
};

type ResponseSchema = { response?: Record<string, unknown>; tags?: string[]; description?: string };

const schemaOf = (r: RouteDecl): ResponseSchema | undefined => (r.schema ? (S[r.schema] as ResponseSchema | undefined) : undefined);

const onIntegrationSurface = (r: RouteDecl): boolean => (schemaOf(r)?.tags ?? []).some((t) => INTEGRATION_SURFACE.has(t));

/** A response node that tells an integrator something: a component reference,
 * or at least one named field (directly, or in an array's items). */
function namesAField(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as SchemaNode;
  if (n.$ref) return true;
  if (n.type === "null") return true; // 204: "no body" IS the documented shape
  if (n.properties && Object.keys(n.properties as object).length > 0) return true;
  if (n.type === "array") return namesAField(n.items);
  if (Array.isArray(n.oneOf)) return n.oneOf.every((alt) => namesAField(alt));
  return false;
}

/** Route keys of every integration-surface route that documents no 2xx shape. */
function undocumentedRoutes(): string[] {
  const failures: string[] = [];
  for (const r of declaredRoutes()) {
    if (!onIntegrationSurface(r)) continue;
    const response = schemaOf(r)?.response ?? {};
    const twoXX = Object.entries(response).filter(([code]) => code.startsWith("2"));
    if (twoXX.some(([, node]) => namesAField(node))) continue;
    failures.push(routeKey(r));
  }
  return failures;
}

describe("every integration-surface route says what it returns", () => {
  it("declares at least one 2xx shape with named fields", () => {
    const failures = undocumentedRoutes()
      .filter((k) => !(k in DOCUMENTATION_DEFERRED))
      .map((k) => `${k} — its 2xx response names no field. Add a \`properties\` block (or a $ref), or defer it with a reason.`);
    // Collected, not thrown one at a time: one run should print the whole work
    // queue rather than whichever route sorts first.
    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });

  it("the deferral list has no stale entries", () => {
    // The same discipline scope-coverage.test.ts applies to its exemptions: an
    // exemption nobody needs any more is an exemption nobody re-examines.
    const undocumented = new Set(undocumentedRoutes());
    const stale = Object.keys(DOCUMENTATION_DEFERRED).filter((k) => !undocumented.has(k));
    expect(stale, `these routes are documented now (or no longer exist) — drop them: ${stale.join(", ")}`).toEqual([]);
  });
});

/**
 * ═══ THE 202 PROBLEM ═══
 *
 * On this platform almost every mutation answers **202 with a proposal**, not
 * with the object it appears to create. Maker-checker means the work happens on
 * APPROVAL, by someone else, later. A client that POSTs a user and then reads
 * `id` off the response gets a PROPOSAL's id, and the user it asked for may
 * never exist at all — the checker can reject it.
 *
 * That is the single most confusing thing about this API for a newcomer, and it
 * is invisible in a status code. Every route that can answer 202 must say so in
 * prose.
 */
describe("every 202 route explains the proposal", () => {
  it("names the proposal in its description", () => {
    const failures: string[] = [];
    for (const r of declaredRoutes()) {
      const schema = schemaOf(r);
      if (!schema?.response || !("202" in schema.response)) continue;
      if (/proposal/i.test(schema.description ?? "")) continue;
      failures.push(
        `${routeKey(r)} (S.${r.schema}) can answer 202 but never says "proposal" in its description — ` +
          `an integrator will read the 202 body as the object they asked for, and it is not.`,
      );
    }
    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });
});

/**
 * ═══ A PATH NAMED IN PROSE MUST BE A PATH THAT EXISTS ═══
 *
 * The checks above police STRUCTURE — that security matches the gate, that a
 * response names its fields, that a 202 says "proposal". None of them read the
 * English, and the English is what an integrator actually follows.
 *
 * MEASURED, not hypothetical: EN-D1's own `ProposalEnvelope` description told
 * every integrator to "Poll `GET /proposals/:id`" — the first instruction they
 * meet after their first successful mutation — and that route has never
 * existed. `/proposals` is a LIST; the single-proposal GET was never built.
 * Every structural test above stayed green, because a sentence is not a schema.
 *
 * So prose is checked against the document's own path table. Any `/…` token in
 * any `description` or `summary` anywhere in the schema surface must resolve to
 * a real path, and where the prose names a method too, that method must exist
 * at that path.
 *
 * The exclusion list below is deliberately tiny and each entry carries its
 * reason. A slash-token this test cannot resolve fails LOUDLY rather than being
 * skipped by a cleverer heuristic: a filter that quietly drops what it does not
 * recognise would have dropped `/proposals/:id` too, and this test would have
 * been written, merged, and useless.
 */

/**
 * Slash-tokens that appear in prose and are NOT API paths. Narrow by
 * construction — the value is the reason it is not a route. Empty today, and
 * that is the point: across the whole schema surface every slash-token in
 * English resolves to a real route, so nothing has to be hand-waved.
 *
 * NOT the place for a description that mentions a route to say it does not
 * exist ("there is no `GET /proposals/{id}`"). This test cannot tell that
 * sentence from an instruction, and neither can a reader skimming — reword it
 * to name the route that DOES answer the question instead.
 */
const NOT_API_PATHS: Record<string, string> = {};

type Prose = { where: string; text: string };

/** Every `description` and `summary` string in the schema surface, with its location. */
function allProse(): Prose[] {
  const out: Prose[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, where: string): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${where}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === "description" || k === "summary") && typeof v === "string") out.push({ where: `${where}.${k}`, text: v });
      else walk(v, `${where}.${k}`);
    }
  };
  for (const [name, schema] of Object.entries(S)) walk(schema, `S.${name}`);
  for (const c of components) walk(c, `${(c as { $id: string }).$id}#`);
  return out;
}

/** `/api/v1/orgs/:id/x` and `/orgs/{orgId}/x` both normalise to `/orgs/{}/x`. */
function normalisePath(raw: string): string {
  const noPrefix = raw.replace(/^\/api\/v\d+(?=\/|$)/, "");
  const params = noPrefix.replace(/\{[^}]*\}/g, "{}").replace(/(?<=\/):[A-Za-z0-9_]+/g, "{}");
  return params.replace(/\/+$/, "") || "/";
}

/** Slash-tokens in a string, each with the HTTP method that immediately precedes it (if any). */
function pathMentions(text: string): { method: string | null; raw: string }[] {
  const re = /\b(GET|POST|PUT|PATCH|DELETE)\s+`?(\/[^\s`"]*)|(?<![\w/])(\/[A-Za-z0-9_{}:.-][^\s`"]*)/g;
  const out: { method: string | null; raw: string }[] = [];
  for (const m of text.matchAll(re)) {
    const method = m[1] ?? null;
    // Prose punctuation is not part of the path: "…see `GET /events`, which…".
    const raw = (m[2] ?? m[3] ?? "").replace(/[.,;:)\]]+$/, "");
    if (!raw || raw.includes("//")) continue; // `https://…` — a URL, not a path on this API
    out.push({ method, raw });
  }
  return out;
}

describe("no description points an integrator at a route that does not exist", () => {
  it("every path named in prose resolves to a real path in the document", async () => {
    const app = await buildTestApp();
    await app.ready(); // @fastify/swagger builds the document at ready(); calling swagger() before it throws.
    const doc = app.swagger() as unknown as { paths: Record<string, Record<string, unknown>> };

    // The document's own path table is the oracle — the same table the portal
    // renders and `every operation traces back to a declaration` already pins.
    const methodsByPath = new Map<string, Set<string>>();
    for (const [path, ops] of Object.entries(doc.paths)) {
      const key = normalisePath(path);
      const set = methodsByPath.get(key) ?? new Set<string>();
      for (const method of Object.keys(ops)) set.add(method.toUpperCase());
      methodsByPath.set(key, set);
    }
    expect(methodsByPath.size).toBeGreaterThan(100); // the oracle is populated, not an empty map that passes everything

    // Which schema objects belong to which route, so a failure names the route
    // an integrator would have been reading, not just a schema key.
    const routesBySchema = new Map<string, string[]>();
    for (const r of declaredRoutes()) if (r.schema) routesBySchema.set(r.schema, [...(routesBySchema.get(r.schema) ?? []), routeKey(r)]);
    const locate = (where: string): string => {
      const owner = /^S\.(\w+)/.exec(where)?.[1];
      const routes = owner ? routesBySchema.get(owner) : undefined;
      return routes?.length ? `${where} (${routes.join(", ")})` : where;
    };

    const failures: string[] = [];
    let checked = 0;
    for (const { where, text } of allProse()) {
      for (const { method, raw } of pathMentions(text)) {
        if (raw in NOT_API_PATHS) continue;
        checked += 1;
        const norm = normalisePath(raw);
        const methods = methodsByPath.get(norm);
        if (!methods) {
          failures.push(
            `${locate(where)} sends an integrator to \`${method ? `${method} ` : ""}${raw}\` — no such path exists in the ` +
              `document. Point at a route that does exist, or add \`${raw}\` to NOT_API_PATHS with the reason it is not one.`,
          );
          continue;
        }
        if (method && !methods.has(method)) {
          failures.push(
            `${locate(where)} names \`${method} ${raw}\`, but ${norm} answers only ${[...methods].filter((x) => x !== "HEAD").sort().join(", ")}.`,
          );
        }
      }
    }
    // THE TEST'S OWN BLIND SPOT, closed. A green run above means either "every
    // path in the prose is real" or "the extractor matched nothing at all", and
    // those are opposite facts. 21 mentions were found when this was written;
    // the floor sits well below that so ordinary editing does not trip it, but a
    // regex that stops matching cannot pass silently.
    expect(checked, "no path mentions were extracted at all — pathMentions() has stopped matching").toBeGreaterThan(15);
    // Collected rather than thrown one at a time: one run should print the whole
    // work queue, not just whichever description sorts first.
    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });

  it("the not-a-path list has no stale entries", () => {
    // Same discipline as every other exemption list here: an exclusion nobody
    // needs any more is an exclusion nobody re-examines — and this one's whole
    // job is to stay small enough to read.
    const mentioned = new Set(allProse().flatMap(({ text }) => pathMentions(text).map((m) => m.raw)));
    const stale = Object.keys(NOT_API_PATHS).filter((p) => !mentioned.has(p));
    expect(stale, `no longer mentioned in any description — drop from NOT_API_PATHS: ${stale.join(", ")}`).toEqual([]);
  });
});
