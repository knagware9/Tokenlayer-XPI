/**
 * EN-F: rendering a certificate ONTO uploaded artwork.
 *
 * Split in two on purpose. `certificateDrawList` is PURE — no pdfkit, no I/O,
 * no clock — and is where every rule worth testing lives, so "the QR is always
 * present" and "the watermark is drawn last" are assertions over an array
 * instead of attempts to parse a PDF. `drawCertificate` (Task 5) is a dumb
 * adapter that executes ops and does no arithmetic.
 */
import { inflateSync } from "node:zlib";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import {
  AUTO_QR_PLACEMENT,
  DEFAULT_COLOR,
  DEFAULT_FONT_SIZE,
  DEFAULT_QR_WIDTH,
  type CertificateAlign,
  type CertificateFieldPlacement,
  type CertificateFieldRef,
  type CertificateFont,
} from "@tokenlayer/core";

export type DrawOp =
  /** The artwork, filling the page. Geometry only — the bytes travel beside the
   *  list, because a draw list carrying a 5MB buffer is miserable to assert on. */
  | { kind: "image"; x: number; y: number; w: number; h: number }
  | {
      kind: "text"; text: string; x: number; y: number; width: number | null;
      fontSize: number; font: CertificateFont; bold: boolean; color: string; align: CertificateAlign;
    }
  | { kind: "qr"; url: string; x: number; y: number; size: number; caption: string | null }
  | { kind: "watermark"; label: string; detail: string | null }
  | { kind: "sample" };

export interface CertificateDrawListInput {
  placements: readonly CertificateFieldPlacement[];
  values: ReadonlyMap<CertificateFieldRef, string>;
  page: { width: number; height: number };
  statusUrl: string;
  /** From `certificateStatusBanner()`. null for a live, unexpired credential. */
  banner: { label: string; detail: string | null } | null;
  /** Preview render: stamps SAMPLE. */
  sample?: boolean;
}

export function certificateDrawList(input: CertificateDrawListInput): DrawOp[] {
  const { placements, values, page, statusUrl, banner } = input;
  const ops: DrawOp[] = [{ kind: "image", x: 0, y: 0, w: page.width, h: page.height }];

  let placedQr = false;
  for (const p of placements) {
    if (p.field === "qr") {
      // Guarded upstream by validateCertificatePlacements, which allows at most
      // one; this second check keeps the invariant true even if the list
      // reaches here unvalidated (a hand-written config, a future caller).
      if (placedQr) continue;
      placedQr = true;
      const size = (p.width ?? DEFAULT_QR_WIDTH) * page.width;
      // No caption on a PLACED qr: the designer put it exactly there, and a
      // stray "Scan to verify" would land somewhere on their artwork.
      ops.push({ kind: "qr", url: statusUrl, x: p.x * page.width, y: p.y * page.height, size, caption: null });
      continue;
    }
    const text = values.get(p.field);
    // Absent ⇒ draw nothing. A placement for a claim this holder does not carry
    // simply prints nothing, which is the whole of the conditional visibility
    // the design deliberately left out.
    if (text === undefined) continue;
    ops.push({
      kind: "text",
      text,
      x: p.x * page.width,
      y: p.y * page.height,
      // `== null` catches an explicit JSON `null` as well as undefined. With
      // `===` a stored `"width": null` resolved to 0 — a zero-width wrap box,
      // i.e. text wrapped to nothing, which prints as an empty certificate line
      // rather than as the unwrapped default it means. `validateCertificatePlacements`
      // rejects null, so this only bites on the same unvalidated path the
      // duplicate-`qr` guard below was written to survive; defending against
      // one and not the other is the inconsistency, not the defence.
      width: p.width == null ? null : p.width * page.width,
      fontSize: p.fontSize ?? DEFAULT_FONT_SIZE,
      font: p.font ?? "sans",
      bold: p.bold ?? false,
      color: p.color ?? DEFAULT_COLOR,
      align: p.align ?? "left",
    });
  }

  // RULE 1 — A QR IS ALWAYS DRAWN. You choose where; never whether. This route
  // is public and unauthenticated, and a certificate with no path back to its
  // status is an assertion nobody can check.
  if (!placedQr) {
    ops.push({
      kind: "qr",
      url: statusUrl,
      x: AUTO_QR_PLACEMENT.x * page.width,
      y: AUTO_QR_PLACEMENT.y * page.height,
      size: (AUTO_QR_PLACEMENT.width ?? DEFAULT_QR_WIDTH) * page.width,
      caption: "Scan to verify",
    });
  }

  // RULE 3 — a preview is stamped, because the preview route renders arbitrary
  // sample claims through the same code that renders real certificates.
  if (input.sample) ops.push({ kind: "sample" });

  // RULE 2 — the revocation watermark is LAST, over everything, consulting no
  // placement and no config. A certificate that can be designed to hide its own
  // revocation is a forgery kit.
  if (banner) ops.push({ kind: "watermark", label: banner.label, detail: banner.detail });

  return ops;
}

