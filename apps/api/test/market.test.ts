import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth, TEST_MARKET_ESCROW } from "./helpers.js";

// A platform fee account distinct from any seeded buyer/treasury address.
const FEE_ACCOUNT = "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097";
const TREASURY_ADDR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
// The seeded carbon Buyer's linked wallet (EcoFund Capital) — our seller.
const SELLER_WALLET = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
// Second buyer onboarded during the tests (Nordic Pension Fund).
const BUYER2_WALLET = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
// Third buyer, never funded (TerraNova Trading).
const BUYER3_WALLET = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";

const CBDC = "CBDC-INR";

async function cashBalance(app: FastifyInstance, token: string, address: string): Promise<string> {
  const res = await app.inject({ method: "GET", url: `${V1}/cash/balances?address=${address}`, headers: auth(token) });
  const rows = res.json() as { currency: string; amount: string }[];
  return rows.find((r) => r.currency === CBDC)?.amount ?? "0";
}

async function tokenBalance(app: FastifyInstance, token: string, assetId: string, address: string): Promise<string> {
  const res = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/accounts`, headers: auth(token) });
  const rows = res.json() as { address: string; balance: string }[];
  return rows.find((r) => r.address === address)?.balance ?? "0";
}

/**
 * Shared market fixture on the seeded carbon-credit use case (fabric sim):
 * - 2.5% marketplace fee configured, priced asset (unitPrice 5 CBDC-INR) with
 *   1000 supply minted to the treasury;
 * - the seeded carbon Buyer (KYC-approved, wallet = EcoFund) allowlisted,
 *   funded 10000, and buying 100 from the treasury — our SELLER;
 * - a second Buyer onboarded by the UseCaseAdmin (KYC-approved the way
 *   richer-config.test.ts does), allowlisted, funded 1000 — our BUYER2.
 * Primary buy: cost 500, fee 12 → seller cash 9500, feeAccount 12.
 */
async function setupMarket() {
  const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
  const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

  // Add a 2.5% marketplace fee to the seeded carbon-credit use case (preserve config).
  const carbon = (await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform) })).json();
  await app.inject({ method: "PUT", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform), payload: { ...carbon, fees: { marketplaceBps: 250 } } });

  // Priced asset with supply minted to the treasury.
  const issued = await app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(platform),
    payload: {
      useCaseKey: "carbon-credit", name: "Market Asset", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 },
      sale: { unitPrice: "5", currency: CBDC, treasuryAccount: TREASURY_ADDR },
      treasuryAccount: TREASURY_ADDR, initialSupply: "1000",
    },
  });
  expect(issued.statusCode).toBe(201);
  const assetId = issued.json().asset.id as string;

  // Seller = the seeded carbon Buyer (already KYC-approved, wallet EcoFund).
  await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(carbonAdmin), payload: { account: SELLER_WALLET } });
  await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: SELLER_WALLET, currency: CBDC, amount: "10000" } });
  const seller = await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123");
  const buyRes = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(seller), payload: { quantity: "100" } });
  expect(buyRes.statusCode).toBe(200);

  // BUYER2 onboarded by the UseCaseAdmin, KYC-approved, allowlisted, funded.
  const b2 = (await app.inject({
    method: "POST", url: `${V1}/users`, headers: auth(carbonAdmin),
    payload: { email: "buyer2@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER2_WALLET, kyc: { country: "IN" } },
  })).json();
  await app.inject({ method: "PATCH", url: `${V1}/users/${b2.id}`, headers: auth(carbonAdmin), payload: { kycStatus: "approved" } });
  await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(carbonAdmin), payload: { account: BUYER2_WALLET } });
  await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: BUYER2_WALLET, currency: CBDC, amount: "1000" } });
  const buyer2 = await loginAs(app, "buyer2@x.dev", "secret1");

  return { app, platform, carbonAdmin, seller, buyer2, assetId };
}

/** Onboard a fresh KYC-approved, allowlisted (and optionally funded) Buyer; returns their login token. */
async function onboardBuyer(
  ctx: { app: FastifyInstance; platform: string; carbonAdmin: string; assetId: string },
  email: string,
  wallet: string,
  fundAmount?: string,
): Promise<string> {
  const { app, platform, carbonAdmin, assetId } = ctx;
  const u = (await app.inject({
    method: "POST", url: `${V1}/users`, headers: auth(carbonAdmin),
    payload: { email, password: "secret1", role: "Buyer", walletAddress: wallet, kyc: { country: "IN" } },
  })).json();
  await app.inject({ method: "PATCH", url: `${V1}/users/${u.id}`, headers: auth(carbonAdmin), payload: { kycStatus: "approved" } });
  await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(carbonAdmin), payload: { account: wallet } });
  if (fundAmount) {
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: wallet, currency: CBDC, amount: fundAmount } });
  }
  return loginAs(app, email, "secret1");
}

describe("secondary market: escrowed sell-listings", () => {
  it("full lifecycle: list (escrow moves) → partial take (cash split + fee) → filling take → cancel returns remaining", async () => {
    const { app, platform, seller, buyer2, assetId } = await setupMarket();

    // After the primary buy: seller holds 100 tokens and 9500 cash; fee acct 12.
    expect(await tokenBalance(app, platform, assetId, SELLER_WALLET)).toBe("100");
    expect(await cashBalance(app, platform, SELLER_WALLET)).toBe("9500");
    expect(await cashBalance(app, platform, FEE_ACCOUNT)).toBe("12");

    // LIST 60 @ 7 — tokens move seller → escrow.
    const listRes = await app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller),
      payload: { quantity: "60", unitPrice: "7", currency: CBDC },
    });
    expect(listRes.statusCode).toBe(201);
    const listing = listRes.json();
    expect(listing).toMatchObject({ assetId, seller: SELLER_WALLET, quantity: "60", unitPrice: "7", currency: CBDC, status: "open" });
    // Escrow moved: the seller's on-ledger balance drops by the listed amount.
    expect(await tokenBalance(app, platform, assetId, SELLER_WALLET)).toBe("40");

    // Open listings visible to another buyer, sorted, with the projected fields.
    const open = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/listings`, headers: auth(buyer2) })).json();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: listing.id, seller: SELLER_WALLET, quantity: "60", unitPrice: "7", currency: CBDC });

    // PARTIAL TAKE of 25: cost 175, fee floor(175×250/10000)=4 → seller +171.
    const take1 = await app.inject({ method: "POST", url: `${V1}/listings/${listing.id}/take`, headers: auth(buyer2), payload: { quantity: "25" } });
    expect(take1.statusCode).toBe(200);
    const t1 = take1.json();
    expect(t1.txHash).toBeTruthy();
    expect(t1.fee).toMatchObject({ amount: "4", account: FEE_ACCOUNT });
    expect(t1.listing).toMatchObject({ id: listing.id, quantity: "35", status: "open" });

    expect(await cashBalance(app, platform, SELLER_WALLET)).toBe("9671"); // 9500 + 171
    expect(await cashBalance(app, platform, FEE_ACCOUNT)).toBe("16"); // 12 + 4
    expect(await cashBalance(app, platform, BUYER2_WALLET)).toBe("825"); // 1000 - 175
    expect(await tokenBalance(app, platform, assetId, BUYER2_WALLET)).toBe("25");

    // SECOND TAKE of the remaining 35: cost 245, fee 6 → seller +239; listing filled.
    const take2 = await app.inject({ method: "POST", url: `${V1}/listings/${listing.id}/take`, headers: auth(buyer2), payload: { quantity: "35" } });
    expect(take2.statusCode).toBe(200);
    expect(take2.json().listing).toMatchObject({ quantity: "0", status: "filled" });
    expect(await cashBalance(app, platform, SELLER_WALLET)).toBe("9910"); // 9671 + 239
    expect(await tokenBalance(app, platform, assetId, BUYER2_WALLET)).toBe("60");
    // Filled listings disappear from the open book.
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/listings`, headers: auth(buyer2) })).json()).toHaveLength(0);

    // CANCEL: a separate listing of 20 returns its remaining tokens to the seller.
    const second = (await app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller),
      payload: { quantity: "20", unitPrice: "9", currency: CBDC },
    })).json();
    expect(await tokenBalance(app, platform, assetId, SELLER_WALLET)).toBe("20");
    const cancel = await app.inject({ method: "DELETE", url: `${V1}/listings/${second.id}`, headers: auth(seller) });
    expect(cancel.statusCode).toBe(204);
    expect(await tokenBalance(app, platform, assetId, SELLER_WALLET)).toBe("40");
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller) })).json()).toHaveLength(0);
  });

  it("guards: over-take, own listing, unfunded buyer, over-list, and disabled market", async () => {
    const { app, platform, carbonAdmin, seller, buyer2, assetId } = await setupMarket();

    const listing = (await app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller),
      payload: { quantity: "10", unitPrice: "5", currency: CBDC },
    })).json();

    // take > remaining
    const over = await app.inject({ method: "POST", url: `${V1}/listings/${listing.id}/take`, headers: auth(buyer2), payload: { quantity: "11" } });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toBe("TAKE_EXCEEDS_REMAINING");

    // taking your own listing
    const own = await app.inject({ method: "POST", url: `${V1}/listings/${listing.id}/take`, headers: auth(seller), payload: { quantity: "5" } });
    expect(own.statusCode).toBe(400);
    expect(own.json().error).toBe("OWN_LISTING");

    // a buyer with no cash is blocked cleanly — nothing moves anywhere
    const b3 = (await app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(carbonAdmin),
      payload: { email: "pauper@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER3_WALLET, kyc: { country: "IN" } },
    })).json();
    await app.inject({ method: "PATCH", url: `${V1}/users/${b3.id}`, headers: auth(carbonAdmin), payload: { kycStatus: "approved" } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(carbonAdmin), payload: { account: BUYER3_WALLET } });
    const pauper = await loginAs(app, "pauper@x.dev", "secret1");
    const sellerCashBefore = await cashBalance(app, platform, SELLER_WALLET);
    const broke = await app.inject({ method: "POST", url: `${V1}/listings/${listing.id}/take`, headers: auth(pauper), payload: { quantity: "5" } });
    expect(broke.statusCode).toBe(400);
    expect(broke.json().error).toBe("INSUFFICIENT_FUNDS");
    expect(await cashBalance(app, platform, BUYER3_WALLET)).toBe("0");
    expect(await cashBalance(app, platform, SELLER_WALLET)).toBe(sellerCashBefore);
    expect(await tokenBalance(app, platform, assetId, BUYER3_WALLET)).toBe("0");
    const stillOpen = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/listings`, headers: auth(buyer2) })).json();
    expect(stillOpen[0]).toMatchObject({ id: listing.id, quantity: "10" });

    // listing more than the wallet's holding (seller holds 90 after listing 10 of 100)
    const overList = await app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller),
      payload: { quantity: "1000", unitPrice: "5", currency: CBDC },
    });
    expect(overList.statusCode).toBe(400);
    expect(overList.json().error).toBe("INSUFFICIENT_BALANCE");

    // market disabled (no escrow account configured) → 503 on every market endpoint
    const disabledApp = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT, marketEscrowAccount: undefined });
    const admin = await loginAs(disabledApp, "admin@tokenlayer.dev", "admin123");
    for (const req of [
      { method: "POST" as const, url: `${V1}/assets/any/listings`, payload: { quantity: "1", unitPrice: "1", currency: CBDC } },
      { method: "GET" as const, url: `${V1}/assets/any/listings` },
      { method: "POST" as const, url: `${V1}/listings/any/take`, payload: { quantity: "1" } },
      { method: "DELETE" as const, url: `${V1}/listings/any` },
      { method: "GET" as const, url: `${V1}/assets/any/trades` },
    ]) {
      const res = await disabledApp.inject({ ...req, headers: auth(admin) });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("MARKET_DISABLED");
    }
  });

  it("tenancy: a user from another use case cannot see or take the listing (404)", async () => {
    const { app, seller, assetId } = await setupMarket();
    const listing = (await app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller),
      payload: { quantity: "10", unitPrice: "5", currency: CBDC },
    })).json();

    const goldBuyer = await loginAs(app, "gold.buyer@tokenlayer.dev", "gold123");
    const listings = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/listings`, headers: auth(goldBuyer) });
    expect(listings.statusCode).toBe(404);
    const take = await app.inject({ method: "POST", url: `${V1}/listings/${listing.id}/take`, headers: auth(goldBuyer), payload: { quantity: "1" } });
    expect(take.statusCode).toBe(404);
    const trades = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/trades`, headers: auth(goldBuyer) });
    expect(trades.statusCode).toBe(404);
    const cancel = await app.inject({ method: "DELETE", url: `${V1}/listings/${listing.id}`, headers: auth(goldBuyer) });
    expect(cancel.statusCode).toBe(404);
  });

  it("trades feed: returns primary + secondary buys, newest first, with the secondary flag", async () => {
    const { app, seller, buyer2, assetId } = await setupMarket();
    const listing = (await app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller),
      payload: { quantity: "60", unitPrice: "7", currency: CBDC },
    })).json();
    const take = await app.inject({ method: "POST", url: `${V1}/listings/${listing.id}/take`, headers: auth(buyer2), payload: { quantity: "25" } });
    expect(take.statusCode).toBe(200);

    const trades = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/trades`, headers: auth(buyer2) })).json();
    expect(trades).toHaveLength(2);
    // Newest first: the secondary take, then the primary treasury buy. The
    // secondary trade shows the SELLER as `from` — never the pooled escrow.
    expect(trades[0]).toMatchObject({ amount: "25", unitPrice: "7", currency: CBDC, from: SELLER_WALLET, to: BUYER2_WALLET, secondary: true });
    expect(trades[0].from).not.toBe(TEST_MARKET_ESCROW);
    expect(trades[0].at).toBeTruthy();
    expect(trades[1]).toMatchObject({ amount: "100", unitPrice: "5", currency: CBDC, from: TREASURY_ADDR, to: SELLER_WALLET, secondary: false });
  });

  it("concurrency: two takes racing for more than the remainder — exactly one wins, the pooled escrow never over-delivers", async () => {
    const ctx = await setupMarket();
    const { app, platform, seller, buyer2, assetId } = ctx;

    // Give the seller 200 tokens (fixture bought 100; buy 100 more) and onboard
    // a second funded buyer so BOTH takes clear the read-only funds guard.
    const more = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(seller), payload: { quantity: "100" } });
    expect(more.statusCode).toBe(200);
    const buyer3 = await onboardBuyer(ctx, "buyer3@x.dev", BUYER3_WALLET, "1000");

    const listing = (await app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller),
      payload: { quantity: "150", unitPrice: "4", currency: CBDC },
    })).json();
    expect(listing.status).toBe("open");

    // THE RACE: 100 + 100 > 150. The escrow is POOLED across all listings of
    // the asset, so without an atomic reserve both settles would "succeed" and
    // the second one would draw on some other seller's escrowed tokens.
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: `${V1}/listings/${listing.id}/take`, headers: auth(buyer2), payload: { quantity: "100" } }),
      app.inject({ method: "POST", url: `${V1}/listings/${listing.id}/take`, headers: auth(buyer3), payload: { quantity: "100" } }),
    ]);

    // Tolerant of WHICH request wins — assert on the outcome set.
    const outcomes = [
      { res: r1, wallet: BUYER2_WALLET },
      { res: r2, wallet: BUYER3_WALLET },
    ];
    const winners = outcomes.filter((o) => o.res.statusCode === 200);
    const losers = outcomes.filter((o) => o.res.statusCode !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect([400, 409]).toContain(losers[0]!.res.statusCode);
    expect(["TAKE_EXCEEDS_REMAINING", "LISTING_CONFLICT"]).toContain(losers[0]!.res.json().error);

    // Total delivered ≤ 150, and listing remaining + delivered = 150.
    expect(await tokenBalance(app, platform, assetId, winners[0]!.wallet)).toBe("100");
    expect(await tokenBalance(app, platform, assetId, losers[0]!.wallet)).toBe("0");
    const open = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller) })).json();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: listing.id, quantity: "50" }); // 150 reserved-down by exactly one take

    // The failed buyer's cash is untouched; the winner paid exactly 400 (100 @ 4).
    expect(await cashBalance(app, platform, losers[0]!.wallet)).toBe("1000");
    expect(await cashBalance(app, platform, winners[0]!.wallet)).toBe("600");
  });

  it("concurrency: two cancels race — one 204, one conflict, and the escrow is released exactly once", async () => {
    const { app, platform, seller, assetId } = await setupMarket();
    const listing = (await app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller),
      payload: { quantity: "20", unitPrice: "5", currency: CBDC },
    })).json();
    expect(await tokenBalance(app, platform, assetId, SELLER_WALLET)).toBe("80");

    const [c1, c2] = await Promise.all([
      app.inject({ method: "DELETE", url: `${V1}/listings/${listing.id}`, headers: auth(seller) }),
      app.inject({ method: "DELETE", url: `${V1}/listings/${listing.id}`, headers: auth(seller) }),
    ]);
    const statuses = [c1.statusCode, c2.statusCode].sort((a, b) => a - b);
    expect(statuses[0]).toBe(204);
    expect(statuses[1]).toBeGreaterThanOrEqual(400); // LISTING_NOT_OPEN (400) or LISTING_CONFLICT (409) — never a second 204

    // The seller got the remaining 20 back exactly ONCE: 80 + 20, not 80 + 40.
    expect(await tokenBalance(app, platform, assetId, SELLER_WALLET)).toBe("100");
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller) })).json()).toHaveLength(0);
  });

  it("holder-count: a seller that fully exits via the market stops counting — new holders are not falsely blocked", async () => {
    const ctx = await setupMarket();
    const { app, platform, seller, buyer2, assetId } = ctx;

    // Cap holders at 3. Current genuine holders: treasury + seller = 2.
    const carbon = (await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform) })).json();
    const put = await app.inject({
      method: "PUT", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform),
      payload: { ...carbon, compliance: { ...carbon.compliance, maxHolders: 3 } },
    });
    expect(put.statusCode).toBe(200);

    // Seller lists ALL 100 tokens; buyer2 takes all → the seller has fully exited.
    const listing = (await app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/listings`, headers: auth(seller),
      payload: { quantity: "100", unitPrice: "5", currency: CBDC },
    })).json();
    const take = await app.inject({ method: "POST", url: `${V1}/listings/${listing.id}/take`, headers: auth(buyer2), payload: { quantity: "100" } });
    expect(take.statusCode).toBe(200);
    expect(await tokenBalance(app, platform, assetId, SELLER_WALLET)).toBe("0");

    // Holders are now {treasury, buyer2} = 2 < 3. Before the fold fix the
    // secondary buy debited the ESCROW, so the exited seller kept a phantom
    // credit ({treasury, seller, buyer2} = 3 ≥ 3) and this brand-new holder's
    // primary buy failed with a false HOLDER_LIMIT_EXCEEDED.
    const buyer3 = await onboardBuyer(ctx, "buyer3@x.dev", BUYER3_WALLET, "1000");
    const buy = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(buyer3), payload: { quantity: "10" } });
    expect(buy.statusCode).toBe(200);
    expect(await tokenBalance(app, platform, assetId, BUYER3_WALLET)).toBe("10");
  });
});
