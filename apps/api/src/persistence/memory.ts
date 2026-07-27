import { createHash, randomUUID } from "node:crypto";
import { auditGenesis, auditEntryHash, normalizeUseCaseDefinition, PolicyError, type UseCaseDefinition, type CredentialUseCaseDefinition } from "@tokenlayer/core";
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
  ListingRecord,
  ListingRepository,
  OrganizationRecord,
  OrganizationRepository,
  OrgStatus,
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
  UseCaseRepository,
  UserRecord,
  UserRepository,
  VerificationRequestRecord,
  VerificationRequestRepository,
  VerificationStatus,
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
  async listByOrg(orgId: string): Promise<UserRecord[]> {
    return [...this.byId.values()].filter((u) => u.orgId === orgId);
  }
  async update(userId: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus" | "did" | "kyc" | "orgId" | "didSeedEncrypted">>): Promise<UserRecord> {
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
    if (value === undefined) return null; // never match on a missing field (undefined === undefined footgun)
    for (const a of this.byId.values()) {
      if (a.useCaseKey === useCaseKey && a.metadata?.[field] === value) return a;
    }
    return null;
  }
}

export class MemoryAuditRepository implements AuditRepository {
  private readonly entries: AuditEntryRecord[] = [];
  private appendLock: Promise<unknown> = Promise.resolve();
  async append(
    entry: Omit<AuditEntryRecord, "id" | "createdAt"> & { createdAt?: string },
  ): Promise<AuditEntryRecord> {
    // Serialize appends so each entry reads a consistent per-asset head.
    const run = this.appendLock.then(async () => {
      const chainKey = entry.assetId ?? "__none__";
      const chain = this.entries.filter((e) => (e.assetId ?? "__none__") === chainKey).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const seq = chain.length;
      const prevHash = chain.length ? chain[chain.length - 1]!.hash! : auditGenesis(chainKey);
      const createdAt = entry.createdAt ?? now();
      const hash = auditEntryHash(prevHash, { assetId: chainKey, seq, actorId: entry.actorId, action: entry.action, payload: entry.payload, txHash: entry.txHash, chainId: entry.chainId, createdAt });
      const rec: AuditEntryRecord = { ...entry, id: id("audit"), createdAt, seq, prevHash, hash };
      this.entries.push(rec);
      return rec;
    });
    this.appendLock = run.catch(() => {});
    return run;
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

export class MemoryCredentialUseCaseRepository implements CredentialUseCaseRepository {
  private store = new Map<string, CredentialUseCaseDefinition>();
  async create(def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    this.store.set(def.key, { ...def }); return { ...def };
  }
  async get(key: string): Promise<CredentialUseCaseDefinition | null> {
    const d = this.store.get(key); return d ? { ...d } : null;
  }
  async has(key: string): Promise<boolean> { return this.store.has(key); }
  async list(): Promise<CredentialUseCaseDefinition[]> { return [...this.store.values()].map((d) => ({ ...d })); }
  async update(key: string, def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    this.store.set(key, { ...def }); return { ...def };
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

export class MemoryProposalRepository implements ProposalRepository {
  private rows = new Map<string, ProposalRecord>();
  // Return a deep-enough copy so callers can't alias the stored record's arrays.
  private clone(r: ProposalRecord): ProposalRecord {
    return { ...r, payload: { ...r.payload }, approvals: r.approvals.map((a) => ({ ...a })) };
  }
  async create(input: Omit<ProposalRecord, "id" | "approvals" | "status" | "error" | "createdAt" | "decidedAt">): Promise<ProposalRecord> {
    const rec: ProposalRecord = { ...input, id: id("proposal"), approvals: [], status: "pending", error: null, createdAt: now(), decidedAt: null };
    this.rows.set(rec.id, rec);
    return this.clone(rec);
  }
  async get(proposalId: string): Promise<ProposalRecord | null> {
    const r = this.rows.get(proposalId);
    return r ? this.clone(r) : null;
  }
  async list(useCaseKey?: string, status?: string): Promise<ProposalRecord[]> {
    return [...this.rows.values()]
      .filter((r) => (!useCaseKey || r.useCaseKey === useCaseKey) && (!status || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => this.clone(r));
  }
  async listByOrg(orgId: string, status?: string): Promise<ProposalRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.orgId === orgId && (!status || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => this.clone(r));
  }
  // addApproval/claimApproved/setStatus are each a single synchronous mutation
  // (no await between check and write) → atomic w.r.t. concurrent requests, as
  // the CashflowRepository CAS methods rely on.
  async addApproval(proposalId: string, approval: ProposalApproval): Promise<ProposalRecord> {
    const r = this.rows.get(proposalId);
    if (!r) throw new Error(`unknown proposal '${proposalId}'`);
    if (r.approvals.some((a) => a.userId === approval.userId)) {
      throw Object.assign(new Error("already approved"), { code: "ALREADY_APPROVED" });
    }
    r.approvals.push(approval);
    return this.clone(r);
  }
  async claimDecided(proposalId: string, target: ProposalRecord["status"]): Promise<boolean> {
    const r = this.rows.get(proposalId);
    if (!r || r.status !== "pending") return false;
    r.status = target;
    return true;
  }
  async setStatus(proposalId: string, status: ProposalRecord["status"], error?: string | null): Promise<ProposalRecord> {
    const r = this.rows.get(proposalId);
    if (!r) throw new Error(`unknown proposal '${proposalId}'`);
    r.status = status;
    r.error = error ?? null;
    if (status === "rejected" || status === "executed" || status === "failed") r.decidedAt = now();
    return this.clone(r);
  }
}

export class MemoryDocumentRepository implements DocumentRepository {
  private readonly docs = new Map<string, DocumentRecord>();
  async create({ contentType, bytes }: { contentType: string; bytes: Buffer }) {
    const docId = randomUUID();
    const sha256 = "0x" + createHash("sha256").update(bytes).digest("hex");
    this.docs.set(docId, { id: docId, contentType, sha256, size: bytes.length, bytes, createdAt: now() });
    return { id: docId, sha256, size: bytes.length };
  }
  async get(docId: string): Promise<DocumentRecord | null> {
    return this.docs.get(docId) ?? null;
  }
}

export class MemoryAuditAnchorRepository implements AuditAnchorRepository {
  private readonly rows: AuditAnchorRecord[] = [];
  async create(input: Omit<AuditAnchorRecord, "id" | "createdAt">): Promise<AuditAnchorRecord> {
    const rec: AuditAnchorRecord = { ...input, id: id("anchor"), createdAt: now() };
    this.rows.push(rec);
    return { ...rec };
  }
  async latest(assetId: string): Promise<AuditAnchorRecord | null> {
    const matches = this.rows.filter((r) => r.assetId === assetId).sort((a, b) => b.seq - a.seq);
    return matches.length ? { ...matches[0]! } : null;
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

export class MemoryOrganizationRepository implements OrganizationRepository {
  private readonly byId = new Map<string, OrganizationRecord>();
  async create(input: Omit<OrganizationRecord, "id" | "createdAt">): Promise<OrganizationRecord> {
    const rec: OrganizationRecord = { ...input, id: id("org"), createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async get(orgId: string): Promise<OrganizationRecord | null> {
    return this.byId.get(orgId) ?? null;
  }
  async findByName(name: string): Promise<OrganizationRecord | null> {
    return [...this.byId.values()].find((o) => o.name === name) ?? null;
  }
  async findByDid(did: string): Promise<OrganizationRecord | null> {
    return [...this.byId.values()].find((o) => o.did === did) ?? null;
  }
  async findByRegistrationId(registrationId: string): Promise<OrganizationRecord | null> {
    return [...this.byId.values()].find((o) => o.registrationId === registrationId) ?? null;
  }
  async list(): Promise<OrganizationRecord[]> {
    return [...this.byId.values()];
  }
  async setVerified(orgId: string, verified: boolean, verifiedAt: string | null): Promise<OrganizationRecord> {
    const rec = this.byId.get(orgId);
    if (!rec) throw new Error(`unknown org '${orgId}'`);
    rec.verified = verified;
    rec.verifiedAt = verifiedAt;
    return rec;
  }
  async setStatus(orgId: string, status: OrgStatus): Promise<OrganizationRecord> {
    const rec = this.byId.get(orgId);
    if (!rec) throw new Error(`unknown org '${orgId}'`);
    rec.status = status;
    return rec;
  }
  async remove(orgId: string): Promise<void> {
    this.byId.delete(orgId);
  }
}

export class MemoryCredentialRepository implements CredentialRepository {
  private readonly byId = new Map<string, CredentialRecord>();
  async create(input: CredentialRecord): Promise<CredentialRecord> {
    const rec: CredentialRecord = { ...input };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async listByHolder(holderDid: string): Promise<CredentialRecord[]> {
    return [...this.byId.values()].filter((c) => c.holderDid === holderDid);
  }
  async listByIssuer(issuerDid: string): Promise<CredentialRecord[]> {
    return [...this.byId.values()].filter((c) => c.issuerDid === issuerDid);
  }
  async get(credId: string): Promise<CredentialRecord | null> {
    return this.byId.get(credId) ?? null;
  }
  async setRevoked(credId: string, revoked: boolean): Promise<CredentialRecord> {
    const rec = this.byId.get(credId);
    if (!rec) throw new Error(`unknown credential '${credId}'`);
    rec.revoked = revoked;
    return rec;
  }
  async revoke(credId: string, input: { reason: string; by: string; at: string }): Promise<CredentialRecord> {
    const rec = this.byId.get(credId);
    if (!rec) throw new Error(`unknown credential '${credId}'`);
    rec.revoked = true;
    rec.revokedReason = input.reason;
    rec.revokedBy = input.by;
    rec.revokedAt = input.at;
    return rec;
  }
}

export class MemoryRegistryDeploymentRepository implements RegistryDeploymentRepository {
  private readonly byChain = new Map<string, RegistryDeploymentRecord>();
  async get(chainId: string): Promise<RegistryDeploymentRecord | null> {
    return this.byChain.get(chainId) ?? null;
  }
  async create(input: Omit<RegistryDeploymentRecord, "createdAt">): Promise<RegistryDeploymentRecord> {
    const rec: RegistryDeploymentRecord = { ...input, createdAt: now() };
    this.byChain.set(rec.chainId, rec);
    return rec;
  }
}

export class MemoryVerificationRequestRepository implements VerificationRequestRepository {
  private readonly byId = new Map<string, VerificationRequestRecord>();
  async create(input: Omit<VerificationRequestRecord, "id" | "createdAt">): Promise<VerificationRequestRecord> {
    const rec: VerificationRequestRecord = { ...input, id: id("vreq"), createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async get(reqId: string): Promise<VerificationRequestRecord | null> {
    return this.byId.get(reqId) ?? null;
  }
  async listByHolder(holderDid: string, status?: string): Promise<VerificationRequestRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.holderDid === holderDid && (!status || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async listByVerifierOrg(orgId: string, status?: string): Promise<VerificationRequestRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.verifierOrgId === orgId && (!status || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async setConsented(reqId: string, input: { vpJwt: string; credentialIds: string[]; at: string }): Promise<VerificationRequestRecord> {
    const rec = this.byId.get(reqId);
    if (!rec) throw new Error(`unknown verification request '${reqId}'`);
    rec.status = "consented"; rec.presentationVpJwt = input.vpJwt; rec.consentedCredentialIds = input.credentialIds; rec.consentedAt = input.at;
    return rec;
  }
  async setStatus(reqId: string, status: VerificationStatus): Promise<VerificationRequestRecord> {
    const rec = this.byId.get(reqId);
    if (!rec) throw new Error(`unknown verification request '${reqId}'`);
    rec.status = status;
    return rec;
  }
  async setVerifierResult(reqId: string, input: { result: Record<string, unknown>; at: string }): Promise<VerificationRequestRecord> {
    const rec = this.byId.get(reqId);
    if (!rec) throw new Error(`unknown verification request '${reqId}'`);
    rec.verifierResult = input.result; rec.verifiedAt = input.at;
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
