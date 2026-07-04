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

  // Constructing an EVM adapter loads compiled contract artifacts — run `pnpm --filter @tokenlayer/contracts build` if these fail with ENOENT.
  it("registers a configured EVM chain as mode 'real' (no mock path exists)", () => {
    const reg = buildChainRegistry({ BESU_RPC_URL: "http://127.0.0.1:9", BESU_OPERATOR_KEY: KEY });
    const besu = reg.list().find((c) => c.id === "besu");
    expect(besu?.kind).toBe("evm");
    expect(besu?.mode).toBe("real");
  });

  it("assertConnectivity rejects with an actionable error when a configured EVM chain is unreachable", async () => {
    const reg = buildChainRegistry({ BESU_RPC_URL: "http://127.0.0.1:9", BESU_OPERATOR_KEY: KEY });
    await expect(reg.assertConnectivity()).rejects.toThrow(/besu.*unreachable/s);
  });

  it("assertConnectivity resolves when no EVM chain is configured", async () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    await expect(reg.assertConnectivity()).resolves.toBeUndefined();
  });

  it("surfaces explorer + currency metadata for a configured EVM chain (mst)", () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0", MST_RPC_URL: "http://127.0.0.1:9", MST_OPERATOR_KEY: KEY });
    const mst = reg.list().find((c) => c.id === "mst");
    expect(mst?.mode).toBe("real");
    expect(mst?.explorerUrl).toBe("https://testnet.mstscan.com");
    expect(mst?.currencySymbol).toBe("tMSTC");
  });

  it("does not attach explorer metadata to chains that have none (besu)", () => {
    const reg = buildChainRegistry({ BESU_RPC_URL: "http://127.0.0.1:9", BESU_OPERATOR_KEY: KEY });
    const besu = reg.list().find((c) => c.id === "besu");
    expect(besu?.explorerUrl).toBeUndefined();
  });

  it("fabric is simulated with no connection env, and is not probed at boot", async () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    expect(reg.list().find((c) => c.id === "fabric")?.mode).toBe("simulated");
    await expect(reg.assertConnectivity()).resolves.toBeUndefined();
  });

  it("fabric is real when FABRIC_CONNECTION_PROFILE is set, and boot probes it (fails fast when the network is absent)", async () => {
    const reg = buildChainRegistry({
      CHAIN_STRICT: "0",
      FABRIC_CONNECTION_PROFILE: "/nonexistent/connection-org1.json",
      FABRIC_WALLET: "/nonexistent/wallet",
      FABRIC_IDENTITY: "appUser",
    });
    expect(reg.list().find((c) => c.id === "fabric")?.mode).toBe("real");
    await expect(reg.assertConnectivity()).rejects.toThrow(/fabric.*real ledger but unreachable/s);
  });
});
