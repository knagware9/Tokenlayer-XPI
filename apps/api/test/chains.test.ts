import { describe, expect, it } from "vitest";
import { buildChainRegistry } from "../src/chains.js";

// A dev-only throwaway key (hardhat account #1) — never used on a live network here.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("chain registry", () => {
  it("throws at build time when a required chain (besu) has no env and CHAIN_STRICT is on", () => {
    expect(() => buildChainRegistry({})).toThrow(/besu.*required.*BESU_RPC_URL/s);
  });

  it("omits (never simulates) a required chain when CHAIN_STRICT=0", () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    const ids = reg.list().map((c) => c.id);
    expect(ids).not.toContain("besu");
    expect(() => reg.resolveAdapter("besu")).toThrow(/not configured/);
  });

  it("omits optional EVM chains (mst, local-evm) when their env is unset", () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    const ids = reg.list().map((c) => c.id);
    expect(ids).not.toContain("mst");
    expect(ids).not.toContain("local-evm");
  });

  it("keeps simulated chains available and labels their mode", () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    const fabric = reg.list().find((c) => c.id === "fabric");
    const canton = reg.list().find((c) => c.id === "canton");
    expect(fabric?.mode).toBe("simulated");
    expect(canton?.mode).toBe("simulated");
  });

  it("registers a configured EVM chain as mode 'real' (no mock path exists)", () => {
    const reg = buildChainRegistry({ BESU_RPC_URL: "http://127.0.0.1:59999", BESU_OPERATOR_KEY: KEY });
    const besu = reg.list().find((c) => c.id === "besu");
    expect(besu?.kind).toBe("evm");
    expect(besu?.mode).toBe("real");
  });

  it("assertConnectivity rejects with an actionable error when a configured EVM chain is unreachable", async () => {
    const reg = buildChainRegistry({ BESU_RPC_URL: "http://127.0.0.1:59999", BESU_OPERATOR_KEY: KEY });
    await expect(reg.assertConnectivity()).rejects.toThrow(/besu.*unreachable/s);
  });

  it("assertConnectivity resolves when no EVM chain is configured", async () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    await expect(reg.assertConnectivity()).resolves.toBeUndefined();
  });
});
