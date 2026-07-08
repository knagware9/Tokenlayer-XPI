import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

const UC = "invoice-tokenization";
const HOLDER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Carol — seeded account, linkable
const PAYER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // seeded "Treasury" wallet — NOT in m1 scope until linked
const inv = (n: string, due: string) => ({ invoiceNumber: n, sellerGstin: "27AAECS1234F1Z5", buyerGstin: "29AABCU9876R1Z3", amountInr: 1000000, dueDate: due });

async function desk(app: FastifyInstance): Promise<string> {
  const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
  await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: "cf.holder@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { country: "IN" } } });
  return admin;
}

/**
 * Payer scoping (F1): the execute payer must be the asset's treasury or a
 * wallet linked into the caller's use case. Link the settlement wallet to an
 * IN-KYC Auditor on the desk — the realistic "settlement account" flow.
 */
async function linkPayer(app: FastifyInstance, admin: string): Promise<void> {
  const res = await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: "m1.settlement@x.dev", password: "secret1", role: "Auditor", walletAddress: PAYER, kyc: { country: "IN" } } });
  expect(res.statusCode).toBe(201);
}

async function issueInvoice(app: FastifyInstance, admin: string, n: string, due: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { useCaseKey: UC, name: n, chainId: "fabric", initialSupply: "10000", treasuryAccount: HOLDER, metadata: inv(n, due) } });
  expect(res.statusCode).toBe(201);
  return res.json().asset.id as string;
}

/**
 * The invoice use case gates cashflow-execute (maker-checker), so an execute is a
 * PROPOSAL: m1.admin proposes (202), then a distinct capability holder (m1.issuer)
 * approves — which runs the settlement as the proposer. Request-time guards
 * (NO_PAYER, OUT_OF_SCOPE, burn-gate, open-listings, ALREADY_EXECUTED) reject
 * before a proposal is ever created, so those responses pass straight through.
 */
