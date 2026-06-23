import { describe, it, expect } from "vitest";
import { MemoryCashRepository } from "../src/persistence/memory.js";

describe("MemoryCashRepository", () => {
  it("credits and reports balances", async () => {
    const cash = new MemoryCashRepository();
    await cash.credit("CBDC-INR", "0xA", "100");
    await cash.credit("CBDC-INR", "0xA", "50");
    expect(await cash.balanceOf("CBDC-INR", "0xA")).toBe("150");
    expect(await cash.balanceOf("CBDC-INR", "0xB")).toBe("0");
  });
  it("transfers between addresses", async () => {
    const cash = new MemoryCashRepository();
    await cash.credit("CBDC-INR", "0xA", "100");
    await cash.transfer("CBDC-INR", "0xA", "0xB", "30");
    expect(await cash.balanceOf("CBDC-INR", "0xA")).toBe("70");
    expect(await cash.balanceOf("CBDC-INR", "0xB")).toBe("30");
  });
  it("rejects an overdraft with INSUFFICIENT_FUNDS", async () => {
    const cash = new MemoryCashRepository();
    await cash.credit("CBDC-INR", "0xA", "10");
    await expect(cash.transfer("CBDC-INR", "0xA", "0xB", "20")).rejects.toThrow(/INSUFFICIENT_FUNDS/);
  });
  it("lists all currency balances for an address", async () => {
    const cash = new MemoryCashRepository();
    await cash.credit("CBDC-INR", "0xA", "100");
    await cash.credit("USDC", "0xA", "5");
    const list = await cash.balancesOf("0xA");
    expect(list).toEqual(expect.arrayContaining([
      { currency: "CBDC-INR", address: "0xA", amount: "100" },
      { currency: "USDC", address: "0xA", amount: "5" },
    ]));
  });
});
