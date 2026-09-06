import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { approveAssetForTest, buildTestApp, V1, loginAs, auth, onboardUser, treasuryAddressOf } from "./helpers.js";

// A platform fee account distinct from any seeded buyer/treasury address.
const FEE_ACCOUNT = "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097";
// The seeded "Treasury" wallet — linked to carbon.issuer's own wallet (used only
// by the issuance-fee test below, which pays FROM the calling issuer's linked
// wallet, not from the asset's own treasury). Kept as its own constant since the
// two concepts are unrelated: this is the ISSUER's wallet, not the use case's
// registered treasury (which is now server-derived — see treasuryAddressOf).
const ISSUER_WALLET = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const BUYER_WALLET = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";


/** A use-case body with the richer metadata + compliance + fee config. */
function richBody(overrides: Record<string, unknown> = {}) {
  return {
    key: "rich-bond",
    name: "Rich Bond",
    symbol: "RB",
    tokenStandard: "ERC-20",
    allowedChainIds: ["fabric"],
    defaultChainId: "fabric",
    metadataSchema: {
      type: "object",
      properties: {
        isin: { type: "string", pattern: "^[A-Z0-9]{12}$" },
        rating: { type: "string", enum: ["AAA", "AA", "A"] },
        coupon: { type: "number", min: 0, max: 100 },
        prospectus: { type: "document" },
      },
      required: [],
    },
    lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
    compliance: { allowlist: true, transferRestrictions: true, maxHolders: 5, lockupDays: 30, allowedJurisdictions: ["IN", "US"] },
    fees: { marketplaceBps: 250, issuanceFlat: "100" },
    saleTermsDefault: { unitPrice: "5", currency: "CBDC-INR" },
    roles: ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"],
    ...overrides,
  };
}

async function cashBalance(app: FastifyInstance, token: string, address: string): Promise<string> {
  const res = await app.inject({ method: "GET", url: `${V1}/cash/balances?address=${address}`, headers: auth(token) });
  const rows = res.json() as { currency: string; amount: string }[];
  return rows.find((r) => r.currency === "CBDC-INR")?.amount ?? "0";
}

