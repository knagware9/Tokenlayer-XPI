import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, onboardUser, V1 } from "./helpers.js";

const KEY = "invoice-tokenization";
const row = { invoiceNumber: "REG-1", invoiceDate: "2026-07-05", buyerName: "JSW Steel", currency: "INR", amount: 1800000, dueDate: "2026-10-15" };
// A seeded demo wallet not linked to any seeded user — the invoice use case gates
// token receipt on IN jurisdiction, so the treasury that supply mints into must
// resolve to IN. Onboard an IN-KYC holder linked to this wallet before tokenizing.
const TREASURY = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

describe("invoice register", () => {
  it("import stages rows, flags in-batch + existing duplicates and invalid rows", async () => {
    const app = await buildTestApp();
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const res = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/import`, headers: { authorization: `Bearer ${issuer}` },
      payload: { rows: [row, row, { ...row, invoiceNumber: "REG-2", amount: "not-a-number" }, { ...row, invoiceNumber: "REG-3" }] } });
    expect(res.statusCode).toBe(200);
    expect((res.json().results as { status: string }[]).map((r) => r.status)).toEqual(["staged", "duplicate", "invalid", "staged"]);
    const list = (await app.inject({ method: "GET", url: `${V1}/use-cases/${KEY}/invoices?status=staged`, headers: { authorization: `Bearer ${issuer}` } })).json();
    expect(list).toHaveLength(2);
    expect(list[0].invoiceHash).toMatch(/^0x/);
  });

  it("pull-erp stages the sample file; a second pull is all duplicates", async () => {
    const app = await buildTestApp();
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const first = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/pull-erp`, headers: { authorization: `Bearer ${issuer}` }, payload: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json().staged).toBeGreaterThan(0);
    const again = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/pull-erp`, headers: { authorization: `Bearer ${issuer}` }, payload: {} });
    expect(again.json().staged).toBe(0);
    expect((again.json().results as { status: string }[]).every((r) => r.status === "duplicate")).toBe(true);
  });

  it("selective tokenize: chosen staged rows become assets; others stay staged; re-tokenize skipped", async () => {
    const app = await buildTestApp();
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    // Gated onboarding of an IN-KYC holder linked to TREASURY so the supply mint resolves to IN.
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await onboardUser(app, admin, platform, { email: "reg.holder@x.dev", password: "secret1", role: "Buyer", walletAddress: TREASURY, kyc: { legalName: "Reg Holder", country: "IN" } });
    const ids = (await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/import`, headers: { authorization: `Bearer ${issuer}` },
      payload: { rows: [row, { ...row, invoiceNumber: "REG-2" }, { ...row, invoiceNumber: "REG-3" }] } })).json().results.map((r: { id: string }) => r.id);
    const tok = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/tokenize`, headers: { authorization: `Bearer ${issuer}` },
      payload: { ids: [ids[0], ids[1]], chainId: "fabric", treasuryAccount: TREASURY } });
    expect(tok.statusCode).toBe(200);
    expect((tok.json().results as { status: string }[]).filter((r) => r.status === "tokenized")).toHaveLength(2);
    const staged2 = (await app.inject({ method: "GET", url: `${V1}/use-cases/${KEY}/invoices?status=staged`, headers: { authorization: `Bearer ${issuer}` } })).json();
    expect(staged2).toHaveLength(1);
    const retry = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/tokenize`, headers: { authorization: `Bearer ${issuer}` }, payload: { ids: [ids[0]], chainId: "fabric", treasuryAccount: TREASURY } });
    expect((retry.json().results as { status: string }[])[0].status).toBe("skipped");
  });

  it("delete staged ok, tokenized 409-guarded; foreign-use-case issuer 403", async () => {
    const app = await buildTestApp();
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const id = (await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/import`, headers: { authorization: `Bearer ${issuer}` }, payload: { rows: [row] } })).json().results[0].id;
    expect((await app.inject({ method: "DELETE", url: `${V1}/use-cases/${KEY}/invoices/${id}`, headers: { authorization: `Bearer ${issuer}` } })).statusCode).toBe(200);
    const carbon = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");
    const forbidden = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/import`, headers: { authorization: `Bearer ${carbon}` }, payload: { rows: [row] } });
    expect(forbidden.statusCode).toBe(403);
  });
});
