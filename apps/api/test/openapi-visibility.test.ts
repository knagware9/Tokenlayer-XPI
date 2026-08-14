import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { components, S } from "../src/http/schemas/index.js";
import { buildTestApp, V1 } from "./helpers.js";
import { declaredRoutes, routeKey } from "./route-decls.js";

/**
 * EN-D1 final review, MEDIUM 2: `hide: true` ESCAPES THE WHOLE MECHANISM.
 *
 * Every guard this branch added polices the `doc → declaration` direction:
 * `openapi-contract.test.ts` checks that each operation IN the document traces
 * back to a route, and `openapi-snapshot.json` notices when a COMMITTED
 * operation disappears. Neither can see an operation that was never published
 * in the first place.
 *
 * MEASURED by the reviewer, not imagined: a live, scope-gated route whose
 * schema carried `hide: true` passed `openapi-contract`, `openapi-snapshot` and
 * `scope-coverage` together — 30 tests, 0 failures — while being absent from
 * the document, from `/openapi.json`, from the in-app Reference and from the
 * committed snapshot, with no diff anywhere. `src/app.ts` already uses
 * `schema: { hide: true }` for `/openapi.json` itself, so this is a plausible
 * copy-paste rather than a contrived case.
 *
 * What is at stake is DOCUMENTATION, not authorization: the security gate still
 * runs on a hidden route, so nothing is exposed. What is lost is that an entire
 * route can leave the published surface without a single line appearing in a
 * diff a human reads — which is the one thing the snapshot exists to prevent.
 *
 * So the missing direction is asserted here: `declaration → doc`. Every route
 * declared in routes.ts must appear in the published document, or be named in
 * `HIDDEN_ROUTES` with a reason, exactly like every other exemption on this
 * branch.
 */

/**
 * Routes deliberately absent from the published document, with the reason.
 *
 * EMPTY, and that is the point: today every route in `routes.ts` is published.
 * An entry here is a route integrators cannot discover, which needs an argument
 * — not a flag. The staleness check below keeps it from accumulating fiction.
 *
 * (`/openapi.json` is not a candidate: it is registered on the docs plugin in
 * `src/app.ts`, not in `routes.ts`, so it is not a declaration this test reads.
 * Hiding the document from itself is the one use of the flag that is obviously
 * right, and it is out of this test's scope by construction.)
 */
const HIDDEN_ROUTES: Record<string, string> = {};

/** The document path an OpenAPI generator gives a Fastify declaration. */
const documentedPath = (path: string): string => `${V1}${path.replace(/:(\w+)/g, "{$1}")}`;

describe("no route can leave the published document unnoticed", () => {
  it("every declared route appears in the document", async () => {
    const app = await buildTestApp();
    await app.ready(); // @fastify/swagger builds the document at ready(); calling swagger() before it throws.
    const doc = app.swagger() as unknown as { paths: Record<string, Record<string, unknown>> };

    const declared = declaredRoutes();
    // The oracle must be populated. A document that failed to build would make
    // every route "missing" — loud — but a declaration list that came back
    // empty would make this test pass on nothing at all.
    expect(declared.length, "the route parser returned nothing — see route-decls.ts").toBeGreaterThan(100);

    const missing: string[] = [];
    for (const r of declared) {
      if (routeKey(r) in HIDDEN_ROUTES) continue;
      const ops = doc.paths[documentedPath(r.path)];
      const published = ops !== undefined && Object.keys(ops).some((m) => m.toUpperCase() === r.method);
      if (!published) {
        missing.push(
          `${routeKey(r)} (S.${r.schema}) is a live route that the document does not publish. ` +
            `The usual cause is \`hide: true\` on its schema, which removes it from /openapi.json, from the in-app ` +
            `Reference and from the committed snapshot without changing a single line of any of them. ` +
            `Publish it, or add it to HIDDEN_ROUTES with the reason integrators must not discover it.`,
        );
      }
    }
    // Collected rather than thrown one at a time: one run should print the whole
    // work queue, not just whichever route sorts first.
    expect(missing, `\n${missing.join("\n")}\n`).toEqual([]);
  });

  it("no route schema sets `hide` at all", () => {
    // The direct half, and the cheap one. The check above is the property that
    // matters — it catches a route vanishing for ANY reason, including a
    // registration that silently failed — but it needs a booted app and it
    // names the symptom. This names the cause, in the file the author is
    // editing, the moment they add the flag.
    const flagged: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach((child, i) => walk(child, `${where}[${i}]`)); return; }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "hide") flagged.push(`${where}.hide = ${JSON.stringify(v)}`);
        else walk(v, `${where}.${k}`);
      }
    };
    for (const [name, schema] of Object.entries(S)) walk(schema, `S.${name}`);
    for (const c of components) walk(c, `${(c as { $id: string }).$id}#`);
    expect(
      flagged,
      `\`hide\` removes an operation from the published document, the in-app Reference and the committed snapshot ` +
        `with no diff anywhere:\n${flagged.join("\n")}\n`,
    ).toEqual([]);
  });

  it("the hidden-route list has no stale entries", () => {
    // Same discipline as PRE_EXISTING_NARROWING, DOCUMENTATION_DEFERRED,
    // NOT_API_PATHS and DELIBERATELY_UNSCOPED: an exemption nobody needs any
    // more is an exemption nobody re-examines.
    const live = new Set(declaredRoutes().map(routeKey));
    const stale = Object.keys(HIDDEN_ROUTES).filter((k) => !live.has(k));
    expect(stale, `no longer a route in routes.ts — drop from HIDDEN_ROUTES: ${stale.join(", ")}`).toEqual([]);
  });
});

/**
 * EN-D1 final review, LOW 7: the document must point at the guides.
 *
 * A per-operation reference answers "what does this route take", never "how do
 * I get from a key to a working integration" — and on this API the gap between
 * the two is maker-checker, which no single operation explains. Three guides do
 * explain it, they are executed against a live deployment, and before this they
 * were reachable only by knowing the repository layout.
 *
 * The filenames are asserted to EXIST, not merely to be mentioned. A link is
 * the one kind of documentation that fails silently: renaming a guide leaves
 * the sentence reading perfectly while pointing at nothing.
 */
describe("the document sends readers to the guides", () => {
  const GUIDES = [
    "docs/api/guides/tokenize-an-asset.md",
    "docs/api/guides/issue-a-credential.md",
    "docs/api/guides/receive-webhooks.md",
  ];

  it("names all three, and each one is a file that exists", async () => {
    const app = await buildTestApp();
    await app.ready(); // @fastify/swagger builds the document at ready(); calling swagger() before it throws.
    const doc = app.swagger() as unknown as { info: { description?: string } };
    const description = doc.info.description ?? "";
    for (const guide of GUIDES) {
      expect(description, `info.description never mentions ${guide}`).toContain(guide);
      const onDisk = fileURLToPath(new URL(`../../../${guide}`, import.meta.url));
      expect(existsSync(onDisk), `${guide} is linked from the document but does not exist on disk`).toBe(true);
    }
  });
});
