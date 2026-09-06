import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, issueAsset, loginAs, V1 } from "./helpers.js";

describe("Asset due-diligence document upload and read gate", () => {
  it("the issuer can upload a prospectus, then read it back", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 fake prospectus").toString("base64") },
    });
    expect(upload.statusCode).toBe(201);
    const docId = upload.json().id as string;
    const read = await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}/diligence/documents/${docId}`, headers: auth(platform) });
    expect(read.statusCode).toBe(200);
    expect(read.payload).toContain("fake prospectus");
  });

  it("an additional document requires a label", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "additional", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("LABEL_REQUIRED");
  });

  it("a buyer scoped to a DIFFERENT use case cannot read a pending asset's documents", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    const docId = upload.json().id as string;
    const goldBuyer = await loginAs(h.app, "gold.buyer@tokenlayer.dev", "gold123");
    const read = await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}/diligence/documents/${docId}`, headers: auth(goldBuyer) });
    expect(read.statusCode).toBe(404);
  });

  it("a buyer scoped to the SAME use case cannot read a still-pending asset's documents, but can once it's active", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    // issueAsset() issues via today's synchronous path (no use case has
    // workflow.approvals.issue set) and returns an already-active asset —
    // this task's own routes don't yet run before Task 8 makes
    // pending_approval the universal default, so force the state this test
    // actually needs directly through the repository, the same way this
    // plan's Task 3 test 3 already does.
    await h.assets.setStatus(assetId, "pending_approval");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    const docId = upload.json().id as string;
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const pendingRead = await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}/diligence/documents/${docId}`, headers: auth(buyer) });
    expect(pendingRead.statusCode).toBe(403);

    await h.assets.setStatus(assetId, "active");
    const activeRead = await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}/diligence/documents/${docId}`, headers: auth(buyer) });
    expect(activeRead.statusCode).toBe(200);
  });

  it("GET /documents/:id refuses an asset-diligence-purposed document outright, even for a PlatformAdmin", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    const docId = upload.json().id as string;
    const res = await h.app.inject({ method: "GET", url: `${V1}/documents/${docId}`, headers: auth(platform) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });
});
