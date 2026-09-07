# Production Observability (Metrics, Tracing, Logging, Alerting) — Design

**Status:** approved by user 2026-09-07 (sectioned design approved in chat), pending spec self-review sign-off
**Scope:** give every deployment of the API a live health signal and a page-someone-on-failure path — metrics, distributed tracing, structured logs, and alerting — self-hosted, layered onto the existing docker-compose topologies the same way the Phase 0 Caddy TLS overlay is. This is the enterprise-readiness gap identified after the asset due-diligence work: the platform has an audit trail for compliance (who approved what, on-chain anchoring) but nothing that reports "is the system healthy right now" or wakes anyone up when it isn't.

## Why

Three things are true about the API today, found while scoping this:

- Fastify's logger is fully disabled (`Fastify({ logger: false, ... })` in `apps/api/src/app.ts:32`) — there are no structured request logs at all, only scattered manual `app.log.error(...)` calls at individual call sites.
- `apps/api/src/shared/observability.ts` wraps Sentry for error tracking only, explicitly scoped as "pilot-scale... no performance tracing" — it catches exceptions, but says nothing about request latency, throughput, or whether a dependency (a ledger RPC endpoint, the database) is degraded before it starts throwing.
- There is no `/health`, `/ready`, or `/metrics` endpoint anywhere in the API. Nothing external can ask "are you okay" — Docker Compose has no healthcheck target to poll, and there is no way to alert on elevated error rates or ledger connectivity short of reading someone's manually-written log line after the fact.

## Non-goals

