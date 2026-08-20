import { describe, it, expect } from "vitest";
import { MemoryUserRepository, MemoryAccountRepository } from "../src/persistence/memory/index.js";

describe("MemoryUserRepository", () => {
  it("creates, finds, lists-by-use-case, updates and removes", async () => {
    const repo = new MemoryUserRepository();
    const a = await repo.create({ email: "a@x.dev", passwordHash: "h", role: "Issuer", useCaseKey: "carbon-credit", accountId: null, active: true, kycStatus: "approved", kyc: null });
    await repo.create({ email: "b@x.dev", passwordHash: "h", role: "Trader", useCaseKey: "gold-loan", accountId: null, active: true, kycStatus: "pending", kyc: { legalName: "B" } });
    expect((await repo.findById(a.id))?.email).toBe("a@x.dev");
    expect((await repo.findByEmail("a@x.dev"))?.role).toBe("Issuer");
    expect((await repo.list("carbon-credit")).map((u) => u.email)).toEqual(["a@x.dev"]);
    expect((await repo.list()).length).toBe(2);
    const upd = await repo.update(a.id, { passwordHash: "h2", accountId: "acct_1" });
    expect(upd.passwordHash).toBe("h2");
    expect(upd.accountId).toBe("acct_1");
    const suspended = await repo.update(a.id, { active: false });
    expect(suspended.active).toBe(false);
    await expect(repo.update("no-such-id", { passwordHash: "x" })).rejects.toThrow("unknown user");
    expect((await repo.findById(a.id))?.kycStatus).toBe("approved");
    const bRec = (await repo.list("gold-loan"))[0];
    expect(bRec?.kyc?.legalName).toBe("B");
    const rej = await repo.update(a.id, { kycStatus: "rejected" });
    expect(rej.kycStatus).toBe("rejected");
    await repo.remove(a.id);
    expect(await repo.findById(a.id)).toBeNull();
  });

  it("finds the user linked to a given account id", async () => {
    const repo = new MemoryUserRepository();
    const a = await repo.create({ email: "a@x.dev", passwordHash: "h", role: "Buyer", useCaseKey: "carbon-credit", accountId: null, active: true, kycStatus: "approved", kyc: null });
    expect(await repo.findByAccountId("acct_1")).toBeNull();
    await repo.update(a.id, { accountId: "acct_1" });
    expect((await repo.findByAccountId("acct_1"))?.id).toBe(a.id);
  });
});

describe("MemoryAccountRepository", () => {
  it("upserts and finds by id", async () => {
    const repo = new MemoryAccountRepository();
    const acct = await repo.upsert("0xabc", "EcoFund");
    expect((await repo.findById(acct.id))?.label).toBe("EcoFund");
    expect(await repo.findById("nope")).toBeNull();
  });

  it("finds by address without mutating an existing row's label", async () => {
    const repo = new MemoryAccountRepository();
    const acct = await repo.upsert("0xabc", "EcoFund");
    expect(await repo.findByAddress("0xdoesnotexist")).toBeNull();
    const found = await repo.findByAddress("0xabc");
    expect(found?.id).toBe(acct.id);
    expect(found?.label).toBe("EcoFund");
  });
});
