import { describe, it, expect, beforeEach } from "vitest";
import {
  LifecycleEngine,
  RbacPolicy,
  StaticUseCaseSource,
  type Actor,
  type AssetContext,
  type AssetRef,
  type AuditRecord,
  type AuditSink,
  type ComplianceProvider,
  type UseCaseDefinition,
} from "../src/index.js";
import { FakeAdapter, FUNGIBLE_USE_CASE, NO_TRANSFER_USE_CASE } from "./fixtures.js";

class MemoryAudit implements AuditSink {
  entries: AuditRecord[] = [];
  async record(entry: AuditRecord): Promise<void> {
    this.entries.push(entry);
  }
}

const ADMIN: Actor = { id: "admin", role: "UseCaseAdmin" };
const AUDITOR: Actor = { id: "auditor", role: "Auditor" };
const ISSUER: Actor = { id: "issuer", role: "Issuer" };
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

  it("issues an asset into the use-case contract, validating metadata and recording audit", async () => {
    const res = await engine.issue(ADMIN, {
      useCaseKey: "generic-asset",
      id: "asset-1",
      chainId: "fake",
      metadata: { issuer: "ACME" },
    });
    // The asset shares the use case's deployed contract (not a per-asset deploy).
    expect(res.ref.contractRef).toBe("fake:generic-asset");
    expect(audit.entries.at(-1)?.action).toBe("issue");
  });

  it("rejects issuance to a chain the use case does not allow", async () => {
    await expect(
      engine.issue(ADMIN, { useCaseKey: "generic-asset", id: "a", chainId: "other", metadata: { issuer: "X" } }),
    ).rejects.toThrowError(/cannot issue on chain 'other'/);
  });

  it("rejects issuance on an allowed chain with no deployed contract", async () => {
    const source = new StaticUseCaseSource([{ ...FUNGIBLE_USE_CASE, allowedChainIds: ["fake", "pending"], contracts: { fake: FUNGIBLE_USE_CASE.contracts!.fake } }]);
    const eng = new LifecycleEngine({ useCases: source, rbac: new RbacPolicy(), resolveAdapter: () => adapter, audit, now: () => "2026-01-01T00:00:00.000Z" });
    await expect(
      eng.issue(ADMIN, { useCaseKey: "generic-asset", id: "a", chainId: "pending", metadata: { issuer: "X" } }),
    ).rejects.toThrowError(/no contract deployed on chain 'pending'/);
  });

  it("deployUseCaseContract deploys the use case's contract on a chain", async () => {
    const contract = await engine.deployUseCaseContract(FUNGIBLE_USE_CASE, "fake");
    expect(contract.contractRef).toBe("fake:generic-asset");
    expect(contract.deployTxHash).toMatch(/^0x/);
  });

  it("rejects issuance with invalid metadata", async () => {
    await expect(
      engine.issue(ADMIN, { useCaseKey: "generic-asset", id: "a", chainId: "fake", metadata: {} }),
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
    await engine.setFrozen(ISSUER, ctx, "alice", true);
    await expect(engine.transfer(TRADER, ctx, "alice", "bob", "10")).rejects.toThrowError(/frozen/);
    await engine.setFrozen(ISSUER, ctx, "alice", false);
    await engine.transfer(TRADER, ctx, "alice", "bob", "10");
    expect(await adapter.balanceOf(ctx.ref, "bob")).toBe("10");
  });

  it("mints, transfers and burns NFTs by token id", async () => {
    await engine.mintToken(ADMIN, nftCtx, "alice", "tok-1", "ipfs://x");
    expect(await engine.ownerOf(ADMIN, nftCtx, "tok-1")).toBe("alice");
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

  it("buy delivers tokens treasury→buyer and records a 'buy' audit entry with price metadata", async () => {
    const treasury = "treasury";
    const buyer = "buyer";
    await engine.setAllowed(ADMIN, ctx, treasury, true);
    await engine.setAllowed(ADMIN, ctx, buyer, true);
    await engine.mint(ADMIN, ctx, treasury, "1000");

    await engine.buy(TRADER, ctx, treasury, buyer, "10", {
      unitPrice: "5",
      currency: "CBDC-INR",
      cost: "50",
    });

    expect(await engine.balanceOf(TRADER, ctx, buyer)).toBe("10");
    const last = audit.entries.at(-1)!;
    expect(last.action).toBe("buy");
    expect(last.payload).toMatchObject({
      from: treasury,
      to: buyer,
      amount: "10",
      unitPrice: "5",
      currency: "CBDC-INR",
      cost: "50",
    });
  });

  it("buy rejects a non-allowlisted buyer", async () => {
    const treasury = "treasury";
    await engine.setAllowed(ADMIN, ctx, treasury, true);
    await engine.mint(ADMIN, ctx, treasury, "1000");

    await expect(
      engine.buy(TRADER, ctx, treasury, "0xNOTLISTED", "10", {
        unitPrice: "5",
        currency: "CBDC-INR",
        cost: "50",
      }),
    ).rejects.toThrow(/NOT_ALLOWLISTED|allowlist/);
  });

  it("buy rejects when the seller/treasury is frozen", async () => {
    const treasury = "treasury";
    const buyer = "buyer";
    await engine.setAllowed(ADMIN, ctx, treasury, true);
    await engine.setAllowed(ADMIN, ctx, buyer, true);
    await engine.mint(ADMIN, ctx, treasury, "1000");
    await engine.setFrozen(ISSUER, ctx, treasury, true);

    await expect(
      engine.buy(TRADER, ctx, treasury, buyer, "10", {
        unitPrice: "5",
        currency: "CBDC-INR",
        cost: "50",
      }),
    ).rejects.toThrow(/ACCOUNT_FROZEN|frozen/);
  });
});

// A configurable fake ComplianceProvider for the data-dependent rules.
class FakeCompliance implements ComplianceProvider {
  holders = 0;
  acquired = new Map<string, string | null>();
  jurisdictions = new Map<string, string | null>();
  verified = new Map<string, boolean>();
  /** treasuryAccountId → the account address it resolves to, mirroring the real
   *  provider's address→Account.id lookup without needing a repo here. */
  treasuryAccounts = new Map<string, string>();
  /** When true, hasVerifiedIdentity throws — used to prove it's never consulted when the flag is off. */
  throwOnVerify = false;
  /** When true, jurisdictionOf throws — used to prove it's never consulted once the treasury exemption applies. */
  throwOnJurisdiction = false;
  async holderCount(_ref: AssetRef): Promise<number> {
    return this.holders;
  }
  async acquiredAt(_ref: AssetRef, account: string): Promise<string | null> {
    return this.acquired.get(account) ?? null;
  }
  async jurisdictionOf(account: string): Promise<string | null> {
    if (this.throwOnJurisdiction) throw new Error("jurisdictionOf should not be consulted once the treasury exemption applies");
    return this.jurisdictions.get(account) ?? null;
  }
  async hasVerifiedIdentity(account: string): Promise<boolean> {
    if (this.throwOnVerify) throw new Error("hasVerifiedIdentity should not be consulted when the flag is off");
    return this.verified.get(account) ?? false;
  }
  async isUseCaseTreasury(account: string, treasuryAccountId: string | undefined): Promise<boolean> {
    if (!treasuryAccountId) return false;
    return this.treasuryAccounts.get(treasuryAccountId) === account;
  }
}

describe("LifecycleEngine — engine-enforced compliance rules", () => {
  let adapter: FakeAdapter;
  let audit: MemoryAudit;
  let provider: FakeCompliance;

  // No allowlist so the compliance rules are exercised in isolation.
  const HOLDER_LIMIT_UC: UseCaseDefinition = {
    ...FUNGIBLE_USE_CASE,
    key: "holder-limit",
    compliance: { allowlist: false, transferRestrictions: true, maxHolders: 2 },
  };
  const LOCKUP_UC: UseCaseDefinition = {
    ...FUNGIBLE_USE_CASE,
    key: "lockup",
    compliance: { allowlist: false, transferRestrictions: true, lockupDays: 30 },
  };
  const JURISDICTION_UC: UseCaseDefinition = {
    ...FUNGIBLE_USE_CASE,
    key: "jurisdiction",
    compliance: { allowlist: false, transferRestrictions: true, allowedJurisdictions: ["IN"] },
  };
  // Same jurisdiction gate, but with a registered treasury — proves the
  // treasury exemption (org-treasury-accounts plan, Task 5 fix) without
  // touching the no-treasury fixture above.
  const JURISDICTION_TREASURY_UC: UseCaseDefinition = {
    ...FUNGIBLE_USE_CASE,
    key: "jurisdiction-treasury",
    treasuryAccountId: "treasury-acct-1",
    compliance: { allowlist: false, transferRestrictions: true, allowedJurisdictions: ["IN"] },
  };
  // A SECOND, independently-gated use case with its OWN (different)
  // treasuryAccountId — proves the exemption doesn't leak across use cases:
  // the same resolved address that is exempt as UC1's treasury is just an
  // ordinary (ungated) holder here, never checked against UC1's mapping.
  const JURISDICTION_TREASURY_UC_2: UseCaseDefinition = {
    ...FUNGIBLE_USE_CASE,
    key: "jurisdiction-treasury-2",
    treasuryAccountId: "treasury-acct-3",
    compliance: { allowlist: false, transferRestrictions: true, allowedJurisdictions: ["IN"] },
  };

  const holderCtx: AssetContext = { ref: { id: "h1", chainId: "fake", contractRef: "fake:h1" }, useCaseKey: "holder-limit" };
  const lockupCtx: AssetContext = { ref: { id: "l1", chainId: "fake", contractRef: "fake:l1" }, useCaseKey: "lockup" };
  const jurCtx: AssetContext = { ref: { id: "j1", chainId: "fake", contractRef: "fake:j1" }, useCaseKey: "jurisdiction" };
  const jurTreasuryCtx: AssetContext = { ref: { id: "j2", chainId: "fake", contractRef: "fake:j2" }, useCaseKey: "jurisdiction-treasury" };
  const jurTreasuryCtx2: AssetContext = { ref: { id: "j3", chainId: "fake", contractRef: "fake:j3" }, useCaseKey: "jurisdiction-treasury-2" };

  function makeEngine(now: () => string): LifecycleEngine {
    return new LifecycleEngine({
      useCases: new StaticUseCaseSource([HOLDER_LIMIT_UC, LOCKUP_UC, JURISDICTION_UC, JURISDICTION_TREASURY_UC, JURISDICTION_TREASURY_UC_2]),
      rbac: new RbacPolicy(),
      resolveAdapter: () => adapter,
      audit,
      now,
      compliance: provider,
    });
  }

  beforeEach(() => {
    adapter = new FakeAdapter();
    audit = new MemoryAudit();
    provider = new FakeCompliance();
  });

  it("holder limit: allows up to the limit, blocks the limit-exceeding new holder, existing holder unaffected", async () => {
    const engine = makeEngine(() => "2026-01-01T00:00:00.000Z");
    // limit = 2. Currently 0 holders.
    provider.holders = 0;
    await engine.mint(ADMIN, holderCtx, "alice", "100"); // new holder ok (0 < 2)
    provider.holders = 1;
    await engine.mint(ADMIN, holderCtx, "bob", "100"); // new holder ok (1 < 2)
    provider.holders = 2;
    // carol is a NEW holder (balance 0) → 2 >= 2 → blocked
    await expect(engine.mint(ADMIN, holderCtx, "carol", "100")).rejects.toThrow(/HOLDER_LIMIT_EXCEEDED|at most 2 holders/);
    // alice already holds → not counted as new → allowed even at the cap
    await expect(engine.mint(ADMIN, holderCtx, "alice", "50")).resolves.toBeDefined();
  });

  it("lockup: blocks a transfer before lockupDays and allows it after", async () => {
    provider.acquired.set("alice", "2026-01-01T00:00:00.000Z");
    await adapter.mint(lockupCtx.ref, "alice", "100"); // seed balance directly

    // 10 days later → still within 30-day lockup → blocked
    const early = makeEngine(() => "2026-01-11T00:00:00.000Z");
    await expect(engine_transfer(early, lockupCtx, "alice", "bob", "10")).rejects.toThrow(/LOCKUP_ACTIVE|lockup/);

    // 31 days later → lockup elapsed → allowed
    const late = makeEngine(() => "2026-02-01T00:00:00.000Z");
    await expect(engine_transfer(late, lockupCtx, "alice", "bob", "10")).resolves.toBeDefined();
  });

  it("lockup: a never-acquired sender (null acquiredAt) is not locked", async () => {
    const engine = makeEngine(() => "2026-01-11T00:00:00.000Z");
    await adapter.mint(lockupCtx.ref, "treasury", "100");
    // provider.acquiredAt('treasury') is null → allowed
    await expect(engine_transfer(engine, lockupCtx, "treasury", "bob", "10")).resolves.toBeDefined();
  });

  it("jurisdiction: allows an in-list holder, blocks out-of-list and null", async () => {
    const engine = makeEngine(() => "2026-01-01T00:00:00.000Z");
    provider.jurisdictions.set("in-holder", "IN");
    provider.jurisdictions.set("us-holder", "US");
    // null-jurisdiction holder not set → jurisdictionOf returns null

    await expect(engine.mint(ADMIN, jurCtx, "in-holder", "10")).resolves.toBeDefined();
    await expect(engine.mint(ADMIN, jurCtx, "us-holder", "10")).rejects.toThrow(/JURISDICTION_NOT_ALLOWED|not allowed/);
    await expect(engine.mint(ADMIN, jurCtx, "unknown-holder", "10")).rejects.toThrow(/JURISDICTION_NOT_ALLOWED|not allowed/);
  });

  it("treasury exemption: minting to the use case's OWN registered treasury bypasses the jurisdiction gate, even with unknown jurisdiction", async () => {
    const engine = makeEngine(() => "2026-01-01T00:00:00.000Z");
    provider.treasuryAccounts.set("treasury-acct-1", "treasury-addr");
    provider.throwOnJurisdiction = true; // would throw if jurisdictionOf were consulted at all
    // No jurisdictions.set("treasury-addr", ...) — its jurisdiction is genuinely
    // unknown, exactly like a freshly provisionTreasury'd account with no linked
    // user. Without the exemption this would 400 JURISDICTION_NOT_ALLOWED.
    await expect(engine.mint(ADMIN, jurTreasuryCtx, "treasury-addr", "10")).resolves.toBeDefined();
  });

  it("treasury exemption: does NOT exempt a different account, even on a use case that has a registered treasury", async () => {
    const engine = makeEngine(() => "2026-01-01T00:00:00.000Z");
    provider.treasuryAccounts.set("treasury-acct-1", "treasury-addr");
    // "someone-else" is not the registered treasury address — ordinary customer
    // holder rules still apply on this same use case.
    await expect(engine.mint(ADMIN, jurTreasuryCtx, "someone-else", "10")).rejects.toThrow(/JURISDICTION_NOT_ALLOWED|not allowed/);
  });

  it("treasury exemption does NOT leak across use cases: UC1's own treasury address is still gated on UC2, which has a DIFFERENT treasuryAccountId", async () => {
    const engine = makeEngine(() => "2026-01-01T00:00:00.000Z");
    // "treasury-addr" resolves to UC1's treasury (treasury-acct-1) — exempt on
    // jurTreasuryCtx (proven above). UC2's own treasury is a different account
    // (treasury-acct-3) that never maps to "treasury-addr". isUseCaseTreasury is
    // always called with THIS use case's own treasuryAccountId (never a caller
    // argument — see prepare()/ctx.useCaseKey), so it must return false here.
    provider.treasuryAccounts.set("treasury-acct-1", "treasury-addr");
    provider.treasuryAccounts.set("treasury-acct-3", "some-other-address");
    // "treasury-addr"'s jurisdiction is genuinely unknown (no user linked) — same
    // as a real cross-use-case leak would look like if the exemption were wrong.
    await expect(engine.mint(ADMIN, jurTreasuryCtx2, "treasury-addr", "10")).rejects.toThrow(/JURISDICTION_NOT_ALLOWED|not allowed/);
  });

  it("no provider / no rule: engine without a ComplianceProvider skips the rules", async () => {
    // Engine constructed WITHOUT a compliance provider, use case WITH maxHolders set.
    const engine = new LifecycleEngine({
      useCases: new StaticUseCaseSource([HOLDER_LIMIT_UC]),
      rbac: new RbacPolicy(),
      resolveAdapter: () => adapter,
      audit,
      now: () => "2026-01-01T00:00:00.000Z",
      // no compliance
    });
    provider.holders = 99; // would exceed if consulted
    // No provider wired → holder-limit rule is skipped entirely.
    await expect(engine.mint(ADMIN, holderCtx, "alice", "10")).resolves.toBeDefined();
    await expect(engine.mint(ADMIN, holderCtx, "bob", "10")).resolves.toBeDefined();
  });
});

describe("LifecycleEngine — compliance.requireVerifiedIdentity gate", () => {
  let adapter: FakeAdapter;
  let audit: MemoryAudit;
  let provider: FakeCompliance;

  const VERIFIED_ID_UC: UseCaseDefinition = {
    ...FUNGIBLE_USE_CASE,
    key: "verified-id",
    compliance: { allowlist: false, transferRestrictions: true, requireVerifiedIdentity: true },
  };
  const FLAG_OFF_UC: UseCaseDefinition = {
    ...FUNGIBLE_USE_CASE,
    key: "verified-id-off",
    compliance: { allowlist: false, transferRestrictions: true },
  };
  // Same requireVerifiedIdentity gate, but with a registered treasury.
  const VERIFIED_ID_TREASURY_UC: UseCaseDefinition = {
    ...FUNGIBLE_USE_CASE,
    key: "verified-id-treasury",
    treasuryAccountId: "treasury-acct-2",
    compliance: { allowlist: false, transferRestrictions: true, requireVerifiedIdentity: true },
  };

  const idCtx: AssetContext = { ref: { id: "v1", chainId: "fake", contractRef: "fake:v1" }, useCaseKey: "verified-id" };
  const offCtx: AssetContext = { ref: { id: "v2", chainId: "fake", contractRef: "fake:v2" }, useCaseKey: "verified-id-off" };
  const idTreasuryCtx: AssetContext = { ref: { id: "v3", chainId: "fake", contractRef: "fake:v3" }, useCaseKey: "verified-id-treasury" };

  function makeEngine(): LifecycleEngine {
    return new LifecycleEngine({
      useCases: new StaticUseCaseSource([VERIFIED_ID_UC, FLAG_OFF_UC, VERIFIED_ID_TREASURY_UC]),
      rbac: new RbacPolicy(),
      resolveAdapter: () => adapter,
      audit,
      now: () => "2026-01-01T00:00:00.000Z",
      compliance: provider,
    });
  }

  beforeEach(() => {
    adapter = new FakeAdapter();
    audit = new MemoryAudit();
    provider = new FakeCompliance();
  });

  it("flag on: blocks mint to an account with no verified identity (IDENTITY_NOT_VERIFIED)", async () => {
    const engine = makeEngine();
    provider.verified.set("alice", false);
    await expect(engine.mint(ADMIN, idCtx, "alice", "10")).rejects.toThrow(/IDENTITY_NOT_VERIFIED|verified identity/);
  });

  it("flag on: blocks transfer to an unverified recipient", async () => {
    const engine = makeEngine();
    provider.verified.set("alice", true);
    await engine.mint(ADMIN, idCtx, "alice", "10");
    provider.verified.set("bob", false);
    await expect(engine.transfer(ADMIN, idCtx, "alice", "bob", "5")).rejects.toThrow(/IDENTITY_NOT_VERIFIED|verified identity/);
  });

  it("flag on: blocks buy delivery to an unverified buyer", async () => {
    const engine = makeEngine();
    provider.verified.set("treasury", true);
    await engine.mint(ADMIN, idCtx, "treasury", "100");
    provider.verified.set("buyer", false);
    await expect(
      engine.buy(ADMIN, idCtx, "treasury", "buyer", "10", { unitPrice: "5", currency: "CBDC-INR", cost: "50" }),
    ).rejects.toThrow(/IDENTITY_NOT_VERIFIED|verified identity/);
  });

  it("flag on: allows mint/transfer/buy once the account is verified", async () => {
    const engine = makeEngine();
    provider.verified.set("alice", true);
    await expect(engine.mint(ADMIN, idCtx, "alice", "10")).resolves.toBeDefined();
    provider.verified.set("bob", true);
    await expect(engine.transfer(ADMIN, idCtx, "alice", "bob", "5")).resolves.toBeDefined();
    expect(await engine.balanceOf(ADMIN, idCtx, "bob")).toBe("5");
    provider.verified.set("buyer", true);
    await expect(
      engine.buy(ADMIN, idCtx, "alice", "buyer", "1", { unitPrice: "5", currency: "CBDC-INR", cost: "5" }),
    ).resolves.toBeDefined();
  });

  it("flag off/absent: never consults hasVerifiedIdentity even if it would reject", async () => {
    const engine = makeEngine();
    provider.throwOnVerify = true; // would throw if consulted at all
    await expect(engine.mint(ADMIN, offCtx, "alice", "10")).resolves.toBeDefined();
    await expect(engine.transfer(ADMIN, offCtx, "alice", "bob", "5")).resolves.toBeDefined();
  });

  it("treasury exemption: minting to the use case's OWN registered treasury bypasses requireVerifiedIdentity", async () => {
    const engine = makeEngine();
    provider.treasuryAccounts.set("treasury-acct-2", "treasury-addr");
    provider.throwOnVerify = true; // would throw if hasVerifiedIdentity were consulted at all
    await expect(engine.mint(ADMIN, idTreasuryCtx, "treasury-addr", "10")).resolves.toBeDefined();
  });

  it("treasury exemption: does NOT exempt a different account on the same treasury-bearing use case", async () => {
    const engine = makeEngine();
    provider.treasuryAccounts.set("treasury-acct-2", "treasury-addr");
    provider.verified.set("someone-else", false);
    await expect(engine.mint(ADMIN, idTreasuryCtx, "someone-else", "10")).rejects.toThrow(/IDENTITY_NOT_VERIFIED|verified identity/);
  });
});

// helper: transfer via the Trader (buy/transfer both use the transfer lifecycle flag).
function engine_transfer(engine: LifecycleEngine, ctx: AssetContext, from: string, to: string, amount: string) {
  return engine.transfer(TRADER, ctx, from, to, amount);
}

describe("LifecycleEngine — secondary market escrow methods", () => {
  const BUYER: Actor = { id: "buyer-1", role: "Buyer" };
  const ESCROW = "escrow-account";
  const META = { unitPrice: "5", currency: "CBDC-INR", cost: "50" };

  // Fungible use case with transfer disabled (for the ACTION_DISABLED path).
  const NO_TRANSFER_FUNGIBLE: UseCaseDefinition = {
    ...FUNGIBLE_USE_CASE,
    key: "no-transfer-fungible",
    compliance: { allowlist: false, transferRestrictions: false },
    lifecycle: { mint: true, transfer: false, burn: true, freeze: true },
  };
  const LOCKUP_UC: UseCaseDefinition = {
    ...FUNGIBLE_USE_CASE,
    key: "lockup",
    compliance: { allowlist: false, transferRestrictions: true, lockupDays: 30 },
  };
  const RULES_UC: UseCaseDefinition = {
    ...FUNGIBLE_USE_CASE,
    key: "rules",
    compliance: { allowlist: false, transferRestrictions: true, maxHolders: 2, allowedJurisdictions: ["IN"], lockupDays: 30 },
  };

  const ctx: AssetContext = { ref: { id: "asset-1", chainId: "fake", contractRef: "fake:asset-1" }, useCaseKey: "generic-asset" };
  const certCtx: AssetContext = { ref: { id: "c1", chainId: "fake", contractRef: "fake:c1" }, useCaseKey: "generic-certificate" };
  const noXferCtx: AssetContext = { ref: { id: "nx1", chainId: "fake", contractRef: "fake:nx1" }, useCaseKey: "no-transfer-fungible" };
  const lockupCtx: AssetContext = { ref: { id: "l1", chainId: "fake", contractRef: "fake:l1" }, useCaseKey: "lockup" };
  const rulesCtx: AssetContext = { ref: { id: "r1", chainId: "fake", contractRef: "fake:r1" }, useCaseKey: "rules" };

  let adapter: FakeAdapter;
  let audit: MemoryAudit;
  let provider: FakeCompliance;

  function makeEngine(now: () => string = () => "2026-01-01T00:00:00.000Z"): LifecycleEngine {
    return new LifecycleEngine({
      useCases: new StaticUseCaseSource([FUNGIBLE_USE_CASE, NO_TRANSFER_USE_CASE, NO_TRANSFER_FUNGIBLE, LOCKUP_UC, RULES_UC]),
      rbac: new RbacPolicy(),
      resolveAdapter: () => adapter,
      audit,
      now,
      compliance: provider,
    });
  }

  beforeEach(() => {
    adapter = new FakeAdapter();
    audit = new MemoryAudit();
    provider = new FakeCompliance();
  });

  describe("escrowList", () => {
    it("moves the seller's balance to the escrow and audits as 'list'", async () => {
      const engine = makeEngine();
      await engine.setAllowed(ADMIN, ctx, "seller", true);
      await engine.setAllowed(ADMIN, ctx, ESCROW, true);
      await engine.mint(ADMIN, ctx, "seller", "100");

      await engine.escrowList(BUYER, ctx, "seller", ESCROW, "40");

      expect(await adapter.balanceOf(ctx.ref, "seller")).toBe("60");
      expect(await adapter.balanceOf(ctx.ref, ESCROW)).toBe("40");
      const last = audit.entries.at(-1)!;
      expect(last.action).toBe("list");
      expect(last.payload).toMatchObject({ seller: "seller", escrow: ESCROW, amount: "40" });
    });

    it("fails loudly when the escrow is not allowlisted", async () => {
      const engine = makeEngine();
      await engine.setAllowed(ADMIN, ctx, "seller", true);
      await engine.mint(ADMIN, ctx, "seller", "100");
      await expect(engine.escrowList(BUYER, ctx, "seller", ESCROW, "10")).rejects.toThrow(/not on the allowlist/);
    });

    it("is blocked by LOCKUP_ACTIVE inside lockupDays and allowed after", async () => {
      provider.acquired.set("seller", "2026-01-01T00:00:00.000Z");
      await adapter.mint(lockupCtx.ref, "seller", "100"); // seed balance directly

      // 10 days later → within the 30-day lockup → blocked
      const early = makeEngine(() => "2026-01-11T00:00:00.000Z");
      await expect(early.escrowList(BUYER, lockupCtx, "seller", ESCROW, "10")).rejects.toThrow(/LOCKUP_ACTIVE|lockup/);

      // 31 days later → lockup elapsed → allowed
      const late = makeEngine(() => "2026-02-01T00:00:00.000Z");
      await expect(late.escrowList(BUYER, lockupCtx, "seller", ESCROW, "10")).resolves.toBeDefined();
      expect(await adapter.balanceOf(lockupCtx.ref, ESCROW)).toBe("10");
    });

    it("is blocked when the seller is frozen", async () => {
      const engine = makeEngine();
      await engine.setAllowed(ADMIN, ctx, "seller", true);
      await engine.setAllowed(ADMIN, ctx, ESCROW, true);
      await engine.mint(ADMIN, ctx, "seller", "100");
      await engine.setFrozen(ISSUER, ctx, "seller", true);
      await expect(engine.escrowList(BUYER, ctx, "seller", ESCROW, "10")).rejects.toThrow(/ACCOUNT_FROZEN|frozen/);
    });

    it("is blocked when lifecycle.transfer is disabled (ACTION_DISABLED)", async () => {
      const engine = makeEngine();
      await adapter.mint(noXferCtx.ref, "seller", "100");
      await expect(engine.escrowList(BUYER, noXferCtx, "seller", ESCROW, "10")).rejects.toThrow(/ACTION_DISABLED|does not allow 'transfer'/);
    });

    it("rejects a non-fungible use case (WRONG_TOKEN_TYPE)", async () => {
      const engine = makeEngine();
      await expect(engine.escrowList(BUYER, certCtx, "seller", ESCROW, "1")).rejects.toThrow(/WRONG_TOKEN_TYPE|non-fungible/);
    });

    it("RBAC — a Buyer may list, an Auditor may not", async () => {
      const engine = makeEngine();
      await engine.setAllowed(ADMIN, ctx, "seller", true);
      await engine.setAllowed(ADMIN, ctx, ESCROW, true);
      await engine.mint(ADMIN, ctx, "seller", "100");
      await expect(engine.escrowList(AUDITOR, ctx, "seller", ESCROW, "10")).rejects.toThrow(/may not perform 'list'/);
      await expect(engine.escrowList(BUYER, ctx, "seller", ESCROW, "10")).resolves.toBeDefined();
    });
  });

  describe("settleFromEscrow", () => {
    it("delivers escrow→buyer and audits as 'buy' with secondary + price meta", async () => {
      const engine = makeEngine();
      await engine.setAllowed(ADMIN, ctx, "seller", true);
      await engine.setAllowed(ADMIN, ctx, ESCROW, true);
      await engine.setAllowed(ADMIN, ctx, "buyer", true);
      await engine.mint(ADMIN, ctx, "seller", "100");
      await engine.escrowList(BUYER, ctx, "seller", ESCROW, "40");

      await engine.settleFromEscrow(BUYER, ctx, ESCROW, "buyer", "10", META);

      expect(await adapter.balanceOf(ctx.ref, ESCROW)).toBe("30");
      expect(await adapter.balanceOf(ctx.ref, "buyer")).toBe("10");
      const last = audit.entries.at(-1)!;
      expect(last.action).toBe("buy");
      expect(last.payload).toMatchObject({
        from: ESCROW,
        to: "buyer",
        amount: "10",
        forced: false,
        secondary: true,
        unitPrice: "5",
        currency: "CBDC-INR",
        cost: "50",
      });
    });

    it("enforces jurisdiction on the buyer (out-of-list and null blocked)", async () => {
      const engine = makeEngine();
      await adapter.mint(rulesCtx.ref, ESCROW, "100"); // seed the escrow directly
      provider.jurisdictions.set("us-buyer", "US");
      // "unknown-buyer" not set → jurisdictionOf returns null
      await expect(engine.settleFromEscrow(BUYER, rulesCtx, ESCROW, "us-buyer", "10", META)).rejects.toThrow(/JURISDICTION_NOT_ALLOWED|not allowed/);
      await expect(engine.settleFromEscrow(BUYER, rulesCtx, ESCROW, "unknown-buyer", "10", META)).rejects.toThrow(/JURISDICTION_NOT_ALLOWED|not allowed/);
    });

    it("enforces the holder limit on a limit-exceeding NEW buyer", async () => {
      const engine = makeEngine();
      await adapter.mint(rulesCtx.ref, ESCROW, "100");
      provider.jurisdictions.set("new-buyer", "IN");
      provider.holders = 2; // at the cap of 2; new-buyer holds 0 → blocked
      await expect(engine.settleFromEscrow(BUYER, rulesCtx, ESCROW, "new-buyer", "10", META)).rejects.toThrow(/HOLDER_LIMIT_EXCEEDED|at most 2 holders/);
    });

    it("does NOT lockup-check the escrow even when the escrow acquired recently (regression)", async () => {
      // The escrow "acquired" yesterday — inside the 30-day lockup window. A
      // plain transfer would throw LOCKUP_ACTIVE; settleFromEscrow must not.
      provider.acquired.set(ESCROW, "2026-01-10T00:00:00.000Z");
      provider.jurisdictions.set("buyer", "IN");
      provider.holders = 0;
      await adapter.mint(rulesCtx.ref, ESCROW, "100");

      const engine = makeEngine(() => "2026-01-11T00:00:00.000Z");
      // Sanity: the same movement via `transfer` IS blocked by the escrow's lockup.
      await expect(engine.transfer(ADMIN, rulesCtx, ESCROW, "buyer", "10")).rejects.toThrow(/LOCKUP_ACTIVE|lockup/);
      // The escrow-aware settle succeeds: lockup is a seller-side, list-time rule.
      await expect(engine.settleFromEscrow(BUYER, rulesCtx, ESCROW, "buyer", "10", META)).resolves.toBeDefined();
      expect(await adapter.balanceOf(rulesCtx.ref, "buyer")).toBe("10");
      expect(audit.entries.at(-1)?.action).toBe("buy");
    });
  });

  describe("escrowRelease", () => {
    it("returns escrow→seller even when jurisdiction/holder rules would block the seller", async () => {
      const engine = makeEngine();
      await adapter.mint(rulesCtx.ref, ESCROW, "100");
      // The seller would fail every buyer-side rule: unknown jurisdiction, at the
      // holder cap with zero balance, and inside lockup. Release must ignore all.
      provider.holders = 2;
      provider.acquired.set("seller", "2026-01-01T00:00:00.000Z");

      await engine.escrowRelease(BUYER, rulesCtx, ESCROW, "seller", "25");

      expect(await adapter.balanceOf(rulesCtx.ref, ESCROW)).toBe("75");
      expect(await adapter.balanceOf(rulesCtx.ref, "seller")).toBe("25");
      const last = audit.entries.at(-1)!;
      expect(last.action).toBe("cancel-listing");
      expect(last.payload).toMatchObject({ escrow: ESCROW, seller: "seller", amount: "25" });
    });

    it("is blocked when the seller is frozen", async () => {
      const engine = makeEngine();
      await engine.setAllowed(ADMIN, ctx, "seller", true);
      await engine.setAllowed(ADMIN, ctx, ESCROW, true);
      await engine.mint(ADMIN, ctx, "seller", "100");
      await engine.escrowList(BUYER, ctx, "seller", ESCROW, "40");
      await engine.setFrozen(ISSUER, ctx, "seller", true);
      await expect(engine.escrowRelease(BUYER, ctx, ESCROW, "seller", "40")).rejects.toThrow(/ACCOUNT_FROZEN|frozen/);
    });

    it("RBAC — a Buyer may cancel, an Auditor may not", async () => {
      const engine = makeEngine();
      await engine.setAllowed(ADMIN, ctx, "seller", true);
      await engine.setAllowed(ADMIN, ctx, ESCROW, true);
      await engine.mint(ADMIN, ctx, "seller", "100");
      await engine.escrowList(BUYER, ctx, "seller", ESCROW, "40");
      await expect(engine.escrowRelease(AUDITOR, ctx, ESCROW, "seller", "40")).rejects.toThrow(/may not perform 'cancel-listing'/);
      await expect(engine.escrowRelease(BUYER, ctx, ESCROW, "seller", "40")).resolves.toBeDefined();
    });
  });
});
