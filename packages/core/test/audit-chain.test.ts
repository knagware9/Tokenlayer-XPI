import { describe, it, expect } from "vitest";
import { auditGenesis, auditEntryHash, verifyChain, type AuditChainFields, type ChainEntry } from "../src/audit-chain.js";

const f = (seq: number, over: Partial<AuditChainFields> = {}): AuditChainFields => ({
  assetId: "a1", seq, actorId: "u1", action: "mint", payload: { to: "0xabc", amount: "100" },
  txHash: "0xtx", chainId: "fabric", createdAt: "2026-07-09T00:00:00.000Z", ...over,
});
/** Build a valid chain of N entries for asset a1. */
function chain(n: number): ChainEntry[] {
  const out: ChainEntry[] = [];
  let prev = auditGenesis("a1");
  for (let i = 0; i < n; i++) {
    const fields = f(i);
    const hash = auditEntryHash(prev, fields);
    out.push({ seq: i, prevHash: prev, hash, fields });
    prev = hash;
  }
  return out;
}

describe("audit-chain", () => {
  it("genesis is deterministic and distinct per asset", () => {
    expect(auditGenesis("a1")).toBe(auditGenesis("a1"));
    expect(auditGenesis("a1")).not.toBe(auditGenesis("a2"));
    expect(auditGenesis("a1")).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("entry hash is deterministic and sensitive to every field", () => {
    const g = auditGenesis("a1");
    const h = auditEntryHash(g, f(0));
    expect(auditEntryHash(g, f(0))).toBe(h);
    expect(auditEntryHash(g, f(0, { actorId: "u2" }))).not.toBe(h);
    expect(auditEntryHash(g, f(0, { payload: { to: "0xabc", amount: "101" } }))).not.toBe(h);
    expect(auditEntryHash("0xdifferentprev", f(0))).not.toBe(h);
  });
  it("verifyChain passes a valid chain", () => {
    const r = verifyChain("a1", chain(4));
    expect(r).toMatchObject({ valid: true, count: 4, brokenAt: null });
    expect(r.head).toMatch(/^0x/);
  });
  it("empty chain is valid with null head", () => {
    expect(verifyChain("a1", [])).toMatchObject({ valid: true, count: 0, head: null, brokenAt: null });
  });
  it("detects a mutated field (hash-mismatch)", () => {
    const c = chain(4);
    c[2] = { ...c[2], fields: { ...c[2].fields, actorId: "attacker" } }; // edit payload/actor, keep stored hash
    expect(verifyChain("a1", c)).toMatchObject({ valid: false, brokenAt: 2, reason: "hash-mismatch" });
  });
  it("detects a deleted middle entry (prevhash-mismatch after reindex)", () => {
    const c = chain(4).filter((_, i) => i !== 1).map((e, i) => ({ ...e, seq: i })); // drop seq1, reindex seqs
    expect(verifyChain("a1", c)).toMatchObject({ valid: false, brokenAt: 1 });
  });
  it("detects an inserted forgery", () => {
    const c = chain(3);
    const forged: ChainEntry = { seq: 1, prevHash: c[0].hash, hash: "0xforged", fields: f(1, { action: "burn" }) };
    const tampered = [c[0], forged, { ...c[1], seq: 2 }, { ...c[2], seq: 3 }];
    expect(verifyChain("a1", tampered)).toMatchObject({ valid: false, brokenAt: 1 });
  });
});
