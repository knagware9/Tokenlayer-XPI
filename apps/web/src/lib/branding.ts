/**
 * EN-E: turning one accent colour into the six-stop `brand-*` scale the app
 * already uses, and refusing to produce an unreadable one.
 *
 * Lives here rather than in `@tokenlayer/core` because the accent never leaves
 * the browser: the API stores a hex string and the certificate PDF uses the
 * LOGO, not the accent. One consumer, so no hand-copied mirror — the pattern
 * that has already drifted twice in this codebase.
 *
 * Values are emitted as `"r g b"` triples, not `#rrggbb`, because they are
 * assigned to CSS custom properties consumed by `rgb(var(--brand-600) / <alpha>)`.
 * Tailwind's alpha modifiers stop working if the variable carries a `#`.
 */

/** The stops `tailwind.config.js` declares. Ordered light → dark. */
export const BRAND_STOPS = [50, 100, 400, 500, 600, 700] as const;
export type BrandStop = (typeof BRAND_STOPS)[number];

const hex = (v: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
const toTriple = (rgb: [number, number, number]): string => rgb.map(clamp255).join(" ");
const toHex = (rgb: [number, number, number]): string => `#${rgb.map((n) => clamp255(n).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance. */
export function relativeLuminance(color: string): number {
  const [r, g, b] = hex(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, symmetric in its arguments. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const WHITE = "#ffffff";
const AA = 4.5;

/**
 * Darken until white text on this colour clears WCAG AA.
 *
 * Applied at RENDER, never at save: the stored value stays the colour the
 * OrgAdmin chose, so their picker never disagrees with what they saved.
 *
 * Multiplies each channel rather than desaturating, so a pale green darkens to
 * a deep green instead of sliding to grey — an org should still recognise it.
 * Bounded to 60 steps, which reaches black from white long before it runs out.
 */
export function clampAccent(accent: string): string {
  let rgb = hex(accent);
  for (let i = 0; i < 60 && contrastRatio(toHex(rgb), WHITE) < AA; i++) {
    rgb = rgb.map((c) => c * 0.9) as [number, number, number];
    if (rgb.every((c) => c < 1)) return "#000000";
  }
  return toHex(rgb);
}

/**
 * The six stops. 500 is the clamped accent itself; lighter stops mix toward
 * white and darker ones toward black, by fixed ratios chosen so the result is
 * MONOTONIC in lightness — a scale where 400 is darker than 500 produces a
 * hover state that looks broken.
 */
export function brandRamp(accent: string): Record<BrandStop, string> {
  const base = hex(clampAccent(accent));
  const mix = (target: 0 | 255, amount: number): string =>
    toTriple(base.map((c) => c + (target - c) * amount) as [number, number, number]);
  return {
    50: mix(255, 0.92),
    100: mix(255, 0.82),
    400: mix(255, 0.22),
    500: toTriple(base),
    600: mix(0, 0.22),
    700: mix(0, 0.42),
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The custom properties a branded shell sets, or `{}` for an unbranded session.
 *
 * Returns `{}` rather than throwing on a malformed accent: the API validates on
 * save, so a bad value here means a stale session or a hand-edited store, and
 * blanking somebody's palette over it would be the wrong failure.
 */
export function brandCssVars(accent: string | null | undefined): Record<string, string> {
  if (!accent || !HEX.test(accent)) return {};
  const ramp = brandRamp(accent);
  return Object.fromEntries(BRAND_STOPS.map((s) => [`--brand-${s}`, ramp[s]]));
}
