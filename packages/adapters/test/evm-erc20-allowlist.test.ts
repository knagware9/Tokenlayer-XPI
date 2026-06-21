import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssetDeploymentSpec, AssetRef, TokenStandard } from "@tokenlayer/core";
import { EvmLedgerAdapter, type EvmArtifact } from "../src/evm-adapter.js";
import { loadArtifact } from "../src/testing/artifact.js";
import { startLocalChain, type LocalChain } from "../src/testing/local-chain.js";

// Reproduces the demo's exact sequence: a plain ERC-20 ComplianceToken with the
// allowlist enabled, then allow → allow → mint → transfer (isolated fresh node).
const chain: LocalChain | null = await startLocalChain(18547).catch(() => null);

if (!chain) {
  describe.skip("EVM ERC-20 allowlist (chain unavailable)", () => {
    it("skipped", () => {});
  });
} else {
  const [alice, bob] = chain.accounts;
  const artifacts: Record<TokenStandard, EvmArtifact> = {
    "ERC-20": loadArtifact("ComplianceToken"),
    "ERC-721": loadArtifact("ComplianceNFT"),
    "ERC-3643": loadArtifact("ComplianceToken3643"),
  };

  describe("EvmLedgerAdapter ERC-20 with allowlist", () => {
    let adapter: EvmLedgerAdapter;
    let ref: AssetRef;
    beforeAll(async () => {
      adapter = new EvmLedgerAdapter({ chainId: "local-evm", rpcUrl: chain.rpcUrl, privateKey: chain.operatorKey, artifacts });
      const spec: AssetDeploymentSpec = {
        id: "gold-1",
        name: "Gold",
        symbol: "GOLD",
        useCaseKey: "generic-asset",
        tokenType: "fungible",
        tokenStandard: "ERC-20",
        allowlistEnabled: true,
        metadata: {},
      };
      const r = await adapter.deployAsset(spec);
      ref = { id: "gold-1", chainId: "local-evm", contractRef: r.contractRef };
    }, 60000);
    afterAll(async () => {
      await chain.stop();
    });

    it("allows two accounts, mints and transfers", async () => {
      await adapter.setAllowed(ref, alice, true);
      await adapter.setAllowed(ref, bob, true);
      expect(await adapter.isAllowed(ref, alice)).toBe(true);
      expect(await adapter.isAllowed(ref, bob)).toBe(true);
      await adapter.mint(ref, alice, "1000");
      expect(await adapter.balanceOf(ref, alice)).toBe("1000");
      await adapter.transfer(ref, alice, bob, "400");
      expect(await adapter.balanceOf(ref, bob)).toBe("400");
    });
  });
}
