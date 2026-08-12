import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  ZeroAddress,
  ZeroHash,
  formatEther,
  id,
  type InterfaceAbi,
} from "ethers";
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
import type { CredentialAnchor, DidRegistration, OnChainCredentialStatus } from "./credential-anchor.js";

/**
 * Headroom added to an estimated gas limit. **An estimate is a lower bound, not
 * a budget**, and ethers v6 uses it verbatim — it adds no margin of its own.
 *
 * Measured, not guessed. Booting against live Besu, the only ERC-3643 use case
 * failed to deploy every time while every ERC-20/721 one succeeded. The failing
 * call was `bindIdentityRegistry` on a T-REX proxy, and replayed at the exact
 * parent block Besu contradicted itself: `eth_estimateGas` said 110_159, and
 * `eth_call` at 110_159 reverted, while the true minimum was 113_520.
 *
 * A proxy call is a nested CALL + DELEGATECALL, and EIP-150 lets a frame forward
 * only 63/64 of what it holds — so the caller must RESERVE gas it never spends.
 * A consumption-based estimator cannot see a reserve that is never consumed, so
 * it under-reports precisely for the pattern ERC-3643 is built on.
 *
 * 25% covers the 3.1% observed with room for deeper proxy chains. Unused gas is
 * refunded, so the margin costs nothing at settlement; it only has to stay small
 * enough that the limit clears the sender's balance check and the block limit.
 */
export const GAS_MARGIN_PERCENT = 25n;

/** An estimated limit plus `GAS_MARGIN_PERCENT`. Never below the estimate. */
export function withGasMargin(estimate: bigint): bigint {
  return (estimate * (100n + GAS_MARGIN_PERCENT)) / 100n;
}

/**
 * A signer that assigns operator nonces from a local counter, fetched once and
 * advanced **only after a transaction is successfully broadcast**, and that
 * never sends a bare estimate as a gas limit.
 *
 * This is where ethers' footguns are neutralised for this adapter, and there are
 * four: stale `getTransactionCount` reads under auto-mining (no per-tx
 * re-fetch), contract-method override nonces that ethers silently drops (the
 * nonce is set at the sendTransaction level), the optimistic over-increment of
 * the built-in NonceManager on a compliance revert (which broadcasts nothing, so
 * the counter simply isn't advanced), and the zero-margin gas limit that made
 * every ERC-3643 deploy fail on Besu (see `GAS_MARGIN_PERCENT`).
 *
 * Estimating here rather than letting ethers populate is what makes the margin
 * reachable at all — by the time ethers has populated the transaction the
 * estimate has already become the limit.
 */
export class SerialNonceSigner extends NonceManager {
  private next: number | null = null;

