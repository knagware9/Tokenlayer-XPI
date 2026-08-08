import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { MemoryOrganizationRepository } from "../src/persistence/memory.js";
import { buildTestApp, loginAs, V1 } from "./helpers.js";

describe("Organization.capabilities persistence (EN-A task A2)", () => {
  it("create stores an explicit envelope; setCapabilities replaces it; null round-trips", async () => {
    const repo = new MemoryOrganizationRepository();
    const base = {
      name: "Caps Org",
      orgType: "corporate" as const,
      registrationId: null,
      jurisdiction: null,
      did: "did:key:zCaps",
      didSeedEncrypted: "enc",
      status: "active" as const,
      verified: false,
      verifiedAt: null,
      companyProfile: null,
      capabilities: { domains: ["identity" as const], roles: ["Issuer" as const] },
    };
    const o = await repo.create(base);
    expect(o.capabilities).toEqual({ domains: ["identity"], roles: ["Issuer"] });

    // Replace with an all-empty envelope — "everything off" is distinct from null.
    const tightened = await repo.setCapabilities(o.id, { domains: [], roles: [] });
    expect(tightened.capabilities).toEqual({ domains: [], roles: [] });

    // Clearing back to null restores the unrestricted-legacy sentinel.
    const cleared = await repo.setCapabilities(o.id, null);
    expect(cleared.capabilities).toBeNull();
  });
});

