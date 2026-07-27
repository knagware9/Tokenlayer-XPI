import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, onboardUser, V1, auth } from "./helpers.js";

// Seed a credential use case, an issuer-eligible subject, then exercise the runtime.
async function seedUseCase(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, over: Record<string, unknown> = {}) {
  const DEF = {
    key: "corp-kyc", name: "Corp KYC",
    credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["legalName", "country"], properties: { legalName: { type: "string" }, country: { type: "string", pattern: "^[A-Z]{2}$" } } } }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    ...over,
  };
  const r = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
  expect(r.statusCode).toBe(201);
  return DEF;
}

// A subject user that has a DID. The test harness's seedDefaults does NOT
// provision DIDs (that only happens at live boot), so we mint one through the
// existing gated onboarding flow: onboarding assigns a custodial DID
// unconditionally, and — with no `kyc` — issues NO KycCredential, so the only
// KycCredential the subject can hold is the one the runtime under test issues.
async function subjectWithDid(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<{ id: string; email: string; password: string }> {
  const maker = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  const checker = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
  const email = `subj-${Math.random().toString(36).slice(2)}@x.dev`;
  const password = "secret1";
  const u = await onboardUser(app, maker, checker, {
    email, password, role: "Buyer", useCaseKey: "invoice-tokenization",
    walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  });
  return { id: u.id, email, password };
}

describe("config-driven credential issuance", () => {
  it("PlatformAdmin issues a platform-bound credential (202) → approved → held by the subject", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app);

    const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(admin),
      payload: { credentialType: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Acme Ltd", country: "IN" } } });
    expect(issued.statusCode).toBe(202);
    const proposalId = issued.json().proposal.id;

    // Second PlatformAdmin approves (proposer != approver).
    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(admin2), payload: {} });
    expect(approve.statusCode).toBe(200);

    // The subject now holds the credential.
    const subjTok = await loginAs(app, subject.email, subject.password);
    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
    expect((held.json() as { type: string[] }[]).some((c) => c.type.includes("KycCredential"))).toBe(true);
  });

  it("rejects bad claims (INVALID_METADATA) and an unknown type (UNKNOWN_CREDENTIAL_TYPE)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app);
    const badClaims = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(admin),
      payload: { credentialType: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Acme" } } });
    expect(badClaims.statusCode).toBe(400);
    const badType = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(admin),
      payload: { credentialType: "Nope", subjectUserId: subject.id, claims: {} } });
    expect(badType.statusCode).toBe(400);
    expect(badType.json().error).toBe("UNKNOWN_CREDENTIAL_TYPE");
  });

  it("a non-issuer role (UseCaseAdmin) cannot issue at all (FORBIDDEN)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app);
    // m1.admin is a UseCaseAdmin — neither PlatformAdmin nor OrgAdmin — so the
    // role gate rejects it before any binding check.
    const useCaseAdmin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const res = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(useCaseAdmin),
      payload: { credentialType: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Acme Ltd", country: "IN" } } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("an OrgAdmin bound to a DIFFERENT org cannot issue (ISSUER_NOT_PERMITTED)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // Org A is the OrgAdmin's own org; org B is the use case's configured issuer.
    const orgA = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: "Issuer Org A", orgType: "corporate" } })).json();
    const orgB = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: "Issuer Org B", orgType: "corporate" } })).json();
    // Mint a genuine OrgAdmin login inside org A.
    const mk = await app.inject({ method: "POST", url: `${V1}/orgs/${orgA.id}/users`, headers: auth(admin),
      payload: { email: `orgadmin.${orgA.id}@x.io`, password: "secret1", role: "OrgAdmin" } });
    expect(mk.statusCode).toBe(201);
    const orgAdmin = await loginAs(app, `orgadmin.${orgA.id}@x.io`, "secret1");
    // A use case whose issuer binding points at org B (NOT org A).
    await seedUseCase(app, admin, { issuer: { kind: "org", orgId: orgB.id } });
    const subject = await subjectWithDid(app);
    const res = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(orgAdmin),
      payload: { credentialType: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Acme Ltd", country: "IN" } } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("ISSUER_NOT_PERMITTED");
  });

  it("honors requiredApprovals: 2 (one approval is not enough)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin, { credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 2,
      claimSchema: { type: "object", required: ["legalName", "country"], properties: { legalName: { type: "string" }, country: { type: "string", pattern: "^[A-Z]{2}$" } } } }] });
    const subject = await subjectWithDid(app);
    const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(admin),
      payload: { credentialType: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Acme Ltd", country: "IN" } } });
    expect(issued.json().proposal.required).toBe(2);
  });

  it("lists eligible holders for a use case", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    await subjectWithDid(app); // a DID-holding, onboarded user → an eligible holder
    const res = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/corp-kyc/eligible-holders`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    // every returned holder has a DID
    for (const h of res.json() as { did: string }[]) expect(h.did).toBeTruthy();
  });
});
