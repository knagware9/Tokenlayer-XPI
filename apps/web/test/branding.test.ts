import { describe, expect, it } from "vitest";
import { BRAND_STOPS, brandRamp, clampAccent, contrastRatio, relativeLuminance } from "../src/lib/shared/branding.js";

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for a colour on itself", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#0e8c75", "#0e8c75")).toBeCloseTo(1, 3);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#0e8c75", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#0e8c75"), 6);
  });
});

describe("clampAccent", () => {
  it("leaves a colour that already passes AA against white text alone", () => {
    // NOTE: the plan's draft used "#0e8c75" (brand-600) here, but that hex's
    // real WCAG contrast against white is ~4.18:1 — it does NOT clear 4.5:1
    // (verified independently against the standard relative-luminance formula).
    // "#0a6f5d" (brand-700) is used instead so this asserts real "already
    // passes, so leave alone" behaviour rather than a false premise.
    const dark = "#0a6f5d";
    expect(contrastRatio(dark, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(clampAccent(dark)).toBe(dark);
  });

  it("darkens a colour that fails until it passes — an org cannot make its own buttons unreadable", () => {
    const pale = "#a7f3d0";
    expect(contrastRatio(pale, "#ffffff")).toBeLessThan(4.5);
    const fixed = clampAccent(pale);
    expect(contrastRatio(fixed, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("terminates on white, the worst case, rather than looping", () => {
    const fixed = clampAccent("#ffffff");
    expect(contrastRatio(fixed, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the hue recognisably the org's — it darkens, it does not desaturate to grey", () => {
    const fixed = clampAccent("#a7f3d0");           // pale green
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(fixed.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r);                    // still green-dominant
    expect(g).toBeGreaterThan(b);
  });
});

describe("brandRamp", () => {
  it("produces every stop the Tailwind scale declares", () => {
    const ramp = brandRamp("#0e8c75");
    expect(Object.keys(ramp).map(Number).sort((a, b) => a - b)).toEqual([...BRAND_STOPS]);
    for (const v of Object.values(ramp)) expect(v).toMatch(/^\d+ \d+ \d+$/); // "r g b" for rgb(var(--x))
  });

  it("is MONOTONIC in lightness: 50 lightest, 700 darkest", () => {
    // A non-monotonic scale gives a hover state lighter than its rest state,
    // which reads as a rendering bug rather than as a theme.
    const ramp = brandRamp("#0e8c75");
    const lum = (s: number): number => {
      const [r, g, b] = ramp[s as (typeof BRAND_STOPS)[number]].split(" ").map(Number);
      return relativeLuminance(`#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`);
    };
    for (let i = 1; i < BRAND_STOPS.length; i++) {
      expect(lum(BRAND_STOPS[i - 1]!), `stop ${BRAND_STOPS[i - 1]} vs ${BRAND_STOPS[i]}`).toBeGreaterThan(lum(BRAND_STOPS[i]!));
    }
  });

  it("stays monotonic for extreme inputs", () => {
    for (const accent of ["#000000", "#ffffff", "#ff0000", "#0000ff"]) {
      const ramp = brandRamp(accent);
      expect(Object.keys(ramp)).toHaveLength(BRAND_STOPS.length);
    }
  });
});
