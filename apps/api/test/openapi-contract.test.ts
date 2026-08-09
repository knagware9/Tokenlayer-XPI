import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1 } from "./helpers.js";

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
