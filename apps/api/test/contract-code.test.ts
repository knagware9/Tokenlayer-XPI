import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

// buildTestApp runs CHAIN_STRICT=0 with no EVM env: fabric/canton are simulated
// and present; besu/mst are known catalog chains but ABSENT (configured:false).

describe("use-case contract code endpoints", () => {
  it("returns the simulated Fabric contract model for an ERC-20 use case on fabric, with the deployed contract merged in", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit/code?chainId=fabric`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ chainId: "fabric", family: "fabric", mode: "simulated", language: "typescript", filename: "simulated-fabric-contract.ts" });
    expect(body.source).toContain("Simulated Fabric contract model");
    expect(body.source).toContain("setAllowed");
    // Seeded use cases deploy on fabric at boot, so the deployed contract is present.
    expect(body.deployed?.contractRef).toBeTruthy();
  });

  it("preview-code renders the real Solidity for an absent-but-known EVM chain (besu)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({
      method: "POST", url: `${V1}/use-cases/preview-code`, headers: auth(admin),
      payload: { tokenStandard: "ERC-20", symbol: "INV", name: "Invoice Financing", chainId: "besu" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ chainId: "besu", family: "evm", mode: "real", language: "solidity", filename: "ComplianceToken.sol" });
    expect(body.source).toContain("contract ComplianceToken");
    // constructorArgs mirror EvmLedgerAdapter.deployAsset: (name, symbol, allowlistEnabled).
    expect(body.constructorArgs).toEqual([
      { name: "name", value: "Invoice Financing" },
      { name: "symbol", value: "INV" },
      { name: "allowlistEnabled", value: "true" },
    ]);
  });

  it("preview-code maps ERC-721 and ERC-3643 to their Solidity sources (3643 = T-REX suite args: name, symbol)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const nft = await app.inject({
      method: "POST", url: `${V1}/use-cases/preview-code`, headers: auth(admin),
      payload: { tokenStandard: "ERC-721", symbol: "CERT", name: "Certificates", allowlist: false, chainId: "besu" },
    });
    expect(nft.statusCode).toBe(200);
    expect(nft.json().source).toContain("contract ComplianceNFT");
    expect(nft.json().constructorArgs).toContainEqual({ name: "allowlistEnabled", value: "false" });

    const trex = await app.inject({
      method: "POST", url: `${V1}/use-cases/preview-code`, headers: auth(admin),
      payload: { tokenStandard: "ERC-3643", symbol: "PRM", name: "Permissioned", chainId: "besu" },
    });
    expect(trex.statusCode).toBe(200);
    expect(trex.json().source).toContain("contract ComplianceToken3643");
    expect(trex.json().constructorArgs).toEqual([
      { name: "name", value: "Permissioned" },
      { name: "symbol", value: "PRM" },
    ]);
  });

  it("preview-code renders the DAML model for canton", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({
      method: "POST", url: `${V1}/use-cases/preview-code`, headers: auth(admin),
      payload: { tokenStandard: "ERC-20", symbol: "INV", name: "Invoice", chainId: "canton" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ family: "canton", mode: "simulated", language: "daml", filename: "TokenModel.daml" });
    expect(res.json().source).toContain("template Holding");
  });

  it("404s for an unknown use case", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}/use-cases/nope/code?chainId=fabric`, headers: auth(admin) });
    expect(res.statusCode).toBe(404);
  });

  it("400s CHAIN_NOT_ALLOWED for a chain outside the use case's allowedChainIds", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit/code?chainId=polygon`, headers: auth(admin) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CHAIN_NOT_ALLOWED");
  });

  it("400s a bad token standard and an unknown preview chain; 401s without a token", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const bad = await app.inject({
      method: "POST", url: `${V1}/use-cases/preview-code`, headers: auth(admin),
      payload: { tokenStandard: "ERC-1155", symbol: "X", name: "X", chainId: "fabric" },
    });
    expect(bad.statusCode).toBe(400);
    const badChain = await app.inject({
      method: "POST", url: `${V1}/use-cases/preview-code`, headers: auth(admin),
      payload: { tokenStandard: "ERC-20", symbol: "X", name: "X", chainId: "polygon" },
    });
    expect(badChain.statusCode).toBe(400);
    expect(badChain.json().error).toBe("CHAIN_NOT_ALLOWED");
    const anon = await app.inject({
      method: "POST", url: `${V1}/use-cases/preview-code`,
      payload: { tokenStandard: "ERC-20", symbol: "X", name: "X", chainId: "fabric" },
    });
    expect(anon.statusCode).toBe(401);
  });

  it("hides another tenant's use case (scoped 404) but serves the caller's own", async () => {
    const app = await buildTestApp();
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const foreign = await app.inject({ method: "GET", url: `${V1}/use-cases/gold-loan/code?chainId=fabric`, headers: auth(carbonAdmin) });
    expect(foreign.statusCode).toBe(404);
    const own = await app.inject({ method: "GET", url: `${V1}/use-cases/carbon-credit/code?chainId=fabric`, headers: auth(carbonAdmin) });
    expect(own.statusCode).toBe(200);
  });
});
