import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1 } from "./helpers.js";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";

const registerBody = {
  company: {
    name: "Globex Trade Pvt Ltd", orgType: "corporate",
    cin: "U72900MH2020PTC123456", pan: "AABCU9603R", gstin: "27AABCU9603R1Z5",
    state: "Maharashtra", pincode: "400001", dateOfIncorporation: "2020-06-15",
    category: "private-limited", companyStatus: "active",
  },
  admin: { name: "Rhea Kapoor", email: "rhea@globex.dev", password: "corp-secret-1" },
};

const pdfBase64 = (label: string): string => Buffer.from(`%PDF-1.4 fake ${label}`).toString("base64");

/** Upload a CIN certificate to the public endpoint and return a register payload referencing it. */
async function registerPayload(app: import("fastify").FastifyInstance, overrides?: { gstinToo?: boolean }) {
  const up = await app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "application/pdf", dataBase64: pdfBase64("cin") } });
  expect(up.statusCode).toBe(201);
  const cin = up.json() as { id: string; sha256: string };
  let gstin: { id: string; sha256: string } | undefined;
  if (overrides?.gstinToo) {
    const up2 = await app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "image/png", dataBase64: pdfBase64("gstin") } });
    gstin = up2.json();
  }
  return {
    body: { ...registerBody, company: { ...registerBody.company, documents: { cinCertificate: { id: cin.id }, ...(gstin ? { gstinCertificate: { id: gstin.id } } : {}) } } },
    cin, gstin,
  };
}

describe("KYB document upload (public)", () => {
  it("uploads → 201 with sha256; register persists SERVER-side refs; reviewer can download", async () => {
    const app = await buildTestApp();
    const { body, cin, gstin } = await registerPayload(app, { gstinToo: true });
    const res = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: body });
    expect(res.statusCode).toBe(202);
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const mine = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json()
      .find((o: { id: string }) => o.id === res.json().organizationId);
    expect(mine.companyProfile.documents.cinCertificate).toEqual({ id: cin.id, sha256: cin.sha256 });
    expect(mine.companyProfile.documents.gstinCertificate).toEqual({ id: gstin!.id, sha256: gstin!.sha256 });
    const dl = await app.inject({ method: "GET", url: `${V1}/documents/${cin.id}`, headers: { authorization: `Bearer ${platform}` } });
    expect(dl.statusCode).toBe(200);
    const anon = await app.inject({ method: "GET", url: `${V1}/documents/${cin.id}` });
    expect(anon.statusCode).toBe(401);
  });
  it("refuses bad uploads and bad references", async () => {
    const app = await buildTestApp();
    const badType = await app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "application/zip", dataBase64: pdfBase64("x") } });
    expect(badType.statusCode).toBe(415);
    const tooBig = await app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "application/pdf", dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") } });
    expect(tooBig.statusCode).toBe(413);
    const noDocs = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody });
    expect(noDocs.statusCode).toBe(400); // schema: documents.cinCertificate required
    const badRef = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, company: { ...registerBody.company, documents: { cinCertificate: { id: "nope" } } } } });
    expect(badRef.statusCode).toBe(400);
    expect(badRef.json().error).toBe("DOCUMENT_NOT_FOUND");
  });
});

describe("corporate self-registration", () => {
  it("creates a pending org (DID minted, not on-chain) + a pending admin who cannot log in", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: (await registerPayload(app)).body });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
    const orgId = res.json().organizationId;
    expect(typeof orgId).toBe("string");
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } });
    expect(login.statusCode).toBe(401);
    // The India KYB profile is persisted and visible to the platform admin at approval.
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const pending = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json();
    const mine = pending.find((o: { id: string }) => o.id === orgId);
    expect(mine.registrationId).toBe(registerBody.company.cin); // CIN is the registration id
    expect(mine.companyProfile).toMatchObject({
      cin: "U72900MH2020PTC123456", pan: "AABCU9603R", gstin: "27AABCU9603R1Z5",
      state: "Maharashtra", pincode: "400001", category: "private-limited", companyStatus: "active",
    });
  });
  it("rejects a verifier orgType, an invalid category, and duplicate name/CIN/email", async () => {
    const app = await buildTestApp();
    const p = await registerPayload(app); // one upload; every variant may reuse the same doc id (the store doesn't dedupe)
    const verifier = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...p.body, company: { ...p.body.company, orgType: "verifier" } } });
    expect(verifier.statusCode).toBe(400);
    const badCategory = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...p.body, company: { ...p.body.company, category: "sole-prop" } } });
    expect(badCategory.statusCode).toBe(400);
    await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: p.body });
    const dupName = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...p.body, admin: { ...p.body.admin, email: "other@x.dev" } } });
    expect(dupName.statusCode).toBe(409);
    const dupEmail = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...p.body, company: { ...p.body.company, name: "Different Co", cin: "U99999MH2021PTC999999" } } });
    expect(dupEmail.statusCode).toBe(409);
    const dupCin = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...p.body, company: { ...p.body.company, name: "Yet Another Co" }, admin: { ...p.body.admin, email: "third@x.dev" } } });
    expect(dupCin.statusCode).toBe(409);
  });
});

async function registerAndId(app: import("fastify").FastifyInstance) {
  const res = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: (await registerPayload(app)).body });
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
    const orgId = (await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: (await registerPayload(app)).body })).json().organizationId as string;
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

  it("execute re-checks the key: if it is taken after propose, approval fails (not crash) and does not overwrite", async () => {
    const app = await buildTestApp();
    const { platform, adminTok } = await activeOrgAdmin(app);
    // OrgAdmin proposes globex-notes.
    const pid = (await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: { authorization: `Bearer ${adminTok}` }, payload: def })).json().proposal.id;
    // The key is taken before approval (a PlatformAdmin creates it directly).
    const direct = await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: { authorization: `Bearer ${platform}` }, payload: def });
    expect(direct.statusCode).toBe(201);
    // Approving the now-stale proposal fails gracefully (no crash), leaving the existing use case intact.
    const appr = await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.json().proposal.status).toBe("failed");
    const matches = (await app.inject({ method: "GET", url: `${V1}/use-cases`, headers: { authorization: `Bearer ${platform}` } })).json().filter((u: { key: string }) => u.key === "globex-notes");
    expect(matches.length).toBe(1);
  });
});
