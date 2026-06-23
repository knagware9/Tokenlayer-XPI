import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppDeps } from "./context.js";
import { components } from "./http/schemas.js";
import { registerRoutes } from "./http/routes.js";
import { errorHandler } from "./http/support.js";

/** JWT lifetime — tokens expire so a leaked/stale token is not valid forever. */
const TOKEN_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours

/**
 * Builds the HTTP surface: a versioned (/api/v1), schema-validated, OpenAPI 3
 * documented REST API over the platform's domain services. All dependencies are
 * injected so the same app runs over Prisma (production) or in-memory repos
 * (tests/demo).
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // 256 KB body cap — bounds payload-size abuse.
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

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
    // Strict CSP for the JSON API; Swagger UI (dev-only) needs a relaxed policy, so skip it there.
    if (!request.url.startsWith("/docs")) reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });

  // API docs are a recon aid — expose only outside production.
  if (!deps.isProduction) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "XI Tokenize API",
          version: "1.0.0",
          description:
            "Chain-agnostic asset-tokenization REST API: configure use cases, issue assets across DLTs and token standards (ERC-20/721/3643), run the compliance-aware lifecycle, and read holders + audit trail.",
        },
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
        },
        tags: [
          { name: "Auth", description: "Authentication" },
          { name: "Catalog", description: "Chains and accounts" },
          { name: "Use Cases", description: "Low-code asset-type definitions" },
          { name: "Assets", description: "Tokenized asset issuance and queries" },
          { name: "Lifecycle", description: "Mint / transfer / burn / freeze / allow" },
          { name: "Users", description: "Scoped user provisioning" },
        ],
      },
    });
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  // Shared schema components (referenced by routes via $ref and by OpenAPI).
  for (const component of components) app.addSchema(component);

  app.setErrorHandler(errorHandler);

  await app.register(
    async (instance) => {
      registerRoutes(instance, deps);
    },
    { prefix: "/api/v1" },
  );

  // Raw OpenAPI 3 document — only when docs are enabled (non-production).
  if (!deps.isProduction) {
    app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  }

  return app;
}
