/**
 * EN-F: rendering a certificate ONTO uploaded artwork.
 *
 * Split in two on purpose. `certificateDrawList` is PURE — no pdfkit, no I/O,
 * no clock — and is where every rule worth testing lives, so "the QR is always
 * present" and "the watermark is drawn last" are assertions over an array
 * instead of attempts to parse a PDF. `drawCertificate` (Task 5) is a dumb
 * adapter that executes ops and does no arithmetic.
 */
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
