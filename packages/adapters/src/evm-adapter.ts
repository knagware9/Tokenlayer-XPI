import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, ZeroAddress, formatEther, type InterfaceAbi } from "ethers";
import type {
  AssetDeploymentSpec,
  AssetRef,
  ChainFamily,
  DeployResult,
  LedgerAdapter,
  TokenStandard,
  TxReceipt,
} from "@tokenlayer/core";
import { loadTrexArtifacts } from "./trex/artifacts.js";
import { TrexManager, type TrexSuiteRefs } from "./trex/trex-manager.js";

/**
 * A signer that assigns operator nonces from a local counter, fetched once and
 * advanced **only after a transaction is successfully broadcast**. This avoids
 * three ethers footguns at once: stale `getTransactionCount` reads under
 * auto-mining (no per-tx re-fetch), contract-method override nonces that ethers
 * silently drops (the nonce is set at the sendTransaction level), and the
 * optimistic over-increment of the built-in NonceManager on a compliance revert
 * (which broadcasts nothing, so the counter simply isn't advanced).
 */
class SerialNonceSigner extends NonceManager {
  private next: number | null = null;

  async sendTransaction(tx: Parameters<NonceManager["sendTransaction"]>[0]): ReturnType<NonceManager["sendTransaction"]> {
    if (this.next === null) {
      this.next = await this.signer.getNonce("latest");
    }
    const response = await this.signer.sendTransaction({ ...tx, nonce: this.next });
    this.next += 1;
    return response;
  }
}

export interface EvmArtifact {
  abi: InterfaceAbi;
  bytecode: string;
}

/** Gas pricing strategy. "zero" suits free-gas networks like Besu IBFT/dev. */
export type GasMode = "auto" | "zero";

export interface EvmAdapterConfig {
  /** Platform-facing chain id (e.g. "local-evm", "besu", "mst"). */
  chainId?: string;
  rpcUrl: string;
  /** Operator private key — this address becomes each token's sole operator. */
  privateKey: string;
  /** Compiled artifacts, one per supported standard. */
  artifacts: Record<TokenStandard, EvmArtifact>;
  /** Gas pricing: "auto" lets ethers populate (EIP-1559/legacy); "zero" forces gasPrice 0. */
  gas?: GasMode;
  /** Confirmations to await per transaction (1 for instant-finality dev chains). */
  confirmations?: number;
}

/**
 * Drives a real EVM chain (local-evm, Besu, MST, …). Deploys the contract that
 * matches the use case's token standard — ComplianceToken (ERC-20),
 * ComplianceToken3643 (ERC-3643), or ComplianceNFT (ERC-721) — and implements
 * the full LedgerAdapter surface, including non-fungible operations.
 *
 * State-changing calls run through a single-operator mutex with locally-tracked
 * nonces, so transactions never race even when interleaved with compliance
 * reverts that consume no nonce.
 */
export class EvmLedgerAdapter implements LedgerAdapter {
  readonly chainId: string;
  readonly family: ChainFamily = "evm";
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly signer: SerialNonceSigner;
  private readonly artifacts: Record<TokenStandard, EvmArtifact>;
  private readonly gas: GasMode;
  private readonly confirmations: number;
  private queue: Promise<unknown> = Promise.resolve();

  // ERC-3643 assets deploy a real T-REX suite; these track them per token address.
  private trex: TrexManager | null = null;
  private readonly trexSuites = new Map<string, TrexSuiteRefs>();
  private readonly kind = new Map<string, "trex" | "plain">();

  constructor(config: EvmAdapterConfig) {
    this.chainId = config.chainId ?? "local-evm";
    this.provider = new JsonRpcProvider(config.rpcUrl);
    this.wallet = new Wallet(config.privateKey, this.provider);
    this.signer = new SerialNonceSigner(this.wallet);
    this.artifacts = config.artifacts;
    this.gas = config.gas ?? "auto";
    this.confirmations = config.confirmations ?? 1;
  }

  /** Boot-time probe: verifies the RPC answers and reports the operator account. */
  async healthCheck(): Promise<{ chainId: string; operator: string; balance: string }> {
    const network = await this.provider.getNetwork();
    const balance = await this.provider.getBalance(this.wallet.address);
    return { chainId: network.chainId.toString(), operator: this.wallet.address, balance: formatEther(balance) };
  }

  /** Per-transaction gas overrides; the signer owns the nonce. */
  private gasOverrides(): Record<string, unknown> {
    return this.gas === "zero" ? { gasPrice: 0n } : {};
  }

