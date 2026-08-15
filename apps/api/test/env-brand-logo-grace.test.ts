import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND_LOGO_PRUNE_GRACE_MS } from "../src/shared/brand-logo-prune.js";

/**
 * `BRAND_LOGO_PRUNE_GRACE_MS` is an operator-facing override for a SAFETY
 * FLOOR, not a performance knob, which is why it is validated at boot instead
 * of coerced with a bare `Number(...)` like the tunables beside it.
 *
 * Two misconfigurations are silent and harmful, and both are pinned below:
 *   - a typo parses to `NaN`; `ageMs >= NaN` is false for every row, so the
 *     prune switches off completely and the storage leak returns unannounced;
 *   - a negative value makes every row instantly reapable, re-opening the
 *     concurrent-upload data loss the grace period was added to close.
 *
 * `env.ts` reads `process.env` at MODULE SCOPE, so each case stubs the
 * environment, resets the module registry and re-imports. `JWT_SECRET` is
 * stubbed too because that module refuses to load without a strong one — which
 * would otherwise make every case here pass for the wrong reason.
 */
const STRONG_SECRET = "0123456789abcdef0123456789abcdef";

async function loadEnv(graceRaw: string | undefined) {
  vi.resetModules();
  vi.stubEnv("JWT_SECRET", STRONG_SECRET);
  // `stubEnv(name, undefined)` deletes the key, which is the "unset" case.
  vi.stubEnv("BRAND_LOGO_PRUNE_GRACE_MS", graceRaw as string);
  return (await import("../src/env.js")).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("BRAND_LOGO_PRUNE_GRACE_MS", () => {
  it("is undefined when unset, so the module default stays the single source of the number", async () => {
    const env = await loadEnv(undefined);
    expect(env.brandLogoPruneGraceMs).toBeUndefined();
    // The route resolves `deps.brandLogoPruneGraceMs ?? BRAND_LOGO_PRUNE_GRACE_MS`,
    // so "unset" must not mean 0 — that would disable the guard by omission.
    expect(env.brandLogoPruneGraceMs ?? BRAND_LOGO_PRUNE_GRACE_MS).toBe(60_000);
  });

  it("parses a valid override", async () => {
    expect((await loadEnv("120000")).brandLogoPruneGraceMs).toBe(120_000);
  });

  it("honours an explicit 0 — `\"0\"` is a truthy string and must reach the parser", async () => {
    // The guard is `process.env.X ? parse(X) : undefined`. If someone ever
    // rewrites that as a numeric-truthiness check, 0 silently becomes "unset"
    // and this test is what says so.
    expect((await loadEnv("0")).brandLogoPruneGraceMs).toBe(0);
  });

  it("REFUSES TO BOOT on a non-numeric value rather than silently disabling the prune", async () => {
    // `Number("6o")` is NaN. Without this check the API starts, looks healthy,
    // and never reaps another row.
    await expect(loadEnv("6o")).rejects.toThrow(/BRAND_LOGO_PRUNE_GRACE_MS must be a non-negative number/);
  });

  it("REFUSES TO BOOT on a negative value rather than re-opening the concurrency race", async () => {
    await expect(loadEnv("-1")).rejects.toThrow(/BRAND_LOGO_PRUNE_GRACE_MS must be a non-negative number/);
  });

  it("names the offending value in the error, so the fix is obvious from the log", async () => {
    await expect(loadEnv("sixty")).rejects.toThrow(/"sixty"/);
  });
});
