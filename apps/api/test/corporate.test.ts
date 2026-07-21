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

describe("gated use-case config", () => {
  async function activeOrgAdmin(app: import("fastify").FastifyInstance) {
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgId = (await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody })).json().organizationId as string;
    await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    const adminTok = (await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } })).json().token as string;
    return { platform, adminTok, orgId };
  }
  // A complete, schema-valid definition on a chain that is deployable in the test app (fabric).
  const def = {
    key: "globex-notes", name: "Globex Notes", symbol: "GXN", tokenStandard: "ERC-20",
    allowedChainIds: ["fabric"], defaultChainId: "fabric",
    metadataSchema: { type: "object", properties: {} },
    lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
    compliance: { allowlist: true, transferRestrictions: false },
    roles: ["UseCaseAdmin", "Issuer"],
  };

  it("an OrgAdmin proposes a use case (202) and a PlatformAdmin approval creates+deploys it, org-owned", async () => {
    const app = await buildTestApp();
    const { platform, adminTok, orgId } = await activeOrgAdmin(app);
    const prop = await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: { authorization: `Bearer ${adminTok}` }, payload: def });
    expect(prop.statusCode).toBe(202);
    expect(prop.json().proposal.kind).toBe("create-use-case");
    const pid = prop.json().proposal.id;
    // The proposer may not decide their own proposal (SoD).
    const self = await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: { authorization: `Bearer ${adminTok}` }, payload: {} });
    expect(self.statusCode).toBe(403);
    const appr = await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.json().proposal.status).toBe("executed");
    const uc = (await app.inject({ method: "GET", url: `${V1}/use-cases`, headers: { authorization: `Bearer ${platform}` } })).json().find((u: { key: string }) => u.key === "globex-notes");
    expect(uc.ownerOrgId).toBe(orgId);
    expect(Object.keys(uc.contracts).length).toBeGreaterThan(0);
  });

  it("a PlatformAdmin creating a use case still deploys directly (201, unchanged)", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: { authorization: `Bearer ${platform}` }, payload: { ...def, key: "pa-direct" } });
    expect(res.statusCode).toBe(201);
  });
});
