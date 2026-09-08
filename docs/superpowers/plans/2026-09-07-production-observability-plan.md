# Production Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every deployment of the TokenLayer API a live health signal and a page-someone-on-failure path: self-hosted metrics, distributed tracing, structured logs, and Prometheus/Alertmanager-driven alerting to Slack and email.

**Architecture:** Each pillar talks directly to its own backend — no collector. `prom-client` exposes `/metrics` for Prometheus to scrape; `@opentelemetry/sdk-node` exports traces straight to Tempo over OTLP; pino (re-enabled) writes JSON to stdout for Promtail to tail into Loki. A new `docker-compose.observability.yml` overlay (Prometheus, Grafana, Loki, Promtail, Tempo, Alertmanager) layers onto whichever app topology is already running, the same way the Phase 0 Caddy TLS overlay does.

**Tech Stack:** Fastify 5, TypeScript, Vitest, `prom-client`, `@opentelemetry/sdk-node` + `@opentelemetry/api`, pino (via Fastify's built-in logger), Prometheus, Grafana, Loki, Promtail, Tempo, Alertmanager, Docker Compose.

**Spec:** [docs/superpowers/specs/2026-09-07-production-observability-design.md](../specs/2026-09-07-production-observability-design.md) — read it alongside this plan; this plan does not repeat the spec's rationale, only what to build.

## Global Constraints

- Self-hosted only — no SaaS backend (Datadog, Grafana Cloud). No OpenTelemetry Collector — each pillar exports directly to its own backend.
- Every new pillar is a no-op unless explicitly configured via an env var (mirrors `SENTRY_DSN`'s existing posture): `METRICS_TOKEN` unset → `/metrics` is open (dev/tests); `OTEL_EXPORTER_OTLP_ENDPOINT` unset → tracing SDK never starts.
- No request/response bodies, emails, or DIDs ever become a metric label, span attribute, or log field without going through `redactSensitiveFields` (Task 1) first. Metric labels are restricted by construction (method/route/status/chain/operation/kind — never free text) rather than by redaction.
- No PagerDuty, no phone paging. Alertmanager routes to Slack + email only.
- Slack webhook URL and SMTP relay for Alertmanager have no default value — they are required env vars at `docker compose up` time for the observability overlay, not silently skipped.

---

## File Structure

**New:**
- `packages/core/src/shared/pii-scrub.ts` (modified) — exports `redactSensitiveFields`
- `apps/api/src/shared/metrics.ts` — prom-client registry, HTTP/ledger/proposal metrics, `instrumentLedgerAdapter`, `refreshProposalBacklogMetrics`
- `apps/api/src/http/routes/health.ts` — `/health`, `/ready`, `/metrics`
- `apps/api/src/shared/tracing.ts` — `startTracing`, `withSpan`
- `apps/api/src/bootstrap.ts` — the real process entry point (starts tracing, then dynamically imports `server.ts`)
- `deploy/observability/alert-rules.yml` — Prometheus alert rules
- `deploy/observability/alertmanager.yml` — Alertmanager routing config
- `deploy/observability/prometheus.main.yml`, `prometheus.identity.yml`, `prometheus.tokenization.yml` — per-topology scrape configs
- `deploy/observability/promtail.yml` — Docker log discovery config
- `deploy/observability/grafana/provisioning/datasources/datasources.yml`
- `deploy/observability/grafana/provisioning/dashboards/dashboards.yml`
- `deploy/observability/grafana/dashboards/api-overview.json`, `ledger-health.json`, `proposal-backlog.json`
- `docker-compose.observability.yml` — the 6-service overlay

**Modified:**
- `apps/api/src/app.ts` — logger config, HTTP metrics hook, health route registration
- `apps/api/src/context.ts` — `AppDeps` gains `metricsToken?: string`
- `apps/api/src/env.ts` — `LOG_LEVEL`, `METRICS_TOKEN`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`
- `apps/api/src/shared/chains.ts` — `resolveAdapter` wraps its return value with `instrumentLedgerAdapter`
- `apps/api/src/shared/proposal-kinds.ts` — `registerProposalKind` wraps `execute` with a trace span
- `apps/api/src/http/routes/tokenization.ts` — `review-decision` handler wraps its decision branch with a trace span
- `apps/api/src/server.ts` — starts the 30s proposal-backlog refresh interval
- `apps/api/package.json` — `dev`/`start` scripts point at `bootstrap.ts`; new dependencies
- `apps/api/Dockerfile` — CMD's final `tsx` target changes to `bootstrap.ts`
- `docker-compose.yml` — names its default network (`tokenlayer-main`) so the observability overlay can join it by a stable name

---

### Task 1: Shared PII redaction, exported for reuse beyond Sentry

**Files:**
- Modify: `packages/core/src/shared/pii-scrub.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/pii-scrub.test.ts`

**Interfaces:**
- Produces: `redactSensitiveFields<T>(value: T): T` — exported from `@tokenlayer/core`. Used by Task 6 (pino log redaction).

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/pii-scrub.test.ts`:

```ts
import { redactSensitiveFields, scrubEvent } from "../src/index.js";

describe("redactSensitiveFields", () => {
  it("redacts the same fields scrubEvent does, on a plain object (no Sentry-event shape required)", () => {
    const input = {
      email: "alice@example.com",
      assetName: "Gold Bar #12",
      nested: { kyc: { panNumber: "ABCDE1234F" }, useCaseKey: "carbon-credit" },
    };
    const out = redactSensitiveFields(input);
    expect(out.email).toBe("[Redacted]");
    expect(out.assetName).toBe("Gold Bar #12");
    expect((out.nested as Record<string, unknown>).kyc).toBe("[Redacted]");
    expect((out.nested as Record<string, unknown>).useCaseKey).toBe("carbon-credit");
  });

  it("leaves non-object values (primitives, arrays of primitives) untouched", () => {
    expect(redactSensitiveFields("hello")).toBe("hello");
    expect(redactSensitiveFields(42)).toBe(42);
    expect(redactSensitiveFields(null)).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenlayer/core test -- pii-scrub`
Expected: FAIL — `redactSensitiveFields` is not exported from `../src/index.js`.

- [ ] **Step 3: Implement**

In `packages/core/src/shared/pii-scrub.ts`, add below `scrubValue` (the function already exists, private to this file):

```ts
/**
 * The same field-name deny-list `scrubEvent` uses, exposed as a plain
 * value → value redactor. Used anywhere PII risk exists outside a Sentry
 * event shape — structured logs and trace attributes, notably.
 */
export function redactSensitiveFields<T>(value: T): T {
  return scrubValue(value, 0) as T;
}
```

In `packages/core/src/index.ts`, change line 25 from:
```ts
export { scrubEvent, type ScrubbableEvent } from "./shared/pii-scrub.js";
```
to:
```ts
export { redactSensitiveFields, scrubEvent, type ScrubbableEvent } from "./shared/pii-scrub.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tokenlayer/core test -- pii-scrub`
Expected: PASS (all `pii-scrub.test.ts` tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/shared/pii-scrub.ts packages/core/src/index.ts packages/core/test/pii-scrub.test.ts
git commit -m "feat(observability): export redactSensitiveFields for reuse beyond Sentry"
```

---

### Task 2: Metrics registry, HTTP request metrics, and /health, /ready, /metrics

**Files:**
- Create: `apps/api/src/shared/metrics.ts`
- Create: `apps/api/src/http/routes/health.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/context.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/package.json`
- Test: `apps/api/test/health.test.ts`

**Interfaces:**
- Produces: `registry: Registry`, `httpRequestDuration: Histogram`, `httpRequestsTotal: Counter` from `metrics.ts` — consumed by Task 3 and Task 4 (same file, extended there) and by `app.ts`'s new `onResponse` hook.
- Produces: `registerHealthRoutes(app: FastifyInstance, deps: Pick<AppDeps, "users" | "metricsToken">): void` from `health.ts`.
- Produces: `AppDeps.metricsToken?: string` — consumed by `health.ts` and set in `server.ts` (Task 2 wires the field; `server.ts`'s actual deps object already exists and gets one new line).
- Consumes: `env.metricsToken: string | undefined` (new in `env.ts`).

- [ ] **Step 1: Install prom-client**

```bash
pnpm add --filter @tokenlayer/api prom-client
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTestAppWithRepos } from "./helpers.js";

describe("GET /health", () => {
  it("200s once the process is up", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /ready", () => {
  it("200s once the DB (or in-memory store) answers", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
  });

  it("503s when the readiness check throws", async () => {
    const h = await buildTestAppWithRepos();
    h.deps.users.findByEmail = async () => {
      throw new Error("db unreachable");
    };
    const res = await h.app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
  });
});

describe("GET /metrics", () => {
  it("is open when METRICS_TOKEN is unset", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("401s without a matching bearer token when METRICS_TOKEN is set", async () => {
    const h = await buildTestAppWithRepos({ metricsToken: "secret-token" });
    const open = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(open.statusCode).toBe(401);
    const wrong = await h.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(401);
    const right = await h.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer secret-token" } });
    expect(right.statusCode).toBe(200);
  });
});
```

Check `apps/api/test/helpers.ts:86`'s `TestAppOptions` — add `metricsToken?: string` to that interface and thread it into the `AppDeps` object `buildTestAppWithRepos` constructs, exactly like the other optional test-only deps already there (find `webhooksAllowInsecure` or a similar boolean flag in that file's `TestAppOptions`/deps-building code for the pattern to copy).

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tokenlayer/api test -- health`
Expected: FAIL — no route registered for `/health`, `/ready`, or `/metrics` (404s), and `TestAppOptions` has no `metricsToken` field yet (TypeScript error).

- [ ] **Step 4: Implement metrics.ts**

Create `apps/api/src/shared/metrics.ts`:

```ts
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

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
```

- [ ] **Step 5: Implement env.ts, context.ts additions**

In `apps/api/src/env.ts`, inside the `export const env: Env = { ... }` object (near `sentryDsn`), add:

```ts
  metricsToken: process.env.METRICS_TOKEN?.trim() || undefined,
```

Add `metricsToken?: string;` to the `Env` interface in the same file, next to `sentryDsn`.

In `apps/api/src/context.ts`, add `metricsToken?: string;` to the `AppDeps` interface, next to `webhooksAllowInsecure` or another optional config field.

In `apps/api/src/server.ts`, inside the `const deps: AppDeps = { ... }` object literal, add:

```ts
    metricsToken: env.metricsToken,
```

- [ ] **Step 6: Implement health.ts**

Create `apps/api/src/http/routes/health.ts`:

```ts
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
```

- [ ] **Step 7: Wire the HTTP metrics hook and route registration into app.ts**

In `apps/api/src/app.ts`, add near the top imports:

```ts
import { httpRequestDuration, httpRequestsTotal } from "./shared/metrics.js";
import { registerHealthRoutes } from "./http/routes/health.js";
```

Right after the `onSend` security-header hook (around line 63, after its closing `});`), add:

```ts
  // HTTP request metrics — every response, gated route or not.
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
  });
```

Right after the `/docs` plugin registration block (after its closing `});`, before the `/api/v1` registration block begins), add:

```ts
  registerHealthRoutes(app, deps);
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @tokenlayer/api test -- health`
Expected: PASS (all 5 tests).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/shared/metrics.ts apps/api/src/http/routes/health.ts apps/api/src/app.ts apps/api/src/context.ts apps/api/src/env.ts apps/api/test/health.test.ts apps/api/test/helpers.ts apps/api/package.json
git commit -m "feat(observability): metrics registry, HTTP request metrics, /health /ready /metrics"
```

---

### Task 3: Ledger adapter metrics — instrumentLedgerAdapter

**Files:**
- Modify: `apps/api/src/shared/metrics.ts`
- Modify: `apps/api/src/shared/chains.ts`
- Test: `apps/api/test/metrics.test.ts`

**Interfaces:**
- Consumes: `registry: Registry` (Task 2, same file).
- Produces: `instrumentLedgerAdapter(adapter: LedgerAdapter): LedgerAdapter` from `metrics.ts` — consumed by `chains.ts`'s `resolveAdapter` here, and extended (not replaced) by Task 8 to also open a trace span.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/metrics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { LedgerAdapter } from "@tokenlayer/core";
import { instrumentLedgerAdapter, ledgerRpcDuration, ledgerRpcErrorsTotal, registry } from "../src/shared/metrics.js";

function stubAdapter(overrides: Partial<LedgerAdapter> = {}): LedgerAdapter {
  return {
    chainId: "test-chain",
    family: "evm",
    deployAsset: async () => ({ address: "0x1" }) as never,
    mint: async () => ({ txHash: "0xabc" }) as never,
    transfer: async () => ({ txHash: "0xabc" }) as never,
    burn: async () => ({ txHash: "0xabc" }) as never,
    balanceOf: async () => "0",
    totalSupply: async () => "0",
    mintToken: async () => ({ txHash: "0xabc" }) as never,
    transferToken: async () => ({ txHash: "0xabc" }) as never,
    burnToken: async () => ({ txHash: "0xabc" }) as never,
    ownerOf: async () => null,
    tokensOf: async () => [],
    setFrozen: async () => ({ txHash: "0xabc" }) as never,
    setAllowed: async () => ({ txHash: "0xabc" }) as never,
    isFrozen: async () => false,
    isAllowed: async () => true,
    anchor: async () => ({ txHash: "0xabc" }) as never,
    ...overrides,
  };
}

describe("instrumentLedgerAdapter", () => {
  it("records duration and does not increment the error counter on success", async () => {
    const adapter = instrumentLedgerAdapter(stubAdapter());
    await adapter.balanceOf({ chainId: "test-chain", address: "0x1" } as never, "0xaccount");
    const errCount = (await registry.getSingleMetric(ledgerRpcErrorsTotal.name)?.get())?.values.find(
      (v) => v.labels.chain === "test-chain" && v.labels.operation === "balanceOf",
    );
    expect(errCount).toBeUndefined();
    const duration = (await registry.getSingleMetric(ledgerRpcDuration.name)?.get())?.values.find(
      (v) => v.labels.chain === "test-chain" && v.labels.operation === "balanceOf" && v.metricName?.endsWith("_count"),
    );
    expect(duration?.value).toBeGreaterThanOrEqual(1);
  });

  it("increments the error counter and rethrows on failure", async () => {
    const boom = new Error("rpc down");
    const adapter = instrumentLedgerAdapter(stubAdapter({ mint: async () => { throw boom; } }));
    await expect(adapter.mint({ chainId: "test-chain", address: "0x1" } as never, "0xto", "10")).rejects.toBe(boom);
    const errCount = (await registry.getSingleMetric(ledgerRpcErrorsTotal.name)?.get())?.values.find(
      (v) => v.labels.chain === "test-chain" && v.labels.operation === "mint",
    );
    expect(errCount?.value).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenlayer/api test -- metrics`
Expected: FAIL — `instrumentLedgerAdapter`, `ledgerRpcDuration`, `ledgerRpcErrorsTotal` are not exported from `metrics.ts`.

- [ ] **Step 3: Implement**

Add to `apps/api/src/shared/metrics.ts`:

```ts
import type { LedgerAdapter } from "@tokenlayer/core";

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

/**
 * Wraps every method on a LedgerAdapter with duration/error recording,
 * labeled by chain and operation (method name). Wrapping at this interface
 * boundary — rather than inside each of EvmLedgerAdapter/FabricLedgerAdapter/
 * CantonLedgerAdapter/the simulated adapter — is deliberate: the four chain
 * families don't share a transport (ethers v6 uses fetch/undici, fabric-network
 * uses gRPC), so a transport-level approach would need separate handling per
 * family. This is transport-agnostic by construction.
 */
// The fixed method list from the LedgerAdapter interface (packages/core/src/shared/types.ts:100).
// NOT Object.keys(adapter) — every implementation (EvmLedgerAdapter included) defines these as
// ordinary class methods on the prototype, not instance-field arrow functions, so Object.keys()
// on an instance would enumerate none of them (only own fields like chainId/family) and silently
// wrap nothing.
const LEDGER_ADAPTER_METHODS = [
  "deployAsset", "mint", "transfer", "burn", "balanceOf", "totalSupply",
  "mintToken", "transferToken", "burnToken", "ownerOf", "tokensOf",
  "setFrozen", "setAllowed", "isFrozen", "isAllowed", "anchor", "getReceipt",
] as const;

export function instrumentLedgerAdapter(adapter: LedgerAdapter): LedgerAdapter {
  const wrappedMethods = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  for (const key of LEDGER_ADAPTER_METHODS) {
    const value = adapter[key];
    if (typeof value !== "function") continue; // getReceipt is optional — absent on simulated/Fabric/Canton adapters
    wrappedMethods.set(key, async (...args: unknown[]) => {
      const stop = ledgerRpcDuration.startTimer({ chain: adapter.chainId, operation: key });
      try {
        return await (value as (...a: unknown[]) => unknown).apply(adapter, args);
      } catch (err) {
        ledgerRpcErrorsTotal.inc({ chain: adapter.chainId, operation: key });
        throw err;
      } finally {
        stop();
      }
    });
  }
  // A Proxy, not a plain-object copy: some call sites reach past the LedgerAdapter
  // interface — ledger-replay.ts does `adapter instanceof SimulatedAdapter` and calls
  // the simulated-only `.hydrate()`. A copy would break both: every adapter would stop
  // being `instanceof` its concrete class, and any adapter-specific member not in
  // LEDGER_ADAPTER_METHODS would silently vanish. The Proxy forwards everything except
  // the enumerated methods straight to the real adapter, so identity and any
  // adapter-specific extras pass through untouched.
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && wrappedMethods.has(prop)) return wrappedMethods.get(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
}
```

**Correction, ruled during implementation (see the SDD ledger for Task 3):** the Proxy-based construction above replaces an earlier plain-object-copy draft — the copy would have broken `apps/api/src/tokenization/ledger-replay.ts`'s `adapter instanceof SimulatedAdapter` check and its simulated-only `.hydrate()` call, a real regression caught by that file's own pre-existing test. This is what actually ships; Task 8 (below) extends this Proxy-based version, not the plain-object one.

In `apps/api/src/shared/chains.ts`, add the import:

```ts
import { instrumentLedgerAdapter } from "./metrics.js";
```

Find `resolveAdapter(chainId: string): LedgerAdapter {` (line 168) and its body — it currently does something like `return adapters.get(chainId) ?? ...` or throws. Wrap whatever it returns:

```ts
    resolveAdapter(chainId: string): LedgerAdapter {
      const adapter = /* ...existing lookup/throw logic, unchanged... */;
      return instrumentLedgerAdapter(adapter);
    },
```

Read the existing method body first (`apps/api/src/shared/chains.ts:168` onward) and wrap only its `return` statement(s) — do not change the lookup/error logic itself.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tokenlayer/api test -- metrics`
Expected: PASS (both tests).

- [ ] **Step 5: Run the full API test suite to confirm no ledger-adapter call site broke**

Run: `pnpm --filter @tokenlayer/api test`
Expected: PASS. `instrumentLedgerAdapter` must preserve `getReceipt` when the underlying adapter has it (EVM) and omit it when it doesn't (simulated/Fabric/Canton) — the `typeof value !== "function"` skip in the loop already handles `getReceipt` being `undefined` on adapters that don't implement it; confirm this by checking that `apps/api/src/shared/ledger-confirmer.ts`'s existing tests (which call `resolveAdapter(...).getReceipt?.(...)`) still pass unmodified.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/shared/metrics.ts apps/api/src/shared/chains.ts apps/api/test/metrics.test.ts
git commit -m "feat(observability): ledger RPC metrics via instrumentLedgerAdapter"
```

---

### Task 4: Proposal backlog gauges

**Files:**
- Modify: `apps/api/src/shared/metrics.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/metrics.test.ts`

**Interfaces:**
- Consumes: `ProposalRepository.list(useCaseKey?: string, status?: string): Promise<ProposalRecord[]>` (`apps/api/src/persistence/types/shared.ts:249`, existing, unchanged).
- Produces: `refreshProposalBacklogMetrics(proposals: ProposalRepository): Promise<void>` from `metrics.ts` — consumed by `server.ts`'s new interval.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/metrics.test.ts`:

```ts
import { buildTestAppWithRepos } from "./helpers.js";
import { proposalPendingAgeSecondsMax, proposalPendingTotal, refreshProposalBacklogMetrics, registry } from "../src/shared/metrics.js";

describe("refreshProposalBacklogMetrics", () => {
  it("sets pending count and max age per kind, and clears a kind that emptied out", async () => {
    const h = await buildTestAppWithRepos();
    const now = Date.now();
    await h.deps.proposals.create({
      useCaseKey: "carbon-credit", orgId: null, assetId: "asset_1", kind: "mint",
      payload: {}, proposerId: "u1", proposerLabel: "Alice", required: 1,
    });
    // Backdate one row directly through the repository's own row store isn't
    // available generically — instead assert on "at least the count is right
    // and age is non-negative", which is what the gauge computation actually
    // promises; a precise age assertion belongs to a unit test of the pure
    // grouping logic, not this integration-level one.
    await refreshProposalBacklogMetrics(h.deps.proposals);
    const count = (await registry.getSingleMetric(proposalPendingTotal.name)?.get())?.values.find(
      (v) => v.labels.kind === "mint",
    );
    expect(count?.value).toBe(1);
    const age = (await registry.getSingleMetric(proposalPendingAgeSecondsMax.name)?.get())?.values.find(
      (v) => v.labels.kind === "mint",
    );
    expect(age?.value).toBeGreaterThanOrEqual(0);
    expect(Date.now() - now).toBeLessThan(5000); // sanity: test itself ran fast

    // Decide the proposal away, then refresh again — the gauge must not keep
    // reporting a stale count for a kind with zero pending proposals left.
    const [p] = await h.deps.proposals.list("carbon-credit", "pending");
    await h.deps.proposals.setStatus(p!.id, "approved");
    await refreshProposalBacklogMetrics(h.deps.proposals);
    const countAfter = (await registry.getSingleMetric(proposalPendingTotal.name)?.get())?.values.find(
      (v) => v.labels.kind === "mint",
    );
    expect(countAfter).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenlayer/api test -- metrics`
Expected: FAIL — `refreshProposalBacklogMetrics`, `proposalPendingTotal`, `proposalPendingAgeSecondsMax` not exported.

- [ ] **Step 3: Implement**

Add to `apps/api/src/shared/metrics.ts`:

```ts
import type { ProposalRepository } from "../persistence/types/index.js";

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

/**
 * Refreshes the two backlog gauges from a platform-wide pending-proposal
 * scan. Called on an interval (see server.ts), never synchronously inside
 * the /metrics handler — a scrape must stay cheap regardless of backlog size.
 */
export async function refreshProposalBacklogMetrics(proposals: ProposalRepository): Promise<void> {
  const pending = await proposals.list(undefined, "pending");
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

In `apps/api/src/server.ts`, add the import:

```ts
import { refreshProposalBacklogMetrics } from "./shared/metrics.js";
```

After `const app = await buildApp(deps);` and its `app.listen(...)` call (so the interval starts once the app is actually serving, matching where the dispatcher/confirmer are started), add:

```ts
  // Refreshes the proposal-backlog gauges every 30s — not on every /metrics
  // scrape, so a scrape stays cheap regardless of backlog size.
  const PROPOSAL_BACKLOG_REFRESH_MS = 30_000;
  await refreshProposalBacklogMetrics(deps.proposals); // populate immediately, don't wait 30s for the first value
  const proposalBacklogInterval = setInterval(() => {
    void refreshProposalBacklogMetrics(deps.proposals);
  }, PROPOSAL_BACKLOG_REFRESH_MS);
  proposalBacklogInterval.unref?.();
```

Add `clearInterval(proposalBacklogInterval);` inside the existing `SIGTERM`/`SIGINT` shutdown handler, alongside `stopConfirmer()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tokenlayer/api test -- metrics`
Expected: PASS (all metrics.test.ts tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/shared/metrics.ts apps/api/src/server.ts apps/api/test/metrics.test.ts
git commit -m "feat(observability): proposal backlog gauges, refreshed on a 30s interval"
```

---

### Task 5: Alert rules and Alertmanager routing

**Files:**
- Create: `deploy/observability/alert-rules.yml`
- Create: `deploy/observability/alertmanager.yml`

**Interfaces:**
- Consumes: metric names `http_requests_total`, `http_request_duration_seconds`, `ledger_rpc_errors_total`, `proposal_pending_age_seconds_max`, `proposal_pending_total` (Tasks 2–4) and the `job_name: tokenlayer-api` convention (Task 9 establishes this in the scrape configs; this task's rules assume it).

This task has no application code — it is pure config, verified with Prometheus's own CLI tools rather than Vitest.

- [ ] **Step 1: Write alert-rules.yml**

Create `deploy/observability/alert-rules.yml`:

```yaml
groups:
  - name: api-health
    rules:
      - alert: APIDown
        expr: up{job="tokenlayer-api"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "TokenLayer API instance {{ $labels.instance }} is down"
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status_code=~"5.."}[5m]))
          / sum(rate(http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "5xx rate above 5% over the last 5 minutes"
      - alert: HighLatency
        expr: histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route)) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "p95 latency for {{ $labels.route }} above 2s"
  - name: ledger
    rules:
      - alert: LedgerRPCFailures
        expr: sum(rate(ledger_rpc_errors_total[2m])) by (chain) > 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Ledger RPC calls to {{ $labels.chain }} are failing"
  - name: proposals
    rules:
      - alert: ProposalBacklogAging
        expr: proposal_pending_age_seconds_max > 86400
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "A pending {{ $labels.kind }} proposal has been unreviewed for over 24h"
      - alert: ProposalBacklogSize
        expr: proposal_pending_total > 20
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "More than 20 pending {{ $labels.kind }} proposals"
```

- [ ] **Step 2: Verify the rule file is syntactically and semantically valid**

Run: `docker run --rm -v "$(pwd)/deploy/observability:/etc/prometheus" prom/prometheus:latest promtool check rules /etc/prometheus/alert-rules.yml`
Expected: `SUCCESS` for all 6 rules — this is the actual runnable check for a rules file, not a YAML linter.

- [ ] **Step 3: Write alertmanager.yml**

Create `deploy/observability/alertmanager.yml`:

```yaml
route:
  receiver: slack-warning
  group_by: ["alertname"]
  group_wait: 30s
  repeat_interval: 4h
  routes:
    - matchers: ["severity=critical"]
      receiver: slack-and-email-critical
      group_wait: 0s

receivers:
  - name: slack-warning
    slack_configs:
      - api_url: "${SLACK_WEBHOOK_URL}"
        channel: "#tokenlayer-alerts"
        send_resolved: true
        title: "{{ .CommonAnnotations.summary }}"
  - name: slack-and-email-critical
    slack_configs:
      - api_url: "${SLACK_WEBHOOK_URL}"
        channel: "#tokenlayer-alerts"
        send_resolved: true
        title: "{{ .CommonAnnotations.summary }}"
    email_configs:
      - to: "${ALERTMANAGER_ALERT_EMAIL}"
        from: "${ALERTMANAGER_SMTP_FROM}"
        smarthost: "${ALERTMANAGER_SMTP_HOST}"
        auth_username: "${ALERTMANAGER_SMTP_USER}"
        auth_password: "${ALERTMANAGER_SMTP_PASS}"
        require_tls: true
```

Alertmanager does not expand `${VAR}` in its config file natively, and its official image has no package manager to install `envsubst` into at container start — so this is rendered on the HOST once per deploy, before `docker compose up` (Task 11 wires the compose file to mount the already-rendered output, never the template, and documents this render step in its own header comment). Name this file `alertmanager.yml.template`, not `alertmanager.yml`:

Rename the file to `deploy/observability/alertmanager.yml.template` (same content as above).

- [ ] **Step 4: Verify the Alertmanager config template's structure is valid**

```bash
SLACK_WEBHOOK_URL=https://example.invalid ALERTMANAGER_ALERT_EMAIL=a@example.com ALERTMANAGER_SMTP_FROM=a@example.com ALERTMANAGER_SMTP_HOST=smtp:587 ALERTMANAGER_SMTP_USER=u ALERTMANAGER_SMTP_PASS=p \
  envsubst < deploy/observability/alertmanager.yml.template > /tmp/alertmanager.yml
docker run --rm -v /tmp/alertmanager.yml:/etc/alertmanager/alertmanager.yml prom/alertmanager:latest amtool check-config /etc/alertmanager/alertmanager.yml
```
Expected: `Checking '/etc/alertmanager/alertmanager.yml'  SUCCESS`.

- [ ] **Step 5: Commit**

```bash
git add deploy/observability/alert-rules.yml deploy/observability/alertmanager.yml.template
git commit -m "feat(observability): Prometheus alert rules and Alertmanager routing to Slack/email"
```

---

### Task 6: Structured logging — pino, redaction, trace correlation

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/package.json`
- Test: `apps/api/test/logging.test.ts`

**Interfaces:**
- Consumes: `redactSensitiveFields` from `@tokenlayer/core` (Task 1).
- Consumes: `trace`, `context` from `@opentelemetry/api` — a lightweight, standalone package; works correctly (returns `undefined` from `trace.getSpan`) even before Task 7's SDK bootstrap exists, so this task has no ordering dependency on Task 7.

- [ ] **Step 1: Install @opentelemetry/api**

```bash
pnpm add --filter @tokenlayer/api @opentelemetry/api
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/logging.test.ts`:

```ts
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildTestAppWithRepos } from "./helpers.js";

describe("structured logging", () => {
  it("redacts sensitive fields logged via app.log, and leaves non-sensitive fields intact", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const h = await buildTestAppWithRepos({ logStream: sink });
    h.app.log.info({ email: "alice@example.com", assetName: "Gold Bar #12" }, "test log line");
    const logged = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "test log line");
    expect(logged.email).toBe("[Redacted]");
    expect(logged.assetName).toBe("Gold Bar #12");
  });
});
```

Add `logStream?: Writable` to `TestAppOptions` in `apps/api/test/helpers.ts`, threaded into `buildApp`'s Fastify logger options as the destination stream (see Step 4 below for the shape `buildApp` needs to accept it — `buildTestAppWithRepos` passes it through to `buildApp(deps, { logStream })` if `buildApp`'s signature needs a second, options argument, or via a field on `deps` if that is a smaller diff given this codebase's existing `buildApp(rawDeps: AppDeps)` single-argument signature — prefer adding it to `AppDeps` as an optional field, e.g. `logStream?: NodeJS.WritableStream`, consistent with how `metricsToken` was added in Task 2).

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tokenlayer/api test -- logging`
Expected: FAIL — logger is currently `false`, so `app.log.info` is a no-op and `lines` stays empty.

- [ ] **Step 4: Implement**

In `apps/api/src/context.ts`, add `logStream?: NodeJS.WritableStream;` to `AppDeps` (test-only override; unset in production, where pino writes to real stdout).

In `apps/api/src/env.ts`, add `logLevel: process.env.LOG_LEVEL?.trim() || "info",` to the `env` object and `logLevel: string;` to the `Env` interface.

In `apps/api/src/app.ts`, add the import:

```ts
import { context, trace } from "@opentelemetry/api";
import { redactSensitiveFields } from "@tokenlayer/core";
import { env } from "./env.js";
```

Change line 32 from:
```ts
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
```
to:
```ts
  const app = Fastify({
    bodyLimit: 256 * 1024,
    logger: {
      level: env.logLevel,
      formatters: {
        log(obj) {
          return redactSensitiveFields(obj) as Record<string, unknown>;
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tokenlayer/api test -- logging`
Expected: PASS.

- [ ] **Step 6: Run the full API test suite**

Run: `pnpm --filter @tokenlayer/api test`
Expected: PASS — flipping the logger on must not break any test that asserts on `app.log` being silent/absent, or on Fastify's default request-logging output appearing where a test didn't expect it. Fix any such test by asserting on behavior, not on the absence of log output.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/context.ts apps/api/src/env.ts apps/api/test/logging.test.ts apps/api/test/helpers.ts apps/api/package.json
git commit -m "feat(observability): structured JSON logging with PII redaction and trace correlation"
```

---

### Task 7: OpenTelemetry tracing bootstrap

**Files:**
- Create: `apps/api/src/shared/tracing.ts`
- Create: `apps/api/src/bootstrap.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/Dockerfile`
- Test: `apps/api/test/tracing.test.ts`

**Interfaces:**
- Produces: `startTracing(opts: { serviceName: string; otlpEndpoint: string | undefined }): NodeSDK | undefined` — consumed by `bootstrap.ts`.
- Produces: `withSpan<T>(name: string, attributes: Record<string, string>, fn: () => Promise<T>): Promise<T>` — consumed by Task 8.

**Correction, ruled during implementation (see the SDD ledger for Task 7):** this section originally also listed a `getTestSpanExporter(): InMemorySpanExporter` production export — that never matched the Step 2 test code below, which always constructed its own local `InMemorySpanExporter`/`NodeTracerProvider` directly. Adding a real `getTestSpanExporter()` to `tracing.ts` would leak test-only devDependencies (`@opentelemetry/sdk-trace-base`/`sdk-trace-node`) into a production file. Task 8's own tests follow the same self-contained local-exporter pattern (see its Step 9) — no task actually needs this export, so it's removed here rather than built to satisfy a stale interface line.

**Mechanical note (a correction to the spec's own wording):** the spec says "server.ts's very first lines call startTracing(...) ahead of importing ./app.js." That is not achievable by ordering statements within `server.ts` itself — ES module `import` statements are hoisted and the entire import graph (`./app.js`, and everything it imports, including `fastify`) is evaluated **before** any of `server.ts`'s own top-level code runs, regardless of where `startTracing()` is textually placed inside that file. The actual fix is a separate, minimal entry point (`bootstrap.ts`) whose only top-level imports are `tracing.ts` and `env.ts`, which calls `startTracing()` synchronously and only **then** `await import("./server.js")` — a dynamic import, which runs after `bootstrap.ts`'s own top-level code, deferring `server.ts` (and therefore `app.ts`, `fastify`, `undici`) until tracing is already initialized. `apps/api/package.json`'s `dev`/`start` scripts and `apps/api/Dockerfile`'s CMD both need to point at `bootstrap.ts` instead of `server.ts` for this to take effect for the real running process.

- [ ] **Step 1: Install OpenTelemetry SDK packages**

```bash
pnpm add --filter @tokenlayer/api @opentelemetry/sdk-node @opentelemetry/instrumentation-fastify @opentelemetry/instrumentation-undici @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions
pnpm add --filter @tokenlayer/api -D @opentelemetry/sdk-trace-base @opentelemetry/sdk-trace-node
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/tracing.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { withSpan } from "../src/shared/tracing.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

describe("withSpan", () => {
  beforeEach(() => exporter.reset());

  it("creates a span with the given name and attributes, and returns fn's result", async () => {
    const result = await withSpan("test.op", { "proposal.kind": "onboard-user" }, async () => "ok");
    expect(result).toBe("ok");
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("test.op");
    expect(spans[0]!.attributes["proposal.kind"]).toBe("onboard-user");
  });

  it("records the exception and still rethrows on failure", async () => {
    const boom = new Error("fail");
    await expect(withSpan("test.op.fail", {}, async () => { throw boom; })).rejects.toBe(boom);
    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.status.code).toBe(2); // SpanStatusCode.ERROR
  });
});
```

`@opentelemetry/sdk-trace-node`'s `NodeTracerProvider` is a transitive dependency of `@opentelemetry/sdk-node` already installed in Step 1 — no separate install needed.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tokenlayer/api test -- tracing`
Expected: FAIL — `tracing.ts` does not exist yet.

