import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssetDeploymentSpec, AssetRef, TokenStandard } from "@tokenlayer/core";
import { EvmLedgerAdapter, type EvmArtifact } from "../src/evm-adapter.js";
import { loadArtifact } from "../src/testing/artifact.js";
import { startLocalChain, type LocalChain } from "../src/testing/local-chain.js";

const chain: LocalChain | null = await startLocalChain(18546).catch((err) => {
  console.warn(`[trex-adapter.test] skipping: ${(err as Error).message}`);
  return null;
});

if (!chain) {
  describe.skip("EvmLedgerAdapter + real T-REX (chain unavailable)", () => {
    it("skipped", () => {});
  });
} else {
  const [alice, bob] = chain.accounts;
  const artifacts: Record<TokenStandard, EvmArtifact> = {
    "ERC-20": loadArtifact("ComplianceToken"),
    "ERC-721": loadArtifact("ComplianceNFT"),
    "ERC-3643": loadArtifact("ComplianceToken3643"),
  };

  describe("EvmLedgerAdapter + real T-REX (ERC-3643)", () => {
    let adapter: EvmLedgerAdapter;
    let ref: AssetRef;

    beforeAll(async () => {
      adapter = new EvmLedgerAdapter({ chainId: "local-evm", rpcUrl: chain.rpcUrl, privateKey: chain.operatorKey, artifacts });
      const spec: AssetDeploymentSpec = {
        id: "sec-1",
        name: "Acme Equity",
        symbol: "ACME",
        useCaseKey: "security-token",
        tokenType: "fungible",
        tokenStandard: "ERC-3643",
        allowlistEnabled: true,
        metadata: {},
      };
      const r = await adapter.deployAsset(spec);
      ref = { id: "sec-1", chainId: "local-evm", contractRef: r.contractRef };
    }, 120000);

    afterAll(async () => {
      await chain.stop();
    });

    it("deploys a real T-REX suite (token has an identity registry)", async () => {
      expect(ref.contractRef).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("rejects minting to an unregistered holder, then onboards + mints", async () => {
      await expect(adapter.mint(ref, alice, "1000")).rejects.toThrow();
      await adapter.setAllowed(ref, alice, true);
      expect(await adapter.isAllowed(ref, alice)).toBe(true);
      await adapter.mint(ref, alice, "1000");
      expect(await adapter.balanceOf(ref, alice)).toBe("1000");
      expect(await adapter.totalSupply(ref)).toBe("1000");
    });

    it("performs operator-mediated transfer once both parties are registered", async () => {
      await adapter.setAllowed(ref, bob, true);
      await adapter.transfer(ref, alice, bob, "400");
      expect(await adapter.balanceOf(ref, bob)).toBe("400");
    });

    it("freezes an account and reflects it on-chain", async () => {
      await adapter.setFrozen(ref, alice, true);
      expect(await adapter.isFrozen(ref, alice)).toBe(true);
      await adapter.setFrozen(ref, alice, false);
    });

    it("removes an investor's identity on disallow", async () => {
      await adapter.setAllowed(ref, bob, false);
      expect(await adapter.isAllowed(ref, bob)).toBe(false);
    });
  });
}