/** pdfkit's standard-14 names for our three families × weight. */
const PDF_FONTS: Record<CertificateFont, { normal: string; bold: string }> = {
  sans: { normal: "Helvetica", bold: "Helvetica-Bold" },
  serif: { normal: "Times-Roman", bold: "Times-Bold" },
  mono: { normal: "Courier", bold: "Courier-Bold" },
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Open the artwork, and prove it can actually be DRAWN — not merely parsed.
 *
 * `openImage` reads a PNG's IHDR and stops; the pixels are inflated much later,
 * while pdfkit flushes the document, inside a zlib callback that `throw`s on a
 * bad stream. That throw surfaces as an uncaughtException — no try/catch around
 * the render and no rejected promise can see it — so a PNG with a valid header
 * and a truncated IDAT (an interrupted upload) would take the API process down
 * on every fetch of a public certificate URL. Inflating here converts that into
 * an ordinary synchronous throw the route can catch and fall back from, which is
 * the whole point of having a fallback.
 */
function openArtwork(bytes: Buffer): { width: number; height: number } {
  // `openImage` is real and public on pdfkit's mixin chain but absent from
  // @types/pdfkit, so the cast is the type gap, not a claim about the value.
  const probe = new PDFDocument({ size: "A4" }) as unknown as {
    openImage(b: Buffer): { width: number; height: number; imgData?: Buffer };
  };
  const img = probe.openImage(bytes);
  // PNG only: a JPEG's `imgData` is the raw scan, not a zlib stream.
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) && Buffer.isBuffer(img.imgData)) inflateSync(img.imgData);
  return img;
}

/**
 * Execute a draw list. NO ARITHMETIC HAPPENS HERE — every coordinate arrived
 * absolute. Throws if the artwork cannot be opened; the route catches that and
 * falls back to the built-in layout, because a deleted document must not turn
 * every certificate for that type into a 500.
 */
export async function drawCertificate(
  ops: readonly DrawOp[],
  artworkBytes: Buffer,
  page: { width: number; height: number },
): Promise<Buffer> {
  // Before anything is emitted, so an undecodable image rejects this promise
  // instead of exploding mid-flush. Callers that already measured pay one extra
  // inflate; a caller that did not would otherwise pay with the process.
  openArtwork(artworkBytes);

  const doc = new PDFDocument({ size: [page.width, page.height], margin: 0 });
  const chunks: Buffer[] = [];
  doc.on("data", (d: Buffer) => chunks.push(d));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // Pre-render QR images: doc.image needs bytes, and QRCode.toBuffer is async
  // while the draw loop below is not.
  const qrPngs = new Map<string, Buffer>();
  for (const op of ops) {
    if (op.kind === "qr" && !qrPngs.has(op.url)) {
      qrPngs.set(op.url, await QRCode.toBuffer(op.url, { type: "png", margin: 1, width: 320 }));
    }
  }

  // In list order, always: the watermark is last because `certificateDrawList`
  // put it last, and reordering or skipping here would undo the one rule config
  // cannot override.
  for (const op of ops) {
    switch (op.kind) {
      case "image":
        doc.image(artworkBytes, op.x, op.y, { width: op.w, height: op.h });
        break;
      case "text": {
        const family = PDF_FONTS[op.font];
        doc.font(op.bold ? family.bold : family.normal).fontSize(op.fontSize).fillColor(op.color);
        // With a width, pdfkit wraps and honours `align` inside the box. Without
        // one, `align` has nothing to align against, so the box is the rest of
        // the page from x — which makes centre/right behave as the designer
        // expects rather than silently doing nothing. The floor keeps a
        // placement pinned at the right edge from asking for a <=0 box.
        const width = op.width ?? Math.max(1, page.width - op.x);
        doc.text(op.text, op.x, op.y, { width, align: op.align, lineBreak: op.width !== null });
        break;
      }
      case "qr": {
        doc.image(qrPngs.get(op.url)!, op.x, op.y, { width: op.size, height: op.size });
        if (op.caption) {
          doc.font("Helvetica").fontSize(8).fillColor("#64748b")
            .text(op.caption, op.x, op.y - 11, { width: op.size, align: "center" });
        }
        break;
      }
      case "sample":
        doc.save().font("Helvetica-Bold").fontSize(Math.max(18, page.width * 0.05)).fillColor("#0ea5e9").opacity(0.35)
          .rotate(-24, { origin: [page.width / 2, page.height / 2] })
          .text("SAMPLE — NOT A CREDENTIAL", 0, page.height / 2 - 24, { width: page.width, align: "center" })
          .restore();
        break;
      case "watermark":
        doc.save().font("Helvetica-Bold").fontSize(Math.max(28, page.width * 0.08)).fillColor("#dc2626").opacity(0.28)
          .rotate(-18, { origin: [page.width / 2, page.height / 2] })
          .text(op.label, 0, page.height / 2 - 30, { width: page.width, align: "center" })
          .restore();
        if (op.detail) {
          doc.opacity(1).font("Helvetica-Bold").fontSize(10).fillColor("#dc2626")
            .text(op.detail, page.width * 0.1, page.height * 0.08, { width: page.width * 0.8, align: "center" });
        }
        break;
    }
  }

  doc.end();
  return done;
}

/**
 * Measure artwork without rendering it. Throws on unusable bytes.
 *
 * The draw list resolves every coordinate against the page it is GIVEN and
 * trusts it, so a page built by hand with a zero or non-finite edge would yield
 * a QR of size 0 — rule 1 satisfied structurally and vacuous in fact, a QR
 * nobody can scan. Every caller must derive the page from THIS measurement via
 * `certificatePageSize`, which guards the degenerate cases.
 */
export function artworkDimensions(bytes: Buffer): { width: number; height: number } {
  const img = openArtwork(bytes);
  return { width: img.width, height: img.height };
}
