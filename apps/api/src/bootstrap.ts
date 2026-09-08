import { startTracing } from "./shared/tracing.js";
import { env } from "./env.js";

// MUST run before ./server.js (and therefore ./app.js, fastify, undici) is
// ever imported — see this task's "Mechanical note" in the plan for why a
// dynamic import is what actually achieves that under ESM.
startTracing({ serviceName: env.otelServiceName, otlpEndpoint: env.otelExporterOtlpEndpoint });

await import("./server.js");
