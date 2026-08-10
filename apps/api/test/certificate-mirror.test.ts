import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CERTIFICATE_FIXED_FIELDS } from "@tokenlayer/core";

/**
 * THE WEB APP HAS NO DEPENDENCY ON CORE, so every shared vocabulary is copied
 * into `apps/web/src/types.ts` by hand — `API_SCOPES`, `EVENT_TYPES`, and now
 * the certificate field catalog.
 *
 * That mirror has silently drifted twice. Most recently `webhooks:read` and
 * `webhooks:write` were added to core by EN-C and never mirrored, so the console
 * could not mint a key for the Webhooks section on its own screen — and when
 * they were finally added they shipped as blank checkboxes, because
 * `npm run build` is `vite build` and esbuild strips types without checking them.
 *
 * This test lives in the API suite for the only reason that matters: this
 * package can import core AND read the web file. The web package can do neither.
 */
// fileURLToPath (not `.pathname`) — `.pathname` returns the raw percent-encoded
// URL path, so a repo checked out under a directory containing a space (or any
// other reserved character) would ENOENT here instead of reading the file. This
// matches every other cross-file path in this suite (route-decls.ts,
// openapi-contract.test.ts, openapi-visibility.test.ts).
const WEB_TYPES = fileURLToPath(new URL("../../web/src/types.ts", import.meta.url));

function mirroredList(source: string, constName: string): string[] {
  const start = source.indexOf(`export const ${constName} = [`);
  expect(start, `${constName} not found in apps/web/src/types.ts`).toBeGreaterThan(-1);
  const end = source.indexOf("] as const;", start);
  expect(end, `${constName} is not a closed \`as const\` array`).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the web mirror of the certificate field catalog", () => {
  const source = readFileSync(WEB_TYPES, "utf8");

  it("lists exactly the fields core defines, in the same order", () => {
    expect(mirroredList(source, "CERTIFICATE_FIXED_FIELDS")).toEqual([...CERTIFICATE_FIXED_FIELDS]);
  });

  it("gives every one of them a label, so none can ship as a blank chip", () => {
    // The web declares `Record<CertificateFixedField, string>`, which only a
    // TYPECHECK enforces — and the web build does not typecheck. Assert it here,
    // where it runs on every api test run.
    for (const field of CERTIFICATE_FIXED_FIELDS) {
      expect(source, `no label for '${field}'`).toContain(`"${field}":`);
    }
  });
});
