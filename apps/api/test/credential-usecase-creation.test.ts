import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const ROUNDS = 4;

/** An org and its OrgAdmin, with the Issuer capability enabled. */
async function orgAdminOrg(h: TestAppHandle, label: string): Promise<{ orgId: string; token: string }> {
  const tag = Math.random().toString(36).slice(2, 10);
  const org = await h.organizations.create({
    name: `${label} ${tag}`, orgType: "issuer", registrationId: null, jurisdiction: null,
    did: `did:key:zCUC${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
    verifiedAt: new Date().toISOString(), companyProfile: null,
    capabilities: { domains: ["identity"], roles: ["Issuer"] },
  });
  const email = `cuc-admin-${tag}@tokenlayer.dev`;
  const password = `cuc-admin-${tag}`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync(password, ROUNDS), role: "OrgAdmin",
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId: org.id, kind: "human",
  });
  return { orgId: org.id, token: await loginAs(h.app, email, password) };
}

function def(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key, name: `Notes ${key}`,
    credentialTypes: [{
      name: "CourseCompletion", title: "Course Completion", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
      certificate: { enabled: true },
    }],
    issuer: { kind: "org", orgId: "IGNORED-should-be-overwritten" },
    holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    ...overrides,
  };
}

describe("OrgAdmin credential-use-case creation (proposal, mirrors tokenization)", () => {
  it("proposes a credential use case; PlatformAdmin approval creates it, owned by and issued by the OrgAdmin's own org", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const { orgId, token: orgAdmin } = await orgAdminOrg(h, "Notes Org");

    const draft = await h.app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(orgAdmin), payload: def("org-notes-1") });
    expect(draft.statusCode).toBe(202);
    const proposalId = draft.json().proposal.id as string;

    // Not yet visible before approval.
    expect((await h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/org-notes-1`, headers: auth(platform) })).statusCode).toBe(404);

    const approve = await h.app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(platform), payload: {} });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().proposal.status).toBe("executed");

    const created = await h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/org-notes-1`, headers: auth(platform) });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.ownerOrgId).toBe(orgId);
    expect(body.issuer).toEqual({ kind: "org", orgId });
  });

  it("forces issuer + ownerOrgId to the OrgAdmin's OWN org, ignoring whatever the client sent", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const { orgId: attackerOrgId, token: attacker } = await orgAdminOrg(h, "Attacker Org");
    const { orgId: victimOrgId } = await orgAdminOrg(h, "Victim Org");

    const draft = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(attacker),
      payload: def("spoof-attempt", { ownerOrgId: victimOrgId, issuer: { kind: "org", orgId: victimOrgId } }),
    });
    expect(draft.statusCode).toBe(202);
    const proposalId = draft.json().proposal.id as string;
    await h.app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(platform), payload: {} });

    const created = await h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/spoof-attempt`, headers: auth(platform) });
    expect(created.json().ownerOrgId).toBe(attackerOrgId); // never the victim
    expect(created.json().issuer).toEqual({ kind: "org", orgId: attackerOrgId });
  });

  it("409s KEY_TAKEN at propose time when the key already exists", async () => {
    const h = await buildTestAppWithRepos();
    const { token: orgAdmin } = await orgAdminOrg(h, "Dup Key Org");
    await h.deps.credentialUseCases.create({
      key: "already-there", name: "Existing",
      credentialTypes: [{ name: "X", title: "X", validityDays: 1, requiredApprovals: 1, claimSchema: { type: "object", properties: {} }, certificate: { enabled: false } }],
      issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" }, ownerOrgId: null,
    } as never);
    const draft = await h.app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(orgAdmin), payload: def("already-there") });
    expect(draft.statusCode).toBe(409);
    expect(draft.json().error).toBe("KEY_TAKEN");
  });

  it("a PlainAdmin still creates directly, 201, unchanged", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform),
      payload: def("platform-direct", { issuer: { kind: "platform" } }),
    });
    expect(res.statusCode).toBe(201);
  });

  it("a plain UseCaseAdmin/Issuer (not OrgAdmin, not PlatformAdmin) is refused", async () => {
    const h = await buildTestAppWithRepos();
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await h.app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(carbonAdmin), payload: def("uca-attempt") });
    expect(res.statusCode).toBe(403);
  });
});
