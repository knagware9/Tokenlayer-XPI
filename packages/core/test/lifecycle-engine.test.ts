import { describe, it, expect, beforeEach } from "vitest";
import {
  LifecycleEngine,
  RbacPolicy,
  StaticUseCaseSource,
  type Actor,
  type AssetContext,
  type AuditRecord,
  type AuditSink,
  type UseCaseDefinition,
} from "../src/index.js";
import { FakeAdapter, FUNGIBLE_USE_CASE, NO_TRANSFER_USE_CASE } from "./fixtures.js";

class MemoryAudit implements AuditSink {
  entries: AuditRecord[] = [];
  async record(entry: AuditRecord): Promise<void> {
    this.entries.push(entry);
  }
}

// Old "Admin" (all-powerful) → UseCaseAdmin
const ADMIN: Actor = { id: "admin", role: "UseCaseAdmin" };
// Old "Viewer" (read-only) → Auditor
const AUDITOR: Actor = { id: "auditor", role: "Auditor" };
// Old "Operator" used for freeze/unfreeze → Issuer (holds freeze/unfreeze in new matrix)
const ISSUER: Actor = { id: "issuer", role: "Issuer" };
// Old "Operator" used for transfer/burn → Trader
const TRADER: Actor = { id: "trader", role: "Trader" };

// A transferable NFT use case (certificate is non-transferable) for NFT transfer tests.
const TRANSFERABLE_NFT: UseCaseDefinition = {
  ...NO_TRANSFER_USE_CASE,
  key: "transferable-nft",
  lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
};

describe("LifecycleEngine", () => {
  let adapter: FakeAdapter;
  let audit: MemoryAudit;
  let engine: LifecycleEngine;
  let ctx: AssetContext;
  let certCtx: AssetContext;
  let nftCtx: AssetContext;

  beforeEach(() => {
    adapter = new FakeAdapter();
    audit = new MemoryAudit();
    engine = new LifecycleEngine({
      useCases: new StaticUseCaseSource([FUNGIBLE_USE_CASE, NO_TRANSFER_USE_CASE, TRANSFERABLE_NFT]),
      rbac: new RbacPolicy(),
      resolveAdapter: (chainId) => {
        if (chainId !== "fake") throw new Error(`no adapter for ${chainId}`);
        return adapter;
      },
      audit,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    ctx = { ref: { id: "asset-1", chainId: "fake", contractRef: "fake:asset-1" }, useCaseKey: "generic-asset" };
    certCtx = { ref: { id: "c1", chainId: "fake", contractRef: "fake:c1" }, useCaseKey: "generic-certificate" };
    nftCtx = { ref: { id: "n1", chainId: "fake", contractRef: "fake:n1" }, useCaseKey: "transferable-nft" };
  });

  it("issues an asset, validating metadata and recording audit", async () => {
    const res = await engine.issue(ADMIN, {
      useCaseKey: "generic-asset",
      id: "asset-1",
      name: "Demo",
      symbol: "DEMO",
      chainId: "fake",
      metadata: { issuer: "ACME" },
    });
    expect(res.ref.contractRef).toBe("fake:asset-1");
    expect(audit.entries.at(-1)?.action).toBe("issue");
  });

  it("rejects issuance to a chain the use case does not allow", async () => {
    await expect(
      engine.issue(ADMIN, { useCaseKey: "generic-asset", id: "a", name: "n", symbol: "S", chainId: "other", metadata: { issuer: "X" } }),
    ).rejects.toThrowError(/cannot deploy to chain 'other'/);
  });

  it("rejects issuance with invalid metadata", async () => {
    await expect(
      engine.issue(ADMIN, { useCaseKey: "generic-asset", id: "a", name: "n", symbol: "S", chainId: "fake", metadata: {} }),
    ).rejects.toThrowError(/missing required field 'issuer'/);
  });

  it("enforces RBAC — Auditor cannot mint", async () => {
    await expect(engine.mint(AUDITOR, ctx, "alice", "100")).rejects.toThrowError(/may not perform 'mint'/);
  });

  it("rejects fungible ops on a non-fungible use case", async () => {
    await expect(engine.mint(ADMIN, certCtx, "alice", "1")).rejects.toThrowError(/non-fungible/);
  });

  it("rejects non-fungible ops on a fungible use case", async () => {
    await expect(engine.mintToken(ADMIN, ctx, "alice", "1")).rejects.toThrowError(/fungible/);
  });

  it("enforces lifecycle flags — transfer disabled certificate", async () => {
    await engine.mintToken(ADMIN, certCtx, "alice", "1");
    await expect(engine.transferToken(ADMIN, certCtx, "alice", "bob", "1")).rejects.toThrowError(/does not allow 'transfer'/);
  });

  it("enforces the allowlist on mint", async () => {
    await expect(engine.mint(ADMIN, ctx, "alice", "100")).rejects.toThrowError(/not on the allowlist/);
    await engine.setAllowed(ADMIN, ctx, "alice", true);
    await expect(engine.mint(ADMIN, ctx, "alice", "100")).resolves.toBeDefined();
    expect(await adapter.balanceOf(ctx.ref, "alice")).toBe("100");
  });

  it("blocks transfers from a frozen account", async () => {
    await engine.setAllowed(ADMIN, ctx, "alice", true);
    await engine.setAllowed(ADMIN, ctx, "bob", true);
    await engine.mint(ADMIN, ctx, "alice", "100");
    // Issuer role now holds freeze/unfreeze
    await engine.setFrozen(ISSUER, ctx, "alice", true);
    // Trader role holds transfer
    await expect(engine.transfer(TRADER, ctx, "alice", "bob", "10")).rejects.toThrowError(/frozen/);
    await engine.setFrozen(ISSUER, ctx, "alice", false);
    await engine.transfer(TRADER, ctx, "alice", "bob", "10");
    expect(await adapter.balanceOf(ctx.ref, "bob")).toBe("10");
  });

  it("mints, transfers and burns NFTs by token id", async () => {
    await engine.mintToken(ADMIN, nftCtx, "alice", "tok-1", "ipfs://x");
    expect(await engine.ownerOf(ADMIN, nftCtx, "tok-1")).toBe("alice");
    // Trader role handles transfer/burn
    await engine.transferToken(TRADER, nftCtx, "alice", "bob", "tok-1");
    expect(await engine.ownerOf(ADMIN, nftCtx, "tok-1")).toBe("bob");
    expect(await engine.tokensOf(ADMIN, nftCtx, "bob")).toEqual(["tok-1"]);
    await engine.burnToken(TRADER, nftCtx, "tok-1");
    expect(await engine.ownerOf(ADMIN, nftCtx, "tok-1")).toBeNull();
  });

  it("rejects setAllowed when the use case has no allowlist", async () => {
    await expect(engine.setAllowed(ADMIN, certCtx, "x", true)).rejects.toThrowError(/no allowlist/);
  });

  it("records an audit entry per state change", async () => {
    await engine.setAllowed(ADMIN, ctx, "alice", true);
    await engine.mint(ADMIN, ctx, "alice", "5");
    const actions = audit.entries.map((e) => e.action);
    expect(actions).toEqual(["allow", "mint"]);
    expect(audit.entries.every((e) => e.at === "2026-01-01T00:00:00.000Z")).toBe(true);
  });
});
