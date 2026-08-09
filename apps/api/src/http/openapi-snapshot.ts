/**
 * EN-D1: THE PUBLIC SURFACE, PROJECTED SO A HUMAN CAN SEE IT CHANGE.
 *
 * Nothing in this file prevents a change. It makes one APPEAR — as a diff, in a
 * pull request, next to the code that caused it. That is the only mechanism in
 * this repository that reliably gets a person to notice that a route quietly
 * became public, that a scope moved, or that a documented field stopped being
 * documented. It is the documentation equivalent of the audit chain: cheap,
 * append-only in spirit, and useless if nobody reads it.
 *
 * ═══ WHAT IS PROJECTED, AND WHY EXACTLY THAT ═══
 *
 * The single design constraint is: **a prose edit must produce NO diff.** A
 * snapshot that churns when someone improves a `description` trains reviewers to
 * regenerate without looking, and a snapshot nobody looks at protects nothing.
 * So every field below is a fact a client's CODE depends on, and no field is
 * text a human wrote for another human.
 *
 * INCLUDED, per path and method:
 *   - `tags`         — which group the operation belongs to. Moving an operation
 *                      between groups reorganizes the published reference.
 *   - `security`     — WHICH CREDENTIALS ARE ACCEPTED. `null` means the operation
 *                      declares none: it is PUBLIC. A route going from
 *                      `[bearerAuth]` to `null` is the single most consequential
 *                      one-line change anyone can make here, and it is invisible
 *                      in a normal diff of routes.ts.
 *   - `scopes`       — the API-key scope(s) the operation requires. See the note
 *                      on extraction below; this is "a scope moved", made visible.
 *   - `parameters`   — `"<in>:<name>"`, `!`-suffixed when required. Names and
 *                      locations only: a removed query parameter breaks callers,
 *                      a reworded parameter description does not.
 *   - `requestBody`  — whether the operation takes a body at all.
 *   - `responses`    — status code → a compact SHAPE TOKEN (below). The set of
 *                      codes is the contract a client's error handling is
 *                      written against; the token additionally reveals a
 *                      top-level response field that vanished.
 *
 * Also included, once per document: the `openapi` version, and each security
 * SCHEME's `type`/`scheme`/`bearerFormat` (not its description). That last field
 * is deliberate: `apiKeyAuth` carrying a `bearerFormat` again is precisely the
 * defect D1-1 corrected — API keys are opaque, not JWTs — and it would otherwise
 * be a one-word regression with no test attached. Plus every named component's
 * top-level property list, because responses `$ref` components, so a field
 * disappearing from a component disappears from every response that shares it.
 *
 * DELIBERATELY EXCLUDED:
 *   - `summary` and `description` everywhere, at every level. Prose. Editing it
 *     is the thing we most want to stay cheap.
 *   - `info` (title, version, description) and `servers`. Release and deployment
 *     metadata, not surface: `servers` is a function of the environment the
 *     document was generated in, so pinning it would make the snapshot fail on a
 *     correctly-configured deployment.
 *   - The document-level `tags` array. Its NAMES are already visible through the
 *     per-operation `tags`, and its bodies are pure prose. Its completeness is
 *     separately enforced by `openapi-contract.test.ts`.
 *   - Nested response structure below the first level, and every validation
 *     keyword (`type`, `format`, `minimum`, `enum`, `default`, `required`).
 *     Response NARROWING already has a precise, purpose-built detector — the
 *     additivity walk in `openapi-contract.test.ts` — and duplicating it here
 *     would double the noise without adding a check.
 *
 * ═══ WHAT THIS SNAPSHOT DOES NOT PROMISE ═══
 *
 * It is not an approval and not a compatibility guarantee. A diff here says
 * "the published surface moved"; it does not say whether that was correct. It
 * also cannot see anything the document never described: a runtime-only gate, a
 * response field the schema does not declare (fast-json-stringify strips those
 * anyway), or an undocumented header. Read it as an alarm, not as a spec.
 *
 * ═══ ONE PROJECTION, TWO CALLERS ═══
 *
 * `scripts/write-openapi-snapshot.ts` (regeneration) and
 * `test/openapi-snapshot.test.ts` (enforcement) both import `projectSurface`
 * from HERE and neither has a projection of its own. A second copy could drift
 * from the first, and the drift would be undetectable by construction — the
 * generated file would match the generator and the test would pass while both
 * described something the document does not. That is the exact class of bug this
 * branch spent the day closing (D1-2 found EN-B's scope-map regex silently
 * mis-parsing; D1-3 found a coarse floor test that had gone inert), so the
 * projection is a module, not a convention.
 *
 * It lives in `src/` rather than `test/` for a second reason: this package
 * typechecks `src` only (`"include": ["src"]`), so a projection written in the
 * test directory would be unverified TypeScript.
 */
