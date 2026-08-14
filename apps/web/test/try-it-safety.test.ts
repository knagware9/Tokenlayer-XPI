/**
 * EN-D1 final review, MEDIUM 1: THE TRY-IT BUTTON MUST NOT FIRE A MUTATION.
 *
 * `canTryIt` restricted try-it to GET and justified it in a comment — "reads
 * have no such tail". That sentence was false, and nothing enforced it.
 * `GET /verification-requests/:id/verify` performs a one-way transition
 * (`setVerifierResult`), appends to the hash-chained audit log, and emits
 * `verification.completed` to EVERY webhook endpoint the organization has
 * registered. A PlatformAdmin or OrgAdmin browsing the reference with a real
 * request id would have consumed that verification and notified third parties,
 * from a page whose own copy promises it will not act.
 *
 * ═══ WHY THIS IS DERIVED AND NOT A HAND-WRITTEN LIST ═══
 *
 * A denylist plus "remember to add to it" is the same shape as the comment it
 * replaces: a claim, maintained by attention. So the answer is COMPUTED from
 * `apps/api/src/http/routes/` — every GET handler's body is read, and any one
 * that reaches a write primitive must be either denied a button or recorded in
 * `TRY_IT_SAFE` below with a written reason.
 *
 * The choice was measured before it was made, because "derive it" is only right
 * if it is not noisy. Across all 55 GET handlers, with a deliberately WIDE
 * primitive vocabulary (wider than the one below: `.delete*`, `.save`,
 * `.revoke*`, `.insert*`, `.upsert`, `.mark*`, `.record*`, `.anchor*`,
 * `.issue*`, `.add`, `.put`, `.remove*` were all tried), exactly two routes
 * matched: the real one, and `/identity/dashboard` calling `Map.prototype.set`
 * on a local label map. One false positive out of 55 is a table a human can
 * read, so the derivation stands rather than falling back to a bare denylist.
 *
 * ═══ WHY THE VOCABULARY IS BROAD RATHER THAN PRECISE ═══
 *
 * `.set…(` matches `Map.set` as well as `deps.repo.setStatus`. That is the
 * correct trade in this direction: a primitive that over-matches produces a
 * line in `TRY_IT_SAFE` that someone reads once; a primitive that under-matches
 * produces a live button that consumes a verification. The first failure is
 * paperwork, the second is the finding.
 *
 * ═══ WHY THE PARSER LIVES HERE AND NOT IN apps/api ═══
 *
 * `apps/api/test/route-decls.ts` already parses this file, and duplicating a
 * parser of the SAME fact is what that module's own comment argues against. But
 * this is a different fact — handler BODIES, not the options object — and the
 * decision it feeds (`tryItAllowed`) is a web module that the api suite cannot
 * import. So the read crosses the package boundary rather than the parser
 * crossing it, and the read is guarded below: if the scan stops finding
 * handlers, or a body runs past the next declaration, the test says so instead
 * of passing on an empty result.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MUTATING_GET_PATHS,
  canTryIt,
  mutatingGetReason,
  normalizeRoutePath,
  tryItAllowed,
} from "../src/lib/openapi.js";

// ONE FILE PER PRODUCT since routes.ts was split. Read the folder, not a list:
// a family added later is covered the day it appears.
const ROUTES_DIR = fileURLToPath(new URL("../../api/src/http/routes", import.meta.url));
const readAllRouteSources = (): string => {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts")).sort();
  if (files.length < 4) throw new Error(`expected the split route files in ${ROUTES_DIR}, found ${files.join(", ")}`);
  return files.map((f) => readFileSync(`${ROUTES_DIR}/${f}`, "utf8")).join("\n");
};

/** The head of a declaration, up to and including the options object's `{`. */
const ROUTE_HEAD_RE = /app\.(get|post|put|patch|delete)\("([^"]+)",\s*\{/g;

/** From an opening brace, the index of the brace that closes it. -1 if unbalanced. */
function balancedEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Handler { method: string; path: string; body: string | null; start: number; end: number }

