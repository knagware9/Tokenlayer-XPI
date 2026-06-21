import { PrismaClient } from "@prisma/client";
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
  Page,
  Paged,
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
  createdAt: Date;
}): UserRecord => ({ ...r, role: r.role as Role, createdAt: r.createdAt.toISOString() });

export class PrismaUserRepository implements UserRepository {
  async findByEmail(email: string): Promise<UserRecord | null> {
    const r = await prisma.user.findUnique({ where: { email } });
    return r ? toUser(r) : null;
  }
  async create(input: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord> {
    return toUser(await prisma.user.create({ data: input }));
  }
  async list(): Promise<UserRecord[]> {
    return (await prisma.user.findMany()).map(toUser);
  }
}

export class PrismaAssetRepository implements AssetRepository {
  async create(input: Omit<AssetRecord, "createdAt">): Promise<AssetRecord> {
    const r = await prisma.asset.create({
      data: { ...input, metadata: JSON.stringify(input.metadata) },
    });
    return {
      ...r,
      tokenType: r.tokenType as TokenType,
      tokenStandard: r.tokenStandard as TokenStandard,
      metadata: input.metadata,
      createdAt: r.createdAt.toISOString(),
    };
  }
  async get(id: string): Promise<AssetRecord | null> {
    const r = await prisma.asset.findUnique({ where: { id } });
    if (!r) return null;
    return {
      ...r,
      tokenType: r.tokenType as TokenType,
      tokenStandard: r.tokenStandard as TokenStandard,
      metadata: JSON.parse(r.metadata) as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    };
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
      items: rows.map((r) => ({
        ...r,
        tokenType: r.tokenType as TokenType,
        tokenStandard: r.tokenStandard as TokenStandard,
        metadata: JSON.parse(r.metadata) as Record<string, unknown>,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
    };
  }
  async setStatus(id: string, status: string): Promise<void> {
    await prisma.asset.update({ where: { id }, data: { status } });
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
      items: rows.map((r) => ({
        id: r.id,
        assetId: r.assetId ?? undefined,
        actorId: r.actorId,
        action: r.action as LifecycleAction,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
        txHash: r.txHash ?? undefined,
        chainId: r.chainId ?? undefined,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
    };
  }
}

export class PrismaAccountRepository implements AccountRepository {
  async list(): Promise<AccountRecord[]> {
    return prisma.account.findMany();
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
  defaultChainId: string;
  allowedChainIds: string;
  metadataSchema: string;
  lifecycle: string;
  compliance: string;
  roles: string;
}

function rowToUseCase(r: UseCaseRow): UseCaseDefinition {
  return normalizeUseCaseDefinition({
    key: r.key,
    name: r.name,
    description: r.description ?? undefined,
    tokenStandard: r.tokenStandard,
    defaultChainId: r.defaultChainId,
    allowedChainIds: JSON.parse(r.allowedChainIds),
    metadataSchema: JSON.parse(r.metadataSchema),
    lifecycle: JSON.parse(r.lifecycle),
    compliance: JSON.parse(r.compliance),
    roles: JSON.parse(r.roles),
  });
}

function useCaseToData(def: UseCaseDefinition) {
  return {
    key: def.key,
    name: def.name,
    description: def.description ?? null,
    tokenStandard: def.tokenStandard,
    defaultChainId: def.defaultChainId,
    allowedChainIds: JSON.stringify(def.allowedChainIds),
    metadataSchema: JSON.stringify(def.metadataSchema),
    lifecycle: JSON.stringify(def.lifecycle),
    compliance: JSON.stringify(def.compliance),
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
