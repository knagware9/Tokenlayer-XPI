/**
 * THE PRODUCT BOUNDARY IS A BOUNDARY, NOT A MENU.
 *
 * `ENABLED_DOMAINS` reached exactly one route before this — `GET /config`, the
 * one the console asks which navigation to draw. A deployment sold as
 * Tokenization-only still answered every identity route: the credential
 * catalogue, the wallet, issuance, the verification exchange. These tests are
 * the difference between hiding a menu and not serving a product.
 *
 * Three things are pinned here:
 *   1. a disabled product's routes are GONE (404, distinct code) while the
 *      other product and the shared platform still work;
 *   2. turning a product off does not tell an ANONYMOUS caller that you did —
 *      the 401 an unauthenticated request always got is the answer it still
 *      gets, so the gate is not a free oracle for which products you run;
 *   3. the routes that sit under a SHARED prefix are classified by what they
 *      are rather than where they live: `/me/credentials` is identity,
 *      `/me/portfolio` is tokenization, `/me` itself is shared. That is where a
 *      prefix-based split would quietly get it wrong.
 *
 * The anti-drift control is the BOOT, not this file: an unclassified route
 * throws from the onRoute hook in src/app.ts, so a new route cannot reach
 * production unclassified even if nobody remembers to add a test for it. The
 * last block below drives that refusal directly.
 */
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyDomainGate, classifyRoute, routeEnabled } from "../src/http/route-domains.js";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

async function adminOn(enabledDomains: string[]): Promise<{ app: FastifyInstance; token: string }> {
  const app = await buildTestApp({ enabledDomains });
  return { app, token: await loginAs(app, "admin@tokenlayer.dev", "admin123") };
}
const get = (app: FastifyInstance, url: string, token?: string) =>
  app.inject({ method: "GET", url: `${V1}${url}`, ...(token ? { headers: auth(token) } : {}) });

describe("a tokenization-only deployment", () => {
  it("does not serve identity routes, and still serves its own and the shared platform", async () => {
    const { app, token } = await adminOn(["tokenization"]);

    // Identity — gone. Not 403: this instance does not have the product at all.
    for (const url of ["/credential-use-cases", "/credential-types", "/verification-requests", "/me/credentials", "/registry"]) {
      const res = await get(app, url, token);
      expect(res.statusCode, `${url} should be absent`).toBe(404);
      expect(res.json().error, `${url} should say WHY it is absent`).toBe("DOMAIN_NOT_ENABLED");
    }

    // Tokenization — the product this deployment sells.
    for (const url of ["/use-cases", "/assets", "/analytics", "/me/portfolio"]) {
      expect((await get(app, url, token)).statusCode, `${url} should work`).toBe(200);
    }

    // Shared — without these there is no login, no tenant, no approval queue.
    for (const url of ["/me", "/orgs", "/users", "/proposals", "/chains", "/config"]) {
      expect((await get(app, url, token)).statusCode, `${url} should work`).toBe(200);
    }
    await app.close();
  });

  it("still reports its domains truthfully on /config", async () => {
    const { app, token } = await adminOn(["tokenization"]);
    expect((await get(app, "/config", token)).json().domains).toEqual(["tokenization"]);
    await app.close();
  });

  it("hides the absent product from the OpenAPI document", async () => {
    // A published surface that advertises routes which cannot answer is a lie
    // told to every integrator who reads it.
    const { app } = await adminOn(["tokenization"]);
    const paths = Object.keys((app.swagger() as { paths: Record<string, unknown> }).paths);
    expect(paths.some((p) => p.includes("/credential-use-cases"))).toBe(false);
    expect(paths.some((p) => p.includes("/use-cases"))).toBe(true);
    await app.close();
  });
});

describe("an identity-only deployment", () => {
  it("is the mirror image — identity works, tokenization is gone", async () => {
    const { app, token } = await adminOn(["identity"]);

    for (const url of ["/credential-use-cases", "/credential-types", "/verification-requests"]) {
      expect((await get(app, url, token)).statusCode, `${url} should work`).toBe(200);
    }
    for (const url of ["/use-cases", "/assets", "/analytics", "/me/portfolio"]) {
      const res = await get(app, url, token);
      expect(res.statusCode, `${url} should be absent`).toBe(404);
      expect(res.json().error).toBe("DOMAIN_NOT_ENABLED");
    }
    expect((await get(app, "/me", token)).statusCode).toBe(200);
    await app.close();
  });
});