  private trexManager(): TrexManager {
    this.trex ??= new TrexManager(this.signer, this.wallet, () => this.gasOverrides(), loadTrexArtifacts());
    return this.trex;
  }

  /**
   * Returns the T-REX suite for a token address, or null if it is a plain
   * ERC-20/721. Suites deployed this session are cached; otherwise the token is
   * probed for the T-REX-only `identityRegistry()` view. After a restart only a
   * partial suite is recoverable (token + identity registry) — enough for reads,
   * mint, transfer, burn and freeze, but not investor onboarding.
   */
  private async trexRefs(ref: AssetRef): Promise<TrexSuiteRefs | null> {
    const cached = this.trexSuites.get(ref.contractRef);
    if (cached) return cached;
    if (this.kind.get(ref.contractRef) === "plain") return null;
    try {
      const probe = new Contract(ref.contractRef, ["function identityRegistry() view returns (address)"], this.wallet);
      const ir = (await probe.getFunction("identityRegistry")()) as string;
      const partial: TrexSuiteRefs = {
        token: ref.contractRef,
        identityRegistry: ir,
        idFactory: ZeroAddress,
        claimIssuer: ZeroAddress,
        modularCompliance: ZeroAddress,
        countryAllowModule: ZeroAddress,
      };
      this.trexSuites.set(ref.contractRef, partial);
      this.kind.set(ref.contractRef, "trex");
      return partial;
    } catch {
      this.kind.set(ref.contractRef, "plain");
      return null;
    }
  }

  /** Serialise a multi-transaction T-REX operation (deploy suite, onboard investor). */
  private trexOp<T>(fn: () => Promise<T>): Promise<T> {
    return this.serialize(fn);
  }

  /** ABI for fungible + shared compliance calls (selectors match all contracts). */
  private get fungibleAbi(): InterfaceAbi {
    return this.artifacts["ERC-20"].abi;
  }
  private get nftAbi(): InterfaceAbi {
    return this.artifacts["ERC-721"].abi;
  }

