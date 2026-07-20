import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth, onboardUser } from "./helpers.js";

const INVESTOR_WALLET = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Carol — seeded account, unlinked
// Helios Energy Corp — seeded account NOT linked to any seeded user. The seeded
// "Treasury" wallet cannot be the invoice treasury here: three seeded issuers
// (kyc: null) already link to it, and jurisdictionOf resolves the FIRST linked
// user, so minting the initial supply to it fails the IN-jurisdiction gate.
const PAYER = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const inv = (n: string) => ({ invoiceNumber: n, invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2026-12-31" });

async function investorSetup(app: FastifyInstance): Promise<{ admin: string; investor: string }> {
  const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
  const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  // Gated onboarding with full KYC (legalName + country) → the checker's approval
  // mints the KycCredential and the investor lands KYC-approved with country IN.
  await onboardUser(app, admin, platform, { email: "inv.portal@x.dev", password: "secret1", role: "Buyer", walletAddress: INVESTOR_WALLET, kyc: { legalName: "Inv Portal", country: "IN" } });
  const investor = await loginAs(app, "inv.portal@x.dev", "secret1");
  return { admin, investor };
}

/** Link an IN-KYC user to the payer wallet BEFORE issuance: the issue mints the
 * initial supply to the treasury, and compliance checks its jurisdiction. */
async function linkPayer(app: FastifyInstance, admin: string, email: string): Promise<void> {
  const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  const user = await onboardUser(app, admin, platform, { email, password: "secret1", role: "Auditor", walletAddress: PAYER, kyc: { legalName: "Inv Payer", country: "IN" } });
  expect(user.kycStatus).toBe("approved");
}

describe("investor portal endpoints", () => {
  it("400 NO_WALLET when the caller has no linked wallet", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123"); // desk admin: no wallet
    const r = await app.inject({ method: "GET", url: `${V1}/me/portfolio`, headers: auth(admin) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("NO_WALLET");
  });

  it("portfolio: holdings + value from a subscription; activity records it", async () => {
    const app = await buildTestApp();
    const { admin, investor } = await investorSetup(app);
    await linkPayer(app, admin, "inv.payer@x.dev");
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { useCaseKey: "invoice-tokenization", name: "INV-PORT-1", chainId: "fabric", initialSupply: "1000", treasuryAccount: PAYER, metadata: inv("INV-PORT-1"), sale: { unitPrice: "920", currency: "CBDC-INR", treasuryAccount: PAYER } } });
    expect(issued.statusCode).toBe(201);
    const assetId = issued.json().asset.id;
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(admin), payload: { account: INVESTOR_WALLET } });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: INVESTOR_WALLET, currency: "CBDC-INR", amount: "500000" } });
    const buy = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(investor), payload: { quantity: "200" } });
    expect(buy.statusCode).toBe(200);

    const pf = (await app.inject({ method: "GET", url: `${V1}/me/portfolio`, headers: auth(investor) })).json();
    const holding = pf.holdings.find((h: { assetId: string }) => h.assetId === assetId);
    expect(holding.units).toBe("200");
    expect(holding.value).toBe("184000"); // 200 × 920 (unitPrice wins over face valuation)
    expect(pf.totalByCurrency["CBDC-INR"]).toBe("184000");
    expect(pf.cash.find((c: { currency: string }) => c.currency === "CBDC-INR").amount).toBe("316000");

    const act = (await app.inject({ method: "GET", url: `${V1}/me/activity`, headers: auth(investor) })).json();
    const sub = act.find((e: { kind: string }) => e.kind === "subscribed");
    expect(sub.units).toBe("200");
    expect(sub.amount).toBe("184000");
  });

  it("activity: redemption share matches what settlement actually paid", async () => {
    const app = await buildTestApp();
    const { admin, investor } = await investorSetup(app);
    await linkPayer(app, admin, "inv.payer2@x.dev");
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { useCaseKey: "invoice-tokenization", name: "INV-PORT-2", chainId: "fabric", initialSupply: "1000", treasuryAccount: PAYER, metadata: inv("INV-PORT-2"), sale: { unitPrice: "900", currency: "CBDC-INR", treasuryAccount: PAYER } } });
    expect(issued.statusCode).toBe(201);
    const assetId = issued.json().asset.id;
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(admin), payload: { account: INVESTOR_WALLET } });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: INVESTOR_WALLET, currency: "CBDC-INR", amount: "900000" } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(investor), payload: { quantity: "400" } }); // investor 400, payer keeps 600
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: PAYER, currency: "CBDC-INR", amount: "1000000" } });
    const cfs = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json().cashflows;
    const redemption = cfs.find((c: { kind: string }) => c.kind === "redemption");
    const proposed = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${redemption.id}/execute`, headers: auth(admin), payload: {} });
    expect(proposed.statusCode).toBe(202); // cashflow-execute is maker-checker gated for invoices
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const approved = await app.inject({ method: "POST", url: `${V1}/proposals/${proposed.json().proposal.id}/approve`, headers: auth(issuer), payload: {} });
    expect(approved.json().proposal.status).toBe("executed");

    const act = (await app.inject({ method: "GET", url: `${V1}/me/activity`, headers: auth(investor) })).json();
    const red = act.find((e: { kind: string }) => e.kind === "redemption");
    // Executor math (executeCashflowCore): splitProRata floors the FULL cashflow
    // amount over pre-burn balances INCLUDING the payer (payer 600, investor 400
    // of 1000), then dropPayerShare withholds the payer's slice. Investor gets
    // floor(1000000 × 400 / 1000) = 400000; the payer's 600000 never moves.
    expect(red.amount).toBe("400000");
    expect(red.units).toBe("400"); // from the recorded pre-burn units map
    // Cash trail: 900000 credited − 360000 buy (400 × 900) + 400000 redemption = 940000.
    const pf = (await app.inject({ method: "GET", url: `${V1}/me/portfolio`, headers: auth(investor) })).json();
    expect(pf.cash.find((c: { currency: string }) => c.currency === "CBDC-INR").amount).toBe("940000");
  });

  it("tenancy: another use case's assets never appear", async () => {
    const app = await buildTestApp();
    const { investor } = await investorSetup(app);
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    // Assert the cross-tenant issuance actually lands, or every() below goes vacuous.
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(carbon), payload: { useCaseKey: "carbon-credit", name: "VCU-X", chainId: "fabric", initialSupply: "10", treasuryAccount: INVESTOR_WALLET, metadata: { projectName: "P", registry: "Verra", vintage: 2024 } } });
    expect(issued.statusCode).toBe(201);
    const pf = (await app.inject({ method: "GET", url: `${V1}/me/portfolio`, headers: auth(investor) })).json();
    expect(pf.holdings.every((h: { useCaseKey: string }) => h.useCaseKey === "invoice-tokenization")).toBe(true);
  });

  it("400 NO_WALLET on /me/activity too", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const r = await app.inject({ method: "GET", url: `${V1}/me/activity`, headers: auth(admin) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("NO_WALLET");
  });
});