- [ ] **Step 4: Implement tracing.ts**

Create `apps/api/src/shared/tracing.ts`:

```ts
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
 * The tracer is looked up fresh on every call, not cached at module scope —
 * a `ProxyTracer` obtained via `trace.getTracer()` binds permanently to
 * whichever `ProxyTracerProvider` answered that specific call, so a tracer
 * captured before `startTracing()`/`provider.register()` runs can orphan
 * itself from the real provider (confirmed: this silently produced zero
 * recorded spans under Vitest's SSR module handling, where the API module
 * instance a test's `NodeTracerProvider.register()` operates on and the one
 * a module-scope `trace.getTracer()` call resolved were different instances
 * of the same package). Looking it up per call is also the generally
 * OTel-recommended pattern, not just a workaround for that one environment.
 */
export async function withSpan<T>(name: string, attributes: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  return trace.getTracer("tokenlayer-api").startActiveSpan(name, { attributes }, async (span) => {
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
```

- [ ] **Step 5: Create bootstrap.ts**

Create `apps/api/src/bootstrap.ts`:

```ts
import { startTracing } from "./shared/tracing.js";
import { env } from "./env.js";

// MUST run before ./server.js (and therefore ./app.js, fastify, undici) is
// ever imported — see this task's "Mechanical note" in the plan for why a
// dynamic import is what actually achieves that under ESM.
startTracing({ serviceName: env.otelServiceName, otlpEndpoint: env.otelExporterOtlpEndpoint });

await import("./server.js");
```

