import { normalizeUseCaseDefinition, PolicyError, type UseCaseDefinition } from "@tokenlayer/core";
import type {
  AccountRecord,
  AccountRepository,
  AssetRecord,
  AssetRepository,
  AuditEntryRecord,
  AuditRepository,
  UseCaseRepository,
  UserRecord,
  UserRepository,
} from "./types.js";

let counter = 0;
const id = (prefix: string): string => `${prefix}_${(++counter).toString(36)}`;
const now = (): string => new Date().toISOString();

/** In-memory persistence — used by integration tests and the demo script. */
export class MemoryUserRepository implements UserRepository {
  private readonly byEmail = new Map<string, UserRecord>();
  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.byEmail.get(email) ?? null;
  }
  async create(input: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord> {
    const rec: UserRecord = { ...input, id: id("user"), createdAt: now() };
    this.byEmail.set(rec.email, rec);
    return rec;
  }
  async list(): Promise<UserRecord[]> {
    return [...this.byEmail.values()];
  }
}

export class MemoryAssetRepository implements AssetRepository {
  private readonly byId = new Map<string, AssetRecord>();
  async create(input: Omit<AssetRecord, "createdAt">): Promise<AssetRecord> {
    const rec: AssetRecord = { ...input, createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async get(assetId: string): Promise<AssetRecord | null> {
    return this.byId.get(assetId) ?? null;
  }
  async list(): Promise<AssetRecord[]> {
    return [...this.byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async setStatus(assetId: string, status: string): Promise<void> {
    const rec = this.byId.get(assetId);
    if (rec) rec.status = status;
  }
}

export class MemoryAuditRepository implements AuditRepository {
  private readonly entries: AuditEntryRecord[] = [];
  async append(
    entry: Omit<AuditEntryRecord, "id" | "createdAt"> & { createdAt?: string },
  ): Promise<AuditEntryRecord> {
    const rec: AuditEntryRecord = { ...entry, id: id("audit"), createdAt: entry.createdAt ?? now() };
    this.entries.push(rec);
    return rec;
  }
  async listByAsset(assetId: string): Promise<AuditEntryRecord[]> {
    return this.entries.filter((e) => e.assetId === assetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export class MemoryUseCaseRepository implements UseCaseRepository {
  private readonly byKey = new Map<string, UseCaseDefinition>();

  async has(key: string): Promise<boolean> {
    return this.byKey.has(key);
  }
  async get(key: string): Promise<UseCaseDefinition> {
    const def = this.byKey.get(key);
    if (!def) throw new PolicyError("UNKNOWN_USECASE", `unknown use case '${key}'`, { key });
    return def;
  }
  async list(): Promise<UseCaseDefinition[]> {
    return [...this.byKey.values()];
  }
  async create(raw: UseCaseDefinition): Promise<UseCaseDefinition> {
    const def = normalizeUseCaseDefinition(raw);
    if (this.byKey.has(def.key)) throw new PolicyError("INVALID_USECASE", `use case '${def.key}' already exists`, { key: def.key });
    this.byKey.set(def.key, def);
    return def;
  }
  async update(key: string, raw: UseCaseDefinition): Promise<UseCaseDefinition> {
    if (!this.byKey.has(key)) throw new PolicyError("UNKNOWN_USECASE", `unknown use case '${key}'`, { key });
    const def = normalizeUseCaseDefinition({ ...raw, key });
    this.byKey.set(key, def);
    return def;
  }
}

export class MemoryAccountRepository implements AccountRepository {
  private readonly byAddress = new Map<string, AccountRecord>();
  async list(): Promise<AccountRecord[]> {
    return [...this.byAddress.values()];
  }
  async upsert(address: string, label: string): Promise<AccountRecord> {
    const existing = this.byAddress.get(address);
    if (existing) {
      existing.label = label;
      return existing;
    }
    const rec: AccountRecord = { id: id("acct"), address, label };
    this.byAddress.set(address, rec);
    return rec;
  }
}
