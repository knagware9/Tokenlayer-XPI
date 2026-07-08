import { describe, it, expect } from "vitest";
import { computeCashflowSchedule, splitProRata } from "../src/cashflows.js";

const TERMS = { principalField: "amountInr", maturityField: "dueDate", currency: "CBDC-INR" } as const;

describe("computeCashflowSchedule", () => {
  it("atMaturity → a single redemption row of the principal at the maturity date", () => {
    const rows = computeCashflowSchedule({ ...TERMS }, { amountInr: 1_000_000, dueDate: "2026-12-31" }, "2026-07-08T00:00:00.000Z");
    expect(rows).toEqual([{ seq: 1, kind: "redemption", dueDate: "2026-12-31", amount: "1000000" }]);
  });

  it("returns [] when the principal or maturity metadata field is absent (terms inapplicable)", () => {
    expect(computeCashflowSchedule({ ...TERMS }, { amountInr: 1_000_000 }, "2026-07-08T00:00:00.000Z")).toEqual([]);
    expect(computeCashflowSchedule({ ...TERMS }, { dueDate: "2026-12-31" }, "2026-07-08T00:00:00.000Z")).toEqual([]);
  });

  it("throws INVALID_TERMS for a non-positive principal or unparseable maturity", () => {
    expect(() => computeCashflowSchedule({ ...TERMS }, { amountInr: 0, dueDate: "2026-12-31" }, "2026-07-08T00:00:00.000Z")).toThrow(/INVALID_TERMS|positive/);
    expect(() => computeCashflowSchedule({ ...TERMS }, { amountInr: 100, dueDate: "not-a-date" }, "2026-07-08T00:00:00.000Z")).toThrow(/INVALID_TERMS|date/);
  });

  it("does not clamp the coupon rate: 150% p.a. for a full year may exceed the principal", () => {
    // Issued 2026-01-01, matures 2027-01-01 (365 days); annual frequency → one stub coupon.
    const rows = computeCashflowSchedule(
      { ...TERMS, principalField: "faceValue", maturityField: "maturityDate", rateField: "couponRate", frequency: "annual" },
      { faceValue: 100_000, maturityDate: "2027-01-01", couponRate: 150 },
      "2026-01-01T00:00:00.000Z",
    );
    // bp = round(150 × 365 / 365 × 100) = 15000 → 100,000 × 15000 / 10000 = 150,000 (> principal).
    expect(rows.map((r) => r.kind)).toEqual(["coupon", "redemption"]);
    expect(rows[0]!.amount).toBe("150000");
    expect(rows[1]!.amount).toBe("100000");
  });

  it("quarterly → coupons stepping from issue, a final stub coupon, then redemption at maturity", () => {
    // Issued 2026-01-15, matures 2026-12-31, 10% p.a. on 1,000,000.
    const rows = computeCashflowSchedule(
      { ...TERMS, principalField: "faceValue", maturityField: "maturityDate", rateField: "couponRate", frequency: "quarterly" },
      { faceValue: 1_000_000, maturityDate: "2026-12-31", couponRate: 10 },
      "2026-01-15T00:00:00.000Z",
    );
    // Coupon dates: 04-15, 07-15, 10-15 (strictly before maturity) + stub coupon 12-31 + redemption 12-31.
    expect(rows.map((r) => `${r.kind}:${r.dueDate}`)).toEqual([
      "coupon:2026-04-15", "coupon:2026-07-15", "coupon:2026-10-15", "coupon:2026-12-31", "redemption:2026-12-31",
    ]);
    // Q1 = 90 days: bp = round(10 × 90 / 365 × 100) = 247 → 1,000,000 × 247 / 10000 = 24,700.
    expect(rows[0]!.amount).toBe("24700");
    expect(rows.at(-1)!.amount).toBe("1000000");
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("splitProRata", () => {
  it("splits by balance with BigInt floor; dust is NOT distributed", () => {
    const out = splitProRata(1_000_000n, new Map([["a", 4000n], ["b", 1000n], ["t", 5000n]]));
    expect(out.get("a")).toBe(400000n);
    expect(out.get("b")).toBe(100000n);
    expect(out.get("t")).toBe(500000n);
  });
  it("floors odd splits (dust stays with the payer)", () => {
    const out = splitProRata(100n, new Map([["a", 1n], ["b", 1n], ["c", 1n]]));
    expect([...out.values()].reduce((s, v) => s + v, 0n)).toBe(99n); // 33+33+33; 1 dust undistributed
  });
  it("ignores zero/negative balances and returns empty on zero supply or total", () => {
    expect(splitProRata(100n, new Map([["a", 0n]])).size).toBe(0);
    expect(splitProRata(0n, new Map([["a", 5n]])).size).toBe(0);
  });
});