describe("richer low-code config: compliance rules + fees", () => {
  it("round-trips compliance rules + fees + saleTermsDefault (create → get) and deploys on a sim chain", async () => {
    const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const created = await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(admin), payload: richBody() });
    expect(created.statusCode).toBe(201);
    // A contract deployed on the (available) fabric chain.
    expect(created.json().contracts?.fabric?.contractRef).toBeTruthy();

    const got = (await app.inject({ method: "GET", url: `${V1}/use-cases/rich-bond`, headers: auth(admin) })).json();
    expect(got.compliance).toMatchObject({ maxHolders: 5, lockupDays: 30, allowedJurisdictions: ["IN", "US"] });
    expect(got.fees).toMatchObject({ marketplaceBps: 250, issuanceFlat: "100" });
    expect(got.saleTermsDefault).toMatchObject({ unitPrice: "5", currency: "CBDC-INR" });
    // Richer metadata field constraints survive the round-trip.
    expect(got.metadataSchema.properties.rating.enum).toEqual(["AAA", "AA", "A"]);
    expect(got.metadataSchema.properties.prospectus.type).toBe("document");
  });

  it("marketplace fee: buy splits payment into fee account + treasury remainder", async () => {
    const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    // Add a 2.5% marketplace fee to the seeded carbon-credit use case (preserve config).
    const carbon = (await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform) })).json();
    await app.inject({ method: "PUT", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform), payload: { ...carbon, fees: { marketplaceBps: 250 } } });

    // Issue a priced asset (unitPrice 5, CBDC-INR) and mint 100 into the use
    // case's own (server-derived, never client-supplied — org-treasury-accounts
    // Task 5) treasury.
    const asset = (await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(platform),
      payload: {
        useCaseKey: "carbon-credit", name: "Fee Asset", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 },
        sale: { unitPrice: "5", currency: "CBDC-INR" },
        initialSupply: "100",
      },
    })).json().asset;
    await approveAssetForTest(app, asset.id, "carbon-credit");
    const treasury = await treasuryAddressOf(app, platform, "carbon-credit");

    // Onboard + KYC-approve a Buyer (via the scoped UseCaseAdmin, checked by the
    // platform admin) with a linked wallet. Full KYC → approved with country IN.
    await onboardUser(app, carbonAdmin, platform, { email: "feebuyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET, kyc: { legalName: "Fee Buyer", country: "IN" } });
    await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/actions/allow`, headers: auth(platform), payload: { account: BUYER_WALLET } });

    // Fund + buy 10 → cost = 50, fee = floor(50 * 250 / 10000) = 1, treasury gets 49.
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: BUYER_WALLET, currency: "CBDC-INR", amount: "1000" } });
    const buyerToken = await loginAs(app, "feebuyer@x.dev", "secret1");
    const buyRes = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(buyRes.statusCode).toBe(200);
    expect(buyRes.json().fee).toMatchObject({ amount: "1", account: FEE_ACCOUNT });

    expect(await cashBalance(app, platform, FEE_ACCOUNT)).toBe("1");
    expect(await cashBalance(app, platform, treasury)).toBe("49");
    expect(await cashBalance(app, platform, BUYER_WALLET)).toBe("950"); // 1000 - 50 total
  });

  it("allowedJurisdictions blocks a buyer whose KYC country is not permitted (JURISDICTION_NOT_ALLOWED)", async () => {
    const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    // Issue + mint the treasury supply FIRST (no jurisdiction gate yet), then add
    // the rule — so the treasury mint is not itself blocked and we isolate the buy.
    const asset = (await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(platform),
      payload: {
        useCaseKey: "carbon-credit", name: "Juris Asset", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 },
        sale: { unitPrice: "5", currency: "CBDC-INR" },
        initialSupply: "100",
      },
    })).json().asset;
    await approveAssetForTest(app, asset.id, "carbon-credit");
    const treasury = await treasuryAddressOf(app, platform, "carbon-credit");

    // Now restrict to IN/US only.
    const carbon = (await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform) })).json();
    await app.inject({ method: "PUT", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform), payload: { ...carbon, compliance: { ...carbon.compliance, allowedJurisdictions: ["IN", "US"] } } });

    // Buyer with a non-permitted KYC country (GB), KYC-approved (so only the
    // jurisdiction rule — not KYC — blocks the buy), allowlisted + funded.
    await onboardUser(app, carbonAdmin, platform, { email: "gbbuyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET, kyc: { legalName: "GB Buyer", country: "GB" } });
    await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/actions/allow`, headers: auth(platform), payload: { account: BUYER_WALLET } });
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: BUYER_WALLET, currency: "CBDC-INR", amount: "1000" } });

    const buyerToken = await loginAs(app, "gbbuyer@x.dev", "secret1");
    const buyRes = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(buyRes.statusCode).toBe(400);
    expect(buyRes.json().error).toBe("JURISDICTION_NOT_ALLOWED");

    // Fail-closed: the buyer's cash was refunded (no net movement to treasury/fee).
    expect(await cashBalance(app, platform, BUYER_WALLET)).toBe("1000");
    expect(await cashBalance(app, platform, treasury)).toBe("0");
  });

  it("issuance fee: charges issuanceFlat from the issuer's cash to the fee account before minting", async () => {
    const app = await buildTestApp({ platformFeeAccount: FEE_ACCOUNT });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    // Add an issuance fee to the seeded carbon-credit use case (whose issuer is
    // linked to the Treasury wallet), preserving its existing config via PUT.
    const carbon = (await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform) })).json();
    const putRes = await app.inject({
      method: "PUT", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform),
      payload: { ...carbon, fees: { issuanceFlat: "100" } },
    });
    expect(putRes.statusCode).toBe(200);

    // The issuance fee is paid from the CALLING ISSUER'S OWN linked wallet (the
    // seeded carbon.issuer is linked to "Treasury" = ISSUER_WALLET) — a
    // different account from the asset's own registered treasury, and unaffected
    // by this task's treasury derivation.
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: ISSUER_WALLET, currency: "CBDC-INR", amount: "500" } });
    const issuer = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");

    const res = await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(issuer),
      payload: { useCaseKey: "carbon-credit", name: "Iss Asset", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 }, sale: { unitPrice: "5", currency: "CBDC-INR" } },
    });
    expect(res.statusCode).toBe(202);
    // The gated-issuance response body no longer echoes `issuanceFee` (Task 8's
    // gated branch returns only `{ asset }` — there is no proposal payload to
    // carry it in any more, and this is the only branch issueAssetCore ever
    // reaches now). The charge itself is unaffected — prove it via balances,
    // the same way this test already does two lines below.
    expect(res.json().issuanceFee).toBeUndefined();
    // Issuer paid 100 → 400 left; fee account received 100.
    expect(await cashBalance(app, platform, ISSUER_WALLET)).toBe("400");
    expect(await cashBalance(app, platform, FEE_ACCOUNT)).toBe("100");
  });
});
