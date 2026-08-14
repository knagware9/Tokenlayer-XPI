/**
 * THE ALLOWLIST AND THE API MUST DESCRIBE THE SAME SURFACE.
 *
 * `packages/core/src/personas.ts` decides what each persona's edge container
 * admits, and the nginx configs are generated from it. That makes it a SECOND
 * description of the route surface, and a second description is a thing that
 * goes stale. The two checks here are what stop it, and they fail in opposite
 * directions on purpose:
 *
 *   · NO DEAD RULE — a prefix that matches no real route. Renaming a route
 *     leaves its allowlist entry behind, where it grants nothing while reading,
 *     to anyone auditing the boundary, exactly like coverage.
 *   · NO ORPHAN ROUTE — a real route no persona can reach. Adding a route and
 *     forgetting the catalogue silently makes a feature unreachable in the
 *     containerized topology; the only symptom is "it doesn't work in Docker",
 *     reported weeks later by someone who cannot reproduce it locally.
 *
 * Both read the surface from the app's own OpenAPI document rather than a list
 * kept here, because a list kept here would be a THIRD copy with the same
 * problem. The app is built with both products enabled so the document carries
 * the whole surface — a domain-gated route is hidden from the spec, and testing
 * against a narrowed one would let identity's routes look like orphans.
 */
import { describe, expect, it } from "vitest";
import {
  DELIBERATELY_UNREACHABLE, PERSONAS, personaAllows, personaRules,
} from "@tokenlayer/core";
import { buildTestApp } from "./helpers.js";

/** `{id}` in OpenAPI is `:id` in a Fastify route pattern. */
const toPattern = (openapiPath: string): string =>
  openapiPath.replace(/^\/api\/v1/, "").replace(/\{([^}]+)\}/g, ":$1") || "/";

interface Endpoint { method: string; pattern: string }

/** Every (method, pattern) the API serves with both products enabled. */
async function surface(): Promise<Endpoint[]> {
  const app = await buildTestApp({ enabledDomains: ["tokenization", "identity"] });
  try {
    await app.ready();   // the spec is only assembled once every route is registered
    const spec = app.swagger() as { paths?: Record<string, Record<string, unknown>> };
    const out: Endpoint[] = [];
    for (const [path, ops] of Object.entries(spec.paths ?? {})) {
      const pattern = toPattern(path);
      for (const method of Object.keys(ops)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        out.push({ method: method.toUpperCase(), pattern });
      }
    }
    return out;
  } finally {
    await app.close();
  }
}

const unreachable = new Set(DELIBERATELY_UNREACHABLE.map(([prefix]) => prefix));
/** True when a pattern is one of the deliberate exclusions, or sits under one. */
const isDeliberatelyUnreachable = (pattern: string): boolean =>
  [...unreachable].some((p) => pattern === p || pattern.startsWith(p + "/"));

describe("the persona allowlist against the API's real surface", () => {
  it("has a non-trivial surface to check — the guard against a vacuous pass", async () => {
    // If `surface()` ever returned nothing (a spec shape change, a build
    // failure swallowed), both tests below would pass by describing nothing.
    const endpoints = await surface();
    expect(endpoints.length).toBeGreaterThan(80);
  }, 60_000);

  it("NO DEAD RULE — every allowlist prefix matches at least one real route", async () => {
    const endpoints = await surface();
    const dead: string[] = [];
    for (const persona of PERSONAS) {
      for (const rule of personaRules(persona)) {
        const hit = endpoints.some((e) =>
          rule.exact ? e.pattern === rule.prefix : e.pattern === rule.prefix || e.pattern.startsWith(rule.prefix + "/"));
        if (!hit) dead.push(`${persona.key}: ${rule.prefix}`);
      }
    }
    expect(dead, `allowlist rules matching no route — renamed or misspelled:\n  ${dead.join("\n  ")}`).toEqual([]);
  }, 60_000);

  it("NO ORPHAN ROUTE — every route is reachable by some persona, or named as deliberately not", async () => {
    const endpoints = await surface();
    const orphans = endpoints
      .filter((e) => !isDeliberatelyUnreachable(e.pattern))
      .filter((e) => !PERSONAS.some((p) => personaAllows(p, e.method, e.pattern)))
      .map((e) => `${e.method} ${e.pattern}`);
    expect(
      orphans,
      "routes no persona container can reach. Grant them to a persona in packages/core/src/personas.ts, " +
        `or add them to DELIBERATELY_UNREACHABLE with a reason:\n  ${orphans.join("\n  ")}`,
    ).toEqual([]);
  }, 60_000);

  it("the deliberate exclusions are real routes, not stale names", async () => {
    // An exclusion for a route that no longer exists is an excuse nobody
    // rechecks — and it would silently absolve a future route of the same name.
    const endpoints = await surface();
    for (const [prefix, reason] of DELIBERATELY_UNREACHABLE) {
      expect(reason.length, `${prefix} needs a reason`).toBeGreaterThan(20);
      expect(
        endpoints.some((e) => e.pattern === prefix || e.pattern.startsWith(prefix + "/")),
        `DELIBERATELY_UNREACHABLE names '${prefix}', which is not a route any more`,
      ).toBe(true);
    }
  }, 60_000);

  it("and no persona reaches the other product's routes", async () => {
    // The domain gate already 404s these inside the API. This asserts the EDGE
    // would refuse them too — defence in depth is the entire reason the persona
    // containers exist, so it must not quietly rely on the API behind it.
    const endpoints = await surface();
    const { classifyRoute } = await import("../src/http/route-domains.js");
    const crossed: string[] = [];
    for (const persona of PERSONAS) {
      for (const e of endpoints) {
        const domain = classifyRoute(e.pattern);
        if (domain === "shared" || domain === undefined || domain === persona.domain) continue;
        if (personaAllows(persona, e.method, e.pattern)) crossed.push(`${persona.key} → ${e.method} ${e.pattern} (${domain})`);
      }
    }
    expect(crossed, `personas admitting the other product's routes:\n  ${crossed.join("\n  ")}`).toEqual([]);
  }, 60_000);
});
