/**
 * EN-D1 (task D1-6): reading the OpenAPI document, with no React in sight.
 *
 * The developer portal's Reference tab is mostly presentation, but three
 * questions underneath it are logic, and each has a wrong answer that would be
 * invisible in a screenshot:
 *
 *  1. Which routes may be executed from a documentation page at all.
 *  2. Which credential may call a route, and — the question integrators
 *     actually arrive with — with WHICH SCOPE.
 *  3. How the routes are grouped, and whether any of them can go missing.
 *
 * Those three live here, as pure functions over the document, so they can be
 * asserted without a DOM (apps/web has no jsdom environment) and so a component
 * edit cannot quietly change what the portal claims about authentication.
 *
 * The types below are deliberately STRUCTURAL and partial. This module reads a
 * document produced by @fastify/swagger from the route schemas in
 * `apps/api/src/http/schemas.ts`; modelling all of OpenAPI 3 would be a large
 * lie about how much of it we depend on, and would break on the next field the
 * generator decides to add.
 */

/** A `{ schemeName: scopes[] }` alternative in an operation's `security` array. */
export type SecurityRequirement = Record<string, readonly string[]>;

export interface OpenApiSchema {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: readonly unknown[];
  nullable?: boolean;
  description?: string;
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | OpenApiSchema;
  anyOf?: readonly OpenApiSchema[];
  oneOf?: readonly OpenApiSchema[];
  allOf?: readonly OpenApiSchema[];
}

export interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}

export interface OpenApiMediaType { schema?: OpenApiSchema }
export interface OpenApiBody { required?: boolean; description?: string; content?: Record<string, OpenApiMediaType> }
export interface OpenApiResponse { description?: string; content?: Record<string, OpenApiMediaType> }

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: readonly string[];
  /**
   * ABSENT and EMPTY both mean public here, and they are not the same thing in
   * OpenAPI: absent inherits the document-level default, empty overrides it to
   * "none". This document declares no top-level `security`, so the two coincide
   * — and treating them alike is what stops a public route from being labelled
   * as needing a credential it does not need.
   */
  security?: readonly SecurityRequirement[];
  parameters?: readonly OpenApiParameter[];
  requestBody?: OpenApiBody;
  responses?: Record<string, OpenApiResponse>;
}

export type OpenApiPathItem = Record<string, unknown>;
export type OpenApiPaths = Record<string, OpenApiPathItem>;

export interface OpenApiTag { name: string; description?: string }

export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: readonly { url?: string; description?: string }[];
  tags?: readonly OpenApiTag[];
  paths?: OpenApiPaths;
  components?: { schemas?: Record<string, OpenApiSchema>; securitySchemes?: Record<string, unknown> };
}

/** The method keys a path item may carry. Anything else on a path item
 * (`parameters`, `summary`, `$ref`, vendor extensions) is NOT an operation and
 * must not be rendered as one. */
export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

function isHttpMethod(key: string): key is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(key);
}

/* ────────────────────────────── try-it eligibility ─────────────────────── */

/**
 * Is this METHOD eligible to be executed from the documentation page?
 *
 * GET ONLY, and the restriction is a product decision rather than a technical
 * one. A docs page that can POST is a docs page that can mint a credential,
 * onboard a user or move tokens against live production data with the reader's
 * own session — and on this API most of those return `202` into a real
 * maker-checker queue, so the "try" would leave a proposal behind for a human
 * to deal with. Everything else gets a copyable curl the integrator runs
 * deliberately, from their own shell, against a deployment they chose.
 *
 * THIS IS HALF THE ANSWER, and it used to be presented as the whole one. The
 * comment here previously said "reads have no such tail", which is false on
 * this API: `GET /verification-requests/{id}/verify` is a read-shaped route
 * that performs a one-way status transition, appends to a hash-chained audit
 * log and fans a `verification.completed` event out to every webhook endpoint
 * the organization has registered. A claim like that, with nothing enforcing
 * it, is exactly what this branch has been removing. Callers must use
 * `tryItAllowed`, which takes the whole route and so cannot forget the path.
 *
 * Case-insensitive because a document, a route table and a UI each spell the
 * method differently and none of them should be able to change the answer.
 */
