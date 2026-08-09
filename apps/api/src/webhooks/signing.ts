/**
 * Delivery signing (EN-C). HMAC-SHA256 over `${timestamp}.${rawBody}` with the
 * endpoint's shared secret, in the Stripe/GitHub shape integrators already know.
 *
 * THE TIMESTAMP IS INSIDE THE SIGNED MATERIAL. Signing the body alone would let
 * anyone who captured one delivery replay it forever against a verifier that
 * checks freshness — the freshness check would itself be unauthenticated, so an
 * attacker would simply re-stamp `t=` to now and re-send the untouched body and
 * signature. Binding `t` into the MAC makes the timestamp as unforgeable as the
 * payload. The "cannot be re-stamped" test pins exactly this.
 *
 * What the tolerance does NOT do is stop a replay INSIDE the window: an attacker
 * who captures a delivery can re-send it verbatim for up to
 * SIGNATURE_TOLERANCE_SECONDS. That is inherent to a stateless MAC and is why
 * every delivery also carries a stable event id — the documented integrator
 * recipe is "verify the signature, then ignore an id you have already seen".
 *
 * `v1=` is a version prefix so the scheme can change without breaking verifiers.
 * A verifier must therefore ignore parameters it does not know rather than
 * assume position — hence the parse below is by name, not by index.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * How far a delivery's timestamp may sit from the verifier's clock, in seconds.
 * Five minutes is the industry-standard figure and it is a CLOCK-SKEW budget,
 * not a security parameter to be tuned down: an integrator whose NTP has drifted
 * two minutes still verifies, and shrinking it mostly produces mystery
 * rejections rather than meaningfully fewer replays.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
}

export function signatureHeader(secret: string, timestampSeconds: number, rawBody: string): string {
  return `t=${timestampSeconds},v1=${signPayload(secret, timestampSeconds, rawBody)}`;
}

/**
 * The recipe we document to integrators, implemented here so OUR OWN tests
 * exercise the same code path a customer will. If this drifts from the docs the
 * tests stop being evidence about anything a customer runs.
 */
export function verifySignature(
  secret: string,
  header: string,
  rawBody: string,
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;

  const parts = new Map<string, string>();
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue; // no name, or an empty name — not a parameter
    parts.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const rawT = parts.get("t");
  const v1 = parts.get("v1");
  // `Number("")` is 0, not NaN, so an empty `t=` would otherwise sail through
  // as a 1970 timestamp and be caught only by the tolerance check below.
  if (!rawT || !v1) return false;
  const t = Number(rawT);
  if (!Number.isFinite(t)) return false;
  if (Math.abs(now - t) > tolerance) return false;

  const expected = Buffer.from(signPayload(secret, t, rawBody), "hex");
  const got = Buffer.from(v1, "hex");
  // Length check first: timingSafeEqual THROWS on a length mismatch, which for a
  // header an attacker controls would turn a false into a 500.
  return expected.length === got.length && timingSafeEqual(expected, got);
}
