import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, issueAsset, loginAs, V1 } from "./helpers.js";

describe("POST /assets/:id/submit-for-review", () => {
  it("400s PROSPECTUS_REQUIRED when no prospectus is attached", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("PROSPECTUS_REQUIRED");
  });

  it("succeeds once a prospectus is attached (legal opinion / additional documents are optional)", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
    expect(res.statusCode).toBe(200);
  });

  it("works identically on a resubmission after rejection — same endpoint, same validation", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueAsset(h.app, platform, "carbon-credit");
    await h.assets.setDueDiligence(assetId, { rejectionReason: "resubmit with a real prospectus" });
    await h.assets.setStatus(assetId, "rejected");
    const beforeDocs = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
    expect(beforeDocs.statusCode).toBe(400);
    await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
    expect(res.statusCode).toBe(200);
  });
});
