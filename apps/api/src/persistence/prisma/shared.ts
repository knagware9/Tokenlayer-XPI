/**
 * PRISMA REPOSITORIES — Shared tables — users, orgs, approvals, audit, events, API keys.
 *
 * Bucketed by `../model-domains.ts`. Its in-memory twin is `../memory/shared.ts`,
 * and `persistence-parity.test.ts` fails if the two stop implementing the same
 * set — the drift that the PARITY RULE exists to catch.
 */
import { createHash } from "node:crypto";
import { prisma } from "./client.js";
import { auditEntryHash, auditGenesis } from "@tokenlayer/core";
import type { LifecycleAction, OrgCapabilities, Role } from "@tokenlayer/core";
import { LEDGER_UNKNOWN_RETRY_MS } from "../types/index.js";
import type { OrgType } from "../types/index.js";
import type { ApiKeyCreateInput, ApiKeyRecord, ApiKeyRepository, AuditAnchorRecord, AuditAnchorRepository, AuditEntryRecord, AuditRepository, BrandingPatch, CompanyProfile, CredentialRecord, CredentialRepository, DocumentPurpose, DocumentRecord, DocumentRepository, DocumentSummary, EventAppendInput, EventRecord, EventRepository, KycDetails, KycStatus, LedgerTransactionRecord, LedgerTransactionRepository, LedgerTransactionSettlement, LedgerTxKind, LedgerTxStatus, LoginKeyRecord, LoginKeyRepository, OrgStatus, OrganizationRecord, OrganizationRepository, Page, Paged, ProposalApproval, ProposalRecord, ProposalRepository, RegistryDeploymentRecord, RegistryDeploymentRepository, UserKind, UserRecord, UserRepository, WebhookDeliveryRecord, WebhookDeliveryRepository, WebhookEndpointCreateInput, WebhookEndpointRecord, WebhookEndpointRepository } from "../types/index.js";

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
  async findByAccountId(accountId: string): Promise<UserRecord | null> {
    const r = await prisma.user.findFirst({ where: { accountId } });
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
type DocumentCreateData = { contentType: string; sha256: string; size: number; bytes: Buffer; ownerOrgId: string | null; purpose: DocumentPurpose | null; uploadedBy: string | null };

export class PrismaDocumentRepository implements DocumentRepository {
  async create({ contentType, bytes, ownerOrgId, purpose, uploadedBy }: { contentType: string; bytes: Buffer; ownerOrgId: string | null; purpose: DocumentPurpose | null; uploadedBy: string | null }): Promise<{ id: string; sha256: string; size: number }> {
    const sha256 = "0x" + createHash("sha256").update(bytes).digest("hex");
    const data: DocumentCreateData = { contentType, sha256, size: bytes.length, bytes, ownerOrgId, purpose, uploadedBy };
    const row = await prisma.document.create({ data });
    return { id: row.id, sha256, size: bytes.length };
  }
  async get(id: string): Promise<DocumentRecord | null> {
    const r = await prisma.document.findUnique({ where: { id } });
    return r
      ? { id: r.id, contentType: r.contentType, sha256: r.sha256, size: r.size, bytes: Buffer.from(r.bytes), createdAt: r.createdAt.toISOString(), ownerOrgId: r.ownerOrgId ?? null, purpose: r.purpose === "brand-logo" ? "brand-logo" : null, uploadedBy: r.uploadedBy ?? null }
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
    // `orderBy: { seq: "desc" }` alone is a TIE when an asset carries more than
    // one anchor at a seq, and SQL does not promise which row wins. Observed in
    // the wild: three anchors at seq 4, the first genuine and two written after
    // a tamper. Oldest-wins at equal seq — see AuditAnchorRepository.latest.
    const r = await prisma.auditAnchor.findFirst({ where: { assetId }, orderBy: [{ seq: "desc" }, { createdAt: "asc" }] });
    return r ? toAuditAnchor(r) : null;
  }
  async list(assetId: string): Promise<AuditAnchorRecord[]> {
    return (await prisma.auditAnchor.findMany({ where: { assetId }, orderBy: [{ seq: "asc" }, { createdAt: "asc" }] })).map(toAuditAnchor);
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
  async listByProposer(proposerId: string, status?: string): Promise<ProposalRecord[]> {
    return (await prisma.proposal.findMany({ where: { proposerId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" } })).map(toProposal);
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
  async upsert(input: Omit<RegistryDeploymentRecord, "createdAt">): Promise<RegistryDeploymentRecord> {
    return toRegistry(await prisma.registryDeployment.upsert({
      where: { chainId: input.chainId },
      create: input,
      update: input,
    }));
  }
}

export const rowToApiKey = (r: {
  id: string; orgId: string | null; userId: string; name: string; prefix: string; secretHash: string;
  scopes: string; expiresAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null;
  revokedBy: string | null; createdBy: string; createdAt: Date;
}): ApiKeyRecord => ({
  id: r.id, orgId: r.orgId, userId: r.userId, name: r.name, prefix: r.prefix, secretHash: r.secretHash,
  scopes: JSON.parse(r.scopes) as string[],
  expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
  lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  revokedBy: r.revokedBy, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
});

export class PrismaApiKeyRepository implements ApiKeyRepository {
  async create(input: ApiKeyCreateInput): Promise<ApiKeyRecord> {
    return rowToApiKey(await prisma.apiKey.create({
      data: {
        orgId: input.orgId, userId: input.userId, name: input.name, prefix: input.prefix,
        secretHash: input.secretHash, scopes: JSON.stringify(input.scopes),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, createdBy: input.createdBy,
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
  subjectId: string | null; data: string; occurredAt: Date;
}): EventRecord => ({
  seq: r.seq, id: r.id, type: r.type, orgId: r.orgId, useCaseKey: r.useCaseKey,
  subjectId: r.subjectId, data: JSON.parse(r.data) as Record<string, unknown>,
  occurredAt: r.occurredAt.toISOString(),
});

export class PrismaEventRepository implements EventRepository {
  async append(input: EventAppendInput): Promise<EventRecord> {
    return rowToEvent(await prisma.event.create({
      data: {
        type: input.type, orgId: input.orgId, useCaseKey: input.useCaseKey, subjectId: input.subjectId,
        data: JSON.stringify(input.data),
        ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
      },
    }));
  }
  /**
   * `orgId: undefined` means EVERY org (PlatformAdmin); `orgId: null` means
   * platform-scope rows only.
   */
  async listAfter(after: number, opts: { orgId?: string | null; type?: string; limit: number }): Promise<EventRecord[]> {
    return (await prisma.event.findMany({
      where: {
        seq: { gt: after },
        ...(opts.orgId === undefined ? {} : { orgId: opts.orgId }),
        ...(opts.type ? { type: opts.type } : {}),
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
  createdAt: Date; lastDeliveryAt: Date | null;
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
});

export class PrismaWebhookEndpointRepository implements WebhookEndpointRepository {
  async create(input: WebhookEndpointCreateInput): Promise<WebhookEndpointRecord> {
    return rowToWebhookEndpoint(await prisma.webhookEndpoint.create({
      data: {
        orgId: input.orgId, url: input.url, description: input.description,
        eventTypes: JSON.stringify(input.eventTypes), useCaseKey: input.useCaseKey,
        secretEncrypted: input.secretEncrypted, createdBy: input.createdBy,
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

const toLedgerTx = (r: {
  id: string; chainId: string; txHash: string; kind: string; amount: string | null; assetId: string | null;
  credentialId: string | null; status: string; attempts: number; nextAttemptAt: Date;
  lastAttemptAt: Date | null; claimedAt: Date | null; claimedBy: string | null;
  blockNumber: number | null; error: string | null; submittedAt: Date; confirmedAt: Date | null;
}): LedgerTransactionRecord => ({
  id: r.id, chainId: r.chainId, txHash: r.txHash, kind: r.kind as LedgerTxKind, amount: r.amount,
  assetId: r.assetId, credentialId: r.credentialId, status: r.status as LedgerTxStatus,
  attempts: r.attempts, nextAttemptAt: r.nextAttemptAt.toISOString(),
  lastAttemptAt: r.lastAttemptAt ? r.lastAttemptAt.toISOString() : null,
  claimedAt: r.claimedAt ? r.claimedAt.toISOString() : null, claimedBy: r.claimedBy,
  blockNumber: r.blockNumber, error: r.error,
  submittedAt: r.submittedAt.toISOString(),
  confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
});

export class PrismaLedgerTransactionRepository implements LedgerTransactionRepository {
  async record(input: {
    chainId: string; txHash: string; kind: LedgerTxKind; amount?: string | null;
    assetId?: string | null; credentialId?: string | null; submittedAt: string;
  }): Promise<LedgerTransactionRecord> {
    const row = await prisma.ledgerTransaction.upsert({
      where: { chainId_txHash: { chainId: input.chainId, txHash: input.txHash } },
      update: {},
      create: {
        chainId: input.chainId, txHash: input.txHash, kind: input.kind, amount: input.amount ?? null,
        assetId: input.assetId ?? null, credentialId: input.credentialId ?? null,
        status: "pending", submittedAt: new Date(input.submittedAt),
        nextAttemptAt: new Date(input.submittedAt),
      },
    });
    return toLedgerTx(row);
  }

  async findById(id: string): Promise<LedgerTransactionRecord | null> {
    const row = await prisma.ledgerTransaction.findUnique({ where: { id } });
    return row ? toLedgerTx(row) : null;
  }

  async listDue(now: string, limit: number): Promise<LedgerTransactionRecord[]> {
    const rows = await prisma.ledgerTransaction.findMany({
      where: { status: { in: ["pending", "unknown"] }, claimedAt: null, nextAttemptAt: { lte: new Date(now) } },
      orderBy: { submittedAt: "asc" }, take: limit,
    });
    return rows.map(toLedgerTx);
  }

  async claim(id: string, workerId: string, now: string): Promise<LedgerTransactionRecord | null> {
    // CAS: the WHERE carries claimedAt:null, so a loser updates 0 rows.
    const res = await prisma.ledgerTransaction.updateMany({
      where: { id, claimedAt: null, status: { in: ["pending", "unknown"] } },
      data: { claimedAt: new Date(now), claimedBy: workerId },
    });
    if (res.count === 0) return null;
    return this.findById(id);
  }

  async reclaimStale(before: string): Promise<number> {
    const res = await prisma.ledgerTransaction.updateMany({
      where: { claimedAt: { lt: new Date(before) } },
      data: { claimedAt: null, claimedBy: null },
    });
    return res.count;
  }

  async listByAsset(assetId: string): Promise<LedgerTransactionRecord[]> {
    const rows = await prisma.ledgerTransaction.findMany({
      where: { assetId, status: { in: ["pending", "unknown"] } },
      orderBy: { submittedAt: "asc" },
    });
    return rows.map(toLedgerTx);
  }

  async countsByStatus(assetId: string): Promise<Record<LedgerTxStatus, number>> {
    // Tallied in JS rather than by `groupBy`, matching `settledSupply` just
    // below: the row count per asset is small, and one shape of query keeps the
    // two backends' answers obviously identical.
    const rows = await prisma.ledgerTransaction.findMany({ where: { assetId }, select: { status: true } });
    const counts: Record<LedgerTxStatus, number> = { pending: 0, confirmed: 0, failed: 0, unknown: 0 };
    for (const r of rows) {
      const status = r.status as LedgerTxStatus;
      if (status in counts) counts[status] += 1;
    }
    return counts;
  }

  async settledSupply(assetId: string): Promise<string> {
    const rows = await prisma.ledgerTransaction.findMany({
      where: { assetId, status: "confirmed", kind: { in: ["mint", "burn"] } },
      select: { kind: true, amount: true },
    });
    // BigInt, not Number: a float would silently round the quantity being reconciled.
    let total = 0n;
    for (const r of rows) {
      if (!r.amount) continue;
      total += r.kind === "mint" ? BigInt(r.amount) : -BigInt(r.amount);
    }
    return total.toString();
  }

  async settle(id: string, s: LedgerTransactionSettlement): Promise<LedgerTransactionRecord> {
    const row = await prisma.ledgerTransaction.update({
      where: { id },
      data: {
        status: s.status,
        blockNumber: s.blockNumber ?? undefined,
        confirmedAt: s.confirmedAt ? new Date(s.confirmedAt) : null,
        error: s.error ?? null, claimedAt: null, claimedBy: null,
        // RULING AA, exactly as in the memory twin: an `unknown` row would
        // otherwise keep a nextAttemptAt already in the past and sit at the head
        // of `listDue`'s oldest-first page forever, starving new submissions.
        ...(s.nextAttemptAt
          ? { nextAttemptAt: new Date(s.nextAttemptAt) }
          : s.status === "unknown"
            ? { nextAttemptAt: new Date(Date.now() + LEDGER_UNKNOWN_RETRY_MS) }
            : {}),
      },
    });
    return toLedgerTx(row);
  }

  async defer(id: string, nextAttemptAt: string, now: string, error?: string): Promise<LedgerTransactionRecord> {
    const row = await prisma.ledgerTransaction.update({
      where: { id },
      data: {
        attempts: { increment: 1 }, nextAttemptAt: new Date(nextAttemptAt),
        lastAttemptAt: new Date(now), error: error ?? undefined,
        claimedAt: null, claimedBy: null,
      },
    });
    return toLedgerTx(row);
  }
}
