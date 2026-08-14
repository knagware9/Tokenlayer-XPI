import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * EN-D1: ONE parser of the route table, shared by the two tests that police it.
 *
 * `scope-coverage.test.ts` (EN-B) asks "did anyone DECIDE what a key may do
 * here?"; `openapi-contract.test.ts` (EN-D1) asks "does the published document
 * SAY the same thing?". Both questions are answered from the same declaration,
 * so they must be answered from the same reading of it — two parsers that drift
 * apart would let a route be scoped-but-undocumented while both files stayed
 * green, which is precisely the disagreement this pair exists to catch.
 *
 * It lives here rather than being exported from `scope-coverage.test.ts`
 * because vitest collects tests through the module graph: importing that file
 * re-registers its five `it`s inside the importer's suite (measured — the
 * openapi file alone reported 12 tests instead of 7), double-counting the
 * back-compat oracle. A plain module has no such side effect.
 *
 * It reads the SOURCE, not Fastify's route table, for the reason
 * scope-coverage.test.ts gives at length: what is under test is the
 * declaration — the shape a future author copies — and a runtime table cannot
 * tell "no scope gate" from "a scope gate that passed".
 */
/**
 * ONE FILE PER PRODUCT since routes.ts was split, so the source these checks read
 * is the CONCATENATION of the route families. Reading the folder rather than a
 * hard-coded list matters: a fourth family added tomorrow is covered the day it
 * appears, whereas a list would silently stop being the denominator.
 */
const ROUTES_DIR = fileURLToPath(new URL("../src/http/routes", import.meta.url));
function readAllRouteSources(): string {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts")).sort();
  if (files.length < 4) throw new Error(`expected the split route files in ${ROUTES_DIR}, found ${files.join(", ")}`);
  return files.map((f) => readFileSync(`${ROUTES_DIR}/${f}`, "utf8")).join("\n");
}

/** The head of a declaration, up to and including the options object's `{`. */
const ROUTE_HEAD_RE = /app\.(get|post|put|patch|delete)\("([^"]+)",\s*\{/g;

/** Every `app.<method>("<path>"` in the file, matched or not — the denominator. */
export const ANY_ROUTE_RE = /app\.(get|post|put|patch|delete)\("([^"]+)"/g;

/**
 * The options object, read by BALANCING braces rather than by stopping at the
 * first `}`.
 *
 * EN-B's original `\{([^}]*)\}` had a silent failure mode that a mutation test
 * caught: given `{ schema: S.x, config: { a: 1 }, ...authScoped("y") }` it
 * matched — so no coverage test complained — but the capture ended at the
 * INNER brace, hiding the scope gate that followed. A route would then read as
 * unscoped everywhere: exempt from the "documents its scope" check, and wrong
 * in the published document. Balancing makes the truncation impossible rather
 * than merely unlikely.
 */
function optionsBody(src: string, openBrace: number): string | null {
  return balanced(src, openBrace, "{", "}");
}

/**
 * The generic of the above: the text between `open` and its matching close.
 *
 * EN-D2 needed the same balancing over PARENTHESES — a route's HANDLER, not
 * just its options object — so the one implementation is parameterised rather
 * than copied. Copying it is how the truncation bug documented above would come
 * back in a second place, with only the first one fixed.
 */
function balanced(src: string, open: number, oc: string, cc: string): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === oc) depth += 1;
    else if (c === cc) {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null; // unterminated — the caller reports it rather than guessing
}

export interface RouteDecl {
  method: string;
  path: string;
  /** The scope from `...authScoped("x")`, or null when the route carries no scope gate. */
  scope: string | null;
  authed: boolean;
  /** The `S.<name>` key in schemas.ts whose `security`/`description` document this route. */
  schema: string | null;
  /**
   * The WHOLE `app.<method>(…)` call — options object and handler body — or
   * null when the parentheses did not balance. EN-D2's mode coverage asks what
   * a handler DOES (does it resolve a use case? does it consult the gate?),
   * which the options object alone cannot answer.
   */
  body: string | null;
}

