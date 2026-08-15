/**
 * THE PRODUCT BOUNDARY IN THE API'S SERVICE LAYER — AND ITS ONE LEGAL DOOR.
 *
 * `apps/api/src` is `shared/`, `tokenization/`, `identity/`, `dev/`, with only
 * the composition root left at the top. The rule is not the flat "never import
 * each other" that packages/core follows, because that would be a lie here:
 * tokenization genuinely asks identity whether a subject is verified. That
 * question IS the product seam.
 *
 *     identity/     must NEVER import tokenization/            (0 edges)
 *     tokenization/ may import identity/ through ONE module:   identity-assertions
 *     nothing       may import dev/                            (harnesses are leaves)
 *
 * Naming the door is the point. The same oracle is what the SPLIT deployment
 * reaches over the network with a peer key, and what `/identity/assertions` —
 * on no persona's edge allowlist — exists to gate. So the in-process seam and
 * the over-the-network seam are the same single module, and a second edge
 * appearing here would mean the two topologies had quietly diverged: code that
 * works when both products share a process and fails when they do not.
 *
 * That is the failure this catches, and it is invisible to every other check.
 * A tokenization service importing `identity/certificate.js` compiles, passes
 * the suite, and works perfectly in the combined deployment — then throws
 * MODULE_NOT_FOUND, or silently serves a route that no longer exists, in the
 * tokenization-only container that is the whole reason for the split.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const FAMILIES = ["shared", "tokenization", "identity", "dev"] as const;

/** The composition root: config and wiring, owned by no single product. */
const COMPOSITION_ROOT = ["app.ts", "context.ts", "env.ts", "server.ts"];

/**
 * The ONE module tokenization may reach into identity for. It is the in-process
 * form of the same question the split deployment asks over HTTP.
 */
const SEAM = "identity-assertions";

const filesIn = (family: string) => readdirSync(`${SRC}/${family}`).filter((f) => f.endsWith(".ts"));

/** Every `../<family>/<module>.js` a file imports. */
function crossEdges(from: string, to: string): string[] {
  const out: string[] = [];
  for (const file of filesIn(from)) {
    const src = readFileSync(`${SRC}/${from}/${file}`, "utf8");
    for (const m of src.matchAll(new RegExp(`from "\\.\\./${to}/([a-z0-9-]+)\\.js"`, "g"))) {
      out.push(`${from}/${file} → ${to}/${m[1]}`);
    }
  }
  return out;
}

describe("the API's service layer is split by product", () => {
  it("every family holds a meaningful number of modules", () => {
    // An empty family would make the edge checks below pass vacuously.
    for (const f of FAMILIES) expect(filesIn(f).length, f).toBeGreaterThan(4);
  });

  it("only the composition root is left loose at the top of src/", () => {
    const loose = readdirSync(SRC).filter((f) => f.endsWith(".ts")).sort();
    expect(loose, `these belong to a product, or to the composition root:\n  ${loose.join("\n  ")}`)
      .toEqual(COMPOSITION_ROOT);
  });

  it("IDENTITY never reaches into TOKENIZATION — not once, not through a seam", () => {
    // The asymmetry is deliberate. Identity is the service being ASKED; a
    // dependency pointing the other way would make the identity-only
    // deployment need the asset ledger to boot.
    const offenders = crossEdges("identity", "tokenization");
    expect(offenders, `the identity-only container would need tokenization code:\n  ${offenders.join("\n  ")}`)
      .toEqual([]);
  });

  it("TOKENIZATION reaches into IDENTITY only through the named seam", () => {
    const edges = crossEdges("tokenization", "identity");
    const illegal = edges.filter((e) => !e.endsWith(`identity/${SEAM}`));
    expect(
      illegal,
      `tokenization may ask identity ONE question, through identity/${SEAM}.js — the same\n` +
        `oracle the split deployment calls over the network. These are other doors:\n  ${illegal.join("\n  ")}`,
    ).toEqual([]);
  });

  it("…and that seam is actually present, so the rule above is not vacuous", () => {
    // If the seam ever disappeared, the check above would pass by accident and
    // stop describing anything. The products ARE connected; this is where.
    const edges = crossEdges("tokenization", "identity");
    expect(edges.length, "the tokenization→identity seam has vanished").toBeGreaterThan(0);
    expect(edges.every((e) => e.endsWith(`identity/${SEAM}`))).toBe(true);
  });

  it("nothing imports the dev harnesses", () => {
    // demo.ts and the e2e-* scripts exist to be RUN, never linked. A service
    // importing one would drag seed data and a whole app factory into the
    // production bundle.
    const offenders = (["shared", "tokenization", "identity"] as const).flatMap((f) => crossEdges(f, "dev"));
    expect(offenders, `dev/ is for running, not for importing:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
