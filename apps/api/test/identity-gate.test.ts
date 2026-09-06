import { describe, it, expect } from "vitest";
import { buildTestApp, buildTestAppWithRepos, V1, loginAs, auth, onboardUser, approveAssetForTest } from "./helpers.js";

const BUYER_WALLET = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";

interface AssetSummary { id: string }

/** Issues a priced carbon-credit asset with an initial treasury supply, BEFORE
 * any requireVerifiedIdentity rule is added — so the treasury mint itself is
 * never gated, isolating the buy leg the tests actually exercise. Every asset
 * now starts `pending_approval` with its mint + sale terms deferred; complete
 * due diligence via the shared helper so callers get back an active, priced asset. */
async function issuePricedCarbonAsset(app: Awaited<ReturnType<typeof buildTestApp>>, platformToken: string): Promise<string> {
  const res = await app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(platformToken),
    payload: {
      useCaseKey: "carbon-credit", name: "Identity Gate Asset", chainId: "fabric",
      metadata: { projectName: "P", registry: "Verra", vintage: 2024 },
      sale: { unitPrice: "5", currency: "CBDC-INR" },
      initialSupply: "100",
    },
  });
  expect(res.statusCode).toBe(202);
  const assetId = (res.json().asset as AssetSummary).id;
  await approveAssetForTest(app, assetId, "carbon-credit");
  return assetId;
}

/** Flips requireVerifiedIdentity on the carbon-credit use case, preserving its
 * existing compliance config (mirrors the allowedJurisdictions test). */
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

describe("identity gate: requireVerifiedIdentity blocks buy without a held, unrevoked KycCredential", () => {
  it("buyer holds an unrevoked KycCredential -> buy succeeds", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    const assetId = await issuePricedCarbonAsset(app, platform);
    await enableIdentityGate(app, platform);

    // kyc present at onboarding -> onboardUserKind mints a KycCredential to the
    // buyer's custodial DID and sets kycStatus "approved" automatically.
    await onboardUser(app, carbonAdmin, platform, {
      email: "verified-buyer@x.dev", password: "secret1", role: "Buyer",
      walletAddress: BUYER_WALLET, kyc: { legalName: "Verified Buyer", country: "IN" },
    });
    await fundAndAllow(app, platform, assetId);

    const buyerToken = await loginAs(app, "verified-buyer@x.dev", "secret1");
    const buyRes = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(buyRes.statusCode).toBe(200);
  });

  it("buyer holds NO KycCredential -> buy fails with IDENTITY_NOT_VERIFIED", async () => {
    const { app, users } = await buildTestAppWithRepos();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    const assetId = await issuePricedCarbonAsset(app, platform);
    await enableIdentityGate(app, platform);

    // No `kyc` -> onboarding mints the buyer's custodial DID but issues no
    // credential. kycStatus is approved out-of-band (PATCH) so the `allow`
    // action's own KYC_NOT_APPROVED check does not mask the identity gate.
    const buyer = await onboardUser(app, carbonAdmin, platform, {
      email: "unverified-buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET,
    });
    await users.update(buyer.id, { kycStatus: "approved" });
    await fundAndAllow(app, platform, assetId);

    const buyerToken = await loginAs(app, "unverified-buyer@x.dev", "secret1");
    const buyRes = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(buyRes.statusCode).toBe(400);
    expect(buyRes.json().error).toBe("IDENTITY_NOT_VERIFIED");
  });

  it("buyer's KycCredential is revoked -> buy fails with IDENTITY_NOT_VERIFIED", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    const assetId = await issuePricedCarbonAsset(app, platform);
    await enableIdentityGate(app, platform);

    await onboardUser(app, carbonAdmin, platform, {
      email: "revoked-buyer@x.dev", password: "secret1", role: "Buyer",
      walletAddress: BUYER_WALLET, kyc: { legalName: "Revoked Buyer", country: "IN" },
    });
    await fundAndAllow(app, platform, assetId);
    const buyerToken = await loginAs(app, "revoked-buyer@x.dev", "secret1");

    // Find + revoke the buyer's own KycCredential via maker-checker (platform
    // is the issuing org for onboarding-issued credentials when the use case
    // has no ownerOrgId; a PlatformAdmin may act for it and needs a second,
    // DIFFERENT PlatformAdmin to approve — SELF_APPROVAL forbids proposer===approver).
    const held = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(buyerToken) })).json() as { id: string; type: string[] }[];
    const kycCred = held.find((c) => c.type.includes("KycCredential"));
    expect(kycCred).toBeTruthy();
    const revokeRes = await app.inject({ method: "POST", url: `${V1}/credentials/${kycCred!.id}/revoke`, headers: auth(platform), payload: { reason: "compromised" } });
    expect(revokeRes.statusCode).toBe(202);
    const proposalId = revokeRes.json().proposal.id;
    const approveRes = await app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(await loginAs(app, "admin2@tokenlayer.dev", "admin123")), payload: {} });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().proposal.status).toBe("executed");

    const buyRes = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(buyRes.statusCode).toBe(400);
    expect(buyRes.json().error).toBe("IDENTITY_NOT_VERIFIED");
  });

  it("requireVerifiedIdentity off (default) -> buy succeeds even without a KycCredential (back-compat)", async () => {
    const { app, users } = await buildTestAppWithRepos();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    const assetId = await issuePricedCarbonAsset(app, platform);
    // No enableIdentityGate() call: the flag stays unset/false.

    const buyer = await onboardUser(app, carbonAdmin, platform, {
      email: "nogate-buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET,
    });
    await users.update(buyer.id, { kycStatus: "approved" });
    await fundAndAllow(app, platform, assetId);

    const buyerToken = await loginAs(app, "nogate-buyer@x.dev", "secret1");
    const buyRes = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(buyRes.statusCode).toBe(200);
  });
});
