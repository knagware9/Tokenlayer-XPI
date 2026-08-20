/**
 * WHO OWNS WHICH TABLE, AND WHAT STOPS A DEPLOYMENT WRITING SOMEONE ELSE'S.
 *
 * The route gate (`route-domains.test.ts`) proves a deployment does not ANSWER
 * for a product it does not sell. That is one door. This suite covers the
 * other: a deployment must not WRITE that product's data through a route that
 * IS served — a proposal executor reached via shared `/proposals/:id/approve`,
 * an onboarding call that carries a wallet address, boot.
 *
 * Three things are pinned:
 *
 *   1. EVERY MODEL IS CLASSIFIED. Parsed out of `schema.prisma`, not out of a
 *      list someone maintains alongside it, so a new table cannot be added
 *      without a decision about who owns it.
 *   2. THE GUARD REFUSES, and refuses as a REJECTED PROMISE — the existing
 *      cross-namespace lookups are written as `.get(k).catch(() => null)`, and
 *      a synchronous throw would fire before `.catch` was ever attached.
 *   3. IT IS INVISIBLE WHEN BOTH PRODUCTS ARE SOLD. That is the default
 *      deployment and it must carry no proxy, no wrapper, nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyModel,
  guardRepositories,
  guardRepository,
  MODEL_DOMAINS,
  REPOSITORY_MODELS,
} from "../src/persistence/model-domains.js";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

const BOTH = ["tokenization", "identity"];

/** Model names declared in the Prisma schema — the authority this table answers to. */
function modelsInSchema(): string[] {
  const schema = readFileSync(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "utf8");
  return [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!);
}