import { API_SCOPES } from "@tokenlayer/core";

/** The generated document, typed only as far as this file reads it. */
export interface OpenApiDocument {
  openapi?: string;
  components?: {
    securitySchemes?: Record<string, { type?: string; scheme?: string; bearerFormat?: string }>;
    schemas?: Record<string, SchemaNode>;
  };
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

interface OpenApiOperation {
  tags?: string[];
  description?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
  requestBody?: unknown;
  responses?: Record<string, { content?: Record<string, { schema?: SchemaNode }> }>;
}

type SchemaNode = {
  $ref?: string;
  title?: string;
  type?: string | string[];
  properties?: Record<string, unknown>;
  items?: SchemaNode;
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  allOf?: SchemaNode[];
};

export interface OperationSurface {
  tags: string[];
  /** Sorted alternatives, each a sorted list of scheme names. `null` = the operation declares no security: PUBLIC. */
  security: string[][] | null;
  /** The API-key scopes this operation requires, or `null` when it is not key-callable. */
  scopes: string[] | null;
  /** `"<in>:<name>"`, with a trailing `!` when required. */
  parameters: string[];
  requestBody: boolean;
  /** status code → shape token. */
  responses: Record<string, string>;
}

export interface Surface {
  openapi: string;
  securitySchemes: Record<string, { type: string; scheme: string; bearerFormat: string | null }>;
  /** component title → its sorted top-level property names. */
  components: Record<string, string[]>;
  /** path → method (lowercase) → operation surface. */
  paths: Record<string, Record<string, OperationSurface>>;
}

/** How a reader regenerates the committed file. Quoted verbatim by the test's failure message. */
export const REGENERATE_COMMAND = "pnpm --filter @tokenlayer/api openapi:snapshot";

/**
 * The committed file, resolved from THIS module so the test and the script
 * cannot disagree about which file is the snapshot.
 */
export const SNAPSHOT_PATH = new URL("../../openapi.snapshot.json", import.meta.url);

/**
 * The scope an operation requires, read out of its description.
 *
 * The scope is a real part of the surface — "a key needs `assets:read` here" is
 * something an integrator's key-minting code depends on — but the published
 * document carries it only in prose, because `security` for an HTTP bearer
 * scheme has nowhere to put it. (OAuth2 scopes have a home in `security`;
 * `type: http` schemes do not.)
 *
 * So it is EXTRACTED, by a deliberately strict pattern, from the sentence every
 * key-callable route is already required to carry — `openapi-contract.test.ts`
 * fails the build if a scoped route's description does not name its scope. The
 * strictness is the point: a loose scan would pick up a scope mentioned in
 * passing ("unlike `assets:write`…") and churn the snapshot on a prose edit.
 *
 * If the phrasing convention is ever abandoned, this THROWS rather than
 * silently recording `null` — a silent null would be a churn diff that looks
 * like a scope was removed, which is exactly the false alarm that teaches
 * reviewers to stop reading.
 */
const SCOPE_RE = /`([a-z]+:[a-z]+)` scope/g;
const KNOWN_SCOPES = new Set<string>(API_SCOPES as readonly string[]);

function scopesOf(op: OpenApiOperation, where: string): string[] | null {
  const keyCallable = (op.security ?? []).some((alt) => "apiKeyAuth" in alt);
  if (!keyCallable) return null;
  const found = new Set<string>();
  for (const m of (op.description ?? "").matchAll(SCOPE_RE)) {
    const scope = m[1]!;
    if (!KNOWN_SCOPES.has(scope)) {
      throw new Error(
        `${where} names an unknown scope \`${scope}\` in its description — ` +
          `it is not in API_SCOPES. Fix the description, or add the scope to packages/core/src/api-scopes.ts.`,
      );
    }
    found.add(scope);
  }
  if (found.size === 0) {
    throw new Error(
      `${where} accepts an API key but its description names no scope in the form \`` +
        "`resource:action` scope" +
        `\`. The snapshot reads the required scope out of that phrase; keep it, or the ` +
        `snapshot cannot record which scope this route needs.`,
    );
  }
  return [...found].sort();
}

/** Component title → the `#/components/schemas/def-N` key it was generated under. */
function titleByRef(doc: OpenApiDocument): Map<string, string> {
  const byRef = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const [key, schema] of Object.entries(doc.components?.schemas ?? {})) {
    const title = schema.title;
    // `@fastify/swagger` names shared components POSITIONALLY — `def-0`,
    // `def-1`, … — so the generated name of a component shifts whenever another
    // is added ahead of it. Recording raw `$ref`s would therefore rewrite half
    // the snapshot on an unrelated insertion, which is churn of the worst kind:
    // enormous, and entirely meaningless. The `title` (the `$id` from
    // schemas.ts) is the stable identity, so the projection uses it and refuses
    // to proceed without one.
    if (!title) {
      throw new Error(
        `component "${key}" has no \`title\`, so the snapshot cannot name it stably — ` +
          `@fastify/swagger's own name for it is positional and shifts when any other component is added. ` +
          `Give the schema an \`$id\` in src/http/schemas.ts.`,
      );
    }
    const prior = seen.get(title);
    if (prior) {
      throw new Error(`components "${prior}" and "${key}" share the title "${title}" — component titles must be unique.`);
    }
    seen.set(title, key);
    byRef.set(`#/components/schemas/${key}`, title);
  }
  return byRef;
}

