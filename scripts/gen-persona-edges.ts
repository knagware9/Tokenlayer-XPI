/**
 * TURN THE PERSONA CATALOGUE INTO SIX NGINX CONFIGS.
 *
 *   pnpm gen:persona-edges     (writes deploy/persona-edges/*.conf)
 *
 * The generated files are COMMITTED, and persona-edge-config.test.ts regenerates
 * them and fails on any diff. That is what keeps the deployed boundary and
 * packages/core/src/personas.ts the same object: you cannot edit one without the
 * other going red.
 *
 * ── THE ORDERING TRAP ───────────────────────────────────────────────────────
 *
 * nginx tries regex locations IN ORDER and stops at the first match — it does
 * not pick the most specific one. So a naive emission in table order produces a
 * config that disagrees with `personaAllows`:
 *
 *     location ~ ^/api/v1/assets(/|$)    { limit_except GET ... }   # marketplace
 *     location ~ ^/api/v1/assets/[^/]+/buy(/|$) { limit_except POST ... }
 *
 * `POST /assets/abc/buy` matches the FIRST block, gets method-checked against
 * GET, and is refused — the investor cannot buy, and nothing in the catalogue
 * says so. Two things fix it together:
 *
 *   1. Rules are emitted MOST SPECIFIC FIRST (most path segments wins).
 *   2. Each block's method list is `personaMethodsFor(prefix)` — the methods the
 *      MODEL grants at that path, not the single rule's own `methods`. Otherwise
 *      `GET /assets/abc/buy`, which the model allows via the broad `/assets`
 *      read rule, would be refused by the narrower `buy` block that shadows it.
 *
 * `edgeDecision` below simulates that matching, and the test asserts it agrees
 * with `personaAllows` for every route in the API surface × every method. The
 * simulation is the only honest way to check a generator whose output is
 * evaluated by another program's ordering rules.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PERSONAS, personaMethodsFor, personaRules,
  type HttpMethod, type PersonaDef,
} from "../packages/core/src/personas.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = resolve(HERE, "../deploy/persona-edges");

/** The API service each persona's edge proxies to, by product. */
const UPSTREAM: Record<string, string> = {
  identity: "http://identity-api:4000",
  tokenization: "http://tokenization-api:4000",
};

export interface EmittedRule {
  /** The nginx regex, anchored, over the CONCRETE url including /api/v1. */
  regex: string;
  methods: readonly HttpMethod[];
  prefix: string;
  why: string;
}

const segments = (prefix: string): number => prefix.split("/").filter(Boolean).length;
/** How many segments are wildcards. Fewer means a more specific claim. */
const params = (prefix: string): number => prefix.split("/").filter((s) => s.startsWith(":")).length;

