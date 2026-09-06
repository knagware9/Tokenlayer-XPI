import { describe, it, expect } from "vitest";
import { approveAssetForTest, buildTestApp, V1, loginAs, auth, onboardUser, treasuryAddressOf } from "./helpers.js";

const UC = "invoice-tokenization";
const HOLDER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Carol — seeded account, linkable

const inv = (n: string, amount: number) => ({
  invoiceNumber: n, invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited",
  currency: "INR", amount, dueDate: "2026-10-01",
});

/** Issued by the platform (not `admin` — m1.admin, invoice-tokenization's own
 *  seeded UseCaseAdmin) so `admin` stays free to DECIDE this asset's
 *  due-diligence review below — review-decision refuses a creator deciding
 *  their own asset. Every asset now starts `pending_approval`; complete the
 *  flow via the shared helper so callers get back an active asset with the
 *  requested supply minted, same as before this task's flip. */
async function issue(
  app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, n: string, amount: number, supply: string,
  sale?: { unitPrice: string; currency: string },
): Promise<string> {
  const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  const res = await app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(platform),
    payload: { useCaseKey: UC, name: n, chainId: "fabric", initialSupply: supply, metadata: inv(n, amount), ...(sale ? { sale } : {}) },
  });
  expect(res.statusCode).toBe(202);
  const assetId = res.json().asset.id as string;
  await approveAssetForTest(app, assetId, UC);
  return assetId;
}

/**
 * Two assets issued under the SAME use case on the SAME simulated chain
 * (fabric) share that use case's single deployed contract — a real EVM chain
 * does too (see ComplianceToken.sol: a flat totalSupply/balanceOf, no asset
 * dimension). GET /assets and GET /assets/:id must still answer for each
 * asset's OWN supply, folded from its own audit stream — not a raw chain
 * read, which would pool every asset sharing that contract together.
 *
 * GET /assets/:id/accounts's `balance` is covered too, via a SEPARATE fold
 * (foldAssetRawBalances) that stays literal about escrow legs — list/
 * cancel-listing/secondary-buy really do move balance on the ledger, unlike
 * the economic-ownership fold portfolio/holder-count views use (see
 * holders.ts) — proven by the escrow-lifecycle test below matching what
 * market.test.ts already asserts for a single asset, now checked to not leak
 * onto a sibling asset either.
 */