- Instrumenting the Besu/Fabric nodes themselves — only the API's own processes are trace/metric producers. A chain node shows up as the *target* of an RPC-call span/metric (duration, success/failure), never as something with its own internal spans.
- Any SaaS backend (Datadog, Grafana Cloud, etc.) — rejected up front given the PII-isolation stance `observability.ts`'s `scrubEvent` already establishes for Sentry; this stays entirely self-hosted.
- An OpenTelemetry Collector — each pillar talks directly to its own backend (Prometheus scrapes `/metrics`, traces export straight to Tempo, Promtail tails Docker's own log files) rather than through a unified collector. A collector is a reasonable future addition if backend flexibility becomes valuable; not built speculatively now.
- PagerDuty or any phone/SMS paging — Slack + email only, per the explicit routing choice. Real on-call paging is deferred until there's an actual on-call rotation to page.
- Metrics or alert rules for mail delivery, webhook delivery, or generic DB/repository error rates — not selected as initial alert priorities. Can be added later following the exact pattern this spec establishes (a counter + an Alertmanager rule), not a reason to add unused metrics now.
- Dynamic, automatic Prometheus service discovery across all 8 docker-compose topologies at once — the observability overlay always targets exactly *one* already-running topology, selected via a static per-topology config file (see section E), not auto-discovered. Nothing here runs all 8 topologies simultaneously in practice.
- Sampling or retention tuning — always-on trace/metric capture at today's pilot-scale traffic. A future tuning pass once real volume/cost data exists.
- Touching `observability.ts`'s existing Sentry wiring or any of its call sites — it stays exactly as-is; this spec adds new, separate pillars alongside it.

## A. Metrics

New `apps/api/src/shared/metrics.ts` builds one `prom-client` `Registry`:

```ts
export const registry = new Registry();
collectDefaultMetrics({ register: registry }); // Node process metrics: event-loop lag, heap, GC

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});
export const ledgerRpcErrorsTotal = new Counter({
  name: "ledger_rpc_errors_total",
  help: "Ledger adapter calls that threw",
  labelNames: ["chain", "operation"],
  registers: [registry],
});
export const ledgerRpcDuration = new Histogram({
  name: "ledger_rpc_duration_seconds",
  help: "Ledger adapter call duration in seconds",
  labelNames: ["chain", "operation"],
  registers: [registry],
});
export const proposalPendingTotal = new Gauge({
  name: "proposal_pending_total",
  help: "Currently pending proposals",
  labelNames: ["kind"],
  registers: [registry],
});
export const proposalPendingAgeSecondsMax = new Gauge({
  name: "proposal_pending_age_seconds_max",
  help: "Age in seconds of the oldest pending proposal",
  labelNames: ["kind"],
  registers: [registry],
});
```

**HTTP metrics** are recorded by an `onResponse` hook added in `app.ts` next to the existing security-header `onSend` hook: `httpRequestDuration.observe({ method, route, status_code }, seconds)` and `httpRequestsTotal.inc(...)`, where `route` comes from `request.routeOptions.url` (the route *template*, e.g. `/assets/:id`) rather than `request.url` — this keeps label cardinality bounded regardless of how many distinct asset/user IDs are hit.

**Ledger metrics** are recorded at a single choke point rather than inside each of the four `LedgerAdapter` implementations (`EvmLedgerAdapter`, `FabricLedgerAdapter`, `CantonLedgerAdapter`, the simulated adapter): `resolveAdapter(chainId)` in `apps/api/src/shared/chains.ts:168` is where every caller obtains a `LedgerAdapter`, so a new `instrumentLedgerAdapter(adapter: LedgerAdapter): LedgerAdapter` in `metrics.ts` wraps every method on the returned object — a `Proxy` (or explicit per-method wrapping, given `LedgerAdapter` is a fixed, fully-listed interface) that times the call, increments `ledgerRpcDuration`/labels it `{chain: adapter.chainId, operation: <method name>}`, and on rejection also increments `ledgerRpcErrorsTotal` before rethrowing. `resolveAdapter` returns the wrapped adapter; every existing call site (mint, transfer, balance checks, anchoring) is instrumented for free with zero changes to adapter internals or call sites.

This wrapper is also where ledger *tracing* attaches (see section B) — deliberately, not via generic HTTP auto-instrumentation. The four chain families don't share a transport: `EvmLedgerAdapter` calls out over `ethers` v6's `JsonRpcProvider`, which is `fetch`-based (undici), not Node's core `http` module; `FabricLedgerAdapter` (`fabric-network`) goes over gRPC; a transport-level instrumentation package would have to correctly match each one, and would still miss Canton/simulated entirely. Wrapping at the `LedgerAdapter` interface boundary sidesteps all of that — one wrapper, correct regardless of what any given chain family does underneath.

**Proposal backlog gauges** are refreshed by a standalone, directly-testable function:

```ts
export async function refreshProposalBacklogMetrics(proposals: ProposalRepository): Promise<void> {
  const pending = await proposals.list(undefined, "pending"); // platform-wide, newest first
  const byKind = new Map<string, { count: number; oldestMs: number }>();
  const now = Date.now();
  for (const p of pending) {
    const ageMs = now - new Date(p.createdAt).getTime();
    const entry = byKind.get(p.kind) ?? { count: 0, oldestMs: 0 };
    entry.count += 1;
    entry.oldestMs = Math.max(entry.oldestMs, ageMs);
    byKind.set(p.kind, entry);
  }
  proposalPendingTotal.reset();
  proposalPendingAgeSecondsMax.reset();
  for (const [kind, { count, oldestMs }] of byKind) {
    proposalPendingTotal.set({ kind }, count);
    proposalPendingAgeSecondsMax.set({ kind }, oldestMs / 1000);
  }
}
```

Called on a 30s `setInterval` started in `server.ts` alongside the app's other boot-time setup — deliberately not computed synchronously inside the `/metrics` handler, so a scrape stays cheap regardless of proposal volume. Reuses `ProposalRepository.list(useCaseKey?, status?)` exactly as it exists today (`apps/api/src/persistence/types/shared.ts:249`) — no new repository method.

**New endpoints**, registered in `app.ts` outside the existing JWT-gated `/api/v1` surface (alongside where CORS/JWT/security-header plugins are wired, before `registerRoutes`):

- `GET /health` — liveness; 200 once the process is up. Usable as a Docker Compose `healthcheck:` target.
- `GET /ready` — readiness; 200 once a trivial DB query succeeds, 503 otherwise. No boot-time DB ping exists anywhere in this codebase today to reuse, and `AppDeps` exposes only repository interfaces, never a raw Prisma client — so this calls `deps.users.findByEmail("__healthcheck__@internal")` (`UserRepository`, `apps/api/src/persistence/types/shared.ts:80`, present in `AppDeps` regardless of which product domains are enabled). For the Prisma-backed repository this is a real indexed lookup that fails if the DB is unreachable; for the in-memory repository (tests/demo) it trivially resolves `null`. Any rejection is caught and returns 503.
- `GET /metrics` — `registry.metrics()` in Prometheus text format. Not behind the app's JWT gate (Prometheus cannot do a login flow), but not left open either: when a new `METRICS_TOKEN` env var is set, the route's own `preHandler` 401s unless `Authorization: Bearer <METRICS_TOKEN>` matches — same opt-in-via-env-var shape `SENTRY_DSN` already uses in `env.ts`. When `METRICS_TOKEN` is unset (local dev/tests), the route is open, matching how Sentry is a no-op unset.

## B. Tracing

New `apps/api/src/shared/tracing.ts` bootstraps `@opentelemetry/sdk-node`:

```ts
export function startTracing(opts: { serviceName: string; otlpEndpoint: string | undefined }): NodeSDK | undefined {
  if (!opts.otlpEndpoint) return undefined; // no-op when unset, same posture as Sentry
  const sdk = new NodeSDK({
    resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: opts.serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${opts.otlpEndpoint}/v1/traces` }),
    instrumentations: [new FastifyInstrumentation(), new UndiciInstrumentation()],
  });
  sdk.start();
  return sdk;
}
```

`FastifyInstrumentation` produces one server span per request. `UndiciInstrumentation` (not `HttpInstrumentation`, which only patches Node's core `http`/`https` modules) auto-traces outbound `fetch` calls — this covers the webhook dispatcher (`apps/api/src/webhooks/dispatcher.ts:141`, a plain `fetch()` call) for free. It deliberately does **not** cover ledger RPC calls, even though `EvmLedgerAdapter` also happens to use `fetch` under the hood: ledger spans come from the same `instrumentLedgerAdapter` wrapper described in section A instead, since that wrapper is correct for every chain family's transport (including Fabric's gRPC, which no HTTP-level instrumentation would ever see) while auto-instrumentation is not. `instrumentLedgerAdapter` additionally opens a span per operation (`tracer.startActiveSpan(\`ledger.${operation}\`, { attributes: { chain, operation } }, ...)`, ended in the same `finally` that records the metric) alongside the counter/histogram it already records.

