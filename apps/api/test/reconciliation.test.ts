/**
 * DOES WHAT WE BELIEVE MATCH WHAT THE CHAIN SAYS?
 *
 * Read-only by design. A mismatch has several possible causes and picking one
 * automatically turns a reporting problem into a data-loss problem.
 *
 * Deliberately built on REAL instances — a real `MemoryAssetRepository`, a
 * real `MemoryLedgerTransactionRepository`, and a real `LifecycleEngine` over
 * a small hand-written `LedgerAdapter` — rather than an `as never`-cast stub.
 * `LifecycleEngine` carries private fields, so it is nominally typed: no
 * object literal can stand in for it without a cast, and a cast is exactly
 * what let Ruling O's bug (a hand-built `AssetContext` shaped nothing like
 * the real one) ship looking correct.
 */
import { describe, expect, it } from "vitest";
import {
  LifecycleEngine,
  RbacPolicy,
  StaticUseCaseSource,
  type Actor,
  type AssetDeploymentSpec,
  type AssetRef,
  type AuditRecord,
  type AuditSink,
  type ChainFamily,
  type DeployResult,
  type LedgerAdapter,
  type TxReceipt,
} from "@tokenlayer/core";
import { MemoryAssetRepository, MemoryLedgerTransactionRepository } from "../src/persistence/memory/index.js";
import { reconcile } from "../src/tokenization/reconciliation.js";

const actor: Actor = { id: "u1", role: "PlatformAdmin" };

class NoopAudit implements AuditSink {
  async record(_entry: AuditRecord): Promise<void> {}
}

/**
 * A `LedgerAdapter` whose `totalSupply` is scripted per test. Every other
 * method is unused by `reconcile` (which only ever calls
 * `engine.totalSupply`) and rejects if reached, so a future call reconcile
 * doesn't make yet is caught rather than silently answering "0".
 */
class ScriptedAdapter implements LedgerAdapter {
  readonly chainId: string;
  readonly family: ChainFamily = "evm";
  constructor(chainId: string, private readonly supply: () => Promise<string>) {
    this.chainId = chainId;
  }
  async totalSupply(_ref: AssetRef): Promise<string> {
    return this.supply();
  }
  private unused(): never {
    throw new Error("reconcile does not call this adapter method");
  }
  deployAsset(_spec: AssetDeploymentSpec): Promise<DeployResult> {
    return this.unused();
  }
  mint(_ref: AssetRef, _to: string, _amount: string): Promise<TxReceipt> {
    return this.unused();
  }
  transfer(_ref: AssetRef, _from: string, _to: string, _amount: string): Promise<TxReceipt> {
    return this.unused();
  }
  burn(_ref: AssetRef, _from: string, _amount: string): Promise<TxReceipt> {
    return this.unused();
  }
  balanceOf(_ref: AssetRef, _account: string): Promise<string> {
    return this.unused();
  }
  mintToken(_ref: AssetRef, _to: string, _tokenId: string, _uri?: string): Promise<TxReceipt> {
    return this.unused();
  }
  transferToken(_ref: AssetRef, _from: string, _to: string, _tokenId: string): Promise<TxReceipt> {
    return this.unused();
  }
  burnToken(_ref: AssetRef, _tokenId: string): Promise<TxReceipt> {
    return this.unused();
  }
  ownerOf(_ref: AssetRef, _tokenId: string): Promise<string | null> {
    return this.unused();
  }
  tokensOf(_ref: AssetRef, _account: string): Promise<string[]> {
    return this.unused();
  }
  setFrozen(_ref: AssetRef, _account: string, _frozen: boolean): Promise<TxReceipt> {
    return this.unused();
  }
  setAllowed(_ref: AssetRef, _account: string, _allowed: boolean): Promise<TxReceipt> {
    return this.unused();
  }
  isFrozen(_ref: AssetRef, _account: string): Promise<boolean> {
    return this.unused();
  }
  isAllowed(_ref: AssetRef, _account: string): Promise<boolean> {
    return this.unused();
  }
  anchor(_ref: AssetRef, _hash: string): Promise<TxReceipt> {
    return this.unused();
  }
}

/** One or more assets on chain "besu", backed by `adapter` when present — absent means resolveAdapter throws, i.e. an unconfigured/unreachable chain. */
async function setup(adapter: ScriptedAdapter | null, assetIds: string[] = ["a1"]) {
  const assets = new MemoryAssetRepository();
  const ledgerTransactions = new MemoryLedgerTransactionRepository();
  const engine = new LifecycleEngine({
    useCases: new StaticUseCaseSource([]),
    rbac: new RbacPolicy(),
    resolveAdapter: (chainId) => {
      if (adapter && chainId === adapter.chainId) return adapter;
      throw new Error(`chain '${chainId}' is not configured`);
    },
    audit: new NoopAudit(),
  });
  for (const id of assetIds) {
    await assets.create({
      id, useCaseKey: "u", name: "Asset", symbol: "AST", chainId: "besu", contractRef: "0xC",
      tokenType: "fungible", tokenStandard: "ERC-20", metadata: {}, status: "active", createdBy: "u1",
      unitPrice: null, currency: null, treasuryAccount: null,
    });
  }
  const deps = { assets, engine, ledgerTransactions };
  return { deps, ledgerTransactions };
}

