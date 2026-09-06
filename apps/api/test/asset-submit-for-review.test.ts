import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

/** Issue raw, without completing due diligence — every one of this file's
 *  tests is specifically about the pending, pre-review state, so the shared
 *  issueAsset() helper (which now completes the whole flow, including this
 *  very submit-for-review step) would defeat the point. */
async function issueRaw(h: Awaited<ReturnType<typeof buildTestAppWithRepos>>, token: string): Promise<string> {
  const res = await h.app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(token),
    payload: { useCaseKey: "carbon-credit", name: "T", symbol: "T", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 } },
  });
  return res.json().asset.id as string;
}

describe("POST /assets/:id/submit-for-review", () => {
  it("400s PROSPECTUS_REQUIRED when no prospectus is attached", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueRaw(h, platform);
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("PROSPECTUS_REQUIRED");
  });

  it("succeeds once a prospectus is attached (legal opinion / additional documents are optional)", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueRaw(h, platform);
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
    const assetId = await issueRaw(h, platform);
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
