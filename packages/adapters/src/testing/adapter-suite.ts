import { describe, it, expect, beforeAll } from "vitest";
import type { AssetDeploymentSpec, AssetRef, LedgerAdapter, TokenStandard } from "@tokenlayer/core";

export interface AdapterSuiteOptions {
  /** Three distinct account identifiers/addresses to test with. */
  accounts: [string, string, string];
  /** Create a fresh adapter for the suite. */
  makeAdapter: () => Promise<LedgerAdapter> | LedgerAdapter;
}

function spec(id: string, standard: TokenStandard, allowlistEnabled: boolean): AssetDeploymentSpec {
  return {
    id,
    name: `Asset ${id}`,
    symbol: id.toUpperCase().slice(0, 6),
    useCaseKey: "test",
    tokenType: standard === "ERC-721" ? "nonfungible" : "fungible",
    tokenStandard: standard,
    allowlistEnabled,
    metadata: {},
  };
}

/**
 * One behavioural specification, run identically against every adapter (mock,
 * fabric, canton, EVM). If all pass this suite, the platform is genuinely
 * chain-agnostic across both fungible and non-fungible standards.
 */
export function runAdapterContractTests(label: string, opts: AdapterSuiteOptions): void {
  const [alice, bob, carol] = opts.accounts;

  describe(`LedgerAdapter contract: ${label}`, () => {
    let adapter: LedgerAdapter;
    beforeAll(async () => {
      adapter = await opts.makeAdapter();
    });

    async function deploy(id: string, standard: TokenStandard, allowlist: boolean): Promise<AssetRef> {
      const r = await adapter.deployAsset(spec(id, standard, allowlist));
      return { id, chainId: adapter.chainId, contractRef: r.contractRef };
    }

    describe("fungible (ERC-20)", () => {
      it("mints and tracks balance + supply", async () => {
        const ref = await deploy("m1", "ERC-20", false);
        await adapter.mint(ref, alice, "1000");
        expect(await adapter.balanceOf(ref, alice)).toBe("1000");
        expect(await adapter.totalSupply(ref)).toBe("1000");
      });

      it("transfers between accounts", async () => {
        const ref = await deploy("m2", "ERC-20", false);
        await adapter.mint(ref, alice, "1000");
        await adapter.transfer(ref, alice, bob, "400");
        expect(await adapter.balanceOf(ref, alice)).toBe("600");
        expect(await adapter.balanceOf(ref, bob)).toBe("400");
      });

      it("burns and reduces supply", async () => {
        const ref = await deploy("m3", "ERC-20", false);
        await adapter.mint(ref, alice, "1000");
        await adapter.burn(ref, alice, "250");
        expect(await adapter.totalSupply(ref)).toBe("750");
      });

      it("rejects transfers that exceed balance", async () => {
        const ref = await deploy("m4", "ERC-20", false);
        await adapter.mint(ref, alice, "100");
        await expect(adapter.transfer(ref, alice, bob, "101")).rejects.toThrow();
      });

      it("enforces freeze on transfer", async () => {
        const ref = await deploy("m5", "ERC-20", false);
        await adapter.mint(ref, alice, "100");
        await adapter.setFrozen(ref, alice, true);
        expect(await adapter.isFrozen(ref, alice)).toBe(true);
        await expect(adapter.transfer(ref, alice, bob, "10")).rejects.toThrow();
        await adapter.setFrozen(ref, alice, false);
        await adapter.transfer(ref, alice, bob, "10");
        expect(await adapter.balanceOf(ref, bob)).toBe("10");
      });

      it("enforces the allowlist when enabled", async () => {
        const ref = await deploy("m6", "ERC-3643", true);
        await expect(adapter.mint(ref, alice, "100")).rejects.toThrow();
        await adapter.setAllowed(ref, alice, true);
        expect(await adapter.isAllowed(ref, alice)).toBe(true);
        await adapter.mint(ref, alice, "100");
        await expect(adapter.transfer(ref, alice, carol, "10")).rejects.toThrow();
        await adapter.setAllowed(ref, carol, true);
        await adapter.transfer(ref, alice, carol, "10");
        expect(await adapter.balanceOf(ref, carol)).toBe("10");
      });
    });

    describe("non-fungible (ERC-721)", () => {
      it("mints, owns, transfers and burns by token id", async () => {
        const ref = await deploy("n1", "ERC-721", false);
        await adapter.mintToken(ref, alice, "1", "ipfs://one");
        expect(await adapter.ownerOf(ref, "1")).toBe(alice);
        expect(await adapter.totalSupply(ref)).toBe("1");
        await adapter.transferToken(ref, alice, bob, "1");
        expect(await adapter.ownerOf(ref, "1")).toBe(bob);
        expect(await adapter.tokensOf(ref, bob)).toEqual(["1"]);
        await adapter.burnToken(ref, "1");
        expect(await adapter.ownerOf(ref, "1")).toBeNull();
      });

      it("rejects transferring a token the sender does not own", async () => {
        const ref = await deploy("n2", "ERC-721", false);
        await adapter.mintToken(ref, alice, "7");
        await expect(adapter.transferToken(ref, bob, carol, "7")).rejects.toThrow();
      });

      it("enforces freeze + allowlist on NFTs", async () => {
        const ref = await deploy("n3", "ERC-721", true);
        await expect(adapter.mintToken(ref, alice, "9")).rejects.toThrow();
        await adapter.setAllowed(ref, alice, true);
        await adapter.mintToken(ref, alice, "9");
        await adapter.setFrozen(ref, alice, true);
        await expect(adapter.transferToken(ref, alice, bob, "9")).rejects.toThrow();
      });
    });
  });
}
