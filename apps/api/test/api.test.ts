import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ACCOUNTS, auth, buildTestApp, login } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});

async function issueGenericAsset(token: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/assets",
    headers: auth(token),
    payload: {
      useCaseKey: "generic-asset",
      name: "Demo Asset",
      symbol: "DEMO",
      chainId: "mock",
      metadata: { issuer: "ACME", assetClass: "commodity" },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().asset.id as string;
}

describe("auth", () => {
  it("rejects bad credentials", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "admin@tokenlayer.dev", password: "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("requires a token for protected routes", async () => {
    const res = await app.inject({ method: "GET", url: "/use-cases" });
    expect(res.statusCode).toBe(401);
  });
});

describe("catalog", () => {
  it("lists configured use cases and multi-DLT chains", async () => {
    const token = await login(app, "Viewer");
    const useCases = await app.inject({ method: "GET", url: "/use-cases", headers: auth(token) });
    expect(useCases.json().map((u: { key: string }) => u.key).sort()).toEqual([
      "generic-asset",
      "generic-certificate",
      "security-token",
    ]);
    const chains = await app.inject({ method: "GET", url: "/chains", headers: auth(token) });
    const ids = chains.json().map((c: { id: string }) => c.id);
    expect(ids).toContain("mock");
    expect(ids).toContain("fabric");
    expect(ids).toContain("canton");
  });
});

