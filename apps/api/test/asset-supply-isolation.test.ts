import { describe, it, expect } from "vitest";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

const UC = "invoice-tokenization";

const inv = (n: string, amount: number) => ({
  invoiceNumber: n, invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited",
  currency: "INR", amount, dueDate: "2026-10-01",
});

async function issue(
  app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, n: string, amount: number, supply: string,
  sale?: { unitPrice: string; currency: string },
): Promise<string> {
  const res = await app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(admin),
    payload: { useCaseKey: UC, name: n, chainId: "fabric", initialSupply: supply, metadata: inv(n, amount), ...(sale ? { sale } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json().asset.id as string;
}

/**
 * Two assets issued under the SAME use case on the SAME simulated chain
 * (fabric) share that use case's single deployed contract — a real EVM chain
 * does too (see ComplianceToken.sol: a flat totalSupply/balanceOf, no asset
 * dimension). GET /assets and GET /assets/:id must still answer for each
 * asset's OWN supply, folded from its own audit stream — not a raw chain
 * read, which would pool every asset sharing that contract together.
 *
 * GET /assets/:id/accounts's `balance` is NOT covered here — it's still a
 * live (pooled) chain read, on purpose for now: see the comment on that route
 * in tokenization.ts for why the audit fold can't be dropped in as-is there
 * without breaking the escrow-lifecycle assertions in market.test.ts.
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
});