Mechanical requirement: this has to run **before** anything it instruments is imported, so `server.ts`'s very first lines call `startTracing(...)` ahead of importing `./app.js` — not a regular import inside `app.ts` itself, which would already be too late.

New env vars (`env.ts`): `OTEL_SERVICE_NAME` (e.g. `tokenlayer-api-tokenization`, `tokenlayer-api-identity`, `tokenlayer-api-main` — set per compose topology so Tempo can distinguish which of the 8 topologies a trace came from) and `OTEL_EXPORTER_OTLP_ENDPOINT` (Tempo's OTLP HTTP endpoint, e.g. `http://tempo:4318`, unset by default so tracing stays off unless explicitly configured — same no-op-unless-configured posture as Sentry and `METRICS_TOKEN`).

On top of the auto-instrumented spans, explicit spans wrap the maker-checker decision paths that most benefit from being visible as a distinct unit of work: `POST /assets/:id/review-decision` and the `ISSUE-USECASE-CREDENTIAL`/`ONBOARD-USER` proposal executors. Each uses `tracer.startActiveSpan(name, ...)` with attributes limited to `proposal.kind`, `decision` (`approved`/`rejected`), and counts — **never** request bodies, emails, or DIDs. Auto-instrumentation doesn't capture bodies by default, so this rule only binds the handful of custom spans this spec adds; it mirrors the same posture `scrubEvent` already enforces for Sentry and the metric labels in section A.

Sampling: `AlwaysOnSampler` (every request traced) — pilot-scale traffic; probabilistic sampling is a tuning knob for later, not built speculatively now (see Non-goals).

## C. Structured logging

`apps/api/src/app.ts:32` changes from `Fastify({ logger: false, ... })` to a configured pino instance: JSON output, level from a new `LOG_LEVEL` env var (default `"info"`), with two additions:

1. **Redaction.** `packages/core/src/shared/pii-scrub.ts` currently keeps its field-name deny-list (`SENSITIVE_KEY_FRAGMENTS`) and recursive `scrubValue` private to `scrubEvent`. This spec exports a generic wrapper:
   ```ts
   export function redactSensitiveFields<T>(value: T): T {
     return scrubValue(value, 0) as T;
   }
   ```
   and wires it into pino's `formatters.log` hook in the new logger config, so every logged object is redacted against the *same* deny-list Sentry already uses — one shared source of truth, not a second list to keep in sync. Fastify's default `req` serializer already omits the body (only method/URL/headers/hostname/remoteAddress), so the residual risk this closes is an ad-hoc call site like `app.log.error({ err, useCaseKey, assetName }, ...)` (seen throughout the route files today) ever passing a raw user/credential object — `useCaseKey`/`assetName` themselves aren't sensitive per the deny-list and pass through unredacted, but an `email` or `kyc` field anywhere in a logged object now comes out `[Redacted]` automatically.

2. **Correlation.** A `mixin()` reads the OpenTelemetry API's active span context (`trace.getSpan(context.active())?.spanContext()`) and injects `trace_id`/`span_id` into every log line when tracing is active, so a Grafana log line links straight to its Tempo trace (Loki↔Tempo derived-field linking, configured in the Grafana datasource provisioning in section E). Fastify's own per-request ID is logged too, independent of tracing being enabled.

Shipping needs no application code: Docker's default `json-file` log driver already writes each container's stdout to disk; Promtail's Docker service-discovery config (section E) tails those files directly and auto-labels each line with container name and compose project.

## D. Alerting

A Prometheus rule file (`deploy/observability/alert-rules.yml`) evaluated in-cluster, routed by Alertmanager (`deploy/observability/alertmanager.yml`) to Slack (webhook) and email (SMTP):

```yaml
groups:
  - name: api-health
    rules:
      - alert: APIDown
        expr: up{job="tokenlayer-api"} == 0
        for: 1m
        labels: { severity: critical }
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status_code=~"5.."}[5m]))
          / sum(rate(http_requests_total[5m])) > 0.05
        for: 5m
        labels: { severity: critical }
      - alert: HighLatency
        expr: histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route)) > 2
        for: 5m
        labels: { severity: warning }
  - name: ledger
    rules:
      - alert: LedgerRPCFailures
        expr: sum(rate(ledger_rpc_errors_total[2m])) by (chain) > 0
        for: 2m
        labels: { severity: critical }
  - name: proposals
    rules:
      - alert: ProposalBacklogAging
        expr: proposal_pending_age_seconds_max > 86400
        for: 5m
        labels: { severity: warning }
      - alert: ProposalBacklogSize
        expr: proposal_pending_total > 20
        for: 5m
        labels: { severity: warning }
```

`LedgerRPCFailures` is deliberately strict (any sustained nonzero failure rate, not a percentage threshold) — a mint/transfer silently failing to reach the chain is severe and easy to miss, matching the reasoning that picked this as an alert priority in the first place. `ProposalBacklogAging`/`Size` fire warning, not critical — a stalled approval queue is a business-process problem to notice within the day, not a 3am page.

Alertmanager routing: `severity: critical` → Slack (immediate) + email; `severity: warning` → Slack only, grouped (`group_wait: 30s`) with a `repeat_interval: 4h` for anything still unresolved, so a slow-moving signal like backlog aging doesn't repost every evaluation cycle. The Slack webhook URL and SMTP relay are supplied via env vars at `docker compose up` time (`SLACK_WEBHOOK_URL`, `ALERTMANAGER_SMTP_*`) — no default, since there's no shared value to fall back to.

## E. Deployment topology & dashboards

New `docker-compose.observability.yml` adds six services — Prometheus, Grafana, Loki, Promtail, Tempo, Alertmanager, each with a named persistent volume — started as an overlay on top of exactly one already-running app stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

This never runs standalone, the same way the Phase 0 Caddy TLS overlay (`deploy/tls/Caddyfile`) never does.

Prometheus scrape targets differ by topology (main vs. the identity/tokenization split vs. persona-edge containers), so rather than build dynamic service discovery, this follows the repo's existing convention of one static config per known topology — `deploy/observability/prometheus.main.yml`, `prometheus.identity.yml`, `prometheus.tokenization.yml`, `prometheus.personas.yml` — selected via a `PROMETHEUS_CONFIG_FILE` env var the overlay bind-mounts in (default `prometheus.main.yml`). Each file's `scrape_configs` lists the known service hostnames for that topology on the shared Docker network, with `authorization: { credentials: "${METRICS_TOKEN}" }` when set. Every scrape config across every topology file uses the same `job_name: tokenlayer-api`, regardless of how many API instances that topology runs (a persona-split stack scrapes several) — instances are told apart by Prometheus's own `instance` label (host:port), not a different job name. This is what lets `APIDown`/`LedgerRPCFailures` in section D be a single rule that works unmodified no matter which topology file is mounted.

Grafana is provisioned as code, not click-ops: `deploy/observability/grafana/provisioning/datasources/` (Prometheus, Loki, Tempo, with Loki↔Tempo trace-ID linking configured) and `deploy/observability/grafana/provisioning/dashboards/` mount three starter dashboards, each tied directly to section D's alert rules:

- **API Overview** — request rate, p50/p95/p99 latency, and error rate, all broken down by route.
- **Ledger Health** — RPC error rate and duration per chain.
- **Maker-Checker Backlog** — pending proposal count and max age, per kind.

Promtail's config (`deploy/observability/promtail.yml`) uses Docker service discovery to tail every container's `json-file` log driver output on the shared network, labeling each line by container name and compose project — no per-app log-shipping code.

## Testing

- `GET /health`, `GET /ready` (DB up and DB down cases), and `GET /metrics` (with and without `METRICS_TOKEN` set — 401 on mismatch/missing when set, 200 when unset) via the existing `app.inject()` Vitest harness.
- `redactSensitiveFields`: new test cases alongside the existing `scrubEvent` tests in the `pii-scrub` test file, asserting the exported function redacts the same fields `scrubEvent` does on a plain object (not just the Sentry-event shape).
- A route hit through `app.inject()` increments `http_requests_total`/observes `http_request_duration_seconds` with the expected `{method, route, status_code}` labels — read back via `registry.getSingleMetric(...)`.
- `instrumentLedgerAdapter`: wrapping a stub `LedgerAdapter` whose `mint()` rejects increments `ledger_rpc_errors_total{chain, operation: "mint"}` and still rethrows the original error to the caller; a resolving call observes `ledger_rpc_duration_seconds` and does not increment the error counter.
- `refreshProposalBacklogMetrics`: given a `ProposalRepository` (the in-memory test double) seeded with pending proposals of known `kind`/`createdAt` across two kinds, asserts `proposal_pending_total`/`proposal_pending_age_seconds_max` are set correctly per kind, and that a kind with zero pending proposals is not left at a stale nonzero value after a repeat call (the `reset()` calls in section A's implementation are what this test is actually checking).
- Pino redaction: capture the logger's output stream in a test, log a synthetic object containing an `email` field, assert the serialized line contains `"[Redacted]"` and not the original value.
- Tracing: `InMemorySpanExporter` (from `@opentelemetry/sdk-trace-base`) swapped in for the OTLP exporter in test config; asserts the custom `review-decision` span exists with `proposal.kind`/`decision` attributes after exercising that route.
- Live verification once implemented: bring the observability overlay up on `docker-compose.yml` (the main topology) in the Browser pane, generate traffic against a few routes, confirm all three Grafana dashboards populate; deliberately break ledger connectivity (stop the Besu container, or force one adapter call to fail) and confirm `LedgerRPCFailures` reaches `firing` in Alertmanager. Actual Slack delivery needs a webhook URL supplied at deploy time — routing to it is verified, but confirming the message lands in a real Slack channel is a check the user performs, not something reproducible in this environment.