- [ ] **Step 6: Add env vars**

In `apps/api/src/env.ts`, add to the `Env` interface: `otelServiceName: string; otelExporterOtlpEndpoint: string | undefined;`. Add to the `env` object:

```ts
  otelServiceName: process.env.OTEL_SERVICE_NAME?.trim() || "tokenlayer-api",
  otelExporterOtlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined,
```

- [ ] **Step 7: Point the real entry point at bootstrap.ts**

In `apps/api/package.json`'s `scripts`, change:
```json
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
```
to:
```json
    "dev": "tsx watch src/bootstrap.ts",
    "start": "tsx src/bootstrap.ts",
```

In `apps/api/Dockerfile`, change the CMD's final segment from `pnpm exec tsx src/server.ts` to `pnpm exec tsx src/bootstrap.ts`.

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @tokenlayer/api test -- tracing`
Expected: PASS (both tests).

- [ ] **Step 9: Run the full API test suite**

Run: `pnpm --filter @tokenlayer/api test`
Expected: PASS — nothing in the existing suite imports `server.ts`/`bootstrap.ts` directly (tests build apps via `buildTestAppWithRepos`/`buildApp` directly), so this change should be inert for the test run.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/shared/tracing.ts apps/api/src/bootstrap.ts apps/api/src/env.ts apps/api/package.json apps/api/Dockerfile apps/api/test/tracing.test.ts
git commit -m "feat(observability): OpenTelemetry tracing bootstrap via a dedicated ESM-safe entry point"
```

