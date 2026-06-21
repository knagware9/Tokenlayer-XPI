import type { Role, TokenStandard, TokenType, LifecycleAction, UseCaseDefinition, UseCaseSource } from "@tokenlayer/core";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
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
  create(input: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord>;
  list(): Promise<UserRecord[]>;
}

export interface AssetRepository {
  create(input: Omit<AssetRecord, "createdAt">): Promise<AssetRecord>;
  get(id: string): Promise<AssetRecord | null>;
  list(): Promise<AssetRecord[]>;
  setStatus(id: string, status: string): Promise<void>;
}

export interface AuditRepository {
  append(entry: Omit<AuditEntryRecord, "id" | "createdAt"> & { createdAt?: string }): Promise<AuditEntryRecord>;
  listByAsset(assetId: string): Promise<AuditEntryRecord[]>;
}

export interface AccountRepository {
  list(): Promise<AccountRecord[]>;
  upsert(address: string, label: string): Promise<AccountRecord>;
}

/** A writable use-case store. Also satisfies the engine's UseCaseSource. */
export interface UseCaseRepository extends UseCaseSource {
  create(def: UseCaseDefinition): Promise<UseCaseDefinition>;
  update(key: string, def: UseCaseDefinition): Promise<UseCaseDefinition>;
}
