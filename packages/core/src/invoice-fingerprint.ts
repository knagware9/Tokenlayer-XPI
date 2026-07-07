import { createHash } from "node:crypto";

export interface InvoiceFingerprintInput {
  invoiceNumber: string | number;
  sellerGstin: string;
  buyerGstin: string;
  amountInr: string | number;
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
    String(inv.sellerGstin).trim().toUpperCase(),
    String(inv.buyerGstin).trim().toUpperCase(),
    String(parseInt(String(inv.amountInr), 10)),
    String(inv.dueDate).trim(),
  ].join("|");
  return "0x" + createHash("sha256").update(canonical, "utf8").digest("hex");
}