/**
 * A compact, prose-free token for a response body.
 *
 *   `#Asset`            a reference to the named component
 *   `{a,b,c}`           an inline object, top-level field names only
 *   `{}`                an object that declares no fields (an open bag)
 *   `[#Event]`          an array of that shape
 *   `oneOf(x|y)`        alternatives, in declaration order
 *   `none`              a response with no JSON body (a 204)
 *   `string` / `null`   a scalar
 */
function shapeToken(node: SchemaNode | undefined, refs: Map<string, string>): string {
  if (!node) return "none";
  if (node.$ref) return `#${refs.get(node.$ref) ?? node.$ref}`;
  if (node.oneOf) return `oneOf(${node.oneOf.map((alt) => shapeToken(alt, refs)).join("|")})`;
  if (node.anyOf) return `anyOf(${node.anyOf.map((alt) => shapeToken(alt, refs)).join("|")})`;
  if (node.allOf) return `allOf(${node.allOf.map((alt) => shapeToken(alt, refs)).join("+")})`;
  if (node.type === "array") return `[${shapeToken(node.items, refs)}]`;
  if (node.properties) return `{${Object.keys(node.properties).sort().join(",")}}`;
  if (node.type === "object") return "{}";
  return typeof node.type === "string" ? node.type : JSON.stringify(node.type ?? null);
}

