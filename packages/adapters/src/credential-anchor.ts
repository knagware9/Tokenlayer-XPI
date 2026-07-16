/**
 * The on-chain identity-registry capability. EVM-only, so it is NOT part of the
 * chain-agnostic LedgerAdapter seam — Fabric/Canton cannot implement it, and
 * forcing them to throw would make the seam dishonest. Adapters that can do this
 * implement it additionally; callers narrow with `supportsCredentialAnchor`.
 *
 * Hashing lives INSIDE the implementation: callers pass plain strings (a
 * credential id, a VC-JWT) and cannot get the commitment wrong.
 */
import type { LedgerAdapter, TxReceipt } from "@tokenlayer/core";

export interface DidRegistration {
  registered: boolean;
  active: boolean;
}

export interface OnChainCredentialStatus {
  /** FALSE means "no record" — NOT "not revoked". Callers must branch on this first. */
  exists: boolean;
  revoked: boolean;
  revokedAt: number | null;
  vcHash: string;
}

export interface CredentialAnchor {
  /** Deploy both registries; the operator becomes their sole writer. */
  deployRegistries(): Promise<{ didRegistry: string; vcRegistry: string; txHash: string }>;
  registerDid(registry: string, did: string): Promise<TxReceipt>;
  deactivateDid(registry: string, did: string): Promise<TxReceipt>;
  didRegistration(registry: string, did: string): Promise<DidRegistration>;
  anchorCredential(
    registry: string,
    credentialId: string,
    vcJwt: string,
    issuedAt: number,
    expiresAt: number,
  ): Promise<TxReceipt>;
  revokeCredential(registry: string, credentialId: string): Promise<TxReceipt>;
  credentialStatusOf(registry: string, credentialId: string): Promise<OnChainCredentialStatus>;
}

const METHODS = [
  "deployRegistries",
  "registerDid",
  "deactivateDid",
  "didRegistration",
  "anchorCredential",
  "revokeCredential",
  "credentialStatusOf",
] as const;

/** Narrowing guard — presence-detected, like assertConnectivity's healthCheck probe. */
export function supportsCredentialAnchor(a: LedgerAdapter): a is LedgerAdapter & CredentialAnchor {
  return METHODS.every((m) => typeof (a as unknown as Record<string, unknown>)[m] === "function");
}
