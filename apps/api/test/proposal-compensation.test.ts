import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth, onboardUser, PLATFORM_ADMIN_2 } from "./helpers.js";

// This file originally covered the compensation seam on the OLD gated-issuance
// proposal path: when a gated issuance would never activate (rejected, or its
// approval failed to execute), issueKind.compensate() undid BOTH halves of the
// propose-time side effects — the captured issuance fee was refunded, and (on
// reject only) the asset flipped to rejected. richer-config.test.ts covers
// CHARGING the fee; this file covered giving it back.
//
// Task 8 retires the whole proposal path for issuance: issueAssetCore no
// longer calls proposeIfGated for "issue" at all, so POST /assets never
// returns a `proposal` for a gated-fee use case any more, and there is no
// compensate() to run when review-decision rejects an asset — its reject
// branch simply flips the status, nothing more. The PROPOSER_INACTIVE failure
// mode (an approval that can't execute because the original proposer went
// inactive first) is gone too: review-decision performs the mint/sale
// directly, attributed to the DECIDER (`claims.id`), not to whoever created
// the asset — there is no "proposer identity" execution runs as any more, so
// nothing can fail on account of one going inactive.
// (issuanceFeeCharged itself — charged unconditionally at issuance, before the
// gated/ungated branch — is UNCHANGED by Task 8; only what happens to it AFTER
// a decision is what this file's rewrite is actually about.)

// A platform fee account distinct from any seeded buyer/treasury address.
const FEE_ACCOUNT = "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097";
// The issuer's linked wallet — the issuance fee payer (routes charges the caller).
const ISSUER_WALLET = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";

/** A use case that BOTH charges a 100 issuance fee AND (inertly, post-Task-8)
 *  gates issue behind 1 approval — kept to prove the fee behaves identically
 *  whether or not that now-dead config is present. */
const GATED_FEE_UC = {
  key: "gated-fee-note",
  name: "Gated Fee Note",
  symbol: "GFN",
  tokenStandard: "ERC-20",
  allowedChainIds: ["fabric"],
  defaultChainId: "fabric",
  metadataSchema: { type: "object", properties: { faceValue: { type: "number" } }, required: ["faceValue"] },
  lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
  compliance: { allowlist: false, transferRestrictions: false },
  // saleTermsDefault makes the fee currency determinable without per-asset sale terms.
  fees: { issuanceFlat: "100" },
  saleTermsDefault: { unitPrice: "5", currency: "CBDC-INR" },
  workflow: { approvals: { issue: 1 } },
  roles: ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"],
};

async function cashBalance(app: FastifyInstance, token: string, address: string): Promise<string> {
  const res = await app.inject({ method: "GET", url: `${V1}/cash/balances?address=${address}`, headers: auth(token) });
  const rows = res.json() as { currency: string; amount: string }[];
  return rows.find((r) => r.currency === "CBDC-INR")?.amount ?? "0";
}

/**
 * Stand up the gated+fee use case with a funded Issuer (wallet linked → fee
 * payer) who will CREATE the asset, and the use case's own UseCaseAdmin who
 * will DECIDE its review — kept distinct throughout, since review-decision
 * refuses a creator deciding their own asset.
 */
async function setup(app: FastifyInstance) {
  const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  expect((await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(platform), payload: GATED_FEE_UC })).statusCode).toBe(201);

  // The FIRST UseCaseAdmin of a brand-new use case is bootstrapped by the platform
  // admin proposing and a SECOND platform admin checking (no gated-fee-note UCA
  // exists yet, and the proposer may not self-approve).
  const platform2 = await loginAs(app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
  await onboardUser(app, platform, platform2, {
    email: "gf.admin@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: "gated-fee-note",
  });
  const admin = await loginAs(app, "gf.admin@x.dev", "secret1");

  // The Issuer is created by the scoped UseCaseAdmin (checked by the platform
  // admin), holds the fee-paying wallet, and is the one who issues the asset.
  const issuerUser = await onboardUser(app, admin, platform, {
    email: "gf.issuer@x.dev", password: "secret1", role: "Issuer", useCaseKey: "gated-fee-note", walletAddress: ISSUER_WALLET, kyc: { country: "IN" },
  });

  // The issuer must hold enough cash to pay the 100 issuance fee.
  await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: ISSUER_WALLET, currency: "CBDC-INR", amount: "500" } });

  return {
    platform,
    issuerId: issuerUser.id as string,
    issuer: await loginAs(app, "gf.issuer@x.dev", "secret1"),
    admin,
  };
}

/** Issue (asserting the fee was charged and the asset is pending_approval —
 *  no `proposal` field exists any more, see this file's header comment), then
 *  complete the due-diligence paperwork so the asset is ready to be decided. */
async function issueAndSubmit(app: FastifyInstance, tokens: { platform: string; issuer: string }, name: string) {
  const res = await app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(tokens.issuer),
    payload: { useCaseKey: "gated-fee-note", name, chainId: "fabric", metadata: { faceValue: 100 } },
  });
  expect(res.statusCode).toBe(202);
  const { asset } = res.json();
  expect(asset.status).toBe("pending_approval");
  // Charged at issuance time regardless of gating — issueAssetCore's
  // issuanceFeeCharged runs before the gated/ungated branch, unchanged by
  // Task 8: 500 - 100 out of the issuer's wallet, into the fee account.
  expect(await cashBalance(app, tokens.platform, ISSUER_WALLET)).toBe("400");
  expect(await cashBalance(app, tokens.platform, FEE_ACCOUNT)).toBe("100");

  await app.inject({
    method: "POST", url: `${V1}/assets/${asset.id}/diligence/documents`, headers: auth(tokens.issuer),
    payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
  });
  await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/submit-for-review`, headers: auth(tokens.issuer) });
  return { asset };
}

describe("issuance fee: charged unconditionally at issuance now — review-decision never refunds it either way", () => {
  it("reject via review-decision flips the asset to rejected but does NOT refund the fee", async () => {
    const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
    const t = await setup(app);
    const { asset } = await issueAndSubmit(app, t, "GFN-REJECT");

    const rej = await app.inject({
      method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(t.admin),
      payload: { decision: "rejected", rejectionReason: "faceValue too small for this desk" },
    });
    expect(rej.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(t.platform) })).json().status).toBe("rejected");

    // The fee stays exactly where it landed at issuance — review-decision's
    // reject branch performs no compensation at all (see this file's header
    // comment for why: there is no proposal left to run compensate() on).
    expect(await cashBalance(app, t.platform, ISSUER_WALLET)).toBe("400");
    expect(await cashBalance(app, t.platform, FEE_ACCOUNT)).toBe("100");
  });

  it("approve via review-decision keeps the fee charged too — it's a one-way charge regardless of the decision", async () => {
    const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
    const t = await setup(app);
    const { asset } = await issueAndSubmit(app, t, "GFN-APPROVE");

    const dec = await app.inject({
      method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(t.admin),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(dec.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(t.platform) })).json().status).toBe("active");

    // Same charge, same balance — approval was never the thing that made the
    // fee stick; issuance itself already did, in both outcomes.
    expect(await cashBalance(app, t.platform, ISSUER_WALLET)).toBe("400");
    expect(await cashBalance(app, t.platform, FEE_ACCOUNT)).toBe("100");
  });
});
