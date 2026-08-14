import { describe, it, expect } from "vitest";
import { invoiceFingerprint } from "../src/tokenization/invoice-fingerprint.js";

describe("invoiceFingerprint", () => {
  const base = { invoiceNumber: "INV-1", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2026-12-31" };

  it("matches the known canonical SHA-256 of the pipe-joined fields", () => {
    // Precomputed with: printf 'INV-1|JSW STEEL LIMITED|INR|1000000|2026-12-31' | shasum -a 256
    expect(invoiceFingerprint(base)).toBe("0x20aad37e03d52380d9516a668e0fa8879cb7ec322275d39a866d69b04e27e555");
  });

  it("normalizes: trims fields, uppercases buyer/currency, integer-parses the amount", () => {
    const messy = { invoiceNumber: " INV-1 ", buyerName: "jsw steel limited", currency: " inr", amount: "1000000.00", dueDate: "2026-12-31 " };
    expect(invoiceFingerprint(messy)).toBe(invoiceFingerprint(base));
  });

  it("changes when any canonical field changes", () => {
    expect(invoiceFingerprint({ ...base, amount: 1000001 })).not.toBe(invoiceFingerprint(base));
    expect(invoiceFingerprint({ ...base, buyerName: "ITC Limited" })).not.toBe(invoiceFingerprint(base));
  });
});
