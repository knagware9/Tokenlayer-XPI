import { PolicyError } from "./errors.js";
import type { RbacPolicy } from "./rbac.js";
import { validateMetadata } from "./validation.js";
import type {
  Actor,
  AssetContext,
  AssetRef,
  AuditRecord,
  AuditSink,
  ComplianceProvider,
  LedgerAdapter,
  LifecycleAction,
  TokenType,
  TxReceipt,
  UseCaseContract,
  UseCaseDefinition,
  UseCaseSource,
} from "./types.js";

export interface IssueInput {
  useCaseKey: string;
  id: string;
  chainId: string;
  metadata: Record<string, unknown>;
}

export interface IssueResult {
  ref: AssetRef;
  tokenType: TokenType;
  txHash: string;
}

export interface LifecycleEngineDeps {
  useCases: UseCaseSource;
  rbac: RbacPolicy;
  /** Maps a chainId to its adapter; throws if the chain is not configured. */
  resolveAdapter: (chainId: string) => LedgerAdapter;
  audit: AuditSink;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  /**
   * Supplies holder/KYC/timing data for data-dependent compliance rules
   * (maxHolders / lockupDays / allowedJurisdictions). Optional: when absent,
   * those rules are skipped so existing use cases behave exactly as before.
   */
  compliance?: ComplianceProvider;
}

/**
 * The single chokepoint for every state change. It enforces, in order:
 *   1. RBAC      — may this role perform this action?
 *   2. Lifecycle — is this action enabled for the asset's use case?
 *   3. Token type — fungible vs non-fungible operations are kept separate.
 *   4. Compliance — allowlist / freeze rules.
 * then dispatches to the bound ledger adapter and records an audit entry.
 *
 * Because all policy lives here (not in any adapter), behaviour is identical
 * across every chain and every token standard.
 */
export class LifecycleEngine {
  private readonly useCases: UseCaseSource;
  private readonly rbac: RbacPolicy;
  private readonly resolveAdapter: (chainId: string) => LedgerAdapter;
  private readonly audit: AuditSink;
  private readonly now: () => string;
  private readonly compliance?: ComplianceProvider;

  constructor(deps: LifecycleEngineDeps) {
    this.useCases = deps.useCases;
    this.rbac = deps.rbac;
    this.resolveAdapter = deps.resolveAdapter;
    this.audit = deps.audit;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.compliance = deps.compliance;
  }

  /**
   * Deploy the use case's contract on one chain (config time). The use case owns
   * the contract; issuing assets later mints/registers within it. Returns the
   * contract handle to store on the use case. Throws if the chain is not
   * configured (resolveAdapter) or the deploy fails.
   */
  async deployUseCaseContract(useCase: UseCaseDefinition, chainId: string): Promise<UseCaseContract> {
    const adapter = this.resolveAdapter(chainId);
    const deploy = await adapter.deployAsset({
      id: useCase.key,
      name: useCase.name,
      symbol: useCase.symbol,
      useCaseKey: useCase.key,
      tokenType: useCase.tokenType,
      tokenStandard: useCase.tokenStandard,
      allowlistEnabled: useCase.compliance.allowlist,
      metadata: {},
    });
    return { contractRef: deploy.contractRef, deployTxHash: deploy.txHash };
  }

  /**
   * Bring an asset into existence WITHIN the use case's already-deployed contract
   * on the chosen chain (no per-asset deploy). Fungible assets are tranches minted
   * into the shared token; NFTs are token-ids in the shared collection. The API
   * layer performs the actual mint of initial supply / token-ids around this.
   */
  async issue(actor: Actor, input: IssueInput): Promise<IssueResult> {
    this.rbac.authorize(actor, "issue");
    const useCase = await this.useCases.get(input.useCaseKey);
    if (!useCase.allowedChainIds.includes(input.chainId)) {
      throw new PolicyError("CHAIN_NOT_ALLOWED", `use case '${useCase.key}' cannot issue on chain '${input.chainId}'`, {
        useCase: useCase.key,
        chainId: input.chainId,
        allowedChainIds: useCase.allowedChainIds,
      });
    }
    const contract = useCase.contracts?.[input.chainId];
    if (!contract) {
      throw new PolicyError(
        "USE_CASE_NOT_DEPLOYED_ON_CHAIN",
        `use case '${useCase.key}' has no contract deployed on chain '${input.chainId}' yet`,
        { useCase: useCase.key, chainId: input.chainId },
      );
    }
    validateMetadata(input.metadata, useCase.metadataSchema);

    const ref: AssetRef = { id: input.id, chainId: input.chainId, contractRef: contract.contractRef };
    // The "issue" audit tx is the use-case contract's deploy tx — issuance is a
    // registration step, not itself an on-chain mint. The actual mint of initial
    // supply / token-ids happens in the API layer and is audited separately.
    await this.write(actor, "issue", {
      assetId: input.id,
      txHash: contract.deployTxHash,
      chainId: input.chainId,
      payload: { useCaseKey: useCase.key, symbol: useCase.symbol, tokenStandard: useCase.tokenStandard, contractRef: contract.contractRef },
    });
    return { ref, tokenType: useCase.tokenType, txHash: contract.deployTxHash };
  }

