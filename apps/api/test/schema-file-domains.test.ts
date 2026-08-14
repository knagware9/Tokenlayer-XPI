/**
 * A ROUTE'S SCHEMA LIVES IN ITS ROUTE'S PRODUCT.
 *
 * `http/schemas/` mirrors `http/routes/`: one file per product. The split was
 * unusually clean — all 131 entries turned out to be referenced by exactly one
 * route file — and that is precisely the property worth pinning, because
 * nothing about adding `S.newThing` to the wrong file would fail otherwise. The
 * schema would work, the route would work, and the two folders would slowly
 * stop meaning the same thing.
 *
 * The check reads the ROUTE files for `S.<key>` rather than trusting a list:
 * the reference is the real relationship, and it is the one that would change
 * if someone moved a route between products and forgot its schema.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HTTP = fileURLToPath(new URL("../src/http", import.meta.url));
const FAMILIES = ["shared", "tokenization", "identity"] as const;

/** The `S.x` keys one product's ROUTE file references. */
function schemaKeysUsedBy(family: string): Set<string> {
  const src = readFileSync(`${HTTP}/routes/${family}.ts`, "utf8");
  return new Set([...src.matchAll(/\bS\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
}

/** The keys one product's SCHEMA file declares. */
function schemaKeysDeclaredIn(family: string): string[] {
  const src = readFileSync(`${HTTP}/schemas/${family}.ts`, "utf8");
  return [...src.matchAll(/^  ([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]!);
}

describe("schemas/ mirrors routes/", () => {
  it("each family declares a meaningful number of schemas", () => {
    for (const f of FAMILIES) expect(schemaKeysDeclaredIn(f).length, f).toBeGreaterThan(20);
  });

  it.each(FAMILIES)("every schema in %s.ts is used by that product's routes", (family) => {
    const used = schemaKeysUsedBy(family);
    const stranded = schemaKeysDeclaredIn(family).filter((k) => !used.has(k));
    expect(
      stranded,
      `declared in schemas/${family}.ts but not referenced by routes/${family}.ts — ` +
        `either the route moved and its schema did not, or the schema is dead:\n  ${stranded.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no schema key is declared in two files", () => {
    // `S` is assembled by spreading the three, so a duplicate key would be
    // silently resolved by spread order — the LAST one wins, and a route would
    // validate against a schema written for a different product.
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const family of FAMILIES) {
      for (const k of schemaKeysDeclaredIn(family)) {
        if (seen.has(k)) dupes.push(`${k} — in ${seen.get(k)}.ts and ${family}.ts`);
        else seen.set(k, family);
      }
    }
    expect(dupes, `duplicate schema keys:\n  ${dupes.join("\n  ")}`).toEqual([]);
  });

  it("every S.<key> a route references is declared somewhere", () => {
    // The opposite direction: a route pointing at a schema that does not exist
    // gets `undefined`, which Fastify accepts as "no schema" — so the route
    // silently loses its validation AND its response serialisation.
    const declared = new Set(FAMILIES.flatMap((f) => schemaKeysDeclaredIn(f)));
    const missing: string[] = [];
    for (const family of FAMILIES) {
      for (const k of schemaKeysUsedBy(family)) if (!declared.has(k)) missing.push(`routes/${family}.ts → S.${k}`);
    }
    expect(missing, `routes referencing a schema that does not exist:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("the products' schema files do not import each other", () => {
    for (const a of ["tokenization", "identity"] as const) {
      const other = a === "tokenization" ? "identity" : "tokenization";
      const src = readFileSync(`${HTTP}/schemas/${a}.ts`, "utf8");
      expect(new RegExp(`from "\\./${other}\\.js"`).test(src), `${a}.ts imports ${other}.ts`).toBe(false);
    }
  });
});
