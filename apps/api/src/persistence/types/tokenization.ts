/**
 * TOKENIZATION PERSISTENCE CONTRACTS — assets, holdings, cash, invoices.
 *
 * Everything `model-domains.ts` marks `"tokenization"`. An identity-only
 * deployment owns none of these tables and must never write one.
 */
import type { TokenStandard, TokenType, LifecycleAction, UseCaseDefinition, UseCaseSource } from "@tokenlayer/core";
import type { Paged, Page } from "./shared.js";

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

export interface AccountRecord {
  id: string;
  address: string;
  label: string;
  ownerOrgId: string | null;
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

export interface AccountRepository {
  list(): Promise<AccountRecord[]>;
  findById(id: string): Promise<AccountRecord | null>;
  findByAddress(address: string): Promise<AccountRecord | null>;
  upsert(address: string, label: string, ownerOrgId?: string): Promise<AccountRecord>;
}

/** An on-ledger anchor of one asset's audit chain head. */
export interface UseCaseRepository extends UseCaseSource {
  create(def: UseCaseDefinition): Promise<UseCaseDefinition>;
  update(key: string, def: UseCaseDefinition): Promise<UseCaseDefinition>;
}

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

/**
 * What a stored document was uploaded FOR. A closed union rather than a free
 * string so a typo cannot invent a third purpose that no gate knows about.
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
export interface CashRepository {
  balanceOf(currency: string, address: string): Promise<string>;
  balancesOf(address: string): Promise<CashBalanceRecord[]>;
  /** Mint/fund: add `amount` to (currency,address). */
  credit(currency: string, address: string, amount: string): Promise<void>;
  /** Payment leg: move `amount` from→to in `currency`; throws on insufficient funds. */
  transfer(currency: string, from: string, to: string, amount: string): Promise<void>;
}

export type InvoiceSource = "upload" | "erp" | "manual";
export type StagedInvoiceStatus = "staged" | "tokenized";

/** An invoice staged (uploaded/ERP-imported/manually entered) before selective tokenization. */
export interface StagedInvoiceRecord {
  id: string;
  useCaseKey: string;
  source: InvoiceSource;
  metadata: Record<string, unknown>;
  invoiceHash: string;
  documentId: string | null;
  documentSha256: string | null;
  status: StagedInvoiceStatus;
  assetId: string | null;
  createdBy: string;
  createdAt: string;
  tokenizedAt: string | null;
}

export interface StagedInvoiceRepository {
  create(input: Omit<StagedInvoiceRecord, "id" | "createdAt">): Promise<StagedInvoiceRecord>;
  get(id: string): Promise<StagedInvoiceRecord | null>;
  listByUseCase(useCaseKey: string, status?: StagedInvoiceStatus): Promise<StagedInvoiceRecord[]>;
  findByHash(useCaseKey: string, invoiceHash: string): Promise<StagedInvoiceRecord | null>;
  markTokenized(id: string, assetId: string, at: string): Promise<StagedInvoiceRecord>;
  remove(id: string): Promise<void>;
}

