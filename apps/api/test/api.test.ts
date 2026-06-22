import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { ACCOUNTS, auth, buildTestApp, issueAsset, loginAs, V1 } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});

/** Inject against the versioned API; absolute paths (e.g. /openapi.json) pass through. */
function inj(opts: InjectOptions & { url: string }) {
  return app.inject({ ...opts, url: opts.url.startsWith("/api") || opts.url.startsWith("/openapi") ? opts.url : `${V1}${opts.url}` });
}

/**
 * Issue a generic-asset (ERC-20) as PlatformAdmin and return its id.
 * All tests that need a live asset in the shared `app` instance use this.
 */
async function issueGenericAsset(token: string): Promise<string> {
  const res = await inj({
    method: "POST",
    url: "/assets",
    headers: auth(token),
    payload: { useCaseKey: "generic-asset", name: "Demo Asset", symbol: "DEMO", chainId: "besu", metadata: { issuer: "ACME", assetClass: "commodity" } },
  });
  expect(res.statusCode).toBe(201);
  return res.json().asset.id as string;
}

describe("auth", () => {
  it("rejects bad credentials", async () => {
    const res = await inj({ method: "POST", url: "/auth/login", payload: { email: "admin@tokenlayer.dev", password: "wrong" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("UNAUTHORIZED");
  });

  it("requires a token for protected routes", async () => {
    const res = await inj({ method: "GET", url: "/use-cases" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("UNAUTHORIZED");
  });
});

describe("OpenAPI", () => {
  it("serves an OpenAPI 3 document covering the versioned paths", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toContain("/api/v1/assets");
    expect(Object.keys(spec.paths)).toContain("/api/v1/assets/{id}/actions/{action}");
  });
});

describe("catalog", () => {
  it("lists configured use cases and multi-DLT chains (PlatformAdmin sees all)", async () => {
    // PlatformAdmin is unscoped — sees every configured use case and chain.
    const token = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const useCases = await inj({ method: "GET", url: "/use-cases", headers: auth(token) });
    const keys = useCases.json().map((u: { key: string }) => u.key);
    expect(keys).toEqual(expect.arrayContaining(["generic-asset", "generic-certificate", "gold-loan", "corporate-bond"]));
    const chains = await inj({ method: "GET", url: "/chains", headers: auth(token) });
    const ids = chains.json().map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["besu", "mst", "fabric", "canton"]));
  });

  it("a scoped user only sees their own use case in the catalog", async () => {
    // carbon.auditor is scoped to carbon-credit — should only see that one use case.
    const token = await loginAs(app, "carbon.auditor@tokenlayer.dev", "carbon123");
    const useCases = await inj({ method: "GET", url: "/use-cases", headers: auth(token) });
    const keys = useCases.json().map((u: { key: string }) => u.key);
    expect(keys).toEqual(["carbon-credit"]);
  });
});

describe("issuance + RBAC + validation", () => {
  it("lets a PlatformAdmin issue an asset", async () => {
    const token = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    expect(await issueGenericAsset(token)).toBeTruthy();
  });

  it("lets a scoped Issuer issue an asset in their own use case", async () => {
    // carbon.issuer is an Issuer scoped to carbon-credit — can issue carbon-credit assets.
    const token = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");
    const res = await inj({
      method: "POST",
      url: "/assets",
      headers: auth(token),
      payload: { useCaseKey: "carbon-credit", name: "VCU Batch", symbol: "VCU", chainId: "besu", metadata: { projectName: "Rainforest", registry: "Verra", vintage: 2023 } },
    });
    expect(res.statusCode).toBe(201);
  });

  it("forbids a Buyer (read-only role) from issuing", async () => {
    // Buyer's RBAC matrix only includes 'read' — no 'issue'.
    const token = await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const res = await inj({
      method: "POST",
      url: "/assets",
      headers: auth(token),
      payload: { useCaseKey: "carbon-credit", name: "X", symbol: "X", chainId: "besu", metadata: { projectName: "X", registry: "Verra", vintage: 2024 } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("rejects a malformed body with VALIDATION_ERROR (schema validation)", async () => {
    const token = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await inj({
      method: "POST",
      url: "/assets",
      headers: auth(token),
      payload: { useCaseKey: "generic-asset", name: "X", chainId: "besu" }, // missing 'symbol'
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION_ERROR");
  });

  it("rejects issuance with invalid metadata", async () => {
    const token = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await inj({
      method: "POST",
      url: "/assets",
      headers: auth(token),
      payload: { useCaseKey: "generic-asset", name: "X", symbol: "X", chainId: "besu", metadata: { issuer: "A" } }, // missing 'assetClass'
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_METADATA");
  });

  it("returns a NOT_FOUND envelope for a missing asset", async () => {
    const token = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await inj({ method: "GET", url: "/assets/does-not-exist", headers: auth(token) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "NOT_FOUND" });
  });
});

describe("asset listing — filter + pagination", () => {
  it("returns a { data, pagination } envelope and honours limit/offset/filter", async () => {
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await issueGenericAsset(admin);
    await issueGenericAsset(admin);

    const page = await inj({ method: "GET", url: "/assets?limit=1&offset=0", headers: auth(admin) });
    const body = page.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination.limit).toBe(1);
    expect(body.pagination.total).toBeGreaterThanOrEqual(2);

    const filtered = await inj({ method: "GET", url: "/assets?useCaseKey=generic-asset&limit=100", headers: auth(admin) });
    expect(filtered.json().data.every((a: { useCaseKey: string }) => a.useCaseKey === "generic-asset")).toBe(true);
  });
});

describe("lifecycle + compliance + audit", () => {
  it("runs allow → mint → transfer → freeze-block → audit", async () => {
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const id = await issueGenericAsset(admin);
    const act = (action: string, body: Record<string, string>) =>
      inj({ method: "POST", url: `/assets/${id}/actions/${action}`, headers: auth(admin), payload: body });

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

    const accounts = await inj({ method: "GET", url: `/assets/${id}/accounts`, headers: auth(admin) });
    const alice = accounts.json().find((a: { address: string }) => a.address === ACCOUNTS.ALICE);
    expect(alice.balance).toBe("600");
    expect(alice.frozen).toBe(true);

    const audit = await inj({ method: "GET", url: `/assets/${id}/audit`, headers: auth(admin) });
    const actions = audit.json().data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["mint", "freeze"]));
    expect(audit.json().pagination.total).toBeGreaterThanOrEqual(5);
  });

  it("issues and mints an ERC-721 certificate by token id, then blocks transfer", async () => {
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const issue = await inj({
      method: "POST",
      url: "/assets",
      headers: auth(admin),
      payload: { useCaseKey: "generic-certificate", name: "Cert", symbol: "CERT", chainId: "fabric", metadata: { category: "registration", authority: "Gov" } },
    });
    expect(issue.statusCode).toBe(201);
    expect(issue.json().asset.tokenStandard).toBe("ERC-721");
    const id = issue.json().asset.id as string;

    expect((await inj({ method: "POST", url: `/assets/${id}/actions/mint`, headers: auth(admin), payload: { to: ACCOUNTS.ALICE, tokenId: "1", uri: "ipfs://x" } })).statusCode).toBe(200);

    const tokens = await inj({ method: "GET", url: `/assets/${id}/tokens`, headers: auth(admin) });
    expect(tokens.json()).toEqual([{ tokenId: "1", owner: ACCOUNTS.ALICE, ownerLabel: "Alice", frozen: false }]);

    const transfer = await inj({ method: "POST", url: `/assets/${id}/actions/transfer`, headers: auth(admin), payload: { from: ACCOUNTS.ALICE, to: ACCOUNTS.BOB, tokenId: "1" } });
    expect(transfer.statusCode).toBe(400);
    expect(transfer.json().error).toBe("ACTION_DISABLED");
  });

  it("rejects issuance to a chain the use case does not allow", async () => {
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const create = await inj({
      method: "POST",
      url: "/use-cases",
      headers: auth(admin),
      payload: {
        key: "besu-only-asset", name: "Besu Only", tokenStandard: "ERC-20", allowedChainIds: ["besu"], defaultChainId: "besu",
        metadataSchema: { type: "object", properties: {} }, lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
        compliance: { allowlist: false, transferRestrictions: false }, roles: ["UseCaseAdmin", "Issuer"],
      },
    });
    expect(create.statusCode).toBe(201);
    const res = await inj({
      method: "POST",
      url: "/assets",
      headers: auth(admin),
      payload: { useCaseKey: "besu-only-asset", name: "X", symbol: "X", chainId: "canton", metadata: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CHAIN_NOT_ALLOWED");
  });
});

describe("low-code use-case builder", () => {
  it("only a PlatformAdmin can create a use case; non-admin gets 403", async () => {
    // Use a scoped role (Buyer) to confirm non-PlatformAdmin is rejected.
    const buyer = await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const forbidden = await inj({
      method: "POST",
      url: "/use-cases",
      headers: auth(buyer),
      payload: { key: "x", name: "X", tokenStandard: "ERC-20", allowedChainIds: ["besu"], defaultChainId: "besu", metadataSchema: { type: "object", properties: {} }, lifecycle: { mint: true, transfer: true, burn: true, freeze: true }, compliance: { allowlist: false, transferRestrictions: false }, roles: ["UseCaseAdmin"] },
    });
    expect(forbidden.statusCode).toBe(403);

    // PlatformAdmin can create a new use case.
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const created = await inj({
      method: "POST",
      url: "/use-cases",
      headers: auth(admin),
      payload: {
        key: "supply-chain-token", name: "Supply Chain Token", tokenStandard: "ERC-20", allowedChainIds: ["besu", "fabric"], defaultChainId: "fabric",
        metadataSchema: { type: "object", properties: { product: { type: "string" } }, required: ["product"] },
        lifecycle: { mint: true, transfer: true, burn: true, freeze: true }, compliance: { allowlist: true, transferRestrictions: true },
        roles: ["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().tokenType).toBe("fungible");

    const fetched = await inj({ method: "GET", url: "/use-cases/supply-chain-token", headers: auth(admin) });
    expect(fetched.json().name).toBe("Supply Chain Token");
  });

  it("rejects an invalid use-case definition", async () => {
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await inj({
      method: "POST",
      url: "/use-cases",
      headers: auth(admin),
      payload: { key: "bad", name: "Bad", tokenStandard: "ERC-999", allowedChainIds: ["besu"], defaultChainId: "besu", metadataSchema: { type: "object", properties: {} }, lifecycle: { mint: true, transfer: true, burn: true, freeze: true }, compliance: { allowlist: false, transferRestrictions: false }, roles: ["UseCaseAdmin"] },
    });
    expect(res.statusCode).toBe(400);
    // ERC-999 fails request-schema enum first; either VALIDATION_ERROR or INVALID_USECASE is acceptable.
    expect(["VALIDATION_ERROR", "INVALID_USECASE"]).toContain(res.json().error);
  });
});

describe("per-use-case tenancy", () => {
  it("a carbon Issuer cannot read a gold-loan asset (404) or act on it (403); lists are scoped", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const gold = await issueAsset(app, platform, "gold-loan");
    await issueAsset(app, platform, "carbon-credit");
    const carbonIssuer = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");

    const read = await app.inject({ method: "GET", url: `${V1}/assets/${gold}`, headers: { authorization: `Bearer ${carbonIssuer}` } });
    expect(read.statusCode).toBe(404);
    const act = await app.inject({ method: "POST", url: `${V1}/assets/${gold}/actions/mint`, headers: { authorization: `Bearer ${carbonIssuer}` }, payload: { to: "0x1", amount: "1" } });
    expect(act.statusCode).toBe(403);
    expect(act.json().error).toBe("WRONG_USE_CASE");

    const list = await app.inject({ method: "GET", url: `${V1}/assets?limit=50`, headers: { authorization: `Bearer ${carbonIssuer}` } });
    expect(list.json().data.every((a: any) => a.useCaseKey === "carbon-credit")).toBe(true);
  });

  it("a UseCaseAdmin creates an Issuer in-scope but cannot escalate or cross use cases", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const ok = await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${admin}` }, payload: { email: "new.issuer@x.dev", password: "secret1", role: "Issuer" } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().useCaseKey).toBe("carbon-credit");
    const escalate = await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${admin}` }, payload: { email: "x@x.dev", password: "secret1", role: "UseCaseAdmin" } });
    expect(escalate.statusCode).toBe(403);
  });

  it("a UseCaseAdmin cannot create a user in another use case", async () => {
    // The POST /users handler ignores body.useCaseKey for non-PlatformAdmin callers:
    //   targetUseCaseKey = claims.useCaseKey  (always the caller's own use case)
    // So even though the body requests "gold-loan", the carbon admin's effective scope
    // forces the new user into "carbon-credit". The security property is upheld:
    // a UseCaseAdmin cannot provision a user into a foreign use case.
    const app = await buildTestApp();
    const admin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${admin}` }, payload: { email: "x.cross@x.dev", password: "secret1", role: "Issuer", useCaseKey: "gold-loan" } });
    // body.useCaseKey is ignored; user is silently created in the caller's own use case.
    expect(res.statusCode).toBe(201);
    expect(res.json().useCaseKey).toBe("carbon-credit");
  });

  it("a Buyer is read-only", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbon = await issueAsset(app, platform, "carbon-credit");
    const buyer = await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const mint = await app.inject({ method: "POST", url: `${V1}/assets/${carbon}/actions/mint`, headers: { authorization: `Bearer ${buyer}` }, payload: { to: "0x1", amount: "1" } });
    expect(mint.statusCode).toBe(403);
  });
});
