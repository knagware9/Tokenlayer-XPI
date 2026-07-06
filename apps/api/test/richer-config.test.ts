import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

// A platform fee account distinct from any seeded buyer/treasury address.
const FEE_ACCOUNT = "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097";
const TREASURY_ADDR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
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

    // Issue a priced asset (unitPrice 5, CBDC-INR) and mint 100 to treasury.
    const asset = (await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(platform),
      payload: {
        useCaseKey: "carbon-credit", name: "Fee Asset", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 },
        sale: { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
        treasuryAccount: TREASURY_ADDR, initialSupply: "100",
      },
    })).json().asset;

    // Onboard + KYC-approve a Buyer (via the scoped UseCaseAdmin) with a linked wallet.
    const buyer = (await app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(carbonAdmin),
      payload: { email: "feebuyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET, kyc: { country: "IN" } },
    })).json();
    await app.inject({ method: "PATCH", url: `${V1}/users/${buyer.id}`, headers: auth(carbonAdmin), payload: { kycStatus: "approved" } });
    await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/actions/allow`, headers: auth(platform), payload: { account: BUYER_WALLET } });

    // Fund + buy 10 → cost = 50, fee = floor(50 * 250 / 10000) = 1, treasury gets 49.
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: BUYER_WALLET, currency: "CBDC-INR", amount: "1000" } });
    const buyerToken = await loginAs(app, "feebuyer@x.dev", "secret1");
    const buyRes = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(buyRes.statusCode).toBe(200);
    expect(buyRes.json().fee).toMatchObject({ amount: "1", account: FEE_ACCOUNT });

    expect(await cashBalance(app, platform, FEE_ACCOUNT)).toBe("1");
    expect(await cashBalance(app, platform, TREASURY_ADDR)).toBe("49");
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
        sale: { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
        treasuryAccount: TREASURY_ADDR, initialSupply: "100",
      },
    })).json().asset;

    // Now restrict to IN/US only.
    const carbon = (await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform) })).json();
    await app.inject({ method: "PUT", url: `${V1}/use-cases/carbon-credit`, headers: auth(platform), payload: { ...carbon, compliance: { ...carbon.compliance, allowedJurisdictions: ["IN", "US"] } } });

    // Buyer with a non-permitted KYC country (GB), allowlisted + funded.
    const buyer = (await app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(carbonAdmin),
      payload: { email: "gbbuyer@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET, kyc: { country: "GB" } },
    })).json();
    await app.inject({ method: "PATCH", url: `${V1}/users/${buyer.id}`, headers: auth(carbonAdmin), payload: { kycStatus: "approved" } });
    await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/actions/allow`, headers: auth(platform), payload: { account: BUYER_WALLET } });
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: BUYER_WALLET, currency: "CBDC-INR", amount: "1000" } });

    const buyerToken = await loginAs(app, "gbbuyer@x.dev", "secret1");
    const buyRes = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/buy`, headers: auth(buyerToken), payload: { quantity: "10" } });
    expect(buyRes.statusCode).toBe(400);
    expect(buyRes.json().error).toBe("JURISDICTION_NOT_ALLOWED");

    // Fail-closed: the buyer's cash was refunded (no net movement to treasury/fee).
    expect(await cashBalance(app, platform, BUYER_WALLET)).toBe("1000");
    expect(await cashBalance(app, platform, TREASURY_ADDR)).toBe("0");
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

    // The carbon issuer's linked wallet (Treasury) must hold funds to pay the fee.
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: TREASURY_ADDR, currency: "CBDC-INR", amount: "500" } });
    const issuer = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");

    const res = await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(issuer),
      payload: { useCaseKey: "carbon-credit", name: "Iss Asset", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 }, sale: { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().issuanceFee).toMatchObject({ amount: "100", currency: "CBDC-INR" });
    // Issuer paid 100 → 400 left; fee account received 100.
    expect(await cashBalance(app, platform, TREASURY_ADDR)).toBe("400");
    expect(await cashBalance(app, platform, FEE_ACCOUNT)).toBe("100");
  });
});
