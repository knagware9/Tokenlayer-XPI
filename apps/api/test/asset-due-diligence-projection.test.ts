import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

/**
 * Whole-branch-review fixup: the shared `Asset#` OpenAPI component declares
 * `dueDiligence: { type: "object", additionalProperties: true, nullable: true }`
 * — every field of it, unfiltered, would reach any caller who can merely READ
 * the asset. That includes `pendingIssuanceFee` (which carries the issuer's
 * own wallet address), `pendingInitialSupply`, `pendingSale` (internal
 * activation plumbing no response should ever surface, for any caller), and
 * `reviewedBy`/`rejectionReason` (reviewer identity and possibly-sensitive
 * commentary — fine for this asset's own use-case staff, not for an unrelated
 * investor). This file proves `projectDueDiligenceForCaller` actually strips
 * the right fields for the right callers, exercised through the real GET
 * routes rather than by calling the function directly.
 */
async function issueRaw(h: Awaited<ReturnType<typeof buildTestAppWithRepos>>, token: string): Promise<string> {
  const res = await h.app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(token),
    payload: { useCaseKey: "carbon-credit", name: "T", symbol: "T", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 } },
  });
  return res.json().asset.id as string;
}

describe("dueDiligence response projection", () => {
  it("a Buyer sees prospectus/riskTier but never reviewedBy/rejectionReason/pending* fields; this asset's own staff see reviewedBy/rejectionReason but STILL never pending* fields", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueRaw(h, platform);

    // Directly seed a dueDiligence blob carrying every field the projection
    // must reason about — including a combination (reviewedBy set on a
    // rejected asset) the real review-decision handler wouldn't itself
    // produce, so this test is purely about the projection, not the business
    // flow that fills these fields in practice.
    await h.assets.setDueDiligence(assetId, {
      prospectus: { id: "doc-prospectus", sha256: "0xaaa" },
      riskTier: "medium",
      reviewedBy: "user-carbon-admin-id",
      reviewedAt: "2026-09-01T00:00:00.000Z",
      rejectionReason: "prospectus is incomplete",
      pendingInitialSupply: "1000",
      pendingSale: { unitPrice: "5", currency: "CBDC-INR" },
      pendingIssuanceFee: { amount: "100", currency: "CBDC-INR", payer: "0xIssuerWalletAddress" },
    });
    await h.assets.setStatus(assetId, "rejected");

    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const admin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const issuer = await loginAs(h.app, "carbon.issuer@tokenlayer.dev", "carbon123");

    // --- Buyer (investor-side viewer, no special relationship to the asset) ---
    const buyerView = (await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(buyer) })).json();
    expect(buyerView.dueDiligence.prospectus).toEqual({ id: "doc-prospectus", sha256: "0xaaa" });
    expect(buyerView.dueDiligence.riskTier).toBe("medium");
    expect(buyerView.dueDiligence.reviewedBy).toBeUndefined();
    expect(buyerView.dueDiligence.rejectionReason).toBeUndefined();
    expect(buyerView.dueDiligence.pendingIssuanceFee).toBeUndefined();
    expect(buyerView.dueDiligence.pendingInitialSupply).toBeUndefined();
    expect(buyerView.dueDiligence.pendingSale).toBeUndefined();

    // --- UseCaseAdmin (staff of this asset's own use case) ---
    const adminView = (await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(admin) })).json();
    expect(adminView.dueDiligence.reviewedBy).toBe("user-carbon-admin-id");
    expect(adminView.dueDiligence.rejectionReason).toBe("prospectus is incomplete");
    // Never leaked to ANYONE, staff included — internal activation plumbing only.
    expect(adminView.dueDiligence.pendingIssuanceFee).toBeUndefined();
    expect(adminView.dueDiligence.pendingInitialSupply).toBeUndefined();
    expect(adminView.dueDiligence.pendingSale).toBeUndefined();

    // --- Issuer (also staff of this asset's own use case) ---
    const issuerView = (await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(issuer) })).json();
    expect(issuerView.dueDiligence.reviewedBy).toBe("user-carbon-admin-id");
    expect(issuerView.dueDiligence.rejectionReason).toBe("prospectus is incomplete");
    expect(issuerView.dueDiligence.pendingIssuanceFee).toBeUndefined();

    // --- Same fields hidden/shown consistently through GET /assets (list) too ---
    const buyerList = (await h.app.inject({ method: "GET", url: `${V1}/assets?limit=50`, headers: auth(buyer) })).json();
    const buyerRow = (buyerList.data as { id: string; dueDiligence: Record<string, unknown> }[]).find((a) => a.id === assetId)!;
    expect(buyerRow.dueDiligence.reviewedBy).toBeUndefined();
    expect(buyerRow.dueDiligence.rejectionReason).toBeUndefined();
    expect(buyerRow.dueDiligence.pendingIssuanceFee).toBeUndefined();

    const adminList = (await h.app.inject({ method: "GET", url: `${V1}/assets?limit=50`, headers: auth(admin) })).json();
    const adminRow = (adminList.data as { id: string; dueDiligence: Record<string, unknown> }[]).find((a) => a.id === assetId)!;
    expect(adminRow.dueDiligence.reviewedBy).toBe("user-carbon-admin-id");
    expect(adminRow.dueDiligence.pendingIssuanceFee).toBeUndefined();
  });

  it("a PlatformAdmin (platform-wide staff) sees reviewedBy/rejectionReason on ANY use case's asset, but never pending* fields", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const assetId = await issueRaw(h, platform);
    await h.assets.setDueDiligence(assetId, {
      reviewedBy: "someone",
      rejectionReason: "reason",
      pendingIssuanceFee: { amount: "10", currency: "CBDC-INR", payer: "0xabc" },
    });
    const view = (await h.app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(platform) })).json();
    expect(view.dueDiligence.reviewedBy).toBe("someone");
    expect(view.dueDiligence.rejectionReason).toBe("reason");
    expect(view.dueDiligence.pendingIssuanceFee).toBeUndefined();
  });
});
