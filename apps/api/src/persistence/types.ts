import type { Role, TokenStandard, TokenType, LifecycleAction, UseCaseDefinition, UseCaseSource } from "@tokenlayer/core";

export type KycStatus = "pending" | "approved" | "rejected";
export interface KycDetails {
  legalName?: string;
  country?: string;
  idType?: string;
  idNumber?: string;
  documentRef?: string;
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  useCaseKey: string | null;
  accountId: string | null;
  active: boolean;
  kycStatus: KycStatus;
  kyc: KycDetails | null;
  createdAt: string;
}

export interface AssetRecord {
  id: string;
  useCaseKey: string;
  name: string;
  symbol: string;
  chainId: string;
  contractRef: string;
  tokenType: TokenType;
  tokenStandard: TokenStandard;
  metadata: Record<string, unknown>;
  status: string;
  createdBy: string;
  createdAt: string;
  unitPrice: string | null;
  currency: string | null;
  treasuryAccount: string | null;
  /** Value of the use case's `uniqueBy` field, enforced unique per use case. */
  uniqueKey?: string | null;
}

export interface SaleTerms {
  unitPrice: string;
  currency: string;
  treasuryAccount: string;
}

export interface AuditEntryRecord {
  id: string;
  assetId?: string;
  actorId: string;
  action: LifecycleAction;
  payload: Record<string, unknown>;
  txHash?: string;
  chainId?: string;
  createdAt: string;
  seq?: number;
  prevHash?: string;
  hash?: string;
}

