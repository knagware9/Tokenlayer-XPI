import { createHash } from "node:crypto";

/** Canonical invoice identity fields (the ERP invoice template: Invoice No,
 * Buyer Name, Currency, Amount, Due Date). */
export interface InvoiceFingerprintInput {
  invoiceNumber: string | number;
  buyerName: string;
  currency: string;
  amount: string | number;
  dueDate: string;
}

/**
 * Canonical, normalization-stable fingerprint of an invoice. MUST stay
 * byte-identical to scripts/erp-import.mjs and the web computeFingerprint so the
 * same invoice hashes the same across every ingestion channel.
 */
export function invoiceFingerprint(inv: InvoiceFingerprintInput): string {
  const canonical = [
    String(inv.invoiceNumber).trim(),
    String(inv.buyerName).trim().toUpperCase(),
    String(inv.currency).trim().toUpperCase(),
    String(parseInt(String(inv.amount), 10)),
    String(inv.dueDate).trim(),
  ].join("|");
  return "0x" + createHash("sha256").update(canonical, "utf8").digest("hex");
}
