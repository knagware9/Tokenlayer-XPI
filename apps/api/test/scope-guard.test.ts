import { describe, it, expect } from "vitest";
import { scopedToCaller } from "../src/http/support.js";

// A stub UseCaseSource that always throws — PlatformAdmin and a caller whose
// own useCaseKey already matches both short-circuit before ever consulting
// it, so these two tests never actually reach it. The OrgAdmin-ownership
// lookup path is covered separately, with a real repo, in
// org-admin-operational.test.ts.
const unreachable = { get: () => { throw new Error("should not be called"); } };

describe("scopedToCaller", () => {
  const platform = { id: "1", email: "a", role: "PlatformAdmin", useCaseKey: null } as const;
  const carbon = { id: "2", email: "b", role: "Issuer", useCaseKey: "carbon-credit" } as const;
  it("PlatformAdmin sees every use case", async () => {
    expect(await scopedToCaller(platform, "carbon-credit", unreachable)).toBe(true);
    expect(await scopedToCaller(platform, "gold-loan", unreachable)).toBe(true);
  });
  it("a scoped user only sees their own use case", async () => {
    expect(await scopedToCaller(carbon, "carbon-credit", unreachable)).toBe(true);
    expect(await scopedToCaller(carbon, "gold-loan", unreachable)).toBe(false);
  });
});
