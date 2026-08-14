/**
 * A ROUTE MUST LIVE IN ITS OWN PRODUCT'S FILE.
 *
 * `http/routes/` is one file per product, and the division only means something
 * while it stays true. Nothing stops someone adding `/credentials/:id/reissue`
 * to tokenization.ts — it compiles, it works, and the folder quietly stops
 * describing anything.
 *
 * The oracle already exists and is used by the running server:
 * `classifyRoute()` in route-domains.ts decides which product owns a path, and
 * `applyDomainGate` 404s it on a deployment that does not sell that product. So
 * this test asks the one question that matters — does the FILE a route is
 * declared in agree with the DOMAIN the gate will judge it by? A route in the
 * wrong file is not cosmetic: it is a route whose neighbours, helpers and
 * reviewers all belong to a different product from the one it is gated as.
 *
 * Read from source rather than from Fastify's table, for the reason
 * scope-coverage.test.ts gives at length: what is under test is the
 * DECLARATION — the shape a future author copies.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyRoute } from "../src/http/route-domains.js";

const DIR = fileURLToPath(new URL("../src/http/routes", import.meta.url));
const FAMILIES = ["shared", "tokenization", "identity"] as const;

/** Every `app.<method>("<path>"` declared in one family's file. */
function routesIn(family: string): { method: string; path: string }[] {
  const src = readFileSync(`${DIR}/${family}.ts`, "utf8");
  return [...src.matchAll(/app\.(get|post|put|patch|delete)\("([^"]+)"/g)]
    .map((m) => ({ method: m[1]!.toUpperCase(), path: m[2]! }));
}

describe("every route sits in the file for the product that owns it", () => {
  it("each family declares a meaningful number of routes", () => {
    // An empty family would make the agreement check below pass vacuously.
    for (const f of FAMILIES) expect(routesIn(f).length, f).toBeGreaterThan(20);
  });

  it.each(FAMILIES)("%s.ts declares only %s routes", (family) => {
    const wrong = routesIn(family)
      .map((r) => ({ ...r, domain: classifyRoute(r.path) }))
      .filter((r) => r.domain !== family)
      .map((r) => `${r.method} ${r.path} is ${r.domain}, declared in ${family}.ts`);
    expect(
      wrong,
      `move these, or fix their classification in route-domains.ts:\n  ${wrong.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no route is declared twice across the families", () => {
    // The split moved 132 declarations by hand-checked line ranges. A duplicate
    // would register the same path twice and Fastify would refuse to boot — but
    // only for the deployment that enables both products, which is not the one
    // most people run locally.
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const family of FAMILIES) {
      for (const r of routesIn(family)) {
        const key = `${r.method} ${r.path}`;
        if (seen.has(key)) dupes.push(`${key} — in ${seen.get(key)}.ts and ${family}.ts`);
        else seen.set(key, family);
      }
    }
    expect(dupes, `duplicated route declarations:\n  ${dupes.join("\n  ")}`).toEqual([]);
  });

  it("the products' files do not import each other", () => {
    // Same rule packages/core follows. A tokenization route reaching into
    // identity.ts would tie two files that ship to different containers.
    const offenders: string[] = [];
    for (const a of ["tokenization", "identity"] as const) {
      const other = a === "tokenization" ? "identity" : "tokenization";
      const src = readFileSync(`${DIR}/${a}.ts`, "utf8");
      if (new RegExp(`from "\\./${other}\\.js"`).test(src)) offenders.push(`${a}.ts → ${other}.ts`);
    }
    expect(offenders).toEqual([]);
  });
});
