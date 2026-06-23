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
}

export interface AuditRepository {
  append(entry: Omit<AuditEntryRecord, "id" | "createdAt"> & { createdAt?: string }): Promise<AuditEntryRecord>;
  listByAsset(assetId: string, page?: Page): Promise<Paged<AuditEntryRecord>>;
}

export interface AccountRepository {
  list(): Promise<AccountRecord[]>;
  findById(id: string): Promise<AccountRecord | null>;
  upsert(address: string, label: string): Promise<AccountRecord>;
}

/** A writable use-case store. Also satisfies the engine's UseCaseSource. */
export interface UseCaseRepository extends UseCaseSource {
  create(def: UseCaseDefinition): Promise<UseCaseDefinition>;
  update(key: string, def: UseCaseDefinition): Promise<UseCaseDefinition>;
}

export interface CashBalanceRecord {
  currency: string;
  address: string;
  amount: string;
}

export interface CashRepository {
  balanceOf(currency: string, address: string): Promise<string>;
  balancesOf(address: string): Promise<CashBalanceRecord[]>;
  /** Mint/fund: add `amount` to (currency,address). */
  credit(currency: string, address: string, amount: string): Promise<void>;
  /** Payment leg: move `amount` from→to in `currency`; throws on insufficient funds. */
  transfer(currency: string, from: string, to: string, amount: string): Promise<void>;
}
