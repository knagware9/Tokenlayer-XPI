import type {
  AssetDeploymentSpec,
  AssetRef,
  ChainFamily,
  DeployResult,
  LedgerAdapter,
  TxReceipt,
} from "@tokenlayer/core";
import { SimulatedLedger, type LedgerHydration } from "./simulated-ledger.js";

export type { LedgerHydration } from "./simulated-ledger.js";

/**
 * Base adapter for any simulated DLT. Owns a SimulatedLedger and synthesises
 * receipts; subclasses only declare their chain id, family, and ref prefix.
 * Real SDK-backed adapters (Fabric chaincode, Canton/Daml) would implement the
 * same LedgerAdapter surface in place of this.
 */
export abstract class SimulatedAdapter implements LedgerAdapter {
  abstract readonly chainId: string;
  abstract readonly family: ChainFamily;
  protected readonly ledger = new SimulatedLedger();
  private seq = 0;

  private receipt(): TxReceipt {
    this.seq += 1;
    return {
      txHash: `0x${this.chainId}${this.seq.toString(16).padStart(8, "0")}`,
      chainId: this.chainId,
      blockNumber: this.seq,
      timestamp: new Date().toISOString(),
    };
  }

  async deployAsset(spec: AssetDeploymentSpec): Promise<DeployResult> {
    const contractRef = `${this.chainId}:${spec.id}`;
    this.ledger.create(contractRef, spec.tokenType, spec.allowlistEnabled);
    return { contractRef, txHash: this.receipt().txHash };
  }

  async mint(ref: AssetRef, to: string, amount: string): Promise<TxReceipt> {
    this.ledger.mint(ref.contractRef, to, amount);
    return this.receipt();
  }
  async transfer(ref: AssetRef, from: string, to: string, amount: string): Promise<TxReceipt> {
    this.ledger.transfer(ref.contractRef, from, to, amount);
    return this.receipt();
  }
  async burn(ref: AssetRef, from: string, amount: string): Promise<TxReceipt> {
    this.ledger.burn(ref.contractRef, from, amount);
    return this.receipt();
  }
  async balanceOf(ref: AssetRef, account: string): Promise<string> {
    return this.ledger.balanceOf(ref.contractRef, account);
  }
  async totalSupply(ref: AssetRef): Promise<string> {
    return this.ledger.totalSupply(ref.contractRef);
  }

  async mintToken(ref: AssetRef, to: string, tokenId: string, uri?: string): Promise<TxReceipt> {
    this.ledger.mintToken(ref.contractRef, to, tokenId, uri);
    return this.receipt();
  }
  async transferToken(ref: AssetRef, from: string, to: string, tokenId: string): Promise<TxReceipt> {
    this.ledger.transferToken(ref.contractRef, from, to, tokenId);
    return this.receipt();
  }
  async burnToken(ref: AssetRef, tokenId: string): Promise<TxReceipt> {
    this.ledger.burnToken(ref.contractRef, tokenId);
    return this.receipt();
  }
  async ownerOf(ref: AssetRef, tokenId: string): Promise<string | null> {
    return this.ledger.ownerOf(ref.contractRef, tokenId);
  }
  async tokensOf(ref: AssetRef, account: string): Promise<string[]> {
    return this.ledger.tokensOf(ref.contractRef, account);
  }

  async setFrozen(ref: AssetRef, account: string, frozen: boolean): Promise<TxReceipt> {
    this.ledger.setFrozen(ref.contractRef, account, frozen);
    return this.receipt();
  }
  async setAllowed(ref: AssetRef, account: string, allowed: boolean): Promise<TxReceipt> {
    this.ledger.setAllowed(ref.contractRef, account, allowed);
    return this.receipt();
  }
  async isFrozen(ref: AssetRef, account: string): Promise<boolean> {
    return this.ledger.isFrozen(ref.contractRef, account);
  }
  async isAllowed(ref: AssetRef, account: string): Promise<boolean> {
    return this.ledger.isAllowed(ref.contractRef, account);
  }

  /** See SimulatedLedger.hydrate — reconstructs this contract's state from a
   *  durable audit trail rather than a live operation (used at boot). */
  hydrate(ref: AssetRef, state: LedgerHydration): void {
    this.ledger.hydrate(ref.contractRef, state);
  }

  /** Record an off-ledger hash as a synthesised on-ledger anchor transaction. */
  async anchor(ref: AssetRef, hash: string): Promise<TxReceipt> {
    const list = this.anchors.get(ref.contractRef) ?? [];
    list.push(hash);
    this.anchors.set(ref.contractRef, list);
    return this.receipt();
  }
  private readonly anchors = new Map<string, string[]>();
}

/** Generic in-memory chain. */
export class MockLedgerAdapter extends SimulatedAdapter {
  readonly chainId: string;
  readonly family: ChainFamily = "mock";
  constructor(chainId = "mock") {
    super();
    this.chainId = chainId;
  }
}

/** Simulated Hyperledger Fabric (chaincode-style operator ledger). */
export class FabricLedgerAdapter extends SimulatedAdapter {
  readonly chainId: string;
  readonly family: ChainFamily = "fabric";
  constructor(chainId = "fabric") {
    super();
    this.chainId = chainId;
  }
}

/** Simulated Canton (party-based ledger). */
export class CantonLedgerAdapter extends SimulatedAdapter {
  readonly chainId: string;
  readonly family: ChainFamily = "canton";
  constructor(chainId = "canton") {
    super();
    this.chainId = chainId;
  }
}
