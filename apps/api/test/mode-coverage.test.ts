import { describe, expect, it } from "vitest";
import { allRouteDeclarations, declaredHelpers, declaredRoutes, routeKey as key } from "./route-decls.js";

/**
 * EN-D2: A ROUTE THAT RESOLVES A USE CASE AND FORGETS THE MODE GATE IS A
 * CROSS-ENVIRONMENT HOLE.
 *
 * The sibling of `scope-coverage.test.ts`, and for the identical reason. There,
 * the fail-open default is "no `authScoped`" — any key, any scope. Here it is
 * even quieter: a handler that resolves a use case and simply never mentions
 * mode serves a `tl_test_` key from the live register with a 200. Nothing about
 * the code looks wrong; the check is absent rather than incorrect, and absence
 * is what a reviewer's eye slides over.
 *
 * So the decision is made mandatory in ONE reviewable place: every route that
 * resolves a use case either consults the gate — directly, or through a helper
 * that does — or appears in MODE_EXEMPT below WITH a reason. A new route that
 * does neither fails the build.
 *
 * WHY IT ALSO READS HELPERS. Routes delegate: ten asset routes resolve nothing
 * themselves and go through `scopedAsset`, six invoice-register routes through
 * `invoiceGate`, three credential routes through `resolveIssuer`. A scan that
 * looked only at route bodies would report those routes as touching no use case
 * at all — the worst possible failure here, because it is indistinguishable
 * from success. `declaredHelpers()` (in the shared parser) therefore discovers
 * the helpers by PARSING and classifies each as a resolver, a gate, or both, so
 * a renamed or newly-added helper is picked up on its own rather than when
 * somebody remembers to add it to a list.
 *
 * It reads the SOURCE rather than Fastify's route table for the reason
 * scope-coverage gives at length: what is under test is the DECLARATION — the
 * shape a future author copies — and a runtime table cannot tell "no gate" from
 * "a gate that passed". The parser is EN-D1's shared one, deliberately not a
 * second copy: the truncation bug documented in `route-decls.ts` is exactly
 * what a private re-implementation would reintroduce.
 */

