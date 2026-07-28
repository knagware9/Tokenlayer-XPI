import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

async function seedUseCase(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, over: Record<string, unknown> = {}) {
  const DEF = {
    key: "corp-kyb", name: "Corp KYB",
    credentialTypes: [{ name: "MCACredential", title: "MCA", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["cin", "companyName"], properties: { cin: { type: "string" }, companyName: { type: "string" } } } }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    ...over,
  };
  expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF })).statusCode).toBe(201);
  return DEF;
}

// A corporate org (created via POST /orgs) has a DID immediately.
async function makeOrg(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, name: string, orgType = "corporate") {
  const r = await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name, orgType } });
  expect(r.statusCode).toBe(201);
  return r.json() as { id: string; did: string; name: string };
}

describe("issue-to-org (entity holder)", () => {
  it("issues a credential to an ORG → approve → held on the org DID", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const org = await makeOrg(app, admin, "Acme Manufacturing Ltd");

    const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyb/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", subjectOrgId: org.id, claims: { cin: "U74999MH2020PTC1", companyName: "Acme Manufacturing Ltd" } } });
    expect(issued.statusCode).toBe(202);
    const pid = issued.json().proposal.id;
    expect((await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: auth(admin2), payload: {} })).statusCode).toBe(200);

    // Held on the org's DID — visible in the org wallet (Task 2 route).
    const wallet = await app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/wallet`, headers: auth(admin) });
    expect(wallet.statusCode).toBe(200);
    const held = wallet.json() as { holderDid: string; type: string[] }[];
    expect(held.some((c) => c.holderDid === org.did && c.type.includes("MCACredential"))).toBe(true);
  });

  it("400 SUBJECT_REQUIRED when neither or both subject ids are given", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const org = await makeOrg(app, admin, "Beta Corp");
    const neither = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyb/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", claims: { cin: "x", companyName: "y" } } });
    expect(neither.statusCode).toBe(400);
    expect(neither.json().error).toBe("SUBJECT_REQUIRED");
    const both = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyb/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", subjectOrgId: org.id, subjectUserId: "u1", claims: { cin: "x", companyName: "y" } } });
    expect(both.statusCode).toBe(400);
    expect(both.json().error).toBe("SUBJECT_REQUIRED");
  });

  it("holder policy gates an org subject", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const bank = await makeOrg(app, admin, "Some Bank", "bank");
    const corp = await makeOrg(app, admin, "Gamma Corp", "corporate");
    // policy admits only corporates
    await seedUseCase(app, admin, { key: "corp-only", holderPolicy: { who: "orgType", orgTypes: ["corporate"] } });
    const bad = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-only/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", subjectOrgId: bank.id, claims: { cin: "x", companyName: "y" } } });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error).toBe("HOLDER_NOT_ELIGIBLE");
    const ok = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-only/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", subjectOrgId: corp.id, claims: { cin: "x", companyName: "y" } } });
    expect(ok.statusCode).toBe(202);
  });

  it("eligible-holders includes both user and org rows for any-onboarded", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    await makeOrg(app, admin, "Delta Corp");
    const res = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/corp-kyb/eligible-holders`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { kind: string; did: string }[];
    expect(rows.some((r) => r.kind === "org")).toBe(true);
    // every row carries a DID + a kind
    for (const r of rows) { expect(r.did).toBeTruthy(); expect(["user", "org"]).toContain(r.kind); }
  });
});

describe("entity wallet read", () => {
  it("me/credentials + org wallet carry credentialUseCaseKey + issuerName", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const org = await makeOrg(app, admin, "Epsilon Corp");
    const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyb/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", subjectOrgId: org.id, claims: { cin: "c", companyName: "Epsilon Corp" } } });
    const pid = issued.json().proposal.id;
    await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: auth(admin2), payload: {} });

    const wallet = (await app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/wallet`, headers: auth(admin) })).json() as { credentialUseCaseKey: string | null; issuerName: string | null }[];
    expect(wallet[0]!.credentialUseCaseKey).toBe("corp-kyb");
    expect(wallet[0]!.issuerName).toBeTruthy(); // the platform issuer org's name
  });

  it("org wallet is org-scoped: a foreign OrgAdmin is 403", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgA = await makeOrg(app, admin, "Org A");
    const orgB = await makeOrg(app, admin, "Org B");
    // an OrgAdmin of B
    await app.inject({ method: "POST", url: `${V1}/orgs/${orgB.id}/users`, headers: auth(admin), payload: { email: "b.admin@x.io", password: "badmin123", role: "OrgAdmin" } });
    const bAdmin = await loginAs(app, "b.admin@x.io", "badmin123");
    expect((await app.inject({ method: "GET", url: `${V1}/orgs/${orgA.id}/wallet`, headers: auth(bAdmin) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `${V1}/orgs/${orgB.id}/wallet`, headers: auth(bAdmin) })).statusCode).toBe(200);
  });
});
