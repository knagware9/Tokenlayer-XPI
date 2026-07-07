import { normalizeUseCaseDefinition, PolicyError, type UseCaseDefinition } from "@tokenlayer/core";
import type {
  AccountRecord,
  AccountRepository,
  AssetFilter,
  AssetRecord,
  AssetRepository,
  AuditEntryRecord,
  AuditRepository,
  CashBalanceRecord,
  CashRepository,
  ListingRecord,
  ListingRepository,
  Page,
  Paged,
  SaleTerms,
  UseCaseRepository,
  UserRecord,
  UserRepository,
} from "./types.js";
import { ListingConflictError } from "./types.js";

let counter = 0;
const id = (prefix: string): string => `${prefix}_${(++counter).toString(36)}`;
const now = (): string => new Date().toISOString();

/** In-memory persistence — used by integration tests and the demo script. */
export class MemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, UserRecord>();
  async findByEmail(email: string): Promise<UserRecord | null> {
    return [...this.byId.values()].find((u) => u.email === email) ?? null;
  }
  async findById(userId: string): Promise<UserRecord | null> {
    return this.byId.get(userId) ?? null;
  }
  async create(input: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord> {
    const rec: UserRecord = { ...input, id: id("user"), createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async list(useCaseKey?: string): Promise<UserRecord[]> {
    const all = [...this.byId.values()];
    return useCaseKey ? all.filter((u) => u.useCaseKey === useCaseKey) : all;
  }
  async update(userId: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus">>): Promise<UserRecord> {
    const rec = this.byId.get(userId);
    if (!rec) throw new Error(`unknown user '${userId}'`);
    Object.assign(rec, patch);
    return rec;
  }
  async remove(userId: string): Promise<void> {
    this.byId.delete(userId);
  }
}

export class MemoryAssetRepository implements AssetRepository {
  private readonly byId = new Map<string, AssetRecord>();
  async create(input: Omit<AssetRecord, "createdAt">): Promise<AssetRecord> {
    const rec: AssetRecord = {
      ...input,
      unitPrice: input.unitPrice ?? null,
      currency: input.currency ?? null,
      treasuryAccount: input.treasuryAccount ?? null,
      createdAt: now(),
    };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async get(assetId: string): Promise<AssetRecord | null> {
    return this.byId.get(assetId) ?? null;
  }
  async list(filter: AssetFilter = {}, page: Page = {}): Promise<Paged<AssetRecord>> {
    const matched = [...this.byId.values()]
      .filter((a) => (!filter.useCaseKey || a.useCaseKey === filter.useCaseKey))
      .filter((a) => (!filter.chainId || a.chainId === filter.chainId))
      .filter((a) => (!filter.status || a.status === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return paginate(matched, page);
  }
  async setStatus(assetId: string, status: string): Promise<void> {
    const rec = this.byId.get(assetId);
    if (rec) rec.status = status;
  }
  async setSaleTerms(id: string, terms: SaleTerms): Promise<void> {
    const a = this.byId.get(id);
    if (a) { a.unitPrice = terms.unitPrice; a.currency = terms.currency; a.treasuryAccount = terms.treasuryAccount; }
  }
  async findByMetadata(useCaseKey: string, field: string, value: unknown): Promise<AssetRecord | null> {
    for (const a of this.byId.values()) {
      if (a.useCaseKey === useCaseKey && a.metadata?.[field] === value) return a;
    }
    return null;
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
  async listByAsset(assetId: string, page: Page = {}): Promise<Paged<AuditEntryRecord>> {
    const matched = this.entries.filter((e) => e.assetId === assetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return paginate(matched, page);
  }
  async listByAssetIds(assetIds: string[], page: Page = {}): Promise<Paged<AuditEntryRecord>> {
    if (assetIds.length === 0) return { items: [], total: 0 };
    const ids = new Set(assetIds);
    const matched = this.entries
      .filter((e) => e.assetId !== undefined && ids.has(e.assetId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return paginate(matched, page);
  }
}

function paginate<T>(rows: T[], page: Page): Paged<T> {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? rows.length;
  return { items: rows.slice(offset, offset + limit), total: rows.length };
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

export class MemoryListingRepository implements ListingRepository {
  private readonly byId = new Map<string, ListingRecord>();
  async create(input: Pick<ListingRecord, "assetId" | "seller" | "quantity" | "unitPrice" | "currency">): Promise<ListingRecord> {
    const at = now();
    const rec: ListingRecord = { ...input, id: id("listing"), status: "open", createdAt: at, updatedAt: at };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async get(listingId: string): Promise<ListingRecord | null> {
    return this.byId.get(listingId) ?? null;
  }
  async listByAsset(assetId: string, status?: string): Promise<ListingRecord[]> {
    return [...this.byId.values()]
      .filter((l) => l.assetId === assetId)
      .filter((l) => (!status || l.status === status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  // Each method below is a single synchronous mutation per call — the JS event
  // loop makes it atomic with respect to concurrent requests (no await between
  // the check and the write), mirroring the Prisma repo's CAS semantics.
  async reserve(listingId: string, by: string): Promise<ListingRecord> {
    const rec = this.byId.get(listingId);
    if (!rec) throw new Error(`unknown listing '${listingId}'`);
    if (rec.status !== "open") throw new ListingConflictError("LISTING_NOT_OPEN", `listing '${listingId}' is ${rec.status}`);
    const remaining = BigInt(rec.quantity) - BigInt(by);
    if (remaining < 0n) throw new ListingConflictError("TAKE_EXCEEDS_REMAINING", `only ${rec.quantity} remain on listing '${listingId}'`);
    rec.quantity = remaining.toString();
    if (remaining === 0n) rec.status = "filled";
    rec.updatedAt = now();
    return { ...rec };
  }
  async restore(listingId: string, by: string): Promise<ListingRecord> {
    const rec = this.byId.get(listingId);
    if (!rec) throw new Error(`unknown listing '${listingId}'`);
    rec.quantity = (BigInt(rec.quantity) + BigInt(by)).toString();
    if (rec.status === "filled") rec.status = "open";
    rec.updatedAt = now();
    return { ...rec };
  }
  async cancel(listingId: string): Promise<ListingRecord> {
    const rec = this.byId.get(listingId);
    if (!rec) throw new Error(`unknown listing '${listingId}'`);
    if (rec.status !== "open") throw new ListingConflictError("LISTING_NOT_OPEN", `listing '${listingId}' is ${rec.status}`);
    rec.status = "cancelled";
    rec.updatedAt = now();
    return { ...rec };
  }
  async reopen(listingId: string): Promise<ListingRecord> {
    const rec = this.byId.get(listingId);
    if (!rec) throw new Error(`unknown listing '${listingId}'`);
    if (rec.status !== "open") {
      rec.status = "open";
      rec.updatedAt = now();
    }
    return { ...rec };
  }
}

export class MemoryCashRepository implements CashRepository {
  private readonly balances = new Map<string, bigint>(); // key: `${currency} ${address}`
  private key(currency: string, address: string): string {
    return `${currency} ${address}`;
  }
  async balanceOf(currency: string, address: string): Promise<string> {
    return (this.balances.get(this.key(currency, address)) ?? 0n).toString();
  }
  async balancesOf(address: string): Promise<CashBalanceRecord[]> {
    const out: CashBalanceRecord[] = [];
    for (const [k, amount] of this.balances) {
      const [currency, addr] = k.split(" ");
      if (addr === address && amount > 0n) out.push({ currency: currency!, address, amount: amount.toString() });
    }
    return out;
  }
  async credit(currency: string, address: string, amount: string): Promise<void> {
    const k = this.key(currency, address);
    this.balances.set(k, (this.balances.get(k) ?? 0n) + BigInt(amount));
  }
  async transfer(currency: string, from: string, to: string, amount: string): Promise<void> {
    const amt = BigInt(amount);
    const fromKey = this.key(currency, from);
    const have = this.balances.get(fromKey) ?? 0n;
    if (have < amt) {
      throw new PolicyError("INSUFFICIENT_FUNDS", `INSUFFICIENT_FUNDS: ${from} has insufficient ${currency} (has ${have}, needs ${amt})`, { from, currency, have: have.toString(), needs: amt.toString() });
    }
    this.balances.set(fromKey, have - amt);
    const toKey = this.key(currency, to);
    this.balances.set(toKey, (this.balances.get(toKey) ?? 0n) + amt);
  }
}

export class MemoryAccountRepository implements AccountRepository {
  private readonly byAddress = new Map<string, AccountRecord>();
  async list(): Promise<AccountRecord[]> {
    return [...this.byAddress.values()];
  }
  async findById(accountId: string): Promise<AccountRecord | null> {
    return [...this.byAddress.values()].find((a) => a.id === accountId) ?? null;
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