  // --- fungible operations (ERC-20 / ERC-3643) -----------------------------

  async mint(actor: Actor, ctx: AssetContext, to: string, amount: string): Promise<TxReceipt> {
    const { adapter, useCase } = await this.prepare(actor, ctx, "mint");
    this.requireFungible(useCase);
    this.requireLifecycle(useCase, "mint");
    await this.requireAllowed(adapter, ctx.ref, useCase, [to]);
    await this.requireJurisdiction(useCase, to);
    await this.requireHolderLimit(ctx.ref, useCase, adapter, to);
    const receipt = await adapter.mint(ctx.ref, to, amount);
    await this.writeReceipt(actor, "mint", ctx, receipt, { to, amount });
    return receipt;
  }

  async transfer(actor: Actor, ctx: AssetContext, from: string, to: string, amount: string): Promise<TxReceipt> {
    const { adapter, useCase } = await this.prepare(actor, ctx, "transfer");
    this.requireFungible(useCase);
    this.requireLifecycle(useCase, "transfer");
    await this.requireAllowed(adapter, ctx.ref, useCase, [from, to]);
    await this.requireNotFrozen(adapter, ctx.ref, [from, to]);
    await this.requireJurisdiction(useCase, to);
    await this.requireHolderLimit(ctx.ref, useCase, adapter, to);
    await this.requireLockup(ctx.ref, useCase, from);
    const receipt = await adapter.transfer(ctx.ref, from, to, amount);
    await this.writeReceipt(actor, "transfer", ctx, receipt, { from, to, amount, forced: true });
    return receipt;
  }

  /**
   * Buyer-initiated delivery leg of a DvP purchase. Same compliance as `transfer`
   * (fungible, allowlist + freeze on both parties) but authorized under the `buy`
   * action and audited as `buy` with the payment metadata. The API layer performs
   * the cash payment around this call.
   */
  async buy(
    actor: Actor,
    ctx: AssetContext,
    from: string,
    to: string,
    amount: string,
    meta: { unitPrice: string; currency: string; cost: string },
  ): Promise<TxReceipt> {
    const { adapter, useCase } = await this.prepare(actor, ctx, "buy");
    this.requireFungible(useCase);
    // buy reuses the transfer lifecycle flag — there is no separate "buy" flag per use case
    this.requireLifecycle(useCase, "transfer");
    await this.requireAllowed(adapter, ctx.ref, useCase, [from, to]);
    await this.requireNotFrozen(adapter, ctx.ref, [from, to]);
    await this.requireJurisdiction(useCase, to);
    await this.requireHolderLimit(ctx.ref, useCase, adapter, to);
    await this.requireLockup(ctx.ref, useCase, from);
    const receipt = await adapter.transfer(ctx.ref, from, to, amount);
    await this.writeReceipt(actor, "buy", ctx, receipt, { from, to, amount, forced: false, ...meta });
    return receipt;
  }

  async burn(actor: Actor, ctx: AssetContext, from: string, amount: string): Promise<TxReceipt> {
    const { adapter, useCase } = await this.prepare(actor, ctx, "burn");
    this.requireFungible(useCase);
    this.requireLifecycle(useCase, "burn");
    const receipt = await adapter.burn(ctx.ref, from, amount);
    await this.writeReceipt(actor, "burn", ctx, receipt, { from, amount, forced: true });
    return receipt;
  }

  // --- non-fungible operations (ERC-721) -----------------------------------

  async mintToken(actor: Actor, ctx: AssetContext, to: string, tokenId: string, uri?: string): Promise<TxReceipt> {
    const { adapter, useCase } = await this.prepare(actor, ctx, "mint");
    this.requireNonFungible(useCase);
    this.requireLifecycle(useCase, "mint");
    await this.requireAllowed(adapter, ctx.ref, useCase, [to]);
    await this.requireJurisdiction(useCase, to);
    await this.requireHolderLimit(ctx.ref, useCase, adapter, to);
    const receipt = await adapter.mintToken(ctx.ref, to, tokenId, uri);
    await this.writeReceipt(actor, "mint", ctx, receipt, { to, tokenId, uri });
    return receipt;
  }

