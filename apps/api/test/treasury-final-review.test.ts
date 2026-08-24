/**
 * Whole-branch review fixes for org-owned treasury accounts.
 *
 * The branch's own task-scoped tests all passed; these cover the defects that
 * only showed up when the new code was read against code the plan never
 * touched — chiefly that the treasury address is PUBLISHED (every asset read
 * carries it) and UNLINKED (no user is on it), which together made it look like
 * a free address to every "is this taken?" check in the codebase.
 */
import { describe, it, expect } from "vitest";
import { buildTestApp, buildTestAppWithRepos, V1, loginAs, auth, onboardUser, treasuryAddressOf } from "./helpers.js";
import { createComplianceProvider } from "../src/tokenization/compliance-provider.js";
import { MemoryAccountRepository, MemoryAuditRepository, MemoryUserRepository } from "../src/persistence/memory/index.js";
import { ownerOrgOfUseCase } from "../src/shared/events.js";
import { resolveAccountId } from "../src/shared/wallets.js";
import { ensureNamedOrg, PLATFORM_ORG_NAME } from "../src/shared/platform-org.js";
import type { UseCaseDefinition } from "@tokenlayer/core";

const BUYER_WALLET = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";

const base = {
  tokenStandard: "ERC-20" as const,
  metadataSchema: { type: "object" as const, properties: {} },
  lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
  compliance: { allowlist: false, transferRestrictions: false },
  roles: ["UseCaseAdmin", "Issuer"],
};

