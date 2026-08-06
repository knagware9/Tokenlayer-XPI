import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, onboardUser, V1 } from "./helpers.js";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";

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
  id: string; type: string[]; holderDid: string; revoked: boolean;
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

  // Regression: the Prisma CredentialUseCase repo initially dropped the
  // top-level holderAcceptance flag on create/update (memory repo spreads
  // records, so it stayed green there while a live Besu/Prisma deployment
  // silently lost the flag). Pins the create → PATCH → GET round-trip.
  it("holderAcceptance survives a create → PATCH → GET round-trip", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const def = await seedUseCase(app, admin, { holderAcceptance: true });

    const patched = await app.inject({ method: "PATCH", url: `${V1}/credential-use-cases/corp-kyc`, headers: auth(admin), payload: def });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().holderAcceptance).toBe(true);

    const got = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/corp-kyc`, headers: auth(admin) });
    expect(got.statusCode).toBe(200);
    expect(got.json().holderAcceptance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L3: holder action routes + fail-closed consumer gates
// ---------------------------------------------------------------------------

async function heldOf(app: Awaited<ReturnType<typeof buildTestApp>>, token: string): Promise<HeldCredential[]> {
  const res = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json() as HeldCredential[];
}

async function pendingKyc(
  app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, admin2: string,
): Promise<{ subject: { id: string; email: string; password: string }; subjTok: string; cred: HeldCredential }> {
  await seedUseCase(app, admin, { holderAcceptance: true });
  const subject = await subjectWithDid(app);
  await issueUsecaseCredential(app, admin, admin2, subject.id);
  const subjTok = await loginAs(app, subject.email, subject.password);
  const held = await heldOf(app, subjTok);
  const cred = held.find((c) => c.type.includes("KycCredential"))!;
  expect(cred).toBeDefined();
  expect(cred.acceptance).toBe("pending");
  return { subject, subjTok, cred };
}

describe("holder action routes (L3)", () => {
  it("accept: pending credential -> 200; GET /me/credentials shows accepted with non-null acceptanceAt", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const { subjTok, cred } = await pendingKyc(app, admin, admin2);

    const res = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/accept`, headers: auth(subjTok), payload: {} });
    expect(res.statusCode).toBe(200);

    const after = (await heldOf(app, subjTok)).find((c) => c.id === cred.id)!;
    expect(after.acceptance).toBe("accepted");
    expect(after.acceptanceAt).not.toBeNull();
  });

  it("reject revokes chain-first: pending -> rejected AND revoked; the FakeAnchor recorded the revoke", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const { subjTok, cred } = await pendingKyc(app, admin, admin2);

    const res = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/reject`, headers: auth(subjTok), payload: { note: "wrong grade" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().acceptance).toBe("rejected");
    expect(res.json().revoked).toBe(true);
    expect(anchor.credentials.get(cred.id)?.revoked).toBe(true);

    const after = (await heldOf(app, subjTok)).find((c) => c.id === cred.id)!;
    expect(after.acceptance).toBe("rejected");
    expect(after.revoked).toBe(true);
  });

  it("request changes: empty body -> 400; with note -> changes_requested + note stored; then accept -> accepted", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const { subjTok, cred } = await pendingKyc(app, admin, admin2);

    const bad = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/request-changes`, headers: auth(subjTok), payload: {} });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/request-changes`, headers: auth(subjTok), payload: { note: "name misspelt" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().acceptance).toBe("changes_requested");

    const after = (await heldOf(app, subjTok)).find((c) => c.id === cred.id)!;
    expect(after.acceptance).toBe("changes_requested");
    expect(after.acceptanceNote).toBe("name misspelt");

    const acc = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/accept`, headers: auth(subjTok), payload: {} });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().acceptance).toBe("accepted");
  });

  it("state machine: accept on an already-accepted credential -> 409; reject on a rejected credential -> 409", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin, { holderAcceptance: true });
    const subject = await subjectWithDid(app);
    // Two independent credentials: one driven to accepted, the other to rejected.
    await issueUsecaseCredential(app, admin, admin2, subject.id);
    await issueUsecaseCredential(app, admin, admin2, subject.id);
    const subjTok = await loginAs(app, subject.email, subject.password);
    const [credA, credB] = (await heldOf(app, subjTok)).filter((c) => c.type.includes("KycCredential"));
    expect(credA).toBeDefined();
    expect(credB).toBeDefined();

    const acc1 = await app.inject({ method: "POST", url: `${V1}/me/credentials/${credA.id}/accept`, headers: auth(subjTok), payload: {} });
    expect(acc1.statusCode).toBe(200);
    const acc2 = await app.inject({ method: "POST", url: `${V1}/me/credentials/${credA.id}/accept`, headers: auth(subjTok), payload: {} });
    expect(acc2.statusCode).toBe(409);
    expect(acc2.json().error).toBe("INVALID_ACCEPTANCE_STATE");

    const rej1 = await app.inject({ method: "POST", url: `${V1}/me/credentials/${credB.id}/reject`, headers: auth(subjTok), payload: {} });
    expect(rej1.statusCode).toBe(200);
    const rej2 = await app.inject({ method: "POST", url: `${V1}/me/credentials/${credB.id}/reject`, headers: auth(subjTok), payload: {} });
    expect(rej2.statusCode).toBe(409);
    expect(rej2.json().error).toBe("INVALID_ACCEPTANCE_STATE");
  });

  it("wrong holder: a different user's token on accept -> 404", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const { cred } = await pendingKyc(app, admin, admin2);

    const other = await subjectWithDid(app);
    const otherTok = await loginAs(app, other.email, other.password);
    const res = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/accept`, headers: auth(otherTok), payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe("consent gate — only accepted credentials are eligible (L3)", () => {
  it("consenting a PENDING credential -> 400 CREDENTIAL_NOT_ELIGIBLE; after accept -> 200; inbox excludes pending", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const { subjTok, cred } = await pendingKyc(app, admin, admin2);

    const verifierOrg = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `Consent Verifier ${Date.now()}`, orgType: "verifier" } })).json() as { id: string };
    const vMk = await app.inject({ method: "POST", url: `${V1}/orgs/${verifierOrg.id}/users`, headers: auth(admin), payload: { email: `vadmin-${Date.now()}@x.io`, password: "secret1", role: "OrgAdmin" } });
    expect(vMk.statusCode).toBe(201);
    const vTok = await loginAs(app, vMk.json().email, "secret1");

    const created = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(vTok), payload: { holderDid: cred.holderDid, requestedTypes: ["KycCredential"], purpose: "onboarding" } });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().id as string;

    const inbox0 = (await app.inject({ method: "GET", url: `${V1}/me/verification-requests`, headers: auth(subjTok) })).json() as { id: string; eligibleCredentials: { id: string }[] }[];
    expect(inbox0.find((r) => r.id === requestId)!.eligibleCredentials.find((c) => c.id === cred.id)).toBeUndefined();

    const consentPending = await app.inject({ method: "POST", url: `${V1}/verification-requests/${requestId}/consent`, headers: auth(subjTok), payload: { credentialIds: [cred.id] } });
    expect(consentPending.statusCode).toBe(400);
    expect(consentPending.json().error).toBe("CREDENTIAL_NOT_ELIGIBLE");

    const acceptRes = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/accept`, headers: auth(subjTok), payload: {} });
    expect(acceptRes.statusCode).toBe(200);

    const inbox1 = (await app.inject({ method: "GET", url: `${V1}/me/verification-requests`, headers: auth(subjTok) })).json() as { id: string; eligibleCredentials: { id: string }[] }[];
    expect(inbox1.find((r) => r.id === requestId)!.eligibleCredentials.find((c) => c.id === cred.id)).toBeDefined();

    const consentAfter = await app.inject({ method: "POST", url: `${V1}/verification-requests/${requestId}/consent`, headers: auth(subjTok), payload: { credentialIds: [cred.id] } });
    expect(consentAfter.statusCode).toBe(200);
  });
});

