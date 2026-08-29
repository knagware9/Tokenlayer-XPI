import { describe, it, expect } from "vitest";
import { MemoryAccountRepository, MemoryUserRepository } from "../src/persistence/memory/index.js";
import { backfillWallets, provisionTreasury, resolveAccountId, WALLET_ELIGIBLE_ROLES } from "../src/shared/wallets.js";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

describe("resolveAccountId", () => {
  it("uses the supplied address when given, regardless of role", async () => {
    const accounts = new MemoryAccountRepository();
    const id = await resolveAccountId({ accounts, enabledDomains: ["tokenization"] } as never, "Auditor", "0xsupplied", "a@x.dev");
    const acct = id ? await accounts.findById(id) : null;
    expect(acct?.address).toBe("0xsupplied");
  });

  it("auto-generates an address for an eligible role when none is supplied", async () => {
    const accounts = new MemoryAccountRepository();
    const id = await resolveAccountId({ accounts, enabledDomains: ["tokenization"] } as never, "Buyer", null, "a@x.dev");
    expect(id).not.toBeNull();
    const acct = id ? await accounts.findById(id) : null;
    expect(acct?.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("stays null for an ineligible role when no address is supplied", async () => {
    const accounts = new MemoryAccountRepository();
    const id = await resolveAccountId({ accounts, enabledDomains: ["tokenization"] } as never, "Auditor", null, "a@x.dev");
    expect(id).toBeNull();
  });

  it("stays null for a wallet-eligible role when the deployment does not serve tokenization", async () => {
    // "Issuer" is a role name both domains use for different things — identity's
    // Issuer signs credentials, never a token transfer, and has nothing to hold
    // a balance in. On an identity-only deployment Account is disabled
    // store-wide, so trying to auto-provision one here (as WALLET_ELIGIBLE_ROLES
    // would otherwise do for "Issuer") always failed onboarding outright.
    const accounts = new MemoryAccountRepository();
    const id = await resolveAccountId({ accounts, enabledDomains: ["identity"] } as never, "Issuer", null, "a@x.dev");
    expect(id).toBeNull();
  });

  it("refuses even a SUPPLIED address when the deployment does not serve tokenization", async () => {
    const accounts = new MemoryAccountRepository();
    const id = await resolveAccountId({ accounts, enabledDomains: ["identity"] } as never, "Issuer", "0xsupplied", "a@x.dev");
    expect(id).toBeNull();
  });

  it("lists exactly the roles that can hold tokens", () => {
    expect(WALLET_ELIGIBLE_ROLES.has("Buyer")).toBe(true);
    expect(WALLET_ELIGIBLE_ROLES.has("Trader")).toBe(true);
    expect(WALLET_ELIGIBLE_ROLES.has("Issuer")).toBe(true);
    expect(WALLET_ELIGIBLE_ROLES.has("Auditor")).toBe(false);
    expect(WALLET_ELIGIBLE_ROLES.has("PlatformAdmin")).toBe(false);
  });
});

describe("provisionTreasury", () => {
  it("creates an org-owned account and returns its id", async () => {
    const accounts = new MemoryAccountRepository();
    const id = await provisionTreasury({ accounts }, "org_1", "carbon-credit treasury");
    const acct = await accounts.findById(id);
    expect(acct?.ownerOrgId).toBe("org_1");
    expect(acct?.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(acct?.label).toBe("carbon-credit treasury");
  });
});

describe("backfillWallets", () => {
  it("assigns a wallet to every eligible walletless user, leaves the rest alone", async () => {
    const users = new MemoryUserRepository();
    const accounts = new MemoryAccountRepository();
    const buyerNoWallet = await users.create({ email: "b@x.dev", passwordHash: "h", role: "Buyer", useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null });
    const auditor = await users.create({ email: "au@x.dev", passwordHash: "h", role: "Auditor", useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null });
    const existing = await accounts.upsert("0xalready", "trader");
    const traderHasWallet = await users.create({ email: "t@x.dev", passwordHash: "h", role: "Trader", useCaseKey: null, accountId: existing.id, active: true, kycStatus: "approved", kyc: null });

    const result = await backfillWallets({ users, accounts, enabledDomains: ["tokenization"] } as never);
    expect(result.assigned).toBe(1);

    expect((await users.findById(buyerNoWallet.id))?.accountId).not.toBeNull();
    expect((await users.findById(auditor.id))?.accountId).toBeNull();
    expect((await users.findById(traderHasWallet.id))?.accountId).toBe(existing.id);
  });

  it("is idempotent — a second run assigns nothing further", async () => {
    const users = new MemoryUserRepository();
    const accounts = new MemoryAccountRepository();
    await users.create({ email: "b2@x.dev", passwordHash: "h", role: "Buyer", useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null });

    await backfillWallets({ users, accounts, enabledDomains: ["tokenization"] } as never);
    const second = await backfillWallets({ users, accounts, enabledDomains: ["tokenization"] } as never);
    expect(second.assigned).toBe(0);
  });
});

describe("PATCH /me/wallet", () => {
  it("replaces an eligible user's wallet with the address they supply", async () => {
    const app = await buildTestApp();
    const buyer = await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const res = await app.inject({
      method: "PATCH", url: `${V1}/me/wallet`, headers: auth(buyer),
      payload: { walletAddress: "0x1111111111111111111111111111111111aaaa" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().walletAddress).toBe("0x1111111111111111111111111111111111aaaa");

    const me = await app.inject({ method: "GET", url: `${V1}/users`, headers: auth(await loginAs(app, "admin@tokenlayer.dev", "admin123")) });
    const row = (me.json() as Array<{ email: string; accountId: string | null }>).find((u) => u.email === "carbon.buyer@tokenlayer.dev");
    expect(row?.accountId).toBe(res.json().accountId);
  });

  it("refuses a role that cannot hold tokens", async () => {
    const app = await buildTestApp();
    const auditor = await loginAs(app, "carbon.auditor@tokenlayer.dev", "carbon123");
    const res = await app.inject({
      method: "PATCH", url: `${V1}/me/wallet`, headers: auth(auditor),
      payload: { walletAddress: "0x2222222222222222222222222222222222bbbb" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("ROLE_CANNOT_HOLD_WALLET");
  });

  it("refuses an address already linked to a different user", async () => {
    const app = await buildTestApp();
    const buyer = await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const issuer = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");
    const taken = await app.inject({
      method: "PATCH", url: `${V1}/me/wallet`, headers: auth(buyer),
      payload: { walletAddress: "0x3333333333333333333333333333333333cccc" },
    });
    expect(taken.statusCode).toBe(200);

    const res = await app.inject({
      method: "PATCH", url: `${V1}/me/wallet`, headers: auth(issuer),
      payload: { walletAddress: "0x3333333333333333333333333333333333cccc" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("ADDRESS_IN_USE");
  });

  it("re-linking the SAME address to the same caller is a no-op success, not a conflict", async () => {
    const app = await buildTestApp();
    const buyer = await loginAs(app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const payload = { walletAddress: "0x4444444444444444444444444444444444dddd" };
    expect((await app.inject({ method: "PATCH", url: `${V1}/me/wallet`, headers: auth(buyer), payload })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `${V1}/me/wallet`, headers: auth(buyer), payload })).statusCode).toBe(200);
  });
});