export function declaredRoutes(): RouteDecl[] {
  const src = readAllRouteSources();
  const out: RouteDecl[] = [];
  for (const m of src.matchAll(ROUTE_HEAD_RE)) {
    const [, method, path] = m as unknown as [string, string, string];
    const opts = optionsBody(src, m.index + m[0].length - 1);
    // A runaway scan (an unbalanced brace inside a string, say) would read the
    // REST OF THE FILE as one route's options and quietly inherit another
    // route's gate. Treat it as unparsed and let the coverage test say so.
    if (opts === null || opts.includes("app.")) continue;
    const scoped = /\.\.\.authScoped\("([^"]+)"\)/.exec(opts);
    const schema = /schema:\s*S\.(\w+)/.exec(opts);
    // Same runaway rule for the handler: a body that swallowed the next route
    // declaration is reported as unparsed rather than credited with that
    // route's gate.
    const call = balanced(src, src.indexOf("(", m.index), "(", ")");
    out.push({
      method: method.toUpperCase(),
      path,
      scope: scoped?.[1] ?? null,
      authed: opts.includes("...auth"),
      schema: schema?.[1] ?? null,
      body: call === null || ANY_ROUTE_RE.test(call) ? null : call,
    });
    ANY_ROUTE_RE.lastIndex = 0; // `g` regex used with .test — reset or it strides
  }
  return out;
}

/**
 * The `{` that opens a function BODY, starting from just past its parameter
 * list — i.e. the first brace at angle-bracket depth zero.
 *
 * The depth tracking is the whole point. `async function invoiceGate(…):
 * Promise<{ useCase: UseCaseDefinition; … } | null> {` has TWO candidate
 * braces, and taking the first would read the return TYPE as the function's
 * body: a helper that plainly resolves a use case would then look like one that
 * touches nothing, and every route delegating to it would drop out of the
 * candidate set. A silent miss of exactly that shape is what the blind-spot
 * assertion in mode-coverage.test.ts exists to catch, but not producing it in
 * the first place is better.
 */
function bodyBrace(src: string, from: number): number {
  let angle = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "<") angle += 1;
    else if (c === ">" && src[i - 1] !== "=") angle = Math.max(0, angle - 1);
    else if (c === "{" && angle === 0) return i;
    // A `;` OUTSIDE the type annotation ends a bodiless declaration (an
    // overload signature). Inside one it is just a member separator —
    // `Promise<{ useCase: UseCaseDefinition; … }>` is full of them, and
    // treating those as the end of the declaration dropped `invoiceGate`,
    // `scopedListing` and `issueAssetCore` out of the helper set entirely.
    else if (c === ";" && angle === 0) return -1;
  }
  return -1;
}

/** A helper function declared inside `registerRoutes`: its name and its body. */
export interface HelperDecl {
  name: string;
  body: string;
}

/**
 * Every `function <name>(…) { … }` in routes.ts EXCEPT the ones that contain
 * route declarations (i.e. `registerRoutes` itself).
 *
 * Why a coverage test needs these: routes delegate. `scopedAsset`,
 * `invoiceGate` and `resolveIssuer` are where a use case is actually resolved
 * and where the gate actually sits, and a scan that looked only at route bodies
 * would call ten gated asset routes ungated and, worse, call them uninteresting.
 * Discovering helpers by PARSING rather than by listing their names means a
 * renamed or newly-added helper is picked up on its own.
 */
export function declaredHelpers(): HelperDecl[] {
  const src = readAllRouteSources();
  const out: HelperDecl[] = [];
  // The four WRAPPERS are not helpers — they are the functions the helpers live
  // inside. Counting them would count every nested helper's body twice: once on
  // its own and once again as part of its wrapper, which is exactly what
  // happened when routes.ts became routes/ and `WRONG_MODE is sent from exactly
  // one place` started reporting two sends of a refusal that is written once.
  const WRAPPERS = new Set(["registerRoutes", "buildRouteContext", "registerSharedRoutes",
    "registerTokenizationRoutes", "registerIdentityRoutes"]);
  for (const m of src.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)) {
    if (WRAPPERS.has(m[1]!)) continue;
    const openParen = m.index + m[0].length - 1;
    const params = balanced(src, openParen, "(", ")");
    if (params === null) continue;
    const bodyOpen = bodyBrace(src, openParen + params.length + 1);
    if (bodyOpen < 0) continue;
    const body = balanced(src, bodyOpen, "{", "}");
    if (body === null) continue;
    if (ANY_ROUTE_RE.test(body)) { ANY_ROUTE_RE.lastIndex = 0; continue; }
    ANY_ROUTE_RE.lastIndex = 0;
    out.push({ name: m[1]!, body });
  }
  return out;
}

/** Every route declaration in the file, whether or not the parser understood it. */
export function allRouteDeclarations(): string[] {
  const src = readAllRouteSources();
  return [...src.matchAll(ANY_ROUTE_RE)].map((m) => `${m[1]!.toUpperCase()} ${m[2]!}`);
}

export const routeKey = (d: { method: string; path: string }): string => `${d.method} ${d.path}`;
