import type {
  AssetDeploymentSpec,
  AssetRef,
  ChainFamily,
  DeployResult,
  LedgerAdapter,
  TxReceipt,
} from "@tokenlayer/core";

export interface FabricAdapterConfig {
  chainId?: string;
  /** Path to a Fabric connection profile JSON. */
  connectionProfile: string;
  /** Filesystem wallet directory holding the operator identity. */
  walletPath: string;
  /** Identity label within the wallet. */
  identity: string;
  channel?: string;
  chaincode?: string;
}

/**
 * Real Hyperledger Fabric adapter. Drives the `tokenlayer` Go chaincode (see
 * infra/fabric/chaincode) through the fabric-network Gateway SDK, mapping each
 * LedgerAdapter operation to a chaincode transaction. Compliance (allowlist +
 * freeze) is enforced in the chaincode, mirroring the EVM contracts and the
 * simulated ledger.
 *
 * The fabric-network SDK is imported dynamically so it is an optional dependency:
 * this adapter is only constructed when FABRIC_CONNECTION_PROFILE is configured,
 * and falls back to the simulated Fabric adapter otherwise. NOTE: requires a
 * running Fabric network + deployed chaincode; not exercised in CI.
 */
export class FabricLedgerAdapter implements LedgerAdapter {
  readonly chainId: string;
  readonly family: ChainFamily = "fabric";
  private readonly channel: string;
  private readonly chaincode: string;
  private contractPromise: Promise<any> | null = null;

  constructor(private readonly config: FabricAdapterConfig) {
    this.chainId = config.chainId ?? "fabric";
    this.channel = config.channel ?? "mychannel";
    this.chaincode = config.chaincode ?? "tokenlayer";
  }

  /** Lazily connect to the gateway and resolve the chaincode contract handle. */
  private contract(): Promise<any> {
    this.contractPromise ??= (async () => {
      const sdk = "fabric-network";
      const { Gateway, Wallets } = (await import(sdk)) as any;
      const { readFile } = await import("node:fs/promises");
      const ccp = JSON.parse(await readFile(this.config.connectionProfile, "utf8"));
      const wallet = await Wallets.newFileSystemWallet(this.config.walletPath);
      const gateway = new Gateway();
      await gateway.connect(ccp, {
        wallet,
        identity: this.config.identity,
        discovery: { enabled: true, asLocalhost: true },
      });
      const network = await gateway.getNetwork(this.channel);
      return network.getContract(this.chaincode);
    })();
    return this.contractPromise;
  }

  private async submit(fn: string, ...args: string[]): Promise<TxReceipt> {
    const contract = await this.contract();
    const tx = contract.createTransaction(fn);
    await tx.submit(...args);
    return { txHash: tx.getTransactionId(), chainId: this.chainId, timestamp: new Date().toISOString() };
  }

  private async evaluate(fn: string, ...args: string[]): Promise<string> {
    const contract = await this.contract();
    const result = await contract.evaluateTransaction(fn, ...args);
    return Buffer.from(result).toString("utf8");
  }

  async deployAsset(spec: AssetDeploymentSpec): Promise<DeployResult> {
    const ref = `fabric:${spec.id}`;
    await this.submit("DeployAsset", ref, spec.tokenType, String(spec.allowlistEnabled));
    return { contractRef: ref, txHash: ref };
  }

  mint = (ref: AssetRef, to: string, amount: string) => this.submit("Mint", ref.contractRef, to, amount);
  transfer = (ref: AssetRef, from: string, to: string, amount: string) =>
    this.submit("Transfer", ref.contractRef, from, to, amount);
  burn = (ref: AssetRef, from: string, amount: string) => this.submit("Burn", ref.contractRef, from, amount);
  mintToken = (ref: AssetRef, to: string, tokenId: string, uri = "") =>
    this.submit("MintToken", ref.contractRef, to, tokenId, uri);
  transferToken = (ref: AssetRef, from: string, to: string, tokenId: string) =>
    this.submit("TransferToken", ref.contractRef, from, to, tokenId);
  burnToken = (ref: AssetRef, tokenId: string) => this.submit("BurnToken", ref.contractRef, tokenId);
  setFrozen = (ref: AssetRef, account: string, frozen: boolean) =>
    this.submit("SetFrozen", ref.contractRef, account, String(frozen));
  setAllowed = (ref: AssetRef, account: string, allowed: boolean) =>
    this.submit("SetAllowed", ref.contractRef, account, String(allowed));

  async balanceOf(ref: AssetRef, account: string): Promise<string> {
    return this.evaluate("BalanceOf", ref.contractRef, account);
  }
  async totalSupply(ref: AssetRef): Promise<string> {
    return this.evaluate("TotalSupply", ref.contractRef);
  }
  async ownerOf(ref: AssetRef, tokenId: string): Promise<string | null> {
    const owner = await this.evaluate("OwnerOf", ref.contractRef, tokenId);
    return owner === "" ? null : owner;
  }
  async tokensOf(ref: AssetRef, account: string): Promise<string[]> {
    const json = await this.evaluate("TokensOf", ref.contractRef, account);
    return json ? (JSON.parse(json) as string[]) : [];
  }
  async isFrozen(ref: AssetRef, account: string): Promise<boolean> {
    return (await this.evaluate("IsFrozen", ref.contractRef, account)) === "true";
  }
  async isAllowed(ref: AssetRef, account: string): Promise<boolean> {
    return (await this.evaluate("IsAllowed", ref.contractRef, account)) === "true";
  }
}
