import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { context, trace } from "@opentelemetry/api";
import { redactSensitiveFields } from "@tokenlayer/core";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppDeps } from "./context.js";
import { env } from "./env.js";
import { openapiConfig } from "./http/openapi.js";
import { applyDomainGate } from "./http/route-domains.js";
import { components } from "./http/schemas/index.js";
import { guardRepositories } from "./persistence/model-domains.js";
import { registerRoutes } from "./http/routes/index.js";
import { registerHealthRoutes } from "./http/routes/health.js";
import { errorHandler, requirePrincipal } from "./http/support.js";
import { httpRequestDuration, httpRequestsTotal } from "./shared/metrics.js";

/** JWT lifetime — tokens expire so a leaked/stale token is not valid forever. */
const TOKEN_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours

/**
 * Builds the HTTP surface: a versioned (/api/v1), schema-validated, OpenAPI 3
 * documented REST API over the platform's domain services. All dependencies are
 * injected so the same app runs over Prisma (production) or in-memory repos
 * (tests/demo).
 */
export async function buildApp(rawDeps: AppDeps): Promise<FastifyInstance> {
  // THE PERSISTENCE HALF OF THE PRODUCT BOUNDARY. The onRoute hook below stops
  // this deployment ANSWERING for a product it does not sell; this stops it
  // WRITING that product's data through a door the route gate never sees — a
  // proposal executor reached through shared `/proposals/:id/approve`, the
  // webhook dispatcher, anything added later. Transparent (literally the same
  // objects) on a deployment that serves both products, which is the default.
  const deps = guardRepositories(rawDeps, rawDeps.enabledDomains);
  // 256 KB body cap — bounds payload-size abuse.
  const app = Fastify({
    bodyLimit: 256 * 1024,
    logger: {
      level: env.logLevel,
      formatters: {
        // `req`/`res`/`err` are excluded from the redaction walk on purpose:
        // Fastify's own automatic request/response logging passes REAL
        // FastifyRequest/FastifyReply instances here (method/url/statusCode
        // etc. are prototype getters, invisible to redactSensitiveFields's
        // Object.entries()-based walk), and pino only applies its registered
        // req/res/err serializers to whatever this hook returns — AFTER this
        // hook runs, not before. Redacting them first silently empties them
        // to `{}` before the serializer ever sees the real object, so every
        // request/response log line loses method/url/statusCode entirely.
        // Fastify's default serializers surface
        // method/url/host/remoteAddress/remotePort/statusCode, and pino's
        // stdSerializers.err surfaces message/stack/type. Two of those are
        // accepted residual exposure rather than gaps this fix introduces:
        // `remoteAddress` technically substring-matches the deny-list's
        // "address" fragment (packages/core/src/shared/pii-scrub.ts), but
        // that fragment's neighbors — bankAccount, walletKey, privateKey,
        // cardNumber — show it targets mailing/financial addresses, not
        // network addresses, and logging the client IP on access-log-style
        // lines (incoming request / request completed) is standard,
        // deliberate practice for security auditing, rate-limiting
        // investigation, and abuse detection. `err`'s message/stack is left
        // unredacted for the same reason redaction can't reach it here — an
        // Error thrown with a raw secret embedded in its message would leak
        // it regardless of this hook, so callers must not do that. Every
        // ad-hoc field from a manual `app.log.error({email, ...}, "msg")`
        // call is always a plain object at the call site (never a
        // getter-based class instance), so it still goes through
        // redactSensitiveFields exactly as before.
        log(obj) {
          const { req, res, err, ...rest } = obj as Record<string, unknown>;
          const redacted = redactSensitiveFields(rest) as Record<string, unknown>;
          if (req !== undefined) redacted.req = req;
          if (res !== undefined) redacted.res = res;
          if (err !== undefined) redacted.err = err;
          return redacted;
        },
      },
      // Injects trace_id/span_id into every log line when a trace is active
      // (Task 7) — a no-op object when tracing isn't configured, since
      // trace.getSpan(context.active()) returns undefined either way.
      mixin() {
        const span = trace.getSpan(context.active());
        if (!span) return {};
        const { traceId, spanId } = span.spanContext();
        return { trace_id: traceId, span_id: spanId };
      },
      ...(rawDeps.logStream ? { stream: rawDeps.logStream } : {}),
    },
  });

  // CORS: explicit origin allowlist (no blanket reflection). Defaults to the local dashboard.
  await app.register(cors, { origin: deps.corsOrigins ?? ["http://localhost:5173"] });

  // JWT: HS256 only, with expiry. The secret is validated upstream (env.ts) to reject the dev default.
  await app.register(jwt, {
    secret: deps.jwtSecret,
    sign: { expiresIn: TOKEN_TTL_MS },
    verify: { algorithms: ["HS256"] },
  });

  // Baseline security headers on every response (Helmet-equivalent, dependency-free).
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    // Strict CSP for the JSON API; Swagger UI needs a relaxed policy, so skip it there.
    //
    // ONLY OUTSIDE PRODUCTION, though. The production gate below is HEADER auth
    // (`Authorization: Bearer …`), and a browser navigating to /docs cannot send
    // one — so Swagger UI is not usable in a production browser at all, and
    // dropping CSP for it there bought nothing while removing a header from a
    // surface that serves HTML. In production the in-app Reference is the
    // product (it fetches /openapi.json with the session it already holds); see
    // docs/api/CHANGELOG.md. Registering the UI anyway keeps /docs a 401 rather
    // than a 404 for an authenticated tool that does send the header.
    if (deps.isProduction || !request.url.startsWith("/docs")) {
      reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    }
    return payload;
  });

  // HTTP request metrics — every response, gated route or not.
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
  });

  // ONE principal preHandler for the whole app: it owns the per-key rate-limit
  // and failed-attempt counters, so the docs gate below and every /api/v1 route
  // must share this instance rather than each build its own.
  const principal = requirePrincipal(deps);

  // The OpenAPI document is ALWAYS generated (EN-D1): the in-app developer
  // portal renders from it and the contract test reads it, so it cannot be
  // conditional on the environment. What production changes is EXPOSURE, not
  // existence — see the gated plugin below.
  await app.register(swagger, openapiConfig(deps.publicApiUrl));

  // Shared schema components (referenced by routes via $ref and by OpenAPI).
  for (const component of components) app.addSchema(component);

  app.setErrorHandler(errorHandler);

  /**
   * Docs surface: the raw OpenAPI 3 document plus Swagger UI.
   *
   * Both live in ONE encapsulated plugin so a single preHandler covers them.
   * An UNAUTHENTICATED spec is a recon aid — it enumerates every route, every
   * field name and every error code to anyone who asks — while an
   * AUTHENTICATED one is the product an integrator was sold. So in production
   * we require a principal; outside it, the docs stay open because that is what
   * makes local development and the demo scripts usable.
   *
   * The gate reuses `principal` — the very preHandler every /api/v1 route runs.
   * There is deliberately no second authentication path here: a docs-only
   * credential check would be a second place for the session rules (expiry,
   * deactivated users, revoked keys) to drift out of agreement with the API's.
   * A machine caller's API key is accepted too; reading the document is the one
   * thing every key holder legitimately needs to do.
   */
  await app.register(async (docs) => {
    if (deps.isProduction) docs.addHook("preHandler", principal);
    await docs.register(swaggerUi, { routePrefix: "/docs" });
    docs.get("/openapi.json", { schema: { hide: true } }, async () => docs.swagger());
  });

  registerHealthRoutes(app, deps);

  await app.register(
    async (instance) => {
      /**
       * THE PRODUCT BOUNDARY.
       *
       * `ENABLED_DOMAINS` used to reach exactly one route — `GET /config`, which
       * tells the console which navigation to draw. Every identity route still
       * answered on a deployment that had switched identity off, so "deploy the
       * two products separately" was a menu item, not a boundary. This hook is
       * the boundary, and it lives HERE rather than on 131 route registrations
       * for the same reason the mode gate does: one chokepoint cannot be
       * forgotten by the next route someone adds.
       *
       * `onRoute` fires once per route AT REGISTRATION, so an unclassified route
       * fails the BOOT rather than a request. That is deliberate and is the
       * whole anti-drift story: a test can be forgotten, a server that refuses
       * to start cannot.
       *
       * A disabled route keeps its existing preHandler chain and only loses its
       * handler, so an ANONYMOUS caller still gets the 401 it got before —
       * turning off a product must not hand out a free oracle for which
       * products a deployment runs. An authenticated caller gets 404 with a
       * distinct code, because "this instance does not serve that product" is
       * something an integrator has to be able to tell from "your id was wrong".
       * It is hidden from the OpenAPI document too: a published surface that
       * advertises routes which cannot answer is a lie told at scale.
       */
      instance.addHook("onRoute", (route) => applyDomainGate(route, deps.enabledDomains));
      registerRoutes(instance, deps, principal);
    },
    { prefix: "/api/v1" },
  );

  return app;
}
