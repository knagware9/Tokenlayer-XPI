/**
 * Unit cover for the EN-D2 live/test vocabulary the console renders and
 * validates against (`src/lib/modes.ts`).
 *
 * Narrow on the same terms as webhooks-panel.test.ts and
 * developers-key-lifecycle.test.ts: apps/web has no DOM test environment, so
 * what is asserted here is the logic the renders delegate to. Every rule below
 * is also enforced by the server — the point of having it here is that the
 * builder can never OFFER a combination the server would refuse, which is the
 * defect class EN-B's review found twice (a Rotate button on a key that could
 * not rotate; a role picker defaulting to maximum privilege).
 */
import { describe, expect, it } from "vitest";
import {
  KEY_MARKERS,
  MODE_LABELS,
  SANDBOX_CHAIN_ID,
  chainChoicesFor,
  checkUseCaseDraft,
  keyMarker,
  modeLabel,
  modeOf,
  modeTone,
  sandboxChainsValid,
} from "../src/lib/shared/modes.js";
import type { ChainInfo } from "../src/types.js";

/** The catalog as `GET /chains` really returns it — four real-or-absent
 *  ledgers plus the always-simulated sandbox one (config/chains.json). */
const CHAINS: ChainInfo[] = [
  { id: "besu", label: "Hyperledger Besu", family: "evm", kind: "evm", mode: "real" },
  { id: "mst", label: "MST Testnet", family: "evm", kind: "evm", mode: "real" },
  { id: "fabric", label: "Hyperledger Fabric", family: "fabric", kind: "simulated" },
  { id: "canton", label: "Canton Network (simulated)", family: "canton", kind: "simulated" },
  { id: SANDBOX_CHAIN_ID, label: "Sandbox (simulated)", family: "mock", kind: "simulated" },
];

describe("chainChoicesFor", () => {
  it("offers only the sandbox chain when sandbox is chosen", () => {
    const offered = chainChoicesFor(true, CHAINS);
    // Asserted as the WHOLE list, not as "contains sandbox": a helper that
    // ignored the flag and returned the catalog would satisfy a containment
    // check while offering besu to a use case the server will refuse
    // (400 INVALID_SANDBOX_CHAINS).
    expect(offered.map((c) => c.id)).toEqual([SANDBOX_CHAIN_ID]);
  });

  it("never offers the sandbox chain to a live use case", () => {
    const offered = chainChoicesFor(false, CHAINS);
    expect(offered.map((c) => c.id)).toEqual(["besu", "mst", "fabric", "canton"]);
    expect(offered.some((c) => c.id === SANDBOX_CHAIN_ID)).toBe(false);
  });

  it("actually consults the flag — the two answers are disjoint", () => {
    // Pins the split itself rather than either list in isolation. An
    // implementation that returned the catalog either way passes neither of
    // these, and one that returned the same list twice fails here.
    const sandbox = chainChoicesFor(true, CHAINS).map((c) => c.id);
    const live = chainChoicesFor(false, CHAINS).map((c) => c.id);
    expect(sandbox.filter((id) => live.includes(id))).toEqual([]);
    expect([...sandbox, ...live].sort()).toEqual(CHAINS.map((c) => c.id).sort());
  });

  it("returns nothing rather than a wrong something when the sandbox chain is absent", () => {
    // A deployment whose catalog predates EN-D2. Offering the first live chain
    // instead would build exactly the combination the server refuses.
    expect(chainChoicesFor(true, CHAINS.filter((c) => c.id !== SANDBOX_CHAIN_ID))).toEqual([]);
  });
});

