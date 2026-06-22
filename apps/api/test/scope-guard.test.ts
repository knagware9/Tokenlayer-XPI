import { describe, it, expect } from "vitest";
import { scopedToCaller } from "../src/http/support.js";

describe("scopedToCaller", () => {
  const platform = { id: "1", email: "a", role: "PlatformAdmin", useCaseKey: null } as const;
  const carbon = { id: "2", email: "b", role: "Issuer", useCaseKey: "carbon-credit" } as const;
  it("PlatformAdmin sees every use case", () => {
    expect(scopedToCaller(platform, "carbon-credit")).toBe(true);
    expect(scopedToCaller(platform, "gold-loan")).toBe(true);
  });
  it("a scoped user only sees their own use case", () => {
    expect(scopedToCaller(carbon, "carbon-credit")).toBe(true);
    expect(scopedToCaller(carbon, "gold-loan")).toBe(false);
  });
});
