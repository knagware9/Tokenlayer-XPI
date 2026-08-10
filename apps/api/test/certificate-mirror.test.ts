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

/**
 * Strip `//` and block comments before matching quoted strings.
 *
 * Without this the pin can be FOOLED INTO PASSING, which is the only failure
 * mode that matters for a pin: delete a real member and leave a comment where
 * it stood (`// "qr" removed, see ticket X`) and the regex lifts the string out
 * of the comment, the arrays compare equal, and genuine drift reads as green.
 * The same shape as the null-as-allow defects this program keeps finding — a
 * check that answers the wrong question confidently.
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The slice of `source` between `export const NAME = [` and its `] as const;`. */
function constBlock(source: string, constName: string): string {
  const start = source.indexOf(`export const ${constName} = [`);
  expect(start, `${constName} not found in apps/web/src/types.ts`).toBeGreaterThan(-1);
  const end = source.indexOf("] as const;", start);
  expect(end, `${constName} is not a closed \`as const\` array`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function mirroredList(source: string, constName: string): string[] {
  return [...withoutComments(constBlock(source, constName)).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/** The `CERTIFICATE_FIELD_LABELS` record body, comments stripped. */
function labelBlock(source: string): string {
  const start = source.indexOf("export const CERTIFICATE_FIELD_LABELS");
  expect(start, "CERTIFICATE_FIELD_LABELS not found in apps/web/src/types.ts").toBeGreaterThan(-1);
  const end = source.indexOf("};", start);
  expect(end, "CERTIFICATE_FIELD_LABELS is not a closed record").toBeGreaterThan(start);
  return withoutComments(source.slice(start, end));
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
      // Scoped to the record, not the whole file: a `"qr":` appearing anywhere
      // else in types.ts would otherwise satisfy this while the real label was
      // gone. Both quoting styles count — core writes `qr:` bare (a valid
      // identifier) and the mirror quotes it; the LABEL is the contract, not the
      // key's syntax.
      const labels = labelBlock(source);
      expect(
        labels.includes(`"${field}":`) || new RegExp(`(^|[\\s,{])${field.replace(/\./g, "\\.")}\\s*:`).test(labels),
        `no label for '${field}' in CERTIFICATE_FIELD_LABELS`,
      ).toBe(true);
    }
  });
});
