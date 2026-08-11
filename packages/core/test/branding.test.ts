import { describe, expect, it } from "vitest";
import { validateBrandAccent } from "../src/branding.js";

const bad = (v: unknown): string | null => {
  try { validateBrandAccent(v); return null; } catch (e) { return (e as Error).message; }
};

describe("validateBrandAccent", () => {
  it("accepts a six-digit hex in either case and normalizes to lowercase", () => {
    expect(validateBrandAccent("#0E8C75")).toBe("#0e8c75");
    expect(validateBrandAccent("#aabbcc")).toBe("#aabbcc");
  });

  it("rejects the shapes a colour picker never emits but a hand-written request does", () => {
    expect(bad("#abc")).toContain("#rrggbb");          // three-digit shorthand
    expect(bad("0e8c75")).toContain("#rrggbb");        // missing hash
    expect(bad("red")).toContain("#rrggbb");           // named colour
    expect(bad("#0e8c7")).toContain("#rrggbb");        // five digits
    expect(bad("#0e8c755")).toContain("#rrggbb");      // seven digits
    expect(bad("#0e8c7g")).toContain("#rrggbb");       // non-hex digit
  });

  it("rejects non-strings, which is what a JSON client sends by accident", () => {
    for (const v of [7, null, undefined, {}, ["#0e8c75"]]) expect(bad(v), String(v)).not.toBeNull();
  });

  it("carries its own error code so a 400 can name the field", () => {
    try { validateBrandAccent("nope"); throw new Error("expected a throw"); }
    catch (e) { expect((e as { code?: string }).code).toBe("INVALID_BRAND_ACCENT"); }
  });
});
