import { describe, expect, it } from "vitest";
import { staggerClass } from "../src/components/shared/ui.js";

describe("staggerClass", () => {
  it("returns just the animation class when n is undefined", () => {
    expect(staggerClass()).toBe("animate-slide-up");
  });

  it("appends the numbered stagger class when n is given", () => {
    expect(staggerClass(1)).toBe("animate-slide-up stagger-1");
    expect(staggerClass(7)).toBe("animate-slide-up stagger-7");
  });

  it("caps at stagger-7 — index.css defines no class beyond it", () => {
    expect(staggerClass(8)).toBe("animate-slide-up stagger-7");
    expect(staggerClass(20)).toBe("animate-slide-up stagger-7");
  });

  it("treats 0 and negative numbers as undefined (no numbered class)", () => {
    expect(staggerClass(0)).toBe("animate-slide-up");
    expect(staggerClass(-1)).toBe("animate-slide-up");
  });
});
