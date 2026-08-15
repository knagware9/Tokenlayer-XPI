/**
 * Side-effect cores of the gatable operations, shared by the direct routes
 * (ungated) and the maker-checker approval service (gated — executed as the
 * PROPOSER's actor identity). Failures throw CodedError so callers map them to
 * an HTTP reply or a proposal `error`. Callers are responsible for the
 * request-time policy pre-checks (capability, NOT_DUE, COUPONS_OUTSTANDING,
 * payer resolution + scoping); these cores re-validate the data-dependent
 * guards (open listings, funds, holders) at execution time.
 */
import type { Actor } from "@tokenlayer/core";
import { splitProRata } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import { emitEvent, ownerOrgOfUseCase } from "./events.js";
import { foldAsset } from "../tokenization/holders.js";
import { contextOf } from "../http/support.js";
import type { AssetRecord, CashflowRecord } from "../persistence/types/index.js";

export class CodedError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CodedError";
  }
}
export const coded = (statusCode: number, code: string, message: string): CodedError => new CodedError(statusCode, code, message);

/** Minimal logger shape (a Fastify request.log) for compensation warnings. */
interface Logger {
  error(obj: unknown, msg: string): void;
}

/** Current positive balances from the audit fold. listByAsset returns DESC — sort ASC before folding. */
export async function assetBalancesOf(deps: AppDeps, assetId: string): Promise<Map<string, bigint>> {
  const { items } = await deps.audit.listByAsset(assetId, { limit: 100000 });
  const asc = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return foldAsset(asc).balances;
}

/** Drop the payer's own pro-rata share (case-insensitive; address casing is not canonical). */
export function dropPayerShare(split: Map<string, bigint>, payer: string): void {
  const lower = payer.toLowerCase();
  for (const key of [...split.keys()]) if (key.toLowerCase() === lower) split.delete(key);
}

/**
 * Complete an issuance: set sale terms + allowlist the treasury + mint the
 * deferred initial supply + flip status to `active`. Idempotent w.r.t. an
 * already-active asset (the ungated path creates it active; this no-ops the
 * status). Runs the mint/allowlist as `actor`.
 */
export async function executeIssueActivation(
  deps: AppDeps,
  actor: Actor,
  asset: AssetRecord,
  p: { initialSupply?: string; treasury?: string; sale?: { unitPrice: string; currency: string; treasuryAccount: string } },
): Promise<void> {
  if (p.sale) await deps.assets.setSaleTerms(asset.id, p.sale);
  if (p.initialSupply && p.treasury) {
    const ctx = contextOf(asset);
    const useCase = await deps.useCases.get(asset.useCaseKey);
    if (useCase.compliance.allowlist) await deps.engine.setAllowed(actor, ctx, p.treasury, true);
    await deps.engine.mint(actor, ctx, p.treasury, p.initialSupply);
  }
  await deps.assets.setStatus(asset.id, "active");
}

/** The five gatable lifecycle actions (mint/transfer/burn/freeze/unfreeze), engine-dispatched as `actor`. */
export async function runGatedAction(
  deps: AppDeps,
  actor: Actor,
  asset: AssetRecord,
  action: string,
  b: Record<string, string>,
): Promise<{ txHash: string }> {
  const receipt = await dispatchGatedAction(deps, actor, asset, action, b);
  // EN-C. Emitted at THIS chokepoint rather than in the route, because both
  // paths that move tokens come through here: the direct POST
  // /assets/:id/actions/:action AND the maker-checker approval that executes the
  // captured action as the proposer. A route-level emit would silently skip
  // every use case that gates transfers — an integrator would see
  // `proposal.executed` and nothing about the transfer it performed.
  if (action === "transfer" || action === "burn") {
    await emitEvent(deps, {
      type: action === "transfer" ? "asset.transferred" : "asset.redeemed",
      orgId: await ownerOrgOfUseCase(deps, asset.useCaseKey),
      useCaseKey: asset.useCaseKey,
      subjectId: asset.id,
      data: {
        assetId: asset.id, useCaseKey: asset.useCaseKey, chainId: asset.chainId,
        tokenType: asset.tokenType,
        from: b.from ?? null, to: action === "transfer" ? (b.to ?? null) : null,
        amount: b.amount ?? null, tokenId: b.tokenId ?? null,
        actorId: actor.id, txHash: receipt.txHash,
      },
    });
  }
  return receipt;
}

