import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

const DEF = {
  key: "kyc-onboarding", name: "KYC Onboarding", description: "Onboarding KYC.",
  credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365,
    claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
};

describe("credential use-case config API", () => {
  it("PlatformAdmin creates → lists → gets → updates", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const c = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
    expect(c.statusCode).toBe(201);
    expect(c.json().credentialTypes[0].name).toBe("KycCredential");
    const list = await app.inject({ method: "GET", url: `${V1}/credential-use-cases`, headers: auth(admin) });
    expect((list.json() as unknown[]).some((u: { key: string }) => u.key === "kyc-onboarding")).toBe(true);
    const got = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/kyc-onboarding`, headers: auth(admin) });
    expect(got.json().name).toBe("KYC Onboarding");
    const upd = await app.inject({ method: "PATCH", url: `${V1}/credential-use-cases/kyc-onboarding`, headers: auth(admin), payload: { ...DEF, name: "KYC v2" } });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().name).toBe("KYC v2");
  });
  it("rejects a duplicate key and an invalid definition", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
    const dup = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
    expect(dup.statusCode).toBe(409);
    // key collides with an existing TOKEN use case too
    const tokenKeyDup = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: { ...DEF, key: "invoice-tokenization" } });
    expect(tokenKeyDup.statusCode).toBe(409);
    const bad = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: { ...DEF, key: "no-types", credentialTypes: [] } });
    expect(bad.statusCode).toBe(400);
  });
  it("is PlatformAdmin-only to author; templates + reads are open to authed users", async () => {
    const app = await buildTestApp();
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const forbidden = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(issuer), payload: DEF });
    expect(forbidden.statusCode).toBe(403);
    const tpl = await app.inject({ method: "GET", url: `${V1}/credential-templates`, headers: auth(issuer) });
    expect(tpl.statusCode).toBe(200);
    expect(Object.keys(tpl.json())).toContain("KycCredential");
  });
});
