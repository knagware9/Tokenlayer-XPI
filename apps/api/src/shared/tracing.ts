import { NodeSDK } from "@opentelemetry/sdk-node";
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { SpanStatusCode, trace } from "@opentelemetry/api";

/**
 * No-op unless otlpEndpoint is set — same posture as Sentry (SENTRY_DSN) and
 * /metrics (METRICS_TOKEN). FastifyInstrumentation auto-traces server
 * requests; UndiciInstrumentation auto-traces outbound fetch() (covers the
 * webhook dispatcher). Ledger RPC calls are deliberately NOT covered here —
 * see instrumentLedgerAdapter in metrics.ts, which opens ledger spans itself
 * (Task 8) because ledger transport varies per chain family in ways no
 * HTTP-level instrumentation package can uniformly catch.
 */
export function startTracing(opts: { serviceName: string; otlpEndpoint: string | undefined }): NodeSDK | undefined {
  if (!opts.otlpEndpoint) return undefined;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${opts.otlpEndpoint}/v1/traces` }),
    instrumentations: [new FastifyInstrumentation(), new UndiciInstrumentation()],
  });
  sdk.start();
  return sdk;
}

/**
 * Runs fn inside a new active span, ending it (and recording any exception)
 * regardless of outcome. Safe to call even when startTracing() was never
 * invoked (e.g. in tests, or a deployment with tracing off) — @opentelemetry/api
 * falls back to a no-op tracer provider by default, so this never throws on
 * its own account.
 *
 * `trace.getTracer(...)` is called fresh on every invocation rather than
 * once at module scope. A ProxyTracer obtained before a real provider is
 * registered binds to that provider's identity at call time; capturing one
 * eagerly at import time risks binding to a since-orphaned proxy if the
 * module that performs the real registration (e.g. NodeTracerProvider via a
 * bundler/SSR-deduped copy of @opentelemetry/api) isn't the exact instance
 * this module resolved. Calling getTracer() per span is the cost of one
 * cheap lookup and sidesteps the hazard entirely.
 */
export async function withSpan<T>(name: string, attributes: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const tracer = trace.getTracer("tokenlayer-api");
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