export function canTryIt(method: string): boolean {
  return method.trim().toLowerCase() === "get";
}

/**
 * GET routes that MUTATE, keyed by normalised path, valued by what they do.
 *
 * A route lands here when its handler reaches a write primitive — an event
 * emission, an audit append, a repository setter. It is not a style list: every
 * entry is a side effect a reader would cause by pressing a button on a page
 * that promises it will not act.
 *
 * DO NOT EMPTY THIS. `apps/web/test/try-it-safety.test.ts` derives the same
 * answer from `apps/api/src/http/routes.ts` — it reads the GET handlers and
 * finds the ones that call a write primitive — and fails if any of them is
 * missing here. Deleting an entry does not make the route safe; it makes the
 * test red.
 */
export const MUTATING_GET_PATHS: Record<string, string> = {
  "/verification-requests/{}/verify":
    "consumes the verification request: a one-way transition to a verified result, an entry in the append-only " +
    "audit chain, and a `verification.completed` event delivered to every webhook endpoint the organization has " +
    "registered. Pressing a button on a documentation page must not notify third parties.",
};

/**
 * `/api/v1/orgs/:id/x` and `/orgs/{orgId}/x` both normalise to `/orgs/{}/x`.
 *
 * The portal reads DOCUMENT paths (`/api/v1/…/{id}/…`); the test that derives
 * the denylist reads DECLARATION paths (`/…/:id/…`). Both have to key the same
 * table, so neither spelling is privileged.
 */
export function normalizeRoutePath(raw: string): string {
  const noPrefix = raw.replace(/^\/api\/v\d+(?=\/|$)/, "");
  const params = noPrefix.replace(/\{[^}]*\}/g, "{}").replace(/(?<=\/):[A-Za-z0-9_]+/g, "{}");
  return params.replace(/\/+$/, "") || "/";
}

/** Why this GET is refused a try-it button, or null when it is not refused. */
export function mutatingGetReason(path: string): string | null {
  return MUTATING_GET_PATHS[normalizeRoutePath(path)] ?? null;
}

/**
 * May this OPERATION be executed from the documentation page?
 *
 * The one function the UI may call. It takes the whole route rather than a
 * method string precisely so the path cannot be left out by accident: the
 * method alone is not enough to answer this, and a signature that accepted only
 * the method is how the answer was wrong before.
 */
export function tryItAllowed(route: { method: string; path: string }): boolean {
  return canTryIt(route.method) && mutatingGetReason(route.path) === null;
}

/* ─────────────────────────── credentials and scopes ────────────────────── */

/** The scheme names this API declares. Mirrors `securitySchemes` in
 * `apps/api/src/http/openapi.ts`; both arrive in `Authorization: Bearer …` and
 * are told apart by the token's shape. */
export const BEARER_SCHEME = "bearerAuth";
export const API_KEY_SCHEME = "apiKeyAuth";

