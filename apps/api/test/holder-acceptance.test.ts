import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, onboardUser, V1 } from "./helpers.js";

// Seed a credential use case, an issuer-eligible subject, then exercise the runtime.
// Mirrors the pattern in credential-usecase-issuance.test.ts.
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

interface HeldCredential {
  id: string; type: string[]; holderDid: string;
  acceptance: "accepted" | "pending" | "rejected" | "changes_requested";
  acceptanceAt: string | null; acceptanceNote: string | null;
}

async function issueUsecaseCredential(
  app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, admin2: string, subjectId: string,
): Promise<void> {
  const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(admin),
    payload: { credentialType: "KycCredential", subjectUserId: subjectId, claims: { legalName: "Acme Ltd", country: "IN" } } });
  expect(issued.statusCode).toBe(202);
  const proposalId = issued.json().proposal.id;
  const approved = await app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(admin2), payload: {} });
  expect(approved.statusCode).toBe(200);
}

describe("holder acceptance state — persistence + born-pending issuance (L2)", () => {
  it("toggle off (back-compat): a use case without holderAcceptance issues an already-accepted credential", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app);
    await issueUsecaseCredential(app, admin, admin2, subject.id);

    const subjTok = await loginAs(app, subject.email, subject.password);
    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
    expect(held.statusCode).toBe(200);
    const kyc = (held.json() as HeldCredential[]).find((c) => c.type.includes("KycCredential"));
    expect(kyc).toBeDefined();
    expect(kyc!.acceptance).toBe("accepted");
    expect(kyc!.acceptanceAt).toBeNull();
  });

  it("toggle on: a use case with holderAcceptance: true issues a born-pending credential", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin, { holderAcceptance: true });
    const subject = await subjectWithDid(app);
    await issueUsecaseCredential(app, admin, admin2, subject.id);

    const subjTok = await loginAs(app, subject.email, subject.password);
    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
    expect(held.statusCode).toBe(200);
    const kyc = (held.json() as HeldCredential[]).find((c) => c.type.includes("KycCredential"));
    expect(kyc).toBeDefined();
    expect(kyc!.acceptance).toBe("pending");
    expect(kyc!.acceptanceAt).toBeNull();
    expect(kyc!.acceptanceNote).toBeNull();
  });

  it("non-use-case issuance (closed catalog) stays accepted", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const verifier = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `KYC Verifier ${Date.now()}`, orgType: "verifier" } })).json() as { id: string };
    const mk = await app.inject({ method: "POST", url: `${V1}/orgs/${verifier.id}/users`, headers: auth(admin), payload: { email: `maker-${Date.now()}@x.io`, password: "secret1", role: "OrgAdmin" } });
    expect(mk.statusCode).toBe(201);
    const ck = await app.inject({ method: "POST", url: `${V1}/orgs/${verifier.id}/users`, headers: auth(admin), payload: { email: `checker-${Date.now()}@x.io`, password: "secret1", role: "OrgAdmin" } });
    expect(ck.statusCode).toBe(201);
    const makerTok = await loginAs(app, mk.json().email, "secret1");
    const checkerTok = await loginAs(app, ck.json().email, "secret1");

    const holderOrg = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `KYC Holder ${Date.now()}`, orgType: "corporate" } })).json() as { id: string };
    const subj = await app.inject({ method: "POST", url: `${V1}/orgs/${holderOrg.id}/users`, headers: auth(admin), payload: { email: `subj-${Date.now()}@x.io`, password: "secret1", role: "Issuer" } });
    expect(subj.statusCode).toBe(201);
    const subjTok = await loginAs(app, subj.json().email, "secret1");

    const req = await app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(makerTok),
      payload: { type: "KycCredential", subjectUserId: subj.json().id, claims: { legalName: "Ada Lovelace", country: "IN", idType: "passport", idNumber: "P1234567" } } });
    expect(req.statusCode).toBe(202);
    const proposalId = req.json().proposal.id;
    const approved = await app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(checkerTok), payload: {} });
    expect(approved.statusCode).toBe(200);

    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
    expect(held.statusCode).toBe(200);
    const kyc = (held.json() as HeldCredential[]).find((c) => c.type.includes("KycCredential"));
    expect(kyc).toBeDefined();
    expect(kyc!.acceptance).toBe("accepted");
  });
});
