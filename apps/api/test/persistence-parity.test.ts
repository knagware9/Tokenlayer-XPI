/**
 * THE PARITY RULE, MADE MECHANICAL.
 *
 * Every persisted field has to land in the Prisma schema, the record type, the
 * mapper, and BOTH repositories — memory and Prisma — in one change. The half
 * that keeps getting missed is the second repository, because nothing fails
 * when it is: the API suite runs on the memory repositories, so a field added
 * to Prisma alone passes every test and is simply absent in production, while a
 * field added to memory alone passes every test and is absent from the database.
 * Twice now that has been caught by a person remembering the rule at review
 * time (the brand columns, the login keys), which is not a mechanism.
 *
 * Splitting `memory.ts` and `prisma.ts` into `memory/<domain>.ts` and
 * `prisma/<domain>.ts` is what makes the rule checkable, and this suite is the
 * reason the split was worth doing at all. Three things are pinned:
 *
 *   1. EVERY REPOSITORY HAS A TWIN, in the SAME domain file. A repository
 *      written into only one of the two backends is the drift itself.
 *   2. EACH TWIN SITS IN THE BUCKET `model-domains.ts` DECLARES. The file a
 *      repository lives in is a claim about who owns its table, and that claim
 *      is checked against the one place ownership is actually decided.
 *   3. NO REPOSITORY IS LOOSE at the top of `persistence/`, which is where the
 *      two 2,400-line files used to put all of them.
 *
 * WHAT THIS DOES NOT CHECK, stated rather than implied: that the two twins
 * store the same FIELDS. Comparing field sets across a Prisma row and a plain
 * object would mean parsing both mappers, and a shape-approximating test that
 * quietly disagrees with the compiler is worse than no test — this file's whole
 * subject is checks that answer the wrong question confidently. What holds the
 * field-level half is the shared `…Repository` interface both classes
 * implement: a method missing from either side is a compile error today. This
 * suite covers the case tsc cannot see, which is a repository (or an entire
 * table's worth of storage) existing on one side and not the other.
 *
 * The interface → domain mapping is DERIVED, never written down here. It chains
 * three declarations that already exist and are already enforced elsewhere:
 * `AppDeps` (key → interface), `REPOSITORY_MODELS` (key → model), and
 * `MODEL_DOMAINS` (model → domain). A fourth hand-maintained copy in a test
 * file would be one more thing to drift.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODEL_DOMAINS, REPOSITORY_MODELS, type DataDomain } from "../src/persistence/model-domains.js";

const SRC = fileURLToPath(new URL("../src/persistence", import.meta.url));
const DOMAINS = ["shared", "tokenization", "identity"] as const;

const read = (rel: string) => readFileSync(`${SRC}/${rel}`, "utf8");

/** The `…Repository` interfaces a file implements — the join key between backends. */
function implementedIn(rel: string): string[] {
  return [...read(rel).matchAll(/implements\s+(\w+Repository)\b/g)].map((m) => m[1]!).sort();
}

/**
 * `AppDeps` field name → the interface it is typed as.
 *
 * Parsed from `context.ts` rather than imported because the mapping wanted here
 * is between a NAME and a TYPE, and types do not survive to runtime.
 */
function appDepsRepositoryTypes(): Map<string, string> {
  const src = readFileSync(fileURLToPath(new URL("../src/context.ts", import.meta.url)), "utf8");
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^\s{2}(\w+):\s*(\w+Repository);/gm)) out.set(m[1]!, m[2]!);
  return out;
}

/**
 * The product that owns `iface`'s table.
 *
 * Two routes to the same answer, because two facts are true at once: most
 * repositories reach `AppDeps` and are classified there by key (`cash` →
 * `CashBalance`, `audit` → `AuditLog` — neither of which the interface name
 * spells), and `RegistryDeploymentRepository` deliberately never reaches
 * `AppDeps` at all, so it can only be classified by its model name.
 *
 * NO DEFAULT. A repository neither route can place throws, exactly as an
 * unclassified model does in `classifyModel` — a guess here would put a
 * repository in a bucket nobody chose and report success.
 */
function domainOfRepository(iface: string, depsTypes: Map<string, string>): DataDomain {
  const key = [...depsTypes].find(([, type]) => type === iface)?.[0];
  const model = (key && REPOSITORY_MODELS[key]) ?? iface.replace(/Repository$/, "");
  const domain = MODEL_DOMAINS[model];
  if (!domain) {
    throw new Error(
      `[parity] cannot place '${iface}': no AppDeps key names it, and '${model}' is not a model in MODEL_DOMAINS. ` +
        "Either wire it into AppDeps with an entry in REPOSITORY_MODELS, or name the class after its table.",
    );
  }
  return domain;
}

describe("memory and Prisma repositories stay in step", () => {
  it("every repository exists in BOTH backends, in the same domain file", () => {
    // The PARITY RULE itself. A repository present in one file and absent from
    // its twin is a table this deployment can write in tests and not in
    // production, or the reverse — and nothing else in the suite notices.
    for (const domain of DOMAINS) {
      const memory = implementedIn(`memory/${domain}.ts`);
      const prisma = implementedIn(`prisma/${domain}.ts`);
      expect(memory.length, `memory/${domain}.ts implements no repositories`).toBeGreaterThan(0);
      expect(
        prisma,
        `memory/${domain}.ts and prisma/${domain}.ts have drifted:\n` +
          `  only in memory: ${memory.filter((r) => !prisma.includes(r)).join(", ") || "—"}\n` +
          `  only in prisma: ${prisma.filter((r) => !memory.includes(r)).join(", ") || "—"}`,
      ).toEqual(memory);
    }
  });

  it("each repository sits in the bucket model-domains.ts declares for its table", () => {
    // The file a repository lives in is a CLAIM about who owns its data. This
    // is what stops the claim being made by whoever ran the split rather than
    // by the one table where ownership is actually decided.
    const depsTypes = appDepsRepositoryTypes();
    const misfiled: string[] = [];
    for (const domain of DOMAINS) {
      for (const backend of ["memory", "prisma"] as const) {
        for (const iface of implementedIn(`${backend}/${domain}.ts`)) {
          const declared = domainOfRepository(iface, depsTypes);
          if (declared !== domain) misfiled.push(`${backend}/${domain}.ts holds ${iface}, declared '${declared}'`);
        }
      }
    }
    expect(misfiled, `repositories filed against MODEL_DOMAINS:\n  ${misfiled.join("\n  ")}`).toEqual([]);
  });

  it("covers every repository AppDeps is built from", () => {
    // A positive control on the two tests above. Both iterate what the folders
    // happen to contain, so deleting a domain file — or all six — would leave
    // them passing on an empty set. This asserts the other direction: every
    // repository the running application actually wires up was one of the
    // things just checked.
    const found = new Set(DOMAINS.flatMap((d) => implementedIn(`memory/${d}.ts`)));
    const missing = [...appDepsRepositoryTypes().values()].filter((iface) => !found.has(iface));
    expect(missing, `wired into AppDeps but in no memory/<domain>.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("no repository is left loose at the top of persistence/", () => {
    // Where all 23 used to live, in two files of ~2,400 lines. A repository
    // added back at the top level is outside every check above.
    const loose = readdirSync(SRC)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /implements\s+\w+Repository\b/.test(read(f)));
    expect(loose, `repositories outside memory/ and prisma/: ${loose.join(", ")}`).toEqual([]);
  });
});