/**
 * Every `app.<method>("<path>", { … }, async (…) => { … })` in routes.ts, with
 * the HANDLER body — not the options object `route-decls.ts` reads.
 *
 * Brace-balanced from the arrow that follows the options object. Balancing is
 * naive about braces inside string and template literals; the integrity checks
 * in the first `it` below are what turn that from a silent risk into a loud
 * one, by asserting no body swallows the declaration that follows it.
 */
function handlers(): Handler[] {
  const src = readAllRouteSources();
  const out: Handler[] = [];
  for (const m of src.matchAll(ROUTE_HEAD_RE)) {
    const [, method, path] = m as unknown as [string, string, string];
    const optionsEnd = balancedEnd(src, m.index + m[0].length - 1);
    if (optionsEnd < 0) { out.push({ method, path, body: null, start: m.index, end: -1 }); continue; }
    const rest = src.slice(optionsEnd);
    const arrow = rest.indexOf("=>");
    const bodyOpen = arrow < 0 ? -1 : rest.indexOf("{", arrow);
    if (bodyOpen < 0) { out.push({ method, path, body: null, start: m.index, end: -1 }); continue; }
    const start = optionsEnd + bodyOpen;
    const end = balancedEnd(src, start);
    out.push({ method, path, body: end < 0 ? null : src.slice(start, end + 1), start, end });
  }
  return out;
}

/**
 * Reaching any of these from a request handler means the request CHANGED
 * something — durable state, the audit chain, or somebody else's system.
 * Deliberately over-broad; see the header.
 */