  async transferToken(actor: Actor, ctx: AssetContext, from: string, to: string, tokenId: string): Promise<TxReceipt> {
    const { adapter, useCase } = await this.prepare(actor, ctx, "transfer");
    this.requireNonFungible(useCase);
    this.requireLifecycle(useCase, "transfer");
    await this.requireAllowed(adapter, ctx.ref, useCase, [from, to]);
    await this.requireNotFrozen(adapter, ctx.ref, [from, to]);
    await this.requireJurisdiction(useCase, to);
    await this.requireHolderLimit(ctx.ref, useCase, adapter, to);
    await this.requireLockup(ctx.ref, useCase, from);
    const receipt = await adapter.transferToken(ctx.ref, from, to, tokenId);
    await this.writeReceipt(actor, "transfer", ctx, receipt, { from, to, tokenId, forced: true });
    return receipt;
  }

  async burnToken(actor: Actor, ctx: AssetContext, tokenId: string): Promise<TxReceipt> {
    const { adapter, useCase } = await this.prepare(actor, ctx, "burn");
    this.requireNonFungible(useCase);
    this.requireLifecycle(useCase, "burn");
    const receipt = await adapter.burnToken(ctx.ref, tokenId);
    await this.writeReceipt(actor, "burn", ctx, receipt, { tokenId, forced: true });
    return receipt;
  }

  async ownerOf(actor: Actor, ctx: AssetContext, tokenId: string): Promise<string | null> {
    this.rbac.authorize(actor, "read");
    return this.resolveAdapter(ctx.ref.chainId).ownerOf(ctx.ref, tokenId);
  }

  async tokensOf(actor: Actor, ctx: AssetContext, account: string): Promise<string[]> {
    this.rbac.authorize(actor, "read");
    return this.resolveAdapter(ctx.ref.chainId).tokensOf(ctx.ref, account);
  }

  // --- compliance ----------------------------------------------------------

  async setFrozen(actor: Actor, ctx: AssetContext, account: string, frozen: boolean): Promise<TxReceipt> {
    const action: LifecycleAction = frozen ? "freeze" : "unfreeze";
    const { adapter, useCase } = await this.prepare(actor, ctx, action);
    this.requireLifecycle(useCase, "freeze");
    const receipt = await adapter.setFrozen(ctx.ref, account, frozen);
    await this.writeReceipt(actor, action, ctx, receipt, { account, frozen });
    return receipt;
  }

  async setAllowed(actor: Actor, ctx: AssetContext, account: string, allowed: boolean): Promise<TxReceipt> {
    const action: LifecycleAction = allowed ? "allow" : "disallow";
    const { adapter, useCase } = await this.prepare(actor, ctx, action);
    if (!useCase.compliance.allowlist) {
      throw new PolicyError("ALLOWLIST_DISABLED", `use case '${useCase.key}' has no allowlist`, { useCase: useCase.key });
    }
    const receipt = await adapter.setAllowed(ctx.ref, account, allowed);
    await this.writeReceipt(actor, action, ctx, receipt, { account, allowed });
    return receipt;
  }

  // --- reads ---------------------------------------------------------------

  async balanceOf(actor: Actor, ctx: AssetContext, account: string): Promise<string> {
    this.rbac.authorize(actor, "read");
    return this.resolveAdapter(ctx.ref.chainId).balanceOf(ctx.ref, account);
  }

  async totalSupply(actor: Actor, ctx: AssetContext): Promise<string> {
    this.rbac.authorize(actor, "read");
    return this.resolveAdapter(ctx.ref.chainId).totalSupply(ctx.ref);
  }

  // --- internals -----------------------------------------------------------

  private async prepare(
    actor: Actor,
    ctx: AssetContext,
    action: LifecycleAction,
  ): Promise<{ adapter: LedgerAdapter; useCase: UseCaseDefinition }> {
    this.rbac.authorize(actor, action);
    const useCase = await this.useCases.get(ctx.useCaseKey);
    const adapter = this.resolveAdapter(ctx.ref.chainId);
    return { adapter, useCase };
  }

  private requireFungible(useCase: UseCaseDefinition): void {
    if (useCase.tokenType !== "fungible") {
      throw new PolicyError("WRONG_TOKEN_TYPE", `use case '${useCase.key}' is non-fungible; use the token operations`, {
        useCase: useCase.key,
      });
    }
  }

  private requireNonFungible(useCase: UseCaseDefinition): void {
    if (useCase.tokenType !== "nonfungible") {
      throw new PolicyError("WRONG_TOKEN_TYPE", `use case '${useCase.key}' is fungible; use the amount operations`, {
        useCase: useCase.key,
      });
    }
  }

  private requireLifecycle(useCase: UseCaseDefinition, flag: keyof UseCaseDefinition["lifecycle"]): void {
    if (!useCase.lifecycle[flag]) {
      throw new PolicyError("ACTION_DISABLED", `use case '${useCase.key}' does not allow '${flag}'`, {
        useCase: useCase.key,
        action: flag,
      });
    }
  }