describe("issuance + RBAC", () => {
  it("lets an Issuer issue an asset", async () => {
    const token = await login(app, "Issuer");
    const id = await issueGenericAsset(token);
    expect(id).toBeTruthy();
  });

  it("forbids a Viewer from issuing", async () => {
    const token = await login(app, "Viewer");
    const res = await app.inject({
      method: "POST",
      url: "/assets",
      headers: auth(token),
      payload: { useCaseKey: "generic-asset", name: "X", symbol: "X", chainId: "mock", metadata: { issuer: "A", assetClass: "c" } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("rejects issuance with invalid metadata", async () => {
    const token = await login(app, "Issuer");
    const res = await app.inject({
      method: "POST",
      url: "/assets",
      headers: auth(token),
      payload: { useCaseKey: "generic-asset", name: "X", symbol: "X", chainId: "mock", metadata: { issuer: "A" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_METADATA");
  });
});

describe("lifecycle + compliance + audit", () => {
  it("runs allow → mint → transfer → freeze-block → audit", async () => {
    const admin = await login(app, "Admin");
    const id = await issueGenericAsset(admin);
    const act = (action: string, body: Record<string, string>) =>
      app.inject({ method: "POST", url: `/assets/${id}/actions/${action}`, headers: auth(admin), payload: body });

    // allowlist is enabled for generic-asset → mint to a non-listed account fails
    const blockedMint = await act("mint", { to: ACCOUNTS.ALICE, amount: "1000" });
    expect(blockedMint.statusCode).toBe(400);
    expect(blockedMint.json().error).toBe("NOT_ALLOWLISTED");

    await act("allow", { account: ACCOUNTS.ALICE });
    await act("allow", { account: ACCOUNTS.BOB });
    expect((await act("mint", { to: ACCOUNTS.ALICE, amount: "1000" })).statusCode).toBe(200);
    expect((await act("transfer", { from: ACCOUNTS.ALICE, to: ACCOUNTS.BOB, amount: "400" })).statusCode).toBe(200);

    await act("freeze", { account: ACCOUNTS.ALICE });
    const frozen = await act("transfer", { from: ACCOUNTS.ALICE, to: ACCOUNTS.BOB, amount: "10" });
    expect(frozen.statusCode).toBe(400);
    expect(frozen.json().error).toBe("ACCOUNT_FROZEN");

    const accounts = await app.inject({ method: "GET", url: `/assets/${id}/accounts`, headers: auth(admin) });
    const alice = accounts.json().find((a: { address: string }) => a.address === ACCOUNTS.ALICE);
    expect(alice.balance).toBe("600");
    expect(alice.frozen).toBe(true);

    const audit = await app.inject({ method: "GET", url: `/assets/${id}/audit`, headers: auth(admin) });
    const actions = audit.json().map((e: { action: string }) => e.action);
    expect(actions).toContain("mint");
    expect(actions).toContain("freeze");
  });

  it("issues and mints an ERC-721 certificate by token id, then blocks transfer", async () => {
    const admin = await login(app, "Admin");
    const issue = await app.inject({
      method: "POST",
      url: "/assets",
      headers: auth(admin),
      payload: {
        useCaseKey: "generic-certificate",
        name: "Cert",
        symbol: "CERT",
        chainId: "fabric",
        metadata: { category: "registration", authority: "Gov" },
      },
    });
    expect(issue.statusCode).toBe(201);
    expect(issue.json().asset.tokenStandard).toBe("ERC-721");
    const id = issue.json().asset.id as string;

    const mint = await app.inject({ method: "POST", url: `/assets/${id}/actions/mint`, headers: auth(admin), payload: { to: ACCOUNTS.ALICE, tokenId: "1", uri: "ipfs://x" } });
    expect(mint.statusCode).toBe(200);

    const tokens = await app.inject({ method: "GET", url: `/assets/${id}/tokens`, headers: auth(admin) });
    expect(tokens.json()).toEqual([{ tokenId: "1", owner: ACCOUNTS.ALICE, ownerLabel: "Alice", frozen: false }]);

    const transfer = await app.inject({ method: "POST", url: `/assets/${id}/actions/transfer`, headers: auth(admin), payload: { from: ACCOUNTS.ALICE, to: ACCOUNTS.BOB, tokenId: "1" } });
    expect(transfer.statusCode).toBe(400);
    expect(transfer.json().error).toBe("ACTION_DISABLED");
  });

  it("rejects issuance to a chain the use case does not allow", async () => {
    const admin = await login(app, "Admin");
    const create = await app.inject({
      method: "POST",
      url: "/use-cases",
      headers: auth(admin),
      payload: {
        key: "mock-only-asset",
        name: "Mock Only",
        tokenStandard: "ERC-20",
        allowedChainIds: ["mock"],
        defaultChainId: "mock",
        metadataSchema: { type: "object", properties: {} },
        lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
        compliance: { allowlist: false, transferRestrictions: false },
        roles: ["Admin", "Issuer"],
      },
    });
    expect(create.statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      url: "/assets",
      headers: auth(admin),
      payload: { useCaseKey: "mock-only-asset", name: "X", symbol: "X", chainId: "canton", metadata: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CHAIN_NOT_ALLOWED");
  });
});

describe("low-code use-case builder", () => {
  it("lets an Admin create a use case and forbids non-Admins", async () => {
    const viewer = await login(app, "Viewer");
    const forbidden = await app.inject({
      method: "POST",
      url: "/use-cases",
      headers: auth(viewer),
      payload: { key: "x", name: "X", tokenStandard: "ERC-20", allowedChainIds: ["mock"], defaultChainId: "mock", metadataSchema: { type: "object", properties: {} }, lifecycle: { mint: true, transfer: true, burn: true, freeze: true }, compliance: { allowlist: false, transferRestrictions: false }, roles: ["Admin"] },
    });
    expect(forbidden.statusCode).toBe(403);

    const admin = await login(app, "Admin");
    const created = await app.inject({
      method: "POST",
      url: "/use-cases",
      headers: auth(admin),
      payload: {
        key: "carbon-credit",
        name: "Carbon Credit",
        tokenStandard: "ERC-20",
        allowedChainIds: ["mock", "fabric"],
        defaultChainId: "fabric",
        metadataSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
        lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
        compliance: { allowlist: true, transferRestrictions: true },
        roles: ["Admin", "Issuer", "Operator", "Viewer"],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().tokenType).toBe("fungible");

    const fetched = await app.inject({ method: "GET", url: "/use-cases/carbon-credit", headers: auth(admin) });
    expect(fetched.json().name).toBe("Carbon Credit");
  });

  it("rejects an invalid use-case definition", async () => {
    const admin = await login(app, "Admin");
    const res = await app.inject({
      method: "POST",
      url: "/use-cases",
      headers: auth(admin),
      payload: { key: "bad", name: "Bad", tokenStandard: "ERC-999", allowedChainIds: ["mock"], defaultChainId: "mock", metadataSchema: { type: "object", properties: {} }, lifecycle: { mint: true, transfer: true, burn: true, freeze: true }, compliance: { allowlist: false, transferRestrictions: false }, roles: ["Admin"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_USECASE");
  });
});
