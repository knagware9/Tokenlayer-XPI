/**
 * EN-E: the ONE piece of branding logic the API needs.
 *
 * The ramp and the contrast clamp deliberately live in `apps/web/src/lib/branding.ts`
 * instead. The accent never leaves the browser — the API stores a string, and the
 * certificate PDF uses the LOGO, not the accent — so they have exactly one
 * consumer, and putting them here would create a third hand-copied mirror in
 * `apps/web/src/types.ts`. That pattern has already drifted twice.
 */
import { PolicyError } from "./errors.js";

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Normalize an accent to lowercase `#rrggbb`, or throw.
 *
 * Six digits only: three-digit shorthand would have to be expanded somewhere,
 * and "somewhere" becomes two implementations that disagree about `#abc`.
 */
export function validateBrandAccent(value: unknown): string {
  if (typeof value !== "string" || !HEX.test(value)) {
    throw new PolicyError("INVALID_BRAND_ACCENT", "brandAccent must be a #rrggbb hex colour");
  }
  return value.toLowerCase();
}
