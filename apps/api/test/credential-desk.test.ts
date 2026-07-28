import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

describe("cross-type use-case key uniqueness", () => {
  it("rejects a credential use case whose key is an existing tokenization use case", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const list = await app.inject({ method: "GET", url: `${V1}/use-cases`, headers: auth(admin) });
    expect(list.statusCode).toBe(200);
    const seeded = (list.json() as { key: string }[])[0];
    expect(seeded?.key).toBeTruthy();

    const r = await app.inject({
      method: "POST",
      url: `${V1}/credential-use-cases`,
      headers: auth(admin),
      payload: {
        key: seeded.key,
        name: "clash",
        description: "d",
        credentialTypes: [{ name: "T", title: "T", claimSchema: { type: "object", required: ["a"], properties: { a: { type: "string" } } }, requiredApprovals: 1 }],
        issuer: { kind: "platform" },
        holderPolicy: { who: "any-onboarded" },
        verifier: { kind: "any" },
      },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("KEY_TAKEN");
  });
});

describe("GET /me reports useCaseDomain", () => {
  it("has a useCaseDomain property for a platform admin (unscoped -> null)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const me = await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(admin) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toHaveProperty("useCaseDomain");
    expect(me.json().useCaseDomain).toBeNull();
  });
});