/** The projection. Pure: same document in, same surface out, byte for byte. */
export function projectSurface(doc: OpenApiDocument): Surface {
  const refs = titleByRef(doc);

  const securitySchemes: Surface["securitySchemes"] = {};
  for (const name of Object.keys(doc.components?.securitySchemes ?? {}).sort()) {
    const s = doc.components!.securitySchemes![name]!;
    securitySchemes[name] = { type: s.type ?? "", scheme: s.scheme ?? "", bearerFormat: s.bearerFormat ?? null };
  }

  const components: Surface["components"] = {};
  for (const [, schema] of Object.entries(doc.components?.schemas ?? {})) {
    components[schema.title!] = Object.keys(schema.properties ?? {}).sort();
  }
  const sortedComponents: Surface["components"] = {};
  for (const title of Object.keys(components).sort()) sortedComponents[title] = components[title]!;

  const paths: Surface["paths"] = {};
  for (const path of Object.keys(doc.paths ?? {}).sort()) {
    const item = doc.paths![path]!;
    const ops: Record<string, OperationSurface> = {};
    for (const method of Object.keys(item).sort()) {
      // HEAD is synthesised by Fastify from a GET route; it is not a declared
      // operation and would only add a duplicate of every GET to the file.
      if (method.toLowerCase() === "head") continue;
      const op = item[method]!;
      const where = `${method.toUpperCase()} ${path}`;

      const responses: Record<string, string> = {};
      for (const code of Object.keys(op.responses ?? {}).sort()) {
        responses[code] = shapeToken(op.responses![code]!.content?.["application/json"]?.schema, refs);
      }

      ops[method.toLowerCase()] = {
        tags: [...(op.tags ?? [])].sort(),
        // Sorted so a cosmetic reordering of the alternatives in schemas.ts does
        // not read as a change; adding or removing one still does.
        security: op.security
          ? op.security.map((alt) => Object.keys(alt).sort()).sort((a, b) => a.join().localeCompare(b.join()))
          : null,
        scopes: scopesOf(op, where),
        parameters: (op.parameters ?? [])
          .map((p) => `${p.in ?? "?"}:${p.name ?? "?"}${p.required ? "!" : ""}`)
          .sort(),
        requestBody: op.requestBody !== undefined,
        responses,
      };
    }
    paths[path] = ops;
  }

  return { openapi: doc.openapi ?? "", securitySchemes, components: sortedComponents, paths };
}

/** The bytes that go in the file. One serializer, so the test compares like with like. */
export function serializeSurface(surface: Surface): string {
  return `${JSON.stringify(surface, null, 2)}\n`;
}

/**
 * Every leaf of a surface, keyed by a path a human can act on
 * (`GET /api/v1/assets » security`). Used only to explain a mismatch; the
 * comparison itself is on the serialized bytes.
 */
function flatten(surface: Surface): Map<string, string> {
  const out = new Map<string, string>();
  out.set("document » openapi", JSON.stringify(surface.openapi));
  for (const [name, scheme] of Object.entries(surface.securitySchemes)) {
    out.set(`securityScheme ${name}`, JSON.stringify(scheme));
  }
  for (const [title, props] of Object.entries(surface.components)) {
    out.set(`component ${title} » properties`, JSON.stringify(props));
  }
  for (const [path, ops] of Object.entries(surface.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const route = `${method.toUpperCase()} ${path}`;
      for (const [field, value] of Object.entries(op)) out.set(`${route} » ${field}`, JSON.stringify(value));
    }
  }
  return out;
}

/**
 * A human-readable account of how the generated surface differs from the
 * committed one, worst first: routes that appeared or disappeared, then fields
 * that changed. Each line names the route, so the reader can go and look at it.
 */
export function describeSurfaceDiff(committed: Surface, generated: Surface, maxLines = 60): string[] {
  const before = flatten(committed);
  const after = flatten(generated);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, value] of after) {
    if (!before.has(key)) added.push(`  + ADDED    ${key} = ${value}`);
    else if (before.get(key) !== value) changed.push(`  ~ CHANGED  ${key}\n              committed: ${before.get(key)}\n              generated: ${value}`);
  }
  for (const key of before.keys()) if (!after.has(key)) removed.push(`  - REMOVED  ${key} = ${before.get(key)}`);
  const lines = [...removed.sort(), ...changed.sort(), ...added.sort()];
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `  … and ${lines.length - maxLines} more`] : lines;
}
