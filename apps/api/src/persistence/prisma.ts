import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { Asset } from "@prisma/client";
import {
  normalizeUseCaseDefinition,
  PolicyError,
  type LifecycleAction,
  type Role,
  type TokenStandard,
  type TokenType,
  type UseCaseDefinition,
} from "@tokenlayer/core";
import type {
  AccountRecord,
  AccountRepository,
  AssetFilter,
  AssetRecord,
  AssetRepository,
  AuditEntryRecord,
  AuditRepository,
  CashBalanceRecord,
  CashflowRecord,
  CashflowRepository,
  CashRepository,
  DocumentRecord,
  DocumentRepository,
  KycDetails,
  KycStatus,
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

export const prisma = new PrismaClient();

const toUser = (r: {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  useCaseKey: string | null;
  accountId: string | null;
  active: boolean;
  kycStatus: string;
  kyc: string | null;
  createdAt: Date;
}): UserRecord => ({
  id: r.id,
  email: r.email,
  passwordHash: r.passwordHash,
  role: r.role as Role,
  useCaseKey: r.useCaseKey,
  accountId: r.accountId,
  active: r.active,
  kycStatus: r.kycStatus as KycStatus,
  kyc: r.kyc ? (JSON.parse(r.kyc) as KycDetails) : null,
  createdAt: r.createdAt.toISOString(),
});

export class PrismaUserRepository implements UserRepository {
  async findByEmail(email: string): Promise<UserRecord | null> {
    const r = await prisma.user.findUnique({ where: { email } });
    return r ? toUser(r) : null;
  }
  async findById(id: string): Promise<UserRecord | null> {
    const r = await prisma.user.findUnique({ where: { id } });
    return r ? toUser(r) : null;
  }
  async create(input: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord> {
    return toUser(await prisma.user.create({ data: { ...input, kyc: input.kyc ? JSON.stringify(input.kyc) : null } }));
  }
  async list(useCaseKey?: string): Promise<UserRecord[]> {
    return (await prisma.user.findMany({ where: useCaseKey ? { useCaseKey } : undefined, orderBy: { createdAt: "asc" } })).map(toUser);
  }
  async update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus">>): Promise<UserRecord> {
    return toUser(await prisma.user.update({ where: { id }, data: patch }));
  }
  async remove(id: string): Promise<void> {
    await prisma.user.delete({ where: { id } });
  }
}

function toAsset(r: Asset, parsedMetadata?: Record<string, unknown>): AssetRecord {
  return {
    id: r.id,
    useCaseKey: r.useCaseKey,
    name: r.name,
    symbol: r.symbol,
    chainId: r.chainId,
    contractRef: r.contractRef,
    tokenType: r.tokenType as TokenType,
    tokenStandard: r.tokenStandard as TokenStandard,
    metadata: parsedMetadata ?? JSON.parse(r.metadata) as Record<string, unknown>,
    status: r.status,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    unitPrice: r.unitPrice,
    currency: r.currency,
    treasuryAccount: r.treasuryAccount,
    uniqueKey: r.uniqueKey,
  };
}

export class PrismaAssetRepository implements AssetRepository {
  async create(input: Omit<AssetRecord, "createdAt">): Promise<AssetRecord> {
    const r = await prisma.asset.create({
      data: {
        ...input,
        uniqueKey: input.uniqueKey ?? null,
        metadata: JSON.stringify(input.metadata),
      },
    });
    return toAsset(r, input.metadata);
  }
  async get(id: string): Promise<AssetRecord | null> {
    const r = await prisma.asset.findUnique({ where: { id } });
    if (!r) return null;
    return toAsset(r);
  }
  async list(filter: AssetFilter = {}, page: Page = {}): Promise<Paged<AssetRecord>> {
    const where = {
      ...(filter.useCaseKey ? { useCaseKey: filter.useCaseKey } : {}),
      ...(filter.chainId ? { chainId: filter.chainId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.asset.findMany({ where, orderBy: { createdAt: "desc" }, skip: page.offset ?? 0, take: page.limit }),
      prisma.asset.count({ where }),
    ]);
    return {
      items: rows.map((r) => toAsset(r)),
      total,
    };
  }
  async setStatus(id: string, status: string): Promise<void> {
    await prisma.asset.update({ where: { id }, data: { status } });
  }
  async setSaleTerms(id: string, terms: SaleTerms): Promise<void> {
    await prisma.asset.update({ where: { id }, data: { unitPrice: terms.unitPrice, currency: terms.currency, treasuryAccount: terms.treasuryAccount } });
  }
  // Metadata is stored as a JSON string column, so filter in-process over the
  // (small) per-use-case set rather than with a JSON query.
  async findByMetadata(useCaseKey: string, field: string, value: unknown): Promise<AssetRecord | null> {
    if (value === undefined) return null; // never match on a missing field (undefined === undefined footgun)
    const rows = await prisma.asset.findMany({ where: { useCaseKey } });
    const hit = rows.find((r) => (JSON.parse(r.metadata) as Record<string, unknown>)?.[field] === value);
    return hit ? toAsset(hit) : null;
  }
}

export class PrismaAuditRepository implements AuditRepository {
  async append(
    entry: Omit<AuditEntryRecord, "id" | "createdAt"> & { createdAt?: string },
  ): Promise<AuditEntryRecord> {
    const r = await prisma.auditLog.create({
      data: {
        assetId: entry.assetId,
        actorId: entry.actorId,
        action: entry.action,
        payload: JSON.stringify(entry.payload),
        txHash: entry.txHash,
        chainId: entry.chainId,
        ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
      },
    });
    return {
      id: r.id,
      assetId: r.assetId ?? undefined,
      actorId: r.actorId,
      action: r.action as LifecycleAction,
      payload: entry.payload,
      txHash: r.txHash ?? undefined,
      chainId: r.chainId ?? undefined,
      createdAt: r.createdAt.toISOString(),
    };
  }
  async listByAsset(assetId: string, page: Page = {}): Promise<Paged<AuditEntryRecord>> {
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where: { assetId }, orderBy: { createdAt: "desc" }, skip: page.offset ?? 0, take: page.limit }),
      prisma.auditLog.count({ where: { assetId } }),
    ]);
    return {
      items: rows.map(toAuditRecord),
      total,
    };
  }
  async listByAssetIds(assetIds: string[], page: Page = {}): Promise<Paged<AuditEntryRecord>> {
    if (assetIds.length === 0) return { items: [], total: 0 };
    const where = { assetId: { in: assetIds } };
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: "asc" }, skip: page.offset ?? 0, take: page.limit ?? 10000 }),
      prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map(toAuditRecord),
      total,
    };
  }
}

