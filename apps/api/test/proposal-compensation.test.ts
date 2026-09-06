import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth, onboardUser, PLATFORM_ADMIN_2 } from "./helpers.js";

// This file originally covered the compensation seam on the OLD gated-issuance
// proposal path: when a gated issuance would never activate (rejected, or its
// approval failed to execute), issueKind.compensate() undid BOTH halves of the
// propose-time side effects — the captured issuance fee was refunded, and (on
// reject only) the asset flipped to rejected. richer-config.test.ts covers
// CHARGING the fee; this file covers giving it back.
//
// Task 8 retired the whole proposal path for issuance: issueAssetCore no
// longer calls proposeIfGated for "issue" at all, so POST /assets never
// returns a `proposal` for a gated-fee use case any more. The PROPOSER_INACTIVE
// failure mode (an approval that can't execute because the original proposer
// went inactive first) is gone too: review-decision performs the mint/sale
// directly, attributed to the DECIDER (`claims.id`), not to whoever created
// the asset — there is no "proposer identity" execution runs as any more, so
// nothing can fail on account of one going inactive.
//
// Task 8 shipped WITHOUT a replacement for issueKind.compensate()'s refund,
// though — an issuer whose asset was rejected simply kept being charged the
// fee, silently, forever. This task-8-fixup restores it: issueAssetCore now
// stashes the charged fee (amount/currency/payer) on the asset's own
// `dueDiligence.pendingIssuanceFee` at issuance time (there is no proposal
// payload left to keep it on), and review-decision's reject branch reads it
// back and refunds it directly — the same transfer issueKind.compensate() used
// to make, just performed at the new chokepoint instead of the old one.
// (issuanceFeeCharged itself — charged unconditionally at issuance, before the
// gated/ungated branch — is unchanged; only what happens to it AFTER a
// decision is what this file covers.)

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

describe("issuance fee: charged unconditionally at issuance, refunded only on review-decision rejection", () => {
  it("reject via review-decision refunds the issuance fee back to the issuer", async () => {
    const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
    const t = await setup(app);
    const { asset } = await issueAndSubmit(app, t, "GFN-REJECT");

    const rej = await app.inject({
      method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(t.admin),
      payload: { decision: "rejected", rejectionReason: "faceValue too small for this desk" },
    });
    expect(rej.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(t.platform) })).json().status).toBe("rejected");

    // The fee moves straight back from the platform fee account to the
    // issuer's wallet — review-decision's reject branch reads
    // `dueDiligence.pendingIssuanceFee` (stashed at issuance time) and refunds
    // it, mirroring the old issueKind.compensate() hook's refundIssuanceFee.
    expect(await cashBalance(app, t.platform, ISSUER_WALLET)).toBe("500");
    expect(await cashBalance(app, t.platform, FEE_ACCOUNT)).toBe("0");
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

  // Whole-branch-review fixup: rejection used to be a permanent dead end (see
  // asset-submit-for-review.test.ts), and separately, the reject branch here
  // refunded `dueDiligence.pendingIssuanceFee` without ever clearing it. Once
  // rejection stopped being terminal, those two bugs compound: reject (refund
  // #1) -> resubmit -> reject again (refund #2 of a fee that was never
  // recharged) would hand the issuer double their money back. This proves the
  // fee field is cleared after the first refund, so a second rejection on the
  // SAME resubmitted asset is a no-op for cash movement.
  it("rejecting a resubmitted asset a second time does NOT refund the issuance fee again", async () => {
    const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
    const t = await setup(app);
    const { asset } = await issueAndSubmit(app, t, "GFN-DOUBLE-REJECT");

    const firstReject = await app.inject({
      method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(t.admin),
      payload: { decision: "rejected", rejectionReason: "faceValue too small for this desk" },
    });
    expect(firstReject.statusCode).toBe(200);
    expect(await cashBalance(app, t.platform, ISSUER_WALLET)).toBe("500");
    expect(await cashBalance(app, t.platform, FEE_ACCOUNT)).toBe("0");

    // Resubmit without re-issuing (no new fee is charged — that only happens
    // at POST /assets time) and reject again.
    await app.inject({
      method: "POST", url: `${V1}/assets/${asset.id}/diligence/documents`, headers: auth(t.issuer),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 revised").toString("base64") },
    });
    const resubmit = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/submit-for-review`, headers: auth(t.issuer) });
    expect(resubmit.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(t.platform) })).json().status).toBe("pending_approval");

    const secondReject = await app.inject({
      method: "POST", url: `${V1}/assets/${asset.id}/review-decision`, headers: auth(t.admin),
      payload: { decision: "rejected", rejectionReason: "still not good enough" },
    });
    expect(secondReject.statusCode).toBe(200);

    // No second refund: the issuer never paid a second time, so the fee
    // account must stay at 0 and the issuer's wallet must stay at 500 — not
    // "grow" a phantom 100 out of a fee field that was never cleared.
    expect(await cashBalance(app, t.platform, ISSUER_WALLET)).toBe("500");
    expect(await cashBalance(app, t.platform, FEE_ACCOUNT)).toBe("0");
  });
});