describe("capability acquisition (EN-A task A3)", () => {
  const PDF = Buffer.from("%PDF-1.4 fake cin certificate").toString("base64");
  const ENVELOPE = { domains: ["identity"], roles: ["Issuer", "Verifier"] };

  interface RegOpts { name: string; cin: string; email: string; capabilities?: unknown }

  /** Upload a KYB doc then self-register an org (optionally with a capability envelope). */
  async function registerOrg(app: FastifyInstance, opts: RegOpts) {
    const up = await app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "application/pdf", dataBase64: PDF } });
    expect(up.statusCode).toBe(201);
    return app.inject({
      method: "POST", url: `${V1}/orgs/register`,
      payload: {
        company: {
          name: opts.name, orgType: "corporate", cin: opts.cin, pan: "AABCU9603R",
          state: "Maharashtra", pincode: "400001", dateOfIncorporation: "2020-06-15",
          category: "private-limited", companyStatus: "active",
          documents: { cinCertificate: { id: (up.json() as { id: string }).id } },
        },
        admin: { name: "Caps Admin", email: opts.email, password: "corp-secret-1" },
        ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
      },
    });
  }

  /** register → PlatformAdmin approve → OrgAdmin login. */
  async function approvedOrg(app: FastifyInstance, platform: string, opts: RegOpts) {
    const res = await registerOrg(app, opts);
    expect(res.statusCode).toBe(202);
    const orgId = res.json().organizationId as string;
    const appr = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.statusCode).toBe(200);
    return { orgId, adminTok: await loginAs(app, opts.email, "corp-secret-1") };
  }

  const getOrg = async (app: FastifyInstance, token: string, id: string) =>
    (await app.inject({ method: "GET", url: `${V1}/orgs/${id}`, headers: { authorization: `Bearer ${token}` } })).json();

  it("register WITH capabilities → pending org stores them; approval carries them into the active org", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await registerOrg(app, { name: "Caps One", cin: "U11111MH2020PTC111111", email: "caps1@x.dev", capabilities: ENVELOPE });
    expect(res.statusCode).toBe(202);
    const orgId = res.json().organizationId as string;
    // The requested envelope is part of what the reviewer sees on the pending org.
    const pending = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json()
      .find((o: { id: string }) => o.id === orgId);
    expect(pending.capabilities).toEqual(ENVELOPE);
    const appr = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.statusCode).toBe(200);
    // Active org still carries the envelope, in both the get and list views.
    expect((await getOrg(app, platform, orgId)).capabilities).toEqual(ENVELOPE);
    const listed = (await app.inject({ method: "GET", url: `${V1}/orgs`, headers: { authorization: `Bearer ${platform}` } })).json()
      .find((o: { id: string }) => o.id === orgId);
    expect(listed.capabilities).toEqual(ENVELOPE);
  });

  it("register WITHOUT capabilities → null (unrestricted legacy; old clients unaffected)", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await registerOrg(app, { name: "Legacy One", cin: "U22222MH2020PTC222222", email: "legacy1@x.dev" });
    expect(res.statusCode).toBe(202);
    const pending = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json()
      .find((o: { id: string }) => o.id === res.json().organizationId);
    expect(pending.capabilities).toBeNull();
  });

  it("register with an unknown domain → 400 INVALID_CAPABILITIES (nothing created)", async () => {
    const app = await buildTestApp();
    const res = await registerOrg(app, {
      name: "Bad Caps", cin: "U33333MH2020PTC333333", email: "bad@x.dev",
      capabilities: { domains: ["defi"], roles: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_CAPABILITIES");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const pending = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json();
    expect(pending.some((o: { name: string }) => o.name === "Bad Caps")).toBe(false);
  });

  it("PATCH /orgs/:id/capabilities: PlatformAdmin sets (and clears) directly; an OrgAdmin gets 403", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const { orgId, adminTok } = await approvedOrg(app, platform, { name: "Patch Co", cin: "U44444MH2020PTC444444", email: "patch@x.dev" });
    const set = await app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/capabilities`, headers: { authorization: `Bearer ${platform}` }, payload: { capabilities: ENVELOPE } });
    expect(set.statusCode).toBe(200);
    expect(set.json().capabilities).toEqual(ENVELOPE);
    expect((await getOrg(app, platform, orgId)).capabilities).toEqual(ENVELOPE);
    // null clears back to the unrestricted legacy envelope (PlatformAdmin only, deliberate).
    const clear = await app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/capabilities`, headers: { authorization: `Bearer ${platform}` }, payload: { capabilities: null } });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().capabilities).toBeNull();
    const asOrgAdmin = await app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/capabilities`, headers: { authorization: `Bearer ${adminTok}` }, payload: { capabilities: ENVELOPE } });
    expect(asOrgAdmin.statusCode).toBe(403);
  });

  it("change request: own OrgAdmin 202 → PlatformAdmin approves → applied; foreign OrgAdmin 403; proposer cannot approve", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const a = await approvedOrg(app, platform, { name: "Req A", cin: "U55555MH2020PTC555555", email: "req-a@x.dev" });
    const b = await approvedOrg(app, platform, { name: "Req B", cin: "U66666MH2020PTC666666", email: "req-b@x.dev" });
    const wanted = { domains: ["identity", "tokenization"], roles: ["Issuer", "Holder"] };
    // A foreign OrgAdmin may not request changes for org A.
    const foreign = await app.inject({ method: "POST", url: `${V1}/orgs/${a.orgId}/capabilities/request`, headers: { authorization: `Bearer ${b.adminTok}` }, payload: { capabilities: wanted } });
    expect(foreign.statusCode).toBe(403);
    // A's own OrgAdmin: 202 with the new proposal kind.
    const req = await app.inject({ method: "POST", url: `${V1}/orgs/${a.orgId}/capabilities/request`, headers: { authorization: `Bearer ${a.adminTok}` }, payload: { capabilities: wanted } });
    expect(req.statusCode).toBe(202);
    expect(req.json().proposal.kind).toBe("org-capability-change");
    const pid = req.json().proposal.id as string;
    // The proposing OrgAdmin cannot decide their own request.
    const self = await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: { authorization: `Bearer ${a.adminTok}` }, payload: {} });
    expect(self.statusCode).toBe(403);
    // Envelope unchanged until the platform decides.
    expect((await getOrg(app, platform, a.orgId)).capabilities).toBeNull();
    const appr = await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.statusCode).toBe(200);
    expect(appr.json().proposal.status).toBe("executed");
    expect((await getOrg(app, platform, a.orgId)).capabilities).toEqual(wanted);
  });

  it("login threads orgCapabilities: an enveloped org's OrgAdmin carries it; a PlatformAdmin gets null", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await approvedOrg(app, platform, { name: "Sess Co", cin: "U77777MH2020PTC777777", email: "sess@x.dev", capabilities: ENVELOPE });
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "sess@x.dev", password: "corp-secret-1" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.orgCapabilities).toEqual(ENVELOPE);
    const adminLogin = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "admin@tokenlayer.dev", password: "admin123" } });
    expect(adminLogin.json().user.orgCapabilities).toBeNull();
  });
});
