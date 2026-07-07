import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

// Fresh Hardhat dev addresses NOT in the seeded roster (so their KYC/jurisdiction
// is whatever we assign here, not a seeded null-country holder).
const SELLER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // #0
const FIN_A = "0x71bE63f3384f5fb98995898A86B02Fb2426c5788"; // #11
const FIN_B = "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a"; // #12
const SUB_SELLER = "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec"; // #13
const FIN_C = "0x2546BcD3c84621e976D8185a91A922aE77ECEc30"; // #16
const SUB_SELLER_2 = "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E"; // #17

const SELLER_GSTIN = "27ABCDE1234F1Z5";
const ANCHOR_GSTIN = "27ZYXWV9876K1Z2";
const SUB_GSTIN = "29PQRST5678L1Z9";

const hash = (c: string): string => "0x" + c.repeat(64);

const UC = "invoice-tokenization";

/** Create + KYC-approve an India-jurisdiction Buyer with a linked wallet (as a scoped UseCaseAdmin). */
async function makeHolder(app: FastifyInstance, ucAdmin: string, email: string, wallet: string): Promise<void> {
  const u = (
    await app.inject({
      method: "POST",
      url: `${V1}/users`,
      headers: auth(ucAdmin),
      payload: { email, password: "secret1", role: "Buyer", walletAddress: wallet, kyc: { country: "IN" } },
    })
  ).json();
  await app.inject({ method: "PATCH", url: `${V1}/users/${u.id}`, headers: auth(ucAdmin), payload: { kycStatus: "approved" } });
}

/** Log in as PlatformAdmin, create + return a UseCaseAdmin token for invoice-tokenization. */
async function invoiceAdmin(app: FastifyInstance): Promise<string> {
  const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  await app.inject({
    method: "POST",
    url: `${V1}/users`,
    headers: auth(platform),
    payload: { email: "inv.admin@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: UC },
  });
  return loginAs(app, "inv.admin@x.dev", "secret1");
}

/** Issue an invoice asset and mint its token to `seller`. Returns the asset id. */
async function issueAndMint(
  app: FastifyInstance,
  ucAdmin: string,
  opts: { invoiceHash: string; invoiceNumber: string; amountInr: number; seller: string },
): Promise<string> {
  const asset = (
    await app.inject({
      method: "POST",
      url: `${V1}/assets`,
      headers: auth(ucAdmin),
      payload: {
        useCaseKey: UC,
        name: opts.invoiceNumber,
        chainId: "fabric",
        metadata: {
          invoiceHash: opts.invoiceHash,
          invoiceNumber: opts.invoiceNumber,
          sellerGstin: SELLER_GSTIN,
          buyerGstin: ANCHOR_GSTIN,
          amountInr: opts.amountInr,
          dueDate: "2026-12-31",
        },
      },
    })
  ).json().asset;
  await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/actions/allow`, headers: auth(ucAdmin), payload: { account: opts.seller } });
  const mint = await app.inject({ method: "POST", url: `${V1}/assets/${asset.id}/actions/mint`, headers: auth(ucAdmin), payload: { to: opts.seller, tokenId: opts.invoiceHash } });
  expect(mint.statusCode).toBe(200);
  return asset.id as string;
}

async function ownerOf(app: FastifyInstance, ucAdmin: string, assetId: string, tokenId: string): Promise<string | null> {
  const tokens = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/tokens`, headers: auth(ucAdmin) })).json() as { tokenId: string; owner: string }[];
  return tokens.find((t) => t.tokenId === tokenId)?.owner ?? null;
}

