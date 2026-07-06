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
  CashRepository,
  KycDetails,
  KycStatus,
  Page,
  Paged,
  SaleTerms,
  UseCaseRepository,
  UserRecord,
  UserRepository,
} from "./types.js";

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
  };
}

export class PrismaAssetRepository implements AssetRepository {
  async create(input: Omit<AssetRecord, "createdAt">): Promise<AssetRecord> {
    const r = await prisma.asset.create({
      data: {
        ...input,
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
