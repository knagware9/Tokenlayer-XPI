import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth, onboardUser, PLATFORM_ADMIN_2 } from "./helpers.js";

// The compensation seam: when a gated issuance will never activate, issueKind
// .compensate() must undo BOTH halves of the propose-time side effects — the
// captured issuance fee is refunded, and (on reject) the asset flips to rejected.
// richer-config.test.ts covers CHARGING the fee; this file covers giving it back.

// A platform fee account distinct from any seeded buyer/treasury address.
const FEE_ACCOUNT = "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097";
// The proposer's linked wallet — the issuance fee payer (routes charges the caller).
const ISSUER_WALLET = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";

/** A use case that BOTH charges a 100 issuance fee AND gates issue behind 1 approval. */
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
 * Stand up the gated+fee use case with a funded proposer (UseCaseAdmin, wallet
 * linked → fee payer) and a second eligible approver (Issuer holds `issue`),
 * since the proposer may not decide their own proposal.
 */
async function setup(app: FastifyInstance) {
  const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  expect((await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(platform), payload: GATED_FEE_UC })).statusCode).toBe(201);

  // The FIRST UseCaseAdmin of a brand-new use case is bootstrapped by the platform
  // admin proposing and a SECOND platform admin checking (no gated-fee-note UCA
  // exists yet, and the proposer may not self-approve).
  const platform2 = await loginAs(app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
  const proposerUser = await onboardUser(app, platform, platform2, {
    email: "gf.admin@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: "gated-fee-note", walletAddress: ISSUER_WALLET, kyc: { country: "IN" },
  });
  // Issuers are created by the scoped UseCaseAdmin (checked by the platform admin).
  const proposer = await loginAs(app, "gf.admin@x.dev", "secret1");
  await onboardUser(app, proposer, platform, {
    email: "gf.approver@x.dev", password: "secret1", role: "Issuer", useCaseKey: "gated-fee-note",
  });

  // The proposer must hold enough cash to pay the 100 issuance fee.
  await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: ISSUER_WALLET, currency: "CBDC-INR", amount: "500" } });

  return {
    platform,
    proposerId: proposerUser.id as string,
    proposer,
    approver: await loginAs(app, "gf.approver@x.dev", "secret1"),
  };
}

/** Propose a gated issuance; assert it was gated (202) AND the fee was charged. */
async function proposeAndAssertCharged(app: FastifyInstance, tokens: { platform: string; proposer: string }, name: string) {
  const res = await app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(tokens.proposer),
    payload: { useCaseKey: "gated-fee-note", name, chainId: "fabric", metadata: { faceValue: 100 } },
  });
  expect(res.statusCode).toBe(202);
  const { proposal, asset } = res.json();
  expect(proposal.status).toBe("pending");
  expect(proposal.kind).toBe("issue");
  expect(asset.status).toBe("pending_approval");
  // Charged at propose time: 500 - 100 out of the issuer's wallet, into the fee account.
  expect(await cashBalance(app, tokens.platform, ISSUER_WALLET)).toBe("400");
  expect(await cashBalance(app, tokens.platform, FEE_ACCOUNT)).toBe("100");
  return { proposal, asset };
}

describe("proposal compensation: a gated issuance that never activates keeps no fee", () => {
  it("reject: refunds the captured issuance fee AND flips the asset to rejected", async () => {
    const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
    const t = await setup(app);
    const { proposal, asset } = await proposeAndAssertCharged(app, t, "GFN-REJECT");

    // A distinct eligible approver rejects (the proposer may not decide their own).
    const rej = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/reject`, headers: auth(t.approver), payload: {} });
    expect(rej.statusCode).toBe(200);
    expect(rej.json().proposal.status).toBe("rejected");

    // Half 1 — the fee came back from the fee account to the payer.
    expect(await cashBalance(app, t.platform, ISSUER_WALLET)).toBe("500");
    expect(await cashBalance(app, t.platform, FEE_ACCOUNT)).toBe("0");
    // Half 2 — the asset is rejected, not left stranded in pending_approval.
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(t.platform) })).json().status).toBe("rejected");
  });

  it("failed execution (inactive proposer): refunds the fee; the asset is not marked rejected", async () => {
    const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
    const t = await setup(app);
    const { proposal, asset } = await proposeAndAssertCharged(app, t, "GFN-FAILED");

    // Deactivate the proposer so the approval cannot execute under their identity
    // → decide() takes the PROPOSER_INACTIVE branch and compensates with "failed".
    expect((await app.inject({ method: "PATCH", url: `${V1}/users/${t.proposerId}`, headers: auth(t.platform), payload: { active: false } })).statusCode).toBe(200);

    const approved = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/approve`, headers: auth(t.approver), payload: {} });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().proposal.status).toBe("failed");
    expect(approved.json().proposal.error).toBe("PROPOSER_INACTIVE");

    // The fee is refunded on the "failed" reason too (parity with reject)...
    expect(await cashBalance(app, t.platform, ISSUER_WALLET)).toBe("500");
    expect(await cashBalance(app, t.platform, FEE_ACCOUNT)).toBe("0");
    // ...but only a REJECT flips the asset — a failure leaves it as it was.
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${asset.id}`, headers: auth(t.platform) })).json().status).toBe("pending_approval");
  });
});
