import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { approveAssetForTest, buildTestApp, V1, loginAs, auth, onboardUser, treasuryAddressOf, PLATFORM_ADMIN_2 } from "./helpers.js";

// Seeded accounts (unlinked → usable as treasuries/holders).
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const HOLDER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Carol
const PAYER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // Treasury

// corporate-bond's seed config (config/use-cases/corporate-bond.json) sets
// workflow.approvals.issue=1 + cashflow-execute=1. Task 8 (this migration)
// supersedes the `issue` entry entirely: due-diligence review now gates
// issuance for EVERY use case, so that entry is simply inert here — this file
// keeps corporate-bond as its fixture (initial supply + treasury + sale terms
// make it a realistic one) to exercise the NEW review flow, not because the
// old flag still does anything for issuance. Its defaultChainId is besu
// (absent in the sim stack) — issue on a deployed chain.
const bondMeta = { issuer: "Acme Corp", isin: "INE000A01011", faceValue: 5_000_000, couponRate: 8, maturityDate: "2099-12-31" };

async function bondChain(app: FastifyInstance, token: string): Promise<string> {
  const uc = (await app.inject({ method: "GET", url: `${V1}/use-cases/corporate-bond`, headers: auth(token) })).json();
  return Object.keys(uc.contracts ?? {})[0] ?? "fabric";
}
async function issueBond(app: FastifyInstance, proposer: string, name: string) {
  const chainId = await bondChain(app, proposer);
  return app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(proposer), payload: { useCaseKey: "corporate-bond", name, chainId, initialSupply: "1000", metadata: bondMeta } });
}

/** Attach a throwaway prospectus and submit for review, as `actorToken`. */
async function submitForReview(app: FastifyInstance, assetId: string, actorToken: string): Promise<void> {
  await app.inject({
    method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(actorToken),
    payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
  });
  await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(actorToken) });
}