describe("ID-H identity gate on acceptance-enabled KYC (L3)", () => {
  const TREASURY_ADDR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
  const BUYER_WALLET = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";

  async function issuePricedCarbonAsset(app: Awaited<ReturnType<typeof buildTestApp>>, platformToken: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(platformToken),
      payload: {
        useCaseKey: "carbon-credit", name: "L3 Identity Gate Asset", chainId: "fabric",
        metadata: { projectName: "P", registry: "Verra", vintage: 2024 },
        sale: { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
        treasuryAccount: TREASURY_ADDR, initialSupply: "100",
      },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().asset as { id: string }).id;
  }

  async function enableIdentityGate(app: Awaited<ReturnType<typeof buildTestApp>>, platformToken: string): Promise<void> {
    const carbon = (await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit`, headers: auth(platformToken) })).json();
    const put = await app.inject({
      method: "PUT", url: `${V1}/use-cases/carbon-credit`, headers: auth(platformToken),
      payload: { ...carbon, compliance: { ...carbon.compliance, requireVerifiedIdentity: true } },
    });
    expect(put.statusCode).toBe(200);
  }

  async function fundAndAllow(app: Awaited<ReturnType<typeof buildTestApp>>, platformToken: string, assetId: string): Promise<void> {
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(platformToken), payload: { account: BUYER_WALLET } });
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platformToken), payload: { account: BUYER_WALLET, currency: "CBDC-INR", amount: "1000" } });
  }

  it("buy refused (IDENTITY_NOT_VERIFIED) while the KYC use-case credential is pending; succeeds after accept", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    const assetId = await issuePricedCarbonAsset(app, platform);
    await enableIdentityGate(app, platform);
    await seedUseCase(app, platform, { holderAcceptance: true });

    const buyer = await onboardUser(app, carbonAdmin, platform, {
      email: "l3-acc-buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET,
    });
    const patchRes = await app.inject({ method: "PATCH", url: `${V1}/users/${buyer.id}`, headers: auth(platform), payload: { kycStatus: "approved" } });
    expect(patchRes.statusCode).toBe(200);
    await issueUsecaseCredential(app, platform, admin2, buyer.id);
    await fundAndAllow(app, platform, assetId);

    const buyerToken = await loginAs(app, "l3-acc-buyer@x.dev", "secret1");
    const buyPending = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(buyPending.statusCode).toBe(400);
    expect(buyPending.json().error).toBe("IDENTITY_NOT_VERIFIED");

    const kycCred = (await heldOf(app, buyerToken)).find((c) => c.type.includes("KycCredential"))!;
    expect(kycCred.acceptance).toBe("pending");
    const acceptRes = await app.inject({ method: "POST", url: `${V1}/me/credentials/${kycCred.id}/accept`, headers: auth(buyerToken), payload: {} });
    expect(acceptRes.statusCode).toBe(200);

    const buyOk = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(buyOk.statusCode).toBe(200);
  });
});

describe("certificate gate on acceptance-enabled use case (L3)", () => {
  it("certificateAvailable false + 404 while pending; certificateAvailable true + 200 %PDF- after accept", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const DEF = {
      key: "domicile-cert-acc", name: "Domicile Acc",
      credentialTypes: [{
        name: "DomicileCredential", title: "Domicile Certificate", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["fullName", "district"], properties: { fullName: { type: "string" }, district: { type: "string" } } },
        certificate: { enabled: true, heading: "Certificate of Domicile", claimOrder: ["fullName", "district"] },
      }],
      issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      holderAcceptance: true,
    };
    const r = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
    expect(r.statusCode).toBe(201);
    const subject = await subjectWithDid(app);
    const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/domicile-cert-acc/credentials`, headers: auth(admin),
      payload: { credentialType: "DomicileCredential", subjectUserId: subject.id, claims: { fullName: "Asha Rao", district: "Pune" } } });
    expect(issued.statusCode).toBe(202);
    const approved = await app.inject({ method: "POST", url: `${V1}/proposals/${issued.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    expect(approved.statusCode).toBe(200);

    const subjTok = await loginAs(app, subject.email, subject.password);
    const held0 = (await heldOf(app, subjTok)) as (HeldCredential & { certificateAvailable: boolean })[];
    const cred = held0.find((c) => c.type.includes("DomicileCredential"))!;
    expect(cred.acceptance).toBe("pending");
    expect(cred.certificateAvailable).toBe(false);

    const pdf0 = await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/certificate.pdf` });
    expect(pdf0.statusCode).toBe(404);

    const acceptRes = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/accept`, headers: auth(subjTok), payload: {} });
    expect(acceptRes.statusCode).toBe(200);

    const held1 = (await heldOf(app, subjTok)) as (HeldCredential & { certificateAvailable: boolean })[];
    const after = held1.find((c) => c.id === cred.id)!;
    expect(after.certificateAvailable).toBe(true);

    const pdf1 = await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/certificate.pdf` });
    expect(pdf1.statusCode).toBe(200);
    const buf = pdf1.rawPayload ?? Buffer.from(pdf1.payload, "binary");
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("public status includes acceptance (L3)", () => {
  it("status reports acceptance: pending, then accepted", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const { subjTok, cred } = await pendingKyc(app, admin, admin2);

    const status0 = await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/status` });
    expect(status0.statusCode).toBe(200);
    expect(status0.json().acceptance).toBe("pending");

    const acceptRes = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/accept`, headers: auth(subjTok), payload: {} });
    expect(acceptRes.statusCode).toBe(200);

    const status1 = await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/status` });
    expect(status1.statusCode).toBe(200);
    expect(status1.json().acceptance).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// L3 follow-up: ORG-held pending credentials (subjectOrgId) must be acceptable
// by the holding org's OrgAdmin — not just a personal-DID holder.
// ---------------------------------------------------------------------------

async function makeOrg(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, name: string, orgType = "corporate") {
  const r = await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name, orgType } });
  expect(r.statusCode).toBe(201);
  return r.json() as { id: string; did: string; name: string };
}

async function addOrgAdmin(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, orgId: string): Promise<string> {
  const email = `orgadmin-${Math.random().toString(36).slice(2)}@x.dev`;
  const password = "secret1";
  const r = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(admin), payload: { email, password, role: "OrgAdmin" } });
  expect(r.statusCode).toBe(201);
  return loginAs(app, email, password);
}

describe("org-held pending credentials — acceptable by the holding org's OrgAdmin (L3 fix)", () => {
  async function pendingOrgKyc(admin: string, admin2: string, app: Awaited<ReturnType<typeof buildTestApp>>) {
    await seedUseCase(app, admin, { holderAcceptance: true });
    const org = await makeOrg(app, admin, `Org Holder ${Date.now()}`);
    const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(admin),
      payload: { credentialType: "KycCredential", subjectOrgId: org.id, claims: { legalName: "Acme Ltd", country: "IN" } } });
    expect(issued.statusCode).toBe(202);
    const approved = await app.inject({ method: "POST", url: `${V1}/proposals/${issued.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    expect(approved.statusCode).toBe(200);
    const wallet = (await app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/wallet`, headers: auth(admin) })).json() as { id: string; holderDid: string; type: string[]; acceptance: string }[];
    const cred = wallet.find((c) => c.holderDid === org.did && c.type.includes("KycCredential"))!;
    expect(cred).toBeDefined();
    expect(cred.acceptance).toBe("pending");
    return { org, cred };
  }

  it("the org's OrgAdmin can accept an org-held pending credential", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const { org, cred } = await pendingOrgKyc(admin, admin2, app);
    const orgAdminTok = await addOrgAdmin(app, admin, org.id);

    const res = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/accept`, headers: auth(orgAdminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().acceptance).toBe("accepted");

    const wallet = (await app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/wallet`, headers: auth(admin) })).json() as { id: string; acceptance: string }[];
    expect(wallet.find((c) => c.id === cred.id)!.acceptance).toBe("accepted");
  });

  it("a DIFFERENT org's OrgAdmin gets 404", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const { cred } = await pendingOrgKyc(admin, admin2, app);
    const otherOrg = await makeOrg(app, admin, `Other Org ${Date.now()}`);
    const otherOrgAdminTok = await addOrgAdmin(app, admin, otherOrg.id);

    const res = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/accept`, headers: auth(otherOrgAdminTok), payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("a plain user (not an OrgAdmin) gets 404", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const { cred } = await pendingOrgKyc(admin, admin2, app);
    const plainUser = await subjectWithDid(app);
    const plainTok = await loginAs(app, plainUser.email, plainUser.password);

    const res = await app.inject({ method: "POST", url: `${V1}/me/credentials/${cred.id}/accept`, headers: auth(plainTok), payload: {} });
    expect(res.statusCode).toBe(404);
  });
});
