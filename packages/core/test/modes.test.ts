import { describe, expect, it } from "vitest";
import { modeAllows, sandboxChainsValid, SANDBOX_CHAIN_ID, type ResourceMode } from "../src/index.js";

describe("modeAllows — symmetric on purpose", () => {
  it("permits only matching modes, in both directions", () => {
    expect(modeAllows("live", "live")).toBe(true);
    expect(modeAllows("test", "test")).toBe(true);
    expect(modeAllows("test", "live")).toBe(false);
    expect(modeAllows("live", "test")).toBe(false);
  });

  it("is total over the mode pair — no third value is reachable", () => {
    const modes: ResourceMode[] = ["live", "test"];
    for (const a of modes) for (const b of modes) expect(typeof modeAllows(a, b)).toBe("boolean");
  });

  it("A HUMAN SESSION HAS NO MODE and may act on both", () => {
    expect(modeAllows(null, "live")).toBe(true);
    expect(modeAllows(null, "test")).toBe(true);
  });
});

describe("sandboxChainsValid — both directions are errors", () => {
  it("a sandbox use case may allow ONLY the sandbox chain", () => {
    expect(sandboxChainsValid(true, [SANDBOX_CHAIN_ID])).toBe(true);
    expect(sandboxChainsValid(true, [SANDBOX_CHAIN_ID, "besu"])).toBe(false);
    expect(sandboxChainsValid(true, ["besu"])).toBe(false);
    expect(sandboxChainsValid(true, [])).toBe(false);
  });

  it("a LIVE use case may never allow the sandbox chain", () => {
    expect(sandboxChainsValid(false, ["besu"])).toBe(true);
    expect(sandboxChainsValid(false, ["besu", SANDBOX_CHAIN_ID])).toBe(false);
    expect(sandboxChainsValid(false, [SANDBOX_CHAIN_ID])).toBe(false);
  });
});
