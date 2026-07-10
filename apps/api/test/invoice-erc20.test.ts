import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";
import { invoiceFingerprint } from "@tokenlayer/core";

const UC = "invoice-tokenization";
// "Carol" — a seeded demo account not linked to any seeded user, so we can link
// it to an IN-KYC holder and use it as the treasury (mint gates on IN jurisdiction).
const HOLDER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const inv = { invoiceNumber: "INV-9001", sellerGstin: "27AAECS1234F1Z5", buyerGstin: "29AABCU9876R1Z3", amountInr: 1000000, dueDate: "2026-12-31" };

// Log in as the seeded invoice desk admin (UseCaseAdmin) and onboard an IN-KYC
// holder wallet — the invoice use case gates token receipt on IN jurisdiction,
// so the treasury that the initial supply mints into must resolve to IN.
async function invoiceAdmin(app: FastifyInstance): Promise<string> {
  const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
  await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: "m1.holder@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { country: "IN" } } });
  return admin;
}

describe("invoice ERC-20 issue", () => {
  it("derives invoiceHash from canonical fields, ignoring any client value", async () => {
    const app = await buildTestApp();
    const admin = await invoiceAdmin(app);
    const res = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: {
      useCaseKey: UC, name: inv.invoiceNumber, chainId: "fabric", initialSupply: "10000", treasuryAccount: HOLDER,
      metadata: { ...inv, invoiceHash: "0x" + "00".repeat(32) }, // bogus — must be ignored
    }});
    expect(res.statusCode).toBe(201);
    expect(res.json().asset.metadata.invoiceHash).toBe(invoiceFingerprint(inv));
  });

  it("rejects a duplicate invoice (same fingerprint) with 409 DUPLICATE_ASSET", async () => {
    const app = await buildTestApp();
    const admin = await invoiceAdmin(app);
    const body = { useCaseKey: UC, name: inv.invoiceNumber, chainId: "fabric", initialSupply: "10000", treasuryAccount: HOLDER, metadata: { ...inv } };
    expect((await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: body })).statusCode).toBe(201);
    const dup = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { ...body, name: "dup" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("DUPLICATE_ASSET");
  });
});
