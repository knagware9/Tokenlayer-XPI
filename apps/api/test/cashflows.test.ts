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
