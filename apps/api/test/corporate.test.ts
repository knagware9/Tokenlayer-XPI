import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1 } from "./helpers.js";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";

const registerBody = {
  company: { name: "Globex Trade Pvt Ltd", orgType: "corporate", registrationId: "U12345", jurisdiction: "IN" },
  admin: { name: "Rhea Kapoor", email: "rhea@globex.dev", password: "corp-secret-1" },
};

describe("corporate self-registration", () => {
  it("creates a pending org (DID minted, not on-chain) + a pending admin who cannot log in", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
    const orgId = res.json().organizationId;
    expect(typeof orgId).toBe("string");
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } });
    expect(login.statusCode).toBe(401);
  });
  it("rejects a verifier orgType and duplicate name/registration/email", async () => {
    const app = await buildTestApp();
    const verifier = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, company: { ...registerBody.company, orgType: "verifier" } } });
    expect(verifier.statusCode).toBe(400);
    await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody });
    const dupName = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, admin: { ...registerBody.admin, email: "other@x.dev" } } });
    expect(dupName.statusCode).toBe(409);
    const dupEmail = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, company: { ...registerBody.company, name: "Different Co", registrationId: "U999" } } });
    expect(dupEmail.statusCode).toBe(409);
    const dupRegistrationId = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, company: { ...registerBody.company, name: "Yet Another Co" }, admin: { ...registerBody.admin, email: "third@x.dev" } } });
    expect(dupRegistrationId.statusCode).toBe(409);
  });
});

async function registerAndId(app: import("fastify").FastifyInstance) {
  const res = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody });
  return res.json().organizationId as string;
}

describe("org approval", () => {
  it("approve → org active+verified, DID on-chain, admin gets a membership VC + can log in", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgId = await registerAndId(app);
    const appr = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.statusCode).toBe(200);
    expect(appr.json().status).toBe("active");
    expect(appr.json().verified).toBe(true);
    const orgDid = appr.json().did;
    expect((await anchor.didRegistration("0xdid", orgDid)).registered).toBe(true);
    const adminTok = (await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } })).json().token;
    expect(typeof adminTok).toBe("string");
    const creds = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: { authorization: `Bearer ${adminTok}` } })).json();
    expect(creds.some((c: { type: string[] }) => c.type.includes("OrganizationMembership"))).toBe(true);
  });
  it("chain-first: a registerDid failure leaves the org pending and the admin locked out", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgId = await registerAndId(app);
    anchor.failNext = "registerDid"; // arm AFTER boot: buildTestApp registers the platform-org DID on-chain (would consume this early); org registration mints the DID but does NOT anchor it, so approve is the first registerDid the failure hits

    const appr = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.statusCode).toBe(502);
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } });
    expect(login.statusCode).toBe(401);
  });
  it("reject → org rejected, admin still cannot log in", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgId = await registerAndId(app);
    const rej = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/reject`, headers: { authorization: `Bearer ${platform}` }, payload: { reason: "incomplete" } });
    expect(rej.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } });
    expect(login.statusCode).toBe(401);
  });
  it("GET /orgs?status=pending lists only pending orgs", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await registerAndId(app);
    const list = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json();
    expect(list.every((o: { status: string }) => o.status === "pending")).toBe(true);
    expect(list.length).toBe(1);
  });
});
