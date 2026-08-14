/**
 * THE PRODUCT BOUNDARY, IN THE UI.
 *
 * `src/components/` is `shared/`, `tokenization/`, `identity/` — the same
 * division as packages/core and apps/api/src/http/routes. The rule here is
 * ONE-WAY, and deliberately weaker than core's:
 *
 *     identity/ and tokenization/ must never import each other.
 *     shared/ MAY import both.
 *
 * The asymmetry is real rather than a concession. `shared/` holds the shell —
 * AppShell, PlatformHome, App's chrome — and a shell's whole job is to compose
 * the products it fronts. Forbidding that would push the composition somewhere
 * worse. What must not happen is the credential wizard reaching into the asset
 * ledger, because those two ship in different containers to different audiences
 * and neither can assume the other's screens exist.
 *
 * The interesting failure this catches is not an import that breaks a build —
 * the build would catch that. It is one that WORKS: an identity panel importing
 * a tokenization component renders perfectly in the full app, and is a blank
 * space or a crash in the identity-only deployment nobody runs locally.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../src/components", import.meta.url));
const FAMILIES = ["shared", "tokenization", "identity"] as const;

const filesIn = (family: string) => readdirSync(`${DIR}/${family}`).filter((f) => f.endsWith(".tsx"));

/** The sibling families a component reaches into. */
function crossImports(family: string, file: string): string[] {
  const src = readFileSync(`${DIR}/${family}/${file}`, "utf8");
  return [...src.matchAll(/from\s+"\.\.\/([a-z]+)\/[A-Za-z]+\.js"/g)].map((m) => m[1]!);
}

describe("the product boundary holds in apps/web/src/components", () => {
  it("every family has components in it", () => {
    for (const f of FAMILIES) expect(filesIn(f).length, f).toBeGreaterThan(5);
  });

  it("no component is left loose at the top of components/", () => {
    // One left behind belongs to no product — the state this restructure removed.
    const loose = readdirSync(DIR).filter((f) => f.endsWith(".tsx"));
    expect(loose, `not in a domain folder: ${loose.join(", ")}`).toEqual([]);
  });

  it("IDENTITY components never import TOKENIZATION ones", () => {
    const offenders: string[] = [];
    for (const f of filesIn("identity")) {
      for (const t of crossImports("identity", f)) if (t === "tokenization") offenders.push(`identity/${f} → tokenization/`);
    }
    expect(offenders, `the identity-only app would ship tokenization screens:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("TOKENIZATION components never import IDENTITY ones", () => {
    const offenders: string[] = [];
    for (const f of filesIn("tokenization")) {
      for (const t of crossImports("tokenization", f)) if (t === "identity") offenders.push(`tokenization/${f} → identity/`);
    }
    expect(offenders, `the tokenization-only app would ship identity screens:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("shared/ is genuinely shared — both products draw on it", () => {
    // If nothing imported shared/, the folder would just be "everything else".
    // Both products depending on it is what makes the name true.
    for (const family of ["tokenization", "identity"] as const) {
      const uses = filesIn(family).some((f) => crossImports(family, f).includes("shared"));
      expect(uses, `${family}/ imports nothing from shared/`).toBe(true);
    }
  });
});