export interface AccountRecord {
  id: string;
  address: string;
  label: string;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(input: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord>;
  list(useCaseKey?: string): Promise<UserRecord[]>;
  update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus">>): Promise<UserRecord>;
  remove(id: string): Promise<void>;
}

/** A page of results plus the total count of matching rows (for pagination). */
export interface Paged<T> {
  items: T[];
  total: number;
}

export interface Page {
  limit?: number;
  offset?: number;
}

export interface AssetFilter {
  useCaseKey?: string;
  chainId?: string;
  status?: string;
}

export interface AssetRepository {
  create(input: Omit<AssetRecord, "createdAt">): Promise<AssetRecord>;
  get(id: string): Promise<AssetRecord | null>;
  list(filter?: AssetFilter, page?: Page): Promise<Paged<AssetRecord>>;
  setStatus(id: string, status: string): Promise<void>;
  setSaleTerms(id: string, terms: SaleTerms): Promise<void>;
  /** First asset in the use case whose metadata[field] === value, else null. */
  findByMetadata(useCaseKey: string, field: string, value: unknown): Promise<AssetRecord | null>;
}

export interface AuditRepository {
  append(entry: Omit<AuditEntryRecord, "id" | "createdAt"> & { createdAt?: string }): Promise<AuditEntryRecord>;
  listByAsset(assetId: string, page?: Page): Promise<Paged<AuditEntryRecord>>;
  /** Cross-asset audit query: entries for any of `assetIds`, ordered createdAt ascending (oldest→newest). Empty ids → empty result. */
  listByAssetIds(assetIds: string[], page?: Page): Promise<Paged<AuditEntryRecord>>;
}

export interface AccountRepository {
  list(): Promise<AccountRecord[]>;
  findById(id: string): Promise<AccountRecord | null>;
  upsert(address: string, label: string): Promise<AccountRecord>;
}

/** An on-ledger anchor of one asset's audit chain head. */
export interface AuditAnchorRecord {
  id: string;
  assetId: string;
  seq: number;
  hash: string;
  txHash: string;
  chainId: string;
  createdAt: string;
}

export interface AuditAnchorRepository {
  create(input: Omit<AuditAnchorRecord, "id" | "createdAt">): Promise<AuditAnchorRecord>;
  /** The most recent anchor for the asset (highest seq), or null if never anchored. */
  latest(assetId: string): Promise<AuditAnchorRecord | null>;
}

/** A writable use-case store. Also satisfies the engine's UseCaseSource. */
export interface UseCaseRepository extends UseCaseSource {
  create(def: UseCaseDefinition): Promise<UseCaseDefinition>;
  update(key: string, def: UseCaseDefinition): Promise<UseCaseDefinition>;
}

/** A secondary-market sell listing. `quantity` is the REMAINING quantity. */
export interface ListingRecord {
  id: string;
  assetId: string;
  seller: string; // wallet address
  quantity: string; // REMAINING quantity (decrements on takes)
  unitPrice: string;
  currency: string;
  status: string; // open | filled | cancelled
  createdAt: string;
  updatedAt: string;
}

/**
 * Typed conflict signal from listing state transitions, so the HTTP layer can
 * map races to precise status codes instead of opaque 500s.
 * - LISTING_NOT_OPEN: the listing is filled/cancelled (or became so under our feet)
 * - TAKE_EXCEEDS_REMAINING: the reservation asks for more than remains
 * - LISTING_CONFLICT: optimistic-concurrency retries exhausted (concurrent writer)
 */
export class ListingConflictError extends Error {
  constructor(
    public readonly code: "LISTING_CONFLICT" | "TAKE_EXCEEDS_REMAINING" | "LISTING_NOT_OPEN",
    message: string,
  ) {
    super(message);
    this.name = "ListingConflictError";
  }
}

export interface ListingRepository {
  create(input: Pick<ListingRecord, "assetId" | "seller" | "quantity" | "unitPrice" | "currency">): Promise<ListingRecord>;
  get(id: string): Promise<ListingRecord | null>;
  listByAsset(assetId: string, status?: string): Promise<ListingRecord[]>;
  /**
   * Atomically reserve `by` tokens from the remaining quantity — the take
   * route's single defence against concurrent over-delivery from the pooled
   * escrow. Decrements ONLY if status is "open" AND remaining ≥ `by` (BigInt
   * math); sets status "filled" when the remainder reaches 0. Throws
   * ListingConflictError (LISTING_NOT_OPEN / TAKE_EXCEEDS_REMAINING /
   * LISTING_CONFLICT) otherwise — never partially applies.
   */
  reserve(id: string, by: string): Promise<ListingRecord>;
  /**
   * Compensation for a failed take AFTER reserve: add `by` back to the
   * remaining quantity and re-open a "filled" listing.
   */
  restore(id: string, by: string): Promise<ListingRecord>;
  /**
   * Atomically flip an "open" listing to "cancelled" (CAS) and return the row
   * as of cancellation — callers release exactly the returned `quantity` from
   * escrow. Throws ListingConflictError when the listing is not open (lost
   * race with a cancel) or the CAS keeps losing to concurrent takes.
   */
  cancel(id: string): Promise<ListingRecord>;
  /**
   * Compensation for a failed escrow release AFTER cancel: flip a "cancelled"
   * listing back to "open" with its quantity untouched.
   */
  reopen(id: string): Promise<ListingRecord>;
}

export interface CashBalanceRecord {
  currency: string;
  address: string;
  amount: string;
}

/** An uploaded document (bytes + content-type), referenced from asset metadata. */
export interface DocumentRecord {
  id: string;
  contentType: string;
  sha256: string;
  size: number;
  bytes: Buffer;
  createdAt: string;
}

export interface DocumentRepository {
  create(input: { contentType: string; bytes: Buffer }): Promise<{ id: string; sha256: string; size: number }>;
  get(id: string): Promise<DocumentRecord | null>;
}

/**
 * A materialized financial-terms cashflow (coupon or redemption) for one asset.
 * Only "scheduled"/"executing"/"executed" are persisted — "due"/"overdue" are
 * derived from the due date at read time (no background scheduler). "executing"
 * is the execute route's atomic claim: it excludes concurrent double-payment.
 */
export interface CashflowRecord {
  id: string;
  assetId: string;
  seq: number;
  kind: "coupon" | "redemption";
  dueDate: string;
  amount: string;
  currency: string;
  status: "scheduled" | "executing" | "executed";
  executedAt: string | null;
}

export interface CashflowRepository {
  createMany(assetId: string, currency: string, rows: { seq: number; kind: "coupon" | "redemption"; dueDate: string; amount: string }[]): Promise<void>;
  listByAsset(assetId: string): Promise<CashflowRecord[]>; // ordered by seq asc
  get(id: string): Promise<CashflowRecord | null>;
  /** Atomic CAS "scheduled"→"executing". True iff this caller won the claim. */
  claim(id: string): Promise<boolean>;
  /** Compensation: flip "executing"→"scheduled" so a failed execute is retryable. */
  release(id: string): Promise<void>;
  /** Finalize: "executing"→"executed" (+executedAt). Throws when the row is not "executing". */
  markExecuted(id: string, executedAt: string): Promise<CashflowRecord>;
}

/** One approval on a proposal (segregation-of-duties: never the proposer). */
export interface ProposalApproval {
  userId: string;
  email: string;
  at: string;
}

/**
 * A maker-checker proposal: a gated operation captured for approval. When the
 * approval count reaches `required`, the operation executes (as the proposer's
 * identity) and the proposal becomes "executed" or "failed".
 */
export interface ProposalRecord {
  id: string;
  useCaseKey: string;
  assetId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  proposerId: string;
  proposerLabel: string;
  required: number;
  approvals: ProposalApproval[];
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ProposalRepository {
  create(input: Omit<ProposalRecord, "id" | "approvals" | "status" | "error" | "createdAt" | "decidedAt">): Promise<ProposalRecord>;
  get(id: string): Promise<ProposalRecord | null>;
  /** Newest first, optionally scoped by use case and/or status. */
  list(useCaseKey?: string, status?: string): Promise<ProposalRecord[]>;
  /** Append an approval; throws { code: "ALREADY_APPROVED" } if this userId already approved. */
  addApproval(id: string, approval: ProposalApproval): Promise<ProposalRecord>;
  /** Atomic CAS "pending"→`target` (approved | rejected). True iff this caller won the transition. */
  claimDecided(id: string, target: ProposalRecord["status"]): Promise<boolean>;
  /** Set a terminal status (+error, +decidedAt for terminal states). */
  setStatus(id: string, status: ProposalRecord["status"], error?: string | null): Promise<ProposalRecord>;
}

export interface CashRepository {
  balanceOf(currency: string, address: string): Promise<string>;
  balancesOf(address: string): Promise<CashBalanceRecord[]>;
  /** Mint/fund: add `amount` to (currency,address). */
  credit(currency: string, address: string, amount: string): Promise<void>;
  /** Payment leg: move `amount` from→to in `currency`; throws on insufficient funds. */
  transfer(currency: string, from: string, to: string, amount: string): Promise<void>;
}
