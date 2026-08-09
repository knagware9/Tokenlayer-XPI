import { readFileSync } from "node:fs";
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
const ROUTES_TS = fileURLToPath(new URL("../src/http/routes.ts", import.meta.url));

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
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(openBrace + 1, i);
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
}

export function declaredRoutes(): RouteDecl[] {
  const src = readFileSync(ROUTES_TS, "utf8");
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
    out.push({
      method: method.toUpperCase(),
      path,
      scope: scoped?.[1] ?? null,
      authed: opts.includes("...auth"),
      schema: schema?.[1] ?? null,
    });
  }
  return out;
}

/** Every route declaration in the file, whether or not the parser understood it. */
export function allRouteDeclarations(): string[] {
  const src = readFileSync(ROUTES_TS, "utf8");
  return [...src.matchAll(ANY_ROUTE_RE)].map((m) => `${m[1]!.toUpperCase()} ${m[2]!}`);
}

export const routeKey = (d: { method: string; path: string }): string => `${d.method} ${d.path}`;
