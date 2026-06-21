/**
 * Core domain types for TokenLayer.
 *
 * This module is intentionally free of any I/O or framework dependency. It
 * defines the vocabulary shared across the platform: the chain-agnostic ledger
 * seam, the declarative use-case shape, and the lifecycle/RBAC primitives.
 */

/** Roles recognised by the platform's access-control policy. */
export type Role = "Admin" | "Issuer" | "Operator" | "Viewer";

export const ROLES: readonly Role[] = ["Admin", "Issuer", "Operator", "Viewer"];

/** Every operation the platform can perform on an asset. */
export type LifecycleAction =
  | "issue"
  | "mint"
  | "transfer"
  | "burn"
  | "freeze"
  | "unfreeze"
  | "allow"
  | "disallow"
  | "read";

/** Kind of token a use case issues. */
export type TokenType = "fungible" | "nonfungible";

/** Token standards the platform can issue. */
export type TokenStandard = "ERC-20" | "ERC-721" | "ERC-3643";

export const TOKEN_STANDARDS: readonly TokenStandard[] = ["ERC-20", "ERC-721", "ERC-3643"];

/** The kind of distributed ledger an adapter speaks to. */
export type ChainFamily = "evm" | "fabric" | "canton" | "mock";

/** The token type implied by a standard (ERC-721 is the only non-fungible one). */
export function tokenTypeForStandard(standard: TokenStandard): TokenType {
  return standard === "ERC-721" ? "nonfungible" : "fungible";
}

/** Identifies one deployed asset on a specific chain. */
export interface AssetRef {
  /** Platform-internal asset id (stable across chains for the same logical asset). */
  id: string;
  /** Which ledger adapter owns this asset (e.g. "mock", "local-evm"). */
  chainId: string;
  /** Adapter-specific handle: a contract address, or a mock registry key. */
  contractRef: string;
}

/** Result of a state-changing ledger operation. */
export interface TxReceipt {
  txHash: string;
  chainId: string;
  blockNumber?: number;
  /** ISO-8601 timestamp recorded by the adapter. */
  timestamp: string;
}

/** Everything an adapter needs to bring a new asset into existence. */
export interface AssetDeploymentSpec {
  id: string;
  name: string;
  symbol: string;
  useCaseKey: string;
  tokenType: TokenType;
  tokenStandard: TokenStandard;
  /** When true, the ledger itself enforces an allowlist on mint/transfer. */
  allowlistEnabled: boolean;
  /** Issuance metadata, already validated against the use case's schema. */
  metadata: Record<string, unknown>;
}

export interface DeployResult {
  contractRef: string;
  txHash: string;
}

/**
 * The chain-agnostic seam. Every supported ledger — an in-memory mock, a local
 * EVM, or a future Besu/Canton network — implements this identical surface, so
 * the rest of the platform never speaks blockchain-specific dialects.
 */
export interface LedgerAdapter {
  readonly chainId: string;
  readonly family: ChainFamily;
  deployAsset(spec: AssetDeploymentSpec): Promise<DeployResult>;

  // Fungible operations (ERC-20 / ERC-3643).
  mint(ref: AssetRef, to: string, amount: string): Promise<TxReceipt>;
  transfer(ref: AssetRef, from: string, to: string, amount: string): Promise<TxReceipt>;
  burn(ref: AssetRef, from: string, amount: string): Promise<TxReceipt>;
  balanceOf(ref: AssetRef, account: string): Promise<string>;
  totalSupply(ref: AssetRef): Promise<string>;

  // Non-fungible operations (ERC-721).
  mintToken(ref: AssetRef, to: string, tokenId: string, uri?: string): Promise<TxReceipt>;
  transferToken(ref: AssetRef, from: string, to: string, tokenId: string): Promise<TxReceipt>;
  burnToken(ref: AssetRef, tokenId: string): Promise<TxReceipt>;
  ownerOf(ref: AssetRef, tokenId: string): Promise<string | null>;
  tokensOf(ref: AssetRef, account: string): Promise<string[]>;

  // Compliance (shared by all standards).
  setFrozen(ref: AssetRef, account: string, frozen: boolean): Promise<TxReceipt>;
  setAllowed(ref: AssetRef, account: string, allowed: boolean): Promise<TxReceipt>;
  isFrozen(ref: AssetRef, account: string): Promise<boolean>;
  isAllowed(ref: AssetRef, account: string): Promise<boolean>;
}

/** Minimal JSON-Schema subset used to describe issuance metadata. */
export interface MetadataSchema {
  type: "object";
  properties: Record<string, PropertySchema>;
  required?: string[];
}

export interface PropertySchema {
  type: "string" | "number" | "boolean";
  description?: string;
}

/** A declarative, config-driven use case. Adding one requires no code change. */
export interface UseCaseDefinition {
  key: string;
  name: string;
  description?: string;
  tokenStandard: TokenStandard;
  /** Derived from tokenStandard; kept explicit for convenience. */
  tokenType: TokenType;
  /** DLTs this use case may deploy to (chain ids). Must be non-empty. */
  allowedChainIds: string[];
  /** Default chain for issuance; must be in allowedChainIds. */
  defaultChainId: string;
  metadataSchema: MetadataSchema;
  lifecycle: {
    mint: boolean;
    transfer: boolean;
    burn: boolean;
    freeze: boolean;
  };
  compliance: {
    allowlist: boolean;
    transferRestrictions: boolean;
  };
  roles: Role[];
}

/**
 * A read source of use-case definitions. Implemented by the in-memory
 * StaticUseCaseSource (tests/seed) and by a DB-backed repository (low-code
 * builder), so the engine works the same whether use cases are code or data.
 */
export interface UseCaseSource {
  has(key: string): Promise<boolean>;
  get(key: string): Promise<UseCaseDefinition>;
  list(): Promise<UseCaseDefinition[]>;
}

/** Identifies who is performing an action, for RBAC and audit. */
export interface Actor {
  id: string;
  role: Role;
}

/** Binds an asset reference to its governing use case. */
export interface AssetContext {
  ref: AssetRef;
  useCaseKey: string;
}

/** One immutable audit entry. */
export interface AuditRecord {
  assetId?: string;
  actorId: string;
  action: LifecycleAction;
  payload: Record<string, unknown>;
  txHash?: string;
  chainId?: string;
  /** ISO-8601 timestamp. */
  at: string;
}

/** Sink for audit records. The engine writes; persistence implements. */
export interface AuditSink {
  record(entry: AuditRecord): Promise<void>;
}
