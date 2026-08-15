import { describe, it, expect } from "vitest";
import { MemoryAuditRepository } from "../src/persistence/memory/index.js";
import { verifyChain, type ChainEntry } from "@tokenlayer/core";

function toChain(items: { seq?: number; prevHash?: string; hash?: string; assetId?: string; actorId: string; action: string; payload: Record<string, unknown>; txHash?: string; chainId?: string; createdAt: string }[]): ChainEntry[] {
  return items
    .slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((e) => ({ seq: e.seq!, prevHash: e.prevHash!, hash: e.hash!, fields: { assetId: e.assetId ?? "__none__", seq: e.seq!, actorId: e.actorId, action: e.action, payload: e.payload, txHash: e.txHash, chainId: e.chainId, createdAt: e.createdAt } }));
}

describe("MemoryAuditRepository chaining", () => {
  it("assigns seq 0..n and a verifiable chain per asset", async () => {
    const repo = new MemoryAuditRepository();
    for (let i = 0; i < 3; i++) await repo.append({ assetId: "a1", actorId: "u", action: "mint", payload: { i }, chainId: "fabric" });
    await repo.append({ assetId: "a2", actorId: "u", action: "issue", payload: {}, chainId: "fabric" });
    const a1 = (await repo.listByAsset("a1", { limit: 100 })).items;
    expect(a1.map((e) => e.seq).sort()).toEqual([0, 1, 2]);
    expect(verifyChain("a1", toChain(a1))).toMatchObject({ valid: true, count: 3 });
    const a2 = (await repo.listByAsset("a2", { limit: 100 })).items;
    expect(a2[0].seq).toBe(0); // a2 has its own chain
    expect(verifyChain("a2", toChain(a2))).toMatchObject({ valid: true, count: 1 });
  });
  it("a mutated entry fails verification at its seq", async () => {
    const repo = new MemoryAuditRepository();
    for (let i = 0; i < 3; i++) await repo.append({ assetId: "a1", actorId: "u", action: "mint", payload: { i }, chainId: "fabric" });
    const items = (await repo.listByAsset("a1", { limit: 100 })).items;
    const mutated = toChain(items).map((e) => (e.seq === 1 ? { ...e, fields: { ...e.fields, actorId: "attacker" } } : e));
    expect(verifyChain("a1", mutated)).toMatchObject({ valid: false, brokenAt: 1, reason: "hash-mismatch" });
  });
});