describe("turning a product off is not an oracle", () => {
  it("an anonymous caller gets the same 401 it always got, not a 404 that leaks the deployment's shape", async () => {
    const { app } = await adminOn(["tokenization"]);
    // Same route, no credential: the auth chain still runs first, so the answer
    // is indistinguishable from the same request against a full deployment.
    expect((await get(app, "/credential-use-cases")).statusCode).toBe(401);
    expect((await get(app, "/use-cases")).statusCode).toBe(401);
    await app.close();
  });
});

describe("both domains enabled — the default — changes nothing", () => {
  it("serves every product, so the gate is inert on a full deployment", async () => {
    const { app, token } = await adminOn(["tokenization", "identity"]);
    for (const url of ["/credential-use-cases", "/use-cases", "/me", "/verification-requests", "/analytics"]) {
      expect((await get(app, url, token)).statusCode, url).toBe(200);
    }
    await app.close();
  });
});

describe("classification of the routes that share a prefix", () => {
  // These are the ones a naive first-segment split gets wrong, which is exactly
  // why the classifier matches the LONGEST prefix instead.
  it.each([
    ["/me", "shared"],
    ["/me/login-keys", "shared"],
    ["/me/portfolio", "tokenization"],
    ["/me/activity", "tokenization"],
    ["/me/credentials", "identity"],
    ["/me/credentials/:id/accept", "identity"],
    ["/me/verification-requests", "identity"],
    ["/orgs", "shared"],
    ["/orgs/:id/webhooks", "shared"],
    ["/orgs/:id/wallet", "identity"],
    ["/orgs/:id/credentials", "identity"],
    ["/users", "shared"],
    ["/users/:id/identity/verify", "identity"],
    ["/users/:id/revoke-identity", "identity"],
    ["/credential-types", "identity"],
    ["/chains", "shared"],
    ["/auth/qr/start", "shared"],
  ])("%s is %s", (url, expected) => {
    expect(classifyRoute(url)).toBe(expected);
  });

  it("classifies the same whether or not the mount prefix is present", () => {
    expect(classifyRoute("/api/v1/me/credentials")).toBe("identity");
    expect(classifyRoute("/me/credentials")).toBe("identity");
  });

  it("shared routes are enabled under every deployment shape", () => {
    for (const enabled of [["tokenization"], ["identity"], ["tokenization", "identity"], []]) {
      expect(routeEnabled("/me", enabled), JSON.stringify(enabled)).toBe(true);
      expect(routeEnabled("/auth/login", enabled)).toBe(true);
    }
  });

  it("an UNKNOWN route is not enabled by anything — no default-allow", () => {
    // The counterpart of the boot check: were a rule ever deleted, the
    // predicate must not start answering "sure, serve it".
    expect(classifyRoute("/some-route-nobody-classified")).toBeUndefined();
    expect(routeEnabled("/some-route-nobody-classified", ["tokenization", "identity"])).toBe(false);
  });
});

describe("an unclassified route refuses to register", () => {
  // `applyDomainGate` is the exact function app.ts installs as its onRoute hook
  // — asserted below — so this drives the real gate rather than a copy of it.
  // The WIRING (that every route goes through it) is what the behavioural tests
  // above prove: identity routes could not 404 unless the hook had run.
  const route = (url: string) => ({ method: "GET", url, schema: {}, handler: async () => ({}) });

  it("throws, naming the route and where to fix it, instead of quietly serving it", () => {
    expect(() => applyDomainGate(route("/brand-new-thing"), ["tokenization", "identity"]))
      .toThrowError(/\/brand-new-thing is not classified by product domain/);
    expect(() => applyDomainGate(route("/brand-new-thing"), ["tokenization", "identity"]))
      .toThrowError(/route-domains\.ts/);
  });

  it("leaves an enabled route completely untouched", () => {
    const r = route("/use-cases");
    const handler = r.handler;
    applyDomainGate(r, ["tokenization"]);
    expect(r.handler).toBe(handler);
    expect(r.schema).toEqual({});
  });

  it("replaces a disabled route's handler and hides it from the document", () => {
    const r = route("/credential-use-cases");
    const handler = r.handler;
    applyDomainGate(r, ["tokenization"]);
    expect(r.handler).not.toBe(handler);
    expect((r.schema as { hide?: boolean }).hide).toBe(true);
  });

  it("is the function app.ts actually installs — not a parallel implementation", () => {
    const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(appSource).toMatch(/addHook\("onRoute",\s*\(route\)\s*=>\s*applyDomainGate\(route, deps\.enabledDomains\)\)/);
  });
});
