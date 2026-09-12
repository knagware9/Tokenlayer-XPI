import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unset SENTRY_DSN / OTEL_EXPORTER_OTLP_ENDPOINT are safe defaults — no
 * tracking, no tracing, nothing exposed. METRICS_TOKEN is the opposite:
 * unset means GET /metrics is OPEN with no authentication. Production must
 * refuse to boot without it — the same fail-closed posture as `JWT_SECRET`.
 *
 * `env.ts` reads `process.env` at MODULE SCOPE, so each case stubs the
 * environment, resets the module registry and re-imports — same pattern as
 * `env-brand-logo-grace.test.ts`. `JWT_SECRET` is stubbed to a strong value
 * in every case so that unrelated refusal doesn't make a case here pass for
 * the wrong reason.
 */
const STRONG_SECRET = "0123456789abcdef0123456789abcdef";

async function loadEnv(nodeEnv: string | undefined, metricsToken: string | undefined) {
  vi.resetModules();
  vi.stubEnv("JWT_SECRET", STRONG_SECRET);
  vi.stubEnv("NODE_ENV", nodeEnv as string);
  vi.stubEnv("METRICS_TOKEN", metricsToken as string);
  return (await import("../src/env.js")).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("METRICS_TOKEN in production", () => {
  it("REFUSES TO BOOT in production when METRICS_TOKEN is unset — /metrics would otherwise be open with no auth", async () => {
    await expect(loadEnv("production", undefined)).rejects.toThrow(/METRICS_TOKEN is not set/);
  });

  it("boots in production when METRICS_TOKEN is set", async () => {
    const env = await loadEnv("production", "a-real-token");
    expect(env.metricsToken).toBe("a-real-token");
  });

  it("does not refuse outside production when METRICS_TOKEN is unset — /metrics stays open by default, matching the demo/dev posture", async () => {
    const env = await loadEnv("development", undefined);
    expect(env.metricsToken).toBeUndefined();
  });
});
