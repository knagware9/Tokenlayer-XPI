import { describe, it, expect } from "vitest";
import { approveAssetForTest, buildTestApp, V1, loginAs, auth } from "./helpers.js";

describe("asset register — generalized beyond the invoice use case", () => {
  it("stages, lists, and selectively tokenizes rows for a non-invoice use case with a generic per-row supply", async () => {
    const app = await buildTestApp();
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    // Manual add — the invoice-only NOT_INVOICE_USECASE gate must not apply here.
    const add = await app.inject({
      method: "POST", url: `${V1}/use-cases/carbon-credit/invoices`, headers: auth(carbonAdmin),
      payload: { metadata: { projectName: "Amazon Basin REDD+", registry: "Verra", vintage: 2025 } },
    });
    expect(add.statusCode).toBe(201);
    const staged = add.json();
    expect(staged.status).toBe("staged");
    expect(staged.invoiceHash).toMatch(/^0x[0-9a-f]{64}$/);

    // A byte-identical second stage is a duplicate — the generic fingerprint dedupes too.
    const dup = await app.inject({
      method: "POST", url: `${V1}/use-cases/carbon-credit/invoices`, headers: auth(carbonAdmin),
      payload: { metadata: { projectName: "Amazon Basin REDD+", registry: "Verra", vintage: 2025 } },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("DUPLICATE_INVOICE");

    const list = await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit/invoices?status=staged`, headers: auth(carbonAdmin) });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((r: { id: string }) => r.id === staged.id)).toBe(true);

    // Tokenize with an explicit initialSupply — the invoice use case's amount÷parValue
    // derivation must not apply; carbon-credit metadata carries no `amount` at all.
    // Called as the platform (not carbonAdmin, carbon-credit's own seeded
    // UseCaseAdmin) so carbonAdmin stays free to DECIDE the due-diligence
    // review below — review-decision refuses a creator deciding their own asset.
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const tokenize = await app.inject({
      method: "POST", url: `${V1}/use-cases/carbon-credit/invoices/tokenize`, headers: auth(platform),
      payload: { ids: [staged.id], chainId: "fabric", initialSupply: "250" },
    });
    expect(tokenize.statusCode).toBe(200);
    const [result] = tokenize.json().results;
    // Every issuance is now `pending_approval` from birth (Task 8) — the batch
    // route never reports "tokenized" any more (see its own comment).
    expect(result.status).toBe("pending_approval");
    expect(result.assetId).toBeTruthy();
    await approveAssetForTest(app, result.assetId, "carbon-credit");

    const asset = (await app.inject({ method: "GET", url: `${V1}/assets/${result.assetId}`, headers: auth(carbonAdmin) })).json();
    // stagedRowLabel: no uniqueBy on carbon-credit -> first two required fields joined.
    expect(asset.name).toBe("Amazon Basin REDD+ · Verra");
    expect(asset.totalSupply).toBe("250");
    expect(asset.metadata.projectName).toBe("Amazon Basin REDD+");

    // Re-tokenizing an already-tokenized row is skipped, not re-minted.
    const again = await app.inject({
      method: "POST", url: `${V1}/use-cases/carbon-credit/invoices/tokenize`, headers: auth(carbonAdmin),
      payload: { ids: [staged.id], chainId: "fabric", initialSupply: "250" },
    });
    expect(again.json().results[0].status).toBe("skipped");
  });

  it("defaults initialSupply to 1 unit per row when the caller doesn't specify one", async () => {
    const app = await buildTestApp();
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const add = await app.inject({
      method: "POST", url: `${V1}/use-cases/carbon-credit/invoices`, headers: auth(carbonAdmin),
      payload: { metadata: { projectName: "Congo Basin", registry: "Gold Standard", vintage: 2024 } },
    });
    expect(add.statusCode).toBe(201);
    const staged = add.json();
    // Called as the platform, not carbonAdmin, for the same reason as the
    // previous test: carbonAdmin needs to stay free to decide the review.
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const tokenize = await app.inject({
      method: "POST", url: `${V1}/use-cases/carbon-credit/invoices/tokenize`, headers: auth(platform),
      payload: { ids: [staged.id], chainId: "fabric" },
    });
    const [result] = tokenize.json().results;
    expect(result.status).toBe("pending_approval");
    await approveAssetForTest(app, result.assetId, "carbon-credit");
    const asset = (await app.inject({ method: "GET", url: `${V1}/assets/${result.assetId}`, headers: auth(carbonAdmin) })).json();
    expect(asset.totalSupply).toBe("1");
  });

  it("reports pending_approval, not tokenized — every issuance is due-diligence-gated now, corporate-bond included", async () => {
    // Originally written against corporate-bond specifically because it's the
    // one seeded use case with workflow.approvals.issue set (config/use-cases/
    // corporate-bond.json) — that was the only gated-issuance path that
    // existed at the time. Task 8 supersedes that opt-in gate with a mandatory
    // due-diligence review for EVERY use case's issuance, so this exact
    // pending_approval/assetId-set/totalSupply-0 outcome is no longer
    // corporate-bond-specific — it is what the batch route now reports for
    // any use case's tokenize call. Kept on corporate-bond (rather than moved
    // to a plain use case) since it's still a fine one to exercise this on,
    // and its own workflow.approvals.issue setting is now simply inert here.
    const app = await buildTestApp();
    const bondAdmin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    // Called as the platform, not bondAdmin (corporate-bond's own seeded
    // UseCaseAdmin), so bondAdmin stays free to DECIDE the due-diligence
    // review below — review-decision refuses a creator deciding their own asset.
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const uc = (await app.inject({ method: "GET", url: `${V1}/use-cases/corporate-bond`, headers: auth(bondAdmin) })).json();
    const chainId = Object.keys(uc.contracts ?? {})[0] ?? "fabric";
    const bondMeta = { issuer: "Batch Bond Co", isin: "INE000A02022", faceValue: 5_000_000, couponRate: 8, maturityDate: "2099-12-31" };

    const add = await app.inject({
      method: "POST", url: `${V1}/use-cases/corporate-bond/invoices`, headers: auth(bondAdmin),
      payload: { metadata: bondMeta },
    });
    expect(add.statusCode).toBe(201);
    const staged = add.json();

    const tokenize = await app.inject({
      method: "POST", url: `${V1}/use-cases/corporate-bond/invoices/tokenize`, headers: auth(platform),
      payload: { ids: [staged.id], chainId, initialSupply: "50" },
    });
    expect(tokenize.statusCode).toBe(200);
    const [result] = tokenize.json().results;
    // The asset was created (assetId is set, staged row is linked) but the
    // mint itself is deferred to due-diligence review (Task 8) — the batch
    // route must not claim "tokenized" for a supply that isn't live yet.
    expect(result.status).toBe("pending_approval");
    expect(result.assetId).toBeTruthy();

    const asset = (await app.inject({ method: "GET", url: `${V1}/assets/${result.assetId}`, headers: auth(bondAdmin) })).json();
    expect(asset.status).toBe("pending_approval");
    expect(asset.totalSupply).toBe("0");

    // Re-submitting the already-tokenized (linked) row is skipped, not re-proposed.
    const again = await app.inject({
      method: "POST", url: `${V1}/use-cases/corporate-bond/invoices/tokenize`, headers: auth(bondAdmin),
      payload: { ids: [staged.id], chainId, initialSupply: "50" },
    });
    expect(again.json().results[0].status).toBe("skipped");
  });
});