/** `/orgs/:id/members` → `^/api/v1/orgs/[^/]+/members(/|$)` (or `…$` when exact). */
export function toRegex(prefix: string, exact: boolean): string {
  const body = prefix
    .split("/")
    .map((s) => (s.startsWith(":") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return `^/api/v1${body}${exact ? "$" : "(/|$)"}`;
}

/**
 * One persona's rules in the order nginx must see them: most specific first, so
 * a narrow rule is never shadowed by the broad one it sits under.
 */
export function emittedRules(persona: PersonaDef): EmittedRule[] {
  const rules = [...personaRules(persona)].sort((a, b) => {
    const bySeg = segments(b.prefix) - segments(a.prefix);
    if (bySeg !== 0) return bySeg;
    // A LITERAL segment beats a wildcard at the same depth. `/users/:id` and
    // `/users/batch` are both two deep, but `[^/]+` also matches `batch` — so
    // emitting the wildcard first swallowed `POST /users/batch` and, in the same
    // way, `/orgs/:id` swallowed the public `POST /orgs/register`. Both were
    // caught by the equivalence test, not by reading the config.
    const byParams = params(a.prefix) - params(b.prefix);
    if (byParams !== 0) return byParams;
    // At equal depth and equal wildcards, an exact rule is the narrower claim.
    if (!!a.exact !== !!b.exact) return a.exact ? -1 : 1;
    return b.prefix.length - a.prefix.length;
  });
  return rules.map((r) => ({
    regex: toRegex(r.prefix, !!r.exact),
    // NOT r.methods — see the ordering trap above.
    // OPTIONS rides along on every rule. A browser preflights any request
    // carrying an Authorization header, and a preflight the edge refuses comes
    // back without Access-Control-Allow-Origin, so the browser blocks the REAL
    // request and reports it as a CORS failure — an error naming neither the
    // persona boundary nor the missing method. Node's fetch sends no preflight,
    // which is why the whole e2e passed against six apps no browser could use.
    // OPTIONS is transport, not permission: it reveals only which methods are
    // allowed, and a route absent from this allowlist is still default-denied.
    methods: [...personaMethodsFor(persona, r.prefix), "OPTIONS" as HttpMethod],
    prefix: r.prefix,
    why: r.why,
  }));
}

/**
 * What the generated config would do with `METHOD url`, by nginx's own rules:
 * first matching regex location wins, then its method guard decides.
 */
export function edgeDecision(persona: PersonaDef, method: string, url: string): "allow" | "deny" {
  for (const rule of emittedRules(persona)) {
    if (!new RegExp(rule.regex).test(url)) continue;
    return (rule.methods as readonly string[]).includes(method.toUpperCase()) ? "allow" : "deny";
  }
  return "deny";
}

const BANNER = (persona: PersonaDef) => `# ─────────────────────────────────────────────────────────────────────────────
# GENERATED — DO NOT EDIT.  Source: packages/core/src/personas.ts
# Regenerate with:  pnpm gen:persona-edges
# persona-edge-config.test.ts fails if this file and the catalogue disagree.
#
# ${persona.label} (${persona.key}) — ${persona.domain}
# ${persona.description}
#
# Everything not named below is refused HERE, at the edge, before it reaches
# ${UPSTREAM[persona.domain]}. Locations are ordered most-specific-first
# because nginx stops at the FIRST matching regex, not the best one.
# ─────────────────────────────────────────────────────────────────────────────`;

export function renderConfig(persona: PersonaDef): string {
  const upstream = UPSTREAM[persona.domain];
  const blocks = emittedRules(persona).map((r) => {
    // `limit_except` is nginx's purpose-built method guard; `error_page 403 =404`
    // turns its refusal into the same 404 an unlisted path gets, so probing the
    // edge cannot distinguish "wrong method here" from "not served here".
    // Always emitted, even when it permits everything: an explicit list is what
    // someone auditing this file reads, and the special case that skipped it was
    // where the missing OPTIONS hid.
    const guard = `\n    limit_except ${r.methods.join(" ")} { deny all; }\n    error_page 403 =404 @denied;`;
    return `  # ${r.prefix} — ${r.why}
  location ~ "${r.regex}" {${guard}
    # Through a VARIABLE so nginx resolves the upstream at request time, not at
    # config-parse time. Two things depend on it: 'nginx -t' can validate this
    # file in a build where no API container exists, and the edge survives the
    # API restarting on a new address instead of caching the first one forever.
    set $upstream_api ${upstream};
    proxy_pass $upstream_api;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Persona         ${persona.key};
    proxy_read_timeout 120s;
  }`;
  });

  return `${BANNER(persona)}

server {
  listen 80;
  server_name _;
  client_max_body_size 12m;   # KYB documents and certificate artwork travel this way
  resolver 127.0.0.11 valid=10s ipv6=off;   # docker compose's embedded DNS

  # Liveness for compose healthchecks — answered by the edge itself, so it stays
  # truthful about the EDGE rather than about the API behind it.
  location = /healthz {
    default_type application/json;
    return 200 '{"ok":true,"persona":"${persona.key}","domain":"${persona.domain}"}';
  }

${blocks.join("\n\n")}

  # ── DEFAULT DENY ──────────────────────────────────────────────────────────
  # Absence is refusal. A route added to the API without being granted to this
  # persona lands here, which is what the NO ORPHAN ROUTE test exists to catch
  # before anyone meets it in a browser.
  location @denied {
    default_type application/json;
    return 404 '{"error":"PERSONA_ROUTE_NOT_ALLOWED","message":"the ${persona.key} application does not serve this route","persona":"${persona.key}"}';
  }

  location / {
    default_type application/json;
    return 404 '{"error":"PERSONA_ROUTE_NOT_ALLOWED","message":"the ${persona.key} application does not serve this route","persona":"${persona.key}"}';
  }
}
`;
}

export function generateAll(): Map<string, string> {
  return new Map(PERSONAS.map((p) => [`${p.key}.conf`, renderConfig(p)]));
}

// Written only when run directly, so the test can import the renderers.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, body] of generateAll()) {
    writeFileSync(resolve(OUT_DIR, name), body);
    console.log(`  wrote deploy/persona-edges/${name}`);
  }
  console.log(`\n${PERSONAS.length} persona edge configs generated from packages/core/src/personas.ts`);
}
