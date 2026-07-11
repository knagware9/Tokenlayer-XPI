import { describe, expect, it } from "vitest";
import { buildChainRegistry } from "../src/chains.js";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

// A dev-only throwaway key (hardhat account #1) — never used on a live network here.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("GET /chains/:id/status", () => {
  it("reports a simulated chain (fabric) as reachable", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}/chains/fabric/status`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "fabric", reachable: true, mode: "simulated" });
  });

  it("404s for an unknown chain id and for an absent (unconfigured) EVM chain", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const unknown = await app.inject({ method: "GET", url: `${V1}/chains/nope/status`, headers: auth(admin) });
    expect(unknown.statusCode).toBe(404);
    // besu is in the catalog but has no adapter under CHAIN_STRICT=0 — nothing to probe.
    const absent = await app.inject({ method: "GET", url: `${V1}/chains/besu/status`, headers: auth(admin) });
    expect(absent.statusCode).toBe(404);
  });
});

describe("GET /chains enrichment", () => {
  it("rows carry configured/available (fabric configured, besu absent) and mst metadata", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}/chains`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const byId = new Map((res.json() as { id: string; [k: string]: unknown }[]).map((c) => [c.id, c]));
    expect(byId.get("fabric")).toMatchObject({ configured: true, available: true, mode: "simulated" });
    // Absent-but-known EVM chain: listed, selectable, but not connected.
    expect(byId.get("besu")).toMatchObject({ family: "evm", configured: false, available: false, mode: "real" });
    // Catalog metadata surfaces even while unconfigured (Networks view needs it).
    expect(byId.get("mst")).toMatchObject({
      configured: false,
      expectedChainId: 91562037,
      faucetUrl: "https://faucet.mstblockchain.com/",
      explorerUrl: "https://testnet.mstscan.com",
    });
    expect(byId.get("mst")).not.toHaveProperty("rpcHost");
  });
});

describe("registry.probe (unit)", () => {
  it("exposes rpcHost (hostname only, never the URL) for a configured EVM chain", () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0", MST_RPC_URL: "https://rpc.mst.example.com/v1/secret-api-key", MST_OPERATOR_KEY: KEY });
    const mst = reg.list().find((c) => c.id === "mst");
    expect(mst?.configured).toBe(true);
    expect(mst?.rpcHost).toBe("rpc.mst.example.com");
    // The full URL (path may embed an API key) must never appear anywhere in the row.
    expect(JSON.stringify(mst)).not.toContain("secret-api-key");
  });

  it("returns reachable:false with a sanitised error for a configured-but-down EVM chain", async () => {
    const reg = buildChainRegistry({ BESU_RPC_URL: "http://127.0.0.1:9", BESU_OPERATOR_KEY: KEY });
    const result = await reg.probe("besu");
    expect(result.reachable).toBe(false);
    expect(result.mode).toBe("real");
    expect(result.error).toBeTruthy();
    // Never leak the RPC endpoint in probe errors.
    expect(result.error).not.toMatch(/http:\/\/|127\.0\.0\.1/);
  });

  it("throws for an unknown chain id (route maps to 404)", async () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    await expect(reg.probe("nope")).rejects.toThrow(/not configured/);
  });
});
