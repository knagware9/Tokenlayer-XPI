import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { invoiceFingerprint, validateMetadata, type UseCaseDefinition } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import type { InvoiceSource, StagedInvoiceRecord } from "../persistence/types.js";

const ERP_CSV = fileURLToPath(new URL("../../../../samples/erp/invoices.csv", import.meta.url));

// The ERP CSV's human-readable headers are NOT the invoice metadata field names;
// map each to the key the invoice metadataSchema expects (mirrors erp-import.mjs).
const HEADER_MAP: Record<string, string> = {
  "invoice no": "invoiceNumber",
  "invoice date": "invoiceDate",
  "buyer name": "buyerName",
  currency: "currency",
  amount: "amount",
  "due date": "dueDate",
  status: "status",
};

/** Read the bundled ERP CSV into invoice metadata rows (header-mapped). */
export function readErpInvoices(): Record<string, unknown>[] {
  const text = readFileSync(ERP_CSV, "utf8").trim();
  const [head = "", ...lines] = text.split(/\r?\n/);
  const cols = head.split(",").map((c) => HEADER_MAP[c.trim().toLowerCase()] ?? c.trim());
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(",");
    const rec: Record<string, unknown> = {};
    cols.forEach((c, i) => { rec[c] = cells[i]?.trim(); });
    if (rec.amount !== undefined) rec.amount = Number(rec.amount);
    return rec;
  });
}

/** Validate + fingerprint + dedupe one row → a staged record or a rejection reason. */
export async function stageInvoice(
  deps: AppDeps, useCase: UseCaseDefinition, actorId: string, source: InvoiceSource,
  metadata: Record<string, unknown>, doc: { id: string; sha256: string } | null,
): Promise<{ status: "staged"; record: StagedInvoiceRecord } | { status: "duplicate" | "invalid"; error: string }> {
  try {
    validateMetadata(metadata, useCase.metadataSchema);
  } catch (err) {
    return { status: "invalid", error: (err as Error).message };
  }
  const invoiceHash = invoiceFingerprint(metadata as unknown as Parameters<typeof invoiceFingerprint>[0]);
  if (await deps.stagedInvoices.findByHash(useCase.key, invoiceHash)) return { status: "duplicate", error: "already staged" };
  if (useCase.uniqueBy && (await deps.assets.findByMetadata(useCase.key, useCase.uniqueBy, invoiceHash))) {
    return { status: "duplicate", error: "already tokenized" };
  }
  const record = await deps.stagedInvoices.create({
    useCaseKey: useCase.key, source, metadata, invoiceHash,
    documentId: doc?.id ?? null, documentSha256: doc?.sha256 ?? null,
    status: "staged", assetId: null, createdBy: actorId, tokenizedAt: null,
  });
  return { status: "staged", record };
}
