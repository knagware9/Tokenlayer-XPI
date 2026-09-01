/**
 * THE BOUNDARY A CONTAINER IS SUPPOSED TO BE.
 *
 * Each persona ships as its own edge container whose whole job is to refuse
 * what that audience has no business calling. These tests pin the refusals that
 * matter — not because the matcher is subtle, but because the failure mode is
 * silent: widening a prefix from `/credentials/:id/status` to `/credentials`
 * costs one word and hands a relying party the power to revoke, and nothing
 * about the diff looks alarming.
 *
 * The positive cases matter just as much. An allowlist that refuses everything
 * passes every negative test ever written, and would ship six containers that
 * cannot log in.
 */
import { describe, expect, it } from "vitest";
import {
  PERSONAS, personaAllows, personaByKey, personaMethodsFor, personaRules, personasForDomain,
} from "../src/shared/personas.js";

const p = (key: string) => {
  const def = personaByKey(key);
  if (!def) throw new Error(`no persona '${key}'`);
  return def;
};

describe("the catalogue itself", () => {
  it("has six personas, three per product, with unique keys", () => {
    expect(PERSONAS).toHaveLength(6);
    expect(new Set(PERSONAS.map((x) => x.key)).size).toBe(6);
    expect(personasForDomain("identity").map((x) => x.key))
      .toEqual(["identity-issuer", "identity-verifier", "identity-holder"]);
    expect(personasForDomain("tokenization").map((x) => x.key))
      .toEqual(["tokenization-issuer", "tokenization-marketplace", "tokenization-admin"]);
  });

  it("gives every persona a default view it is actually allowed to render", () => {
    // A landing view outside the persona's own surfaces would open each app on a
    // blank screen — the kind of thing that only shows up after a docker build.
    for (const persona of PERSONAS) expect(persona.surfaces).toContain(persona.defaultView);
  });

  it("states a reason on every rule", () => {
    // The `why` is what someone auditing the boundary reads. A blank one means
    // nobody has to justify a widening.
    for (const persona of PERSONAS) {
      for (const rule of personaRules(persona)) expect(rule.why.trim().length).toBeGreaterThan(10);
    }
  });
});

describe("every persona can still sign in and wear its brand", () => {
  it.each(PERSONAS.map((x) => x.key))("%s admits the baseline", (key) => {
    const persona = p(key);
    expect(personaAllows(persona, "POST", "/auth/login")).toBe(true);
    expect(personaAllows(persona, "GET", "/config")).toBe(true);
    expect(personaAllows(persona, "GET", "/me")).toBe(true);
    expect(personaAllows(persona, "GET", "/orgs/:id/branding/logo")).toBe(true);
  });

  it("the baseline brand rule does NOT leak the rest of /orgs to an end-user app", () => {
    // The trap this pins: `/orgs/:id/branding/logo` is a child of `/orgs`, so a
    // careless rule written as `/orgs` would satisfy the test above while also
    // handing a wallet the roster.
    const holder = p("identity-holder");
    expect(personaAllows(holder, "GET", "/orgs/:id/branding/logo")).toBe(true);
    expect(personaAllows(holder, "GET", "/orgs")).toBe(false);
    expect(personaAllows(holder, "GET", "/orgs/:id/members")).toBe(false);
    expect(personaAllows(holder, "GET", "/orgs/:id/api-keys")).toBe(false);
  });
});

