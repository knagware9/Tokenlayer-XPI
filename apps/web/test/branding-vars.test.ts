import { describe, expect, it } from "vitest";
import { brandCssVars } from "../src/lib/branding.js";

describe("brandCssVars", () => {
  it("returns nothing for a session with no accent — the platform palette stands", () => {
    expect(brandCssVars(null)).toEqual({});
    expect(brandCssVars(undefined)).toEqual({});
  });

  it("returns one custom property per stop for a branded session", () => {
    const vars = brandCssVars("#0e8c75");
    expect(Object.keys(vars).sort()).toEqual(
      ["--brand-100", "--brand-400", "--brand-50", "--brand-500", "--brand-600", "--brand-700"],
    );
    for (const v of Object.values(vars)) expect(v).toMatch(/^\d+ \d+ \d+$/);
  });

  it("ignores a malformed accent rather than emitting broken CSS", () => {
    // The API validates on save, but a stale session or a hand-edited store
    // must not be able to blank the palette.
    expect(brandCssVars("red")).toEqual({});
    expect(brandCssVars("#abc")).toEqual({});
  });
});