/** `useCases.get(` / `credentialUseCases.list(` / … — a use case being resolved. */
const RESOLVES_USE_CASE = /\b(useCases|credentialUseCases)\.(get|has|list)\(/;

/**
 * The gate, in either of its two entry points: `modeGate` (the record in hand)
 * and `modeGateByKey` (only a key in hand, resolved across both domains). The
 * shared prefix is deliberate — one pattern matches both, and a third entry
 * point named in the same family is covered the day it is written.
 */
const CONSULTS_GATE = /\bmodeGate\w*\(/;

/** Does `body` call any of `names` (as functions)? */
function calls(body: string, names: readonly string[]): boolean {
  return names.some((n) => new RegExp(`\\b${n}\\(`).test(body));
}

/**
 * Routes that resolve a use case and deliberately carry NO mode gate. Each
 * entry states WHY, in prose, and the staleness check below deletes the
 * standing exemption the moment it stops being true.
 */
/**
 * The exemptions above that are exempt BECAUSE THEY FILTER. Every one of them
 * must be able to show the filter in its own body — otherwise the reason is
 * merely a sentence, and a sentence is what an allowlist rots into.
 *
 * `modeFilter` narrows a projection row by row; `modeVisibleUseCaseKeys`
 * narrows the repository query itself. Either is the decision; neither being
 * present means the route says "filtered" and is not.
 */
const FILTERED = [
  "GET /use-cases",
  "GET /credential-use-cases",
  "GET /analytics",
  "GET /identity/dashboard",
  "GET /assets",
  "GET /audit/verify",
  "POST /audit/anchor",
] as const;

/** `modeFilter(` / `modeVisible…(` — a mode NARROWING rather than a refusal. */
const NARROWS_BY_MODE = /\bmode(Filter|Visible\w*)\(/;

const MODE_EXEMPT: Record<string, string> = {
  // --- pre-auth, or the caller's own session: the use case is resolved only to
  // LABEL a session with its product domain (see resolveUseCaseDomain), never
  // to read or write anything belonging to it.
  "POST /auth/login": "resolves a use case only to label the session's product domain; runs before any principal exists, and a key cannot authenticate here at all",
  "GET /auth/qr/:id": "the same domain label on an unauthenticated QR poll; no principal, so no mode to compare against",
  "GET /me": "the caller's own claims, with the same domain label; a key reading back the identity it already proved crosses nothing",

  // --- list projections and aggregates. Gating a LIST per row would 403 the
  // whole response because one row is in the other environment, which is the
  // wrong answer: the right one is to FILTER. D2-6 landed that filter, so
  // these are no longer deferred — they are decided, and the decision is
  // checked rather than asserted in prose by "the filtered projections really
  // do filter" below.
  "GET /use-cases": "a list, not an act on one use case; a machine principal's catalog is narrowed to its own environment by modeFilter, and a human sees both because a builder must be able to find the sandbox programme they are configuring",
  "GET /credential-use-cases": "the identity-domain twin of the above, narrowed by the same modeFilter rather than 403'd per row",
  "GET /analytics": "an aggregate over every use case the caller can see; modeFilter excludes sandbox from the numbers by default (?includeSandbox=true opts in, and never for a key), which is a filter and not a refusal",
  "GET /identity/dashboard": "an aggregate over the caller's own credential use cases, narrowed by the same modeFilter on the same terms",
  // The three routes that resolve NO use case of their own and select across
  // ALL of them — the crossing D2-6 found. They are exempt from the GATE for
  // the reason above (an aggregate must narrow, not refuse), but the narrowing
  // is not optional here: it rides into the repository query as
  // `AssetFilter.useCaseKeys`, so `pagination.total` and the page window
  // describe only rows the caller may see.
  "GET /assets": "selects across every use case for a PlatformAdmin principal, so there is no single use case to gate; modeVisibleUseCaseKeys pushes the admitted keys into the asset query instead, which narrows the page and its total together",
  "GET /audit/verify": "a tamper summary over the same unnarrowed asset selection, narrowed by the same modeVisibleUseCaseKeys — a summary over the live register would be a disclosure of the live register",
  "POST /audit/anchor": "the write side of that same selection (it would otherwise anchor live heads on a real chain with a test key); narrowed by modeVisibleUseCaseKeys rather than gated, because anchoring is a bulk act over everything the caller can see",

  // --- the holder's own wallet. A credential belongs to its HOLDER, who is a
  // human with no mode; the use case is resolved only to title the row.
  "GET /me/credentials": "the caller's OWN held credentials; the use case is resolved for a display label, and a holder's wallet legitimately spans whatever was issued to them",
  "GET /orgs/:id/wallet": "an organization's own held credentials, through the same mapHeld projection and for the same reason",

  // --- public by design: no principal, so nothing to compare a mode against.
  "GET /credentials/:id/certificate.pdf": "public by design (a third party holding only the credential must be able to render it); an unauthenticated request carries no key and so has no mode",
};

describe("mode-gate coverage (EN-D2)", () => {
  const routes = declaredRoutes();
  const helpers = declaredHelpers();
  const resolvers = helpers.filter((h) => RESOLVES_USE_CASE.test(h.body)).map((h) => h.name);
  const gates = helpers.filter((h) => CONSULTS_GATE.test(h.body)).map((h) => h.name);

  /** Routes that resolve a use case — themselves, or through a resolving helper. */
  const candidates = routes.filter((r) => r.body !== null && (RESOLVES_USE_CASE.test(r.body) || calls(r.body, resolvers)));
  const gated = (r: { body: string | null }) => !!r.body && (CONSULTS_GATE.test(r.body) || calls(r.body, gates));

  it("the scan actually looked — routes, helper bodies, and both sides of the gate", () => {
    // THE BLIND-SPOT ASSERTION, and the most important test in this file.
    //
    // Every other assertion here is of the form "no route is undecided", which
    // a scan that found NOTHING satisfies perfectly. EN-C shipped with 16 tests
    // silently uncollected and a green suite; a coverage test that reports
    // success because it never looked is the same failure with a stronger claim
    // attached. So: pin the denominator, pin zero unparsed bodies, and pin the
    // named anchors on both sides of the gate.
    expect(allRouteDeclarations().length).toBeGreaterThan(100);
    expect(routes.length).toBe(allRouteDeclarations().length);
    // A handler whose parentheses did not balance is UNPARSED, not ungated —
    // it would read as touching nothing and drop out of `candidates` silently.
    expect(routes.filter((r) => r.body === null).map(key)).toEqual([]);

    // The helper layer exists and was read. `invoiceGate` and `issueAssetCore`
    // are here by name because both have a `Promise<{ … ; … }>` return type
    // that an earlier version of the body-brace scan mistook for the function
    // body — dropping them, and with them every route that delegates to them.
    expect(helpers.length).toBeGreaterThan(30);
    for (const anchor of ["scopedAsset", "invoiceGate", "issueAssetCore", "resolveIssuer", "scopedListing"]) {
      expect(helpers.map((h) => h.name)).toContain(anchor);
    }
    expect(resolvers).toEqual(expect.arrayContaining(["scopedAsset", "invoiceGate", "issueAssetCore"]));
    expect(gates).toEqual(expect.arrayContaining(["scopedAsset", "invoiceGate", "resolveIssuer"]));

    // A plausible number of candidates, and a plausible number actually gated.
    // Break the matcher and BOTH collapse to zero, loudly.
    expect(candidates.length).toBeGreaterThan(35);
    expect(candidates.filter(gated).length).toBeGreaterThan(30);
  });

  it("EVERY route that resolves a use case consults the gate or is listed with a reason", () => {
    const undecided = candidates.filter((r) => !gated(r) && !(key(r) in MODE_EXEMPT)).map(key);
    // If this fails you added (or changed) a route that resolves a use case and
    // did not say what a `tl_test_` key may do with it. Call `modeGate(request,
    // reply, useCase)` — it sends the 403 itself — or add the route to
    // MODE_EXEMPT above WITH the reason. Reads count as much as writes: serving
    // the live register to a sandbox key is a disclosure, and disclosure is an
    // authorization decision.
    expect(undecided).toEqual([]);
  });

  it("the exemption table has no stale entries", () => {
    // An exemption that is no longer needed must not keep standing — that is
    // how an allowlist rots into a rubber stamp (EN-B's DELIBERATELY_UNSCOPED
    // and EN-D1's DOCUMENTATION_DEFERRED both carry this same check). Two ways
    // to go stale: the route was since gated, or it no longer resolves a use
    // case (or no longer exists at all).
    const exemptable = new Set(candidates.filter((r) => !gated(r)).map(key));
    const stale = Object.keys(MODE_EXEMPT).filter((k) => !exemptable.has(k));
    expect(stale).toEqual([]);
  });

  it("the filtered projections really do filter (D2-6)", () => {
    // D2-4 exempted the list projections on the promise that D2-6 would filter
    // them. This is the promise being collected: an exemption whose stated
    // reason is "it filters" fails here the day the filter is deleted, which
    // is the only difference between a decision and a note.
    for (const k of FILTERED) {
      expect(MODE_EXEMPT[k], `${k} must still be exempt from the gate`).toBeDefined();
      const r = routes.find((x) => key(x) === k);
      expect(r, `${k} has gone missing`).toBeDefined();
      expect(NARROWS_BY_MODE.test(r!.body ?? ""), `${k} claims to filter by mode and does not`).toBe(true);
    }
    // …and the narrowing helpers exist and were read, so a rename cannot turn
    // the assertion above into a check on a regex nothing matches.
    const narrowers = helpers.filter((h) => NARROWS_BY_MODE.test(h.body)).map((h) => h.name);
    expect(helpers.map((h) => h.name)).toEqual(expect.arrayContaining(["modeFilter", "modeVisibleUseCaseKeys"]));
    expect(narrowers).toContain("modeVisibleUseCaseKeys");
  });

  it("every exemption gives a real reason", () => {
    // A placeholder is worse than no entry: it looks like a decision and is
    // not one. Prose, of a length somebody had to think to write.
    for (const [route, reason] of Object.entries(MODE_EXEMPT)) {
      expect(reason.trim().length, `${route} needs a written reason`).toBeGreaterThan(30);
      expect(reason.trim().split(/\s+/).length, `${route}'s reason is not prose`).toBeGreaterThan(6);
      expect(reason, `${route}'s reason is a placeholder`).not.toMatch(/^(todo|tbd|fixme|n\/a|-+|\?+)\b/i);
    }
  });

  it("both doors onto asset issuance are gated", () => {
    // The mode twin of scope-coverage's "the two doors agree". `issueAssetCore`
    // is reached from POST /assets and from the invoice register's tokenize,
    // and it returns a result object rather than replying — so the gate cannot
    // live inside it and must be present on each door independently. Gate one
    // and not the other and a test key still mints into the live register.
    const at = (k: string) => routes.find((r) => key(r) === k);
    for (const k of ["POST /assets", "POST /use-cases/:key/invoices/tokenize"]) {
      const r = at(k);
      expect(r, `${k} has gone missing`).toBeDefined();
      expect(gated(r!), `${k} is a door onto issueAssetCore and must consult the mode gate`).toBe(true);
    }
  });

  it("deciding a proposal is gated, and the proposal list is narrowed (D2-6)", () => {
    // THE BLIND SPOT THIS FILE HAD. A proposal is a CAPTURED OPERATION: the
    // mint, the deploy and the signature all happen on final approval, in
    // `decide` — which resolves a PROPOSAL and no use case, so the scan above
    // could never have classified it as a candidate. It is named here instead,
    // by hand, because the scan cannot find what it cannot see. (`GET /assets`
    // was the same shape; it only became visible once its fix added a
    // `useCases.list()` call.)
    const at = (k: string) => routes.find((r) => key(r) === k);
    for (const k of ["POST /proposals/:id/approve", "POST /proposals/:id/reject"]) {
      const r = at(k);
      expect(r, `${k} has gone missing`).toBeDefined();
      expect(gated(r!), `${k} EXECUTES the captured operation and must consult the mode gate`).toBe(true);
    }
    // Reject is not a spectator: it runs compensation (fee refunds, asset state
    // changes), so it decides the other environment's business just as much.
    const decideHelper = helpers.find((h) => h.name === "decide");
    expect(decideHelper, "both decision routes delegate to `decide` — it has gone missing").toBeDefined();
    expect(CONSULTS_GATE.test(decideHelper!.body)).toBe(true);
    // …and the list of them narrows rather than refusing, as every other
    // machine-visible list here does.
    expect(NARROWS_BY_MODE.test(at("GET /proposals")?.body ?? "")).toBe(true);
  });

  it("WRONG_MODE is sent from exactly one place", () => {
    // The refusal is the gate's, not a call site's. A second hand-rolled 403
    // would be the beginning of the drift this whole file exists to prevent —
    // one that forgets `details`, or gets the direction the wrong way round.
    const src = routes.map((r) => r.body ?? "").join("\n") + helpers.map((h) => h.body).join("\n");
    expect(src.match(/WRONG_MODE/g) ?? []).toHaveLength(1);
  });
});
