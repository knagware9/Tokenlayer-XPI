/**
 * EN-F: the vocabulary for placing credential values onto uploaded certificate
 * artwork. Pure — no rendering, no I/O — because it is shared three ways: the
 * API renderer, the API validator, and (mirrored) the web designer.
 */
import { PolicyError } from "./errors.js";

/** pdfkit's three built-in families. No font pipeline, no licensing question. */
export type CertificateFont = "sans" | "serif" | "mono";
export type CertificateAlign = "left" | "center" | "right";

/**
 * Everything printable that is NOT a claim. Closed on purpose: a designer may
 * place any of these, and nothing else. `qr` is in the list because the QR is
 * PLACEABLE — see `validateCertificatePlacements` for the half of that rule
 * which says it is not REMOVABLE.
 */
export const CERTIFICATE_FIXED_FIELDS = [
  "subject.name",
  "subject.did",
  "credential.id",
  "credential.type",
  "credential.issuedAt",
  "credential.expiresAt",
  "issuer.name",
  "issuer.did",
  // Placeable so a parameterised template heading (`{{orgName}}`) still prints
  // once artwork replaces the built-in layout, instead of becoming dead config.
  "config.heading",
  "config.subheading",
  "qr",
] as const;

export type CertificateFixedField = (typeof CERTIFICATE_FIXED_FIELDS)[number];
export type CertificateFieldRef = CertificateFixedField | `claim:${string}`;

/** Human labels for the designer's palette. Total over the fixed list, so a new
 *  field cannot be added without naming it. */
export const CERTIFICATE_FIELD_LABELS: Record<CertificateFixedField, string> = {
  "subject.name": "Holder name",
  "subject.did": "Holder DID",
  "credential.id": "Credential ID",
  "credential.type": "Credential type",
  "credential.issuedAt": "Issue date",
  "credential.expiresAt": "Expiry date",
  "issuer.name": "Issuer name",
  "issuer.did": "Issuer DID",
  "config.heading": "Heading (from config)",
  "config.subheading": "Subheading (from config)",
  qr: "Verification QR",
};

export interface CertificateFieldPlacement {
  field: CertificateFieldRef;
  /** 0–1 of page width/height. The ANCHOR: `align` picks which edge of the text
   *  sits on `x`, and `y` is the TOP of the text box. */
  x: number;
  y: number;
  /** 0–1 of page width. Text wraps inside it; omitted ⇒ one unwrapped line.
   *  For `qr` this is the square's edge, defaulting to DEFAULT_QR_WIDTH. */
  width?: number;
  fontSize?: number;
  font?: CertificateFont;
  bold?: boolean;
  /** #rrggbb. */
  color?: string;
  align?: CertificateAlign;
}

export const MAX_CERTIFICATE_PLACEMENTS = 40;
export const DEFAULT_QR_WIDTH = 0.14;
export const DEFAULT_FONT_SIZE = 11;
export const DEFAULT_COLOR = "#0f172a";

/** Where the QR lands when the designer placed none. Exported as DATA so the
 *  renderer and its tests cannot disagree about it. */
export const AUTO_QR_PLACEMENT: CertificateFieldPlacement = {
  field: "qr",
  x: 0.82,
  y: 0.82,
  width: DEFAULT_QR_WIDTH,
};

/** A4's long edge in PDF points (297mm). The certificate page keeps this and
 *  derives its short edge from the artwork, so the page IS the artwork. */
export const A4_LONG_EDGE_PT = 841.89;
/** A4's short edge — used only for the degenerate-image fallback. */
export const A4_SHORT_EDGE_PT = 595.28;

export function isClaimRef(field: string): field is `claim:${string}` {
  return field.startsWith("claim:");
}

export function claimKeyOf(field: `claim:${string}`): string {
  return field.slice("claim:".length);
}

