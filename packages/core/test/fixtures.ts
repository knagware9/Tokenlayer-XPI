import type {
  AssetDeploymentSpec,
  AssetRef,
  ChainFamily,
  DeployResult,
  LedgerAdapter,
  TxReceipt,
  UseCaseDefinition,
} from "../src/index.js";

/** A tiny deterministic in-memory adapter (fungible + NFT) for core unit tests. */
export class FakeAdapter implements LedgerAdapter {
  readonly chainId = "fake";
  readonly family: ChainFamily = "mock";
  private seq = 0;
  private balances = new Map<string, bigint>();
  private supply = 0n;
  private frozen = new Set<string>();
  private allowed = new Set<string>();
  private owners = new Map<string, string>(); // tokenId -> owner

  private tx(): TxReceipt {
    this.seq += 1;
    return { txHash: `0xfake${this.seq}`, chainId: this.chainId, timestamp: "2026-01-01T00:00:00.000Z" };
  }

  async deployAsset(spec: AssetDeploymentSpec): Promise<DeployResult> {
    return { contractRef: `fake:${spec.id}`, txHash: this.tx().txHash };
  }
  async mint(_ref: AssetRef, to: string, amount: string): Promise<TxReceipt> {
    this.balances.set(to, (this.balances.get(to) ?? 0n) + BigInt(amount));
    this.supply += BigInt(amount);
    return this.tx();
  }
  async transfer(_ref: AssetRef, from: string, to: string, amount: string): Promise<TxReceipt> {
    const amt = BigInt(amount);
    this.balances.set(from, (this.balances.get(from) ?? 0n) - amt);
    this.balances.set(to, (this.balances.get(to) ?? 0n) + amt);
    return this.tx();
  }
  async burn(_ref: AssetRef, from: string, amount: string): Promise<TxReceipt> {
    const amt = BigInt(amount);
    this.balances.set(from, (this.balances.get(from) ?? 0n) - amt);
    this.supply -= amt;
    return this.tx();
  }
  async mintToken(_ref: AssetRef, to: string, tokenId: string): Promise<TxReceipt> {
    this.owners.set(tokenId, to);
    return this.tx();
  }
  async transferToken(_ref: AssetRef, _from: string, to: string, tokenId: string): Promise<TxReceipt> {
    this.owners.set(tokenId, to);
    return this.tx();
  }
  async burnToken(_ref: AssetRef, tokenId: string): Promise<TxReceipt> {
    this.owners.delete(tokenId);
    return this.tx();
  }
  async ownerOf(_ref: AssetRef, tokenId: string): Promise<string | null> {
    return this.owners.get(tokenId) ?? null;
  }
  async tokensOf(_ref: AssetRef, account: string): Promise<string[]> {
    return [...this.owners.entries()].filter(([, o]) => o === account).map(([t]) => t);
  }
  async setFrozen(_ref: AssetRef, account: string, frozen: boolean): Promise<TxReceipt> {
    if (frozen) this.frozen.add(account);
    else this.frozen.delete(account);
    return this.tx();
  }
  async setAllowed(_ref: AssetRef, account: string, allowed: boolean): Promise<TxReceipt> {
    if (allowed) this.allowed.add(account);
    else this.allowed.delete(account);
    return this.tx();
  }
  async balanceOf(_ref: AssetRef, account: string): Promise<string> {
    return (this.balances.get(account) ?? 0n).toString();
  }
  async totalSupply(): Promise<string> {
    return this.supply.toString();
  }
  async isFrozen(_ref: AssetRef, account: string): Promise<boolean> {
    return this.frozen.has(account);
  }
  async isAllowed(_ref: AssetRef, account: string): Promise<boolean> {
    return this.allowed.has(account);
  }
}

export const FUNGIBLE_USE_CASE: UseCaseDefinition = {
  key: "generic-asset",
  name: "Generic Asset",
  tokenStandard: "ERC-20",
  tokenType: "fungible",
  allowedChainIds: ["fake"],
  defaultChainId: "fake",
  metadataSchema: {
    type: "object",
    properties: {
      issuer: { type: "string" },
      valuation: { type: "number" },
    },
    required: ["issuer"],
  },
  lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
  compliance: { allowlist: true, transferRestrictions: true },
  roles: ["Admin", "Issuer", "Operator", "Viewer"],
};

export const NO_TRANSFER_USE_CASE: UseCaseDefinition = {
  key: "generic-certificate",
  name: "Generic Certificate",
  tokenStandard: "ERC-721",
  tokenType: "nonfungible",
  allowedChainIds: ["fake"],
  defaultChainId: "fake",
  metadataSchema: {
    type: "object",
    properties: { holder: { type: "string" } },
    required: ["holder"],
  },
  lifecycle: { mint: true, transfer: false, burn: true, freeze: true },
  compliance: { allowlist: false, transferRestrictions: false },
  roles: ["Admin", "Issuer", "Viewer"],
};
