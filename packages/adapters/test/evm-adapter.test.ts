import { afterAll, describe, it } from "vitest";
import type { TokenStandard } from "@tokenlayer/core";
import { runAdapterContractTests } from "../src/testing/adapter-suite.js";
import { EvmLedgerAdapter, type EvmArtifact } from "../src/evm-adapter.js";
import { loadArtifact } from "../src/testing/artifact.js";
import { startLocalChain, type LocalChain } from "../src/testing/local-chain.js";

// Boot a real local EVM during collection. If it cannot start (e.g. CI without
// the contracts built, or port busy), skip rather than fail the whole run.
const chain: LocalChain | null = await startLocalChain().catch((err) => {
  console.warn(`[evm-adapter.test] skipping EVM parity suite: ${(err as Error).message}`);
  return null;
});

if (!chain) {
  describe.skip("LedgerAdapter contract: EvmLedgerAdapter (local chain unavailable)", () => {
    it("skipped", () => {});
  });
} else {
  const artifacts: Record<TokenStandard, EvmArtifact> = {
    "ERC-20": loadArtifact("ComplianceToken"),
    "ERC-721": loadArtifact("ComplianceNFT"),
    "ERC-3643": loadArtifact("ComplianceToken3643"),
  };
  runAdapterContractTests("EvmLedgerAdapter", {
    accounts: chain.accounts,
    makeAdapter: () =>
      new EvmLedgerAdapter({ chainId: "local-evm", rpcUrl: chain.rpcUrl, privateKey: chain.operatorKey, artifacts }),
  });
  afterAll(async () => {
    await chain.stop();
  });
}