/** Every scheme named anywhere in an operation's `security` alternatives. */
export function securitySchemesOf(op: OpenApiOperation): string[] {
  const names: string[] = [];
  for (const requirement of op.security ?? []) {
    for (const name of Object.keys(requirement ?? {})) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * The scope a key-callable route needs, read out of its prose.
 *
 * The scope is NOT in the document's `security` array: every requirement there
 * carries an empty scope list, because these are bearer schemes rather than
 * OAuth2 flows and OpenAPI only gives scopes meaning for the latter. What task
 * D1-2 guaranteed instead is that every key-callable route STATES its scope in
 * its description ("Requires the `assets:read` scope."), enforced by a contract
 * test in apps/api. All 73 key-callable operations satisfy the primary pattern
 * today.
 *
 * The fallback exists anyway. If someone rewords a description, the primary
 * pattern misses, and the honest outcome is "an API key with the required
 * scope" (see `credentialLine`) rather than a sentence with a hole in it — a
 * reference that renders a broken claim is worse than one that admits it does
 * not know.
 */
export function extractScope(description: string | undefined): string | null {
  if (!description) return null;
  const stated = /requires the `([^`]+)` scope/i.exec(description);
  if (stated?.[1]) return stated[1].trim();
  // Any scope-shaped backticked token, for a reworded sentence.
  const shaped = /`([a-z][a-z0-9-]*:[a-z0-9-]+)`/.exec(description);
  return shaped?.[1] ?? null;
}

/** Which credential a route accepts, as structure — so the UI can style the
 * scope and the sentence can be asserted independently of the styling. */
export interface CredentialInfo {
  /** `both` = key or session; `session` = human only; `key` = key only; `public` = neither. */
  kind: "both" | "session" | "key" | "public";
  /** The scope named in the description, when the route is key-callable. */
  scope: string | null;
}

export function credentialInfo(op: OpenApiOperation): CredentialInfo {
  const schemes = securitySchemesOf(op);
  const key = schemes.includes(API_KEY_SCHEME);
  const session = schemes.includes(BEARER_SCHEME);
  if (!key && !session) return { kind: "public", scope: null };
  if (key && session) return { kind: "both", scope: extractScope(op.description) };
  if (key) return { kind: "key", scope: extractScope(op.description) };
  return { kind: "session", scope: null };
}

/**
 * One sentence naming which credential may call this route, and with what.
 *
 * This is the single most useful thing the portal knows about a route, and the
 * one the pre-EN-D1 document got wrong for all 121 of them: it declared
 * `bearerAuth` everywhere, which told every machine integrator that machine
 * access did not exist while the server was serving it happily. So the sentence
 * must distinguish the three real cases, and — for the key-callable case — must
 * name the SCOPE, because "you can use a key" without "which scope" only moves
 * the integrator's question one call further down the road, to a
 * `403 INSUFFICIENT_SCOPE` they cannot act on.
 */
export function credentialLine(op: OpenApiOperation): string {
  const { kind, scope } = credentialInfo(op);
  // "the required scope" is the deliberate degraded form: it is true, and it
  // does not fabricate a scope name we could not find.
  const holding = scope ? `holding the ${scope} scope` : "with the required scope";
  switch (kind) {
    case "both":
      return `Callable with an organization API key ${holding}, or with a signed-in user session.`;
    case "key":
      return `Callable with an organization API key ${holding}. A user session cannot call this route.`;
    case "session":
      return "Callable with a signed-in user session only — an organization API key is refused here.";
    case "public":
      return "Public — no credential required.";
  }
}

/* ──────────────────────────────── grouping ─────────────────────────────── */

export interface RouteEntry {
  path: string;
  method: HttpMethod;
  op: OpenApiOperation;
}

export interface TagGroup {
  name: string;
  description?: string;
  routes: RouteEntry[];
}

/**
 * Where an operation with no tag goes. It goes SOMEWHERE — that is the whole
 * point of the constant existing.
 */
export const UNTAGGED_GROUP = "Other";

/**
 * Group every operation by its first tag, in the document's declared tag order.
 *
 * TWO invariants, both learned the hard way elsewhere on this branch:
 *
 *  - NOTHING IS DROPPED. An operation with no tags, an empty tag array or a
 *    blank tag lands under "Other". A reference that silently omits a route is
 *    worse than one that renders it awkwardly: the reader has no way to know
 *    the gap exists, and "it is not in the docs" is how a real route becomes an
 *    unsupported one. (The document is clean today — all 121 operations carry a
 *    tag — which is exactly when this stops being tested by reality.)
 *
 *  - THE DOCUMENT'S ORDER WINS. `apps/api/src/http/openapi.ts` orders its 23
 *    tags on purpose: the machine integration surface first, then
 *    administration, then reference data. Sorting alphabetically here would
 *    throw that editorial judgement away and open the reference on "Analytics".
 *
 * Tags used by a route but not declared are appended in first-encounter order
 * rather than discarded — same reason as "Other". "Other" itself sorts last
 * unless the document declares it, in which case its declared position wins.
 */
export function groupByTag(paths: OpenApiPaths | undefined, declaredTags: readonly OpenApiTag[] = []): TagGroup[] {
  const byName = new Map<string, RouteEntry[]>();
  const encounterOrder: string[] = [];

  const bucket = (name: string): RouteEntry[] => {
    let rows = byName.get(name);
    if (!rows) {
      rows = [];
      byName.set(name, rows);
      encounterOrder.push(name);
    }
    return rows;
  };

  for (const [path, item] of Object.entries(paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const [key, value] of Object.entries(item)) {
      if (!isHttpMethod(key)) continue;
      if (!value || typeof value !== "object") continue;
      const op = value as OpenApiOperation;
      const tag = op.tags?.find((t) => typeof t === "string" && t.trim() !== "")?.trim() ?? UNTAGGED_GROUP;
      bucket(tag).push({ path, method: key, op });
    }
  }

  const declaredOrder = declaredTags.map((t) => t.name);
  const describedBy = new Map(declaredTags.map((t) => [t.name, t.description] as const));

  const ordered: string[] = [];
  for (const name of declaredOrder) if (byName.has(name) && !ordered.includes(name)) ordered.push(name);
  for (const name of encounterOrder) if (!ordered.includes(name) && name !== UNTAGGED_GROUP) ordered.push(name);
  if (byName.has(UNTAGGED_GROUP) && !ordered.includes(UNTAGGED_GROUP)) ordered.push(UNTAGGED_GROUP);

  return ordered.map((name) => ({
    name,
    description: describedBy.get(name),
    routes: byName.get(name) ?? [],
  }));
}

/* ─────────────────────────────── URLs ──────────────────────────────────── */

/**
 * Where the OpenAPI document lives, derived from the API base the app already
 * uses.
 *
 * The docs plugin is registered at the app's ROOT, not under `/api/v1` — see
 * `apps/api/src/app.ts` — so the document is a sibling of the versioned API,
 * not a child of it. Deriving it from `API_BASE` keeps the portal pointed at
 * the same deployment every other call goes to, including the same-origin dev
 * mode where `API_BASE` is the bare string "/api/v1".
 */
export function openapiUrl(apiBase: string): string {
  return `${apiOrigin(apiBase)}/openapi.json`;
}

/** The API's origin: `API_BASE` with its version suffix removed. "" in
 * same-origin dev mode, which is a valid prefix for a root-relative fetch. */
export function apiOrigin(apiBase: string): string {
  return apiBase.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

/**
 * Substitute `{param}` placeholders in a documented path with the values the
 * reader typed. A blank or missing value is LEFT AS THE PLACEHOLDER rather
 * than replaced with an empty segment: `/assets//holders` is a different route
 * (usually a 404), and a 404 the reader cannot explain teaches nothing. The
 * caller checks `missing` and refuses to send.
 */
export function fillPath(path: string, values: Record<string, string>): { url: string; missing: string[] } {
  const missing: string[] = [];
  const url = path.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const value = values[name]?.trim();
    if (!value) { missing.push(name); return whole; }
    return encodeURIComponent(value);
  });
  return { url, missing };
}

