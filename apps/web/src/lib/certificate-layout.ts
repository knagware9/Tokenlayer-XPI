/**
 * EN-F: the certificate designer's arithmetic, extracted from the component.
 *
 * apps/web has no DOM test environment (see apps/web/test/*), so the rules that
 * matter — what the palette offers, where a new chip lands, and above all that
 * a drag is CLAMPED to the page — live here and are unit-tested. The component
 * renders and delegates.
 */
import {
  CERTIFICATE_FIELD_LABELS,
  CERTIFICATE_FIXED_FIELDS,
  DEFAULT_QR_WIDTH,
  MAX_CERTIFICATE_PLACEMENTS,
  type CertificateFieldPlacement,
  type CertificateFieldRef,
  type CertificateFixedField,
} from "../types.js";

/** Just the part of a DOMRect this module needs, so tests need no DOM. */
export interface CanvasBox { left: number; top: number; width: number; height: number }
export interface PointerAt { clientX: number; clientY: number }

export function fieldLabel(field: CertificateFieldRef): string {
  return field.startsWith("claim:")
    ? field.slice("claim:".length)
    : CERTIFICATE_FIELD_LABELS[field as CertificateFixedField];
}

/**
 * Claims first (they are what an issuer is actually placing), then the fixed
 * fields. The QR is withdrawn once one is placed — the server allows at most
 * one, and offering a second would build a config that 400s on save.
 *
 * A CLAIM is never withdrawn: the same value may legitimately print twice, e.g.
 * a name in the body and again on a signature line.
 */
export function paletteFields(
  claimKeys: readonly string[],
  placements: readonly CertificateFieldPlacement[],
): CertificateFieldRef[] {
  const hasQr = placements.some((p) => p.field === "qr");
  return [
    ...claimKeys.map((k) => `claim:${k}` as CertificateFieldRef),
    ...CERTIFICATE_FIXED_FIELDS.filter((f) => f !== "qr" || !hasQr),
  ];
}

/** Add at the canvas centre. Refuses past the server-side cap. */
export function addPlacement(
  placements: readonly CertificateFieldPlacement[],
  field: CertificateFieldRef,
): CertificateFieldPlacement[] {
  if (placements.length >= MAX_CERTIFICATE_PLACEMENTS) return [...placements];
  return [
    ...placements,
    { field, x: 0.5, y: 0.5, ...(field === "qr" ? { width: DEFAULT_QR_WIDTH } : {}) },
  ];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Pointer → normalized coordinates, CLAMPED to [0,1].
 *
 * The clamp is the load-bearing part: `validateCertificatePlacements` rejects
 * anything outside the page, so an unclamped drag past the edge would build a
 * design that cannot be saved — and the failure would arrive minutes later on
 * the save button rather than at the drag.
 *
 * A zero-sized box (the image has not loaded) would divide to Infinity, so it
 * returns the input untouched.
 */
export function movePlacement(
  placements: readonly CertificateFieldPlacement[],
  index: number,
  at: PointerAt,
  box: CanvasBox,
): CertificateFieldPlacement[] {
  if (!(box.width > 0) || !(box.height > 0)) return [...placements];
  return placements.map((p, i) =>
    i === index
      ? { ...p, x: clamp01((at.clientX - box.left) / box.width), y: clamp01((at.clientY - box.top) / box.height) }
      : p,
  );
}

export function removePlacement(
  placements: readonly CertificateFieldPlacement[],
  index: number,
): CertificateFieldPlacement[] {
  return placements.filter((_, i) => i !== index);
}

const CLAIM_PREFIX = "claim:";
const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 96;

/**
 * The size box's raw string → a size the server accepts, or `undefined` for
 * "no override" (the renderer then uses its own default).
 *
 * `<input type="number" min={4} max={96}>` does NOT stop an out-of-range value
 * reaching `onChange` — those attributes gate native FORM validation, which
 * this panel never runs. So the clamp has to be here, for the same reason the
 * drag clamp is: the server rejects fontSize outside 4–96, and without this the
 * refusal lands on the save button long after the keystroke that caused it.
 *
 * A CLEARED box is `undefined`, not 0. `Number("")` is 0, which the server
 * rejects; absent is valid and means exactly what clearing the box looks like.
 */
export function clampFontSize(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v)) return undefined;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, v));
}

/**
 * The claim keys these placements reference that the schema no longer defines.
 *
 * The palette is built from the credential type's claim fields, but those stay
 * editable after a field has been placed — rename or delete one and its
 * placement is left pointing at a claim that does not exist, which the server
 * rejects ("references unknown claim"). Fixed fields are never stale: they
 * exist independently of the schema.
 */
export function stalePlacementFields(
  placements: readonly CertificateFieldPlacement[],
  claimKeys: readonly string[],
): string[] {
  const known = new Set(claimKeys);
  const stale: string[] = [];
  for (const p of placements) {
    if (!p.field.startsWith(CLAIM_PREFIX)) continue;
    const key = p.field.slice(CLAIM_PREFIX.length);
    if (!known.has(key) && !stale.includes(key)) stale.push(key);
  }
  return stale;
}

/**
 * The placements minus the stale ones — what actually gets saved or previewed.
 *
 * A placement whose claim no longer exists could not print anything anyway, so
 * dropping it changes no output; what it changes is that the request succeeds
 * instead of 400-ing. The designer shows a warning naming them, so this is
 * never the user's first news of it.
 */
export function withoutStalePlacements(
  placements: readonly CertificateFieldPlacement[],
  claimKeys: readonly string[],
): CertificateFieldPlacement[] {
  const known = new Set(claimKeys);
  return placements.filter((p) => !p.field.startsWith(CLAIM_PREFIX) || known.has(p.field.slice(CLAIM_PREFIX.length)));
}