/**
 * The page from the artwork's pixel dimensions: A4's long edge, the short edge
 * scaled to the image's aspect, orientation following the image. One coordinate
 * space, no letterboxing.
 *
 * A degenerate image (a zero or non-finite dimension) would divide to NaN and
 * produce an unopenable PDF, so it falls back to A4 portrait — the same page the
 * built-in renderer uses.
 */
export function certificatePageSize(imageWidth: number, imageHeight: number): { width: number; height: number } {
  const w = Number(imageWidth);
  const h = Number(imageHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { width: A4_SHORT_EDGE_PT, height: A4_LONG_EDGE_PT };
  }
  const short = A4_LONG_EDGE_PT * (Math.min(w, h) / Math.max(w, h));
  return w >= h ? { width: A4_LONG_EDGE_PT, height: short } : { width: short, height: A4_LONG_EDGE_PT };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const FONTS: readonly string[] = ["sans", "serif", "mono"];
const ALIGNS: readonly string[] = ["left", "center", "right"];

/**
 * Throws PolicyError("INVALID_CERTIFICATE_PLACEMENT") on any structural problem.
 *
 * A DISTINCT CODE from the surrounding INVALID_USECASE, deliberately: "your
 * chip is off the page" and "your use case is malformed" have different fixes,
 * and the message names the credential type AND the index so the designer can
 * be told which chip to move.
 *
 * `undefined` is valid (no placements) and so is `[]`.
 */
export function validateCertificatePlacements(
  placements: unknown,
  claimKeys: readonly string[],
  credentialTypeName: string,
): void {
  if (placements === undefined) return;
  const fail = (msg: string): never => {
    throw new PolicyError("INVALID_CERTIFICATE_PLACEMENT", `credential type '${credentialTypeName}' ${msg}`);
  };
  if (!Array.isArray(placements)) fail("certificate.placements must be an array");
  const list = placements as unknown[];
  if (list.length > MAX_CERTIFICATE_PLACEMENTS) {
    fail(`certificate.placements has ${list.length} entries; at most ${MAX_CERTIFICATE_PLACEMENTS} are allowed`);
  }

  const fixed = new Set<string>(CERTIFICATE_FIXED_FIELDS);
  const claims = new Set(claimKeys);
  let qrCount = 0;

  list.forEach((raw, i) => {
    const at = (msg: string): never => fail(`certificate.placements[${i}] ${msg}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) at("must be an object");
    const p = raw as Record<string, unknown>;

    if (typeof p.field !== "string") at("field must be a string");
    const field = p.field as string;
    if (isClaimRef(field)) {
      const key = claimKeyOf(field as `claim:${string}`);
      if (!claims.has(key)) at(`references unknown claim '${key}'`);
    } else if (!fixed.has(field)) {
      at(`references unknown field '${field}'`);
    }
    if (field === "qr") qrCount += 1;

    for (const axis of ["x", "y"] as const) {
      const v = p[axis];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) at(`${axis} must be a number between 0 and 1`);
    }
    if (p.width !== undefined) {
      const v = p.width;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1) at("width must be a number greater than 0 and at most 1");
    }
    if (p.fontSize !== undefined) {
      const v = p.fontSize;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 4 || v > 96) at("fontSize must be a number between 4 and 96");
    }
    if (p.font !== undefined && !FONTS.includes(p.font as string)) at(`font must be one of: ${FONTS.join(", ")}`);
    if (p.align !== undefined && !ALIGNS.includes(p.align as string)) at(`align must be one of: ${ALIGNS.join(", ")}`);
    if (p.bold !== undefined && typeof p.bold !== "boolean") at("bold must be a boolean");
    if (p.color !== undefined && (typeof p.color !== "string" || !HEX_COLOR.test(p.color))) at("color must be a #rrggbb hex string");
  });

  // Duplicate CLAIMS are fine (a name may print twice). A second QR is not:
  // the renderer guarantees exactly one, and two placements would silently
  // make one of them a lie about where verification lives.
  if (qrCount > 1) fail("certificate.placements may contain at most one 'qr'");
}