describe("end-user apps get self-service and nothing else", () => {
  const holder = p("identity-holder");
  const market = p("tokenization-marketplace");

  it("a wallet cannot onboard people, mint keys, or read the audit log", () => {
    expect(personaAllows(holder, "POST", "/orgs/:id/users")).toBe(false);
    expect(personaAllows(holder, "POST", "/orgs/:id/api-keys")).toBe(false);
    expect(personaAllows(holder, "GET", "/users")).toBe(false);
    expect(personaAllows(holder, "GET", "/audit/verify")).toBe(false);
    expect(personaAllows(holder, "GET", "/events")).toBe(false);
    expect(personaAllows(holder, "GET", "/proposals")).toBe(false);
  });

  it("a wallet answers verification requests but cannot raise or run them", () => {
    // The holder consents; the verifier asks and decides. Collapsing those would
    // let a holder verify themselves.
    expect(personaAllows(holder, "POST", "/verification-requests/:id/consent")).toBe(true);
    expect(personaAllows(holder, "POST", "/verification-requests/:id/reject")).toBe(true);
    expect(personaAllows(holder, "POST", "/verification-requests")).toBe(false);
    expect(personaAllows(holder, "GET", "/verification-requests")).toBe(false);
    expect(personaAllows(holder, "GET", "/verification-requests/:id/verify")).toBe(false);
  });

  it("a wallet cannot issue or revoke anything", () => {
    expect(personaAllows(holder, "POST", "/credential-use-cases/:key/credentials")).toBe(false);
    expect(personaAllows(holder, "POST", "/credentials/:id/revoke")).toBe(false);
  });

  it("the marketplace can buy and sell but cannot mint, freeze or configure", () => {
    expect(personaAllows(market, "GET", "/assets")).toBe(true);
    expect(personaAllows(market, "POST", "/assets/:id/buy")).toBe(true);
    expect(personaAllows(market, "POST", "/assets/:id/listings")).toBe(true);
    expect(personaAllows(market, "POST", "/listings/:id/take")).toBe(true);
    // The refusals: minting an asset and acting on one are the issuer's.
    expect(personaAllows(market, "POST", "/assets")).toBe(false);
    expect(personaAllows(market, "POST", "/assets/:id/actions/:action")).toBe(false);
    expect(personaAllows(market, "POST", "/use-cases")).toBe(false);
    // GET is allowed, deliberately: AssetDetail (opened from a holding's View
    // button) needs the asset's use case to know its compliance/lifecycle
    // rules — without it the page can only ever show a loading skeleton for
    // this persona. Read-only; only POST (define/reconfigure) stays refused.
    expect(personaAllows(market, "GET", "/use-cases")).toBe(true);
    expect(personaAllows(market, "POST", "/cash/credit")).toBe(false);
  });

  it("the marketplace reads its own balance without reaching the credit route", () => {
    // `/cash/balances` is allowed; `/cash` is not — an investor crediting their
    // own settlement account would be minting money.
    expect(personaAllows(market, "GET", "/cash/balances")).toBe(true);
    expect(personaAllows(market, "POST", "/cash/credit")).toBe(false);
  });
});

describe("a verifier checks credentials; it does not issue them", () => {
  const verifier = p("identity-verifier");

  it("runs the presentation exchange", () => {
    expect(personaAllows(verifier, "POST", "/verification-requests")).toBe(true);
    expect(personaAllows(verifier, "GET", "/verification-requests/:id/verify")).toBe(true);
    expect(personaAllows(verifier, "GET", "/credentials/:id/status")).toBe(true);
  });

  it("cannot issue, revoke, or define a programme", () => {
    // The single most likely widening in this file: `/credentials` instead of
    // `/credentials/:id/status` would silently grant revocation.
    expect(personaAllows(verifier, "POST", "/credentials/:id/revoke")).toBe(false);
    expect(personaAllows(verifier, "POST", "/credentials/requests")).toBe(false);
    expect(personaAllows(verifier, "POST", "/credential-use-cases")).toBe(false);
    expect(personaAllows(verifier, "POST", "/credential-use-cases/:key/credentials")).toBe(false);
    // …but it may READ the programme catalogue to know what to ask for.
    expect(personaAllows(verifier, "GET", "/credential-use-cases")).toBe(true);
  });
});

