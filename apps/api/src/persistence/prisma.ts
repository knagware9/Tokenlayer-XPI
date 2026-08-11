import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { Asset } from "@prisma/client";
import {
  auditGenesis,
  auditEntryHash,
  normalizeUseCaseDefinition,
  PolicyError,
  type LifecycleAction,
  type OrgCapabilities,
  type Role,
  type TokenStandard,
  type TokenType,
  type ResourceMode,
  type UseCaseDefinition,
  type CredentialUseCaseDefinition,
  type UseCaseTemplate,
} from "@tokenlayer/core";
import type {
  AccountRecord,
  AccountRepository,
  ApiKeyCreateInput,
  ApiKeyRecord,
  ApiKeyRepository,
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
  DocumentPurpose,
  DocumentRecord,
  DocumentRepository,
  DocumentSummary,
  EventAppendInput,
  EventRecord,
  EventRepository,
  BrandingPatch,
  KycDetails,
  CompanyProfile,
  KycStatus,
  ListingRecord,
  ListingRepository,
  LoginKeyRecord,
  LoginKeyRepository,
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
  StagedInvoiceRecord,
  StagedInvoiceRepository,
  StagedInvoiceStatus,
  CredentialUseCaseRepository,
  CredentialUseCaseTemplateRepository,
  UseCaseRepository,
  UserKind,
  UserRecord,
  UserRepository,
  VerificationRequestRecord,
  VerificationRequestRepository,
  VerificationStatus,
  WebhookDeliveryRecord,
  WebhookDeliveryRepository,
  WebhookEndpointCreateInput,
  WebhookEndpointRecord,
  WebhookEndpointRepository,
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
  kind: string;
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
  kind: r.kind as UserKind,
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
  async create(input: Omit<UserRecord, "id" | "createdAt" | "kind"> & { kind?: UserKind }): Promise<UserRecord> {
    return toUser(await prisma.user.create({ data: { ...input, kind: input.kind ?? "human", kyc: input.kyc ? JSON.stringify(input.kyc) : null } }));
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
      // Under `AND`, deliberately. Spreading a second `useCaseKey` key at this
      // level would OVERWRITE the single-key clamp above rather than intersect
      // with it — silently widening a scoped caller's query the moment both
      // filters are supplied, which is exactly what /analytics does.
      ...(filter.useCaseKeys ? { AND: [{ useCaseKey: { in: filter.useCaseKeys } }] } : {}),
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

/**
 * `Prisma.DocumentUncheckedCreateInput` declares `purpose` as optional
 * (`purpose?: string | null`), so a `data` object typed directly against it
 * would let a future edit silently drop `purpose` and compile clean — every
 * test passes against the memory repository regardless, and production would
 * quietly write NULL for every brand logo, making the prune a permanent
 * no-op. Binding to this narrower, locally-declared shape instead makes
 * `purpose` required, so omitting it is a compile error here specifically.
 */
type DocumentCreateData = { contentType: string; sha256: string; size: number; bytes: Buffer; ownerOrgId: string | null; purpose: DocumentPurpose | null };

export class PrismaDocumentRepository implements DocumentRepository {
  async create({ contentType, bytes, ownerOrgId, purpose }: { contentType: string; bytes: Buffer; ownerOrgId: string | null; purpose: DocumentPurpose | null }): Promise<{ id: string; sha256: string; size: number }> {
    const sha256 = "0x" + createHash("sha256").update(bytes).digest("hex");
    const data: DocumentCreateData = { contentType, sha256, size: bytes.length, bytes, ownerOrgId, purpose };
    const row = await prisma.document.create({ data });
    return { id: row.id, sha256, size: bytes.length };
  }
  async get(id: string): Promise<DocumentRecord | null> {
    const r = await prisma.document.findUnique({ where: { id } });
    return r
      ? { id: r.id, contentType: r.contentType, sha256: r.sha256, size: r.size, bytes: Buffer.from(r.bytes), createdAt: r.createdAt.toISOString(), ownerOrgId: r.ownerOrgId ?? null, purpose: r.purpose === "brand-logo" ? "brand-logo" : null }
      : null;
  }
  async listByOwnerPurpose(ownerOrgId: string, purpose: DocumentPurpose): Promise<DocumentSummary[]> {
    // `select` WITHOUT `bytes`, deliberately: this runs on every logo upload and
    // must not pull megabytes out of the database to compare identifiers.
    const rows = await prisma.document.findMany({
      where: { ownerOrgId, purpose },
      select: { id: true, size: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({ id: r.id, size: r.size, createdAt: r.createdAt.toISOString() }));
  }
  async removeByOwnerPurpose(id: string, ownerOrgId: string, purpose: DocumentPurpose): Promise<void> {
    // `deleteMany`, not `delete`: `delete` throws P2025 when the row is already
    // gone (or already doesn't match), and this must be idempotent for a
    // best-effort, racing prune. A row belonging to another org or uploaded
    // for something else simply matches zero rows and is left alone.
    await prisma.document.deleteMany({ where: { id, ownerOrgId, purpose } });
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
  sandbox: boolean;
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

export function rowToUseCase(r: UseCaseRow): UseCaseDefinition {
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
    // Column, not derivation — the whole point of EN-D2's flag (see chains.ts).
    sandbox: r.sandbox,
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
    // Written explicitly rather than left to the column default: the default
    // exists for rows that predate the column, not for rows we are writing now.
    sandbox: def.sandbox === true,
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

export function rowToCredentialUseCase(r: {
  key: string; name: string; description: string | null;
  credentialTypes: string; issuer: string; holderPolicy: string; verifier: string; ownerOrgId: string | null;
  holderAcceptance: boolean; sandbox: boolean;
}): CredentialUseCaseDefinition {
  return {
    key: r.key, name: r.name, description: r.description ?? undefined,
    credentialTypes: JSON.parse(r.credentialTypes), issuer: JSON.parse(r.issuer),
    holderPolicy: JSON.parse(r.holderPolicy), verifier: JSON.parse(r.verifier),
    ownerOrgId: r.ownerOrgId,
    ...(r.holderAcceptance ? { holderAcceptance: true } : {}),
    // Unlike holderAcceptance this is ALWAYS present: the memory repo normalises
    // an absent sandbox to false, so omitting it here when false would be the
    // exact memory/prisma divergence THE PARITY RULE forbids.
    sandbox: r.sandbox,
  };
}
export class PrismaCredentialUseCaseRepository implements CredentialUseCaseRepository {
  async create(def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    const r = await prisma.credentialUseCase.create({ data: {
      key: def.key, name: def.name, description: def.description ?? null,
      credentialTypes: JSON.stringify(def.credentialTypes), issuer: JSON.stringify(def.issuer),
      holderPolicy: JSON.stringify(def.holderPolicy), verifier: JSON.stringify(def.verifier),
      ownerOrgId: def.ownerOrgId ?? null, holderAcceptance: def.holderAcceptance ?? false,
      sandbox: def.sandbox === true } });
    return rowToCredentialUseCase(r);
  }
  async get(key: string): Promise<CredentialUseCaseDefinition | null> {
    const r = await prisma.credentialUseCase.findUnique({ where: { key } });
    return r ? rowToCredentialUseCase(r) : null;
  }
  async has(key: string): Promise<boolean> { return (await prisma.credentialUseCase.count({ where: { key } })) > 0; }
  async list(): Promise<CredentialUseCaseDefinition[]> {
    return (await prisma.credentialUseCase.findMany({ orderBy: { createdAt: "asc" } })).map(rowToCredentialUseCase);
  }
  async update(key: string, def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    const r = await prisma.credentialUseCase.update({ where: { key }, data: {
      name: def.name, description: def.description ?? null,
      credentialTypes: JSON.stringify(def.credentialTypes), issuer: JSON.stringify(def.issuer),
      holderPolicy: JSON.stringify(def.holderPolicy), verifier: JSON.stringify(def.verifier),
      ownerOrgId: def.ownerOrgId ?? null, holderAcceptance: def.holderAcceptance ?? false,
      sandbox: def.sandbox === true } });
    return rowToCredentialUseCase(r);
  }
}

function toCredentialUseCaseTemplate(r: {
  key: string; name: string; category: string; description: string | null;
  parameters: string; body: string;
}): UseCaseTemplate {
  return {
    key: r.key, name: r.name, category: r.category, description: r.description ?? undefined,
    parameters: JSON.parse(r.parameters), body: JSON.parse(r.body),
  };
}
export class PrismaCredentialUseCaseTemplateRepository implements CredentialUseCaseTemplateRepository {
  async list(): Promise<UseCaseTemplate[]> {
    return (await prisma.credentialUseCaseTemplate.findMany({ orderBy: { createdAt: "asc" } })).map(toCredentialUseCaseTemplate);
  }
  async get(key: string): Promise<UseCaseTemplate | null> {
    const r = await prisma.credentialUseCaseTemplate.findUnique({ where: { key } });
    return r ? toCredentialUseCaseTemplate(r) : null;
  }
  async create(t: UseCaseTemplate): Promise<UseCaseTemplate> {
    const r = await prisma.credentialUseCaseTemplate.create({ data: {
      key: t.key, name: t.name, category: t.category, description: t.description ?? null,
      parameters: JSON.stringify(t.parameters), body: JSON.stringify(t.body) } });
    return toCredentialUseCaseTemplate(r);
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

const toProposal = (r: { id: string; useCaseKey: string | null; orgId: string | null; assetId: string | null; kind: string; payload: string; proposerId: string; proposerLabel: string; required: number; approvals: string; status: string; error: string | null; result: string | null; createdAt: Date; decidedAt: Date | null }): ProposalRecord => ({
  id: r.id, useCaseKey: r.useCaseKey, orgId: r.orgId ?? null, assetId: r.assetId, kind: r.kind,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  proposerId: r.proposerId, proposerLabel: r.proposerLabel, required: r.required,
  approvals: JSON.parse(r.approvals) as ProposalApproval[],
  status: r.status as ProposalRecord["status"], error: r.error,
  result: r.result ? (JSON.parse(r.result) as Record<string, unknown>) : null,
  createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null,
});

export class PrismaProposalRepository implements ProposalRepository {
  async create(input: Omit<ProposalRecord, "id" | "approvals" | "status" | "error" | "result" | "createdAt" | "decidedAt">): Promise<ProposalRecord> {
    const r = await prisma.proposal.create({
      data: {
        useCaseKey: input.useCaseKey, orgId: input.orgId, assetId: input.assetId, kind: input.kind,
        payload: JSON.stringify(input.payload), proposerId: input.proposerId,
        proposerLabel: input.proposerLabel, required: input.required, result: null,
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
  async setResult(id: string, result: Record<string, unknown>): Promise<ProposalRecord> {
    const updated = await prisma.proposal.update({ where: { id }, data: { result: JSON.stringify(result) } });
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
  did: string; didSeedEncrypted: string; status: string; verified: boolean; verifiedAt: Date | null;
  companyProfile: string | null; capabilities: string | null;
  brandLogoDocumentId: string | null; brandAccent: string | null; createdAt: Date;
}): OrganizationRecord => ({
  id: r.id, name: r.name, orgType: r.orgType as OrgType, registrationId: r.registrationId, jurisdiction: r.jurisdiction,
  did: r.did, didSeedEncrypted: r.didSeedEncrypted, status: r.status as OrgStatus, verified: r.verified,
  verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
  companyProfile: r.companyProfile ? (JSON.parse(r.companyProfile) as CompanyProfile) : null,
  capabilities: r.capabilities ? (JSON.parse(r.capabilities) as OrgCapabilities) : null,
  brandLogoDocumentId: r.brandLogoDocumentId, brandAccent: r.brandAccent,
  createdAt: r.createdAt.toISOString(),
});

export class PrismaOrganizationRepository implements OrganizationRepository {
  async create(input: Omit<OrganizationRecord, "id" | "createdAt">): Promise<OrganizationRecord> {
    return toOrg(await prisma.organization.create({
      data: {
        ...input,
        verifiedAt: input.verifiedAt ? new Date(input.verifiedAt) : null,
        companyProfile: input.companyProfile ? JSON.stringify(input.companyProfile) : null,
        capabilities: input.capabilities ? JSON.stringify(input.capabilities) : null,
      },
    }));
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
  async setCapabilities(id: string, caps: OrgCapabilities | null): Promise<OrganizationRecord> {
    return toOrg(await prisma.organization.update({ where: { id }, data: { capabilities: caps ? JSON.stringify(caps) : null } }));
  }
  async setBranding(orgId: string, patch: BrandingPatch): Promise<OrganizationRecord> {
    // `in` rather than `!== undefined`: prisma treats an undefined column as
    // "don't write", so spreading only the keys actually present is what makes
    // an explicit null CLEAR while an omitted key is left alone.
    return toOrg(await prisma.organization.update({
      where: { id: orgId },
      data: {
        ...("brandLogoDocumentId" in patch ? { brandLogoDocumentId: patch.brandLogoDocumentId ?? null } : {}),
        ...("brandAccent" in patch ? { brandAccent: patch.brandAccent ?? null } : {}),
      },
    }));
  }
  async remove(id: string): Promise<void> {
    await prisma.organization.delete({ where: { id } });
  }
}

const toCredential = (r: {
  id: string; holderDid: string; issuerDid: string; type: string; vcJwt: string;
  subjectClaims: string; issuedAt: Date; expiresAt: Date | null; revoked: boolean;
  revokedAt: Date | null; revokedReason: string | null; revokedBy: string | null; proposalId: string | null;
  credentialUseCaseKey: string | null; acceptance: string; acceptanceAt: Date | null; acceptanceNote: string | null;
  anchorTxHash: string | null; anchorChainId: string | null; revokeTxHash: string | null;
}): CredentialRecord => ({
  id: r.id, holderDid: r.holderDid, issuerDid: r.issuerDid, type: r.type, vcJwt: r.vcJwt,
  subjectClaims: JSON.parse(r.subjectClaims) as Record<string, unknown>,
  issuedAt: r.issuedAt.toISOString(), expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null, revoked: r.revoked,
  revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null, revokedReason: r.revokedReason,
  revokedBy: r.revokedBy, proposalId: r.proposalId, credentialUseCaseKey: r.credentialUseCaseKey,
  acceptance: r.acceptance as CredentialRecord["acceptance"],
  acceptanceAt: r.acceptanceAt ? r.acceptanceAt.toISOString() : null, acceptanceNote: r.acceptanceNote,
  anchorTxHash: r.anchorTxHash, anchorChainId: r.anchorChainId, revokeTxHash: r.revokeTxHash,
});

export class PrismaCredentialRepository implements CredentialRepository {
  async create(input: CredentialRecord): Promise<CredentialRecord> {
    return toCredential(await prisma.credential.create({
      data: {
        id: input.id,
        holderDid: input.holderDid, issuerDid: input.issuerDid, type: input.type, vcJwt: input.vcJwt,
        subjectClaims: JSON.stringify(input.subjectClaims),
        issuedAt: new Date(input.issuedAt), expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        revoked: input.revoked, proposalId: input.proposalId, credentialUseCaseKey: input.credentialUseCaseKey,
        acceptance: input.acceptance, acceptanceAt: input.acceptanceAt ? new Date(input.acceptanceAt) : null,
        acceptanceNote: input.acceptanceNote,
        anchorTxHash: input.anchorTxHash, anchorChainId: input.anchorChainId, revokeTxHash: input.revokeTxHash,
      },
    }));
  }
  async listByHolder(holderDid: string): Promise<CredentialRecord[]> {
    return (await prisma.credential.findMany({ where: { holderDid }, orderBy: { issuedAt: "asc" } })).map(toCredential);
  }
  async listByIssuer(issuerDid: string): Promise<CredentialRecord[]> {
    return (await prisma.credential.findMany({ where: { issuerDid }, orderBy: { issuedAt: "desc" } })).map(toCredential);
  }
  async list(): Promise<CredentialRecord[]> {
    return (await prisma.credential.findMany()).map(toCredential);
  }
  async get(id: string): Promise<CredentialRecord | null> {
    const r = await prisma.credential.findUnique({ where: { id } });
    return r ? toCredential(r) : null;
  }
  async setRevoked(id: string, revoked: boolean): Promise<CredentialRecord> {
    return toCredential(await prisma.credential.update({ where: { id }, data: { revoked } }));
  }
  async revoke(id: string, input: { reason: string; by: string; at: string; txHash?: string | null }): Promise<CredentialRecord> {
    return toCredential(await prisma.credential.update({
      where: { id },
      data: { revoked: true, revokedReason: input.reason, revokedBy: input.by, revokedAt: new Date(input.at), revokeTxHash: input.txHash ?? null },
    }));
  }
  async setAcceptance(id: string, patch: { acceptance: CredentialRecord["acceptance"]; at: string; note: string | null }): Promise<CredentialRecord> {
    return toCredential(await prisma.credential.update({
      where: { id },
      data: { acceptance: patch.acceptance, acceptanceAt: new Date(patch.at), acceptanceNote: patch.note },
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
  credentialUseCaseKey: string | null;
}): VerificationRequestRecord => ({
  id: r.id, verifierOrgId: r.verifierOrgId, holderDid: r.holderDid,
  requestedTypes: JSON.parse(r.requestedTypes) as string[], purpose: r.purpose, challenge: r.challenge,
  status: r.status as VerificationStatus, presentationVpJwt: r.presentationVpJwt,
  consentedAt: r.consentedAt ? r.consentedAt.toISOString() : null,
  consentedCredentialIds: r.consentedCredentialIds ? (JSON.parse(r.consentedCredentialIds) as string[]) : null,
  verifierResult: r.verifierResult ? (JSON.parse(r.verifierResult) as Record<string, unknown>) : null,
  verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
  credentialUseCaseKey: r.credentialUseCaseKey,
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
        credentialUseCaseKey: input.credentialUseCaseKey,
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
  async list(): Promise<VerificationRequestRecord[]> {
    return (await prisma.verificationRequest.findMany()).map(toVerificationRequest);
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

const toStagedInvoice = (r: {
  id: string; useCaseKey: string; source: string; metadata: string; invoiceHash: string;
  documentId: string | null; documentSha256: string | null; status: string; assetId: string | null;
  createdBy: string; createdAt: Date; tokenizedAt: Date | null;
}): StagedInvoiceRecord => ({
  id: r.id, useCaseKey: r.useCaseKey, source: r.source as StagedInvoiceRecord["source"],
  metadata: JSON.parse(r.metadata) as Record<string, unknown>, invoiceHash: r.invoiceHash,
  documentId: r.documentId, documentSha256: r.documentSha256, status: r.status as StagedInvoiceStatus,
  assetId: r.assetId, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
  tokenizedAt: r.tokenizedAt ? r.tokenizedAt.toISOString() : null,
});

export class PrismaStagedInvoiceRepository implements StagedInvoiceRepository {
  async create(input: Omit<StagedInvoiceRecord, "id" | "createdAt">): Promise<StagedInvoiceRecord> {
    return toStagedInvoice(await prisma.stagedInvoice.create({
      data: {
        ...input,
        metadata: JSON.stringify(input.metadata),
        tokenizedAt: input.tokenizedAt ? new Date(input.tokenizedAt) : null,
      },
    }));
  }
  async get(id: string): Promise<StagedInvoiceRecord | null> {
    const r = await prisma.stagedInvoice.findUnique({ where: { id } });
    return r ? toStagedInvoice(r) : null;
  }
  async listByUseCase(useCaseKey: string, status?: StagedInvoiceStatus): Promise<StagedInvoiceRecord[]> {
    return (await prisma.stagedInvoice.findMany({ where: { useCaseKey, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" } })).map(toStagedInvoice);
  }
  async findByHash(useCaseKey: string, invoiceHash: string): Promise<StagedInvoiceRecord | null> {
    const r = await prisma.stagedInvoice.findFirst({ where: { useCaseKey, invoiceHash } });
    return r ? toStagedInvoice(r) : null;
  }
  async markTokenized(id: string, assetId: string, at: string): Promise<StagedInvoiceRecord> {
    return toStagedInvoice(await prisma.stagedInvoice.update({ where: { id }, data: { status: "tokenized", assetId, tokenizedAt: new Date(at) } }));
  }
  async remove(id: string): Promise<void> {
    await prisma.stagedInvoice.delete({ where: { id } });
  }
}

export const rowToApiKey = (r: {
  id: string; orgId: string | null; userId: string; name: string; prefix: string; secretHash: string;
  scopes: string; expiresAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null;
  revokedBy: string | null; createdBy: string; createdAt: Date; mode: string;
}): ApiKeyRecord => ({
  id: r.id, orgId: r.orgId, userId: r.userId, name: r.name, prefix: r.prefix, secretHash: r.secretHash,
  scopes: JSON.parse(r.scopes) as string[],
  expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
  lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  revokedBy: r.revokedBy, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
  mode: r.mode as ResourceMode,
});

export class PrismaApiKeyRepository implements ApiKeyRepository {
  async create(input: ApiKeyCreateInput): Promise<ApiKeyRecord> {
    return rowToApiKey(await prisma.apiKey.create({
      data: {
        orgId: input.orgId, userId: input.userId, name: input.name, prefix: input.prefix,
        secretHash: input.secretHash, scopes: JSON.stringify(input.scopes),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, createdBy: input.createdBy,
        mode: input.mode ?? "live",
      },
    }));
  }
  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const r = await prisma.apiKey.findUnique({ where: { prefix } });
    return r ? rowToApiKey(r) : null;
  }
  async findById(id: string): Promise<ApiKeyRecord | null> {
    const r = await prisma.apiKey.findUnique({ where: { id } });
    return r ? rowToApiKey(r) : null;
  }
  /** Revoked/expired keys are deliberately NOT filtered — they are the audit trail. */
  async listByOrg(orgId: string | null): Promise<ApiKeyRecord[]> {
    return (await prisma.apiKey.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } })).map(rowToApiKey);
  }
  async rotate(id: string, input: { prefix: string; secretHash: string }): Promise<ApiKeyRecord> {
    return rowToApiKey(await prisma.apiKey.update({ where: { id }, data: { prefix: input.prefix, secretHash: input.secretHash } }));
  }
  async touchLastUsed(id: string, at: string): Promise<void> {
    await prisma.apiKey.update({ where: { id }, data: { lastUsedAt: new Date(at) } });
  }
  async revoke(id: string, input: { by: string; at: string }): Promise<ApiKeyRecord> {
    return rowToApiKey(await prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date(input.at), revokedBy: input.by },
    }));
  }
}

const toLoginKey = (r: {
  id: string; userId: string; did: string; label: string; createdAt: Date; lastUsedAt: Date | null;
}): LoginKeyRecord => ({
  id: r.id, userId: r.userId, did: r.did, label: r.label,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
});

export class PrismaLoginKeyRepository implements LoginKeyRepository {
  async create(input: Omit<LoginKeyRecord, "id" | "createdAt" | "lastUsedAt">): Promise<LoginKeyRecord> {
    return toLoginKey(await prisma.loginKey.create({ data: { userId: input.userId, did: input.did, label: input.label } }));
  }
  async listByUser(userId: string): Promise<LoginKeyRecord[]> {
    return (await prisma.loginKey.findMany({ where: { userId }, orderBy: { createdAt: "desc" } })).map(toLoginKey);
  }
  async getByDid(did: string): Promise<LoginKeyRecord | null> {
    const r = await prisma.loginKey.findUnique({ where: { did } });
    return r ? toLoginKey(r) : null;
  }
  async get(id: string): Promise<LoginKeyRecord | null> {
    const r = await prisma.loginKey.findFirst({ where: { id } });
    return r ? toLoginKey(r) : null;
  }
  async remove(id: string): Promise<void> {
    await prisma.loginKey.delete({ where: { id } });
  }
  async touch(id: string, at: string): Promise<void> {
    await prisma.loginKey.update({ where: { id }, data: { lastUsedAt: new Date(at) } });
  }
}

export const rowToEvent = (r: {
  seq: number; id: string; type: string; orgId: string | null; useCaseKey: string | null;
  subjectId: string | null; data: string; occurredAt: Date; mode: string;
}): EventRecord => ({
  seq: r.seq, id: r.id, type: r.type, orgId: r.orgId, useCaseKey: r.useCaseKey,
  subjectId: r.subjectId, data: JSON.parse(r.data) as Record<string, unknown>,
  occurredAt: r.occurredAt.toISOString(),
  mode: r.mode as ResourceMode,
});

export class PrismaEventRepository implements EventRepository {
  async append(input: EventAppendInput): Promise<EventRecord> {
    return rowToEvent(await prisma.event.create({
      data: {
        type: input.type, orgId: input.orgId, useCaseKey: input.useCaseKey, subjectId: input.subjectId,
        data: JSON.stringify(input.data),
        mode: input.mode ?? "live",
        ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
      },
    }));
  }
  /**
   * `orgId: undefined` means EVERY org (PlatformAdmin); `orgId: null` means
   * platform-scope rows only. `mode: undefined` means BOTH environments.
   */
  async listAfter(after: number, opts: { orgId?: string | null; type?: string; mode?: ResourceMode; limit: number }): Promise<EventRecord[]> {
    return (await prisma.event.findMany({
      where: {
        seq: { gt: after },
        ...(opts.orgId === undefined ? {} : { orgId: opts.orgId }),
        ...(opts.type ? { type: opts.type } : {}),
        ...(opts.mode === undefined ? {} : { mode: opts.mode }),
      },
      orderBy: { seq: "asc" },
      take: opts.limit,
    })).map(rowToEvent);
  }
  async findById(id: string): Promise<EventRecord | null> {
    const r = await prisma.event.findUnique({ where: { id } });
    return r ? rowToEvent(r) : null;
  }
}

export const rowToWebhookEndpoint = (r: {
  id: string; orgId: string | null; url: string; description: string | null; eventTypes: string;
  useCaseKey: string | null; secretEncrypted: string; status: string; disabledReason: string | null;
  disabledAt: Date | null; consecutiveFailures: number; consecutiveGuardFailures: number;
  failingSince: Date | null; deletedAt: Date | null; createdBy: string;
  createdAt: Date; lastDeliveryAt: Date | null; mode: string;
}): WebhookEndpointRecord => ({
  id: r.id, orgId: r.orgId, url: r.url, description: r.description,
  eventTypes: JSON.parse(r.eventTypes) as string[],
  useCaseKey: r.useCaseKey, secretEncrypted: r.secretEncrypted,
  status: r.status as WebhookEndpointRecord["status"], disabledReason: r.disabledReason,
  disabledAt: r.disabledAt ? r.disabledAt.toISOString() : null,
  consecutiveFailures: r.consecutiveFailures,
  consecutiveGuardFailures: r.consecutiveGuardFailures,
  failingSince: r.failingSince ? r.failingSince.toISOString() : null,
  deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
  lastDeliveryAt: r.lastDeliveryAt ? r.lastDeliveryAt.toISOString() : null,
  mode: r.mode as ResourceMode,
});

export class PrismaWebhookEndpointRepository implements WebhookEndpointRepository {
  async create(input: WebhookEndpointCreateInput): Promise<WebhookEndpointRecord> {
    return rowToWebhookEndpoint(await prisma.webhookEndpoint.create({
      data: {
        orgId: input.orgId, url: input.url, description: input.description,
        eventTypes: JSON.stringify(input.eventTypes), useCaseKey: input.useCaseKey,
        secretEncrypted: input.secretEncrypted, createdBy: input.createdBy,
        mode: input.mode ?? "live",
      },
    }));
  }
  async findById(id: string): Promise<WebhookEndpointRecord | null> {
    const r = await prisma.webhookEndpoint.findUnique({ where: { id } });
    return r ? rowToWebhookEndpoint(r) : null;
  }
  /** Soft-deleted rows are filtered: unlike an api key, a dead endpoint is not an audit trail. */
  async listByOrg(orgId: string | null): Promise<WebhookEndpointRecord[]> {
    return (await prisma.webhookEndpoint.findMany({ where: { orgId, deletedAt: null }, orderBy: { createdAt: "desc" } })).map(rowToWebhookEndpoint);
  }
  async listActive(): Promise<WebhookEndpointRecord[]> {
    return (await prisma.webhookEndpoint.findMany({ where: { status: "active", deletedAt: null }, orderBy: { createdAt: "asc" } })).map(rowToWebhookEndpoint);
  }
  async update(id: string, patch: Partial<Pick<WebhookEndpointRecord, "url" | "description" | "eventTypes" | "useCaseKey" | "secretEncrypted" | "status" | "disabledReason" | "disabledAt" | "consecutiveFailures" | "consecutiveGuardFailures" | "failingSince" | "deletedAt" | "lastDeliveryAt">>): Promise<WebhookEndpointRecord> {
    // Each key is spread in only when PRESENT: an absent key must leave the
    // column alone, while an explicit `null` must clear it (re-enabling an
    // endpoint clears disabledReason/disabledAt), and `undefined` cannot say both.
    return rowToWebhookEndpoint(await prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.eventTypes !== undefined ? { eventTypes: JSON.stringify(patch.eventTypes) } : {}),
        ...(patch.useCaseKey !== undefined ? { useCaseKey: patch.useCaseKey } : {}),
        ...(patch.secretEncrypted !== undefined ? { secretEncrypted: patch.secretEncrypted } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.disabledReason !== undefined ? { disabledReason: patch.disabledReason } : {}),
        ...(patch.disabledAt !== undefined ? { disabledAt: patch.disabledAt ? new Date(patch.disabledAt) : null } : {}),
        ...(patch.consecutiveFailures !== undefined ? { consecutiveFailures: patch.consecutiveFailures } : {}),
        ...(patch.consecutiveGuardFailures !== undefined ? { consecutiveGuardFailures: patch.consecutiveGuardFailures } : {}),
        // `null` clears the failure clock (a success); absent leaves it running.
        ...(patch.failingSince !== undefined ? { failingSince: patch.failingSince ? new Date(patch.failingSince) : null } : {}),
        ...(patch.deletedAt !== undefined ? { deletedAt: patch.deletedAt ? new Date(patch.deletedAt) : null } : {}),
        ...(patch.lastDeliveryAt !== undefined ? { lastDeliveryAt: patch.lastDeliveryAt ? new Date(patch.lastDeliveryAt) : null } : {}),
      },
    }));
  }
}

const toWebhookDelivery = (r: {
  id: string; endpointId: string; eventId: string; eventSeq: number; status: string; attempts: number;
  nextAttemptAt: Date; lastAttemptAt: Date | null; responseStatus: number | null;
  responseError: string | null; durationMs: number | null; claimedAt: Date | null;
  claimedBy: string | null; createdAt: Date;
}): WebhookDeliveryRecord => ({
  id: r.id, endpointId: r.endpointId, eventId: r.eventId, eventSeq: r.eventSeq,
  status: r.status as WebhookDeliveryRecord["status"], attempts: r.attempts,
  nextAttemptAt: r.nextAttemptAt.toISOString(),
  lastAttemptAt: r.lastAttemptAt ? r.lastAttemptAt.toISOString() : null,
  responseStatus: r.responseStatus, responseError: r.responseError, durationMs: r.durationMs,
  claimedAt: r.claimedAt ? r.claimedAt.toISOString() : null,
  claimedBy: r.claimedBy, createdAt: r.createdAt.toISOString(),
});

export class PrismaWebhookDeliveryRepository implements WebhookDeliveryRepository {
  async enqueue(input: { endpointId: string; eventId: string; eventSeq: number }): Promise<WebhookDeliveryRecord> {
    // The unique (endpointId, eventId) pair IS the idempotency key. upsert with an
    // empty update returns the existing row instead of throwing P2002.
    return toWebhookDelivery(await prisma.webhookDelivery.upsert({
      where: { endpointId_eventId: { endpointId: input.endpointId, eventId: input.eventId } },
      create: { endpointId: input.endpointId, eventId: input.eventId, eventSeq: input.eventSeq },
      update: {},
    }));
  }
  async findById(id: string): Promise<WebhookDeliveryRecord | null> {
    const r = await prisma.webhookDelivery.findUnique({ where: { id } });
    return r ? toWebhookDelivery(r) : null;
  }
  /** Newest event first. Ordered by `eventSeq`, not `createdAt`: a fan-out writes every row in the same millisecond. */
  async listByEndpoint(endpointId: string, limit: number): Promise<WebhookDeliveryRecord[]> {
    return (await prisma.webhookDelivery.findMany({ where: { endpointId }, orderBy: { eventSeq: "desc" }, take: limit })).map(toWebhookDelivery);
  }
  async listDue(now: string, limit: number): Promise<WebhookDeliveryRecord[]> {
    return (await prisma.webhookDelivery.findMany({
      where: { status: { in: ["pending", "failed"] }, nextAttemptAt: { lte: new Date(now) } },
      orderBy: [{ nextAttemptAt: "asc" }, { eventSeq: "asc" }],
      take: limit,
    })).map(toWebhookDelivery);
  }
  async claim(id: string, workerId: string, now: string): Promise<WebhookDeliveryRecord | null> {
    // Compare-and-set. The status predicate is inside the WHERE, so two racing
    // dispatchers cannot both transition the same row — the loser updates 0 rows.
    const n = await prisma.webhookDelivery.updateMany({
      where: { id, status: { in: ["pending", "failed"] } },
      data: { status: "inflight", claimedAt: new Date(now), claimedBy: workerId },
    });
    if (n.count === 0) return null;
    const r = await prisma.webhookDelivery.findUnique({ where: { id } });
    return r ? toWebhookDelivery(r) : null;
  }
  /**
   * Operator replay, as a compare-and-set. The `not: "inflight"` predicate is
   * inside the WHERE for the same reason `claim`'s is: a dispatcher claiming
   * between a read and a plain update would have its claim reset while it was
   * mid-POST. The loser of the race updates 0 rows and gets a 409.
   */
  async requeue(id: string, at: string): Promise<WebhookDeliveryRecord | null> {
    const n = await prisma.webhookDelivery.updateMany({
      where: { id, status: { not: "inflight" } },
      data: { status: "pending", attempts: 0, nextAttemptAt: new Date(at), claimedAt: null, claimedBy: null },
    });
    if (n.count === 0) return null;
    const r = await prisma.webhookDelivery.findUnique({ where: { id } });
    return r ? toWebhookDelivery(r) : null;
  }
  /** Crash recovery: an inflight row whose worker died is nobody's, so it goes back in the queue. */
  async reclaimStale(before: string): Promise<number> {
    const n = await prisma.webhookDelivery.updateMany({
      where: { status: "inflight", claimedAt: { lt: new Date(before) } },
      data: { status: "pending", claimedAt: null, claimedBy: null },
    });
    return n.count;
  }
  async update(id: string, patch: Partial<Pick<WebhookDeliveryRecord, "status" | "attempts" | "nextAttemptAt" | "lastAttemptAt" | "responseStatus" | "responseError" | "durationMs" | "claimedAt" | "claimedBy">>): Promise<WebhookDeliveryRecord> {
    // Same present-vs-null discipline as the endpoint patch: an absent key must
    // not touch the column, an explicit null must clear it (releasing a claim).
    return toWebhookDelivery(await prisma.webhookDelivery.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
        ...(patch.nextAttemptAt !== undefined ? { nextAttemptAt: new Date(patch.nextAttemptAt) } : {}),
        ...(patch.lastAttemptAt !== undefined ? { lastAttemptAt: patch.lastAttemptAt ? new Date(patch.lastAttemptAt) : null } : {}),
        ...(patch.responseStatus !== undefined ? { responseStatus: patch.responseStatus } : {}),
        ...(patch.responseError !== undefined ? { responseError: patch.responseError } : {}),
        ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
        ...(patch.claimedAt !== undefined ? { claimedAt: patch.claimedAt ? new Date(patch.claimedAt) : null } : {}),
        ...(patch.claimedBy !== undefined ? { claimedBy: patch.claimedBy } : {}),
      },
    }));
  }
}