  async sendTransaction(tx: Parameters<NonceManager["sendTransaction"]>[0]): ReturnType<NonceManager["sendTransaction"]> {
    if (this.next === null) {
      this.next = await this.signer.getNonce("latest");
    }
    // ESTIMATE THE TRANSACTION WE WILL ACTUALLY SEND — nonce included.
    //
    // Not cosmetic. `AbstractProvider` memoises `estimateGas` for ~250ms keyed
    // by the request payload, so two identical calls inside that window share
    // one answer — including a REJECTION. The allowlist flow issues exactly
    // that shape: mint to a blocked account (refused), allow the account, mint
    // again (must succeed). Estimating a nonce-less payload makes both requests
    // identical, and the second is served the first's cached refusal.
    //
    // The nonce differs per transaction, so carrying it keeps every estimate on
    // its own cache entry. Letting ethers populate used to do this by accident;
    // doing it here makes it deliberate.
    //
    // An explicit limit is the caller's decision — only fill in what is absent.
    // Estimation still runs BEFORE the counter advances, so a call a contract
    // genuinely refuses throws without burning a nonce.
    const request = { ...tx, nonce: this.next };
    const gasLimit = request.gasLimit ?? withGasMargin(await this.signer.estimateGas(request));
    const response = await this.signer.sendTransaction({ ...request, gasLimit });
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
  /** Registry artifacts. Absent ⇒ registry methods throw when called. */
  registryArtifacts?: { didRegistry: EvmArtifact; vcRegistry: EvmArtifact };
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
export class EvmLedgerAdapter implements LedgerAdapter, CredentialAnchor {
  readonly chainId: string;
  readonly family: ChainFamily = "evm";
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly signer: SerialNonceSigner;
  private readonly artifacts: Record<TokenStandard, EvmArtifact>;
  private readonly registries?: { didRegistry: EvmArtifact; vcRegistry: EvmArtifact };
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
    this.registries = config.registryArtifacts;
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

  // --- CredentialAnchor (on-chain identity registries) ----------------------
  // Commitments are hashed HERE so no caller can get them wrong: keccak256 of the
  // credential id, and of the VC-JWT string (already canonical — no JSON
  // canonicalization step, and therefore none of its fragility).

  private requireRegistryArtifacts(): { didRegistry: EvmArtifact; vcRegistry: EvmArtifact } {
    if (!this.registries) throw new Error("registry artifacts are not configured for this adapter");
    return this.registries;
  }

  async deployRegistries(): Promise<{ didRegistry: string; vcRegistry: string; txHash: string }> {
    return this.serialize(async () => {
      const { didRegistry, vcRegistry } = this.requireRegistryArtifacts();
      const didFactory = new ContractFactory(didRegistry.abi, didRegistry.bytecode, this.signer);
      const did = await didFactory.deploy(this.gasOverrides());
      await did.waitForDeployment();
      const vcFactory = new ContractFactory(vcRegistry.abi, vcRegistry.bytecode, this.signer);
      const vc = await vcFactory.deploy(this.gasOverrides());
      await vc.waitForDeployment();
      return {
        didRegistry: await did.getAddress(),
        vcRegistry: await vc.getAddress(),
        txHash: vc.deploymentTransaction()?.hash ?? "",
      };
    });
  }

  async registerDid(registry: string, did: string): Promise<TxReceipt> {
    const c = new Contract(registry, this.requireRegistryArtifacts().didRegistry.abi, this.signer);
    return this.send((ov) => c.getFunction("registerDid")(did, ov));
  }

  async deactivateDid(registry: string, did: string): Promise<TxReceipt> {
    const c = new Contract(registry, this.requireRegistryArtifacts().didRegistry.abi, this.signer);
    return this.send((ov) => c.getFunction("deactivateDid")(did, ov));
  }

  async didRegistration(registry: string, did: string): Promise<DidRegistration> {
    const c = new Contract(registry, this.requireRegistryArtifacts().didRegistry.abi, this.provider);
    const rec = await c.getFunction("resolve")(did);
    return { registered: BigInt(rec.registeredAt) > 0n, active: Boolean(rec.active) };
  }

  async anchorCredential(
    registry: string,
    credentialId: string,
    vcJwt: string,
    issuedAt: number,
    expiresAt: number,
  ): Promise<TxReceipt> {
    const c = new Contract(registry, this.requireRegistryArtifacts().vcRegistry.abi, this.signer);
    return this.send((ov) => c.getFunction("anchor")(id(credentialId), id(vcJwt), BigInt(issuedAt), BigInt(expiresAt), ov));
  }

  async revokeCredential(registry: string, credentialId: string): Promise<TxReceipt> {
    const c = new Contract(registry, this.requireRegistryArtifacts().vcRegistry.abi, this.signer);
    return this.send((ov) => c.getFunction("revoke")(id(credentialId), ov));
  }

  async credentialStatusOf(registry: string, credentialId: string): Promise<OnChainCredentialStatus> {
    const c = new Contract(registry, this.requireRegistryArtifacts().vcRegistry.abi, this.provider);
    const s = await c.getFunction("statusOf")(id(credentialId));
    return {
      exists: Boolean(s.exists),
      revoked: Boolean(s.revoked),
      revokedAt: BigInt(s.revokedAt) > 0n ? Number(s.revokedAt) : null,
      vcHash: s.exists ? String(s.vcHash) : ZeroHash,
    };
  }
}