/** The raw ledger dispatch. Split out so `runGatedAction` owns the emit. */
async function dispatchGatedAction(
  deps: AppDeps,
  actor: Actor,
  asset: AssetRecord,
  action: string,
  b: Record<string, string>,
): Promise<{ txHash: string }> {
  const ctx = contextOf(asset);
  const isNft = asset.tokenType === "nonfungible";
  switch (action) {
    case "mint": return isNft ? deps.engine.mintToken(actor, ctx, b.to!, b.tokenId!, b.uri) : deps.engine.mint(actor, ctx, b.to!, b.amount!);
    case "transfer": return isNft ? deps.engine.transferToken(actor, ctx, b.from!, b.to!, b.tokenId!) : deps.engine.transfer(actor, ctx, b.from!, b.to!, b.amount!);
    case "burn": return isNft ? deps.engine.burnToken(actor, ctx, b.tokenId!) : deps.engine.burn(actor, ctx, b.from!, b.amount!);
    case "freeze": return deps.engine.setFrozen(actor, ctx, b.account!, true);
    case "unfreeze": return deps.engine.setFrozen(actor, ctx, b.account!, false);
    default: throw coded(400, "VALIDATION_ERROR", `unknown gated action '${action}'`);
  }
}

/**
 * Execute a validated cashflow: pro-rata payout from `payer` (its own share
 * withheld), redemption additionally burns all balances + matures the asset,
 * then markExecuted + audit. Atomic CAS claim guards concurrent double-payment;
 * on any post-claim failure it refunds what was paid, releases the claim, and
 * rethrows. Throws CodedError for OPEN_LISTINGS / NO_HOLDERS / funds / claim.
 */
export async function executeCashflowCore(
  deps: AppDeps,
  actor: Actor,
  asset: AssetRecord,
  cf: CashflowRecord,
  payer: string,
  log: Logger,
): Promise<CashflowRecord> {
  if (cf.kind === "redemption") {
    const open = await deps.listings.listByAsset(asset.id, "open");
    if (open.length > 0) throw coded(409, "OPEN_LISTINGS_BLOCK_SETTLEMENT", "cancel open listings before settling — escrowed tokens cannot be redeemed");
  }
  const balances = await assetBalancesOf(deps, asset.id);
  const split = splitProRata(BigInt(cf.amount), balances);
  dropPayerShare(split, payer);
  if (split.size === 0) throw coded(400, "NO_HOLDERS", "no positive balances to pay");
  let payable = 0n;
  for (const v of split.values()) payable += v;
  if (BigInt(await deps.cash.balanceOf(cf.currency, payer)) < payable) {
    throw coded(400, "INSUFFICIENT_TREASURY_FUNDS", `payer needs ${payable} ${cf.currency} (record the repayment via /cash/credit first)`);
  }

  // ATOMIC CLAIM — scheduled → executing. From here everything either completes
  // to "executed" or compensates (refunds) and releases back to "scheduled".
  if (!(await deps.cashflows.claim(cf.id))) throw coded(409, "ALREADY_EXECUTED", "this cashflow was already executed");
  const releaseClaim = () =>
    deps.cashflows.release(cf.id).catch((releaseErr) => log.error({ releaseErr, cashflowId: cf.id }, "cashflow claim release failed — row stuck 'executing', manual reconciliation required"));

  const paid: [string, bigint][] = [];
  let executed: CashflowRecord;
  try {
    // Re-check open listings after the claim (closes the create-listing race).
    if (cf.kind === "redemption") {
      const open = await deps.listings.listByAsset(asset.id, "open");
      if (open.length > 0) throw coded(409, "OPEN_LISTINGS_BLOCK_SETTLEMENT", "cancel open listings before settling — escrowed tokens cannot be redeemed");
    }
    for (const [addr, amount] of split) {
      await deps.cash.transfer(cf.currency, payer, addr, amount.toString());
      paid.push([addr, amount]);
    }
    if (cf.kind === "redemption") {
      const ctx = contextOf(asset);
      for (const [addr, bal] of balances) if (bal > 0n) await deps.engine.burn(actor, ctx, addr, bal.toString());
      await deps.assets.setStatus(asset.id, "matured");
    }
    executed = await deps.cashflows.markExecuted(cf.id, new Date().toISOString());
  } catch (err) {
    for (const [addr, amount] of paid) {
      await deps.cash.transfer(cf.currency, addr, payer, amount.toString()).catch((refundErr) => log.error({ refundErr, addr, amount: amount.toString(), cashflowId: cf.id }, "cashflow refund compensation failed — manual reconciliation required"));
    }
    await releaseClaim();
    throw err;
  }

  await deps.audit.append({
    assetId: asset.id,
    actorId: actor.id,
    action: cf.kind === "redemption" ? "redeem" : "distribute",
    payload: {
      currency: cf.currency,
      amount: cf.amount,
      paid: payable.toString(),
      holders: split.size,
      from: payer,
      seq: cf.seq,
      // Exact per-holder payments as settled — lets read-models report each
      // investor's share without re-deriving it (balances are already burned
      // by the time a redemption's audit entry lands).
      payments: Object.fromEntries([...split].map(([addr, amt]) => [addr, amt.toString()])),
      // Pre-burn per-holder unit balances — for redemptions this is each
      // investor's "units retired" (recorded here because the burns above
      // erase the balances before this entry lands). Harmless for coupons.
      units: Object.fromEntries([...balances].map(([addr, bal]) => [addr, bal.toString()])),
    },
    chainId: asset.chainId,
  });
  return executed;
}
