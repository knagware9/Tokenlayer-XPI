import { createHash, randomUUID } from "node:crypto";
import { auditGenesis, auditEntryHash, normalizeUseCaseDefinition, PolicyError, type OrgCapabilities, type ResourceMode, type UseCaseDefinition, type CredentialUseCaseDefinition, type UseCaseTemplate } from "@tokenlayer/core";
import type {
  AccountRecord,
  AccountRepository,
  ApiKeyCreateInput,
  ApiKeyRecord,
  ApiKeyRepository,
  AssetFilter,
  AssetRecord,
  BrandingPatch,
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
  ListingRecord,
  ListingRepository,
  LoginKeyRecord,
  LoginKeyRepository,
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
  async create(input: Omit<UserRecord, "id" | "createdAt" | "kind"> & { kind?: UserKind }): Promise<UserRecord> {
    const rec: UserRecord = { ...input, kind: input.kind ?? "human", id: id("user"), createdAt: now() };
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
      // An allowlist, ANDed with the single-key filter above rather than
      // replacing it: a scoped caller stays clamped to their own use case even
      // when the mode narrowing also applies.
      .filter((a) => (!filter.useCaseKeys || filter.useCaseKeys.includes(a.useCaseKey)))
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
  /**
   * Every entry, oldest first. Deliberately NOT part of `AuditRepository`: it is
   * an in-memory introspection affordance for tests (against Prisma one queries
   * the database directly), so the interface stays the read shape routes use.
   */
  async list(): Promise<AuditEntryRecord[]> {
    return [...this.entries];
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
    const def = { ...normalizeUseCaseDefinition(raw), sandbox: raw.sandbox === true };
    if (this.byKey.has(def.key)) throw new PolicyError("INVALID_USECASE", `use case '${def.key}' already exists`, { key: def.key });
    this.byKey.set(def.key, def);
    return def;
  }
  async update(key: string, raw: UseCaseDefinition): Promise<UseCaseDefinition> {
    if (!this.byKey.has(key)) throw new PolicyError("UNKNOWN_USECASE", `unknown use case '${key}'`, { key });
    const def = { ...normalizeUseCaseDefinition({ ...raw, key }), sandbox: raw.sandbox === true };
    this.byKey.set(key, def);
    return def;
  }
}

export class MemoryCredentialUseCaseRepository implements CredentialUseCaseRepository {
  private store = new Map<string, CredentialUseCaseDefinition>();
  async create(def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    const rec = { ...def, sandbox: def.sandbox === true };
    this.store.set(rec.key, rec); return { ...rec };
  }
  async get(key: string): Promise<CredentialUseCaseDefinition | null> {
    const d = this.store.get(key); return d ? { ...d } : null;
  }
  async has(key: string): Promise<boolean> { return this.store.has(key); }
  async list(): Promise<CredentialUseCaseDefinition[]> { return [...this.store.values()].map((d) => ({ ...d })); }
  async update(key: string, def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition> {
    const rec = { ...def, sandbox: def.sandbox === true };
    this.store.set(key, rec); return { ...rec };
  }
}

export class MemoryCredentialUseCaseTemplateRepository implements CredentialUseCaseTemplateRepository {
  private store = new Map<string, UseCaseTemplate>();
  async list(): Promise<UseCaseTemplate[]> { return [...this.store.values()].map((t) => ({ ...t })); }
  async get(key: string): Promise<UseCaseTemplate | null> {
    const t = this.store.get(key); return t ? { ...t } : null;
  }
  async create(t: UseCaseTemplate): Promise<UseCaseTemplate> {
    this.store.set(t.key, { ...t }); return { ...t };
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
    return { ...r, payload: { ...r.payload }, approvals: r.approvals.map((a) => ({ ...a })), result: r.result ? { ...r.result } : null };
  }
  async create(input: Omit<ProposalRecord, "id" | "approvals" | "status" | "error" | "result" | "createdAt" | "decidedAt">): Promise<ProposalRecord> {
    const rec: ProposalRecord = { ...input, id: id("proposal"), approvals: [], status: "pending", error: null, result: null, createdAt: now(), decidedAt: null };
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
  async setResult(proposalId: string, result: Record<string, unknown>): Promise<ProposalRecord> {
    const r = this.rows.get(proposalId);
    if (!r) throw new Error(`unknown proposal '${proposalId}'`);
    r.result = result;
    return this.clone(r);
  }
}

export class MemoryDocumentRepository implements DocumentRepository {
  private readonly docs = new Map<string, DocumentRecord>();
  async create({ contentType, bytes, ownerOrgId, purpose }: { contentType: string; bytes: Buffer; ownerOrgId: string | null; purpose: DocumentPurpose | null }) {
    const docId = randomUUID();
    const sha256 = "0x" + createHash("sha256").update(bytes).digest("hex");
    this.docs.set(docId, { id: docId, contentType, sha256, size: bytes.length, bytes, createdAt: now(), ownerOrgId, purpose });
    return { id: docId, sha256, size: bytes.length };
  }
  async get(docId: string): Promise<DocumentRecord | null> {
    return this.docs.get(docId) ?? null;
  }
  async listByOwnerPurpose(ownerOrgId: string, purpose: DocumentPurpose): Promise<DocumentSummary[]> {
    // Projected to a summary, mirroring the Prisma `select` — a test that passed
    // here while the real repository loaded every buffer would prove nothing.
    // Map insertion order is creation order, so this is oldest-first for free;
    // Prisma gets there with an explicit `orderBy`.
    return [...this.docs.values()]
      .filter((d) => d.ownerOrgId === ownerOrgId && d.purpose === purpose)
      .map((d) => ({ id: d.id, size: d.size, createdAt: d.createdAt }));
  }
  async removeByOwnerPurpose(docId: string, ownerOrgId: string, purpose: DocumentPurpose): Promise<void> {
    const row = this.docs.get(docId);
    if (row && row.ownerOrgId === ownerOrgId && row.purpose === purpose) this.docs.delete(docId);
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
  async setCapabilities(orgId: string, caps: OrgCapabilities | null): Promise<OrganizationRecord> {
    const rec = this.byId.get(orgId);
    if (!rec) throw new Error(`unknown org '${orgId}'`);
    rec.capabilities = caps;
    return rec;
  }
  async setBranding(orgId: string, patch: BrandingPatch): Promise<OrganizationRecord> {
    const rec = this.byId.get(orgId);
    if (!rec) throw new Error(`unknown org '${orgId}'`);
    // `in` rather than `!== undefined`: an explicit null must CLEAR, and
    // `patch.brandAccent !== undefined` cannot tell "clear it" from "leave it".
    if ("brandLogoDocumentId" in patch) rec.brandLogoDocumentId = patch.brandLogoDocumentId ?? null;
    if ("brandAccent" in patch) rec.brandAccent = patch.brandAccent ?? null;
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
  async list(): Promise<CredentialRecord[]> {
    return [...this.byId.values()];
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
  async revoke(credId: string, input: { reason: string; by: string; at: string; txHash?: string | null }): Promise<CredentialRecord> {
    const rec = this.byId.get(credId);
    if (!rec) throw new Error(`unknown credential '${credId}'`);
    rec.revoked = true;
    rec.revokedReason = input.reason;
    rec.revokedBy = input.by;
    rec.revokedAt = input.at;
    rec.revokeTxHash = input.txHash ?? null;
    return rec;
  }
  async setAcceptance(credId: string, patch: { acceptance: CredentialRecord["acceptance"]; at: string; note: string | null }): Promise<CredentialRecord> {
    const rec = this.byId.get(credId);
    if (!rec) throw new Error(`unknown credential '${credId}'`);
    rec.acceptance = patch.acceptance;
    rec.acceptanceAt = patch.at;
    rec.acceptanceNote = patch.note;
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
  async list(): Promise<VerificationRequestRecord[]> {
    return [...this.byId.values()];
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

export class MemoryApiKeyRepository implements ApiKeyRepository {
  private readonly byId = new Map<string, ApiKeyRecord>();
  async create(input: ApiKeyCreateInput): Promise<ApiKeyRecord> {
    // Mirror the DB's unique `prefix`: a duplicate would make findByPrefix
    // ambiguous here while Prisma rejected it — exactly the divergence the
    // memory/prisma parity rule exists to prevent.
    for (const k of this.byId.values()) {
      if (k.prefix === input.prefix) {
        throw Object.assign(new Error("Unique constraint failed on (prefix)"), { code: "P2002" });
      }
    }
    const rec: ApiKeyRecord = {
      ...input,
      scopes: [...input.scopes],
      id: id("ak"),
      createdAt: now(),
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
      // The DB default, restated: an omitted mode is a LIVE key, so every key
      // minted before EN-D2 keeps behaving exactly as it did.
      mode: input.mode ?? "live",
    };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    return [...this.byId.values()].find((k) => k.prefix === prefix) ?? null;
  }
  async findById(keyId: string): Promise<ApiKeyRecord | null> {
    return this.byId.get(keyId) ?? null;
  }
  /** Revoked/expired keys are deliberately NOT filtered — they are the audit trail. */
  async listByOrg(orgId: string | null): Promise<ApiKeyRecord[]> {
    return [...this.byId.values()]
      .filter((k) => k.orgId === orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async rotate(keyId: string, input: { prefix: string; secretHash: string }): Promise<ApiKeyRecord> {
    const rec = this.byId.get(keyId);
    if (!rec) throw new Error(`unknown api key '${keyId}'`);
    // Same unique-prefix parity the create path enforces.
    for (const k of this.byId.values()) {
      if (k.id !== keyId && k.prefix === input.prefix) {
        throw Object.assign(new Error("Unique constraint failed on (prefix)"), { code: "P2002" });
      }
    }
    rec.prefix = input.prefix;
    rec.secretHash = input.secretHash;
    return rec;
  }
  async touchLastUsed(keyId: string, at: string): Promise<void> {
    const rec = this.byId.get(keyId);
    if (rec) rec.lastUsedAt = at;
  }
  async revoke(keyId: string, input: { by: string; at: string }): Promise<ApiKeyRecord> {
    const rec = this.byId.get(keyId);
    if (!rec) throw new Error(`unknown api key '${keyId}'`);
    rec.revokedAt = input.at;
    rec.revokedBy = input.by;
    return rec;
  }
}

export class MemoryLoginKeyRepository implements LoginKeyRepository {
  private readonly byId = new Map<string, LoginKeyRecord>();
  async create(input: Omit<LoginKeyRecord, "id" | "createdAt" | "lastUsedAt">): Promise<LoginKeyRecord> {
    const rec: LoginKeyRecord = { ...input, id: id("lk"), createdAt: now(), lastUsedAt: null };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async listByUser(userId: string): Promise<LoginKeyRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getByDid(did: string): Promise<LoginKeyRecord | null> {
    return [...this.byId.values()].find((r) => r.did === did) ?? null;
  }
  async get(keyId: string): Promise<LoginKeyRecord | null> {
    return this.byId.get(keyId) ?? null;
  }
  async remove(keyId: string): Promise<void> {
    this.byId.delete(keyId);
  }
  async touch(keyId: string, at: string): Promise<void> {
    const rec = this.byId.get(keyId);
    if (rec) rec.lastUsedAt = at;
  }
}

export class MemoryEventRepository implements EventRepository {
  private readonly rows: EventRecord[] = [];
  /** The global cursor. An array index would break the moment anything filtered. */
  private nextSeq = 1;
  // `data` is a caller-owned object, so copy in AND out — the stored row must
  // not alias whatever the emitter happened to hand us.
  private clone(r: EventRecord): EventRecord {
    return { ...r, data: { ...r.data } };
  }
  async append(input: EventAppendInput): Promise<EventRecord> {
    const rec: EventRecord = {
      ...input,
      data: { ...input.data },
      seq: this.nextSeq++,
      id: `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      occurredAt: input.occurredAt ?? now(),
      // The DB default, restated — see ApiKeyRecord.mode.
      mode: input.mode ?? "live",
    };
    this.rows.push(rec);
    return this.clone(rec);
  }
  /**
   * `orgId: undefined` means EVERY org (PlatformAdmin); `orgId: null` means
   * platform-scope rows only. `mode: undefined` means BOTH environments.
   */
  async listAfter(after: number, opts: { orgId?: string | null; type?: string; mode?: ResourceMode; limit: number }): Promise<EventRecord[]> {
    return this.rows
      .filter((r) => r.seq > after && (opts.orgId === undefined || r.orgId === opts.orgId) && (!opts.type || r.type === opts.type)
        && (opts.mode === undefined || r.mode === opts.mode))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, opts.limit)
      .map((r) => this.clone(r));
  }
  async findById(eventId: string): Promise<EventRecord | null> {
    const r = this.rows.find((e) => e.id === eventId);
    return r ? this.clone(r) : null;
  }
}

export class MemoryWebhookEndpointRepository implements WebhookEndpointRepository {
  private readonly byId = new Map<string, WebhookEndpointRecord>();
  private clone(r: WebhookEndpointRecord): WebhookEndpointRecord {
    return { ...r, eventTypes: [...r.eventTypes] };
  }
  async create(input: WebhookEndpointCreateInput): Promise<WebhookEndpointRecord> {
    const rec: WebhookEndpointRecord = {
      ...input,
      eventTypes: [...input.eventTypes],
      id: id("whep"),
      status: "active",
      disabledReason: null,
      disabledAt: null,
      consecutiveFailures: 0,
      consecutiveGuardFailures: 0,
      // A fresh endpoint is healthy, so its failure clock is not running. The
      // prisma default is likewise NULL, not now().
      failingSince: null,
      deletedAt: null,
      createdAt: now(),
      lastDeliveryAt: null,
      // The DB default, restated — see ApiKeyRecord.mode.
      mode: input.mode ?? "live",
    };
    this.byId.set(rec.id, rec);
    return this.clone(rec);
  }
  async findById(endpointId: string): Promise<WebhookEndpointRecord | null> {
    const r = this.byId.get(endpointId);
    return r ? this.clone(r) : null;
  }
  /** Soft-deleted rows are filtered: unlike an api key, a dead endpoint is not an audit trail. */
  async listByOrg(orgId: string | null): Promise<WebhookEndpointRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.orgId === orgId && r.deletedAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => this.clone(r));
  }
  async listActive(): Promise<WebhookEndpointRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.status === "active" && r.deletedAt === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => this.clone(r));
  }
  async update(endpointId: string, patch: Partial<Pick<WebhookEndpointRecord, "url" | "description" | "eventTypes" | "useCaseKey" | "secretEncrypted" | "status" | "disabledReason" | "disabledAt" | "consecutiveFailures" | "consecutiveGuardFailures" | "failingSince" | "deletedAt" | "lastDeliveryAt">>): Promise<WebhookEndpointRecord> {
    const rec = this.byId.get(endpointId);
    if (!rec) throw new Error(`unknown webhook endpoint '${endpointId}'`);
    // An ABSENT key leaves the column alone; an explicit `null` clears it
    // (re-enabling clears disabledReason/disabledAt). A key present but
    // `undefined` must behave as absent — which is exactly what the prisma
    // side's `!== undefined` spread does, so it must do so here too.
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) Object.assign(rec, { [k]: v });
    }
    if (patch.eventTypes) rec.eventTypes = [...patch.eventTypes];
    return this.clone(rec);
  }
}

export class MemoryWebhookDeliveryRepository implements WebhookDeliveryRepository {
  private readonly byId = new Map<string, WebhookDeliveryRecord>();
  async enqueue(input: { endpointId: string; eventId: string; eventSeq: number }): Promise<WebhookDeliveryRecord> {
    // Mirror the DB's @@unique([endpointId, eventId]): that pair IS the fan-out
    // idempotency key, so a duplicate returns the EXISTING row rather than
    // throwing — the same emulate-the-constraint duty MemoryApiKeyRepository
    // has for its unique prefix, with the opposite (upsert) resolution.
    const existing = [...this.byId.values()].find((d) => d.endpointId === input.endpointId && d.eventId === input.eventId);
    if (existing) return { ...existing };
    const rec: WebhookDeliveryRecord = {
      ...input,
      id: id("whd"),
      status: "pending",
      attempts: 0,
      nextAttemptAt: now(),
      lastAttemptAt: null,
      responseStatus: null,
      responseError: null,
      durationMs: null,
      claimedAt: null,
      claimedBy: null,
      createdAt: now(),
    };
    this.byId.set(rec.id, rec);
    return { ...rec };
  }
  async findById(deliveryId: string): Promise<WebhookDeliveryRecord | null> {
    const rec = this.byId.get(deliveryId);
    return rec ? { ...rec } : null;
  }
  /** Newest event first. Ordered by `eventSeq`, not `createdAt`: a fan-out writes every row in the same millisecond. */
  async listByEndpoint(endpointId: string, limit: number): Promise<WebhookDeliveryRecord[]> {
    return [...this.byId.values()]
      .filter((d) => d.endpointId === endpointId)
      .sort((a, b) => b.eventSeq - a.eventSeq)
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }
  async listDue(at: string, limit: number): Promise<WebhookDeliveryRecord[]> {
    // Compare parsed INSTANTS, not strings: prisma compares Dates, so an ISO
    // string carrying an offset (…+05:30) rather than Z would order one way here
    // and the other way there — a divergence no memory-harness test can see.
    const cutoff = Date.parse(at);
    return [...this.byId.values()]
      .filter((d) => (d.status === "pending" || d.status === "failed") && Date.parse(d.nextAttemptAt) <= cutoff)
      .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt) || a.eventSeq - b.eventSeq)
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }
  // claim/reclaimStale are each a single synchronous mutation (no await between
  // the status check and the write) → atomic w.r.t. concurrent requests, as
  // MemoryProposalRepository.claimDecided already relies on.
  async claim(deliveryId: string, workerId: string, at: string): Promise<WebhookDeliveryRecord | null> {
    const rec = this.byId.get(deliveryId);
    // The status predicate IS the compare half of the compare-and-set: drop it
    // and two dispatchers both "win" the same row and double-POST it.
    if (!rec || (rec.status !== "pending" && rec.status !== "failed")) return null;
    rec.status = "inflight";
    rec.claimedAt = at;
    rec.claimedBy = workerId;
    return { ...rec };
  }
  async reclaimStale(before: string): Promise<number> {
    const cutoff = Date.parse(before);
    let count = 0;
    for (const rec of this.byId.values()) {
      if (rec.status !== "inflight" || rec.claimedAt === null || !(Date.parse(rec.claimedAt) < cutoff)) continue;
      rec.status = "pending";
      rec.claimedAt = null;
      rec.claimedBy = null;
      count += 1;
    }
    return count;
  }
  async requeue(deliveryId: string, at: string): Promise<WebhookDeliveryRecord | null> {
    const rec = this.byId.get(deliveryId);
    // The `!== "inflight"` predicate is the compare half, and it must sit HERE
    // rather than in the caller: a claim landing between a caller's read and its
    // write would be reset mid-POST.
    if (!rec || rec.status === "inflight") return null;
    rec.status = "pending";
    rec.attempts = 0;
    rec.nextAttemptAt = at;
    rec.claimedAt = null;
    rec.claimedBy = null;
    return { ...rec };
  }
  async update(deliveryId: string, patch: Partial<Pick<WebhookDeliveryRecord, "status" | "attempts" | "nextAttemptAt" | "lastAttemptAt" | "responseStatus" | "responseError" | "durationMs" | "claimedAt" | "claimedBy">>): Promise<WebhookDeliveryRecord> {
    const rec = this.byId.get(deliveryId);
    if (!rec) throw new Error(`unknown webhook delivery '${deliveryId}'`);
    // Same present-vs-undefined discipline as the endpoint patch above.
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) Object.assign(rec, { [k]: v });
    }
    return { ...rec };
  }
}
