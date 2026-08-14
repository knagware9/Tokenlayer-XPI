/**
 * THE WEB'S PERSONA MIRROR MUST NOT DRIFT FROM CORE'S.
 *
 * `apps/web/src/personas.ts` restates the shell half of the catalogue because
 * the web package does not depend on core — the same arrangement as API_SCOPES
 * and CERTIFICATE_FIXED_FIELDS. A mirror with nothing checking it is a copy that
 * will be wrong, and the symptom here is specific and unhelpful: a container
 * whose sidebar is missing an entry that the edge in front of it happily
 * proxies, or worse, whose landing view no longer exists.
 *
 * This test lives in the API package because it is the only one that can import
 * core AND read the web file. It parses rather than imports, since the web
 * module is browser-targeted TSX-adjacent source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERSONAS } from "@tokenlayer/core";

const WEB_PERSONAS = fileURLToPath(new URL("../../web/src/personas.ts", import.meta.url));
const source = readFileSync(WEB_PERSONAS, "utf8");

/** Pull one persona's mirrored fields out of the web source. */
function mirrored(key: string): { label?: string; domain?: string; defaultView?: string; shell?: string; surfaces?: string[] } {
  const start = source.indexOf(`key: "${key}"`);
  if (start < 0) return {};
  const end = source.indexOf("  {", start) > 0 ? source.indexOf("\n  },", start) : source.length;
  const block = source.slice(start, end < 0 ? source.length : end);
  const one = (field: string) => block.match(new RegExp(`${field}: "([^"]*)"`))?.[1];
  const surfaces = block.match(/surfaces: \[([\s\S]*?)\]/)?.[1];
  return {
    label: one("label"),
    domain: one("domain"),
    defaultView: one("defaultView"),
    shell: one("shell"),
    surfaces: surfaces ? [...surfaces.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : undefined,
  };
}

describe("apps/web/src/personas.ts mirrors packages/core/src/personas.ts", () => {
  it("mirrors every persona — none missing, none invented", () => {
    for (const persona of PERSONAS) {
      expect(source, `web mirror is missing '${persona.key}'`).toContain(`key: "${persona.key}"`);
    }
    const keysInWeb = [...source.matchAll(/key: "([a-z-]+)"/g)].map((m) => m[1]!);
    expect(keysInWeb.sort()).toEqual(PERSONAS.map((p) => p.key).sort());
  });

  it.each(PERSONAS.map((p) => p.key))("%s agrees on label, domain, default view and surfaces", (key) => {
    const core = PERSONAS.find((p) => p.key === key)!;
    const web = mirrored(key);
    expect(web.label, "label").toBe(core.label);
    expect(web.domain, "domain").toBe(core.domain);
    expect(web.defaultView, "defaultView").toBe(core.defaultView);
    expect(web.shell, "shell").toBe(core.shell);
    expect(web.surfaces, "surfaces").toEqual([...core.surfaces]);
  });

  it("does NOT mirror the route allowlist", () => {
    // The `allow` rules are enforced by nginx and the API. A copy in the browser
    // bundle would be a fourth description of the boundary that no user agent
    // consults and nobody would think to audit — and it would read, to someone
    // skimming, as though the browser were enforcing something.
    expect(source).not.toContain("allow:");
    expect(source).not.toContain("methods:");
  });
});
