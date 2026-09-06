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

  // Regression for the whole-branch review finding: submit-for-review used to
  // return 200 on a resubmission WITHOUT ever transitioning the asset's status
  // back to pending_approval — a permanent dead end, since the asset never
  // reappeared in the Review Assets screen (which filters on pending_approval)
  // and review-decision would 409 NOT_PENDING forever afterward. This proves
  // the actual round trip: reject -> re-upload -> resubmit -> really is
  // pending_approval again -> a UseCaseAdmin can actually approve it -> it
  // actually activates.
  it("a rejected asset genuinely becomes reviewable again — resubmission transitions status back to pending_approval, and it can then be approved to active", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueRaw(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");

    await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 first draft").toString("base64") },
    });
    await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
    const rejection = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin),
      payload: { decision: "rejected", rejectionReason: "prospectus is incomplete" },
    });
    expect(rejection.statusCode).toBe(200);

    const rejected = await h.assets.get(assetId);
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.dueDiligence?.rejectionReason).toBe("prospectus is incomplete");

    // Re-upload and resubmit.
    await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 fixed draft").toString("base64") },
    });
    const resubmit = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
    expect(resubmit.statusCode).toBe(200);
    expect(resubmit.json().status).toBe("pending_approval");

    // The asset must actually be pending_approval again — not just report 200
    // — and its rejectionReason must be cleared now that it's back under review.
    const afterResubmit = await h.assets.get(assetId);
    expect(afterResubmit?.status).toBe("pending_approval");
    expect(afterResubmit?.dueDiligence?.rejectionReason).toBeFalsy();

    // It must reappear as decidable: review-decision must NOT 409 anymore.
    const approval = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(approval.statusCode).toBe(200);
    const activated = await h.assets.get(assetId);
    expect(activated?.status).toBe("active");
  });
});
