/**
 * EN-D1: regenerate `apps/api/openapi.snapshot.json`.
 *
 *   pnpm --filter @tokenlayer/api openapi:snapshot
 *
 * Then READ THE DIFF. The snapshot exists so that a change to the public surface
 * shows up in code review; regenerating without looking is the one way to make
 * it worthless.
 *
 * ═══ WHY THIS BUILDS THE *TEST* APP ═══
 *
 * The document must be a pure function of the CODE. Building the production app
 * would make it a function of `.env` and of `prisma/dev.db` as well — the
 * snapshot would then differ between machines, and regenerating it would touch a
 * database, which no documentation task should ever need to do.
 *
 * `buildTestApp()` is the only fully in-memory, deterministic deps factory in
 * this package, and — more importantly — it is the very same one
 * `test/openapi-snapshot.test.ts` builds from. Generator and enforcer therefore
 * read one document, not two documents that happen to look alike. (Route
 * registration in `routes.ts` is unconditional; every `deps`-dependent branch is
 * inside a handler, so the deps choice changes nothing the projection reads.
 * `servers` is the one field it would change, and the projection deliberately
 * excludes it.)
 *
 * The PROJECTION itself is imported from `src/http/openapi-snapshot.ts`, the
 * same module the test imports. There is no second copy to drift.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildTestApp } from "../test/helpers.js";
import {
  type OpenApiDocument,
  projectSurface,
  serializeSurface,
  SNAPSHOT_PATH,
} from "../src/http/openapi-snapshot.js";

const app = await buildTestApp();
// @fastify/swagger builds the document at ready(); calling swagger() before it throws.
await app.ready();
const surface = projectSurface(app.swagger() as unknown as OpenApiDocument);
await app.close();

writeFileSync(SNAPSHOT_PATH, serializeSurface(surface));

const operations = Object.values(surface.paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
const publicOperations = Object.entries(surface.paths).flatMap(([path, ops]) =>
  Object.entries(ops)
    .filter(([, op]) => op.security === null)
    .map(([method]) => `${method.toUpperCase()} ${path}`),
);
console.log(`wrote ${fileURLToPath(SNAPSHOT_PATH)}`);
console.log(`  ${Object.keys(surface.paths).length} paths, ${operations} operations, ${Object.keys(surface.components).length} components`);
// Printed every time, not only when it changes: the count of UNAUTHENTICATED
// operations is the number most worth glancing at before committing.
console.log(`  ${publicOperations.length} operations declare no security (public):`);
for (const op of publicOperations) console.log(`    ${op}`);
console.log("\nNow READ THE DIFF (`git diff apps/api/openapi.snapshot.json`) — every line is a change to the published API.");

process.exit(0);
