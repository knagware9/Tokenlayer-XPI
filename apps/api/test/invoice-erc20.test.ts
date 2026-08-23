import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";
import { invoiceFingerprint } from "@tokenlayer/core";

const UC = "invoice-tokenization";
const inv = { invoiceNumber: "INV-9001", invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2026-12-31" };

// Log in as the seeded invoice desk admin (UseCaseAdmin). The initial supply
// mints into the use case's own registered treasury (org-treasury-accounts
// Task 5: server-derived, never client-supplied), which is exempt from the
// IN-jurisdiction gate as the use case's own operational reserve — no holder
// needs to be onboarded here just to receive the mint.
async function invoiceAdmin(app: FastifyInstance): Promise<string> {
  return loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
}

describe("invoice ERC-20 issue", () => {
  it("derives invoiceHash from canonical fields, ignoring any client value", async () => {
    const app = await buildTestApp();
    const admin = await invoiceAdmin(app);
    const res = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: {
      useCaseKey: UC, name: inv.invoiceNumber, chainId: "fabric", initialSupply: "10000",
      metadata: { ...inv, invoiceHash: "0x" + "00".repeat(32) }, // bogus — must be ignored
    }});
    expect(res.statusCode).toBe(201);
    expect(res.json().asset.metadata.invoiceHash).toBe(invoiceFingerprint(inv));
  });

  it("rejects a duplicate invoice (same fingerprint) with 409 DUPLICATE_ASSET", async () => {
    const app = await buildTestApp();
    const admin = await invoiceAdmin(app);
    const body = { useCaseKey: UC, name: inv.invoiceNumber, chainId: "fabric", initialSupply: "10000", metadata: { ...inv } };
    expect((await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: body })).statusCode).toBe(201);
    const dup = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { ...body, name: "dup" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("DUPLICATE_ASSET");
  });
});
