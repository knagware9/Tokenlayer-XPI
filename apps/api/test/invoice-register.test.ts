import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1 } from "./helpers.js";

const KEY = "invoice-tokenization";
const row = { invoiceNumber: "REG-1", invoiceDate: "2026-07-05", buyerName: "JSW Steel", currency: "INR", amount: 1800000, dueDate: "2026-10-15" };

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
    // The tokenized supply mints into the use case's own registered treasury
    // (org-treasury-accounts Task 5: server-derived, never client-supplied),
    // which is exempt from the IN-jurisdiction gate as the use case's own
    // operational reserve — no holder needs onboarding just to receive it.
    const ids = (await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/import`, headers: { authorization: `Bearer ${issuer}` },
      payload: { rows: [row, { ...row, invoiceNumber: "REG-2" }, { ...row, invoiceNumber: "REG-3" }] } })).json().results.map((r: { id: string }) => r.id);
    const tok = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/tokenize`, headers: { authorization: `Bearer ${issuer}` },
      payload: { ids: [ids[0], ids[1]], chainId: "fabric" } });
    expect(tok.statusCode).toBe(200);
    // Every issuance is now `pending_approval` from birth (Task 8) — the route
    // reports that distinctly from "tokenized" so a caller doesn't read
    // "tokenized" as "active with the supply it asked for" (see its own
    // comment above); "tokenized" as a status literally never comes back now.
    expect((tok.json().results as { status: string }[]).filter((r) => r.status === "pending_approval")).toHaveLength(2);
    const staged2 = (await app.inject({ method: "GET", url: `${V1}/use-cases/${KEY}/invoices?status=staged`, headers: { authorization: `Bearer ${issuer}` } })).json();
    expect(staged2).toHaveLength(1);
    const retry = await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/tokenize`, headers: { authorization: `Bearer ${issuer}` }, payload: { ids: [ids[0]], chainId: "fabric" } });
    expect((retry.json().results as { status: string }[])[0].status).toBe("skipped");
  });

  it("tokenize → reject → resubmit → approve: the staged row's asset reaches active, not stuck at pending forever", async () => {
    const app = await buildTestApp();
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const staged = (await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/import`, headers: { authorization: `Bearer ${issuer}` }, payload: { rows: [row] } })).json().results[0];
    const tok = (await app.inject({ method: "POST", url: `${V1}/use-cases/${KEY}/invoices/tokenize`, headers: { authorization: `Bearer ${issuer}` }, payload: { ids: [staged.id], chainId: "fabric" } })).json();
    const assetId = (tok.results as { assetId: string }[])[0].assetId;

    // Reject it — the staged row's own status ("tokenized", meaning "has an
    // associated asset") never reflects the asset's review state, so the
    // register itself has nothing to get stuck on; what matters is that the
    // ASSET can still reach active from here.
    const prospectus = { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") };
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: { authorization: `Bearer ${issuer}` }, payload: prospectus });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: { authorization: `Bearer ${issuer}` } });
    const rejected = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: { authorization: `Bearer ${admin}` }, payload: { decision: "rejected", rejectionReason: "amount looks wrong" } });
    expect(rejected.statusCode).toBe(200);

    // Resubmit (same prospectus already attached) and approve.
    const resubmitted = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: { authorization: `Bearer ${issuer}` } });
    expect(resubmitted.statusCode).toBe(200);
    const approved = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: { authorization: `Bearer ${admin}` }, payload: { decision: "approved", riskTier: "low" } });
    expect(approved.statusCode).toBe(200);

    const asset = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: { authorization: `Bearer ${issuer}` } })).json();
    expect(asset.status).toBe("active");
    // The row stays "tokenized" throughout — it was never re-staged, and the
    // invoice pipeline's own view of it never depended on the asset's status.
    const stagedRow = (await app.inject({ method: "GET", url: `${V1}/use-cases/${KEY}/invoices?status=tokenized`, headers: { authorization: `Bearer ${issuer}` } })).json();
    expect(stagedRow.some((r: { id: string; assetId: string }) => r.id === staged.id && r.assetId === assetId)).toBe(true);
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