describe("reconcile", () => {
  it("reports nothing when belief and chain agree", async () => {
    const { deps } = await setup(new ScriptedAdapter("besu", async () => "100"));
    const report = await reconcile(deps, actor, { believedSupply: async () => "100" });
    expect(report.checked).toBe(1);
    expect(report.drifted).toEqual([]);
  });

  it("reports drift when the chain holds less than the register claims", async () => {
    // The observed failure: register says issued, chain never minted.
    const { deps } = await setup(new ScriptedAdapter("besu", async () => "0"));
    const report = await reconcile(deps, actor, { believedSupply: async () => "510" });
    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0]).toMatchObject({ assetId: "a1", believedSupply: "510", chainSupply: "0", reason: "supply-mismatch" });
  });

  it("reports an unreadable chain as drift with a distinct reason, not as zero", async () => {
    // Reading "absent" as 0 would invent a discrepancy on every asset whenever a
    // chain is down — the alarm that trains people to ignore alarms.
    const { deps } = await setup(null); // resolveAdapter throws for every chainId
    const report = await reconcile(deps, actor, { believedSupply: async () => "510" });
    expect(report.drifted[0]?.chainSupply).toBeNull();
    expect(report.drifted[0]?.reason).toBe("chain-unreadable");
  });

  it("counts outstanding transactions so pending work is not read as drift", async () => {
    const { deps, ledgerTransactions } = await setup(new ScriptedAdapter("besu", async () => "0"));
    await ledgerTransactions.record({ chainId: "besu", txHash: "0x1", kind: "mint", assetId: "a1", submittedAt: "2026-08-18T10:00:00.000Z" });
    const report = await reconcile(deps, actor, { believedSupply: async () => "510" });
    expect(report.drifted[0]?.outstanding).toBe(1);
    expect(report.drifted[0]?.reason).toBe("settlement-outstanding");
  });

  it("says we have NO RECORD for an asset that predates the ledger table, instead of asserting drift", async () => {
    // RULING Z. An asset issued before this branch has no ledger rows at all,
    // so its derived belief is 0 against a real chain supply — and calling that
    // `supply-mismatch` reports every pre-existing asset as drifted, forever.
    // `believedSupply` here is the REAL derivation (settledSupply over zero
    // rows), not a stub, because the whole point is that 0 and "never recorded"
    // are indistinguishable from the number alone.
    const { deps, ledgerTransactions } = await setup(new ScriptedAdapter("besu", async () => "3000"));
    const report = await reconcile(deps, actor, { believedSupply: (id) => ledgerTransactions.settledSupply(id) });
    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0]).toMatchObject({ assetId: "a1", believedSupply: "0", chainSupply: "3000", outstanding: 0, reason: "no-ledger-record" });
  });

  it("still reports supply-mismatch once the asset HAS records — a settled zero is not the same as no record", async () => {
    // The boundary: one confirmed mint and one confirmed burn net to 0, which
    // is a belief the ledger genuinely supports. Disagreement with the chain
    // there is a real discrepancy to investigate, not missing history.
    const { deps, ledgerTransactions } = await setup(new ScriptedAdapter("besu", async () => "3000"));
    const minted = await ledgerTransactions.record({ chainId: "besu", txHash: "0xm", kind: "mint", amount: "500", assetId: "a1", submittedAt: "2026-08-18T10:00:00.000Z" });
    await ledgerTransactions.settle(minted.id, { status: "confirmed", blockNumber: 1, confirmedAt: "2026-08-18T10:00:01.000Z" });
    const burned = await ledgerTransactions.record({ chainId: "besu", txHash: "0xb", kind: "burn", amount: "500", assetId: "a1", submittedAt: "2026-08-18T10:00:02.000Z" });
    await ledgerTransactions.settle(burned.id, { status: "confirmed", blockNumber: 2, confirmedAt: "2026-08-18T10:00:03.000Z" });

    const report = await reconcile(deps, actor, { believedSupply: (id) => ledgerTransactions.settledSupply(id) });
    expect(report.drifted[0]).toMatchObject({ believedSupply: "0", chainSupply: "3000", reason: "supply-mismatch" });
  });

  it("pages through every asset rather than stopping at the first page", async () => {
    // RULING R: a single-page read silently drops whatever lies past it — a
    // report that says "checked: 1, drifted: 0" while a second asset was never
    // looked at is a confident wrong answer. `limit: 1` forces two assets into
    // two pages; `checked` must still count both, not just the first page.
    const { deps } = await setup(new ScriptedAdapter("besu", async () => "100"), ["a1", "a2"]);
    const report = await reconcile(deps, actor, { believedSupply: async () => "100", limit: 1 });
    expect(report.checked).toBe(2);
    expect(report.drifted).toEqual([]);
  });
});