  private async requireAllowed(
    adapter: LedgerAdapter,
    ref: AssetRef,
    useCase: UseCaseDefinition,
    accounts: string[],
  ): Promise<void> {
    if (!useCase.compliance.allowlist) return;
    for (const account of accounts) {
      if (!(await adapter.isAllowed(ref, account))) {
        throw new PolicyError("NOT_ALLOWLISTED", `account '${account}' is not on the allowlist`, { account });
      }
    }
  }

  private async requireNotFrozen(adapter: LedgerAdapter, ref: AssetRef, accounts: string[]): Promise<void> {
    for (const account of accounts) {
      if (await adapter.isFrozen(ref, account)) {
        throw new PolicyError("ACCOUNT_FROZEN", `account '${account}' is frozen`, { account });
      }
    }
  }

  /**
   * Cap the number of distinct holders. Only a recipient that currently holds
   * nothing (a NEW holder) counts against the cap. No-op unless the rule is set
   * on the use case AND a ComplianceProvider is wired.
   */
  private async requireHolderLimit(
    ref: AssetRef,
    useCase: UseCaseDefinition,
    adapter: LedgerAdapter,
    to: string,
  ): Promise<void> {
    const maxHolders = useCase.compliance.maxHolders;
    if (maxHolders === undefined || !this.compliance) return;
    const isNewHolder = (await adapter.balanceOf(ref, to)) === "0";
    if (!isNewHolder) return;
    const count = await this.compliance.holderCount(ref);
    if (count >= maxHolders) {
      throw new PolicyError(
        "HOLDER_LIMIT_EXCEEDED",
        `use case '${useCase.key}' allows at most ${maxHolders} holders`,
        { useCase: useCase.key, maxHolders, holderCount: count, account: to },
      );
    }
  }

  /**
   * Block a sender from transferring within `lockupDays` of acquiring. A null
   * acquisition time means the sender never acquired (e.g. the mint path) and is
   * allowed. No-op unless the rule is set AND a ComplianceProvider is wired.
   */
  private async requireLockup(ref: AssetRef, useCase: UseCaseDefinition, from: string): Promise<void> {
    const lockupDays = useCase.compliance.lockupDays;
    if (lockupDays === undefined || !this.compliance) return;
    const acq = await this.compliance.acquiredAt(ref, from);
    if (acq === null) return; // never acquired → not locked (mint path)
    const acquiredMs = Date.parse(acq);
    const nowMs = Date.parse(this.now());
    const dayMs = 24 * 60 * 60 * 1000;
    const elapsedDays = (nowMs - acquiredMs) / dayMs;
    if (elapsedDays < lockupDays) {
      const remaining = Math.ceil(lockupDays - elapsedDays);
      throw new PolicyError(
        "LOCKUP_ACTIVE",
        `account '${from}' is within the ${lockupDays}-day lockup (${remaining} day(s) remaining)`,
        { useCase: useCase.key, lockupDays, account: from, daysRemaining: remaining },
      );
    }
  }

  /**
   * Require the recipient's KYC jurisdiction to be in the allowed set. A holder
   * with no known jurisdiction is rejected (fail closed). No-op unless the rule
   * is set AND a ComplianceProvider is wired.
   */
  private async requireJurisdiction(useCase: UseCaseDefinition, to: string): Promise<void> {
    const allowed = useCase.compliance.allowedJurisdictions;
    if (allowed === undefined || !this.compliance) return;
    const j = await this.compliance.jurisdictionOf(to);
    if (j === null || !allowed.includes(j)) {
      throw new PolicyError(
        "JURISDICTION_NOT_ALLOWED",
        `account '${to}' jurisdiction '${j ?? "unknown"}' is not allowed (permitted: ${allowed.join(", ")})`,
        { useCase: useCase.key, account: to, jurisdiction: j, allowedJurisdictions: allowed },
      );
    }
  }

  private async writeReceipt(
    actor: Actor,
    action: LifecycleAction,
    ctx: AssetContext,
    receipt: TxReceipt,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.write(actor, action, {
      assetId: ctx.ref.id,
      txHash: receipt.txHash,
      chainId: receipt.chainId,
      payload,
    });
  }

  private async write(
    actor: Actor,
    action: LifecycleAction,
    fields: { assetId?: string; txHash?: string; chainId?: string; payload: Record<string, unknown> },
  ): Promise<void> {
    const entry: AuditRecord = {
      assetId: fields.assetId,
      actorId: actor.id,
      action,
      // Record the acting role on every entry so operator-initiated actions are attributable.
      payload: { ...fields.payload, actorRole: actor.role },
      txHash: fields.txHash,
      chainId: fields.chainId,
      at: this.now(),
    };
    await this.audit.record(entry);
  }
}