// ---------------------------------------------------------------------------
// This whole describe block originally exercised corporate-bond's
// workflow.approvals.issue gate: POST /assets returned a 202 + a `proposal`,
// and a distinct capability holder approved it via POST /proposals/:id/approve.
// Task 8 retires that path for issuance specifically — issueAssetCore no
// longer calls proposeIfGated for "issue" at all, for ANY use case, gated or
// not. Every issuance is `pending_approval` from birth and is decided instead
// via the due-diligence review flow (POST /assets/:id/diligence/documents →
// submit-for-review → review-decision), which is NOT a proposal: there is
// nothing under /proposals to poll, and the decider must be a UseCaseAdmin of
// the asset's own use case, distinct from whoever created it (not merely "a
// distinct capability holder" as the old proposal-approval rule allowed).
// Each test below is rewritten against that real replacement, not deleted.
// ---------------------------------------------------------------------------
describe("maker-checker: gated issuance lifecycle", () => {
  it("issuance returns 202 + a frozen pending_approval asset — no proposal, due-diligence review instead", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const res = await issueBond(app, admin, "BOND-1");
    expect(res.statusCode).toBe(202);
    const body = res.json();
    // Unlike almost every other 202 in this API, this one creates no proposal
    // — see this task's own schema description on issueAsset.
    expect(body.proposal).toBeUndefined();
    expect(body.asset.status).toBe("pending_approval");
    // Frozen: no actions / buy / listing while pending.
    expect((await app.inject({ method: "POST", url: `${V1}/assets/${body.asset.id}/actions/mint`, headers: auth(admin), payload: { to: BOB, amount: "1" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${V1}/assets/${body.asset.id}/buy`, headers: auth(admin), payload: { quantity: "1" } })).statusCode).toBe(409);
  });

  it("review-decision approval by corporate-bond's own UseCaseAdmin mints the deferred supply and activates", async () => {
    const app = await buildTestApp();
    // Issued by an Issuer, not bond.admin — corporate-bond's only seeded
    // UseCaseAdmin — so bond.admin stays free to DECIDE the review below
    // (review-decision refuses a creator deciding their own asset).
    const issuer = await loginAs(app, "bond.issuer@tokenlayer.dev", "bond123");
    const { asset } = (await issueBond(app, issuer, "BOND-2")).json();
    await submitForReview(app, asset.id, issuer);
    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const decided = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(admin), payload: { decision: "approved", riskTier: "low" } });
    expect(decided.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(admin) })).json();
    expect(after.status).toBe("active");
    // Supply minted to the use case's own (server-derived, never client-supplied
    // — org-treasury-accounts Task 5) treasury only on approval. The treasury
    // Account is never linked to a user, so a scoped GET /accounts (unlike
    // PlatformAdmin's) would never show it — look it up as platform.
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const treasury = await treasuryAddressOf(app, platform, "corporate-bond");
    const accts = (await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}/accounts`, headers: auth(admin) })).json();
    expect(accts.find((a: { address: string }) => a.address.toLowerCase() === treasury.toLowerCase())?.balance).toBe("1000");
  });

  it("gated issuance with sale terms but NO initial supply: review-decision approval writes the sale terms, not a silent no-op", async () => {
    // Regression: `treasury` used to be captured only when `initialSupply` was
    // also requested, so a gated issue with `sale` alone silently dropped the
    // sale terms on approval — no mint (nothing to gate) but no price either.
    // Still a live risk under the due-diligence path (setDueDiligence captures
    // pendingSale unconditionally, but executeIssueActivation only applies it
    // when a treasury is resolved) — worth keeping this regression coverage.
    const app = await buildTestApp();
    const issuer = await loginAs(app, "bond.issuer@tokenlayer.dev", "bond123");
    const chainId = await bondChain(app, issuer);
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const treasury = await treasuryAddressOf(app, platform, "corporate-bond");

    const res = await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(issuer),
      payload: { useCaseKey: "corporate-bond", name: "BOND-SALE-ONLY", chainId, sale: { unitPrice: "5", currency: "CBDC-INR" }, metadata: bondMeta },
    });
    expect(res.statusCode).toBe(202);
    const { asset } = res.json();
    expect(asset.unitPrice).toBeNull(); // deferred to approval, not set yet
    await submitForReview(app, asset.id, issuer);

    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const decided = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(admin), payload: { decision: "approved", riskTier: "low" } });
    expect(decided.statusCode).toBe(200);

    const after = (await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(admin) })).json();
    expect(after.unitPrice).toBe("5");
    expect(after.currency).toBe("CBDC-INR");
    expect(after.treasuryAccount).toBe(treasury);
    // No supply was requested — nothing minted, so the treasury sits at a zero
    // balance and isn't allowlisted. It's still visible in the caller's own use
    // case's accounts (scopedAccounts always includes the caller's own treasury,
    // regardless of activity — see scopedAccounts in routes/tokenization.ts) —
    // an Issuer needs the address to fund/allow it, not just after it already has.
    const accts = (await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}/accounts`, headers: auth(admin) })).json();
    const treasuryRow = accts.find((a: { address: string }) => a.address.toLowerCase() === treasury.toLowerCase());
    expect(treasuryRow?.balance).toBe("0");
    expect(treasuryRow?.allowed).toBe(false);
  });

  it("the asset's own creator cannot decide its own due-diligence review, even as the use case's sole UseCaseAdmin", async () => {
    // Was: "segregation of duties: the proposer cannot approve their own
    // proposal" (SELF_APPROVAL, 403). The new decision point enforces the same
    // property directly (FORBIDDEN, 403) — see also asset-review-decision.test.ts,
    // which covers this in depth on carbon-credit; repeated here on
    // corporate-bond because that file's shared issueAsset() helper cannot
    // reach this state (it always completes the whole flow itself).
    const app = await buildTestApp();
    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const { asset } = (await issueBond(app, admin, "BOND-3")).json();
    await submitForReview(app, asset.id, admin);
    const self = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(admin), payload: { decision: "approved", riskTier: "low" } });
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe("FORBIDDEN");
  });

  it("rejection via review-decision marks the pending asset rejected; a decided asset cannot be decided again", async () => {
    // Folds in the old "the same approver cannot approve twice" test too: that
    // was a proposal-specific per-approver de-dup (ALREADY_APPROVED_BY_YOU)
    // with no equivalent under a single-decision endpoint — what actually
    // still matters, decided-by-anyone-or-not, is that a SECOND decision on an
    // already-decided asset is refused (NOT_PENDING), asserted here.
    const app = await buildTestApp();
    const issuer = await loginAs(app, "bond.issuer@tokenlayer.dev", "bond123");
    const { asset } = (await issueBond(app, issuer, "BOND-4")).json();
    await submitForReview(app, asset.id, issuer);
    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const rej = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(admin), payload: { decision: "rejected", rejectionReason: "prospectus is incomplete" } });
    expect(rej.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(admin) })).json().status).toBe("rejected");
    // A decided asset cannot be decided again.
    const late = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(admin), payload: { decision: "approved", riskTier: "low" } });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("NOT_PENDING");
  });

  it("eligibility: a Buyer cannot decide; a cross-tenant UseCaseAdmin is refused too (403 either way, not a visibility-based 404)", async () => {
    // Was: a Buyer got 403 NOT_ELIGIBLE (proposal-eligibility check), while a
    // cross-tenant approver got 404 (couldn't even see the foreign proposal).
    // review-decision has no such visibility split — it 404s only when the
    // asset itself doesn't exist, and 403 FORBIDDEN for every ineligible
    // caller regardless of tenancy, so both cases below now read the same.
    const app = await buildTestApp();
    const issuer = await loginAs(app, "bond.issuer@tokenlayer.dev", "bond123");
    const { asset } = (await issueBond(app, issuer, "BOND-5")).json();
    await submitForReview(app, asset.id, issuer);
    const buyer = await loginAs(app, "bond.buyer@tokenlayer.dev", "bond123");
    const notEligible = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(buyer), payload: { decision: "approved", riskTier: "low" } });
    expect(notEligible.statusCode).toBe(403);
    expect(notEligible.json().error).toBe("FORBIDDEN");
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const crossTenant = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(carbon), payload: { decision: "approved", riskTier: "low" } });
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json().error).toBe("FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// Was "maker-checker: thresholds + concurrency": a use case's
// workflow.approvals.issue: N required N distinct proposal approvals before an
// issuance activated (a t2-note fixture proved threshold=2; corporate-bond's
// own issue:1 proved two approvers racing a threshold=1 proposal execute the
// operation exactly once). Task 8 retires the whole concept for issuance: a
// due-diligence review is ONE UseCaseAdmin's decision, not a multi-party vote,
// so there is no N-of-M threshold left to prove, and review-decision's own
// concurrency behavior (if two UseCaseAdmins raced the same decision) is
// Task 4's endpoint, already reviewed there — re-probing it for a race is out
// of this migration's scope. What genuinely still needs proving, and is new
// under this system, is that a configured threshold — however high — is
// simply ignored now: a single review-decision is enough regardless.
// ---------------------------------------------------------------------------
describe("workflow.approvals.issue thresholds are now inert for issuance", () => {
  it("a use case configured with workflow.approvals.issue: 2 still activates on ONE review-decision, not two", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const def = {
      key: "t2-note", name: "T2 Note", tokenStandard: "ERC-20", symbol: "T2N",
      allowedChainIds: ["fabric"], defaultChainId: "fabric",
      metadataSchema: { type: "object", properties: { faceValue: { type: "number" } }, required: ["faceValue"] },
      lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
      compliance: { allowlist: false, transferRestrictions: false },
      workflow: { approvals: { issue: 2 } },
      roles: ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"],
    };
    expect((await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(platform), payload: def })).statusCode).toBe(201);
    // Bootstrapping the FIRST UseCaseAdmin of a brand-new use case is gated too:
    // the platform admin proposes, a SECOND platform admin checks (no t2-note UCA
    // exists yet, and the proposer may not self-approve).
    const platform2 = await loginAs(app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    await onboardUser(app, platform, platform2, { email: "t2.admin@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: "t2-note" });
    const adminTok = await loginAs(app, "t2.admin@x.dev", "secret1");
    await onboardUser(app, adminTok, platform, { email: "t2.i1@x.dev", password: "secret1", role: "Issuer", useCaseKey: "t2-note" });
    const iss1 = await loginAs(app, "t2.i1@x.dev", "secret1");

    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(iss1), payload: { useCaseKey: "t2-note", name: "N1", chainId: "fabric", initialSupply: "500", metadata: { faceValue: 100 } } });
    expect(issued.statusCode).toBe(202);
    const asset = issued.json().asset;
    expect(asset.status).toBe("pending_approval");
    await submitForReview(app, asset.id, iss1);

    // ONE decision — from the use case's own UseCaseAdmin, issued by a
    // DIFFERENT actor (iss1) so the creator/decider split holds — is enough,
    // despite the configured threshold of 2.
    const decided = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(adminTok), payload: { decision: "approved", riskTier: "low" } });
    expect(decided.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(adminTok) })).json();
    expect(after.status).toBe("active");
    expect(after.totalSupply).toBe("500");
  });
});

describe("maker-checker: gated settlement + ungated pass-through", () => {
  it("invoice settlement is proposal-gated: 202 then approval pays out and matures", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await onboardUser(app, admin, platform, { email: "ap.holder@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { legalName: "AP Holder", country: "IN" } });
    await onboardUser(app, admin, platform, { email: "ap.settle@x.dev", password: "secret1", role: "Auditor", walletAddress: PAYER, kyc: { legalName: "AP Settle", country: "IN" } });
    // Issued by the platform, not m1.admin (the invoice desk's own seeded
    // UseCaseAdmin), so m1.admin stays free to DECIDE this asset's
    // due-diligence review — issuance itself is now gated for every use case,
    // this one included, regardless of its cashflow-execute gate below.
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(platform), payload: { useCaseKey: "invoice-tokenization", name: "INV-AP-1", chainId: "fabric", initialSupply: "10000", metadata: { invoiceNumber: "INV-AP-1", invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2099-12-31" } } });
    expect(issued.statusCode).toBe(202);
    const assetId = issued.json().asset.id;
    await approveAssetForTest(app, assetId, "invoice-tokenization");
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: PAYER, currency: "CBDC-INR", amount: "1000000" } });
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const proposed = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(admin), payload: { from: PAYER } });
    expect(proposed.statusCode).toBe(202);
    expect(proposed.json().proposal.kind).toBe("cashflow-execute");
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const decided = await app.inject({ method: "POST", url: `${V1}/proposals/${proposed.json().proposal.id}/approve`, headers: auth(issuer), payload: {} });
    expect(decided.json().proposal.status).toBe("executed");
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(admin) })).json().status).toBe("matured");
  });

  it("an approved execution that fails (unfunded payer) becomes a failed proposal, error preserved", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await onboardUser(app, admin, platform, { email: "ap.holder2@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { legalName: "AP Holder2", country: "IN" } });
    await onboardUser(app, admin, platform, { email: "ap.settle2@x.dev", password: "secret1", role: "Auditor", walletAddress: PAYER, kyc: { legalName: "AP Settle2", country: "IN" } });
    // Issued by the platform so m1.admin stays free to decide the review (see
    // the previous test's comment).
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(platform), payload: { useCaseKey: "invoice-tokenization", name: "INV-AP-2", chainId: "fabric", initialSupply: "10000", metadata: { invoiceNumber: "INV-AP-2", invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2099-12-31" } } });
    const assetId = issued.json().asset.id;
    await approveAssetForTest(app, assetId, "invoice-tokenization");
    const { cashflows } = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json();
    const proposed = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${cashflows[0].id}/execute`, headers: auth(admin), payload: { from: PAYER } });
    expect(proposed.statusCode).toBe(202); // PAYER is scoped but unfunded — checked at execution
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const decided = await app.inject({ method: "POST", url: `${V1}/proposals/${proposed.json().proposal.id}/approve`, headers: auth(issuer), payload: {} });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().proposal.status).toBe("failed");
    expect(decided.json().proposal.error).toContain("INSUFFICIENT_TREASURY_FUNDS");
    // The cashflow was not consumed — still settleable once funded.
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json().cashflows[0].status).toBe("scheduled");
  });

  it("an ungated operation (a plain mint on an already-active asset) still executes instantly — issuance is the only op this migration changed", async () => {
    // Was: "an ungated operation on the same platform still executes
    // instantly", proved via invoice-tokenization ISSUANCE itself (201,
    // immediately active) — invoice-tokenization never set
    // workflow.approvals.issue, so that used to be true. Task 8 makes
    // issuance due-diligence-gated for every use case, this one included, so
    // that specific example no longer holds. What is still true, and is the
    // actual point this test makes, is that lifecycle ACTIONS this use case
    // never gates (mint, in this case — only cashflow-execute is gated here)
    // keep executing synchronously with no proposal at all, on an asset once
    // it's active.
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await onboardUser(app, admin, platform, { email: "ap.holder3@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { legalName: "AP Holder3", country: "IN" } });
    // Issued by the platform so m1.admin stays free to decide the review.
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(platform), payload: { useCaseKey: "invoice-tokenization", name: "INV-AP-3", chainId: "fabric", metadata: { invoiceNumber: "INV-AP-3", invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2099-12-31" } } });
    expect(issued.statusCode).toBe(202); // issuance is due-diligence-gated now, universally
    const assetId = issued.json().asset.id;
    await approveAssetForTest(app, assetId, "invoice-tokenization");
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(admin) })).json().status).toBe("active");

    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(admin), payload: { account: HOLDER } });
    const mint = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/mint`, headers: auth(admin), payload: { to: HOLDER, amount: "1" } });
    expect(mint.statusCode).toBe(200); // instant — no proposal, mint is not one of this use case's gated ops
  });
});
