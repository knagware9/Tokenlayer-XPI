import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../context.js";
import { registry } from "../../shared/metrics.js";

/**
 * Liveness/readiness/metrics — registered outside the JWT-gated /api/v1
 * surface (Prometheus and container healthchecks can't do a login flow).
 * `/metrics` is still not left open: when METRICS_TOKEN is set, a mismatch
 * or missing bearer token 401s, mirroring SENTRY_DSN's opt-in-via-env-var
 * shape elsewhere in this codebase.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: Pick<AppDeps, "users" | "metricsToken">): void {
  app.get("/health", { schema: { hide: true } }, async () => ({ status: "ok" }));

  app.get("/ready", { schema: { hide: true } }, async (_request, reply) => {
    try {
      // A real indexed lookup for the Prisma-backed repository (fails if the
      // DB is unreachable); trivially resolves null for the in-memory one.
      await deps.users.findByEmail("__healthcheck__@internal");
      return reply.code(200).send({ status: "ok" });
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.get("/metrics", { schema: { hide: true } }, async (request, reply) => {
    if (deps.metricsToken) {
      const header = request.headers.authorization;
      if (header !== `Bearer ${deps.metricsToken}`) {
        return reply.code(401).send({ error: "UNAUTHORIZED" });
      }
    }
    reply.header("Content-Type", registry.contentType);
    return reply.send(await registry.metrics());
  });
}
