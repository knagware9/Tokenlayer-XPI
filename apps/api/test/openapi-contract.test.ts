import { describe, expect, it } from "vitest";
import { S } from "../src/http/schemas.js";
import { buildTestApp, loginAs, V1 } from "./helpers.js";
import { allRouteDeclarations, declaredRoutes, routeKey, type RouteDecl } from "./route-decls.js";

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
