import { PolicyError } from "./errors.js";
import type { RbacPolicy } from "./rbac.js";
import { validateMetadata } from "./validation.js";
import type {
  Actor,
  AssetContext,
  AssetRef,
  AuditRecord,
  AuditSink,
  LedgerAdapter,
  LifecycleAction,
  TokenType,
  TxReceipt,
  UseCaseDefinition,
  UseCaseSource,
} from "./types.js";

export interface IssueInput {
  useCaseKey: string;
  id: string;
  name: string;
  symbol: string;
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

  constructor(deps: LifecycleEngineDeps) {
    this.useCases = deps.useCases;
    this.rbac = deps.rbac;
    this.resolveAdapter = deps.resolveAdapter;
    this.audit = deps.audit;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async issue(actor: Actor, input: IssueInput): Promise<IssueResult> {
    this.rbac.authorize(actor, "issue");
    const useCase = await this.useCases.get(input.useCaseKey);
    if (!useCase.allowedChainIds.includes(input.chainId)) {
      throw new PolicyError("CHAIN_NOT_ALLOWED", `use case '${useCase.key}' cannot deploy to chain '${input.chainId}'`, {
        useCase: useCase.key,
        chainId: input.chainId,
        allowedChainIds: useCase.allowedChainIds,
      });
    }
    validateMetadata(input.metadata, useCase.metadataSchema);

    const adapter = this.resolveAdapter(input.chainId);
    const deploy = await adapter.deployAsset({
      id: input.id,
      name: input.name,
      symbol: input.symbol,
      useCaseKey: useCase.key,
      tokenType: useCase.tokenType,
      tokenStandard: useCase.tokenStandard,
      allowlistEnabled: useCase.compliance.allowlist,
      metadata: input.metadata,
    });

    const ref: AssetRef = { id: input.id, chainId: input.chainId, contractRef: deploy.contractRef };
    await this.write(actor, "issue", {
      assetId: input.id,
      txHash: deploy.txHash,
      chainId: input.chainId,
      payload: { useCaseKey: useCase.key, name: input.name, symbol: input.symbol, tokenStandard: useCase.tokenStandard },
    });
    return { ref, tokenType: useCase.tokenType, txHash: deploy.txHash };
  }

  // --- fungible operations (ERC-20 / ERC-3643) -----------------------------

  async mint(actor: Actor, ctx: AssetContext, to: string, amount: string): Promise<TxReceipt> {
    const { adapter, useCase } = await this.prepare(actor, ctx, "mint");
    this.requireFungible(useCase);
    this.requireLifecycle(useCase, "mint");
    await this.requireAllowed(adapter, ctx.ref, useCase, [to]);
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
    const receipt = await adapter.transfer(ctx.ref, from, to, amount);
    await this.writeReceipt(actor, "transfer", ctx, receipt, { from, to, amount });
    return receipt;
  }

  async burn(actor: Actor, ctx: AssetContext, from: string, amount: string): Promise<TxReceipt> {
    const { adapter, useCase } = await this.prepare(actor, ctx, "burn");
    this.requireFungible(useCase);
    this.requireLifecycle(useCase, "burn");
    const receipt = await adapter.burn(ctx.ref, from, amount);
    await this.writeReceipt(actor, "burn", ctx, receipt, { from, amount });
    return receipt;
  }

  // --- non-fungible operations (ERC-721) -----------------------------------

  async mintToken(actor: Actor, ctx: AssetContext, to: string, tokenId: string, uri?: string): Promise<TxReceipt> {
    const { adapter, useCase } = await this.prepare(actor, ctx, "mint");
    this.requireNonFungible(useCase);
    this.requireLifecycle(useCase, "mint");
    await this.requireAllowed(adapter, ctx.ref, useCase, [to]);
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
    const receipt = await adapter.transferToken(ctx.ref, from, to, tokenId);
    await this.writeReceipt(actor, "transfer", ctx, receipt, { from, to, tokenId });
    return receipt;
  }

  async burnToken(actor: Actor, ctx: AssetContext, tokenId: string): Promise<TxReceipt> {
    const { adapter, useCase } = await this.prepare(actor, ctx, "burn");
    this.requireNonFungible(useCase);
    this.requireLifecycle(useCase, "burn");
    const receipt = await adapter.burnToken(ctx.ref, tokenId);
    await this.writeReceipt(actor, "burn", ctx, receipt, { tokenId });
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
      payload: fields.payload,
      txHash: fields.txHash,
      chainId: fields.chainId,
      at: this.now(),
    };
    await this.audit.record(entry);
  }
}