  private fungible(ref: AssetRef): Contract {
    return new Contract(ref.contractRef, this.fungibleAbi, this.signer);
  }
  private nft(ref: AssetRef): Contract {
    return new Contract(ref.contractRef, this.nftAbi, this.signer);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Non-serialised single transaction with explicit overrides (advance nonce only on success). */
  private async sendTx(
    build: (overrides: Record<string, unknown>) => Promise<{ hash: string; wait: (c?: number) => Promise<unknown> }>,
  ): Promise<TxReceipt> {
    const tx = await build(this.gasOverrides());
    const receipt = (await tx.wait(this.confirmations)) as { blockNumber?: number } | null;
    return { txHash: tx.hash, chainId: this.chainId, blockNumber: receipt?.blockNumber, timestamp: new Date().toISOString() };
  }

  /** Serialised single transaction (the common case for one-shot operations). */
  private send(
    build: (overrides: Record<string, unknown>) => Promise<{ hash: string; wait: (c?: number) => Promise<unknown> }>,
  ): Promise<TxReceipt> {
    return this.serialize(() => this.sendTx(build));
  }

  async deployAsset(spec: AssetDeploymentSpec): Promise<DeployResult> {
    // ERC-3643 deploys a full, official T-REX suite (ONCHAINID + registries +
    // modular compliance + token), not the simplified contract.
    if (spec.tokenStandard === "ERC-3643") {
      return this.trexOp(async () => {
        const refs = await this.trexManager().deploySuite(spec.name, spec.symbol);
        this.trexSuites.set(refs.token, refs);
        this.kind.set(refs.token, "trex");
        return { contractRef: refs.token, txHash: "" };
      });
    }
    return this.serialize(async () => {
      const artifact = this.artifacts[spec.tokenStandard];
      const factory = new ContractFactory(artifact.abi, artifact.bytecode, this.signer);
      const contract = await factory.deploy(spec.name, spec.symbol, spec.allowlistEnabled, this.gasOverrides());
      const tx = contract.deploymentTransaction();
      await contract.waitForDeployment();
      this.kind.set(await contract.getAddress(), "plain");
      return { contractRef: await contract.getAddress(), txHash: tx?.hash ?? "" };
    });
  }

  // --- fungible ------------------------------------------------------------

  async mint(ref: AssetRef, to: string, amount: string): Promise<TxReceipt> {
    const refs = await this.trexRefs(ref);
    if (refs) return this.send((ov) => this.trexManager().token(refs).mint(to, BigInt(amount), ov));
    return this.send((ov) => this.fungible(ref).getFunction("mint")(to, BigInt(amount), ov));
  }
  async transfer(ref: AssetRef, from: string, to: string, amount: string): Promise<TxReceipt> {
    const refs = await this.trexRefs(ref);
    // Operator-mediated transfer maps to the T-REX agent recovery path; the
    // engine has already enforced allowlist (identity) + freeze policy.
    if (refs) return this.send((ov) => this.trexManager().token(refs).forcedTransfer(from, to, BigInt(amount), ov));
    return this.send((ov) => this.fungible(ref).getFunction("transfer")(from, to, BigInt(amount), ov));
  }
  async burn(ref: AssetRef, from: string, amount: string): Promise<TxReceipt> {
    const refs = await this.trexRefs(ref);
    if (refs) return this.send((ov) => this.trexManager().token(refs).burn(from, BigInt(amount), ov));
    return this.send((ov) => this.fungible(ref).getFunction("burn")(from, BigInt(amount), ov));
  }
  async balanceOf(ref: AssetRef, account: string): Promise<string> {
    return (await this.fungible(ref).getFunction("balanceOf")(account)).toString();
  }
  async totalSupply(ref: AssetRef): Promise<string> {
    return (await this.fungible(ref).getFunction("totalSupply")()).toString();
  }

  // --- non-fungible --------------------------------------------------------

  async mintToken(ref: AssetRef, to: string, tokenId: string, uri = ""): Promise<TxReceipt> {
    return this.send((ov) => this.nft(ref).getFunction("mintToken")(to, BigInt(tokenId), uri, ov));
  }
  async transferToken(ref: AssetRef, from: string, to: string, tokenId: string): Promise<TxReceipt> {
    return this.send((ov) => this.nft(ref).getFunction("transferToken")(from, to, BigInt(tokenId), ov));
  }
  async burnToken(ref: AssetRef, tokenId: string): Promise<TxReceipt> {
    return this.send((ov) => this.nft(ref).getFunction("burnToken")(BigInt(tokenId), ov));
  }
  async ownerOf(ref: AssetRef, tokenId: string): Promise<string | null> {
    const owner = (await this.nft(ref).getFunction("ownerOf")(BigInt(tokenId))) as string;
    return owner === ZeroAddress ? null : owner;
  }
  async tokensOf(ref: AssetRef, account: string): Promise<string[]> {
    const ids = (await this.nft(ref).getFunction("tokensOf")(account)) as bigint[];
    return ids.map((t) => t.toString());
  }

  // --- compliance (shared selectors across all contracts) ------------------

  async setFrozen(ref: AssetRef, account: string, frozen: boolean): Promise<TxReceipt> {
    const refs = await this.trexRefs(ref);
    if (refs) return this.send((ov) => this.trexManager().token(refs).setAddressFrozen(account, frozen, ov));
    return this.send((ov) => this.fungible(ref).getFunction("setFrozen")(account, frozen, ov));
  }
  async setAllowed(ref: AssetRef, account: string, allowed: boolean): Promise<TxReceipt> {
    const refs = await this.trexRefs(ref);
    // For T-REX, "allowed" means an on-chain ONCHAINID identity + KYC claim +
    // registry entry (allowed) or its removal (disallowed).
    if (refs) {
      return this.trexOp(async () => {
        const hash = allowed
          ? (await this.trexManager().registerInvestor(refs, account)).txHash
          : await this.trexManager().removeInvestor(refs, account);
        return { txHash: hash, chainId: this.chainId, timestamp: new Date().toISOString() };
      });
    }
    return this.send(() => this.fungible(ref).getFunction("setAllowed")(account, allowed));
  }
  async isFrozen(ref: AssetRef, account: string): Promise<boolean> {
    // isFrozen(address) shares a selector across ComplianceToken and the T-REX token.
    return (await this.fungible(ref).getFunction("isFrozen")(account)) as boolean;
  }
  async isAllowed(ref: AssetRef, account: string): Promise<boolean> {
    const refs = await this.trexRefs(ref);
    if (refs) return this.trexManager().isVerified(refs, account);
    return (await this.fungible(ref).getFunction("isAllowed")(account)) as boolean;
  }

  /**
   * Anchor an off-ledger hash (an audit chain head) on-ledger by broadcasting a
   * 0-value self-transaction that carries the hash as calldata — permanent,
   * tamper-evident proof the operator observed that head. Routed through the same
   * serialised send/nonce machinery as every other write so it never races.
   */
  async anchor(_ref: AssetRef, hash: string): Promise<TxReceipt> {
    return this.send((ov) => this.signer.sendTransaction({ to: this.wallet.address, value: 0n, data: hash, ...ov }));
  }
}
