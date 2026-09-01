import type { TokenType } from "@tokenlayer/core";

interface AssetState {
  tokenType: TokenType;
  allowlistEnabled: boolean;
  // fungible
  balances: Map<string, bigint>;
  supply: bigint;
  // non-fungible
  owners: Map<string, string>; // tokenId -> owner
  uris: Map<string, string>;
  // compliance
  frozen: Set<string>;
  allowed: Set<string>;
}

/**
 * A contract's full state, as reconstructed from its durable audit trail
 * rather than produced by a live operation. See `SimulatedLedger.hydrate`.
 */
export type LedgerHydration = AssetState;

/**
 * An in-memory ledger that mirrors the on-chain compliance contracts' rules for
 * both fungible and non-fungible tokens (allowlist + freeze enforcement). It is
 * the shared engine behind the mock, Fabric, and Canton adapters, so those DLTs
 * behave identically to the real EVM contracts without any external infra.
 */
export class SimulatedLedger {
  private readonly assets = new Map<string, AssetState>();

  create(contractRef: string, tokenType: TokenType, allowlistEnabled: boolean): void {
    this.assets.set(contractRef, {
      tokenType,
      allowlistEnabled,
      balances: new Map(),
      supply: 0n,
      owners: new Map(),
      uris: new Map(),
      frozen: new Set(),
      allowed: new Set(),
    });
  }

  private asset(ref: string): AssetState {
    const a = this.assets.get(ref);
    if (!a) throw new Error(`simulated: unknown asset '${ref}'`);
    return a;
  }

  /**
   * Replace this contract's ENTIRE state with reconstructed historical data,
   * bypassing every mutation-time invariant (allowlist, sufficient balance,
   * frozen). The caller is installing state already known to be true from a
   * durable audit trail — e.g. after a process restart wiped this in-memory
   * ledger — not simulating a fresh operation subject to those rules.
   * Creates the contract if it does not exist yet, overwrites it otherwise.
   * Copies every collection so the caller's own working copy is never aliased
   * into ledger state a later mutation could then reach back and corrupt.
   */
  hydrate(contractRef: string, state: LedgerHydration): void {
    this.assets.set(contractRef, {
      tokenType: state.tokenType,
      allowlistEnabled: state.allowlistEnabled,
      balances: new Map(state.balances),
      supply: state.supply,
      owners: new Map(state.owners),
      uris: new Map(state.uris),
      frozen: new Set(state.frozen),
      allowed: new Set(state.allowed),
    });
  }

  // --- fungible ------------------------------------------------------------

  mint(ref: string, to: string, amount: string): void {
    const a = this.asset(ref);
    const amt = positive(amount);
    if (a.allowlistEnabled && !a.allowed.has(to)) throw new Error(`simulated: '${to}' not allowlisted`);
    if (a.frozen.has(to)) throw new Error(`simulated: '${to}' is frozen`);
    a.balances.set(to, (a.balances.get(to) ?? 0n) + amt);
    a.supply += amt;
  }

  transfer(ref: string, from: string, to: string, amount: string): void {
    const a = this.asset(ref);
    const amt = positive(amount);
    if (a.frozen.has(from) || a.frozen.has(to)) throw new Error("simulated: account is frozen");
    if (a.allowlistEnabled && (!a.allowed.has(from) || !a.allowed.has(to))) throw new Error("simulated: not allowlisted");
    const bal = a.balances.get(from) ?? 0n;
    if (bal < amt) throw new Error("simulated: insufficient balance");
    a.balances.set(from, bal - amt);
    a.balances.set(to, (a.balances.get(to) ?? 0n) + amt);
  }

  burn(ref: string, from: string, amount: string): void {
    const a = this.asset(ref);
    const amt = positive(amount);
    const bal = a.balances.get(from) ?? 0n;
    if (bal < amt) throw new Error("simulated: insufficient balance");
    a.balances.set(from, bal - amt);
    a.supply -= amt;
  }

  balanceOf(ref: string, account: string): string {
    const a = this.asset(ref);
    if (a.tokenType === "nonfungible") {
      return [...a.owners.values()].filter((o) => o === account).length.toString();
    }
    return (a.balances.get(account) ?? 0n).toString();
  }

  totalSupply(ref: string): string {
    const a = this.asset(ref);
    return a.tokenType === "nonfungible" ? a.owners.size.toString() : a.supply.toString();
  }

  // --- non-fungible --------------------------------------------------------

  mintToken(ref: string, to: string, tokenId: string, uri?: string): void {
    const a = this.asset(ref);
    if (a.owners.has(tokenId)) throw new Error(`simulated: token '${tokenId}' already exists`);
    if (a.allowlistEnabled && !a.allowed.has(to)) throw new Error(`simulated: '${to}' not allowlisted`);
    if (a.frozen.has(to)) throw new Error(`simulated: '${to}' is frozen`);
    a.owners.set(tokenId, to);
    if (uri) a.uris.set(tokenId, uri);
  }

  transferToken(ref: string, from: string, to: string, tokenId: string): void {
    const a = this.asset(ref);
    if (a.owners.get(tokenId) !== from) throw new Error(`simulated: '${from}' does not own '${tokenId}'`);
    if (a.frozen.has(from) || a.frozen.has(to)) throw new Error("simulated: account is frozen");
    if (a.allowlistEnabled && (!a.allowed.has(from) || !a.allowed.has(to))) throw new Error("simulated: not allowlisted");
    a.owners.set(tokenId, to);
  }

  burnToken(ref: string, tokenId: string): void {
    const a = this.asset(ref);
    if (!a.owners.has(tokenId)) throw new Error(`simulated: token '${tokenId}' does not exist`);
    a.owners.delete(tokenId);
    a.uris.delete(tokenId);
  }

  ownerOf(ref: string, tokenId: string): string | null {
    return this.asset(ref).owners.get(tokenId) ?? null;
  }

  tokensOf(ref: string, account: string): string[] {
    return [...this.asset(ref).owners.entries()].filter(([, o]) => o === account).map(([t]) => t);
  }

  // --- compliance ----------------------------------------------------------

  setFrozen(ref: string, account: string, frozen: boolean): void {
    const a = this.asset(ref);
    if (frozen) a.frozen.add(account);
    else a.frozen.delete(account);
  }

  setAllowed(ref: string, account: string, allowed: boolean): void {
    const a = this.asset(ref);
    if (allowed) a.allowed.add(account);
    else a.allowed.delete(account);
  }

  isFrozen(ref: string, account: string): boolean {
    return this.asset(ref).frozen.has(account);
  }

  isAllowed(ref: string, account: string): boolean {
    return this.asset(ref).allowed.has(account);
  }
}

function positive(amount: string): bigint {
  const amt = BigInt(amount);
  if (amt <= 0n) throw new Error("simulated: amount must be positive");
  return amt;
}
