/**
 * IN-MEMORY REPOSITORIES — Tokenization tables — assets, holdings, cash, invoices.
 *
 * Bucketed by `../model-domains.ts`. Its Prisma twin is `../prisma/tokenization.ts`,
 * and `persistence-parity.test.ts` fails if the two stop implementing the same
 * set — the drift that the PARITY RULE exists to catch.
 */
import { randomUUID } from "node:crypto";
import { id, now, paginate } from "./common.js";
import { PolicyError, normalizeUseCaseDefinition } from "@tokenlayer/core";
import type { UseCaseDefinition } from "@tokenlayer/core";
import type { AccountRecord, AccountRepository, AssetDueDiligence, AssetFilter, AssetRecord, AssetRepository, CashBalanceRecord, CashRepository, CashflowRecord, CashflowRepository, ListingRecord, ListingRepository, Page, Paged, SaleTerms, StagedInvoiceRecord, StagedInvoiceRepository, StagedInvoiceStatus, UseCaseRepository } from "../types/index.js";
import { ListingConflictError } from "../types/index.js";

export class MemoryAssetRepository implements AssetRepository {
  private readonly byId = new Map<string, AssetRecord>();
  async create(input: Omit<AssetRecord, "createdAt">): Promise<AssetRecord> {
    // Mirror the DB's (useCaseKey, uniqueKey) unique constraint: reject a second
    // asset with the same non-null uniqueKey in the same use case (throws a
    // P2002-shaped error the issue route maps to 409, same as Prisma).
    if (input.uniqueKey != null) {
      for (const a of this.byId.values()) {
        if (a.useCaseKey === input.useCaseKey && a.uniqueKey === input.uniqueKey) {
          throw Object.assign(new Error("Unique constraint failed on (useCaseKey, uniqueKey)"), { code: "P2002" });
        }
      }
    }
    const rec: AssetRecord = {
      ...input,
      unitPrice: input.unitPrice ?? null,
      currency: input.currency ?? null,
      treasuryAccount: input.treasuryAccount ?? null,
      uniqueKey: input.uniqueKey ?? null,
      dueDiligence: input.dueDiligence ?? null,
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
  async casStatus(assetId: string, from: string, to: string): Promise<boolean> {
    // No `await` between the read and the write — this process is
    // single-threaded, so nothing can interleave here. Still models the same
    // contract as PrismaAssetRepository's WHERE-guarded updateMany, so a test
    // exercising the memory repo genuinely exercises the CAS semantics.
    const rec = this.byId.get(assetId);
    if (!rec || rec.status !== from) return false;
    rec.status = to;
    return true;
  }
  async setSaleTerms(id: string, terms: SaleTerms): Promise<void> {
    const a = this.byId.get(id);
    if (a) { a.unitPrice = terms.unitPrice; a.currency = terms.currency; a.treasuryAccount = terms.treasuryAccount; }
  }
  async setDueDiligence(id: string, patch: Partial<AssetDueDiligence>): Promise<void> {
    const a = this.byId.get(id);
    // No `await` between the read and the write: this whole method runs as
    // one synchronous turn, so two "concurrent" callers can never interleave
    // here — each call sees whatever the previous call already merged in.
    if (a) a.dueDiligence = { ...(a.dueDiligence ?? {}), ...patch };
  }
  async appendAdditionalDocument(id: string, doc: { id: string; sha256: string; label: string }): Promise<void> {
    const a = this.byId.get(id);
    if (a) {
      const dd = a.dueDiligence ?? {};
      a.dueDiligence = { ...dd, additionalDocuments: [...(dd.additionalDocuments ?? []), doc] };
    }
  }
  async findByMetadata(useCaseKey: string, field: string, value: unknown): Promise<AssetRecord | null> {
    if (value === undefined) return null; // never match on a missing field (undefined === undefined footgun)
    for (const a of this.byId.values()) {
      if (a.useCaseKey === useCaseKey && a.metadata?.[field] === value) return a;
    }
    return null;
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

export class MemoryCashflowRepository implements CashflowRepository {
  private rows = new Map<string, CashflowRecord>();
  async createMany(assetId: string, currency: string, rows: { seq: number; kind: "coupon" | "redemption"; dueDate: string; amount: string }[]): Promise<void> {
    for (const r of rows) {
      const cfId = randomUUID();
      this.rows.set(cfId, { id: cfId, assetId, currency, status: "scheduled", executedAt: null, ...r });
    }
  }
  async listByAsset(assetId: string): Promise<CashflowRecord[]> {
    return [...this.rows.values()].filter((r) => r.assetId === assetId).sort((a, b) => a.seq - b.seq);
  }
  async get(cfId: string): Promise<CashflowRecord | null> {
    return this.rows.get(cfId) ?? null;
  }
  // claim/release/markExecuted mirror the Prisma repo's CAS semantics: each is a
  // single synchronous mutation (no await between check and write), so the JS
  // event loop makes it atomic with respect to concurrent requests.
  async claim(cfId: string): Promise<boolean> {
    const r = this.rows.get(cfId);
    if (!r || r.status !== "scheduled") return false;
    r.status = "executing";
    return true;
  }
  async release(cfId: string): Promise<void> {
    const r = this.rows.get(cfId);
    if (r && r.status === "executing") r.status = "scheduled";
  }
  async markExecuted(cfId: string, executedAt: string): Promise<CashflowRecord> {
    const r = this.rows.get(cfId);
    if (!r) throw new Error(`unknown cashflow '${cfId}'`);
    if (r.status !== "executing") throw new Error(`cashflow '${cfId}' is '${r.status}', not 'executing' — claim it before marking executed`);
    r.status = "executed";
    r.executedAt = executedAt;
    return r;
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
  async findByAddress(address: string): Promise<AccountRecord | null> {
    return this.byAddress.get(address) ?? null;
  }
  async upsert(address: string, label: string, ownerOrgId?: string): Promise<AccountRecord> {
    const existing = this.byAddress.get(address);
    if (existing) {
      existing.label = label;
      if (ownerOrgId !== undefined) existing.ownerOrgId = ownerOrgId;
      return existing;
    }
    const rec: AccountRecord = { id: id("acct"), address, label, ownerOrgId: ownerOrgId ?? null };
    this.byAddress.set(address, rec);
    return rec;
  }
}

export class MemoryStagedInvoiceRepository implements StagedInvoiceRepository {
  private readonly byId = new Map<string, StagedInvoiceRecord>();
  async create(input: Omit<StagedInvoiceRecord, "id" | "createdAt">): Promise<StagedInvoiceRecord> {
    const rec: StagedInvoiceRecord = { ...input, id: id("inv"), createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async get(invId: string): Promise<StagedInvoiceRecord | null> {
    return this.byId.get(invId) ?? null;
  }
  async listByUseCase(useCaseKey: string, status?: StagedInvoiceStatus): Promise<StagedInvoiceRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.useCaseKey === useCaseKey && (!status || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async findByHash(useCaseKey: string, invoiceHash: string): Promise<StagedInvoiceRecord | null> {
    return [...this.byId.values()].find((r) => r.useCaseKey === useCaseKey && r.invoiceHash === invoiceHash) ?? null;
  }
  async markTokenized(invId: string, assetId: string, at: string): Promise<StagedInvoiceRecord> {
    const rec = this.byId.get(invId);
    if (!rec) throw new Error(`unknown staged invoice '${invId}'`);
    rec.status = "tokenized";
    rec.assetId = assetId;
    rec.tokenizedAt = at;
    return rec;
  }
  async remove(invId: string): Promise<void> {
    this.byId.delete(invId);
  }
}
