/**
 * TrexManager's internal `deploy()`/`tx()` helpers build a 15-20-transaction
 * T-REX suite entirely inside EvmLedgerAdapter's single serialised write queue
 * (`evm-adapter.ts` `serialize`/`trexOp`). A promise that never settles there
 * doesn't just hang its own request — it wedges every subsequent write on the
 * whole chain adapter (mints, transfers, other deploys), forever, with no
 * fastify request timeout to free the connection. Both helpers must be bounded
 * by `confirmationTimeoutMs`, the same as every other wait in this branch.
 *
 * `deploy()` reuses the already-tested `awaitDeployment` (throws
 * `DeploymentTimeoutError`, carries the tx hash — see
 * `evm-confirmation-timeout.test.ts`). `tx()` reuses `waitForReceipt`, but
 * UNLIKE `EvmLedgerAdapter#sendTx` it THROWS rather than degrading to
 * "submitted, outcome unknown" on timeout: these suite-build steps get no
 * `LedgerTransaction` row and no confirmer worker watching them, and every
 * later step assumes the one before it truly landed on-chain (e.g. registering
 * an identity assumes the identity registry it registers into already exists).
 *
 * `deploy`/`tx` are private, and `deploy` is entangled with a real
 * `ContractFactory` talking to a signer/chain. Rather than stand up a chain
 * (that's what `trex-adapter.test.ts` is for), this file reaches the two
 * private methods directly — the same reflection style used elsewhere for
 * internals-under-test — and stubs only the one call that would otherwise
 * require a live signer to resolve: `ContractFactory.prototype.deploy`. `tx()`
 * needs no stubbing at all; its `call` argument is supplied directly by each
 * test. This keeps the actual bounded-wait *logic* covered at the
 * `awaitDeployment`/`waitForReceipt` level (already exercised in
 * `evm-confirmation-timeout.test.ts`) while proving `TrexManager` really wires
 * those helpers in and produces the right, hash-naming error on timeout.
 */
import { ContractFactory } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentTimeoutError } from "../src/evm-adapter.js";
import type { Artifact } from "../src/trex/artifacts.js";
import { TrexManager } from "../src/trex/trex-manager.js";

const artifacts: Record<string, Artifact> = { Identity: { abi: [], bytecode: "0x" } };

function makeManager(confirmationTimeoutMs: number): TrexManager {
  const fakeWallet = { address: "0xoperator" } as unknown as ConstructorParameters<typeof TrexManager>[1];
  const fakeSigner = {} as unknown as ConstructorParameters<typeof TrexManager>[0];
  return new TrexManager(fakeSigner, fakeWallet, () => ({}), artifacts, confirmationTimeoutMs);
}

/** Narrowly-scoped, test-only view onto TrexManager's private deploy()/tx(). */
type PrivateTrex = {
  deploy: (name: string, ...args: unknown[]) => Promise<unknown>;
  tx: (call: (overrides: Record<string, unknown>) => Promise<{ hash: string; wait: () => Promise<unknown> }>) => Promise<unknown>;
};

describe("TrexManager bounded waits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("deploy()", () => {
    it("throws DeploymentTimeoutError naming the tx hash when waitForDeployment never resolves", async () => {
      vi.spyOn(ContractFactory.prototype, "deploy").mockResolvedValue({
        waitForDeployment: () => new Promise(() => {}),
        deploymentTransaction: () => ({ hash: "0xtrexdeploy" }),
      } as never);

      const m = makeManager(50) as unknown as PrivateTrex;
      await expect(m.deploy("Identity")).rejects.toThrow(DeploymentTimeoutError);
      await expect(m.deploy("Identity")).rejects.toThrow(/0xtrexdeploy/);
    });

    it("resolves with the contract when the deployment confirms in time", async () => {
      const fakeContract = {
        waitForDeployment: async () => ({}),
        deploymentTransaction: () => ({ hash: "0xok" }),
      };
      vi.spyOn(ContractFactory.prototype, "deploy").mockResolvedValue(fakeContract as never);

      const m = makeManager(1000) as unknown as PrivateTrex;
      await expect(m.deploy("Identity")).resolves.toBe(fakeContract);
    });
  });

  describe("tx()", () => {
    it("throws, naming the tx hash, when the wait never resolves", async () => {
      const m = makeManager(50) as unknown as PrivateTrex;
      await expect(m.tx(async () => ({ hash: "0xtrextx", wait: () => new Promise(() => {}) }))).rejects.toThrow(/0xtrextx/);
    });

    it("does not degrade to a silent pending state — it rejects rather than returning null", async () => {
      const m = makeManager(50) as unknown as PrivateTrex;
      await expect(m.tx(async () => ({ hash: "0xtrextx2", wait: () => new Promise(() => {}) }))).rejects.toBeInstanceOf(Error);
    });

    it("returns the response when it confirms in time", async () => {
      const m = makeManager(1000) as unknown as PrivateTrex;
      const response = { hash: "0xtrexok", wait: async () => ({ blockNumber: 7 }) };
      await expect(m.tx(async () => response)).resolves.toBe(response);
    });
  });
});
