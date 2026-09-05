import { describe, it, expect } from "vitest";
import { buildTestApp, buildTestAppWithRepos, V1, loginAs, auth, onboardUser } from "./helpers.js";

const BUYER_WALLET = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";

interface AssetSummary { id: string }

/** Mirrors identity-gate.test.ts's fixture: a priced carbon-credit asset,
 * issued BEFORE requireVerifiedIdentity is turned on so the treasury mint
 * itself is never gated. */
async function issuePricedCarbonAsset(app: Awaited<ReturnType<typeof buildTestApp>>, platformToken: string): Promise<string> {
  const res = await app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(platformToken),
    payload: {
      useCaseKey: "carbon-credit", name: "Admin KYC Test Asset", chainId: "fabric",
      metadata: { projectName: "P", registry: "Verra", vintage: 2024 },
      sale: { unitPrice: "5", currency: "CBDC-INR" },
      initialSupply: "100",
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json().asset as AssetSummary).id;
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

describe("POST /users/:id/identity/issue-kyc — admin-issued KYC for a user with no external credential to present", () => {
  it("mints a DID and a local KycCredential for a DID-less user, unblocking a requireVerifiedIdentity buy", async () => {
    const { app, users } = await buildTestAppWithRepos();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    const assetId = await issuePricedCarbonAsset(app, platform);
    await enableIdentityGate(app, platform);

    // Onboarded with NO kyc block — onboarding still mints a DID unconditionally,
    // but issues no credential without one: exactly the "has an identity, no proof
    // of KYC" state a boot-seeded demo user (no onboarding at all) also ends up in.
    const buyer = await onboardUser(app, carbonAdmin, platform, {
      email: "admin-kyc-buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET,
    });
    // Approve KYC status out-of-band so the `allow` action's own KYC_NOT_APPROVED
    // check doesn't mask the identity gate this test actually exercises.
    await users.update(buyer.id, { kycStatus: "approved" });
    await fundAndAllow(app, platform, assetId);

    // Blocked before issuance.
    const buyerToken = await loginAs(app, "admin-kyc-buyer@x.dev", "secret1");
    const blocked = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toBe("IDENTITY_NOT_VERIFIED");

    // The UseCaseAdmin issues KYC directly — no presented credential involved.
    const issueRes = await app.inject({
      method: "POST", url: `${V1}/users/${buyer.id}/identity/issue-kyc`, headers: auth(carbonAdmin),
      payload: { legalName: "Admin KYC Buyer", country: "IN" },
    });
    expect(issueRes.statusCode).toBe(200);
    const body = issueRes.json();
    expect(body.did).toMatch(/^did:/);
    expect(body.credentialId).toBeTruthy();

    // The user's own row now carries the approved KYC status.
    const list = (await app.inject({ method: "GET", url: `${V1}/users`, headers: auth(carbonAdmin) })).json() as { id: string; kycStatus?: string }[];
    expect(list.find((u) => u.id === buyer.id)?.kycStatus).toBe("approved");

    // The credential is genuinely held, not just referenced.
    const held = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(buyerToken) })).json() as { id: string; type: string[] }[];
    expect(held.some((c) => c.id === body.credentialId && c.type.includes("KycCredential"))).toBe(true);

    // And the previously-blocked buy now succeeds.
    const unblocked = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(unblocked.statusCode).toBe(200);
  });

  it("is idempotent on the DID: re-issuing to an already-DID'd user reuses the same DID", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const buyer = await onboardUser(app, carbonAdmin, platform, {
      email: "twice-kyc-buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET,
    });
    const first = await app.inject({
      method: "POST", url: `${V1}/users/${buyer.id}/identity/issue-kyc`, headers: auth(carbonAdmin),
      payload: { legalName: "Twice Buyer", country: "IN" },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST", url: `${V1}/users/${buyer.id}/identity/issue-kyc`, headers: auth(carbonAdmin),
      payload: { legalName: "Twice Buyer", country: "IN" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().did).toBe(first.json().did);
    expect(second.json().credentialId).not.toBe(first.json().credentialId);
  });

  it("mints a DID for a genuinely DID-less user (SUBJECT_IDENTIFIERS=plain skips DID minting at onboarding)", async () => {
    const app = await buildTestApp({ subjectIdentifiers: "plain" });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const buyer = await onboardUser(app, carbonAdmin, platform, {
      email: "plain-kyc-buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET,
    });
    expect(buyer.did).toBeFalsy();
    const res = await app.inject({
      method: "POST", url: `${V1}/users/${buyer.id}/identity/issue-kyc`, headers: auth(carbonAdmin),
      payload: { legalName: "Plain Buyer", country: "IN" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().did).toMatch(/^did:/);
  });

  it("refuses a cross-tenant UseCaseAdmin (not this user's use case)", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const bondAdmin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const buyer = await onboardUser(app, carbonAdmin, platform, {
      email: "scoped-kyc-buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET,
    });
    const res = await app.inject({
      method: "POST", url: `${V1}/users/${buyer.id}/identity/issue-kyc`, headers: auth(bondAdmin),
      payload: { legalName: "Scoped Buyer", country: "IN" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects claims missing the required legalName/country shape", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const buyer = await onboardUser(app, carbonAdmin, platform, {
      email: "bad-claims-buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET,
    });
    const res = await app.inject({
      method: "POST", url: `${V1}/users/${buyer.id}/identity/issue-kyc`, headers: auth(carbonAdmin),
      payload: { legalName: "", country: "not-a-code" },
    });
    expect(res.statusCode).toBe(400);
  });
});
