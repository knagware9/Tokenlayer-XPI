import type { Role, TokenStandard, TokenType, LifecycleAction, OrgType, OrgCapabilities, UseCaseDefinition, UseCaseSource, CredentialUseCaseDefinition, UseCaseTemplate } from "@tokenlayer/core";

export type { OrgType };

export type KycStatus = "pending" | "approved" | "rejected";
export interface KycDetails {
  legalName?: string;
  country?: string;
  idType?: string;
  idNumber?: string;
  documentRef?: string;
  issuerDid?: string;
  credentialId?: string;
  verifiedAt?: string;
  revokedAt?: string;
  revokeReason?: string;
}

/**
 * "service" marks the machine principal an API key authenticates as (EN-B): no
 * usable password, refused by interactive login. Defaults to "human" on create,
 * so every pre-EN-B caller and row stays human without a migration.
 */
export type UserKind = "human" | "service";

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
  did?: string;
  orgId?: string | null;
  didSeedEncrypted?: string | null;
  kind: UserKind;
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
  /** `kind` is optional and defaults to "human" — mirrors the column default. */
  create(input: Omit<UserRecord, "id" | "createdAt" | "kind"> & { kind?: UserKind }): Promise<UserRecord>;
  list(useCaseKey?: string): Promise<UserRecord[]>;
  listByOrg(orgId: string): Promise<UserRecord[]>;
  update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus" | "did" | "kyc" | "orgId" | "didSeedEncrypted">>): Promise<UserRecord>;
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

