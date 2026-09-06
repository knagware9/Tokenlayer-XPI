import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, issueAsset, loginAs, V1 } from "./helpers.js";

/** Issue raw, without completing due diligence — left `pending_approval`, the
 *  state most of this file's tests actually need (they exercise upload/read
 *  while the asset is still under review). `issueAsset()` now completes the
 *  whole review flow and returns an already-`active` asset, which would trip
 *  the NOT_EDITABLE guard these tests are not about. */
async function issueRaw(h: Awaited<ReturnType<typeof buildTestAppWithRepos>>, token: string): Promise<string> {
  const res = await h.app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(token),
    payload: { useCaseKey: "carbon-credit", name: "T", symbol: "T", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 } },
  });
  return res.json().asset.id as string;
}

describe("Asset due-diligence document upload and read gate", () => {
  it("the issuer can upload a prospectus, then read it back", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueRaw(h, platform);
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
    const assetId = await issueRaw(h, platform);
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
    const assetId = await issueRaw(h, platform);
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    expect(upload.statusCode).toBe(201);
    const docId = upload.json().id as string;
    const goldBuyer = await loginAs(h.app, "gold.buyer@tokenlayer.dev", "gold123");
    const read = await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}/diligence/documents/${docId}`, headers: auth(goldBuyer) });
    expect(read.statusCode).toBe(404);
  });

  it("a buyer scoped to the SAME use case cannot read a still-pending asset's documents, but can once it's active", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    // issueAsset() now completes the whole due-diligence flow and returns an
    // already-active asset — force it back to pending_approval directly
    // through the repository so this test can exercise the pending-state gate.
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

  // Whole-branch-review fixup: this route had no status guard at all — an
  // issuer could swap in a replacement prospectus on an already-`active`
  // asset, silently changing what the risk tier and reviewer attribution were
  // actually based on while investors keep seeing the old badge unchanged.
  it("uploading a diligence document on an already-active asset is refused (409 NOT_EDITABLE)", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit"); // issueAsset() completes review -> active
    const asset = await h.assets.get(assetId);
    expect(asset?.status).toBe("active");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 replacement").toString("base64") },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NOT_EDITABLE");
  });

  it("GET /documents/:id refuses an asset-diligence-purposed document outright, even for a PlatformAdmin", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueRaw(h, platform);
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    expect(upload.statusCode).toBe(201);
    const docId = upload.json().id as string;
    const res = await h.app.inject({ method: "GET", url: `${V1}/documents/${docId}`, headers: auth(platform) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });
});