---

### Task 8: Custom spans — ledger operations, proposal execution, review-decision

**Files:**
- Modify: `apps/api/src/shared/metrics.ts`
- Modify: `apps/api/src/shared/proposal-kinds.ts`
- Modify: `apps/api/src/http/routes/tokenization.ts`
- Test: `apps/api/test/tracing.test.ts`

**Interfaces:**
- Consumes: `withSpan` from `tracing.ts` (Task 7).
- Consumes: `instrumentLedgerAdapter` from `metrics.ts` (Task 3) — extended here, not replaced.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/tracing.test.ts`:

```ts
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

describe("review-decision span", () => {
  beforeEach(() => exporter.reset());

  it("opens a span named review-decision with proposal.kind and decision attributes", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const issue = await h.app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(platform),
      payload: { useCaseKey: "carbon-credit", name: "T", symbol: "T", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 } },
    });
    const assetId = issue.json().asset.id as string;
    await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });

    await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin),
      payload: { decision: "approved", riskTier: "low" },
    });

    const span = exporter.getFinishedSpans().find((s) => s.name === "review-decision");
    expect(span).toBeDefined();
    expect(span!.attributes["proposal.kind"]).toBe("asset-review-decision");
    expect(span!.attributes.decision).toBe("approved");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tokenlayer/api test -- tracing`
Expected: FAIL — no span named `review-decision` is emitted yet.

- [ ] **Step 3: Implement the review-decision span**

In `apps/api/src/http/routes/tokenization.ts`, add the import:

```ts
import { withSpan } from "../../shared/tracing.js";
```

In the `review-decision` handler (starting at line 879), wrap the decision branch (lines 949–992, from `if (b.decision === "approved") {` through the closing `}` of the `else` block) with `withSpan`:

```ts
    await withSpan("review-decision", { "proposal.kind": "asset-review-decision", decision: b.decision }, async () => {
      if (b.decision === "approved") {
        await deps.assets.setDueDiligence(asset.id, {
          riskTier: b.riskTier,
          reviewedBy: claims.id,
          reviewedAt: new Date().toISOString(),
          rejectionReason: null,
        });
        const useCase = await deps.useCases.get(asset.useCaseKey);
        const treasury = useCase.treasuryAccountId ? (await deps.accounts.findById(useCase.treasuryAccountId))?.address ?? null : null;
        await executeIssueActivation(deps, { id: claims.id, role: claims.role }, asset, {
          initialSupply: asset.dueDiligence?.pendingInitialSupply ?? undefined,
          treasury,
          sale: asset.dueDiligence?.pendingSale ?? undefined,
        }, request.log);
      } else {
        const fee = asset.dueDiligence?.pendingIssuanceFee;
        await deps.assets.setDueDiligence(asset.id, {
          rejectionReason: b.rejectionReason,
          riskTier: null,
          reviewedBy: null,
          reviewedAt: null,
          pendingIssuanceFee: null,
        });
        if (fee?.payer && deps.platformFeeAccount) {
          await deps.cash.transfer(fee.currency, deps.platformFeeAccount, fee.payer, fee.amount).catch((refundErr) =>
            request.log.error({ refundErr, assetId: asset.id }, "issuance fee refund failed — manual reconciliation required"));
        }
      }
    });
