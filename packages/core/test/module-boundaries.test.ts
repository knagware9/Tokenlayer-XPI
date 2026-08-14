/**
 * THE RULE THAT KEEPS THE FOLDERS MEANINGFUL.
 *
 * `src/` is divided by product — `shared/`, `tokenization/`, `identity/` — and a
 * division with nothing enforcing it lasts about three features. Someone adds an
 * import that happens to compile, the folders stop describing anything, and the
 * next person to look for "the identity code" finds it scattered again.
 *
 * ONE INVARIANT, and it is the same one the deployment relies on:
 *
 *     identity/ and tokenization/ may both use shared/.
 *     Neither may import the other. Ever.
 *
 * That is not a style preference. `ENABLED_DOMAINS` lets a deployment serve one
 * product, `docker-compose.identity.yml` ships one, and the persona edges refuse
 * the other's routes at the network. A single import across this line means the
 * separation those three things describe is not real in the source they all run.
 *
 * `shared/` importing DOWN into a product would be the same failure wearing a
 * different hat, so that is checked too: shared code is what both products
 * stand on, and it cannot know which one is asking.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const DOMAINS = ["shared", "tokenization", "identity"] as const;

/** Every `from "../<domain>/x.js"` a file reaches for. */
function crossImports(dir: string, file: string): string[] {
  const body = readFileSync(`${SRC}/${dir}/${file}`, "utf8");
  return [...body.matchAll(/from\s+"\.\.\/([a-z]+)\/[a-z-]+\.js"/g)].map((m) => m[1]!);
}

const filesIn = (dir: string) => readdirSync(`${SRC}/${dir}`).filter((f) => f.endsWith(".ts"));

describe("the product boundary holds inside packages/core", () => {
  it("every domain folder has modules in it — an empty one would pass vacuously", () => {
    for (const d of DOMAINS) expect(filesIn(d).length, d).toBeGreaterThan(3);
  });

  it("IDENTITY never imports from TOKENIZATION", () => {
    const offenders: string[] = [];
    for (const f of filesIn("identity")) {
      for (const target of crossImports("identity", f)) {
        if (target === "tokenization") offenders.push(`identity/${f} → tokenization/`);
      }
    }
    expect(offenders, `an identity-only deployment would carry tokenization code:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("TOKENIZATION never imports from IDENTITY", () => {
    const offenders: string[] = [];
    for (const f of filesIn("tokenization")) {
      for (const target of crossImports("tokenization", f)) {
        if (target === "identity") offenders.push(`tokenization/${f} → identity/`);
      }
    }
    expect(offenders, `a tokenization-only deployment would carry identity code:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("SHARED never imports from either product", () => {
    // Shared is what both stand on. Reaching down into one of them means it is
    // not shared — it is that product's code in the wrong folder, and it would
    // be compiled into the deployment that does not sell it.
    const offenders: string[] = [];
    for (const f of filesIn("shared")) {
      for (const target of crossImports("shared", f)) {
        if (target !== "shared") offenders.push(`shared/${f} → ${target}/`);
      }
    }
    expect(offenders, `shared code that belongs to one product:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("index.ts is the only thing at the top of src/", () => {
    // A module left loose at the root belongs to no product, which is exactly
    // the state this restructure removed.
    const loose = readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== "index.ts");
    expect(loose, `these modules are not in a domain folder: ${loose.join(", ")}`).toEqual([]);
  });

  it("index.ts still re-exports every module, so no consumer import changed", () => {
    const idx = readFileSync(`${SRC}/index.ts`, "utf8");
    for (const d of DOMAINS) {
      for (const f of filesIn(d)) {
        const spec = `./${d}/${f.replace(/\.ts$/, ".js")}`;
        expect(idx, `${spec} is not re-exported from index.ts`).toContain(spec);
      }
    }
  });
});