describe("checkUseCaseDraft", () => {
  it("a draft with a chain/mode mismatch cannot reach the create call", () => {
    // A sandbox use case naming a real ledger: the server answers
    // 400 INVALID_SANDBOX_CHAINS, and a sandbox programme whose assets minted
    // on Besu would not be a sandbox at all.
    const sandboxOnBesu = checkUseCaseDraft({ sandbox: true, allowedChainIds: ["besu"], defaultChainId: "besu" });
    expect(sandboxOnBesu.ok).toBe(false);
    // THE NARROWING IS THE POINT: the validated chain list exists only on the
    // ok arm, so a mismatched draft has nothing to hand `api.createUseCase`.
    expect("allowedChainIds" in sandboxOnBesu).toBe(false);

    // …and the other direction, which is the one that forges a real register:
    // a LIVE use case whose assets would mint on the in-memory ledger.
    const liveOnSandbox = checkUseCaseDraft({
      sandbox: false,
      allowedChainIds: ["besu", SANDBOX_CHAIN_ID],
      defaultChainId: "besu",
    });
    expect(liveOnSandbox.ok).toBe(false);
    expect("allowedChainIds" in liveOnSandbox).toBe(false);
    expect(liveOnSandbox.ok === false && liveOnSandbox.message).toMatch(/sandbox/i);
  });

  it("accepts a matched draft and narrows it", () => {
    expect(checkUseCaseDraft({ sandbox: true, allowedChainIds: [SANDBOX_CHAIN_ID], defaultChainId: SANDBOX_CHAIN_ID })).toEqual({
      ok: true,
      sandbox: true,
      mode: "test",
      allowedChainIds: [SANDBOX_CHAIN_ID],
      defaultChainId: SANDBOX_CHAIN_ID,
    });
    expect(checkUseCaseDraft({ sandbox: false, allowedChainIds: ["besu", "mst"], defaultChainId: "mst" })).toEqual({
      ok: true,
      sandbox: false,
      mode: "live",
      allowedChainIds: ["besu", "mst"],
      defaultChainId: "mst",
    });
  });

  it("refuses a draft with no ledger at all, in either environment", () => {
    expect(checkUseCaseDraft({ sandbox: false, allowedChainIds: [], defaultChainId: "" }).ok).toBe(false);
    expect(checkUseCaseDraft({ sandbox: true, allowedChainIds: [], defaultChainId: "" }).ok).toBe(false);
  });

  it("refuses a default chain that is not in the allowed list", () => {
    const check = checkUseCaseDraft({ sandbox: false, allowedChainIds: ["besu"], defaultChainId: "mst" });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.message).toMatch(/default/i);
  });

  it("mirrors the server's chain rule in both directions", () => {
    expect(sandboxChainsValid(true, [SANDBOX_CHAIN_ID])).toBe(true);
    expect(sandboxChainsValid(true, [SANDBOX_CHAIN_ID, "besu"])).toBe(false);
    expect(sandboxChainsValid(false, ["besu", "fabric"])).toBe(true);
    expect(sandboxChainsValid(false, [SANDBOX_CHAIN_ID])).toBe(false);
    // An empty allowlist is invalid for BOTH — core says so, and a use case
    // that may deploy nowhere is not a use case.
    expect(sandboxChainsValid(true, [])).toBe(false);
    expect(sandboxChainsValid(false, [])).toBe(false);
  });
});

describe("mode labelling", () => {
  it("labels a test key and a live key distinguishably", () => {
    // Asserted on the FULL label, not on a substring: if the live label
    // contained the word "test" anywhere ("Live (not test)"), a substring
    // assertion would pass while the UI showed two labels a reader cannot tell
    // apart at a glance.
    expect(modeLabel("live")).toBe("Live");
    expect(modeLabel("test")).toBe("Sandbox");
    expect(modeLabel("live")).not.toBe(modeLabel("test"));
    // Neither label may CONTAIN the other either: "Live" / "Live sandbox" reads
    // as the same word at the size these render at.
    expect(modeLabel("live").includes(modeLabel("test"))).toBe(false);
    expect(modeLabel("test").includes(modeLabel("live"))).toBe(false);
    // The two must also look different, not just read differently — a pill that
    // is the same colour in both environments is the thing someone's eye slides
    // past on a screenshot.
    expect(modeTone("live")).not.toBe(modeTone("test"));
    // The map is total over the two modes and has no accidental third entry.
    expect(Object.keys(MODE_LABELS).sort()).toEqual(["live", "test"]);
  });

  it("labels the secret markers distinguishably too", () => {
    // The mirror of the API's KEY_PREFIX_MARKERS. A secret that looks safe and
    // is not is exactly what the marker exists to prevent, so the display of it
    // must not collapse the two either.
    expect(keyMarker("live")).toBe("tl_live_");
    expect(keyMarker("test")).toBe("tl_test_");
    expect(keyMarker("live")).not.toBe(keyMarker("test"));
    expect(Object.keys(KEY_MARKERS).sort()).toEqual(["live", "test"]);
  });

  it("reads a use case's environment off its sandbox flag, defaulting to live", () => {
    // `sandbox` is optional on the wire (a DB default, absent on every row that
    // predates EN-D2), and absent means LIVE — the same reading the server's
    // `modeGate` applies.
    expect(modeOf(true)).toBe("test");
    expect(modeOf(false)).toBe("live");
    expect(modeOf(undefined)).toBe("live");
    expect(modeOf(null)).toBe("live");
  });
});
