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
    payload: { useCaseKey: "generic-asset", name: "Demo Asset", symbol: "DEMO", chainId: "fabric", metadata: { issuer: "ACME", assetClass: "commodity" } },
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
    expect(ids).toEqual(expect.arrayContaining(["fabric", "canton"]));
    expect(ids).not.toContain("besu"); // EVM chains are never simulated
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
      payload: { useCaseKey: "carbon-credit", name: "VCU Batch", symbol: "VCU", chainId: "fabric", metadata: { projectName: "Rainforest", registry: "Verra", vintage: 2023 } },
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
      payload: { useCaseKey: "carbon-credit", name: "X", symbol: "X", chainId: "fabric", metadata: { projectName: "X", registry: "Verra", vintage: 2024 } },
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
      payload: { name: "X", chainId: "fabric" }, // missing required 'useCaseKey'
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
      payload: { useCaseKey: "generic-asset", name: "X", symbol: "X", chainId: "fabric", metadata: { issuer: "A" } }, // missing 'assetClass'
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
        key: "fabric-only-asset", name: "Fabric Only", symbol: "FAB", tokenStandard: "ERC-20", allowedChainIds: ["fabric"], defaultChainId: "fabric",
        metadataSchema: { type: "object", properties: {} }, lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
        compliance: { allowlist: false, transferRestrictions: false }, roles: ["UseCaseAdmin", "Issuer"],
      },
    });
    expect(create.statusCode).toBe(201);
    const res = await inj({
      method: "POST",
      url: "/assets",
      headers: auth(admin),
      payload: { useCaseKey: "fabric-only-asset", name: "X", chainId: "canton", metadata: {} },
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
      payload: { key: "x", name: "X", symbol: "X", tokenStandard: "ERC-20", allowedChainIds: ["besu"], defaultChainId: "besu", metadataSchema: { type: "object", properties: {} }, lifecycle: { mint: true, transfer: true, burn: true, freeze: true }, compliance: { allowlist: false, transferRestrictions: false }, roles: ["UseCaseAdmin"] },
    });
    expect(forbidden.statusCode).toBe(403);

    // PlatformAdmin can create a new use case.
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const created = await inj({
      method: "POST",
      url: "/use-cases",
      headers: auth(admin),
      payload: {
        key: "supply-chain-token", name: "Supply Chain Token", symbol: "SCT", tokenStandard: "ERC-20", allowedChainIds: ["besu", "fabric"], defaultChainId: "fabric",
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

  it("edit (reset password), revoke (suspend), reactivate, and scope rules", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const created = (await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${admin}` }, payload: { email: "edit.me@x.dev", password: "secret1", role: "Issuer" } })).json();
    const reset = await app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { password: "newpass1" } });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "edit.me@x.dev", password: "secret1" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "edit.me@x.dev", password: "newpass1" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { active: false } })).statusCode).toBe(200);
    const blocked = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "edit.me@x.dev", password: "newpass1" } });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toBe("ACCOUNT_SUSPENDED");
    await app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { active: true } });
    expect((await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "edit.me@x.dev", password: "newpass1" } })).statusCode).toBe(200);
    const list = (await app.inject({ method: "GET", url: `${V1}/users`, headers: { authorization: `Bearer ${admin}` } })).json();
    expect(list.find((u: any) => u.email === "edit.me@x.dev").active).toBe(true);
  });

  it("a UseCaseAdmin cannot PATCH a user in another use case", async () => {
    const app = await buildTestApp();
    const goldAdmin = await loginAs(app, "gold.admin@tokenlayer.dev", "gold123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const carbonIssuer = (await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${carbonAdmin}` }, payload: { email: "x.iss@x.dev", password: "secret1", role: "Issuer" } })).json();
    const res = await app.inject({ method: "PATCH", url: `${V1}/users/${carbonIssuer.id}`, headers: { authorization: `Bearer ${goldAdmin}` }, payload: { active: false } });
    expect(res.statusCode).toBe(403);
  });

  it("throttles repeated logins from one IP (429)", async () => {
    const app = await buildTestApp({ loginRateLimitMax: 3 });
    const attempt = () => app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "admin@tokenlayer.dev", password: "wrong" } });
    expect((await attempt()).statusCode).toBe(401); // 1
    expect((await attempt()).statusCode).toBe(401); // 2
    expect((await attempt()).statusCode).toBe(401); // 3 (= max)
    const limited = await attempt(); // 4 → over the limit
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("TOO_MANY_REQUESTS");
  });

  it("M4: a scoped user's account list is limited to their use case (no cross-tenant enumeration)", async () => {
    const app = await buildTestApp();
    const carbonIssuer = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");
    const accts = (await app.inject({ method: "GET", url: `${V1}/accounts`, headers: { authorization: `Bearer ${carbonIssuer}` } })).json();
    const labels = (accts as { label: string }[]).map((a) => a.label);
    expect(labels).toContain("EcoFund Capital"); // linked to carbon.buyer — in scope
    expect(labels).not.toContain("Alice"); // linked to gold.buyer — must be hidden
  });

  it("C2: operator transfers/burns are labeled forced + attributed in the audit trail", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const id = await issueAsset(app, platform, "carbon-credit");
    const wallet = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
    const h = { authorization: `Bearer ${platform}` };
    await app.inject({ method: "POST", url: `${V1}/assets/${id}/actions/allow`, headers: h, payload: { account: wallet } });
    await app.inject({ method: "POST", url: `${V1}/assets/${id}/actions/mint`, headers: h, payload: { to: wallet, amount: "100" } });
    await app.inject({ method: "POST", url: `${V1}/assets/${id}/actions/burn`, headers: h, payload: { from: wallet, amount: "10" } });
    const audit = (await app.inject({ method: "GET", url: `${V1}/assets/${id}/audit`, headers: h })).json();
    const burn = (audit.data as { action: string; payload: Record<string, unknown> }[]).find((e) => e.action === "burn");
    expect(burn?.payload.forced).toBe(true);
    expect(burn?.payload.actorRole).toBe("PlatformAdmin");
  });

  it("KYC: onboard pending, gate allowlist until approved, ungated for unlinked wallets", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const wallet = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"; // not linked by the seed
    const created = (await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${admin}` }, payload: { email: "kyc.buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: wallet, kyc: { legalName: "K Buyer", country: "IN", idType: "Passport", idNumber: "X1", documentRef: "doc://1" } } })).json();
    expect(created.kycStatus).toBe("pending");
    const id = await issueAsset(app, platform, "carbon-credit");
    const blocked = await app.inject({ method: "POST", url: `${V1}/assets/${id}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: wallet } });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toBe("KYC_NOT_APPROVED");
    const free = await app.inject({ method: "POST", url: `${V1}/assets/${id}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" } });
    expect(free.statusCode).toBe(200); // unlinked wallet ungated
    const appr = await app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { kycStatus: "approved" } });
    expect(appr.json().kycStatus).toBe("approved");
    const allowed = await app.inject({ method: "POST", url: `${V1}/assets/${id}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: wallet } });
    expect(allowed.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Marketplace: buy (DvP) + cash/credit endpoints
// ---------------------------------------------------------------------------

// Seeded addresses used across buy tests:
// Treasury wallet (used as treasury account for listings): 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
// A buyer wallet we onboard fresh: Helios Energy Corp — 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955
const TREASURY_ADDR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const BUYER_WALLET = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";

/** Fund an address with CBDC-INR via POST /cash/credit using the given token. */
async function creditCash(appInst: typeof app, token: string, account: string, amount: string): Promise<{ ok: boolean; balance: string }> {
  const res = await appInst.inject({
    method: "POST",
    url: `${V1}/cash/credit`,
    headers: { authorization: `Bearer ${token}` },
    payload: { account, currency: "CBDC-INR", amount },
  });
  return res.json();
}

/** Read CBDC-INR balance for an address via GET /cash/balances. Returns "0" if none. */
async function cashBalance(appInst: typeof app, token: string, address: string): Promise<string> {
  const res = await appInst.inject({
    method: "GET",
    url: `${V1}/cash/balances?address=${address}`,
    headers: { authorization: `Bearer ${token}` },
  });
  const rows = res.json() as { currency: string; address: string; amount: string }[];
  return rows.find((r) => r.currency === "CBDC-INR")?.amount ?? "0";
}

/** POST /assets/:id/buy with a quantity. */
async function buy(appInst: typeof app, token: string, assetId: string, quantity: string) {
  return appInst.inject({
    method: "POST",
    url: `${V1}/assets/${assetId}/buy`,
    headers: { authorization: `Bearer ${token}` },
    payload: { quantity },
  });
}

describe("marketplace: buy (DvP) + cash/credit", () => {
  it("happy path: issue with sale terms, fund buyer, buy → token delivered + cash moved", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    // Issue asset WITH sale terms (unitPrice=5, currency=CBDC-INR, treasuryAccount=TREASURY_ADDR)
    const issueRes = await app.inject({
      method: "POST",
      url: `${V1}/assets`,
      headers: { authorization: `Bearer ${platform}` },
      payload: {
        useCaseKey: "carbon-credit",
        name: "Carbon VCU",
        symbol: "VCU",
        chainId: "fabric",
        metadata: { projectName: "Amazon Rainforest", registry: "Verra", vintage: 2024 },
        sale: { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
      },
    });
    expect(issueRes.statusCode).toBe(201);
    const assetId = issueRes.json().asset.id as string;
    // Sale terms should be reflected in the returned asset
    expect(issueRes.json().asset.unitPrice).toBe("5");
    expect(issueRes.json().asset.currency).toBe("CBDC-INR");

    // Onboard a new Buyer with a wallet (BUYER_WALLET = Helios Energy Corp)
    const createdBuyer = (await app.inject({
      method: "POST",
      url: `${V1}/users`,
      headers: { authorization: `Bearer ${carbonAdmin}` },
      payload: { email: "helios@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET },
    })).json();
    expect(createdBuyer.kycStatus).toBe("pending");

    // KYC-approve the buyer
    await app.inject({
      method: "PATCH",
      url: `${V1}/users/${createdBuyer.id}`,
      headers: { authorization: `Bearer ${carbonAdmin}` },
      payload: { kycStatus: "approved" },
    });

    // Allow treasury and buyer wallet
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: TREASURY_ADDR } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: BUYER_WALLET } });

    // Mint 100 tokens to treasury
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/mint`, headers: { authorization: `Bearer ${platform}` }, payload: { to: TREASURY_ADDR, amount: "100" } });

    // Fund the buyer with 1000 CBDC-INR via cash/credit (platform admin can always credit)
    const creditRes = await app.inject({
      method: "POST",
      url: `${V1}/cash/credit`,
      headers: { authorization: `Bearer ${platform}` },
      payload: { account: BUYER_WALLET, currency: "CBDC-INR", amount: "1000" },
    });
    expect(creditRes.statusCode).toBe(200);
    expect(creditRes.json().balance).toBe("1000");

    // Log in as the buyer and buy 10 tokens
    const buyerToken = await loginAs(app, "helios@x.dev", "secret1");
    const buyRes = await buy(app, buyerToken, assetId, "10");
    expect(buyRes.statusCode).toBe(200);
    const buyBody = buyRes.json();
    expect(buyBody.paid.amount).toBe("50"); // 5 * 10
    expect(buyBody.paid.currency).toBe("CBDC-INR");
    expect(buyBody.delivered.amount).toBe("10");

    // Assert buyer CBDC balance = 1000 - 50 = 950
    const buyerBalance = await cashBalance(app, platform, BUYER_WALLET);
    expect(buyerBalance).toBe("950");

    // Assert treasury CBDC balance = 50 (received payment)
    const treasuryBalance = await cashBalance(app, platform, TREASURY_ADDR);
    expect(treasuryBalance).toBe("50");

    // Assert buyer received 10 tokens by checking asset accounts
    const accountsRes = await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/accounts`, headers: { authorization: `Bearer ${platform}` } });
    const buyerAcct = accountsRes.json().find((a: { address: string }) => a.address === BUYER_WALLET);
    expect(buyerAcct?.balance).toBe("10");
  });

  it("buy blocked when buyer NOT allowlisted → cash refunded (compensation ran)", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    // Issue with sale terms
    const assetId = (await app.inject({
      method: "POST",
      url: `${V1}/assets`,
      headers: { authorization: `Bearer ${platform}` },
      payload: {
        useCaseKey: "carbon-credit",
        name: "Carbon VCU",
        symbol: "VCU",
        chainId: "fabric",
        metadata: { projectName: "Amazon Rainforest", registry: "Verra", vintage: 2024 },
        sale: { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
      },
    })).json().asset.id as string;

    // Onboard buyer with a fresh email
    const createdBuyer = (await app.inject({
      method: "POST",
      url: `${V1}/users`,
      headers: { authorization: `Bearer ${carbonAdmin}` },
      payload: { email: "helios2@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET },
    })).json();
    await app.inject({ method: "PATCH", url: `${V1}/users/${createdBuyer.id}`, headers: { authorization: `Bearer ${carbonAdmin}` }, payload: { kycStatus: "approved" } });

    // Allow ONLY treasury (NOT the buyer wallet)
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: TREASURY_ADDR } });
    // Mint to treasury
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/mint`, headers: { authorization: `Bearer ${platform}` }, payload: { to: TREASURY_ADDR, amount: "100" } });

    // Fund buyer
    await creditCash(app, platform, BUYER_WALLET, "1000");

    // Attempt to buy — should fail because buyer wallet not allowlisted
    const buyerToken = await loginAs(app, "helios2@x.dev", "secret1");
    const buyRes = await buy(app, buyerToken, assetId, "10");
    expect(buyRes.statusCode).toBe(400);

    // Buyer CBDC balance must be unchanged (refund ran)
    const buyerBalance = await cashBalance(app, platform, BUYER_WALLET);
    expect(buyerBalance).toBe("1000");
  });

  it("buy 400 NO_SALE_TERMS when asset has no sale terms", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    // Issue WITHOUT sale terms
    const assetId = (await issueAsset(app, platform, "carbon-credit"));

    // Onboard buyer
    const createdBuyer = (await app.inject({
      method: "POST",
      url: `${V1}/users`,
      headers: { authorization: `Bearer ${carbonAdmin}` },
      payload: { email: "helios3@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET },
    })).json();
    await app.inject({ method: "PATCH", url: `${V1}/users/${createdBuyer.id}`, headers: { authorization: `Bearer ${carbonAdmin}` }, payload: { kycStatus: "approved" } });
    await creditCash(app, platform, BUYER_WALLET, "500");
    const buyerToken = await loginAs(app, "helios3@x.dev", "secret1");

    const res = await buy(app, buyerToken, assetId, "1");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("NO_SALE_TERMS");
  });

  it("buy 400 INSUFFICIENT_FUNDS when buyer funded less than cost", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    const assetId = (await app.inject({
      method: "POST",
      url: `${V1}/assets`,
      headers: { authorization: `Bearer ${platform}` },
      payload: {
        useCaseKey: "carbon-credit",
        name: "Carbon VCU",
        symbol: "VCU",
        chainId: "fabric",
        metadata: { projectName: "Amazon Rainforest", registry: "Verra", vintage: 2024 },
        sale: { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
      },
    })).json().asset.id as string;

    const createdBuyer = (await app.inject({
      method: "POST",
      url: `${V1}/users`,
      headers: { authorization: `Bearer ${carbonAdmin}` },
      payload: { email: "helios4@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET },
    })).json();
    await app.inject({ method: "PATCH", url: `${V1}/users/${createdBuyer.id}`, headers: { authorization: `Bearer ${carbonAdmin}` }, payload: { kycStatus: "approved" } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: TREASURY_ADDR } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: BUYER_WALLET } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/mint`, headers: { authorization: `Bearer ${platform}` }, payload: { to: TREASURY_ADDR, amount: "100" } });

    // Fund with only 10 — not enough for 10 tokens at 5 each (cost=50)
    await creditCash(app, platform, BUYER_WALLET, "10");

    const buyerToken = await loginAs(app, "helios4@x.dev", "secret1");
    const res = await buy(app, buyerToken, assetId, "10");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INSUFFICIENT_FUNDS");
  });

  it("buy 400 INSUFFICIENT_TREASURY when treasury holds fewer tokens than requested", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    const assetId = (await app.inject({
      method: "POST",
      url: `${V1}/assets`,
      headers: { authorization: `Bearer ${platform}` },
      payload: {
        useCaseKey: "carbon-credit",
        name: "Carbon VCU",
        symbol: "VCU",
        chainId: "fabric",
        metadata: { projectName: "Amazon Rainforest", registry: "Verra", vintage: 2024 },
        sale: { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
      },
    })).json().asset.id as string;

    const createdBuyer = (await app.inject({
      method: "POST",
      url: `${V1}/users`,
      headers: { authorization: `Bearer ${carbonAdmin}` },
      payload: { email: "helios5@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET },
    })).json();
    await app.inject({ method: "PATCH", url: `${V1}/users/${createdBuyer.id}`, headers: { authorization: `Bearer ${carbonAdmin}` }, payload: { kycStatus: "approved" } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: TREASURY_ADDR } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: { authorization: `Bearer ${platform}` }, payload: { account: BUYER_WALLET } });

    // Mint only 5 tokens to treasury — buyer requests 10
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/mint`, headers: { authorization: `Bearer ${platform}` }, payload: { to: TREASURY_ADDR, amount: "5" } });
    await creditCash(app, platform, BUYER_WALLET, "1000");

    const buyerToken = await loginAs(app, "helios5@x.dev", "secret1");
    const res = await buy(app, buyerToken, assetId, "10");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INSUFFICIENT_TREASURY");
  });

  it("cash/credit 403 for a Buyer caller (role gate)", async () => {
    const res = await inj({
      method: "POST",
      url: "/cash/credit",
      headers: auth(await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123")),
      payload: { account: BUYER_WALLET, currency: "CBDC-INR", amount: "100" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("cash/credit 403 OUT_OF_SCOPE when a UseCaseAdmin funds an out-of-scope account", async () => {
    const app = await buildTestApp();
    // gold.admin is scoped to gold-loan — ALICE (0x70997970…) is linked to gold.buyer in gold-loan scope
    // but not to carbon-credit scope. We need an account that is NOT in gold-loan scope.
    // Carol (0x90F79bf6EB2c4f870365E785982E1f101E93b906) is not linked to any gold-loan user.
    const goldAdmin = await loginAs(app, "gold.admin@tokenlayer.dev", "gold123");

    // EcoFund Capital is linked to carbon.buyer (carbon-credit scope), so out-of-scope for gold admin
    const outOfScopeAccount = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"; // EcoFund Capital

    const res = await app.inject({
      method: "POST",
      url: `${V1}/cash/credit`,
      headers: { authorization: `Bearer ${goldAdmin}` },
      payload: { account: outOfScopeAccount, currency: "CBDC-INR", amount: "100" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("OUT_OF_SCOPE");
  });

  it("setPrice action updates sale terms; only issuers/admins may call it", async () => {
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const id = await issueGenericAsset(admin);

    // setPrice should work for PlatformAdmin
    const setPriceRes = await inj({
      method: "POST",
      url: `/assets/${id}/actions/setPrice`,
      headers: auth(admin),
      payload: { unitPrice: "10", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
    });
    expect(setPriceRes.statusCode).toBe(200);
    expect(setPriceRes.json().ok).toBe(true);

    // Verify sale terms are stored
    const assetRes = await inj({ method: "GET", url: `/assets/${id}`, headers: auth(admin) });
    expect(assetRes.json().unitPrice).toBe("10");
    expect(assetRes.json().currency).toBe("CBDC-INR");

    // Buyer cannot setPrice (no issue RBAC)
    const buyerToken = await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const blockedRes = await inj({
      method: "POST",
      url: `/assets/${id}/actions/setPrice`,
      headers: auth(buyerToken),
      payload: { unitPrice: "10", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
    });
    expect(blockedRes.statusCode).toBe(403);
  });

  it("buy 400 NO_WALLET when buyer has no linked wallet", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");

    // Issue with sale terms
    const assetId = (await app.inject({
      method: "POST",
      url: `${V1}/assets`,
      headers: { authorization: `Bearer ${platform}` },
      payload: {
        useCaseKey: "carbon-credit",
        name: "Carbon VCU",
        symbol: "VCU",
        chainId: "fabric",
        metadata: { projectName: "Amazon Rainforest", registry: "Verra", vintage: 2024 },
        sale: { unitPrice: "5", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
      },
    })).json().asset.id as string;

    // Onboard a Buyer WITHOUT a walletAddress
    const createdBuyer = (await app.inject({
      method: "POST",
      url: `${V1}/users`,
      headers: { authorization: `Bearer ${carbonAdmin}` },
      payload: { email: "nowallet@x.dev", password: "secret1", role: "Buyer" },
    })).json();
    expect(createdBuyer.accountId).toBeNull();

    // KYC-approve the buyer
    await app.inject({
      method: "PATCH",
      url: `${V1}/users/${createdBuyer.id}`,
      headers: { authorization: `Bearer ${carbonAdmin}` },
      payload: { kycStatus: "approved" },
    });

    const buyerToken = await loginAs(app, "nowallet@x.dev", "secret1");
    const res = await buy(app, buyerToken, assetId, "1");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("NO_WALLET");
  });

  it("setPrice 200 for a scoped Issuer; Buyer is still denied", async () => {
    // carbon.issuer@tokenlayer.dev is an Issuer scoped to carbon-credit
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    // Issue a carbon-credit asset (required for the Issuer to be in-scope)
    const assetId = await issueAsset(app, platform, "carbon-credit");

    const issuerToken = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");
    const setPriceRes = await app.inject({
      method: "POST",
      url: `${V1}/assets/${assetId}/actions/setPrice`,
      headers: { authorization: `Bearer ${issuerToken}` },
      payload: { unitPrice: "20", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
    });
    expect(setPriceRes.statusCode).toBe(200);
    expect(setPriceRes.json().ok).toBe(true);

    // Buyer is still denied
    const buyerToken = await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const blockedRes = await app.inject({
      method: "POST",
      url: `${V1}/assets/${assetId}/actions/setPrice`,
      headers: { authorization: `Bearer ${buyerToken}` },
      payload: { unitPrice: "20", currency: "CBDC-INR", treasuryAccount: TREASURY_ADDR },
    });
    expect(blockedRes.statusCode).toBe(403);
  });

  it("cash/balances 403 OUT_OF_SCOPE for a cross-tenant caller; 200 for PlatformAdmin", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const goldAdmin = await loginAs(app, "gold.admin@tokenlayer.dev", "gold123");

    // Fund an address that belongs to carbon-credit scope (EcoFund Capital)
    const ecoFundAddr = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
    await app.inject({
      method: "POST",
      url: `${V1}/cash/credit`,
      headers: { authorization: `Bearer ${platform}` },
      payload: { account: ecoFundAddr, currency: "CBDC-INR", amount: "500" },
    });

    // gold.admin is scoped to gold-loan — EcoFund Capital is out of that scope
    const scopedRes = await app.inject({
      method: "GET",
      url: `${V1}/cash/balances?address=${ecoFundAddr}`,
      headers: { authorization: `Bearer ${goldAdmin}` },
    });
    expect(scopedRes.statusCode).toBe(403);
    expect(scopedRes.json().error).toBe("OUT_OF_SCOPE");

    // PlatformAdmin can query any address
    const adminRes = await app.inject({
      method: "GET",
      url: `${V1}/cash/balances?address=${ecoFundAddr}`,
      headers: { authorization: `Bearer ${platform}` },
    });
    expect(adminRes.statusCode).toBe(200);
    const balances = adminRes.json() as { currency: string; amount: string }[];
    expect(balances.find((b) => b.currency === "CBDC-INR")?.amount).toBe("500");
  });

  it("setPrice 400 VALIDATION_ERROR when treasuryAccount is missing", async () => {
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const id = await issueGenericAsset(admin);

    const res = await inj({
      method: "POST",
      url: `/assets/${id}/actions/setPrice`,
      headers: auth(admin),
      payload: { unitPrice: "10", currency: "CBDC-INR" }, // missing treasuryAccount
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION_ERROR");
    expect(res.json().message).toContain("setPrice requires unitPrice, currency, and treasuryAccount");
  });
});