describe("finding 1: the compliance-exempt treasury address is not claimable", () => {
  it("a Buyer cannot PATCH /me/wallet onto the use case's treasury address", async () => {
    // THE CVE-SHAPED SCENARIO, END TO END. `asset.treasuryAccount` is returned
    // on every asset read, so any Buyer in the use case can discover the
    // address; the treasury Account has no linked user, so the pre-existing
    // ADDRESS_IN_USE check answered "free". Claiming it would have made this
    // Buyer the user linked to the one account `isUseCaseTreasury` exempts
    // from requireJurisdiction / requireVerifiedIdentity.
    const { app, deps } = await buildTestAppWithRepos();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const treasury = await treasuryAddressOf(app, platform, "carbon-credit");

    const buyer = await onboardUser(app, carbonAdmin, platform, {
      email: "claimant@x.dev", password: "secret1", role: "Buyer", walletAddress: BUYER_WALLET,
    });
    const buyerToken = await loginAs(app, "claimant@x.dev", "secret1");

    const res = await app.inject({
      method: "PATCH", url: `${V1}/me/wallet`, headers: auth(buyerToken),
      payload: { walletAddress: treasury },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("ADDRESS_IS_ORG_TREASURY");

    // Nothing moved: the buyer keeps their own wallet, and the treasury Account
    // still has no user on it.
    const after = await deps.users.findById(buyer.id);
    expect(after?.accountId).toBe(buyer.accountId);
    const treasuryAcct = await deps.accounts.findByAddress(treasury);
    expect(treasuryAcct).not.toBeNull();
    expect(await deps.users.findByAccountId(treasuryAcct!.id)).toBeNull();
  });

  it("the OTHER door refuses it too: resolveAccountId rejects an org-owned address", async () => {
    // A gate on one of two doors is not a gate. `resolveAccountId` is where a
    // supplied `walletAddress` becomes a link on POST /users, POST
    // /orgs/:id/users and the onboard-user proposal executor.
    const accounts = new MemoryAccountRepository();
    const orgOwned = await accounts.upsert("0xtreasury", "Carbon treasury", "org_owner");
    await expect(resolveAccountId({ accounts } as never, "Buyer", orgOwned.address, "b@x.dev"))
      .rejects.toMatchObject({ code: "ADDRESS_IS_ORG_TREASURY", statusCode: 400 });
    // A personal (org-less) address is untouched by the new refusal.
    const personal = await accounts.upsert("0xpersonal", "someone", undefined);
    expect(await resolveAccountId({ accounts } as never, "Buyer", personal.address, "b@x.dev")).toBe(personal.id);
  });

  it("defence in depth: a CLAIMED account is no longer the use case's treasury", async () => {
    // Even reached with a link already in place (a row that predates the
    // refusal, or any future door that forgets it), the exemption is refused
    // rather than granted to whoever holds the link.
    const users = new MemoryUserRepository();
    const accounts = new MemoryAccountRepository();
    const audit = new MemoryAuditRepository();
    const provider = createComplianceProvider({
      users, accounts, audit,
      identity: { holds: async () => false },
    });
    const treasury = await accounts.upsert("0xtreasury", "UC treasury", "org_owner");

    // Unclaimed: the exemption stands (the behaviour Task 5 shipped).
    expect(await provider.isUseCaseTreasury(treasury.address, treasury.id)).toBe(true);

    // Claimed: it does not.
    await users.create({
      email: "claimant@x.dev", passwordHash: "x", role: "Buyer", useCaseKey: "carbon-credit",
      accountId: treasury.id, active: true, kycStatus: "approved", kyc: null, kind: "human",
    });
    expect(await provider.isUseCaseTreasury(treasury.address, treasury.id)).toBe(false);
  });

  it("and the gate really re-arms: a claimed treasury stops bypassing requireVerifiedIdentity", async () => {
    // The trace that "looks right" cannot give you: force the link straight
    // through the repository (as if it predated the route refusal) and watch
    // the mint that used to be exempt fail the real check.
    const { app, deps } = await buildTestAppWithRepos();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // A use case with the identity gate on and no allowlist, so the only thing
    // standing between the mint and a 400 is the treasury exemption itself.
    const created = await app.inject({
      method: "POST", url: `${V1}/use-cases`, headers: auth(platform),
      payload: {
        ...base, key: "uc-exempt", name: "UC Exempt", symbol: "UEX",
        allowedChainIds: ["fabric"], defaultChainId: "fabric",
        compliance: { allowlist: false, transferRestrictions: false, requireVerifiedIdentity: true },
      },
    });
    expect(created.statusCode).toBe(201);
    const treasury = await treasuryAddressOf(app, platform, "uc-exempt");

    const assetId = (await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(platform),
      payload: { useCaseKey: "uc-exempt", name: "Exemption Trace", chainId: "fabric", metadata: {} },
    })).json().asset.id as string;

    const mint = () => app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/actions/mint`, headers: auth(platform),
      payload: { to: treasury, amount: "10" },
    });

    // Unclaimed treasury: exempt, mints fine.
    expect((await mint()).statusCode).toBe(200);

    // Claim it behind the route's back, then try again.
    const treasuryAcct = await deps.accounts.findByAddress(treasury);
    const buyer = await deps.users.create({
      email: "backdoor@x.dev", passwordHash: "x", role: "Buyer", useCaseKey: "uc-exempt",
      accountId: null, active: true, kycStatus: "approved", kyc: { legalName: "B", country: "GB" }, kind: "human",
    });
    await deps.users.update(buyer.id, { accountId: treasuryAcct!.id });

    const blocked = await mint();
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toBe("IDENTITY_NOT_VERIFIED");
  });
});

describe("finding 2: PUT /use-cases/:key cannot clear ownerOrgId", () => {
  it("a body with no ownerOrgId leaves the owner unchanged", async () => {
    // Mirrors the treasuryAccountId preservation test. ownerOrgId is not in the
    // PUT schema at all, so every ordinary edit arrives with it undefined — and
    // the column is String NOT NULL DEFAULT "", so writing null is a Prisma
    // validation error on the real database (a silent null-out on memory,
    // which is why the branch's own tests never saw it).
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const created = await app.inject({
      method: "POST", url: `${V1}/use-cases`, headers: auth(admin),
      payload: { ...base, key: "uc-owner", name: "UC Owner", symbol: "UCO", allowedChainIds: ["fabric"], defaultChainId: "fabric" },
    });
    expect(created.statusCode).toBe(201);
    const ownerOrgId = created.json().ownerOrgId as string;
    expect(typeof ownerOrgId).toBe("string");
    expect(ownerOrgId).not.toBe("");

    const put = await app.inject({
      method: "PUT", url: `${V1}/use-cases/uc-owner`, headers: auth(admin),
      payload: { ...base, key: "uc-owner", name: "UC Owner Renamed", symbol: "UCO", allowedChainIds: ["fabric"], defaultChainId: "fabric" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().ownerOrgId).toBe(ownerOrgId);

    const after = await app.inject({ method: "GET", url: `${V1}/use-cases/uc-owner`, headers: auth(admin) });
    expect(after.json().ownerOrgId).toBe(ownerOrgId);
    expect(after.json().name).toBe("UC Owner Renamed"); // the edit itself still landed
  });

  it("a body that tries to REPOINT the owner is ignored", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const created = await app.inject({
      method: "POST", url: `${V1}/use-cases`, headers: auth(admin),
      payload: { ...base, key: "uc-owner-2", name: "UC Owner 2", symbol: "UO2", allowedChainIds: ["fabric"], defaultChainId: "fabric" },
    });
    const ownerOrgId = created.json().ownerOrgId as string;
    const put = await app.inject({
      method: "PUT", url: `${V1}/use-cases/uc-owner-2`, headers: auth(admin),
      payload: { ...base, key: "uc-owner-2", name: "UC Owner 2", symbol: "UO2", allowedChainIds: ["fabric"], defaultChainId: "fabric", ownerOrgId: "org_someone_else" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().ownerOrgId).toBe(ownerOrgId);
  });
});

describe("finding 6: platform-seeded use cases stay tenancy-invisible", () => {
  it("ownerOrgOfUseCase returns null for a Platform-org-owned use case, and the real org id otherwise", async () => {
    // Task 4 stamped the seven seeded use cases with the "TokenLayer Platform"
    // org so each could own a treasury. That org is the deployment's own signer
    // identity, not a customer tenant — an OrgAdmin or an org-scoped API key
    // under it must not thereby inherit every seeded use case's asset events.
    const { deps } = await buildTestAppWithRepos();
    const platformOrg = await deps.organizations.findByName(PLATFORM_ORG_NAME);
    expect(platformOrg).not.toBeNull();
    const seeded = await deps.useCases.get("carbon-credit");
    expect(seeded.ownerOrgId).toBe(platformOrg!.id); // provisioning ownership is real…
    expect(await ownerOrgOfUseCase(deps, "carbon-credit")).toBeNull(); // …tenancy ownership is not

    const customer = await ensureNamedOrg(deps, { name: "Globex Ltd", orgType: "corporate", jurisdiction: "IN" });
    await deps.useCases.create({ ...seeded, key: "globex-bond", name: "Globex Bond", symbol: "GXB", ownerOrgId: customer.id, contracts: {} } as UseCaseDefinition);
    expect(await ownerOrgOfUseCase(deps, "globex-bond")).toBe(customer.id);

    // Unknown use case and the "" sentinel both stay null.
    expect(await ownerOrgOfUseCase(deps, "no-such-use-case")).toBeNull();
    await deps.useCases.create({ ...seeded, key: "unowned-uc", name: "Unowned", symbol: "UNO", ownerOrgId: "", contracts: {} } as UseCaseDefinition);
    expect(await ownerOrgOfUseCase(deps, "unowned-uc")).toBeNull();
  });
});

describe("finding 7: PlatformAdmin create-use-case edge cases", () => {
  it("an explicit ownerOrgId of \"\" falls back to the Platform org, not to the backfill sentinel", async () => {
    const { app, deps } = await buildTestAppWithRepos();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({
      method: "POST", url: `${V1}/use-cases`, headers: auth(admin),
      payload: { ...base, key: "uc-empty-owner", name: "UC Empty Owner", symbol: "UEO", allowedChainIds: ["fabric"], defaultChainId: "fabric", ownerOrgId: "" },
    });
    expect(res.statusCode).toBe(201);
    const platformOrg = await deps.organizations.findByName(PLATFORM_ORG_NAME);
    expect(res.json().ownerOrgId).toBe(platformOrg!.id);
    // …and the treasury Account it provisioned belongs to the same org, so a
    // later backfill run has nothing to "fix".
    const uc = await deps.useCases.get("uc-empty-owner");
    const treasury = await deps.accounts.findById(uc.treasuryAccountId!);
    expect(treasury?.ownerOrgId).toBe(platformOrg!.id);
  });

  it("a duplicate key is a 409 with no treasury provisioned and no contract deployed", async () => {
    const { app, deps } = await buildTestAppWithRepos();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const payload = { ...base, key: "uc-dup", name: "UC Dup", symbol: "UDP", allowedChainIds: ["fabric"], defaultChainId: "fabric" };
    expect((await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(admin), payload })).statusCode).toBe(201);

    const accountsBefore = (await deps.accounts.list()).length;
    const dup = await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(admin), payload });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("USECASE_EXISTS");
    expect((await deps.accounts.list()).length).toBe(accountsBefore);
  });

  it("MISSING_TREASURY reads the same from issuance and from setPrice", async () => {
    const { app, deps } = await buildTestAppWithRepos();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // Issue while the treasury still exists, then strip it — so setPrice hits
    // the same condition issuance does.
    const assetId = (await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(platform),
      payload: {
        useCaseKey: "carbon-credit", name: "Wording Check", chainId: "fabric",
        metadata: { projectName: "P", registry: "Verra", vintage: 2024 },
      },
    })).json().asset.id as string;
    const carbon = await deps.useCases.get("carbon-credit");
    await deps.useCases.update("carbon-credit", { ...carbon, treasuryAccountId: undefined });

    const issued = await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(platform),
      payload: {
        useCaseKey: "carbon-credit", name: "Wording Check 2", chainId: "fabric",
        metadata: { projectName: "P", registry: "Verra", vintage: 2025 },
        sale: { unitPrice: "5", currency: "CBDC-INR" },
      },
    });
    const priced = await app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/actions/setPrice`, headers: auth(platform),
      payload: { unitPrice: "5", currency: "CBDC-INR" },
    });
    expect(issued.statusCode).toBe(400);
    expect(priced.statusCode).toBe(400);
    expect(issued.json().error).toBe("MISSING_TREASURY");
    expect(priced.json().error).toBe("MISSING_TREASURY");
    expect(issued.json().message).toBe(priced.json().message);
    expect(issued.json().message).toContain("backfill");
  });
});