async function settle(app: FastifyInstance, admin: string, assetId: string, cfId: string, payer: string) {
  const proposed = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cfId}/execute`, headers: auth(admin), payload: { from: payer } });
  if (proposed.statusCode !== 202) return proposed; // ungated result or a request-time guard error
  const approver = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
  return app.inject({ method: "POST", url: `${V1}/proposals/${proposed.json().proposal.id}/approve`, headers: auth(approver), payload: {} });
}

describe("cashflows: materialization + listing", () => {
  it("issuing an invoice materializes one redemption cashflow at the due date", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-1", "2099-12-31");
    const res = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const { cashflows, preview } = res.json();
    expect(cashflows).toHaveLength(1);
    expect(cashflows[0]).toMatchObject({ kind: "redemption", dueDate: "2099-12-31", amount: "1000000", currency: "CBDC-INR", status: "scheduled" });
    // Redemption is always payable → preview shows the holder's full share.
    expect(preview?.cashflowId).toBe(cashflows[0].id);
    expect(preview?.split?.find((s: { address: string }) => s.address.toLowerCase() === HOLDER.toLowerCase())?.amount).toBe("1000000");
  });

  it("a past due date reads as overdue (derived, not stored)", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-2", "2020-01-01");
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    expect(cashflows[0].status).toBe("overdue");
  });

  it("tenancy: a foreign use-case user gets 404", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-3", "2099-12-31");
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(carbon) })).statusCode).toBe(404);
  });
});

describe("cashflows: execution", () => {
  it("redemption: pays holders pro-rata from the payer, burns balances, matures the asset", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-10", "2099-12-31");
    // Fund a payer account (buyer repayment landing) — link it into the desk's
    // scope first, then use the platform admin's cash faucet.
    await linkPayer(app, admin);
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: PAYER, currency: "CBDC-INR", amount: "1000000" } });
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const cfId = cashflows[0].id;

    const exec = await settle(app, admin, assetId, cfId, PAYER);
    expect(exec.statusCode).toBe(200);
    expect(exec.json().proposal.status).toBe("executed"); // maker-checker settlement executed on approval
    // Holder received face value.
    const bal = (await app.inject({ method: "GET", url: `${V1}/cash/balances?address=${HOLDER}`, headers: auth(platform) })).json();
    expect(bal.find((b: { currency: string }) => b.currency === "CBDC-INR")?.amount).toBe("1000000");
    // Tokens burned; asset matured.
    const accounts = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/accounts`, headers: auth(admin) })).json();
    expect(accounts.find((a: { address: string }) => a.address.toLowerCase() === HOLDER.toLowerCase())?.balance ?? "0").toBe("0");
    const asset = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(admin) })).json();
    expect(asset.status).toBe("matured");
    // Re-execute → 409 (and stays 409 — the CAS claim never re-opens an executed row).
    const again = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cfId}/execute`, headers: auth(admin), payload: { from: PAYER } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("ALREADY_EXECUTED");
    const third = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cfId}/execute`, headers: auth(admin), payload: { from: PAYER } });
    expect(third.statusCode).toBe(409);
    // GET reflects the persisted terminal status.
    const after = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    expect(after.cashflows[0].status).toBe("executed");
    // A matured asset is frozen for state-changing lifecycle actions.
    const mint = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/mint`, headers: auth(admin), payload: { to: HOLDER, amount: "1" } });
    expect(mint.statusCode).toBe(409);
    expect(mint.json().error).toBe("ASSET_NOT_ACTIVE");
  });

  it("redemption without payer funds → INSUFFICIENT_TREASURY_FUNDS; without payer → NO_PAYER", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-11", "2099-12-31");
    await linkPayer(app, admin); // in scope but unfunded
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const noPayer = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(admin), payload: {} });
    expect(noPayer.statusCode).toBe(400); // NO_PAYER is a request-time guard (before any proposal)
    expect(noPayer.json().error).toBe("NO_PAYER");
    // Funds are checked at execution — for a gated settlement that is APPROVAL
    // time, so the proposal is created then fails on approval with the funds error.
    const broke = await settle(app, admin, assetId, cashflows[0].id, PAYER);
    expect(broke.statusCode).toBe(200);
    expect(broke.json().proposal.status).toBe("failed");
    expect(broke.json().proposal.error).toContain("INSUFFICIENT_TREASURY_FUNDS");
  });

  it("redemption is blocked while an open listing escrows tokens", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-12", "2099-12-31");
    // Holder lists 100 tokens (holder session).
    const holderTok = await loginAs(app, "cf.holder@x.dev", "secret1");
    const list = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(holderTok), payload: { quantity: "100", unitPrice: "92", currency: "CBDC-INR" } });
    expect([200, 201]).toContain(list.statusCode);
    // Scope + fund the payer so the request reaches the open-listings guard.
    await linkPayer(app, admin);
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: PAYER, currency: "CBDC-INR", amount: "1000000" } });
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const exec = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(admin), payload: { from: PAYER } });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error).toBe("OPEN_LISTINGS_BLOCK_SETTLEMENT");
    // The failed attempt released its claim — the row is retryable, not stuck "executing".
    const after = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    expect(after.cashflows[0].status).toBe("scheduled");
  });

  it("payer scoping: a wallet linked to another use case's user → 403 OUT_OF_SCOPE", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-13", "2099-12-31");
    // Link a foreign wallet to a carbon-credit user — visible only to that use case.
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const FOREIGN = "0x976EA74026E726554dB657fA54763abd0C3a0aa9"; // GreenWing Airlines (seeded, unlinked)
    const created = await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(carbon), payload: { email: "carbon.settle@x.dev", password: "secret1", role: "Auditor", walletAddress: FOREIGN, kyc: { country: "IN" } } });
    expect(created.statusCode).toBe(201);
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const exec = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(admin), payload: { from: FOREIGN } });
    expect(exec.statusCode).toBe(403);
    expect(exec.json().error).toBe("OUT_OF_SCOPE");
  });

  it("redemption requires the 'burn' capability: an Issuer is rejected before any cash moves", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-14", "2099-12-31");
    await linkPayer(app, admin);
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: PAYER, currency: "CBDC-INR", amount: "1000000" } });
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const exec = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(issuer), payload: { from: PAYER } });
    expect(exec.statusCode).toBe(403);
    expect(exec.json().error).toBe("FORBIDDEN");
    expect(exec.json().message).toContain("burn");
    // Rejected up front — the payer's balance is untouched.
    const bal = (await app.inject({ method: "GET", url: `${V1}/cash/balances?address=${PAYER}`, headers: auth(platform) })).json();
    expect(bal.find((b: { currency: string }) => b.currency === "CBDC-INR")?.amount).toBe("1000000");
  });

  it("a future coupon is NOT_DUE (bond-style use case created on the fly)", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // Minimal fungible use case with quarterly terms, far maturity.
    const def = {
      key: "cf-note", name: "CF Note", tokenStandard: "ERC-20", symbol: "CFN",
      allowedChainIds: ["fabric"], defaultChainId: "fabric",
      metadataSchema: { type: "object", properties: { faceValue: { type: "number" }, couponRate: { type: "number" }, maturityDate: { type: "string" } }, required: ["faceValue"] },
      lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
      compliance: { allowlist: false, transferRestrictions: false },
      terms: { principalField: "faceValue", maturityField: "maturityDate", rateField: "couponRate", frequency: "quarterly", currency: "CBDC-INR" },
      roles: ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"],
    };
    expect((await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(platform), payload: def })).statusCode).toBe(201);
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(platform), payload: { useCaseKey: "cf-note", name: "NOTE-1", chainId: "fabric", initialSupply: "1000", treasuryAccount: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", metadata: { faceValue: 1000000, couponRate: 10, maturityDate: "2099-12-31" } } });
    expect(issued.statusCode).toBe(201);
    const assetId = issued.json().asset.id;
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(platform) })).json();
    const coupon = cashflows.find((c: { kind: string }) => c.kind === "coupon");
    expect(coupon).toBeTruthy();
    const exec = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${coupon.id}/execute`, headers: auth(platform), payload: { from: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" } });
    expect(exec.statusCode).toBe(400);
    expect(exec.json().error).toBe("NOT_DUE");
  });

  it("redemption cannot leapfrog unexecuted coupons → 409 COUPONS_OUTSTANDING", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // Monthly terms maturing ~40 days out → at least one coupon precedes the redemption.
    const maturity = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const def = {
      key: "cf-note-2", name: "CF Note 2", tokenStandard: "ERC-20", symbol: "CFN2",
      allowedChainIds: ["fabric"], defaultChainId: "fabric",
      metadataSchema: { type: "object", properties: { faceValue: { type: "number" }, couponRate: { type: "number" }, maturityDate: { type: "string" } }, required: ["faceValue"] },
      lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
      compliance: { allowlist: false, transferRestrictions: false },
      terms: { principalField: "faceValue", maturityField: "maturityDate", rateField: "couponRate", frequency: "monthly", currency: "CBDC-INR" },
      roles: ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"],
    };
    expect((await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(platform), payload: def })).statusCode).toBe(201);
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(platform), payload: { useCaseKey: "cf-note-2", name: "NOTE-2", chainId: "fabric", initialSupply: "1000", treasuryAccount: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", metadata: { faceValue: 1000000, couponRate: 12, maturityDate: maturity } } });
    expect(issued.statusCode).toBe(201);
    const assetId = issued.json().asset.id;
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(platform) })).json();
    expect(cashflows.some((c: { kind: string }) => c.kind === "coupon")).toBe(true);
    const redemption = cashflows.find((c: { kind: string }) => c.kind === "redemption");
    const exec = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${redemption.id}/execute`, headers: auth(platform), payload: { from: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" } });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error).toBe("COUPONS_OUTSTANDING");
  });

  it("invalid terms metadata → 400 INVALID_TERMS with NO ghost asset created", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const def = {
      key: "cf-note-3", name: "CF Note 3", tokenStandard: "ERC-20", symbol: "CFN3",
      allowedChainIds: ["fabric"], defaultChainId: "fabric",
      metadataSchema: { type: "object", properties: { faceValue: { type: "number" }, couponRate: { type: "number" }, maturityDate: { type: "string" } }, required: ["faceValue"] },
      lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
      compliance: { allowlist: false, transferRestrictions: false },
      terms: { principalField: "faceValue", maturityField: "maturityDate", rateField: "couponRate", frequency: "quarterly", currency: "CBDC-INR" },
      roles: ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"],
    };
    expect((await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(platform), payload: def })).statusCode).toBe(201);
    // Periodic frequency + maturity present but NO couponRate → INVALID_TERMS.
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(platform), payload: { useCaseKey: "cf-note-3", name: "NOTE-3", chainId: "fabric", metadata: { faceValue: 1000000, maturityDate: "2099-12-31" } } });
    expect(issued.statusCode).toBe(400);
    expect(issued.json().error).toBe("INVALID_TERMS");
    // No ghost: the failed issuance left no asset row behind.
    const list = (await app.inject({ method: "GET", url: `${V1}/assets?useCaseKey=cf-note-3`, headers: auth(platform) })).json();
    expect(list.data).toHaveLength(0);
  });
});
