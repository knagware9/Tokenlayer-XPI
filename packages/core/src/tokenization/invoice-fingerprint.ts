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

/**
 * Generic staging fingerprint for a use case with no special-cased fingerprint
 * of its own (every use case except the canonical invoice one — see
 * `stageInvoice`, which picks between the two). Sorted-key JSON over the whole
 * metadata object, so the same values hash the same regardless of field order.
 * Not normalization-aware the way `invoiceFingerprint` is (no case-folding, no
 * numeric parsing) — good enough to catch an exact re-upload, not a fuzzy
 * near-duplicate.
 */
export function genericMetadataFingerprint(metadata: Record<string, unknown>): string {
  const sorted = Object.keys(metadata).sort().reduce<Record<string, unknown>>((acc, k) => {
    acc[k] = metadata[k];
    return acc;
  }, {});
  return "0x" + createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex");
}
