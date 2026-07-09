import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

// Issue a carbon asset (activity → chained audit entries) and return handles.
async function seeded(): Promise<{ app: FastifyInstance; admin: string; assetId: string }> {
  const app = await buildTestApp();
  const admin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
  const issuer = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");
  const res = await app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(issuer),
    payload: { useCaseKey: "carbon-credit", name: "VCU-1", chainId: "fabric", initialSupply: "100", treasuryAccount: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", metadata: { projectName: "P", registry: "Verra", vintage: 2024 } },
  });
  expect(res.statusCode).toBe(201);
  return { app, admin, assetId: res.json().asset.id };
}

describe("audit verify + anchor", () => {
  it("verifies a clean chain and rolls up a summary", async () => {
    const { app, admin, assetId } = await seeded();
    const v = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/audit/verify`, headers: auth(admin) });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ valid: true, anchorConsistent: true });
    expect(v.json().count).toBeGreaterThan(0);
    const s = await app.inject({ method: "GET", url: `${V1}/audit/verify`, headers: auth(admin) });
    expect(s.json().tampered).toEqual([]);
    expect(s.json().verified).toBeGreaterThan(0);
  });

  it("anchors chain heads on-ledger and reports the anchor", async () => {
    const { app, admin, assetId } = await seeded();
    const a = await app.inject({ method: "POST", url: `${V1}/audit/anchor`, headers: auth(admin), payload: {} });
    expect(a.statusCode).toBe(200);
    expect(a.json().anchored.length).toBeGreaterThan(0);
    const v = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/audit/verify`, headers: auth(admin) });
    expect(v.json().lastAnchor.txHash).toMatch(/^0x/);
    expect(v.json().anchorConsistent).toBe(true);
  });

  it("tenancy: a foreign use-case user cannot verify (404)", async () => {
    const { app, assetId } = await seeded();
    const gold = await loginAs(app, "gold.admin@tokenlayer.dev", "gold123");
    expect((await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/audit/verify`, headers: auth(gold) })).statusCode).toBe(404);
  });
});
