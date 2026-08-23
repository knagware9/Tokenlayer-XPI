import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth, onboardUser, treasuryAddressOf, PLATFORM_ADMIN_2 } from "./helpers.js";

// Seeded accounts (unlinked → usable as treasuries/holders).
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const HOLDER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Carol
const PAYER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // Treasury

// corporate-bond gates workflow.approvals.issue=1 + cashflow-execute=1. Its
// defaultChainId is besu (absent in the sim stack) — issue on a deployed chain.
const bondMeta = { issuer: "Acme Corp", isin: "INE000A01011", faceValue: 5_000_000, couponRate: 8, maturityDate: "2099-12-31" };

async function bondChain(app: FastifyInstance, token: string): Promise<string> {
  const uc = (await app.inject({ method: "GET", url: `${V1}/use-cases/corporate-bond`, headers: auth(token) })).json();
  return Object.keys(uc.contracts ?? {})[0] ?? "fabric";
}
async function proposeBond(app: FastifyInstance, proposer: string, name: string) {
  const chainId = await bondChain(app, proposer);
  return app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(proposer), payload: { useCaseKey: "corporate-bond", name, chainId, initialSupply: "1000", metadata: bondMeta } });
}

describe("maker-checker: gated issuance lifecycle", () => {
  it("gated issuance returns 202 + a pending proposal + a frozen pending_approval asset", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const res = await proposeBond(app, admin, "BOND-1");
    expect(res.statusCode).toBe(202);
    const { proposal, asset } = res.json();
    expect(proposal.status).toBe("pending");
    expect(proposal.kind).toBe("issue");
    expect(asset.status).toBe("pending_approval");
    // Frozen: no actions / buy / listing while pending.
    expect((await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/actions/mint`, headers: auth(admin), payload: { to: BOB, amount: "1" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/buy`, headers: auth(admin), payload: { quantity: "1" } })).statusCode).toBe(409);
  });

  it("approval by a distinct capability holder mints the deferred supply and activates", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const { proposal, asset } = (await proposeBond(app, admin, "BOND-2")).json();
    const issuer = await loginAs(app, "bond.issuer@tokenlayer.dev", "bond123");
    const decided = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(issuer), payload: {} });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().proposal.status).toBe("executed");
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

  it("gated issuance with sale terms but NO initial supply: approval writes the sale terms, not a silent no-op", async () => {
    // Regression: `treasury` used to be captured in the proposal payload only
    // when `initialSupply` was also requested (`wantsSupply ? {initialSupply,
    // treasury} : {}`), so a gated issue with `sale` alone silently dropped the
    // sale terms on approval — no mint (nothing to gate) but no price either.
    const app = await buildTestApp();
    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const chainId = await bondChain(app, admin);
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const treasury = await treasuryAddressOf(app, platform, "corporate-bond");

    const res = await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(admin),
      payload: { useCaseKey: "corporate-bond", name: "BOND-SALE-ONLY", chainId, sale: { unitPrice: "5", currency: "CBDC-INR" }, metadata: bondMeta },
    });
    expect(res.statusCode).toBe(202);
    const { proposal, asset } = res.json();
    expect(asset.unitPrice).toBeNull(); // deferred to approval, not set yet

    const issuer = await loginAs(app, "bond.issuer@tokenlayer.dev", "bond123");
    const decided = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(issuer), payload: {} });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().proposal.status).toBe("executed");

    const after = (await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(admin) })).json();
    expect(after.unitPrice).toBe("5");
    expect(after.currency).toBe("CBDC-INR");
    expect(after.treasuryAccount).toBe(treasury);
    // No supply was requested — nothing minted.
    const accts = (await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}/accounts`, headers: auth(admin) })).json();
    expect(accts.find((a: { address: string }) => a.address.toLowerCase() === treasury.toLowerCase())).toBeUndefined();
  });

  it("segregation of duties: the proposer cannot approve their own proposal", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const { proposal } = (await proposeBond(app, admin, "BOND-3")).json();
    const self = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(admin), payload: {} });
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe("SELF_APPROVAL");
  });

  it("rejection marks the proposal rejected and the pending asset rejected", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const { proposal, asset } = (await proposeBond(app, admin, "BOND-4")).json();
    const issuer = await loginAs(app, "bond.issuer@tokenlayer.dev", "bond123");
    const rej = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/reject`, headers: auth(issuer), payload: {} });
    expect(rej.statusCode).toBe(200);
    expect(rej.json().proposal.status).toBe("rejected");
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(admin) })).json().status).toBe("rejected");
    // A decided proposal cannot be approved.
    const late = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(issuer), payload: {} });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("PROPOSAL_NOT_PENDING");
  });

  it("eligibility: a Buyer cannot approve; a cross-tenant user gets 404", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const { proposal } = (await proposeBond(app, admin, "BOND-5")).json();
    const buyer = await loginAs(app, "bond.buyer@tokenlayer.dev", "bond123");
    const notEligible = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(buyer), payload: {} });
    expect(notEligible.statusCode).toBe(403);
    expect(notEligible.json().error).toBe("NOT_ELIGIBLE");
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    expect((await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(carbon), payload: {} })).statusCode).toBe(404);
  });
});

