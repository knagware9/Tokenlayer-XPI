/**
 * `GET /me/verification-requests` is gated on `verifications:read`, but its
 * `eligibleCredentials[].claims` field returns full credential contents — the
 * same content `GET /me/credentials` returns, and THAT route is gated on the
 * different scope `credentials:read` (see shared.ts). Without a check here, a
 * caller (e.g. a machine principal) holding only `verifications:read` reads
 * full claims it could not read through `GET /me/credentials`, widening what
 * that scope grants.
 *
 * `claims` must therefore only appear when the caller also holds
 * `credentials:read`, or when the caller is a human session (no API key at
 * all — see `machinePrincipal`/`scopeAllows`'s use in `decidableByPrincipal`
 * in shared.ts for the precedent this follows).
 */
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/shared/api-keys.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";

const DEF = {
  key: "ec-domicile", name: "Eligible Credentials Domicile",
  credentialTypes: [{
    name: "DomicileCredential", title: "Domicile", validityDays: 365, requiredApprovals: 1,
    claimSchema: { type: "object", required: ["holderName"], properties: { holderName: { type: "string" } } },
  }],
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
};

async function setup() {
  const anchor = new FakeAnchor();
  const h = await buildTestAppWithRepos({ registry: fakeRegistry(anchor) });
  const { app } = h;
  const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
  expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF })).statusCode).toBe(201);

  const holderOrg = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `EC Holder Co ${Date.now()}`, orgType: "corporate" } })).json();
  const holderEmail = `ec.holder.${Date.now()}@x.io`;
  const holderMk = await app.inject({ method: "POST", url: `${V1}/orgs/${holderOrg.id}/users`, headers: auth(admin), payload: { email: holderEmail, password: "secret1", role: "Issuer" } });
  expect(holderMk.statusCode).toBe(201);
  const holder = holderMk.json() as { id: string; did: string };
  const holderToken = await loginAs(app, holderEmail, "secret1");

  const issued = await app.inject({
    method: "POST", url: `${V1}/credential-use-cases/ec-domicile/credentials`, headers: auth(admin),
    payload: { credentialType: "DomicileCredential", subjectUserId: holder.id, claims: { holderName: "Ramesh Kumar" } },
  });
  expect(issued.statusCode).toBe(202);
  expect((await app.inject({ method: "POST", url: `${V1}/proposals/${issued.json().proposal.id}/approve`, headers: auth(admin2), payload: {} })).statusCode).toBe(200);

  const verifierOrg = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `EC Verifier Co ${Date.now()}`, orgType: "corporate" } })).json();
  const verifierEmail = `ec.verifier.${Date.now()}@x.io`;
  const vMk = await app.inject({ method: "POST", url: `${V1}/orgs/${verifierOrg.id}/users`, headers: auth(admin), payload: { email: verifierEmail, password: "secret1", role: "OrgAdmin" } });
  expect(vMk.statusCode).toBe(201);
  const verifierToken = await loginAs(app, verifierEmail, "secret1");
  const created = await app.inject({
    method: "POST", url: `${V1}/verification-requests`, headers: auth(verifierToken),
    payload: { holderDid: holder.did, requestedTypes: ["DomicileCredential"], purpose: "check", credentialUseCaseKey: "ec-domicile" },
  });
  expect(created.statusCode).toBe(201);

  return { h, holder, holderToken };
}

async function keyFor(h: TestAppHandle, userId: string, scopes: string[]): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 10);
  const minted = await mintSecret(4);
  await h.apiKeys.create({ orgId: null, userId, name: `key ${tag}`, prefix: minted.prefix, secretHash: minted.hash, scopes, expiresAt: null, createdBy: "test" });
  return minted.secret;
}

function inbox(h: TestAppHandle, token: string) {
  return h.app.inject({ method: "GET", url: `${V1}/me/verification-requests`, headers: auth(token) });
}

describe("GET /me/verification-requests eligibleCredentials.claims is scoped", () => {
  it("a key holding only verifications:read does NOT receive claims", async () => {
    const { h, holder } = await setup();
    const key = await keyFor(h, holder.id, ["verifications:read"]);
    const res = await inbox(h, key);
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ eligibleCredentials: Array<Record<string, unknown>> }>;
    const withEligible = rows.filter((r) => r.eligibleCredentials.length > 0);
    expect(withEligible.length).toBeGreaterThan(0);
    for (const r of withEligible) for (const c of r.eligibleCredentials) expect(c).not.toHaveProperty("claims");
  });

  it("a key holding verifications:read AND credentials:read DOES receive claims", async () => {
    const { h, holder } = await setup();
    const key = await keyFor(h, holder.id, ["verifications:read", "credentials:read"]);
    const res = await inbox(h, key);
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ eligibleCredentials: Array<{ claims?: Record<string, unknown> }> }>;
    const eligible = rows.flatMap((r) => r.eligibleCredentials).find((c) => c.claims);
    expect(eligible?.claims).toMatchObject({ holderName: "Ramesh Kumar" });
  });

  it("a human session (JWT, no API key) DOES receive claims", async () => {
    const { h, holderToken } = await setup();
    const res = await inbox(h, holderToken);
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ eligibleCredentials: Array<{ claims?: Record<string, unknown> }> }>;
    const eligible = rows.flatMap((r) => r.eligibleCredentials).find((c) => c.claims);
    expect(eligible?.claims).toMatchObject({ holderName: "Ramesh Kumar" });
  });
});
