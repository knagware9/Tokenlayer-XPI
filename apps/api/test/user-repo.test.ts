import { describe, it, expect } from "vitest";
import { MemoryUserRepository, MemoryAccountRepository } from "../src/persistence/memory.js";

describe("MemoryUserRepository", () => {
  it("creates, finds, lists-by-use-case, updates and removes", async () => {
    const repo = new MemoryUserRepository();
    const a = await repo.create({ email: "a@x.dev", passwordHash: "h", role: "Issuer", useCaseKey: "carbon-credit", accountId: null, active: true });
    await repo.create({ email: "b@x.dev", passwordHash: "h", role: "Trader", useCaseKey: "gold-loan", accountId: null, active: true });
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
    await repo.remove(a.id);
    expect(await repo.findById(a.id)).toBeNull();
  });
});

describe("MemoryAccountRepository", () => {
  it("upserts and finds by id", async () => {
    const repo = new MemoryAccountRepository();
    const acct = await repo.upsert("0xabc", "EcoFund");
    expect((await repo.findById(acct.id))?.label).toBe("EcoFund");
    expect(await repo.findById("nope")).toBeNull();
  });
});