describe("every table has an owning product", () => {
  it("classifies exactly the models the schema declares — no more, no fewer", () => {
    // BOTH directions on purpose. A missing entry is the dangerous one (an
    // unowned table), but a stale one is how the table stops describing the
    // schema and starts describing what it used to be.
    expect([...new Set(modelsInSchema())].sort()).toEqual(Object.keys(MODEL_DOMAINS).sort());
  });

  it("the schema's own `/// domain:` annotations agree with the table, model for model", () => {
    // The annotation is what someone reading `schema.prisma` sees, and it is
    // the only place the split is visible where the tables actually are. Making
    // it load-bearing rather than decorative is the whole point: a comment that
    // nothing checks is a comment that will eventually be wrong, and this one
    // would be wrong about which database a table belongs in.
    const schema = readFileSync(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "utf8");
    const annotated = Object.fromEntries(
      [...schema.matchAll(/^\/\/\/ domain:\s*(\w+)\s*\nmodel\s+(\w+)\s*\{/gm)].map((m) => [m[2]!, m[1]!]),
    );
    expect(annotated).toEqual(MODEL_DOMAINS);
  });

  it("refuses to guess for a model nobody classified", () => {
    expect(() => classifyModel("SomeNewTable")).toThrow(/not classified by product domain/);
  });

  it("every repository names a classified model", () => {
    for (const [key, model] of Object.entries(REPOSITORY_MODELS)) {
      expect(() => classifyModel(model), `${key} → ${model}`).not.toThrow();
    }
  });

  it("every repository key is a real dependency — a rename cannot silently unguard one", async () => {
    const h = await buildTestAppWithRepos();
    try {
      for (const key of Object.keys(REPOSITORY_MODELS)) {
        expect(h.deps, `AppDeps has no '${key}'`).toHaveProperty(key);
      }
    } finally {
      await h.app.close();
    }
  });

  it("keeps Credential SHARED, and says why in one place", () => {
    // Pinned because it is the classification most likely to be "tidied" into
    // identity by someone reading only the name. Organization membership is
    // built on VCs and is added through a SHARED route on every deployment;
    // moving this would mean a tokenization deployment could not add an org
    // member without a round trip to the identity service.
    expect(MODEL_DOMAINS.Credential).toBe("shared");
    // The mirror of the same boundary: a wallet is tokenization's concept, and
    // only a DID ever crosses to identity (see identity-assertions.ts).
    expect(MODEL_DOMAINS.Account).toBe("tokenization");
  });
});

describe("the repository guard", () => {
  const repo = {
    async list() { return ["real"]; },
    async get() { return { id: "real" }; },
    async create() { return { id: "created" }; },
    notAFunction: 42,
  };

  it("is the identity function when this deployment owns the table", () => {
    // Not "behaves the same" — literally the same object. A both-products
    // deployment must not pay for, or be able to be surprised by, a proxy.
    expect(guardRepository(repo, "Asset", BOTH)).toBe(repo);
    expect(guardRepository(repo, "Credential", ["tokenization"])).toBe(repo); // shared
  });

  it("REJECTS rather than throws, so an existing .catch() still catches it", async () => {
    const guarded = guardRepository(repo, "Asset", ["identity"]);
    // If this threw synchronously, `.catch` would never be attached and the
    // expression below would blow up instead of resolving — which is exactly
    // how `events.ts` consults the other namespace today.
    await expect(guarded.get().catch(() => null)).resolves.toBeNull();
  });

  it("refuses every operation, read or write, naming the product and the table", async () => {
    const guarded = guardRepository(repo, "Asset", ["identity"]);
    for (const call of [() => guarded.list(), () => guarded.get(), () => guarded.create()]) {
      await expect(call()).rejects.toMatchObject({
        name: "PolicyError",
        code: "DOMAIN_NOT_ENABLED",
        details: { domain: "tokenization", model: "Asset" },
      });
    }
  });

  it("does not answer 'empty' — the same mistake as a false verdict from an unreachable identity service", async () => {
    const guarded = guardRepository(repo, "Asset", ["identity"]);
    // An empty list would read to the caller exactly like "this deployment has
    // no assets", which is a different fact from "this deployment does not keep
    // assets" and sends an investigation to the wrong place.
    await expect(guarded.list()).rejects.toThrow();
  });

  it("leaves non-function properties alone", () => {
    expect(guardRepository(repo, "Asset", ["identity"]).notAFunction).toBe(42);
  });

  it("guards each repository by its own table, not by the object it sits on", () => {
    const deps = { assets: { ...repo }, credentials: { ...repo }, verificationRequests: { ...repo }, jwtSecret: "x" };
    const guarded = guardRepositories(deps, ["tokenization"]);
    expect(guarded.assets).toBe(deps.assets); // owned
    expect(guarded.credentials).toBe(deps.credentials); // shared
    expect(guarded.verificationRequests).not.toBe(deps.verificationRequests); // identity's
    expect(guarded.jwtSecret).toBe("x"); // untouched, not a repository
  });
});

describe("the guard is wired into every app, and it found a real bug on the way in", () => {
  it("buildApp installs it over the deps it was handed", () => {
    // Asserted at the SOURCE, the same way the route gate's installation is,
    // because the alternative — inspecting a built app — cannot see inside
    // `buildApp`'s closure, and a test that merely called `guardRepositories`
    // itself would pass on a build that never wired it up.
    const src = readFileSync(fileURLToPath(new URL("../src/app.ts", import.meta.url)), "utf8");
    expect(src).toContain("guardRepositories(rawDeps, rawDeps.enabledDomains)");
  });

  /** POST /auth/login is SHARED — it exists on every deployment. */
  async function signIn(domains: string[]) {
    const h = await buildTestAppWithRepos({ enabledDomains: domains });
    try {
      const res = await h.app.inject({
        method: "POST", url: `${V1}/auth/login`,
        payload: { email: "admin@tokenlayer.dev", password: "admin123" },
      });
      return res;
    } finally {
      await h.app.close();
    }
  }

  it("an identity-only deployment can still sign in, and reports no wallet", async () => {
    // THE BUG THE GUARD FOUND. `admin@tokenlayer.dev` is seeded WITH a linked
    // account, and login decorated the session by reading it — `Account` is
    // tokenization's table. On an identity-only deployment that is a table this
    // instance does not keep, so sign-in itself failed: not a corner case, but
    // every user carrying an accountId, which is every user in a database
    // migrated from a combined deployment.
    const res = await signIn(["identity"]);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.walletAddress).toBeNull();
  }, 30_000);

  it("a tokenization-only deployment signs in and lists its own catalogue — the mirror direction", async () => {
    // `resolveUseCaseDomain` runs on login and listed BOTH catalogues, so the
    // same class of failure existed pointing the other way: a tokenization-only
    // deployment reading the credential catalogue it does not keep.
    const h = await buildTestAppWithRepos({ enabledDomains: ["tokenization"] });
    try {
      const token = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
      expect(token, "sign-in must work on a tokenization-only deployment").toBeTruthy();
      const list = await h.app.inject({ method: "GET", url: `${V1}/use-cases`, headers: auth(token) });
      expect(list.statusCode).toBe(200);
      // …while the other product's catalogue is not served here at all.
      const creds = await h.app.inject({ method: "GET", url: `${V1}/credential-use-cases`, headers: auth(token) });
      expect(creds.statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  }, 30_000);

  it("a both-products deployment reports the wallet exactly as before", async () => {
    // The positive control: without it the assertion above would pass just as
    // happily on a build that had stopped reporting wallets to anyone.
    const res = await signIn(BOTH);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 30_000);
});