describe("an issuer issues", () => {
  const issuer = p("identity-issuer");

  it("defines programmes, issues against them, and revokes", () => {
    expect(personaAllows(issuer, "POST", "/credential-use-cases")).toBe(true);
    expect(personaAllows(issuer, "POST", "/credential-use-cases/:key/credentials")).toBe(true);
    expect(personaAllows(issuer, "POST", "/credential-use-cases/:key/credentials/batch")).toBe(true);
    expect(personaAllows(issuer, "POST", "/credentials/:id/revoke")).toBe(true);
    expect(personaAllows(issuer, "POST", "/users/:id/revoke-identity")).toBe(true);
  });

  it("does not reach the other product", () => {
    expect(personaAllows(issuer, "GET", "/assets")).toBe(false);
    expect(personaAllows(issuer, "GET", "/use-cases")).toBe(false);
  });
});

describe("the products do not reach each other", () => {
  it.each(personasForDomain("identity").map((x) => x.key))("%s admits no tokenization route", (key) => {
    const persona = p(key);
    for (const route of ["/use-cases", "/assets", "/listings", "/cash/balances", "/me/portfolio", "/analytics"]) {
      expect(personaAllows(persona, "GET", route)).toBe(false);
    }
  });

  it.each(personasForDomain("tokenization").map((x) => x.key))("%s admits no identity-PRODUCT route", (key) => {
    const persona = p(key);
    // NOT `/me/credentials` — that one is deliberately shared. A tokenization
    // staff member has a DID too, minted at onboarding, and can hold
    // credentials like any other subject ("My Credentials" in every persona's
    // pinned nav) — each tokenization staff persona's own `allow` list grants
    // it explicitly, on purpose, while the identity PRODUCT's operator
    // surface (issue/verify/revoke) never does.
    for (const route of ["/credential-use-cases", "/credentials/:id/status", "/verification-requests", "/registry"]) {
      expect(personaAllows(persona, "GET", route)).toBe(false);
    }
  });

  it.each(["tokenization-issuer", "tokenization-admin"])("%s still reaches its OWN /me/credentials — the deliberate exception", (key) => {
    const persona = p(key);
    expect(personaAllows(persona, "GET", "/me/credentials")).toBe(true);
  });

  it("and the machine-to-machine identity oracle is on nobody's edge", () => {
    // Publishing this would let anyone ask whether an arbitrary DID holds a
    // credential — the exact question the peer key exists to gate.
    for (const persona of PERSONAS) expect(personaAllows(persona, "POST", "/identity/assertions")).toBe(false);
  });
});

describe("prefix matching cannot capture a sibling", () => {
  it("/credentials never captures /credential-types or /credential-use-cases", () => {
    const holder = p("identity-holder");
    // The holder has `/credentials/:id/status`; none of these are children of it.
    expect(personaAllows(holder, "GET", "/credential-types")).toBe(false);
    expect(personaAllows(holder, "GET", "/credential-use-cases")).toBe(false);
  });

  it("/me does not swallow /me/portfolio", () => {
    // Every persona has baseline `GET /me`. If that matched on raw string prefix
    // rather than segment boundary, a wallet would read asset holdings.
    const holder = p("identity-holder");
    expect(personaAllows(holder, "GET", "/me")).toBe(true);
    expect(personaAllows(holder, "GET", "/me/portfolio")).toBe(false);
  });
});

describe("personaMethodsFor — what the edge's method guard emits", () => {
  it("narrows to the methods actually granted", () => {
    expect(personaMethodsFor(p("tokenization-marketplace"), "/assets")).toEqual(["GET"]);
    // GET too, because the read rule on `/assets` covers every child — an
    // investor reads asset detail, tokens and trades through those subpaths.
    // The POST is what `/assets/:id/buy` adds.
    expect(personaMethodsFor(p("tokenization-marketplace"), "/assets/:id/buy")).toEqual(["GET", "POST"]);
  });

  it("returns nothing for a route the persona does not have", () => {
    expect(personaMethodsFor(p("identity-holder"), "/orgs/:id/members")).toEqual([]);
  });
});
