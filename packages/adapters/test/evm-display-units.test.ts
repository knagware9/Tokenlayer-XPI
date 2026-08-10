import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
import type { AssetDeploymentSpec, AssetRef, TokenStandard } from "@tokenlayer/core";
import { EvmLedgerAdapter, type EvmArtifact } from "../src/evm-adapter.js";
import { loadArtifact } from "../src/testing/artifact.js";
import { startLocalChain, type LocalChain } from "../src/testing/local-chain.js";

/**
 * Pins the unit convention at the boundary that integrators actually see.
 *
 * The platform accounts in whole units — a quantity of "1000" means a thousand
 * tokens, never 1000 × 10^decimals — so every deployed token must report
 * `decimals() == 0`. That makes the *displayed* value (what MetaMask, a block
 * explorer, or `formatUnits(balance, decimals())` renders) identical to the
 * quantity the adapter was asked to mint. Reading decimals from the contract
 * rather than assuming it is deliberate: tokens deployed before this convention
 * still report 18, and consumers must read the value per asset.
 */
const chain: LocalChain | null = await startLocalChain(18548).catch((err) => {
  console.warn(`[evm-display-units.test] skipping: ${(err as Error).message}`);
  return null;
});

if (!chain) {
  describe.skip("EVM display units (local chain unavailable)", () => {
    it("skipped", () => {});
  });
} else {
  const [alice, bob] = chain.accounts;
  const artifacts: Record<TokenStandard, EvmArtifact> = {
    "ERC-20": loadArtifact("ComplianceToken"),
    "ERC-721": loadArtifact("ComplianceNFT"),
    "ERC-3643": loadArtifact("ComplianceToken3643"),
  };
  const provider = new JsonRpcProvider(chain.rpcUrl);
  const ERC20_VIEWS = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
  ];

  const adapter = new EvmLedgerAdapter({
    chainId: "local-evm",
    rpcUrl: chain.rpcUrl,
    privateKey: chain.operatorKey,
    artifacts,
  });

  async function deploy(tokenStandard: "ERC-20" | "ERC-3643"): Promise<AssetRef> {
    const spec: AssetDeploymentSpec = {
      id: `units-${tokenStandard}`,
      name: "Units Demo",
      symbol: "UNIT",
      useCaseKey: "units-demo",
      tokenType: "fungible",
      tokenStandard,
      allowlistEnabled: true,
      metadata: {},
    };
    const result = await adapter.deployAsset(spec);
    return { id: spec.id, chainId: "local-evm", contractRef: result.contractRef };
  }

  afterAll(async () => {
    await chain.stop();
  });

  describe.each(["ERC-20", "ERC-3643"] as const)("%s issued through the adapter", (tokenStandard) => {
    it("renders the platform's own quantities to a standard ERC-20 consumer", async () => {
      const ref = await deploy(tokenStandard);
      await adapter.setAllowed(ref, alice, true);
      await adapter.setAllowed(ref, bob, true);
      await adapter.mint(ref, alice, "1000");
      await adapter.transfer(ref, alice, bob, "250");

      // Independent read, exactly as a wallet or explorer would do it.
      const token = new Contract(ref.contractRef, ERC20_VIEWS, provider);
      const decimals = (await token.getFunction("decimals")()) as bigint;
      const display = async (account: string): Promise<string> =>
        formatUnits((await token.getFunction("balanceOf")(account)) as bigint, decimals);

      expect(decimals).toBe(0n);
      expect(await display(alice)).toBe(await adapter.balanceOf(ref, alice));
      expect(await display(bob)).toBe(await adapter.balanceOf(ref, bob));
      expect(await display(alice)).toBe("750");
      expect(await display(bob)).toBe("250");
      expect(formatUnits((await token.getFunction("totalSupply")()) as bigint, decimals)).toBe(
        await adapter.totalSupply(ref),
      );
    }, 180000);
  });
}
