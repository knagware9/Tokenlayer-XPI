import { describe, it, expect } from "vitest";
import { invoiceFingerprint } from "../src/invoice-fingerprint.js";

describe("invoiceFingerprint", () => {
  const base = { invoiceNumber: "INV-1", sellerGstin: "27AAECS1234F1Z5", buyerGstin: "29AABCU9876R1Z3", amountInr: 1000000, dueDate: "2026-12-31" };

  it("matches the known canonical SHA-256 of the pipe-joined fields", () => {
    // Precomputed with: printf 'INV-1|27AAECS1234F1Z5|29AABCU9876R1Z3|1000000|2026-12-31' | shasum -a 256
    expect(invoiceFingerprint(base)).toBe("0xf1981bbf0cf9edb3a745ded5b64b9f0390d2a5558071c89d5e2696965d2dbd97");
  });

  it("normalizes: trims fields, uppercases GSTINs, integer-parses the amount", () => {
    const messy = { invoiceNumber: " INV-1 ", sellerGstin: "27aaecs1234f1z5", buyerGstin: " 29AABCU9876R1Z3", amountInr: "1000000.00", dueDate: "2026-12-31 " };
    expect(invoiceFingerprint(messy)).toBe(invoiceFingerprint(base));
  });

  it("changes when any canonical field changes", () => {
    expect(invoiceFingerprint({ ...base, amountInr: 1000001 })).not.toBe(invoiceFingerprint(base));
  });
});
