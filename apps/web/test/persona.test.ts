/**
 * SIX APPS OUT OF ONE BUNDLE.
 *
 * The failure this guards against is not a security one — the edge container and
 * the API both refuse what the UI wrongly offers. It is that a container ships
 * with an empty sidebar and a landing view that does not exist, and the only
 * symptom is a blank frame nobody can explain. So the cases below are mostly
 * about what SURVIVES narrowing, and about the two ways it can go silently
 * wrong: an unknown persona key, and a landing view the user's role removed.
 */
import { describe, expect, it } from "vitest";
import {
  landingView, narrowToPersona, personaConfigError, personaTitle, resolvePersona,
} from "../src/lib/shared/persona.js";

const nav = (...ids: string[]) => ids.map((id) => ({ id, label: id }));

describe("resolvePersona", () => {
  it("resolves a known key", () => {
    expect(resolvePersona("identity-holder")?.label).toBe("Wallet");
    expect(resolvePersona("tokenization-marketplace")?.domain).toBe("tokenization");
  });

  it("treats unset, empty and whitespace as the full application", () => {
    // The single-container and two-container topologies build with no persona,
    // and must keep behaving exactly as they always have.
    expect(resolvePersona(undefined)).toBeNull();
    expect(resolvePersona("")).toBeNull();
    expect(resolvePersona("   ")).toBeNull();
  });

  it("falls back to the FULL app on an unknown key, and says so", () => {
    // Not an empty app: a typo in a compose file would otherwise ship a
    // container that renders nothing, with no clue as to why.
    expect(resolvePersona("identity-holdr")).toBeNull();
    const err = personaConfigError("identity-holdr");
    expect(err).toContain("identity-holdr");
    expect(err).toContain("identity-holder");     // names the valid keys
  });

  it("reports no error for a valid or absent persona", () => {
    expect(personaConfigError("identity-issuer")).toBeNull();
    expect(personaConfigError(undefined)).toBeNull();
  });
});

describe("narrowToPersona", () => {
  const holder = resolvePersona("identity-holder");

  it("keeps only the surfaces the persona serves", () => {
    const items = nav("credentials", "profile", "logout", "users", "audit", "assets");
    expect(narrowToPersona(items, holder).map((i) => i.id)).toEqual(["credentials", "profile", "logout"]);
  });

  it("is an INTERSECTION — it never adds a surface the caller did not offer", () => {
    // The caller's list is already filtered by role and enabled domains. If this
    // could add, the wallet would render buttons that die at the edge.
    const items = nav("profile");
    expect(narrowToPersona(items, holder).map((i) => i.id)).toEqual(["profile"]);
  });

  it("passes everything through when there is no persona", () => {
    const items = nav("dashboard", "assets", "users");
    expect(narrowToPersona(items, null).map((i) => i.id)).toEqual(["dashboard", "assets", "users"]);
  });

  it("returns a copy, so the caller's array is not aliased", () => {
    const items = nav("profile");
    expect(narrowToPersona(items, null)).not.toBe(items);
  });
});

describe("landingView", () => {
  const issuer = resolvePersona("identity-issuer");

  it("opens on the persona's own default when it survived", () => {
    expect(landingView(nav("identity", "audit", "profile"), issuer, "dashboard")).toBe("identity");
  });

  it("falls back to the first real item when the default did not survive", () => {
    // A Verifier-role user signing in to the issuer console has no `identity`
    // surface; opening there would render an empty frame.
    expect(landingView(nav("audit", "profile"), issuer, "dashboard")).toBe("audit");
  });

  it("skips logout and back when choosing a fallback", () => {
    // Landing on "logout" would sign the user out as the app opened.
    expect(landingView(nav("back", "logout", "profile"), issuer, "dashboard")).toBe("profile");
  });

  it("uses the caller's fallback when nothing survived at all", () => {
    expect(landingView([], issuer, "dashboard")).toBe("dashboard");
  });

  it("leaves the fallback alone when there is no persona", () => {
    expect(landingView(nav("assets"), null, "dashboard")).toBe("dashboard");
  });
});

describe("personaTitle", () => {
  it("names the app, or keeps the product name when unset", () => {
    expect(personaTitle(resolvePersona("tokenization-marketplace"), "XI Tokenize")).toBe("Marketplace");
    expect(personaTitle(null, "XI Tokenize")).toBe("XI Tokenize");
  });
});

describe("every persona's own surfaces survive its own narrowing", () => {
  // A persona whose surfaces list disagreed with its default view would ship an
  // app that opens nowhere. personas.test.ts pins that in core; this pins the
  // web side actually honours it.
  it.each(["identity-issuer", "identity-verifier", "identity-holder",
    "tokenization-issuer", "tokenization-marketplace", "tokenization-admin"])("%s", (key) => {
    const persona = resolvePersona(key)!;
    const items = nav(...persona.surfaces);
    expect(narrowToPersona(items, persona)).toHaveLength(persona.surfaces.length);
    expect(landingView(items, persona, "nowhere")).toBe(persona.defaultView);
  });
});

describe("which console a persona app renders", () => {
  // The bug: the shell was chosen by ROLE, so a PlatformAdmin signing in to the
  // Marketplace got the platform console's nav intersected down to two entries.
  // The container is the investor app whoever signs in.
  it("the two public-facing apps are self-service; the four staff apps are consoles", () => {
    expect(resolvePersona("tokenization-marketplace")?.shell).toBe("self-service");
    expect(resolvePersona("identity-holder")?.shell).toBe("self-service");
    for (const key of ["identity-issuer", "identity-verifier", "tokenization-issuer", "tokenization-admin"]) {
      expect(resolvePersona(key)?.shell, key).toBe("console");
    }
  });

  it("a Wallet lands on its credentials, not on a portfolio it cannot load", () => {
    // The self-service branch offers portfolio/offerings/transactions. For the
    // Wallet none of those survive narrowing, and opening on one would render a
    // panel whose data the holder edge refuses.
    const holder = resolvePersona("identity-holder");
    const investorNav = nav("portfolio", "offerings", "transactions", "profile", "credentials", "logout");
    expect(narrowToPersona(investorNav, holder).map((i) => i.id)).toEqual(["profile", "credentials", "logout"]);
    expect(landingView(narrowToPersona(investorNav, holder), holder, "portfolio")).toBe("credentials");
  });

  it("a Marketplace keeps the whole investor surface", () => {
    const market = resolvePersona("tokenization-marketplace");
    const investorNav = nav("portfolio", "offerings", "transactions", "profile", "credentials", "logout");
    // `credentials` is identity's and its edge refuses it — so it must NOT survive.
    expect(narrowToPersona(investorNav, market).map((i) => i.id))
      .toEqual(["portfolio", "offerings", "transactions", "profile", "logout"]);
    expect(landingView(narrowToPersona(investorNav, market), market, "portfolio")).toBe("portfolio");
  });
});
