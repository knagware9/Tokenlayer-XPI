import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { certificateSubjectName } from "./certificate-fields.js";
import type { CredentialRecord } from "../persistence/types/index.js";
import type { CredentialTypeSpec } from "@tokenlayer/core";

export interface CertificateStatus { revoked: boolean; revokedAt: string | null; revokedReason: string | null; }

/** The prominent banner to stamp, or null when the credential is live & unexpired. */
export function certificateStatusBanner(
  input: { status: CertificateStatus; expiresAt: string | null; nowMs: number },
): { label: string; detail: string | null } | null {
  if (input.status.revoked)
    return { label: "REVOKED", detail: input.status.revokedReason ? `Revoked: ${input.status.revokedReason}` : "This credential has been revoked." };
  if (input.expiresAt && Date.parse(input.expiresAt) < input.nowMs)
    return { label: "EXPIRED", detail: `Expired on ${new Date(input.expiresAt).toLocaleDateString()}` };
  return null;
}

/** Turn a claim key into a human label (camelCase / snake / kebab → Title Case). */
export function humanizeKey(k: string): string {
  return k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface RenderCertificateInput {
  credential: CredentialRecord;
  spec: CredentialTypeSpec;
  issuerName: string | null;
  statusUrl: string;
  status: CertificateStatus;
  logoBytes: Buffer | null;
  nowMs: number;
}

export async function renderCredentialCertificate(input: RenderCertificateInput): Promise<Buffer> {
  const { credential: c, spec, issuerName, statusUrl, logoBytes } = input;
  const cert = spec.certificate;
  const heading = cert?.heading?.trim() || spec.title;
  const claims = (c.subjectClaims ?? {}) as Record<string, unknown>;
  const orderedKeys = (cert?.claimOrder && cert.claimOrder.length ? cert.claimOrder : Object.keys(spec.claimSchema.properties))
    .filter((k) => k !== "id" && k in claims);
  const descOf = (k: string): string => {
    const p = spec.claimSchema.properties[k] as { description?: string } | undefined;
    return p?.description?.trim() || humanizeKey(k);
  };
  const banner = certificateStatusBanner({ status: input.status, expiresAt: c.expiresAt, nowMs: input.nowMs });
  const qrPng = await QRCode.toBuffer(statusUrl, { type: "png", margin: 1, width: 160 });

  const doc = new PDFDocument({ size: "A4", margin: 56 });
  const chunks: Buffer[] = [];
  doc.on("data", (d: Buffer) => chunks.push(d));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  if (logoBytes) { try { doc.image(logoBytes, doc.page.width / 2 - 40, 48, { fit: [80, 80], align: "center" }); doc.moveDown(4); } catch { /* ignore bad image */ } }
  doc.moveDown(logoBytes ? 3 : 1);
  doc.fontSize(22).font("Helvetica-Bold").fillColor("#0f172a").text(heading, { align: "center" });
  if (cert?.subheading?.trim()) doc.moveDown(0.2).fontSize(12).font("Helvetica").text(cert.subheading.trim(), { align: "center" });
  doc.moveDown(1).fontSize(11).font("Helvetica").fillColor("#334155").text("This certifies that", { align: "center" });
  const subjectName = certificateSubjectName(c);
  doc.moveDown(0.3).fontSize(16).font("Helvetica-Bold").fillColor("#0f172a").text(String(subjectName), { align: "center" });
  doc.moveDown(1);

  doc.fillColor("#0f172a");
  for (const k of orderedKeys) {
    doc.fontSize(10).font("Helvetica-Bold").text(`${descOf(k)}: `, { continued: true }).font("Helvetica").text(String(claims[k]));
  }
  doc.moveDown(1);
  doc.fontSize(9).fillColor("#475569").font("Helvetica")
    .text(`Issuer: ${issuerName ?? c.issuerDid}`)
    .text(`Issuer DID: ${c.issuerDid}`)
    .text(`Credential type: ${spec.title}`)
    .text(`Issued: ${new Date(c.issuedAt).toLocaleDateString()}`)
    .text(`Expires: ${c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "No expiry"}`)
    .text(`Credential ID: ${c.id}`);

  doc.image(qrPng, doc.page.width - 56 - 96, doc.page.height - 56 - 96, { width: 96 });
  doc.fontSize(8).fillColor("#64748b").text("Scan to verify", doc.page.width - 56 - 96, doc.page.height - 56 - 96 - 12, { width: 96, align: "center" });
  doc.fontSize(7).fillColor("#94a3b8").text(statusUrl, 56, doc.page.height - 56 - 12, { width: doc.page.width - 112 });

  if (banner) {
    doc.save().fontSize(48).font("Helvetica-Bold").fillColor("#dc2626").opacity(0.28)
      .rotate(-18, { origin: [doc.page.width / 2, doc.page.height / 2] })
      .text(banner.label, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: "center" }).restore();
    if (banner.detail) doc.opacity(1).fillColor("#dc2626").fontSize(10).font("Helvetica-Bold").text(banner.detail, 56, 120, { width: doc.page.width - 112, align: "center" });
  }

  doc.end();
  return done;
}
