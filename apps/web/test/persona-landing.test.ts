/**
 * A LANDING PAGE IS A PROMISE, AND THE EDGE ENFORCES IT.
 *
 * The interesting failure is not a typo. It is a page that offers its reader
 * something the container refuses — "issue credentials" on the Wallet's front
 * door, or an organization signup on an app whose audience is individuals. The
 * reader clicks, the edge 404s, and the product looks broken rather than narrow.
 */
import { describe, expect, it } from "vitest";
import { landingFor } from "../src/lib/persona-landing.js";
import { resolvePersona } from "../src/lib/persona.js";
import { PERSONAS } from "../src/personas.js";

describe("every persona has a front door that names itself", () => {
  it.each(PERSONAS.map((p) => p.key))("%s", (key) => {
    const copy = landingFor(resolvePersona(key));
    expect(copy).not.toBeNull();
    expect(copy!.product).toMatch(/^XI /);
    expect(copy!.headline.length).toBeGreaterThan(20);
    expect(copy!.blurb.length).toBeGreaterThan(80);
    expect(copy!.does).toHaveLength(3);
    expect(copy!.cta.length).toBeGreaterThan(5);
  });

  it("names the right PRODUCT for each domain", () => {
    // The bug this replaces: identity containers advertising XI Tokenize.
    for (const p of PERSONAS) {
      const copy = landingFor(resolvePersona(p.key))!;
      expect(copy.product).toBe(p.domain === "identity" ? "XI Identity" : "XI Tokenize");
    }
  });

  it("a build with no persona has no persona landing — it keeps the shared homepage", () => {
    expect(landingFor(null)).toBeNull();
  });
});

describe("no page promises what its own edge refuses", () => {
  it("the two individual-facing apps do not invite an organization to register", () => {
    // The Wallet and the Marketplace are for people, and neither edge carries
    // the roster routes an org signup leads to.
    expect(landingFor(resolvePersona("identity-holder"))!.publicSignup).toBe(false);
    expect(landingFor(resolvePersona("tokenization-marketplace"))!.publicSignup).toBe(false);
  });

  it("the wallet's copy never offers to issue or verify", () => {
    const copy = landingFor(resolvePersona("identity-holder"))!;
    const text = [copy.headline, copy.blurb, ...copy.does].join(" ").toLowerCase();
    expect(text).not.toContain("issue a credential");
    expect(text).not.toContain("revoke");
    // It DOES describe consenting — the holder's half of verification.
    expect(text).toContain("consent");
  });

  it("the marketplace's copy never offers to mint or configure", () => {
    const copy = landingFor(resolvePersona("tokenization-marketplace"))!;
    const text = [copy.headline, copy.blurb, ...copy.does].join(" ").toLowerCase();
    expect(text).not.toContain("mint");
    expect(text).not.toContain("configure a use case");
    expect(text).toContain("buy");
  });

  it("the verifier's copy never offers to issue", () => {
    const copy = landingFor(resolvePersona("identity-verifier"))!;
    const text = [copy.headline, copy.blurb, ...copy.does].join(" ").toLowerCase();
    expect(text).not.toContain("issue, reissue");
    expect(text).toContain("verif");
  });
});
