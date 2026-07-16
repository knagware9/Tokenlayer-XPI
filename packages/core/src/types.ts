/**
 * Core domain types for TokenLayer.
 *
 * This module is intentionally free of any I/O or framework dependency. It
 * defines the vocabulary shared across the platform: the chain-agnostic ledger
 * seam, the declarative use-case shape, and the lifecycle/RBAC primitives.
 */

/** Roles recognised by the platform's access-control policy. */
export type Role = "PlatformAdmin" | "OrgAdmin" | "UseCaseAdmin" | "Issuer" | "Trader" | "Buyer" | "Auditor";

export const ROLES: readonly Role[] = ["PlatformAdmin", "OrgAdmin", "UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"];

/** The kind of tenant an organization is. */
export type OrgType = "bank" | "corporate" | "msme" | "government" | "verifier";

export const ORG_TYPES: readonly OrgType[] = ["bank", "corporate", "msme", "government", "verifier"];

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
  | "buy"
  | "list"
  | "cancel-listing"
  | "distribute"
  | "redeem"
  | "read";

/** Operations that may be gated behind maker-checker approvals. */
export type GatedOp = "issue" | "mint" | "transfer" | "burn" | "freeze" | "unfreeze" | "cashflow-execute";

export const GATED_OPS: readonly GatedOp[] = ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "cashflow-execute"];

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

  /** Anchor an off-ledger hash (e.g. an audit chain head) on-ledger for tamper-evidence. */
  anchor(ref: AssetRef, hash: string): Promise<TxReceipt>;
}

/** Minimal JSON-Schema subset used to describe issuance metadata. */
export interface MetadataSchema {
  type: "object";
  properties: Record<string, PropertySchema>;
  required?: string[];
}

export interface PropertySchema {
  /** A `document` field's runtime value is a string URL (http/https). */
  type: "string" | "number" | "boolean" | "document";
  description?: string;
  /** string fields → a fixed choice list (value must be one of these). */
  enum?: string[];
  /** number fields → inclusive lower bound. */
  min?: number;
  /** number fields → inclusive upper bound. */
  max?: number;
  /** string fields → RegExp source the value must match (new RegExp(pattern)). */
  pattern?: string;
}

/** A contract deployed for a use case on one chain. */
export interface UseCaseContract {
  contractRef: string;
  deployTxHash: string;
}

/** A declarative, config-driven use case. Adding one requires no code change. */
export interface UseCaseDefinition {
  key: string;
  name: string;
  description?: string;
  /** Owning organization id (null/undefined for legacy platform-owned use cases). */
  ownerOrgId?: string;
  tokenStandard: TokenStandard;
  /** Derived from tokenStandard; kept explicit for convenience. */
  tokenType: TokenType;
  /** Token symbol for the use case's contract(s). */
  symbol: string;
  /** DLTs this use case may deploy to (chain ids). Must be non-empty. */
  allowedChainIds: string[];
  /** Default chain for issuance; must be in allowedChainIds. */
  defaultChainId: string;
  /**
   * The contract deployed for this use case, per chain. A chain is "deployed"
   * iff it has an entry here. Populated at config time (create + deploy action);
   * empty on a freshly-defined use case whose contracts haven't deployed yet.
   */
  contracts?: Record<string, UseCaseContract>;
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
    /** Cap on the number of distinct positive-balance holders. */
    maxHolders?: number;
    /** No transfer of tokens within N days of the sender's acquisition. */
    lockupDays?: number;
    /** Holder KYC country codes permitted to receive tokens. */
    allowedJurisdictions?: string[];
  };
  /** Optional fee configuration; the API layer applies the cash movements. */
  fees?: {
    /** Marketplace fee in basis points (0..10000) taken on a DvP buy. */
    marketplaceBps?: number;
    /** Flat CBDC amount (non-negative integer string) charged at issuance. */
    issuanceFlat?: string;
  };
  /** Default sale terms used to pre-fill the issue form; not enforced. */
  saleTermsDefault?: {
    unitPrice?: string;
    currency?: string;
  };
  /**
   * How to value this use case's tokens in analytics when they carry no on-sale
   * unitPrice (e.g. invoices priced by face value in metadata). When set, a
   * token's value = its `metadataField` amount (a non-negative number) in
   * `currency`. unitPrice/currency sale terms, when present, take precedence.
   */
  valuation?: {
    metadataField: string;
    currency: string;
  };
  /**
   * Metadata fields the platform computes on issue instead of accepting from the
   * client. Maps a metadata field to a named generator. Currently the only
   * generator is "invoiceFingerprint" (see invoiceFingerprint()).
   */
  derivedFields?: Record<string, "invoiceFingerprint">;
  /**
   * A metadata field whose value must be unique across the use case's assets.
   * Issue rejects a duplicate with DUPLICATE_ASSET. Must name a declared
   * metadata property.
   */
  uniqueBy?: string;
  /**
   * Financial terms template: which metadata fields carry the principal,
   * maturity date, and (for periodic coupons) the % p.a. rate — plus the
   * payment frequency and cash-ledger currency. Drives the cashflow schedule
   * materialized at issue (see computeCashflowSchedule()).
   */
  terms?: {
    principalField: string;
    maturityField: string;
    rateField?: string;
    frequency?: "atMaturity" | "monthly" | "quarterly" | "semiannual" | "annual";
    currency: string;
  };
  /**
   * Maker-checker policy: gated operations require N approvals from capability
   * holders other than the proposer before they execute. Unlisted ops run
   * instantly. No role bypasses a gated op — including admins.
   */
  workflow?: {
    approvals?: Partial<Record<GatedOp, number>>;
  };
  roles: Role[];
}

/**
 * Supplies holder/KYC/timing data the engine needs to enforce data-dependent
 * compliance rules. Wired by the API from its repos.
 */
export interface ComplianceProvider {
  /** Distinct positive-balance holders of the asset. */
  holderCount(ref: AssetRef): Promise<number>;
  /** ISO of that account's first acquisition, or null if never acquired. */
  acquiredAt(ref: AssetRef, account: string): Promise<string | null>;
  /** Holder address → KYC country code, or null if unknown. */
  jurisdictionOf(account: string): Promise<string | null>;
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