describe("per-asset supply/balance isolation on a shared simulated contract", () => {
  it("GET /assets/:id reports each asset's own totalSupply, not another asset's sharing the same contract", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");

    const assetA = await issue(app, admin, "INV-SUPPLY-A", 500000, "10000");
    const assetB = await issue(app, admin, "INV-SUPPLY-B", 200000, "3000");

    const getA = await app.inject({ method: "GET", url: `${V1}/assets/${assetA}`, headers: auth(admin) });
    const getB = await app.inject({ method: "GET", url: `${V1}/assets/${assetB}`, headers: auth(admin) });
    expect(getA.json().totalSupply).toBe("10000");
    expect(getB.json().totalSupply).toBe("3000");
  });

  it("GET /assets (list) reports distinct totalSupply/availableSupply per row, not the pooled contract figure", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");

    const sale = { unitPrice: "100", currency: "CBDC-INR" };
    const assetA = await issue(app, admin, "INV-LIST-A", 500000, "8000", sale);
    const assetB = await issue(app, admin, "INV-LIST-B", 200000, "1500", sale);

    const list = await app.inject({ method: "GET", url: `${V1}/assets?useCaseKey=${UC}&limit=100`, headers: auth(admin) });
    expect(list.statusCode).toBe(200);
    const rows: { id: string; totalSupply: string; availableSupply: string }[] = list.json().data;
    const rowA = rows.find((r) => r.id === assetA)!;
    const rowB = rows.find((r) => r.id === assetB)!;
    expect(rowA.totalSupply).toBe("8000");
    expect(rowB.totalSupply).toBe("1500");
    // Freshly issued, nothing sold yet: the WHOLE minted supply still sits with
    // the treasury — each asset's own, not the other's.
    expect(rowA.availableSupply).toBe("8000");
    expect(rowB.availableSupply).toBe("1500");
  });

  it("GET /assets/:id/accounts doesn't leak a holder's balance from one asset onto a sibling sharing the same contract", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // invoice-tokenization is IN-jurisdiction-gated — HOLDER needs a linked,
    // KYC'd user before it can receive a transfer at all (same setup cashflows.test.ts uses).
    await onboardUser(app, admin, platform, { email: "supply-isolation.holder@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { legalName: "Isolation Test Holder", country: "IN" } });

    const assetA = await issue(app, admin, "INV-HOLD-A", 500000, "10000");
    const assetB = await issue(app, admin, "INV-HOLD-B", 200000, "3000");

    // Move ALL of asset A's supply to HOLDER — none of it is asset B's.
    const treasury = await treasuryAddressOf(app, platform, UC);
    await app.inject({ method: "POST", url: `${V1}/assets/${assetA}/actions/allow`, headers: auth(admin), payload: { account: HOLDER } });
    const xfer = await app.inject({
      method: "POST", url: `${V1}/assets/${assetA}/actions/transfer`, headers: auth(admin),
      payload: { from: treasury, to: HOLDER, amount: "10000" },
    });
    expect(xfer.statusCode).toBe(200);

    type Row = { address: string; balance: string };
    const accountsA: Row[] = (await app.inject({ method: "GET", url: `${V1}/assets/${assetA}/accounts`, headers: auth(admin) })).json();
    const accountsB: Row[] = (await app.inject({ method: "GET", url: `${V1}/assets/${assetB}/accounts`, headers: auth(admin) })).json();

    expect(accountsA.find((r) => r.address.toLowerCase() === HOLDER.toLowerCase())?.balance).toBe("10000");
    // HOLDER never touched asset B — must not show up with a phantom balance
    // (or at all, since a "0" balance means the row is filtered out entirely).
    const holderOnB = accountsB.find((r) => r.address.toLowerCase() === HOLDER.toLowerCase());
    expect(holderOnB?.balance ?? "0").toBe("0");
  });

  it("GET /assets/:id/accounts reflects an escrowed listing literally, without leaking it onto a sibling asset", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await onboardUser(app, admin, platform, { email: "escrow-isolation.holder@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { legalName: "Escrow Isolation Holder", country: "IN" } });

    const sale = { unitPrice: "10", currency: "CBDC-INR" };
    const assetA = await issue(app, admin, "INV-ESCROW-A", 500000, "10000", sale);
    const assetB = await issue(app, admin, "INV-ESCROW-B", 200000, "3000", sale);

    const treasury = await treasuryAddressOf(app, platform, UC);
    await app.inject({ method: "POST", url: `${V1}/assets/${assetA}/actions/allow`, headers: auth(admin), payload: { account: HOLDER } });
    await app.inject({
      method: "POST", url: `${V1}/assets/${assetA}/actions/transfer`, headers: auth(admin),
      payload: { from: treasury, to: HOLDER, amount: "10000" },
    });

    const holderToken = await loginAs(app, "escrow-isolation.holder@x.dev", "secret1");
    const listRes = await app.inject({
      method: "POST", url: `${V1}/assets/${assetA}/listings`, headers: auth(holderToken),
      payload: { quantity: "4000", unitPrice: "12", currency: "CBDC-INR" },
    });
    expect(listRes.statusCode).toBe(201);

    type Row = { address: string; balance: string };
    const accountsA: Row[] = (await app.inject({ method: "GET", url: `${V1}/assets/${assetA}/accounts`, headers: auth(admin) })).json();
    const accountsB: Row[] = (await app.inject({ method: "GET", url: `${V1}/assets/${assetB}/accounts`, headers: auth(admin) })).json();

    // The listing is a real ledger transfer to escrow — asset A's own table
    // shows it literally: HOLDER's balance dropped by the listed amount, the
    // same way market.test.ts's single-asset escrow assertions expect.
    expect(accountsA.find((r) => r.address.toLowerCase() === HOLDER.toLowerCase())?.balance).toBe("6000");
    // HOLDER never touched asset B — must not show up with a phantom balance.
    expect(accountsB.find((r) => r.address.toLowerCase() === HOLDER.toLowerCase())?.balance ?? "0").toBe("0");
  });

  it("POST /assets/:id/buy: a sibling asset's unsold treasury can't mask this asset's own exhausted supply", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await onboardUser(app, admin, platform, { email: "buy-isolation.buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { legalName: "Buy Isolation Buyer", country: "IN" } });

    const sale = { unitPrice: "1", currency: "CBDC-INR" };
    // Asset A: large, mostly-unsold supply sitting in the SAME treasury address.
    const assetA = await issue(app, admin, "INV-BUY-A", 500000, "100000", sale);
    // Asset B: tiny supply — this is the one we'll fully exhaust.
    const assetB = await issue(app, admin, "INV-BUY-B", 200000, "10", sale);

    await app.inject({ method: "POST", url: `${V1}/assets/${assetB}/actions/allow`, headers: auth(admin), payload: { account: HOLDER } });
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: HOLDER, currency: "CBDC-INR", amount: "1000" } });
    const buyerToken = await loginAs(app, "buy-isolation.buyer@x.dev", "secret1");

    // Buy asset B's ENTIRE supply — its own treasury is now exhausted.
    const buyAll = await app.inject({ method: "POST", url: `${V1}/assets/${assetB}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(buyAll.statusCode).toBe(200);

    // One more unit of asset B must be refused — asset A's own 100000 unsold
    // units (same treasury address) must not be able to fill it.
    const buyOneMore = await app.inject({ method: "POST", url: `${V1}/assets/${assetB}/buy`, headers: auth(buyerToken), payload: { quantity: "1" } });
    expect(buyOneMore.statusCode).toBe(400);
    expect(buyOneMore.json().error).toBe("INSUFFICIENT_TREASURY");

    // Asset A itself was never touched by any of this.
    const list = await app.inject({ method: "GET", url: `${V1}/assets?useCaseKey=${UC}&limit=100`, headers: auth(admin) });
    const rowA = (list.json().data as { id: string; availableSupply: string }[]).find((r) => r.id === assetA);
    expect(rowA?.availableSupply).toBe("100000");
  });

  it("POST /assets/:id/listings: holding a sibling asset can't satisfy this asset's own balance check", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await onboardUser(app, admin, platform, { email: "list-isolation.holder@x.dev", password: "secret1", role: "Buyer", walletAddress: HOLDER, kyc: { legalName: "List Isolation Holder", country: "IN" } });

    const assetA = await issue(app, admin, "INV-LISTCHECK-A", 500000, "10000");
    const assetB = await issue(app, admin, "INV-LISTCHECK-B", 200000, "10000");

    // HOLDER receives units of asset A ONLY — never touches asset B.
    const treasury = await treasuryAddressOf(app, platform, UC);
    await app.inject({ method: "POST", url: `${V1}/assets/${assetA}/actions/allow`, headers: auth(admin), payload: { account: HOLDER } });
    await app.inject({
      method: "POST", url: `${V1}/assets/${assetA}/actions/transfer`, headers: auth(admin),
      payload: { from: treasury, to: HOLDER, amount: "5000" },
    });

    const holderToken = await loginAs(app, "list-isolation.holder@x.dev", "secret1");
    // Listing asset A's own tokens still works.
    const listA = await app.inject({
      method: "POST", url: `${V1}/assets/${assetA}/listings`, headers: auth(holderToken),
      payload: { quantity: "1000", unitPrice: "10", currency: "CBDC-INR" },
    });
    expect(listA.statusCode).toBe(201);

    // Listing asset B — which HOLDER never holds a single unit of — must be
    // refused, not silently filled from asset A's balance on the shared contract.
    const listB = await app.inject({
      method: "POST", url: `${V1}/assets/${assetB}/listings`, headers: auth(holderToken),
      payload: { quantity: "1000", unitPrice: "10", currency: "CBDC-INR" },
    });
    expect(listB.statusCode).toBe(400);
    expect(listB.json().error).toBe("INSUFFICIENT_BALANCE");
  });
});