```

This is a pure indentation/wrapping change around the existing logic — no behavior inside the branch changes. Leave every comment already inside that block exactly as it is; only the surrounding `withSpan(...)` call and closing brace are new.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tokenlayer/api test -- tracing`
Expected: PASS.

- [ ] **Step 5: Write the failing test for proposal-execute spans**

Add to `apps/api/test/tracing.test.ts`:

```ts
describe("proposal execution span", () => {
  beforeEach(() => exporter.reset());

  it("opens a proposal.execute span labeled with the proposal's kind for onboard-user", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const propose = await h.app.inject({
      method: "POST", url: `${V1}/proposals`, headers: auth(platform),
      payload: { kind: "onboard-user", useCaseKey: null, orgId: null, assetId: null, payload: { email: "new.user@example.com", role: "Buyer" } },
    });
    const proposalId = propose.json().id as string;
    const other = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    await h.app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(other) });

    const span = exporter.getFinishedSpans().find((s) => s.name === "proposal.execute");
    expect(span).toBeDefined();
    expect(span!.attributes["proposal.kind"]).toBe("onboard-user");
  });
});
```

Check the exact `POST /proposals` create-payload shape and the `onboard-user` kind's required fields against `apps/api/src/shared/user-kinds.ts` and an existing test that drafts one (search `apps/api/test` for `"onboard-user"`) before finalizing this test's payload — copy the real shape used there rather than guessing field names.

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @tokenlayer/api test -- tracing`
Expected: FAIL — no `proposal.execute` span exists yet.

- [ ] **Step 7: Implement the proposal-execute span**

In `apps/api/src/shared/proposal-kinds.ts`, add the import:

```ts
import { withSpan } from "./tracing.js";
```

Change `registerProposalKind` (line 149) from:

```ts
export function registerProposalKind(h: ProposalKindHandler): void {
  HANDLERS.set(h.kind, h);
}
```

to:

```ts
export function registerProposalKind(h: ProposalKindHandler): void {
  HANDLERS.set(h.kind, {
    ...h,
    execute: (ctx, proposer, p) => withSpan("proposal.execute", { "proposal.kind": h.kind }, () => h.execute(ctx, proposer, p)),
  });
}
```

This covers every registered kind through the one choke point every kind is registered through — including `onboard-user`, `issue-usecase-credential`, and every token/credential/org/kyc kind, not only the two named in the spec as motivating examples. `canView`, `canApprove`, `apiScope`, and `compensate` are untouched (spread from `h`).

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @tokenlayer/api test -- tracing`
Expected: PASS.

