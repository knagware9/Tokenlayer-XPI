import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { Asset } from "@prisma/client";
import {
  auditGenesis,
  auditEntryHash,
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
  AuditAnchorRecord,
  AuditAnchorRepository,
  AuditEntryRecord,
  AuditRepository,
  CashBalanceRecord,
  CashflowRecord,
  CashflowRepository,
  CashRepository,
  CredentialRecord,
  CredentialRepository,
  DocumentRecord,
  DocumentRepository,
  KycDetails,
  KycStatus,
  ListingRecord,
  ListingRepository,
  OrganizationRecord,
  OrganizationRepository,
  OrgStatus,
  OrgType,
  Page,
  Paged,
  ProposalApproval,
  ProposalRecord,
  ProposalRepository,
  RegistryDeploymentRecord,
  RegistryDeploymentRepository,
  SaleTerms,
  UseCaseRepository,
  UserRecord,
  UserRepository,
  VerificationRequestRecord,
  VerificationRequestRepository,
  VerificationStatus,
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
  did: string | null;
  orgId: string | null;
  didSeedEncrypted: string | null;
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
  did: r.did ?? undefined,
  orgId: r.orgId ?? null,
  didSeedEncrypted: r.didSeedEncrypted ?? null,
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
  async listByOrg(orgId: string): Promise<UserRecord[]> {
    return (await prisma.user.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } })).map(toUser);
  }
  async update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus" | "did" | "kyc" | "orgId" | "didSeedEncrypted">>): Promise<UserRecord> {
    const { kyc, ...rest } = patch;
    return toUser(await prisma.user.update({ where: { id }, data: { ...rest, ...(kyc !== undefined ? { kyc: kyc ? JSON.stringify(kyc) : null } : {}) } }));
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
  private appendLock: Promise<unknown> = Promise.resolve();
  async append(
    entry: Omit<AuditEntryRecord, "id" | "createdAt"> & { createdAt?: string },
  ): Promise<AuditEntryRecord> {
    const run = this.appendLock.then(async () => {
      const chainKey = entry.assetId ?? "__none__";
      const head = await prisma.auditLog.findFirst({ where: { assetId: entry.assetId ?? null }, orderBy: { seq: "desc" } });
      const seq = head ? head.seq + 1 : 0;
      const prevHash = head ? head.hash : auditGenesis(chainKey);
      const createdAt = entry.createdAt ? new Date(entry.createdAt) : new Date();
      // Hash over createdAt.toISOString() + the payload OBJECT so verifyChain,
      // which reads toAuditRecord's createdAt.toISOString() and payload, matches
      // byte-for-byte (no re-stringify/re-parse drift).
      const hash = auditEntryHash(prevHash, { assetId: chainKey, seq, actorId: entry.actorId, action: entry.action, payload: entry.payload, txHash: entry.txHash, chainId: entry.chainId, createdAt: createdAt.toISOString() });
      const r = await prisma.auditLog.create({
        data: { assetId: entry.assetId, actorId: entry.actorId, action: entry.action, payload: JSON.stringify(entry.payload), txHash: entry.txHash, chainId: entry.chainId, createdAt, seq, prevHash, hash },
      });
      return toAuditRecord({ ...r, payload: entry.payload });
    });
    this.appendLock = run.catch(() => {});
    return run;
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
  // string on DB reads (JSON column); object when append passes it through so the
  // hashed payload round-trips unchanged.
  payload: string | Record<string, unknown>;
  txHash: string | null;
  chainId: string | null;
  createdAt: Date;
  seq: number;
  prevHash: string;
  hash: string;
}): AuditEntryRecord {
  return {
    id: r.id,
    assetId: r.assetId ?? undefined,
    actorId: r.actorId,
    action: r.action as LifecycleAction,
    payload: typeof r.payload === "string" ? (JSON.parse(r.payload) as Record<string, unknown>) : r.payload,
    txHash: r.txHash ?? undefined,
    chainId: r.chainId ?? undefined,
    createdAt: r.createdAt.toISOString(),
    seq: r.seq,
    prevHash: r.prevHash,
    hash: r.hash,
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

const toAuditAnchor = (r: {
  id: string;
  assetId: string;
  seq: number;
  hash: string;
  txHash: string;
  chainId: string;
  createdAt: Date;
}): AuditAnchorRecord => ({
  id: r.id,
  assetId: r.assetId,
  seq: r.seq,
  hash: r.hash,
  txHash: r.txHash,
  chainId: r.chainId,
  createdAt: r.createdAt.toISOString(),
});

export class PrismaAuditAnchorRepository implements AuditAnchorRepository {
  async create(input: Omit<AuditAnchorRecord, "id" | "createdAt">): Promise<AuditAnchorRecord> {
    const r = await prisma.auditAnchor.create({ data: { assetId: input.assetId, seq: input.seq, hash: input.hash, txHash: input.txHash, chainId: input.chainId } });
    return toAuditAnchor(r);
  }
  async latest(assetId: string): Promise<AuditAnchorRecord | null> {
    const r = await prisma.auditAnchor.findFirst({ where: { assetId }, orderBy: { seq: "desc" } });
    return r ? toAuditAnchor(r) : null;
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
  ownerOrgId: string | null;
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
    ownerOrgId: r.ownerOrgId ?? undefined,
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
    ownerOrgId: def.ownerOrgId ?? null,
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

const toProposal = (r: { id: string; useCaseKey: string | null; orgId: string | null; assetId: string | null; kind: string; payload: string; proposerId: string; proposerLabel: string; required: number; approvals: string; status: string; error: string | null; createdAt: Date; decidedAt: Date | null }): ProposalRecord => ({
  id: r.id, useCaseKey: r.useCaseKey, orgId: r.orgId ?? null, assetId: r.assetId, kind: r.kind,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  proposerId: r.proposerId, proposerLabel: r.proposerLabel, required: r.required,
  approvals: JSON.parse(r.approvals) as ProposalApproval[],
  status: r.status as ProposalRecord["status"], error: r.error,
  createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null,
});

export class PrismaProposalRepository implements ProposalRepository {
  async create(input: Omit<ProposalRecord, "id" | "approvals" | "status" | "error" | "createdAt" | "decidedAt">): Promise<ProposalRecord> {
    const r = await prisma.proposal.create({
      data: {
        useCaseKey: input.useCaseKey, orgId: input.orgId, assetId: input.assetId, kind: input.kind,
        payload: JSON.stringify(input.payload), proposerId: input.proposerId,
        proposerLabel: input.proposerLabel, required: input.required,
      },
    });
    return toProposal(r);
  }
  async get(id: string): Promise<ProposalRecord | null> {
    const r = await prisma.proposal.findUnique({ where: { id } });
    return r ? toProposal(r) : null;
  }
  async list(useCaseKey?: string, status?: string): Promise<ProposalRecord[]> {
    const where = { ...(useCaseKey ? { useCaseKey } : {}), ...(status ? { status } : {}) };
    return (await prisma.proposal.findMany({ where, orderBy: { createdAt: "desc" } })).map(toProposal);
  }
  async listByOrg(orgId: string, status?: string): Promise<ProposalRecord[]> {
    return (await prisma.proposal.findMany({ where: { orgId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" } })).map(toProposal);
  }
  async addApproval(id: string, approval: ProposalApproval): Promise<ProposalRecord> {
    // Optimistic-concurrency append: read-modify-write is not atomic in SQL, so
    // two distinct approvers racing could clobber each other's approval. Guard the
    // write with a CAS on the exact prior JSON (the listings-repo pattern) and
    // retry on a lost race, so no approval is silently dropped from the audit trail.
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await prisma.proposal.findUnique({ where: { id } });
      if (!r) throw new Error(`unknown proposal '${id}'`);
      const approvals = JSON.parse(r.approvals) as ProposalApproval[];
      if (approvals.some((a) => a.userId === approval.userId)) {
        throw Object.assign(new Error("already approved"), { code: "ALREADY_APPROVED" });
      }
      const next = JSON.stringify([...approvals, approval]);
      const { count } = await prisma.proposal.updateMany({ where: { id, approvals: r.approvals }, data: { approvals: next } });
      if (count === 1) return toProposal({ ...r, approvals: next });
      // Lost the race to a concurrent approver — re-read and retry.
    }
    throw new Error(`addApproval for '${id}' kept losing to concurrent writers`);
  }
  async claimDecided(id: string, target: ProposalRecord["status"]): Promise<boolean> {
    // Atomic CAS: only one concurrent decision flips pending → target, so the
    // Nth approval (approved) executes once and an approve-vs-reject race resolves
    // to exactly one outcome.
    const { count } = await prisma.proposal.updateMany({ where: { id, status: "pending" }, data: { status: target } });
    return count === 1;
  }
  async setStatus(id: string, status: ProposalRecord["status"], error?: string | null): Promise<ProposalRecord> {
    const terminal = status === "rejected" || status === "executed" || status === "failed";
    const updated = await prisma.proposal.update({
      where: { id },
      data: { status, error: error ?? null, ...(terminal ? { decidedAt: new Date() } : {}) },
    });
    return toProposal(updated);
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

const toOrg = (r: {
  id: string; name: string; orgType: string; registrationId: string | null; jurisdiction: string | null;
  did: string; didSeedEncrypted: string; status: string; verified: boolean; verifiedAt: Date | null; createdAt: Date;
}): OrganizationRecord => ({
  id: r.id, name: r.name, orgType: r.orgType as OrgType, registrationId: r.registrationId, jurisdiction: r.jurisdiction,
  did: r.did, didSeedEncrypted: r.didSeedEncrypted, status: r.status as OrgStatus, verified: r.verified,
  verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null, createdAt: r.createdAt.toISOString(),
});

export class PrismaOrganizationRepository implements OrganizationRepository {
  async create(input: Omit<OrganizationRecord, "id" | "createdAt">): Promise<OrganizationRecord> {
    return toOrg(await prisma.organization.create({ data: { ...input, verifiedAt: input.verifiedAt ? new Date(input.verifiedAt) : null } }));
  }
  async get(id: string): Promise<OrganizationRecord | null> {
    const r = await prisma.organization.findUnique({ where: { id } });
    return r ? toOrg(r) : null;
  }
  async findByName(name: string): Promise<OrganizationRecord | null> {
    const r = await prisma.organization.findUnique({ where: { name } });
    return r ? toOrg(r) : null;
  }
  async findByDid(did: string): Promise<OrganizationRecord | null> {
    const r = await prisma.organization.findUnique({ where: { did } });
    return r ? toOrg(r) : null;
  }
  async findByRegistrationId(registrationId: string): Promise<OrganizationRecord | null> {
    const r = await prisma.organization.findFirst({ where: { registrationId } });
    return r ? toOrg(r) : null;
  }
  async list(): Promise<OrganizationRecord[]> {
    return (await prisma.organization.findMany({ orderBy: { createdAt: "asc" } })).map(toOrg);
  }
  async setVerified(id: string, verified: boolean, verifiedAt: string | null): Promise<OrganizationRecord> {
    return toOrg(await prisma.organization.update({ where: { id }, data: { verified, verifiedAt: verifiedAt ? new Date(verifiedAt) : null } }));
  }
  async setStatus(id: string, status: OrgStatus): Promise<OrganizationRecord> {
    return toOrg(await prisma.organization.update({ where: { id }, data: { status } }));
  }
  async remove(id: string): Promise<void> {
    await prisma.organization.delete({ where: { id } });
  }
}

const toCredential = (r: {
  id: string; holderDid: string; issuerDid: string; type: string; vcJwt: string;
  subjectClaims: string; issuedAt: Date; expiresAt: Date | null; revoked: boolean;
  revokedAt: Date | null; revokedReason: string | null; revokedBy: string | null; proposalId: string | null;
}): CredentialRecord => ({
  id: r.id, holderDid: r.holderDid, issuerDid: r.issuerDid, type: r.type, vcJwt: r.vcJwt,
  subjectClaims: JSON.parse(r.subjectClaims) as Record<string, unknown>,
  issuedAt: r.issuedAt.toISOString(), expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null, revoked: r.revoked,
  revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null, revokedReason: r.revokedReason,
  revokedBy: r.revokedBy, proposalId: r.proposalId,
});

export class PrismaCredentialRepository implements CredentialRepository {
  async create(input: CredentialRecord): Promise<CredentialRecord> {
    return toCredential(await prisma.credential.create({
      data: {
        id: input.id,
        holderDid: input.holderDid, issuerDid: input.issuerDid, type: input.type, vcJwt: input.vcJwt,
        subjectClaims: JSON.stringify(input.subjectClaims),
        issuedAt: new Date(input.issuedAt), expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        revoked: input.revoked, proposalId: input.proposalId,
      },
    }));
  }
  async listByHolder(holderDid: string): Promise<CredentialRecord[]> {
    return (await prisma.credential.findMany({ where: { holderDid }, orderBy: { issuedAt: "asc" } })).map(toCredential);
  }
  async listByIssuer(issuerDid: string): Promise<CredentialRecord[]> {
    return (await prisma.credential.findMany({ where: { issuerDid }, orderBy: { issuedAt: "desc" } })).map(toCredential);
  }
  async get(id: string): Promise<CredentialRecord | null> {
    const r = await prisma.credential.findUnique({ where: { id } });
    return r ? toCredential(r) : null;
  }
  async setRevoked(id: string, revoked: boolean): Promise<CredentialRecord> {
    return toCredential(await prisma.credential.update({ where: { id }, data: { revoked } }));
  }
  async revoke(id: string, input: { reason: string; by: string; at: string }): Promise<CredentialRecord> {
    return toCredential(await prisma.credential.update({
      where: { id },
      data: { revoked: true, revokedReason: input.reason, revokedBy: input.by, revokedAt: new Date(input.at) },
    }));
  }
}

const toRegistry = (r: {
  chainId: string; didRegistry: string; vcRegistry: string; deployTxHash: string; createdAt: Date;
}): RegistryDeploymentRecord => ({
  chainId: r.chainId, didRegistry: r.didRegistry, vcRegistry: r.vcRegistry,
  deployTxHash: r.deployTxHash, createdAt: r.createdAt.toISOString(),
});

export class PrismaRegistryDeploymentRepository implements RegistryDeploymentRepository {
  async get(chainId: string): Promise<RegistryDeploymentRecord | null> {
    const r = await prisma.registryDeployment.findUnique({ where: { chainId } });
    return r ? toRegistry(r) : null;
  }
  async create(input: Omit<RegistryDeploymentRecord, "createdAt">): Promise<RegistryDeploymentRecord> {
    return toRegistry(await prisma.registryDeployment.create({ data: input }));
  }
}

const toVerificationRequest = (r: {
  id: string; verifierOrgId: string; holderDid: string; requestedTypes: string; purpose: string; challenge: string;
  status: string; presentationVpJwt: string | null; consentedAt: Date | null; consentedCredentialIds: string | null;
  verifierResult: string | null; verifiedAt: Date | null; createdAt: Date; expiresAt: Date;
}): VerificationRequestRecord => ({
  id: r.id, verifierOrgId: r.verifierOrgId, holderDid: r.holderDid,
  requestedTypes: JSON.parse(r.requestedTypes) as string[], purpose: r.purpose, challenge: r.challenge,
  status: r.status as VerificationStatus, presentationVpJwt: r.presentationVpJwt,
  consentedAt: r.consentedAt ? r.consentedAt.toISOString() : null,
  consentedCredentialIds: r.consentedCredentialIds ? (JSON.parse(r.consentedCredentialIds) as string[]) : null,
  verifierResult: r.verifierResult ? (JSON.parse(r.verifierResult) as Record<string, unknown>) : null,
  verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
});

export class PrismaVerificationRequestRepository implements VerificationRequestRepository {
  async create(input: Omit<VerificationRequestRecord, "id" | "createdAt">): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.create({
      data: {
        verifierOrgId: input.verifierOrgId, holderDid: input.holderDid,
        requestedTypes: JSON.stringify(input.requestedTypes), purpose: input.purpose, challenge: input.challenge,
        status: input.status, presentationVpJwt: input.presentationVpJwt,
        consentedAt: input.consentedAt ? new Date(input.consentedAt) : null,
        consentedCredentialIds: input.consentedCredentialIds ? JSON.stringify(input.consentedCredentialIds) : null,
        verifierResult: input.verifierResult ? JSON.stringify(input.verifierResult) : null,
        verifiedAt: input.verifiedAt ? new Date(input.verifiedAt) : null,
        expiresAt: new Date(input.expiresAt),
      },
    }));
  }
  async get(id: string): Promise<VerificationRequestRecord | null> {
    const r = await prisma.verificationRequest.findUnique({ where: { id } });
    return r ? toVerificationRequest(r) : null;
  }
  async listByHolder(holderDid: string, status?: string): Promise<VerificationRequestRecord[]> {
    return (await prisma.verificationRequest.findMany({ where: { holderDid, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" } })).map(toVerificationRequest);
  }
  async listByVerifierOrg(orgId: string, status?: string): Promise<VerificationRequestRecord[]> {
    return (await prisma.verificationRequest.findMany({ where: { verifierOrgId: orgId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" } })).map(toVerificationRequest);
  }
  async setConsented(id: string, input: { vpJwt: string; credentialIds: string[]; at: string }): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.update({ where: { id }, data: { status: "consented", presentationVpJwt: input.vpJwt, consentedCredentialIds: JSON.stringify(input.credentialIds), consentedAt: new Date(input.at) } }));
  }
  async setStatus(id: string, status: VerificationStatus): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.update({ where: { id }, data: { status } }));
  }
  async setVerifierResult(id: string, input: { result: Record<string, unknown>; at: string }): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.update({ where: { id }, data: { verifierResult: JSON.stringify(input.result), verifiedAt: new Date(input.at) } }));
  }
}