describe("maker-checker: thresholds + concurrency", () => {
  // An on-the-fly use case with issue threshold 2 and no compliance gating.
  async function makeT2(app: FastifyInstance): Promise<{ adminTok: string; iss1: string; iss2: string; chainId: string }> {
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
    for (const e of ["t2.i1@x.dev", "t2.i2@x.dev"]) {
      await onboardUser(app, adminTok, platform, { email: e, password: "secret1", role: "Issuer", useCaseKey: "t2-note" });
    }
    return { adminTok, iss1: await loginAs(app, "t2.i1@x.dev", "secret1"), iss2: await loginAs(app, "t2.i2@x.dev", "secret1"), chainId: "fabric" };
  }

  it("threshold 2: the first approval leaves it pending; the second (distinct approver) executes", async () => {
    const app = await buildTestApp();
    const { adminTok, iss1, iss2, chainId } = await makeT2(app);
    const { proposal } = (await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(adminTok), payload: { useCaseKey: "t2-note", name: "N1", chainId, initialSupply: "500", metadata: { faceValue: 100 } } })).json();
    const first = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(iss1), payload: {} });
    expect(first.json().proposal.status).toBe("pending");
    expect(first.json().proposal.approvals).toHaveLength(1);
    const second = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(iss2), payload: {} });
    expect(second.json().proposal.status).toBe("executed");
  });

  it("the same approver cannot approve twice", async () => {
    const app = await buildTestApp();
    const { adminTok, iss1, chainId } = await makeT2(app);
    const { proposal } = (await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(adminTok), payload: { useCaseKey: "t2-note", name: "N2", chainId, initialSupply: "500", metadata: { faceValue: 100 } } })).json();
    expect((await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(iss1), payload: {} })).json().proposal.status).toBe("pending");
    const dup = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(iss1), payload: {} });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("ALREADY_APPROVED_BY_YOU");
  });

  it("two concurrent final approvals execute the operation exactly once", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "bond.admin@tokenlayer.dev", "bond123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // corporate-bond gates issue:1 — add a second eligible approver.
    await onboardUser(app, admin, platform, { email: "bond.iss2@x.dev", password: "secret1", role: "Issuer", useCaseKey: "corporate-bond" });
    const { proposal, asset } = (await proposeBond(app, admin, "BOND-RACE")).json();
    const a1 = await loginAs(app, "bond.issuer@tokenlayer.dev", "bond123");
    const a2 = await loginAs(app, "bond.iss2@x.dev", "secret1");
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(a1), payload: {} }),
      app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(a2), payload: {} }),
    ]);
    const statuses = [r1, r2].map((r) => (r.json().proposal?.status ?? r.json().error));
    expect(statuses.filter((s) => s === "executed")).toHaveLength(1);
    expect(statuses.filter((s) => s === "PROPOSAL_NOT_PENDING")).toHaveLength(1);
    // Supply minted exactly once, into the use case's own server-derived
    // treasury — looked up as platform since the treasury Account is never
    // linked to a user, so a scoped GET /accounts would never show it.
    const treasury = await treasuryAddressOf(app, platform, "corporate-bond");
    const accts = (await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}/accounts`, headers: auth(admin) })).json();
    expect(accts.find((a: { address: string }) => a.address.toLowerCase() === treasury.toLowerCase())?.balance).toBe("1000");
  });
});

describe("maker-checker: gated settlement + ungated pass-through", () => {
  it("invoice settlement is proposal-gated: 202 then approval pays out and matures", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await onboardUser(app, admin, platform, { email: "ap.holder@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { legalName: "AP Holder", country: "IN" } });
    await onboardUser(app, admin, platform, { email: "ap.settle@x.dev", password: "secret1", role: "Auditor", walletAddress: PAYER, kyc: { legalName: "AP Settle", country: "IN" } });
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { useCaseKey: "invoice-tokenization", name: "INV-AP-1", chainId: "fabric", initialSupply: "10000", metadata: { invoiceNumber: "INV-AP-1", invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2099-12-31" } } });
    expect(issued.statusCode).toBe(201); // invoice issuance is NOT gated
    const assetId = issued.json().asset.id;
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
    const assetId = (await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { useCaseKey: "invoice-tokenization", name: "INV-AP-2", chainId: "fabric", initialSupply: "10000", metadata: { invoiceNumber: "INV-AP-2", invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2099-12-31" } } })).json().asset.id;
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

  it("an ungated operation on the same platform still executes instantly", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await onboardUser(app, admin, platform, { email: "ap.holder3@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { legalName: "AP Holder3", country: "IN" } });
    // Invoice issuance is ungated → 201 immediately with supply minted.
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { useCaseKey: "invoice-tokenization", name: "INV-AP-3", chainId: "fabric", initialSupply: "10000", metadata: { invoiceNumber: "INV-AP-3", invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2099-12-31" } } });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().asset.status).toBe("active");
  });
});