function toAuditRecord(r: {
  id: string;
  assetId: string | null;
  actorId: string;
  action: string;
  payload: string;
  txHash: string | null;
  chainId: string | null;
  createdAt: Date;
}): AuditEntryRecord {
  return {
    id: r.id,
    assetId: r.assetId ?? undefined,
    actorId: r.actorId,
    action: r.action as LifecycleAction,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    txHash: r.txHash ?? undefined,
    chainId: r.chainId ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

export class PrismaDocumentRepository implements DocumentRepository {
  async create({ contentType, bytes }: { contentType: string; bytes: Buffer }): Promise<{ id: string; sha256: string; size: number }> {
    const sha256 = "0x" + createHash("sha256").update(bytes).digest("hex");
    const row = await prisma.document.create({ data: { contentType, sha256, size: bytes.length, bytes } });
    return { id: row.id, sha256, size: bytes.length };
  }
  async get(id: string): Promise<DocumentRecord | null> {
    const r = await prisma.document.findUnique({ where: { id } });
    return r
      ? { id: r.id, contentType: r.contentType, sha256: r.sha256, size: r.size, bytes: Buffer.from(r.bytes), createdAt: r.createdAt.toISOString() }
      : null;
  }
}

export class PrismaAccountRepository implements AccountRepository {
  async list(): Promise<AccountRecord[]> {
    return prisma.account.findMany();
  }
  async findById(id: string): Promise<AccountRecord | null> {
    const r = await prisma.account.findUnique({ where: { id } });
    return r ? { id: r.id, address: r.address, label: r.label } : null;
  }
  async upsert(address: string, label: string): Promise<AccountRecord> {
    return prisma.account.upsert({
      where: { address },
      update: { label },
      create: { address, label },
    });
  }
}

interface UseCaseRow {
  key: string;
  name: string;
  description: string | null;
  tokenStandard: string;
  symbol: string;
  defaultChainId: string;
  allowedChainIds: string;
  contracts: string;
  metadataSchema: string;
  lifecycle: string;
  compliance: string;
  fees: string;
  saleTermsDefault: string;
  valuation: string;
  derivedFields: string;
  uniqueBy: string | null;
  terms: string;
  workflow: string;
  roles: string;
}

/** Parse a JSON object column, tolerating null/empty/invalid → `{}`. */
function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToUseCase(r: UseCaseRow): UseCaseDefinition {
  const fees = parseJsonObject(r.fees);
  const saleTermsDefault = parseJsonObject(r.saleTermsDefault);
  const valuation = parseJsonObject(r.valuation);
  const derivedFields = parseJsonObject(r.derivedFields);
  const terms = parseJsonObject(r.terms);
  const workflow = parseJsonObject(r.workflow);
  return normalizeUseCaseDefinition({
    key: r.key,
    name: r.name,
    description: r.description ?? undefined,
    tokenStandard: r.tokenStandard,
    symbol: r.symbol,
    defaultChainId: r.defaultChainId,
    allowedChainIds: JSON.parse(r.allowedChainIds),
    contracts: JSON.parse(r.contracts),
    metadataSchema: JSON.parse(r.metadataSchema),
    lifecycle: JSON.parse(r.lifecycle),
    compliance: JSON.parse(r.compliance),
    // Omit empty objects so normalization leaves the optional fields unset.
    ...(Object.keys(fees).length > 0 ? { fees } : {}),
    ...(Object.keys(saleTermsDefault).length > 0 ? { saleTermsDefault } : {}),
    ...(Object.keys(valuation).length > 0 ? { valuation } : {}),
    ...(Object.keys(derivedFields).length > 0 ? { derivedFields: derivedFields as Record<string, "invoiceFingerprint"> } : {}),
    ...(r.uniqueBy ? { uniqueBy: r.uniqueBy } : {}),
    ...(Object.keys(terms).length > 0 ? { terms: terms as UseCaseDefinition["terms"] } : {}),
    ...(Object.keys(workflow).length > 0 ? { workflow: workflow as UseCaseDefinition["workflow"] } : {}),
    roles: JSON.parse(r.roles),
  });
}

function useCaseToData(def: UseCaseDefinition) {
  return {
    key: def.key,
    name: def.name,
    description: def.description ?? null,
    tokenStandard: def.tokenStandard,
    symbol: def.symbol,
    defaultChainId: def.defaultChainId,
    allowedChainIds: JSON.stringify(def.allowedChainIds),
    contracts: JSON.stringify(def.contracts ?? {}),
    metadataSchema: JSON.stringify(def.metadataSchema),
    lifecycle: JSON.stringify(def.lifecycle),
    compliance: JSON.stringify(def.compliance),
    fees: JSON.stringify(def.fees ?? {}),
    saleTermsDefault: JSON.stringify(def.saleTermsDefault ?? {}),
    valuation: JSON.stringify(def.valuation ?? {}),
    derivedFields: JSON.stringify(def.derivedFields ?? {}),
    uniqueBy: def.uniqueBy ?? null,
    terms: JSON.stringify(def.terms ?? {}),
    workflow: JSON.stringify(def.workflow ?? {}),
    roles: JSON.stringify(def.roles),
  };
}

export class PrismaUseCaseRepository implements UseCaseRepository {
  async has(key: string): Promise<boolean> {
    return (await prisma.useCase.count({ where: { key } })) > 0;
  }
  async get(key: string): Promise<UseCaseDefinition> {
    const r = await prisma.useCase.findUnique({ where: { key } });
    if (!r) throw new PolicyError("UNKNOWN_USECASE", `unknown use case '${key}'`, { key });
    return rowToUseCase(r);
  }
  async list(): Promise<UseCaseDefinition[]> {
    return (await prisma.useCase.findMany({ orderBy: { createdAt: "asc" } })).map(rowToUseCase);
  }
  async create(raw: UseCaseDefinition): Promise<UseCaseDefinition> {
    const def = normalizeUseCaseDefinition(raw);
    if (await this.has(def.key)) {
      throw new PolicyError("INVALID_USECASE", `use case '${def.key}' already exists`, { key: def.key });
    }
    await prisma.useCase.create({ data: useCaseToData(def) });
    return def;
  }
  async update(key: string, raw: UseCaseDefinition): Promise<UseCaseDefinition> {
    if (!(await this.has(key))) throw new PolicyError("UNKNOWN_USECASE", `unknown use case '${key}'`, { key });
    const def = normalizeUseCaseDefinition({ ...raw, key });
    const { key: _omit, ...data } = useCaseToData(def);
    await prisma.useCase.update({ where: { key }, data });
    return def;
  }
}

const toListing = (r: {
  id: string;
  assetId: string;
  seller: string;
  quantity: string;
  unitPrice: string;
  currency: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): ListingRecord => ({
  id: r.id,
  assetId: r.assetId,
  seller: r.seller,
  quantity: r.quantity,
  unitPrice: r.unitPrice,
  currency: r.currency,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export class PrismaListingRepository implements ListingRepository {
  async create(input: Pick<ListingRecord, "assetId" | "seller" | "quantity" | "unitPrice" | "currency">): Promise<ListingRecord> {
    return toListing(await prisma.listing.create({ data: { ...input, status: "open" } }));
  }
  async get(id: string): Promise<ListingRecord | null> {
    const r = await prisma.listing.findUnique({ where: { id } });
    return r ? toListing(r) : null;
  }
  async listByAsset(assetId: string, status?: string): Promise<ListingRecord[]> {
    const rows = await prisma.listing.findMany({
      where: { assetId, ...(status ? { status } : {}) },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toListing);
  }
  // Optimistic CAS, NOT a `quantity: { gte: by }` filter: `quantity` is a
  // string column, so SQL comparisons would be lexicographic ("9" > "100").
  // Each attempt reads the row, validates with BigInt, then updates guarded on
  // the exact (status, quantity) it read — `count === 0` means a concurrent
  // writer moved the row first, so re-read and retry (bounded).
  private static readonly CAS_ATTEMPTS = 3;

  async reserve(id: string, by: string): Promise<ListingRecord> {
    for (let attempt = 0; attempt < PrismaListingRepository.CAS_ATTEMPTS; attempt++) {
      const r = await prisma.listing.findUnique({ where: { id } });
      if (!r) throw new Error(`unknown listing '${id}'`);
      if (r.status !== "open") throw new ListingConflictError("LISTING_NOT_OPEN", `listing '${id}' is ${r.status}`);
      const remaining = BigInt(r.quantity) - BigInt(by);
      if (remaining < 0n) throw new ListingConflictError("TAKE_EXCEEDS_REMAINING", `only ${r.quantity} remain on listing '${id}'`);
      const newStatus = remaining === 0n ? "filled" : "open";
      const { count } = await prisma.listing.updateMany({
        where: { id, status: r.status, quantity: r.quantity },
        data: { quantity: remaining.toString(), status: newStatus },
      });
      if (count === 1) return { ...toListing(r), quantity: remaining.toString(), status: newStatus, updatedAt: new Date().toISOString() };
    }
    throw new ListingConflictError("LISTING_CONFLICT", `listing '${id}' kept changing under concurrent takes — retry`);
  }
  async restore(id: string, by: string): Promise<ListingRecord> {
    for (let attempt = 0; attempt < PrismaListingRepository.CAS_ATTEMPTS; attempt++) {
      const r = await prisma.listing.findUnique({ where: { id } });
      if (!r) throw new Error(`unknown listing '${id}'`);
      const newQty = (BigInt(r.quantity) + BigInt(by)).toString();
      const newStatus = r.status === "filled" ? "open" : r.status;
      const { count } = await prisma.listing.updateMany({
        where: { id, status: r.status, quantity: r.quantity },
        data: { quantity: newQty, status: newStatus },
      });
      if (count === 1) return { ...toListing(r), quantity: newQty, status: newStatus, updatedAt: new Date().toISOString() };
    }
    throw new ListingConflictError("LISTING_CONFLICT", `listing '${id}' kept changing while restoring ${by} — manual reconciliation may be required`);
  }
  async cancel(id: string): Promise<ListingRecord> {
    for (let attempt = 0; attempt < PrismaListingRepository.CAS_ATTEMPTS; attempt++) {
      const r = await prisma.listing.findUnique({ where: { id } });
      if (!r) throw new Error(`unknown listing '${id}'`);
      if (r.status !== "open") throw new ListingConflictError("LISTING_NOT_OPEN", `listing '${id}' is ${r.status}`);
      // Guard on the exact quantity read so a cancel racing a take never
      // releases more than the post-take remainder — the retry re-reads it.
      const { count } = await prisma.listing.updateMany({
        where: { id, status: "open", quantity: r.quantity },
        data: { status: "cancelled" },
      });
      if (count === 1) return { ...toListing(r), status: "cancelled", updatedAt: new Date().toISOString() };
    }
    throw new ListingConflictError("LISTING_CONFLICT", `listing '${id}' kept changing under concurrent activity — retry`);
  }
  async reopen(id: string): Promise<ListingRecord> {
    for (let attempt = 0; attempt < PrismaListingRepository.CAS_ATTEMPTS; attempt++) {
      const r = await prisma.listing.findUnique({ where: { id } });
      if (!r) throw new Error(`unknown listing '${id}'`);
      if (r.status === "open") return toListing(r);
      const { count } = await prisma.listing.updateMany({
        where: { id, status: r.status, quantity: r.quantity },
        data: { status: "open" },
      });
      if (count === 1) return { ...toListing(r), status: "open", updatedAt: new Date().toISOString() };
    }
    throw new ListingConflictError("LISTING_CONFLICT", `listing '${id}' kept changing while reopening — manual reconciliation may be required`);
  }
}

const toCashflow = (r: { id: string; assetId: string; seq: number; kind: string; dueDate: string; amount: string; currency: string; status: string; executedAt: Date | null }): CashflowRecord => ({
  id: r.id, assetId: r.assetId, seq: r.seq, kind: r.kind as CashflowRecord["kind"], dueDate: r.dueDate,
  amount: r.amount, currency: r.currency, status: r.status as CashflowRecord["status"], executedAt: r.executedAt?.toISOString() ?? null,
});

export class PrismaCashflowRepository implements CashflowRepository {
  async createMany(assetId: string, currency: string, rows: { seq: number; kind: "coupon" | "redemption"; dueDate: string; amount: string }[]): Promise<void> {
    if (rows.length === 0) return;
    await prisma.cashflow.createMany({ data: rows.map((r) => ({ assetId, currency, ...r })) });
  }
  async listByAsset(assetId: string): Promise<CashflowRecord[]> {
    return (await prisma.cashflow.findMany({ where: { assetId }, orderBy: { seq: "asc" } })).map(toCashflow);
  }
  async get(id: string): Promise<CashflowRecord | null> {
    const r = await prisma.cashflow.findUnique({ where: { id } });
    return r ? toCashflow(r) : null;
  }
  async claim(id: string): Promise<boolean> {
    // Atomic CAS: only one concurrent execute can flip scheduled → executing.
    const { count } = await prisma.cashflow.updateMany({ where: { id, status: "scheduled" }, data: { status: "executing" } });
    return count === 1;
  }
  async release(id: string): Promise<void> {
    await prisma.cashflow.updateMany({ where: { id, status: "executing" }, data: { status: "scheduled" } });
  }
  async markExecuted(id: string, executedAt: string): Promise<CashflowRecord> {
    const { count } = await prisma.cashflow.updateMany({ where: { id, status: "executing" }, data: { status: "executed", executedAt: new Date(executedAt) } });
    if (count !== 1) throw new Error(`cashflow '${id}' is not 'executing' — claim it before marking executed`);
    const r = await prisma.cashflow.findUnique({ where: { id } });
    return toCashflow(r!);
  }
}

export class PrismaCashRepository implements CashRepository {
  async balanceOf(currency: string, address: string): Promise<string> {
    const row = await prisma.cashBalance.findUnique({ where: { currency_address: { currency, address } } });
    return row?.amount ?? "0";
  }
  async balancesOf(address: string): Promise<CashBalanceRecord[]> {
    const rows = await prisma.cashBalance.findMany({ where: { address, amount: { not: "0" } } });
    return rows.map((r) => ({ currency: r.currency, address: r.address, amount: r.amount }));
  }
  async credit(currency: string, address: string, amount: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const row = await tx.cashBalance.findUnique({ where: { currency_address: { currency, address } } });
      const next = (BigInt(row?.amount ?? "0") + BigInt(amount)).toString();
      await tx.cashBalance.upsert({
        where: { currency_address: { currency, address } },
        create: { currency, address, amount: next },
        update: { amount: next },
      });
    });
  }
  async transfer(currency: string, from: string, to: string, amount: string): Promise<void> {
    const amt = BigInt(amount);
    await prisma.$transaction(async (tx) => {
      const fromRow = await tx.cashBalance.findUnique({ where: { currency_address: { currency, address: from } } });
      const have = BigInt(fromRow?.amount ?? "0");
      if (have < amt) throw new PolicyError("INSUFFICIENT_FUNDS", `INSUFFICIENT_FUNDS: ${from} has insufficient ${currency} (has ${have}, needs ${amt})`, { from, currency, have: have.toString(), needs: amt.toString() });
      await tx.cashBalance.update({ where: { currency_address: { currency, address: from } }, data: { amount: (have - amt).toString() } });
      const toRow = await tx.cashBalance.findUnique({ where: { currency_address: { currency, address: to } } });
      const next = (BigInt(toRow?.amount ?? "0") + amt).toString();
      await tx.cashBalance.upsert({
        where: { currency_address: { currency, address: to } },
        create: { currency, address: to, amount: next },
        update: { amount: next },
      });
    });
  }
}
