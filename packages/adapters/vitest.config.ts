import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The EVM parity suite boots a real Hardhat node and sends live transactions.
    testTimeout: 60000,
    hookTimeout: 90000,
    // Keep the spawned chain and the mock suite from racing on shared resources.
    fileParallelism: false,
  },
});