/** Append the non-empty query values as a query string. */
export function withQuery(url: string, values: Record<string, string>): string {
  const pairs = Object.entries(values).filter(([, v]) => v.trim() !== "");
  if (pairs.length === 0) return url;
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v.trim())}`).join("&");
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}

/* ───────────────────────────── schema shapes ───────────────────────────── */

/**
 * Follow a `$ref` into `components.schemas`.
 *
 * WORTH KNOWING WHEN READING THE REFERENCE: this document's components are
 * named `def-0` … `def-28`. @fastify/swagger generates those names from
 * anonymous inline schemas, so a `$ref` here carries no information at all —
 * rendering "def-0" to an integrator would be strictly worse than rendering
 * nothing. Every display path therefore resolves refs into their actual shape
 * before showing anything.
 */
export function resolveRef(schema: OpenApiSchema | undefined, doc: OpenApiDocument, seen: readonly string[] = []): OpenApiSchema | undefined {
  if (!schema?.$ref) return schema;
  const name = schema.$ref.replace("#/components/schemas/", "");
  if (seen.includes(name)) return undefined; // recursive schema — stop rather than hang.
  const target = doc.components?.schemas?.[name];
  return target ? resolveRef(target, doc, [...seen, name]) : undefined;
}

/**
 * A one-line shape for a schema: `{id, name, scopes[]}`, `[{…}]`, `string`.
 *
 * Compact on purpose. The reference shows shapes so a reader can tell an array
 * from an object and find a field name; a full JSON Schema dump is what the
 * document itself is for, and pasting one into a table makes the page
 * unreadable at exactly the moment it needs to be scannable.
 */
export function describeShape(schema: OpenApiSchema | undefined, doc: OpenApiDocument, depth = 0): string {
  const resolved = resolveRef(schema, doc);
  if (!resolved) return "—";
  if (depth > 2) return "…";

  const variants = resolved.anyOf ?? resolved.oneOf ?? resolved.allOf;
  if (variants && variants.length > 0) {
    return variants.map((v) => describeShape(v, doc, depth + 1)).join(" | ");
  }
  if (resolved.enum && resolved.enum.length > 0) {
    return resolved.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  if (resolved.type === "array") return `[${describeShape(resolved.items, doc, depth + 1)}]`;

  const props = resolved.properties;
  if (props && Object.keys(props).length > 0) {
    const names = Object.keys(props);
    const shown = names.slice(0, 12);
    const body = shown.map((n) => {
      const child = resolveRef(props[n], doc);
      return child?.type === "array" ? `${n}[]` : n;
    }).join(", ");
    return `{${body}${names.length > shown.length ? `, …+${names.length - shown.length}` : ""}}`;
  }
  if (resolved.type === "object") return "{…}";
  return resolved.type ?? "—";
}

/** The media type this portal renders. Everything else (the PDF certificate
 * route, notably) is named rather than shaped. */
const JSON_MEDIA = "application/json";

export function bodySchema(body: OpenApiBody | undefined): OpenApiSchema | undefined {
  return body?.content?.[JSON_MEDIA]?.schema;
}

/** The content types a response can return, so a non-JSON one (`application/pdf`)
 * is stated rather than silently rendered as "—". */
export function responseMediaTypes(response: OpenApiResponse | undefined): string[] {
  return Object.keys(response?.content ?? {});
}

/* ──────────────────────────────── curl ─────────────────────────────────── */

/** A placeholder value for a request-body field, keyed off its declared type. */
function placeholder(schema: OpenApiSchema | undefined, doc: OpenApiDocument): unknown {
  const resolved = resolveRef(schema, doc);
  if (!resolved) return "…";
  if (resolved.enum && resolved.enum.length > 0) return resolved.enum[0];
  switch (resolved.type) {
    case "integer":
    case "number": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    default: return "…";
  }
}

/**
 * A copyable `curl` for one operation — the affordance every non-GET route gets
 * instead of a "Try it" button.
 *
 * Uses the credential the route actually accepts: an API key when the document
 * says a key may call it, a session token otherwise. Getting that backwards
 * would hand an integrator a snippet that 403s and no clue why.
 */
export function curlFor(entry: RouteEntry, baseUrl: string, doc: OpenApiDocument): string {
  const { method, path, op } = entry;
  const { kind } = credentialInfo(op);
  const credential = kind === "session" ? "$TL_SESSION" : kind === "public" ? null : "$TL_API_KEY";
  const lines: string[] = [`curl -sS -X ${method.toUpperCase()} '${baseUrl}${path}'`];
  if (credential) lines.push(`  -H "authorization: Bearer ${credential}"`);

  const schema = resolveRef(bodySchema(op.requestBody), doc);
  if (schema) {
    lines.push(`  -H 'content-type: application/json'`);
    const props = schema.properties ?? {};
    const required = schema.required ?? [];
    const names = Object.keys(props);
    const chosen = required.length > 0 ? required.filter((n) => names.includes(n)) : names.slice(0, 4);
    const body: Record<string, unknown> = {};
    for (const name of chosen) body[name] = placeholder(props[name], doc);
    lines.push(`  -d '${JSON.stringify(names.length > 0 ? body : {})}'`);
  }
  return lines.join(" \\\n");
}