describe("invoice financing (record-only) + deep-tier", () => {
  it("finance moves the token to the financier, records correct discounted math, blocks double-finance, and repay burns", async () => {
    const app = await buildTestApp();
    const admin = await invoiceAdmin(app);
    await makeHolder(app, admin, "seller@x.dev", SELLER);
    await makeHolder(app, admin, "fina@x.dev", FIN_A);

    const invHash = hash("a");
    const assetId = await issueAndMint(app, admin, { invoiceHash: invHash, invoiceNumber: "INV-001", amountInr: 1_000_000, seller: SELLER });

    // Finance: rate 10% p.a. over a 365-day tenor → 10% discount → 900,000.
    const fin = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/finance`, headers: auth(admin), payload: { financier: FIN_A, ratePct: 10, tenorDays: 365 } });
    expect(fin.statusCode).toBe(201);
    const financing = fin.json().financing;
    expect(financing.status).toBe("financed");
    expect(financing.faceValueInr).toBe("1000000");
    expect(financing.discountedInr).toBe("900000");
    expect(financing.tokenId).toBe(invHash);

    // Token now owned by the financier.
    expect((await ownerOf(app, admin, assetId, invHash))?.toLowerCase()).toBe(FIN_A.toLowerCase());

    // GET financing surfaces the record.
    const got = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/financing`, headers: auth(admin) })).json();
    expect(got.financing.discountedInr).toBe("900000");

    // Double-finance → 409 ALREADY_FINANCED.
    const dbl = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/finance`, headers: auth(admin), payload: { financier: FIN_B, ratePct: 10, tenorDays: 365 } });
    expect(dbl.statusCode).toBe(409);
    expect(dbl.json().error).toBe("ALREADY_FINANCED");

    // Repay → token burned, status repaid.
    const repay = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/repay`, headers: auth(admin) });
    expect(repay.statusCode).toBe(200);
    expect(repay.json().financing.status).toBe("repaid");
    expect(await ownerOf(app, admin, assetId, invHash)).toBeNull();
  });

  it("repay before finance is rejected (NOT_FINANCED)", async () => {
    const app = await buildTestApp();
    const admin = await invoiceAdmin(app);
    await makeHolder(app, admin, "seller@x.dev", SELLER);
    const assetId = await issueAndMint(app, admin, { invoiceHash: hash("a"), invoiceNumber: "INV-001", amountInr: 1_000_000, seller: SELLER });
    const repay = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/repay`, headers: auth(admin) });
    expect(repay.statusCode).toBe(400);
    expect(repay.json().error).toBe("NOT_FINANCED");
  });

  it("deep-tier: child within cap is linked (tier+1, anchor inherited); over-cap rejected; non-financed parent rejected", async () => {
    const app = await buildTestApp();
    const admin = await invoiceAdmin(app);
    await makeHolder(app, admin, "seller@x.dev", SELLER);
    await makeHolder(app, admin, "fina@x.dev", FIN_A);
    await makeHolder(app, admin, "sub@x.dev", SUB_SELLER);

    const parentHash = hash("a");
    const parentId = await issueAndMint(app, admin, { invoiceHash: parentHash, invoiceNumber: "INV-100", amountInr: 1_000_000, seller: SELLER });

    // Deep-tier on a NOT-yet-financed parent → 400 PARENT_NOT_FINANCED.
    const early = await app.inject({
      method: "POST", url: `${V1}/assets/${parentId}/deep-tier`, headers: auth(admin),
      payload: { invoiceNumber: "INV-100-A", sellerGstin: SUB_GSTIN, amountInr: 700_000, dueDate: "2026-11-30", invoiceHash: hash("b"), mintTo: SUB_SELLER },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().error).toBe("PARENT_NOT_FINANCED");

    // Finance the parent, then extend deep-tier.
    await app.inject({ method: "POST", url: `${V1}/assets/${parentId}/finance`, headers: auth(admin), payload: { financier: FIN_A, ratePct: 10, tenorDays: 365 } });

    // Within cap (700,000 ≤ 80% of 1,000,000).
    const child = await app.inject({
      method: "POST", url: `${V1}/assets/${parentId}/deep-tier`, headers: auth(admin),
      payload: { invoiceNumber: "INV-100-A", sellerGstin: SUB_GSTIN, amountInr: 700_000, dueDate: "2026-11-30", invoiceHash: hash("b"), mintTo: SUB_SELLER },
    });
    expect(child.statusCode).toBe(201);
    const childAsset = child.json().asset;
    expect(childAsset.metadata.tier).toBe(2);
    expect(childAsset.metadata.parentInvoiceHash).toBe(parentHash);
    expect(childAsset.metadata.anchorBuyerGstin).toBe(ANCHOR_GSTIN); // inherited from parent's buyerGstin
    expect(childAsset.metadata.buyerGstin).toBe(SELLER_GSTIN); // tier-1 seller is the buyer for the sub-supplier
    // Child token minted to the sub-supplier.
    expect((await ownerOf(app, admin, childAsset.id, hash("b")))?.toLowerCase()).toBe(SUB_SELLER.toLowerCase());

    // Over-cap (900,000 > 80% of 1,000,000) → 400 DEEP_TIER_CAP_EXCEEDED.
    const over = await app.inject({
      method: "POST", url: `${V1}/assets/${parentId}/deep-tier`, headers: auth(admin),
      payload: { invoiceNumber: "INV-100-B", sellerGstin: SUB_GSTIN, amountInr: 900_000, dueDate: "2026-11-30", invoiceHash: hash("c"), mintTo: SUB_SELLER },
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toBe("DEEP_TIER_CAP_EXCEEDED");
  });

  it("builds a 3-level chain and tier-chain returns all nodes with correct tiers", async () => {
    const app = await buildTestApp();
    const admin = await invoiceAdmin(app);
    await makeHolder(app, admin, "seller@x.dev", SELLER);
    await makeHolder(app, admin, "fina@x.dev", FIN_A);
    await makeHolder(app, admin, "sub@x.dev", SUB_SELLER);
    await makeHolder(app, admin, "finc@x.dev", FIN_C);
    await makeHolder(app, admin, "sub2@x.dev", SUB_SELLER_2);

    // Tier 1: parent, financed.
    const parentId = await issueAndMint(app, admin, { invoiceHash: hash("a"), invoiceNumber: "INV-1", amountInr: 1_000_000, seller: SELLER });
    await app.inject({ method: "POST", url: `${V1}/assets/${parentId}/finance`, headers: auth(admin), payload: { financier: FIN_A, ratePct: 10, tenorDays: 365 } });

    // Tier 2: deep-tier child (700,000), minted to SUB_SELLER, then financed to FIN_C.
    const child2 = (
      await app.inject({
        method: "POST", url: `${V1}/assets/${parentId}/deep-tier`, headers: auth(admin),
        payload: { invoiceNumber: "INV-2", sellerGstin: SUB_GSTIN, amountInr: 700_000, dueDate: "2026-11-30", invoiceHash: hash("b"), mintTo: SUB_SELLER },
      })
    ).json().asset;
    expect(child2.metadata.tier).toBe(2);
    await app.inject({ method: "POST", url: `${V1}/assets/${child2.id}/finance`, headers: auth(admin), payload: { financier: FIN_C, ratePct: 10, tenorDays: 365 } });

    // Tier 3: deep-tier off the tier-2 child (500,000 ≤ 80% of 700,000).
    const child3 = (
      await app.inject({
        method: "POST", url: `${V1}/assets/${child2.id}/deep-tier`, headers: auth(admin),
        payload: { invoiceNumber: "INV-3", sellerGstin: SUB_GSTIN, amountInr: 500_000, dueDate: "2026-10-31", invoiceHash: hash("d"), mintTo: SUB_SELLER_2 },
      })
    ).json().asset;
    expect(child3.metadata.tier).toBe(3);

    // tier-chain from any node returns all 3, sorted by tier.
    const chain = (await app.inject({ method: "GET", url: `${V1}/assets/${child3.id}/tier-chain`, headers: auth(admin) })).json() as { tier: number; parentInvoiceHash: string | null; financing: { status: string } | null }[];
    expect(chain.map((n) => n.tier)).toEqual([1, 2, 3]);
    expect(chain[0].parentInvoiceHash).toBeNull();
    expect(chain[1].parentInvoiceHash).toBe(hash("a"));
    expect(chain[2].parentInvoiceHash).toBe(hash("b"));
    expect(chain[0].financing?.status).toBe("financed");
  });

  it("tenancy: a user from another use case cannot read financing or tier-chain (404)", async () => {
    const app = await buildTestApp();
    const admin = await invoiceAdmin(app);
    await makeHolder(app, admin, "seller@x.dev", SELLER);
    await makeHolder(app, admin, "fina@x.dev", FIN_A);
    const assetId = await issueAndMint(app, admin, { invoiceHash: hash("a"), invoiceNumber: "INV-1", amountInr: 1_000_000, seller: SELLER });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/finance`, headers: auth(admin), payload: { financier: FIN_A, ratePct: 10, tenorDays: 365 } });

    // A seeded carbon-credit buyer (different use case) is blocked.
    const outsider = await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const fin = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/financing`, headers: auth(outsider) });
    expect(fin.statusCode).toBe(404);
    const chain = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/tier-chain`, headers: auth(outsider) });
    expect(chain.statusCode).toBe(404);
  });
});
