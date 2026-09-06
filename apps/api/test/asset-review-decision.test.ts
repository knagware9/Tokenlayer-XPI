import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

// Deliberately NOT the shared issueAsset() helper: that helper now completes
// the ENTIRE due-diligence flow (upload + submit + approve) internally, using
// the use case's own seeded UseCaseAdmin to decide — which is exactly the
// actor these tests need to still be free to act as themselves (to attempt
// (and, in one case, be refused) the decision below). Issue raw, upload, and
// submit — leaving the asset `pending_approval` for the test body to decide.
async function submittedAsset(h: Awaited<ReturnType<typeof buildTestAppWithRepos>>, actor: string): Promise<string> {
  const issue = await h.app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(actor),
    payload: { useCaseKey: "carbon-credit", name: "T", symbol: "T", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 } },
  });
  const assetId = issue.json().asset.id as string;
  await h.app.inject({
    method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(actor),
    payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
  });
  await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(actor) });
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

  // Task-8 fixup regression test: the OLD sync issuance path emitted
  // `asset.issued` on activation, and the old gated (proposal) path surfaced
  // `proposal.executed` instead — an integrator always got SOME signal that an
  // asset went live. Task 8 made review-decision the sole activation path and
  // dropped both: `executeIssueActivation` (shared/executors.ts) emitted
  // nothing at all. This proves the fix — `asset.issued` now fires uniformly
  // from `executeIssueActivation` itself, exercised here through the real
  // HTTP approval path (not a direct emitEvent() call, which would prove
  // nothing about whether the route actually triggers it).
  it("approving via review-decision emits an asset.issued event", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(res.statusCode).toBe(200);

    const events = await h.deps.events.listAfter(0, { orgId: undefined, type: "asset.issued", limit: 10 });
    const forThisAsset = events.filter((e) => e.subjectId === assetId);
    expect(forThisAsset).toHaveLength(1);
    expect(forThisAsset[0].data).toMatchObject({ assetId, useCaseKey: "carbon-credit", status: "active" });
  });

  // Whole-branch-review fixup ("overturned ruling"): a use case with no
  // onboarded UseCaseAdmin (the built-in generic-asset/generic-certificate,
  // or simply one nobody has staffed yet) used to have no eligible decider at
  // all once every asset became pending_approval — a permanent dead end.
  // PlatformAdmin may now decide ANY use case's asset, not just its own.
  // Proven here on carbon-credit (which DOES have its own UseCaseAdmin) to
  // isolate exactly the thing that changed: PlatformAdmin's eligibility no
  // longer depends on matching claims.useCaseKey to the asset's use case.
  it("a PlatformAdmin can decide a review for a use case it has no UseCaseAdmin membership in", async () => {
    const h = await buildTestAppWithRepos();
    const carbonIssuer = await loginAs(h.app, "carbon.issuer@tokenlayer.dev", "carbon123");
    const assetId = await submittedAsset(h, carbonIssuer);
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(platform),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(res.statusCode).toBe(200);
    const asset = (await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(platform) })).json();
    expect(asset.status).toBe("active");
    expect(asset.dueDiligence.reviewedBy).toBeTruthy();
  });

  // Widening WHO may decide (any PlatformAdmin, not just a same-use-case
  // UseCaseAdmin) must never widen self-approval — the creator-cannot-decide
  // rule has to apply to a deciding PlatformAdmin exactly as it does to a
  // UseCaseAdmin.
  it("the creator-cannot-decide-own-asset rule still applies to a PlatformAdmin creator", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await submittedAsset(h, platform);
    const res = await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(platform),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
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