- [ ] **Step 9: Extend instrumentLedgerAdapter to also open a span per operation**

Add to `apps/api/test/metrics.test.ts` (extends Task 3's test file):

```ts
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const spanExporter = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }).register();

it("opens a ledger.<operation> span alongside the metric", async () => {
  spanExporter.reset();
  const adapter = instrumentLedgerAdapter(stubAdapter());
  await adapter.balanceOf({ chainId: "test-chain", address: "0x1" } as never, "0xaccount");
  const span = spanExporter.getFinishedSpans().find((s) => s.name === "ledger.balanceOf");
  expect(span).toBeDefined();
  expect(span!.attributes.chain).toBe("test-chain");
  expect(span!.attributes.operation).toBe("balanceOf");
});
```

Run: `pnpm --filter @tokenlayer/api test -- metrics`
Expected: FAIL — no `ledger.balanceOf` span yet.

Modify `instrumentLedgerAdapter` in `apps/api/src/shared/metrics.ts` (the real, Proxy-based version Task 3 shipped — see that task's plan text for the full current file): add the import `import { withSpan } from "./tracing.js";` and change the wrapped-method body from:

```ts
    wrappedMethods.set(key, async (...args: unknown[]) => {
      const stop = ledgerRpcDuration.startTimer({ chain: adapter.chainId, operation: key });
      try {
        return await (value as (...a: unknown[]) => unknown).apply(adapter, args);
      } catch (err) {
        ledgerRpcErrorsTotal.inc({ chain: adapter.chainId, operation: key });
        throw err;
      } finally {
        stop();
      }
    });
```

to:

```ts
    wrappedMethods.set(key, async (...args: unknown[]) => {
      const stop = ledgerRpcDuration.startTimer({ chain: adapter.chainId, operation: key });
      return withSpan(`ledger.${key}`, { chain: adapter.chainId, operation: key }, async () => {
        try {
          return await (value as (...a: unknown[]) => unknown).apply(adapter, args);
        } catch (err) {
          ledgerRpcErrorsTotal.inc({ chain: adapter.chainId, operation: key });
          throw err;
        } finally {
          stop();
        }
      });
    });
```

The Proxy wrapper itself (the `new Proxy(adapter, { get(...) {...} })` at the end of the function) is unchanged by this task — only the body stored in `wrappedMethods` changes.

- [ ] **Step 10: Run test to verify it passes**

Run: `pnpm --filter @tokenlayer/api test -- metrics tracing`
Expected: PASS.

- [ ] **Step 11: Run the full API test suite**

Run: `pnpm --filter @tokenlayer/api test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/shared/metrics.ts apps/api/src/shared/proposal-kinds.ts apps/api/src/http/routes/tokenization.ts apps/api/test/tracing.test.ts apps/api/test/metrics.test.ts
git commit -m "feat(observability): custom spans for ledger ops, proposal execution, and asset review decisions"
```

---

### Task 9: Per-topology Prometheus scrape configs, and a stable network name for the main stack

**Files:**
- Create: `deploy/observability/prometheus.main.yml`
- Create: `deploy/observability/prometheus.identity.yml`
- Create: `deploy/observability/prometheus.tokenization.yml`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: the `job_name: tokenlayer-api` convention Task 5's alert rules assume.
- Produces: the network name `tokenlayer-main` — consumed by Task 11's compose overlay (`OBSERVABILITY_NETWORK=tokenlayer-main` for the main topology).

- [ ] **Step 1: Name the main stack's network**

`docker-compose.yml` today declares no top-level `networks:` key, so Compose auto-creates one named after the project directory — not a stable value another compose file can reliably join by name. Add, at the end of `docker-compose.yml` (after the `volumes:` block):

```yaml
networks:
  default:
    name: tokenlayer-main
```

This does not change any existing behavior for the `api`/`web` services — Compose still auto-creates this network on `up`, just under a fixed name instead of a directory-derived one.

- [ ] **Step 2: Write prometheus.main.yml**

Create `deploy/observability/prometheus.main.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/alert-rules.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]

scrape_configs:
  - job_name: tokenlayer-api
    metrics_path: /metrics
    static_configs:
      - targets: ["api:4000"]
```

- [ ] **Step 3: Write prometheus.identity.yml and prometheus.tokenization.yml**

Create `deploy/observability/prometheus.identity.yml` (same `global`/`rule_files`/`alerting` block as above, different target):

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/alert-rules.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]

scrape_configs:
  - job_name: tokenlayer-api
    metrics_path: /metrics
    static_configs:
      - targets: ["identity-api:4000"]
```

Create `deploy/observability/prometheus.tokenization.yml` identically, with `targets: ["tokenization-api:4000"]`.

All three files use `job_name: tokenlayer-api` regardless of topology — this is what lets `APIDown`/`LedgerRPCFailures` (Task 5) be one rule set that works unmodified no matter which of the three files is mounted; instances are distinguished by Prometheus's own `instance` label, not by job name.

- [ ] **Step 4: Verify each config parses**

Run for each of the three files: `docker run --rm -v "$(pwd)/deploy/observability:/etc/prometheus" prom/prometheus:latest promtool check config /etc/prometheus/prometheus.main.yml` (repeat with `.identity.yml`, `.tokenization.yml`)
Expected: `SUCCESS` for each.

- [ ] **Step 5: Commit**

```bash
git add deploy/observability/prometheus.main.yml deploy/observability/prometheus.identity.yml deploy/observability/prometheus.tokenization.yml docker-compose.yml
git commit -m "feat(observability): per-topology Prometheus scrape configs, name the main stack's network"
```

---

### Task 10: Grafana provisioning (datasources + 3 dashboards) and Promtail config

**Files:**
- Create: `deploy/observability/grafana/provisioning/datasources/datasources.yml`
- Create: `deploy/observability/grafana/provisioning/dashboards/dashboards.yml`
- Create: `deploy/observability/grafana/dashboards/api-overview.json`
- Create: `deploy/observability/grafana/dashboards/ledger-health.json`
- Create: `deploy/observability/grafana/dashboards/proposal-backlog.json`
- Create: `deploy/observability/promtail.yml`

No app code in this task — config only, verified by structural checks rather than Vitest.

- [ ] **Step 1: Write datasources.yml**

Create `deploy/observability/grafana/provisioning/datasources/datasources.yml`:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    jsonData:
      derivedFields:
        - datasourceUid: tempo
          matcherRegex: '"trace_id":"(\w+)"'
          name: TraceID
          url: "$${__value.raw}"
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    uid: tempo
```

- [ ] **Step 2: Write dashboards.yml provisioning pointer**

Create `deploy/observability/grafana/provisioning/dashboards/dashboards.yml`:

```yaml
apiVersion: 1
providers:
  - name: TokenLayer
    folder: TokenLayer
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

- [ ] **Step 3: Write the three starter dashboards**

Create `deploy/observability/grafana/dashboards/api-overview.json`:

```json
{
  "title": "API Overview",
  "uid": "tokenlayer-api-overview",
  "panels": [
    { "title": "Request rate by route", "type": "timeseries", "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "targets": [{ "expr": "sum(rate(http_requests_total[5m])) by (route)" }] },
    { "title": "p95 latency by route", "type": "timeseries", "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "targets": [{ "expr": "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))" }] },
    { "title": "5xx error rate", "type": "timeseries", "gridPos": { "h": 8, "w": 24, "x": 0, "y": 8 },
      "targets": [{ "expr": "sum(rate(http_requests_total{status_code=~\"5..\"}[5m])) / sum(rate(http_requests_total[5m]))" }] }
  ],
  "schemaVersion": 39,
  "time": { "from": "now-1h", "to": "now" }
}
```

Create `deploy/observability/grafana/dashboards/ledger-health.json`:

```json
{
  "title": "Ledger Health",
  "uid": "tokenlayer-ledger-health",
  "panels": [
    { "title": "RPC error rate by chain", "type": "timeseries", "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "targets": [{ "expr": "sum(rate(ledger_rpc_errors_total[5m])) by (chain)" }] },
    { "title": "RPC duration p95 by chain/operation", "type": "timeseries", "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "targets": [{ "expr": "histogram_quantile(0.95, sum(rate(ledger_rpc_duration_seconds_bucket[5m])) by (le, chain, operation))" }] }
  ],
  "schemaVersion": 39,
  "time": { "from": "now-1h", "to": "now" }
}
```

Create `deploy/observability/grafana/dashboards/proposal-backlog.json`:

```json
{
  "title": "Maker-Checker Backlog",
  "uid": "tokenlayer-proposal-backlog",
  "panels": [
    { "title": "Pending proposals by kind", "type": "timeseries", "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "targets": [{ "expr": "proposal_pending_total" }] },
    { "title": "Oldest pending proposal age by kind", "type": "timeseries", "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "targets": [{ "expr": "proposal_pending_age_seconds_max" }] }
  ],
  "schemaVersion": 39,
  "time": { "from": "now-1h", "to": "now" }
}
```

- [ ] **Step 4: Write promtail.yml**

Create `deploy/observability/promtail.yml`:

```yaml
server:
  http_listen_port: 9080

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s
    relabel_configs:
      - source_labels: ["__meta_docker_container_name"]
        target_label: container
      - source_labels: ["__meta_docker_container_label_com_docker_compose_project"]
        target_label: compose_project
```

- [ ] **Step 5: Verify all JSON dashboards parse**

Run: `for f in deploy/observability/grafana/dashboards/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "$f OK"; done`
Expected: `OK` for all three files.

- [ ] **Step 6: Commit**

```bash
git add deploy/observability/grafana deploy/observability/promtail.yml
git commit -m "feat(observability): Grafana provisioning (datasources + 3 starter dashboards) and Promtail config"
```

---

### Task 11: docker-compose.observability.yml overlay

**Files:**
- Create: `docker-compose.observability.yml`

**Interfaces:**
- Consumes: `deploy/observability/{alert-rules.yml, alertmanager.yml.template, prometheus.*.yml, promtail.yml, grafana/...}` (Tasks 5, 9, 10).
- Consumes env vars: `PROMETHEUS_CONFIG_FILE` (default `prometheus.main.yml`), `OBSERVABILITY_NETWORK` (required, no default). `SLACK_WEBHOOK_URL`/`ALERTMANAGER_ALERT_EMAIL`/`ALERTMANAGER_SMTP_*` are consumed at the host-side `envsubst` render step (Task 5), not by `docker compose up` directly — the compose file only ever reads the already-rendered `alertmanager.yml`.

- [ ] **Step 1: Write docker-compose.observability.yml**

Create `docker-compose.observability.yml`:

```yaml
# Observability overlay — Prometheus, Grafana, Loki, Promtail, Tempo, Alertmanager.
# Never runs standalone: always combined with exactly one app-stack compose file.
#
# Alertmanager's config carries secrets (Slack webhook, SMTP password) that
# Alertmanager itself cannot expand from ${VAR} — and its official image has
# no package manager to install envsubst into at container start. Render it
# on the host BEFORE `up`, once per deploy, from the required env vars:
#
#   SLACK_WEBHOOK_URL=... ALERTMANAGER_ALERT_EMAIL=... ALERTMANAGER_SMTP_FROM=... \
#   ALERTMANAGER_SMTP_HOST=... ALERTMANAGER_SMTP_USER=... ALERTMANAGER_SMTP_PASS=... \
#     envsubst < deploy/observability/alertmanager.yml.template > deploy/observability/alertmanager.yml
#
# deploy/observability/alertmanager.yml (the rendered file, not the
# .template) is gitignored — it holds real secrets once rendered.
#
#   OBSERVABILITY_NETWORK=tokenlayer-main \
#     docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
#
#   OBSERVABILITY_NETWORK=xi-net PROMETHEUS_CONFIG_FILE=prometheus.identity.yml \
#     docker compose -f docker-compose.identity.yml -f docker-compose.observability.yml up -d
#
#   OBSERVABILITY_NETWORK=xi-net PROMETHEUS_CONFIG_FILE=prometheus.tokenization.yml \
#     docker compose -f docker-compose.tokenization.yml -f docker-compose.observability.yml up -d
services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./deploy/observability/${PROMETHEUS_CONFIG_FILE:-prometheus.main.yml}:/etc/prometheus/prometheus.yml:ro
      - ./deploy/observability/alert-rules.yml:/etc/prometheus/alert-rules.yml:ro
      - prometheus-data:/prometheus
    command: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus"]
    networks: [obs]

  alertmanager:
    image: prom/alertmanager:latest
    volumes:
      # The RENDERED file (see the header comment above) — not the .template.
      - ./deploy/observability/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
      - alertmanager-data:/alertmanager
    command: ["--config.file=/etc/alertmanager/alertmanager.yml", "--storage.path=/alertmanager"]
    networks: [obs]

  loki:
    image: grafana/loki:latest
    volumes:
      - loki-data:/loki
    networks: [obs]

  promtail:
    image: grafana/promtail:latest
    volumes:
      - ./deploy/observability/promtail.yml:/etc/promtail/config.yml:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    command: ["-config.file=/etc/promtail/config.yml"]
    networks: [obs]

  tempo:
    image: grafana/tempo:latest
    command: ["-config.file=/etc/tempo/tempo.yml"]
    volumes:
      - ./deploy/observability/tempo.yml:/etc/tempo/tempo.yml:ro
      - tempo-data:/var/tempo
    networks: [obs]

  grafana:
    image: grafana/grafana:latest
    ports:
      - "${GRAFANA_PORT:-3000}:3000"
    volumes:
      - ./deploy/observability/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./deploy/observability/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana-data:/var/lib/grafana
    networks: [obs]

volumes:
  prometheus-data:
  alertmanager-data:
  loki-data:
  tempo-data:
  grafana-data:

networks:
  obs:
    name: ${OBSERVABILITY_NETWORK:?Set OBSERVABILITY_NETWORK to the app stack's Docker network name (tokenlayer-main for docker-compose.yml, xi-net for the identity/tokenization split stacks)}
    external: true
```

Tempo needs its own minimal config file (not previously specced as a separate file — add it now, since the overlay above references it): create `deploy/observability/tempo.yml`:

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        http:

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/traces
```

- [ ] **Step 2: Gitignore the rendered Alertmanager config**

Add a line to the repo's root `.gitignore`: `deploy/observability/alertmanager.yml` (the rendered file carries real secrets once produced by the `envsubst` step; only `alertmanager.yml.template` is tracked).

- [ ] **Step 3: Verify the compose file parses, and that OBSERVABILITY_NETWORK's required-var guard works**

Run: `docker compose -f docker-compose.yml -f docker-compose.observability.yml config --quiet`
Expected: exits nonzero, naming `OBSERVABILITY_NETWORK` as missing — proving the `:?` guard works. This will also fail because `deploy/observability/alertmanager.yml` doesn't exist yet (only the `.template` does) — render it first with placeholder values, then verify:
```bash
SLACK_WEBHOOK_URL=https://example.invalid ALERTMANAGER_ALERT_EMAIL=a@example.com ALERTMANAGER_SMTP_FROM=a@example.com ALERTMANAGER_SMTP_HOST=smtp:587 ALERTMANAGER_SMTP_USER=u ALERTMANAGER_SMTP_PASS=p \
  envsubst < deploy/observability/alertmanager.yml.template > deploy/observability/alertmanager.yml
OBSERVABILITY_NETWORK=tokenlayer-main docker compose -f docker-compose.yml -f docker-compose.observability.yml config --quiet
```
Expected: exits 0. Delete the rendered placeholder file afterward (`rm deploy/observability/alertmanager.yml`) — it must not be committed (Step 2's gitignore entry prevents `git add` from picking it up regardless, but don't leave secrets-shaped placeholder content sitting in the worktree unnecessarily).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.observability.yml deploy/observability/tempo.yml .gitignore
git commit -m "feat(observability): docker-compose overlay wiring Prometheus, Grafana, Loki, Promtail, Tempo, Alertmanager"
```

---

### Task 12: Live verification

No new files. This task brings the overlay up against the running main stack and proves the whole pipeline end-to-end, per the spec's own testing section.

- [ ] **Step 1: Bring up the main stack plus the observability overlay**

```bash
docker compose -f docker-compose.yml up -d --build
SLACK_WEBHOOK_URL=<a real or throwaway webhook URL> ALERTMANAGER_ALERT_EMAIL=you@example.com ALERTMANAGER_SMTP_FROM=alerts@example.com ALERTMANAGER_SMTP_HOST=<smtp host:port> ALERTMANAGER_SMTP_USER=<user> ALERTMANAGER_SMTP_PASS=<pass> \
  envsubst < deploy/observability/alertmanager.yml.template > deploy/observability/alertmanager.yml
OBSERVABILITY_NETWORK=tokenlayer-main docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

- [ ] **Step 2: Confirm Prometheus is scraping the API**

In the Browser pane, open `http://localhost:9090/targets` and confirm the `tokenlayer-api` job shows state `UP`.

- [ ] **Step 3: Generate traffic and confirm the three Grafana dashboards populate**

Hit a handful of routes (login, list assets, etc.) via the running web app or `curl`, then open `http://localhost:${GRAFANA_PORT:-3000}` in the Browser pane, sign in (default `admin`/`admin`), and confirm all three dashboards under the "TokenLayer" folder show non-empty data: API Overview (request rate/latency), Ledger Health (should show near-zero error rate under normal operation), Maker-Checker Backlog.

- [ ] **Step 4: Deliberately trigger LedgerRPCFailures and confirm it fires**

Stop whichever chain container the main stack's default chain resolves to (or, if the stack runs `CHAIN_STRICT: "0"` with a simulated chain per `docker-compose.yml`'s own comment, instead force one ledger call to fail — e.g. call a mint against a chain ID that isn't configured — to produce ledger RPC errors). Wait ~2 minutes (the rule's `for: 2m`), then open `http://localhost:9093` (Alertmanager) and confirm `LedgerRPCFailures` shows state `firing`.

- [ ] **Step 5: Confirm log correlation**

In Grafana, open the Loki datasource's Explore view, find a recent log line for a request that also produced a trace (any request after tracing was configured — note `OTEL_EXPORTER_OTLP_ENDPOINT` must be set on the API container's environment for this specifically; it is not set by the commands in Step 1 above, so either add `OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318` to `docker-compose.yml`'s `api` service environment for this verification pass, or note in the final report that trace correlation was verified via the unit tests in Task 7/8 only, not live, if wiring that env var into the main stack's compose file is out of scope for this pass). Confirm the log line carries a `trace_id` field and Grafana's derived-field link opens the matching Tempo trace.

- [ ] **Step 6: Report results**

Summarize, for the user: which of Steps 2–5 passed as expected, any deviation from the spec found live (matching this plan's own practice of disclosing real findings rather than silently patching around them), and confirm Slack/email delivery specifically was NOT verified end-to-end in this environment (no real Slack channel/SMTP relay to check against) — routing to Alertmanager's receivers was confirmed, actual delivery is the user's own check per the spec's Testing section.

No commit for this task — it produces no file changes beyond what Steps 2–5 might reveal as bugs, which would be fixed as their own follow-up commits against the specific task whose code was wrong.

---

## Self-Review Notes

**Spec coverage:** Section A (metrics) → Tasks 2–4. Section B (tracing) → Tasks 7–8, including the ESM bootstrap correction. Section C (logging) → Task 6. Section D (alerting) → Task 5. Section E (deployment/dashboards) → Tasks 9–11. Testing section → each task's own test steps plus Task 12's live verification. Every spec requirement has a task.

**Placeholder scan:** no TBD/TODO. Two steps (Task 8 Step 5, Task 12 Step 5) explicitly instruct checking an existing file/convention before finalizing rather than guessing a shape outright — this is deliberate: the exact `onboard-user` proposal payload shape and the main stack's live-environment tracing env var are genuinely not knowable without reading code that sits outside this plan's own diff, and guessing either risks a wrong-but-plausible-looking test. This is different from a "TBD" — the instruction names exactly what to check and where.

**Type consistency:** `instrumentLedgerAdapter(adapter: LedgerAdapter): LedgerAdapter` (Task 3) is the same signature used unchanged in Task 8. `refreshProposalBacklogMetrics(proposals: ProposalRepository): Promise<void>` (Task 4) matches `AppDeps.proposals`'s type used in Task 4's test and Task 8's `withSpan` wrapping doesn't touch it. `withSpan<T>(name: string, attributes: Record<string, string>, fn: () => Promise<T>): Promise<T>` (Task 7) is called with matching argument shapes in every one of Task 8's three call sites. `AppDeps.metricsToken?: string` (Task 2) and `AppDeps.logStream?: NodeJS.WritableStream` (Task 6) are both consumed exactly where they're produced.
