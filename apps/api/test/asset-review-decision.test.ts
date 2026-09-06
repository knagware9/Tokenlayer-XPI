import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, issueAsset, loginAs, V1 } from "./helpers.js";

async function submittedAsset(h: Awaited<ReturnType<typeof buildTestAppWithRepos>>, platform: string): Promise<string> {
  const assetId = await issueAsset(h.app, platform, "carbon-credit");
  // issueAsset() issues via today's synchronous path (no use case has
  // workflow.approvals.issue set) and returns an already-active asset — the
  // review-decision route this task adds requires pending_approval, and
  // Task 8 is what makes that the universal default, not this task. Force
  // the state this task's own tests need directly, same as Task 2's fix.
  await h.assets.setStatus(assetId, "pending_approval");
  await h.app.inject({
    method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
    payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
  });
  await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });
  return assetId;
}

describe("POST /assets/:id/review-decision", () => {
  it("a UseCaseAdmin approving with a risk tier activates the asset", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(res.statusCode).toBe(200);
    const asset = (await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(platform) })).json();
    expect(asset.status).toBe("active");
    expect(asset.dueDiligence.riskTier).toBe("low");
    expect(asset.dueDiligence.reviewedBy).toBeTruthy();
  });

  it("rejecting with a reason sets status rejected and stores the reason", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin),
      payload: { decision: "rejected", rejectionReason: "prospectus is incomplete" },
    });
    expect(res.statusCode).toBe(200);
    const asset = (await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(platform) })).json();
    expect(asset.status).toBe("rejected");
    expect(asset.dueDiligence.rejectionReason).toBe("prospectus is incomplete");
  });

  it("approving with no riskTier is refused", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin), payload: { decision: "approved" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("RISK_TIER_REQUIRED");
  });

  it("rejecting with no reason is refused", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin), payload: { decision: "rejected" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("REASON_REQUIRED");
  });

  it("a UseCaseAdmin from a DIFFERENT use case cannot decide", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const goldAdmin = await loginAs(h.app, "gold.admin@tokenlayer.dev", "gold123");
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(goldAdmin), payload: { decision: "approved", riskTier: "low" } });
    expect(res.statusCode).toBe(403);
  });

  it("the asset's own creator cannot decide it, even if they hold the UseCaseAdmin role", async () => {
    const h = await buildTestAppWithRepos();
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const assetId = await submittedAsset(h, carbonAdmin);
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin), payload: { decision: "approved", riskTier: "low" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("a machine principal is refused outright", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const org = await h.app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(platform), payload: { name: `Diligence Test Org ${Date.now()}`, orgType: "corporate" } });
    const key = await h.app.inject({ method: "POST", url: `${V1}/orgs/${org.json().id}/api-keys`, headers: auth(platform), payload: { name: "k", role: "UseCaseAdmin", scopes: ["assets:issue"] } });
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: { authorization: `Bearer ${key.json().secret}` }, payload: { decision: "approved", riskTier: "low" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("MACHINE_PRINCIPAL");
  });

  it("deciding on an asset that is not pending_approval is refused", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin), payload: { decision: "approved", riskTier: "low" } });
    const res = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin), payload: { decision: "approved", riskTier: "low" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NOT_PENDING");
  });
});