const MUTATING_PRIMITIVES: readonly (readonly [string, RegExp])[] = [
  ["emitEvent(", /\bemitEvent\(/],
  ["audit.append(", /\baudit\.append\(/],
  [".set…(", /\.set[A-Za-z]*\(/],
  [".create…(", /\.create[A-Za-z]*\(/],
  [".update…(", /\.update[A-Za-z]*\(/],
  [".claim(", /\.claim\(/],
];

/**
 * GET handlers that match a primitive but are NOT mutations, with the reason.
 *
 * The same discipline every other exemption on this branch carries
 * (`PRE_EXISTING_NARROWING`, `DOCUMENTATION_DEFERRED`, `NOT_API_PATHS`,
 * `DELIBERATELY_UNSCOPED`): named, reasoned, and checked for staleness below,
 * so an entry nobody needs any more cannot sit here unread.
 */
const TRY_IT_SAFE: Record<string, string> = {
  "GET /identity/dashboard":
    "`holderLabels.set(...)` is Map.prototype.set on a lookup table built inside the handler — an in-memory join " +
    "for the response it is about to return. Nothing leaves the request.",
};

const key = (h: Handler): string => `${h.method.toUpperCase()} ${h.path}`;

/** Which primitives a handler's body reaches, by their display names. */
function primitivesIn(body: string): string[] {
  return MUTATING_PRIMITIVES.filter(([, re]) => re.test(body)).map(([name]) => name);
}

describe("the try-it button cannot fire a mutating route", () => {
  it("reads every route handler in routes.ts", () => {
    // THE SCAN'S OWN BLIND SPOT, closed first. Every assertion below is of the
    // form "nothing was found that should have been denied", and an empty scan
    // satisfies all of them. 121 routes and 55 GETs were present when this was
    // written; the floors sit below that so ordinary route work does not trip
    // them, but a parser that stops matching cannot pass silently.
    const all = handlers();
    expect(all.length, "no route declarations were found at all — ROUTE_HEAD_RE has stopped matching").toBeGreaterThan(100);
    expect(all.filter((h) => h.method === "get").length, "no GET handlers were found").toBeGreaterThan(40);

    const unparsed = all.filter((h) => h.body === null).map(key);
    expect(unparsed, `handler bodies the scan could not read: ${unparsed.join(", ")}`).toEqual([]);

    // A body that runs past the NEXT declaration has swallowed it, which would
    // both hide that route's own primitives and attribute them to this one.
    const overlaps: string[] = [];
    for (let i = 0; i < all.length - 1; i++) {
      if (all[i]!.end > all[i + 1]!.start) overlaps.push(`${key(all[i]!)} swallows ${key(all[i + 1]!)}`);
    }
    expect(overlaps, `handler bodies that ran past the next declaration: ${overlaps.join("; ")}`).toEqual([]);
  });

  it("denies a button to every GET that reaches a write primitive", () => {
    const failures: string[] = [];
    for (const h of handlers()) {
      if (h.method !== "get" || h.body === null) continue;
      const hits = primitivesIn(h.body);
      if (hits.length === 0) continue;
      if (key(h) in TRY_IT_SAFE) continue;
      if (tryItAllowed({ method: h.method, path: h.path })) {
        failures.push(
          `${key(h)} calls ${hits.join(", ")} but the reference would still offer a "Try it" button for it. ` +
            `Add its path to MUTATING_GET_PATHS in src/lib/openapi.ts, or — if the match is a false positive — ` +
            `add it to TRY_IT_SAFE in this file with the reason it does not mutate.`,
        );
      }
    }
    // Collected rather than thrown one at a time: one run should print the whole
    // work queue, not just whichever route sorts first.
    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });

  it("the safe list has no stale entries", () => {
    const matching = new Set(
      handlers().filter((h) => h.method === "get" && h.body !== null && primitivesIn(h.body!).length > 0).map(key),
    );
    const stale = Object.keys(TRY_IT_SAFE).filter((k) => !matching.has(k));
    expect(stale, `no longer matches any primitive (or no longer exists) — drop from TRY_IT_SAFE: ${stale.join(", ")}`).toEqual([]);
  });

  it("the denylist is non-empty and still names the verification route", () => {
    // Belt to the derivation's braces. If MUTATING_GET_PATHS were emptied AND
    // the derivation regressed to matching nothing, every check above would go
    // green on two failures cancelling out. This one names the route.
    expect(Object.keys(MUTATING_GET_PATHS).length).toBeGreaterThan(0);
    expect(MUTATING_GET_PATHS).toHaveProperty("/verification-requests/{}/verify");
    for (const reason of Object.values(MUTATING_GET_PATHS)) expect(reason.length).toBeGreaterThan(40);
  });

  it("refuses the route however the path is spelled", () => {
    // The portal reads DOCUMENT paths and the derivation reads DECLARATION
    // paths. A denylist that only matched one spelling would be green here and
    // wide open in the browser, which is the only place it matters.
    for (const spelling of [
      "/verification-requests/{id}/verify",
      "/api/v1/verification-requests/{id}/verify",
      "/verification-requests/:id/verify",
      "/api/v1/verification-requests/:id/verify",
      "/verification-requests/{requestId}/verify",
    ]) {
      expect(normalizeRoutePath(spelling)).toBe("/verification-requests/{}/verify");
      expect(mutatingGetReason(spelling), spelling).not.toBeNull();
      expect(tryItAllowed({ method: "GET", path: spelling }), spelling).toBe(false);
      expect(tryItAllowed({ method: "get", path: spelling }), spelling).toBe(false);
    }
  });

  it("leaves ordinary reads alone", () => {
    // The denial must be surgical. A guard that switched try-it off everywhere
    // would also pass the checks above, and would silently delete the feature.
    for (const path of ["/api/v1/assets", "/api/v1/orgs/{id}/webhooks", "/api/v1/verification-requests/{id}"]) {
      expect(mutatingGetReason(path), path).toBeNull();
      expect(tryItAllowed({ method: "get", path }), path).toBe(true);
    }
    expect(canTryIt("get")).toBe(true); // the method predicate itself is unchanged
  });

  it("is the only eligibility check the reference component uses", () => {
    // `canTryIt` answers the METHOD question alone, and calling it directly from
    // the UI is precisely the bug: the path is what carries the danger. The
    // component must reach for `tryItAllowed`, which cannot be called without
    // one. Asserted on the source because there is no DOM here to render into.
    const tsx = readFileSync(fileURLToPath(new URL("../src/components/ApiReference.tsx", import.meta.url)), "utf8");
    expect(tsx).toContain("tryItAllowed(route)");
    expect(
      /\bcanTryIt\s*\(/.test(tsx),
      "ApiReference.tsx calls canTryIt directly — that predicate never sees the path, so it cannot refuse a mutating GET. Use tryItAllowed(route).",
    ).toBe(false);
  });
});
