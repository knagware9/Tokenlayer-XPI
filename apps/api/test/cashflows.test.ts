import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

const UC = "invoice-tokenization";
const HOLDER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Carol — seeded account, linkable
const inv = (n: string, due: string) => ({ invoiceNumber: n, sellerGstin: "27AAECS1234F1Z5", buyerGstin: "29AABCU9876R1Z3", amountInr: 1000000, dueDate: due });

async function desk(app: FastifyInstance): Promise<string> {
  const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
  await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: "cf.holder@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { country: "IN" } } });
  return admin;
}

async function issueInvoice(app: FastifyInstance, admin: string, n: string, due: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { useCaseKey: UC, name: n, chainId: "fabric", initialSupply: "10000", treasuryAccount: HOLDER, metadata: inv(n, due) } });
  expect(res.statusCode).toBe(201);
  return res.json().asset.id as string;
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
    // Fund a payer account (buyer repayment landing) — use the platform admin's cash faucet.
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const PAYER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // Treasury (seeded)
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: PAYER, currency: "CBDC-INR", amount: "1000000" } });
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const cfId = cashflows[0].id;

    const exec = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cfId}/execute`, headers: auth(admin), payload: { from: PAYER } });
    expect(exec.statusCode).toBe(200);
    // Holder received face value.
    const bal = (await app.inject({ method: "GET", url: `${V1}/cash/balances?address=${HOLDER}`, headers: auth(platform) })).json();
    expect(bal.find((b: { currency: string }) => b.currency === "CBDC-INR")?.amount).toBe("1000000");
    // Tokens burned; asset matured.
    const accounts = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/accounts`, headers: auth(admin) })).json();
    expect(accounts.find((a: { address: string }) => a.address.toLowerCase() === HOLDER.toLowerCase())?.balance ?? "0").toBe("0");
    const asset = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(admin) })).json();
    expect(asset.status).toBe("matured");
    // Re-execute → 409.
    const again = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cfId}/execute`, headers: auth(admin), payload: { from: PAYER } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("ALREADY_EXECUTED");
  });

  it("redemption without payer funds → INSUFFICIENT_TREASURY_FUNDS; without payer → NO_PAYER", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-11", "2099-12-31");
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const noPayer = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(admin), payload: {} });
    expect(noPayer.statusCode).toBe(400);
    expect(noPayer.json().error).toBe("NO_PAYER");
    const broke = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(admin), payload: { from: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" } });
    expect(broke.statusCode).toBe(400);
    expect(broke.json().error).toBe("INSUFFICIENT_TREASURY_FUNDS");
  });

  it("redemption is blocked while an open listing escrows tokens", async () => {
    const app = await buildTestApp();
    const admin = await desk(app);
    const assetId = await issueInvoice(app, admin, "INV-CF-12", "2099-12-31");
    // Holder lists 100 tokens (holder session).
    const holderTok = await loginAs(app, "cf.holder@x.dev", "secret1");
    const list = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(holderTok), payload: { quantity: "100", unitPrice: "92", currency: "CBDC-INR" } });
    expect([200, 201]).toContain(list.statusCode);
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const exec = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(admin), payload: { from: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" } });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error).toBe("OPEN_LISTINGS_BLOCK_SETTLEMENT");
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
});
