import { describe, expect, it } from "vitest";
import { MockLedgerAdapter } from "../src/simulated-adapter.js";
import type { AssetRef } from "@tokenlayer/core";

describe("SimulatedAdapter.hydrate — reconstructing state after a restart", () => {
  const ref: AssetRef = { id: "a1", chainId: "mock", contractRef: "mock:usecase" };

  it("installs balances/supply directly, bypassing the allowlist a live mint would enforce", async () => {
    const adapter = new MockLedgerAdapter();
    await adapter.deployAsset({
      id: "usecase", name: "n", symbol: "S", useCaseKey: "usecase",
      tokenType: "fungible", tokenStandard: "ERC-20", allowlistEnabled: true, metadata: {},
    });
    adapter.hydrate(ref, {
      tokenType: "fungible", allowlistEnabled: true,
      balances: new Map([["alice", 100n], ["bob", 25n]]),
      supply: 125n, owners: new Map(), uris: new Map(), frozen: new Set(), allowed: new Set(),
    });
    expect(await adapter.balanceOf(ref, "alice")).toBe("100");
    expect(await adapter.balanceOf(ref, "bob")).toBe("25");
    expect(await adapter.totalSupply(ref)).toBe("125");
    // alice was never live-allowlisted — a real mint() would have thrown.
    expect(await adapter.isAllowed(ref, "alice")).toBe(false);
  });

  it("restores compliance state (allow/freeze) alongside balances", async () => {
    const adapter = new MockLedgerAdapter();
    await adapter.deployAsset({
      id: "usecase", name: "n", symbol: "S", useCaseKey: "usecase",
      tokenType: "fungible", tokenStandard: "ERC-20", allowlistEnabled: true, metadata: {},
    });
    adapter.hydrate(ref, {
      tokenType: "fungible", allowlistEnabled: true,
      balances: new Map([["alice", 10n]]), supply: 10n, owners: new Map(), uris: new Map(),
      frozen: new Set(["bob"]), allowed: new Set(["alice", "bob"]),
    });
    expect(await adapter.isAllowed(ref, "alice")).toBe(true);
    expect(await adapter.isAllowed(ref, "bob")).toBe(true);
    expect(await adapter.isFrozen(ref, "bob")).toBe(true);
    expect(await adapter.isFrozen(ref, "alice")).toBe(false);
    // A subsequent live mint into the restored allowlisted account just works.
    await adapter.mint(ref, "alice", "5");
    expect(await adapter.balanceOf(ref, "alice")).toBe("15");
  });

  it("restores NFT ownership and token URIs", async () => {
    const adapter = new MockLedgerAdapter();
    await adapter.deployAsset({
      id: "usecase", name: "n", symbol: "S", useCaseKey: "usecase",
      tokenType: "nonfungible", tokenStandard: "ERC-721", allowlistEnabled: false, metadata: {},
    });
    adapter.hydrate(ref, {
      tokenType: "nonfungible", allowlistEnabled: false,
      balances: new Map([["alice", 2n]]), supply: 2n,
      owners: new Map([["tok-1", "alice"], ["tok-2", "alice"]]),
      uris: new Map([["tok-1", "ipfs://one"]]),
      frozen: new Set(), allowed: new Set(),
    });
    expect(await adapter.ownerOf(ref, "tok-1")).toBe("alice");
    expect(await adapter.ownerOf(ref, "tok-2")).toBe("alice");
    expect(await adapter.tokensOf(ref, "alice")).toEqual(["tok-1", "tok-2"]);
    expect(await adapter.totalSupply(ref)).toBe("2");
  });

  it("overwrites rather than merges — a second hydrate replaces the first entirely", async () => {
    const adapter = new MockLedgerAdapter();
    await adapter.deployAsset({
      id: "usecase", name: "n", symbol: "S", useCaseKey: "usecase",
      tokenType: "fungible", tokenStandard: "ERC-20", allowlistEnabled: false, metadata: {},
    });
    adapter.hydrate(ref, {
      tokenType: "fungible", allowlistEnabled: false,
      balances: new Map([["alice", 100n]]), supply: 100n, owners: new Map(), uris: new Map(),
      frozen: new Set(), allowed: new Set(),
    });
    adapter.hydrate(ref, {
      tokenType: "fungible", allowlistEnabled: false,
      balances: new Map([["bob", 40n]]), supply: 40n, owners: new Map(), uris: new Map(),
      frozen: new Set(), allowed: new Set(),
    });
    expect(await adapter.balanceOf(ref, "alice")).toBe("0");
    expect(await adapter.balanceOf(ref, "bob")).toBe("40");
    expect(await adapter.totalSupply(ref)).toBe("40");
  });

  it("does not alias the caller's Maps/Sets — mutating them afterward leaves the ledger untouched", async () => {
    const adapter = new MockLedgerAdapter();
    await adapter.deployAsset({
      id: "usecase", name: "n", symbol: "S", useCaseKey: "usecase",
      tokenType: "fungible", tokenStandard: "ERC-20", allowlistEnabled: false, metadata: {},
    });
    const balances = new Map([["alice", 10n]]);
    const allowed = new Set<string>();
    adapter.hydrate(ref, { tokenType: "fungible", allowlistEnabled: false, balances, supply: 10n, owners: new Map(), uris: new Map(), frozen: new Set(), allowed });
    balances.set("alice", 999n);
    allowed.add("mallory");
    expect(await adapter.balanceOf(ref, "alice")).toBe("10");
    expect(await adapter.isAllowed(ref, "mallory")).toBe(false);
  });

  it("creates the contract if hydrate runs before any deployAsset (a restart-before-deploy race)", async () => {
    const adapter = new MockLedgerAdapter();
    adapter.hydrate(ref, {
      tokenType: "fungible", allowlistEnabled: false,
      balances: new Map([["alice", 7n]]), supply: 7n, owners: new Map(), uris: new Map(),
      frozen: new Set(), allowed: new Set(),
    });
    expect(await adapter.balanceOf(ref, "alice")).toBe("7");
  });
});
