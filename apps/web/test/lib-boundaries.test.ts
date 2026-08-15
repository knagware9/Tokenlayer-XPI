/**
 * THE PRODUCT BOUNDARY IN THE WEB'S LIB.
 *
 * `src/lib/` is `shared/` and `identity/`. The rule matches the one
 * `src/components/` follows, and for the same reason:
 *
 *     identity/ and tokenization/ must never import each other.
 *     shared/ MAY import both.
 *
 * THERE IS NO `tokenization/` FOLDER, and that is a finding rather than an
 * oversight. Classifying all 16 modules turned up FOUR that belong to identity
 * — the certificate designer's access gate, the certificate layout maths, the
 * public verification page's helpers, the scheme catalogue — and TWELVE that
 * serve both products. Not one is tokenization-only.
 *
 * That is worth knowing: the tokenization product's logic lives in its
 * components, while identity has grown a body of pure, testable rules beside
 * them. An empty `tokenization/` folder would have looked tidier and said
 * something false — that there is tokenization lib code, and this is where it
 * goes. The test below therefore does not demand three folders. It demands
 * that whatever folders exist obey the rule, and it will start enforcing
 * `tokenization/` the moment a real one appears.
 *
 * The failure this catches is the same one components/ guards against: an
 * import that WORKS in the combined app and is missing code in the
 * single-product deployment nobody runs locally.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LIB = fileURLToPath(new URL("../src/lib", import.meta.url));

const families = () => readdirSync(LIB, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const filesIn = (family: string) => readdirSync(`${LIB}/${family}`).filter((f) => f.endsWith(".ts"));

/** The sibling families a module reaches into. */
function crossImports(from: string, to: string): string[] {
  // BOTH sides, not just the destination. A family that does not exist yet
  // cannot import anything and cannot be imported from — and scanning it
  // throws ENOENT, which reads as a boundary violation rather than an absence.
  if (!existsSync(`${LIB}/${from}`) || !existsSync(`${LIB}/${to}`)) return [];
  const out: string[] = [];
  for (const file of filesIn(from)) {
    const src = readFileSync(`${LIB}/${from}/${file}`, "utf8");
    for (const m of src.matchAll(new RegExp(`from "\\.\\./${to}/([a-z0-9-]+)\\.js"`, "g"))) {
      out.push(`lib/${from}/${file} → lib/${to}/${m[1]}`);
    }
  }
  return out;
}

describe("the product boundary holds in apps/web/src/lib", () => {
  it("every family present is non-empty, and none is a placeholder", () => {
    // A folder that exists but holds nothing is a claim about where code lives
    // that no code supports — exactly what leaving an empty `tokenization/`
    // behind would have been.
    const fams = families();
    expect(fams.length, "lib has no domain folders at all").toBeGreaterThan(0);
    for (const f of fams) expect(filesIn(f).length, `lib/${f}/ is empty`).toBeGreaterThan(0);
  });

  it("no module is left loose at the top of lib/", () => {
    const loose = readdirSync(LIB).filter((f) => f.endsWith(".ts"));
    expect(loose, `not in a domain folder: ${loose.join(", ")}`).toEqual([]);
  });

  it("identity/ and tokenization/ never import each other", () => {
    // Vacuous today — there is no tokenization/ — and deliberately written so
    // it starts working the moment one appears, rather than being remembered.
    const offenders = [...crossImports("identity", "tokenization"), ...crossImports("tokenization", "identity")];
    expect(offenders, `a single-product build would be missing code:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("shared/ is genuinely shared — the components of BOTH products draw on it", () => {
    // Without this, `shared/` is just "everything else". What makes the name
    // true is that both product component families actually import from it.
    const COMPONENTS = fileURLToPath(new URL("../src/components", import.meta.url));
    for (const family of ["tokenization", "identity"] as const) {
      const uses = readdirSync(`${COMPONENTS}/${family}`)
        .filter((f) => f.endsWith(".tsx"))
        .some((f) => /from "\.\.\/\.\.\/lib\/shared\//.test(readFileSync(`${COMPONENTS}/${family}/${f}`, "utf8")));
      expect(uses, `components/${family}/ imports nothing from lib/shared/`).toBe(true);
    }
  });

  it("only identity components use lib/identity/", () => {
    // The other direction of the same boundary: if a tokenization screen
    // reached for the certificate designer's access gate, the identity split
    // would be describing nothing.
    const COMPONENTS = fileURLToPath(new URL("../src/components", import.meta.url));
    const offenders = readdirSync(`${COMPONENTS}/tokenization`)
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /from "\.\.\/\.\.\/lib\/identity\//.test(readFileSync(`${COMPONENTS}/tokenization/${f}`, "utf8")))
      .map((f) => `components/tokenization/${f}`);
    expect(offenders, `tokenization screens reaching into identity lib:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
