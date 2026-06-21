import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppDeps } from "./context.js";
import { components } from "./http/schemas.js";
import { registerRoutes } from "./http/routes.js";
import { errorHandler } from "./http/support.js";

/**
 * Builds the HTTP surface: a versioned (/api/v1), schema-validated, OpenAPI 3
 * documented REST API over the platform's domain services. All dependencies are
 * injected so the same app runs over Prisma (production) or in-memory repos
 * (tests/demo).
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: deps.jwtSecret });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "TokenLayer API",
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
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  // Shared schema components (referenced by routes via $ref and by OpenAPI).
  for (const component of components) app.addSchema(component);

  app.setErrorHandler(errorHandler);

  await app.register(
    async (instance) => {
      registerRoutes(instance, deps);
    },
    { prefix: "/api/v1" },
  );

  // Raw OpenAPI 3 document (also available via Swagger UI at /docs).
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  return app;
}
