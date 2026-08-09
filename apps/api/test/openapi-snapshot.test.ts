import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describeSurfaceDiff,
  type OpenApiDocument,
  projectSurface,
  REGENERATE_COMMAND,
  serializeSurface,
  SNAPSHOT_PATH,
  type Surface,
} from "../src/http/openapi-snapshot.js";
import { buildTestApp } from "./helpers.js";

/**
 * EN-D1: THE PUBLIC SURFACE IS COMMITTED, SO CHANGING IT SHOWS UP IN REVIEW.
 *
 * `apps/api/openapi.snapshot.json` is a projection of the generated OpenAPI
 * document down to the facts a client's code depends on — which credentials each
 * operation accepts, which scope a key needs, which status codes it can answer,
 * whether it takes a body, and what its responses are shaped like. What the
 * projection includes and, just as deliberately, EXCLUDES (all prose, all
 * deployment metadata) is documented at length in
 * `src/http/openapi-snapshot.ts`, which is also where both this test and the
 * regeneration script get it from — ONE function, so the file that is generated
 * and the file that is checked cannot be projections of different things.
 *
 * This test does not forbid change. It forbids SILENT change. The surface is
 * allowed to move whenever the code means it to; what is not allowed is for it
 * to move without a line appearing in a diff that a human reads.
 */
describe("the committed public-surface snapshot", () => {
  it("matches the document this code generates", async () => {
    const app = await buildTestApp();
    await app.ready(); // @fastify/swagger builds the document at ready(); calling swagger() before it throws.
    const generated = projectSurface(app.swagger() as unknown as OpenApiDocument);

    const committedText = readFileSync(SNAPSHOT_PATH, "utf8");
    const committed = JSON.parse(committedText) as Surface;

    if (serializeSurface(generated) === committedText) return; // identical — nothing to explain

    // The comparison above is on bytes; the message below is on meaning. Naming
    // the exact routes and fields is the whole point: a failure that says only
    // "snapshot mismatch" teaches the reader to regenerate reflexively, which
    // turns the snapshot into a rubber stamp and deletes the protection it was
    // added for.
    const diff = describeSurfaceDiff(committed, generated);
    const message = [
      "",
      "THE PUBLIC API SURFACE CHANGED.",
      "",
      ...diff,
      "",
      "Read every line above before you do anything else, and satisfy yourself that each one is a",
      "change you meant to publish. In particular:",
      "  · a `security` that became null is a route that is now PUBLIC — no credential at all;",
      "  · a `security` that lost `apiKeyAuth` locks out every machine integration on that route;",
      "  · a changed `scopes` means keys already minted in the field may stop working;",
      "  · a removed response code or a shrunken response shape breaks clients that read it.",
      "",
      "If all of it is intended, regenerate and COMMIT THE RESULT AS PART OF THIS CHANGE:",
      "",
      `    ${REGENERATE_COMMAND}`,
      "",
      "Then review the resulting `git diff apps/api/openapi.snapshot.json` in your pull request.",
      "Regenerating is not approval — the diff is the artefact reviewers are meant to read, and a",
      "regeneration nobody reads is the only way this file can fail at its job.",
      "",
    ].join("\n");

    expect.fail(message);
  });

  /**
   * A snapshot that has drifted into a shape the projection no longer produces
   * would compare unequal for a reason that has nothing to do with the API. Pin
   * the file's own form so that failure reads as what it is.
   */
  it("is stored in the canonical serialization", () => {
    const committedText = readFileSync(SNAPSHOT_PATH, "utf8");
    const roundTripped = serializeSurface(JSON.parse(committedText) as Surface);
    expect(
      roundTripped,
      `the committed snapshot is not in the canonical form this projection writes — regenerate it with \`${REGENERATE_COMMAND}\``,
    ).toBe(committedText);
  });

  /**
   * The snapshot is only as good as its coverage. If the projection ever stopped
   * seeing most of the document — a renamed field, a shape change in
   * @fastify/swagger — every subsequent comparison would pass vacuously.
   */
  it("covers the whole document, not a fragment of it", async () => {
    const app = await buildTestApp();
    await app.ready(); // @fastify/swagger builds the document at ready(); calling swagger() before it throws.
    const doc = app.swagger() as unknown as OpenApiDocument;
    const surface = projectSurface(doc);

    const operationsInDoc = Object.values(doc.paths ?? {}).reduce(
      (n, ops) => n + Object.keys(ops).filter((m) => m.toLowerCase() !== "head").length,
      0,
    );
    const operationsInSurface = Object.values(surface.paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
    expect(operationsInSurface).toBe(operationsInDoc);
    expect(operationsInSurface).toBeGreaterThan(100);
    // Both credentials, and every shared component, must be represented.
    expect(Object.keys(surface.securitySchemes).sort()).toEqual(["apiKeyAuth", "bearerAuth"]);
    expect(Object.keys(surface.components).length).toBe(Object.keys(doc.components?.schemas ?? {}).length);
  });

  /**
   * The projection's contract, asserted directly rather than inferred from the
   * committed bytes: PROSE IS NOT SURFACE. If a description edit could move the
   * snapshot, reviewers would learn to regenerate on autopilot and the file
   * would stop being read at all — so this is the property the whole mechanism
   * rests on, and it is measured, not assumed.
   */
  it("does not move when only prose changes", async () => {
    const app = await buildTestApp();
    await app.ready(); // @fastify/swagger builds the document at ready(); calling swagger() before it throws.
    const doc = app.swagger() as unknown as OpenApiDocument;
    const before = serializeSurface(projectSurface(doc));

    // Rewrite every human-facing string in the document, leaving the machine
    // facts untouched. The scope sentence is preserved verbatim: the projection
    // reads the required scope out of it (there is nowhere in an OpenAPI `http`
    // security scheme to put a scope), and that is a documented, enforced
    // convention rather than free text.
    const scopeSentence = /`[a-z]+:[a-z]+` scope/g;
    const reword = (s: string | undefined): string =>
      `Rewritten. ${(s ?? "").match(scopeSentence)?.map((m) => `Requires the ${m}.`).join(" ") ?? ""}`;
    for (const ops of Object.values(doc.paths ?? {})) {
      for (const op of Object.values(ops) as Array<Record<string, unknown>>) {
        op.summary = "Rewritten summary";
        op.description = reword(op.description as string | undefined);
        for (const r of Object.values((op.responses ?? {}) as Record<string, { description?: string }>)) {
          r.description = "Rewritten response description";
        }
      }
    }
    for (const scheme of Object.values(doc.components?.securitySchemes ?? {}) as Array<Record<string, unknown>>) {
      scheme.description = "Rewritten scheme description";
    }

    expect(serializeSurface(projectSurface(doc))).toBe(before);
  });
});