export interface CredentialUseCaseRepository {
  create(def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition>;
  get(key: string): Promise<CredentialUseCaseDefinition | null>;
  has(key: string): Promise<boolean>;
  list(): Promise<CredentialUseCaseDefinition[]>;
  update(key: string, def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition>;
}

/** Customer-saved use-case templates (built-in templates live in TEMPLATE_CATALOG, not persisted). */
export interface CredentialUseCaseTemplateRepository {
  list(): Promise<UseCaseTemplate[]>;
  get(key: string): Promise<UseCaseTemplate | null>;
  create(t: UseCaseTemplate): Promise<UseCaseTemplate>;
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
  /** null for non-token (e.g. credential) proposals. */
  useCaseKey: string | null;
  /** Set for org-scoped kinds; null for token kinds. */
  orgId: string | null;
  assetId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  proposerId: string;
  proposerLabel: string;
  required: number;
  approvals: ProposalApproval[];
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  error: string | null;
  /** Optional executor report (e.g. a CSV batch's per-row outcomes), set after execution. */
  result: Record<string, unknown> | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ProposalRepository {
  create(input: Omit<ProposalRecord, "id" | "approvals" | "status" | "error" | "result" | "createdAt" | "decidedAt">): Promise<ProposalRecord>;
  get(id: string): Promise<ProposalRecord | null>;
  /** Newest first, optionally scoped by use case and/or status. */
  list(useCaseKey?: string, status?: string): Promise<ProposalRecord[]>;
  /** Newest first, scoped to one org, optionally by status. */
  listByOrg(orgId: string, status?: string): Promise<ProposalRecord[]>;
  /** Append an approval; throws { code: "ALREADY_APPROVED" } if this userId already approved. */
  addApproval(id: string, approval: ProposalApproval): Promise<ProposalRecord>;
  /** Atomic CAS "pending"→`target` (approved | rejected). True iff this caller won the transition. */
  claimDecided(id: string, target: ProposalRecord["status"]): Promise<boolean>;
  /** Set a terminal status (+error, +decidedAt for terminal states). */
  setStatus(id: string, status: ProposalRecord["status"], error?: string | null): Promise<ProposalRecord>;
  /** Record an executor report on the proposal (e.g. a CSV batch's per-row outcomes). */
  setResult(id: string, result: Record<string, unknown>): Promise<ProposalRecord>;
}

export interface CashRepository {
  balanceOf(currency: string, address: string): Promise<string>;
  balancesOf(address: string): Promise<CashBalanceRecord[]>;
  /** Mint/fund: add `amount` to (currency,address). */
  credit(currency: string, address: string, amount: string): Promise<void>;
  /** Payment leg: move `amount` from→to in `currency`; throws on insufficient funds. */
  transfer(currency: string, from: string, to: string, amount: string): Promise<void>;
}

export type OrgStatus = "pending" | "active" | "suspended" | "rejected";

/** Legal structure of an Indian company — the KYB "category". */
export type CompanyCategory = "private-limited" | "public-limited" | "llp" | "opc" | "section-8";

/** A stored KYB document reference — sha256 comes from the SERVER's document record. */
export interface KybDocumentRef {
  id: string;
  sha256: string;
}

/**
 * India-specific KYB details captured at corporate self-registration and shown to
 * the Platform Admin at approval. Statutory identifiers (CIN/PAN/GSTIN) are stored
 * as reference numbers plus REFERENCES to uploaded certificates in the document
 * store (id + sha256) — the file bytes themselves live in the store, gated behind
 * the authenticated document read route.
 */
export interface CompanyProfile {
  cin: string;
  pan: string;
  gstin: string | null;
  state: string;
  pincode: string;
  dateOfIncorporation: string; // ISO calendar date, yyyy-mm-dd
  category: CompanyCategory;
  companyStatus: "active" | "inactive";
  /** Statutory certificates uploaded at registration. CIN required, GSTIN optional. */
  documents: {
    cinCertificate: KybDocumentRef;
    gstinCertificate: KybDocumentRef | null;
  };
}

export interface OrganizationRecord {
  id: string;
  name: string;
  orgType: OrgType;
  registrationId: string | null;
  jurisdiction: string | null;
  did: string;
  didSeedEncrypted: string;
  status: OrgStatus;
  verified: boolean;
  verifiedAt: string | null;
  /** Present for self-registered corporates; null for platform-created orgs. */
  companyProfile: CompanyProfile | null;
  /** EN-A capability envelope; null = unrestricted legacy (predates EN-A or path didn't choose). */
  capabilities: OrgCapabilities | null;
  createdAt: string;
}

export interface OrganizationRepository {
  create(input: Omit<OrganizationRecord, "id" | "createdAt">): Promise<OrganizationRecord>;
  get(id: string): Promise<OrganizationRecord | null>;
  findByName(name: string): Promise<OrganizationRecord | null>;
  /** The org whose parent DID is `did` — the issuer of a credential signed by it. */
  findByDid(did: string): Promise<OrganizationRecord | null>;
  findByRegistrationId(registrationId: string): Promise<OrganizationRecord | null>;
  list(): Promise<OrganizationRecord[]>;
  setVerified(id: string, verified: boolean, verifiedAt: string | null): Promise<OrganizationRecord>;
  setStatus(id: string, status: OrgStatus): Promise<OrganizationRecord>;
  setCapabilities(id: string, caps: OrgCapabilities | null): Promise<OrganizationRecord>;
  remove(id: string): Promise<void>;
}

export interface CredentialRecord {
  id: string;
  holderDid: string;
  issuerDid: string;
  type: string;
  vcJwt: string;
  subjectClaims: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
  revokedReason: string | null;
  revokedBy: string | null;
  proposalId: string | null;
  credentialUseCaseKey: string | null;
  /** Holder acceptance lifecycle (ID-L). Non-use-case issuance and use cases
   *  without `holderAcceptance` are born "accepted" (back-compat default). */
  acceptance: "accepted" | "pending" | "rejected" | "changes_requested";
  acceptanceAt: string | null;
  acceptanceNote: string | null;
  /** Receipt of the on-chain anchor write at issuance (null: no registry / pre-ID-O). */
  anchorTxHash: string | null;
  anchorChainId: string | null;
  /** Receipt of the on-chain revoke write (null until revoked on-chain). */
  revokeTxHash: string | null;
}

export interface CredentialRepository {
  /** `id` is supplied by the caller: the VC embeds it in `jti` + credentialStatus before signing. */
  create(input: CredentialRecord): Promise<CredentialRecord>;
  listByHolder(holderDid: string): Promise<CredentialRecord[]>;
  listByIssuer(issuerDid: string): Promise<CredentialRecord[]>;
  /** Every stored credential, unordered — dashboard aggregation input (callers sort/filter). */
  list(): Promise<CredentialRecord[]>;
  get(id: string): Promise<CredentialRecord | null>;
  setRevoked(id: string, revoked: boolean): Promise<CredentialRecord>;
  revoke(id: string, input: { reason: string; by: string; at: string; txHash?: string | null }): Promise<CredentialRecord>;
  setAcceptance(id: string, patch: { acceptance: CredentialRecord["acceptance"]; at: string; note: string | null }): Promise<CredentialRecord>;
}

export interface RegistryDeploymentRecord {
  chainId: string;
  didRegistry: string;
  vcRegistry: string;
  deployTxHash: string;
  createdAt: string;
}

export interface RegistryDeploymentRepository {
  get(chainId: string): Promise<RegistryDeploymentRecord | null>;
  create(input: Omit<RegistryDeploymentRecord, "createdAt">): Promise<RegistryDeploymentRecord>;
}

export type VerificationStatus = "pending" | "consented" | "rejected" | "expired";

export interface VerificationRequestRecord {
  id: string;
  verifierOrgId: string;
  holderDid: string;
  requestedTypes: string[];
  purpose: string;
  credentialUseCaseKey: string | null;
  challenge: string;
  status: VerificationStatus;
  presentationVpJwt: string | null;
  consentedAt: string | null;
  consentedCredentialIds: string[] | null;
  verifierResult: Record<string, unknown> | null;
  verifiedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface VerificationRequestRepository {
  create(input: Omit<VerificationRequestRecord, "id" | "createdAt">): Promise<VerificationRequestRecord>;
  get(id: string): Promise<VerificationRequestRecord | null>;
  listByHolder(holderDid: string, status?: string): Promise<VerificationRequestRecord[]>;
  listByVerifierOrg(orgId: string, status?: string): Promise<VerificationRequestRecord[]>;
  /** Every stored request, unordered — dashboard aggregation input (callers sort/filter). */
  list(): Promise<VerificationRequestRecord[]>;
  setConsented(id: string, input: { vpJwt: string; credentialIds: string[]; at: string }): Promise<VerificationRequestRecord>;
  setStatus(id: string, status: VerificationStatus): Promise<VerificationRequestRecord>;
  setVerifierResult(id: string, input: { result: Record<string, unknown>; at: string }): Promise<VerificationRequestRecord>;
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

export interface LoginKeyRecord {
  id: string;
  userId: string;
  did: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface LoginKeyRepository {
  create(input: Omit<LoginKeyRecord, "id" | "createdAt" | "lastUsedAt">): Promise<LoginKeyRecord>;
  listByUser(userId: string): Promise<LoginKeyRecord[]>;
  getByDid(did: string): Promise<LoginKeyRecord | null>;
  get(id: string): Promise<LoginKeyRecord | null>;
  remove(id: string): Promise<void>;
  touch(id: string, at: string): Promise<void>;
}

/**
 * An org-scoped machine credential (EN-B), bound to a service user — the
 * principal the key becomes. The secret itself is NEVER stored: only its bcrypt
 * hash plus the public `prefix` used to find the row before hashing.
 */
export interface ApiKeyRecord {
  id: string;
  /** Owning org; null = platform-owned key (PlatformAdmin-minted). */
  orgId: string | null;
  /** The bound service user whose role/useCaseKey/orgId this key authenticates as. */
  userId: string;
  name: string;
  /** First 8 chars of the secret body — safe to display and index. */
  prefix: string;
  secretHash: string;
  /** Coarse scopes from core's API_SCOPES vocabulary; persisted as a JSON string. */
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ApiKeyRepository {
  /** Lifecycle columns (`lastUsedAt`/`revokedAt`/`revokedBy`) are repo-managed and start null. */
  create(input: Omit<ApiKeyRecord, "id" | "createdAt" | "lastUsedAt" | "revokedAt" | "revokedBy">): Promise<ApiKeyRecord>;
  /** The single indexed lookup the auth path does before any hash work. */
  findByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  findById(id: string): Promise<ApiKeyRecord | null>;
  /**
   * Every key of the org, newest first — INCLUDING revoked and expired ones:
   * they are the audit trail of what was ever granted, so nothing is filtered.
   */
  listByOrg(orgId: string): Promise<ApiKeyRecord[]>;
  /** Last-use stamp; callers throttle the write (see the design's compare-then-write). */
  touchLastUsed(id: string, at: string): Promise<void>;
  /** Soft revoke: sets `revokedAt`/`revokedBy`, keeping the row for the audit trail. */
  revoke(id: string, input: { by: string; at: string }): Promise<ApiKeyRecord>;
}
