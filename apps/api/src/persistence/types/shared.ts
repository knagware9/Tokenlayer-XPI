/**
 * SHARED PERSISTENCE CONTRACTS — the tables both products need.
 *
 * Split by `model-domains.ts`, which is the declared owner of every table and
 * the same map the repository seam enforces at runtime. This file is not
 * "everything else": a table is shared when BOTH products genuinely need it —
 * users, organizations, approvals, audit, events, API keys.
 */
import type { Role, OrgType, OrgCapabilities, ResourceMode, LifecycleAction } from "@tokenlayer/core";

export type { OrgType };

export type KycStatus = "pending" | "approved" | "rejected";
export interface KycDetails {
  legalName?: string;
  country?: string;
  idType?: string;
  idNumber?: string;
  documentRef?: string;
  issuerDid?: string;
  credentialId?: string;
  verifiedAt?: string;
  revokedAt?: string;
  revokeReason?: string;
}

/**
 * "service" marks the machine principal an API key authenticates as (EN-B): no
 * usable password, refused by interactive login. Defaults to "human" on create,
 * so every pre-EN-B caller and row stays human without a migration.
 */
export type UserKind = "human" | "service";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  useCaseKey: string | null;
  accountId: string | null;
  active: boolean;
  kycStatus: KycStatus;
  kyc: KycDetails | null;
  did?: string;
  orgId?: string | null;
  didSeedEncrypted?: string | null;
  kind: UserKind;
  createdAt: string;
}

export interface AuditEntryRecord {
  id: string;
  assetId?: string;
  actorId: string;
  action: LifecycleAction;
  payload: Record<string, unknown>;
  txHash?: string;
  chainId?: string;
  createdAt: string;
  seq?: number;
  prevHash?: string;
  hash?: string;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** `kind` is optional and defaults to "human" — mirrors the column default. */
  create(input: Omit<UserRecord, "id" | "createdAt" | "kind"> & { kind?: UserKind }): Promise<UserRecord>;
  list(useCaseKey?: string): Promise<UserRecord[]>;
  listByOrg(orgId: string): Promise<UserRecord[]>;
  update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus" | "did" | "kyc" | "orgId" | "didSeedEncrypted">>): Promise<UserRecord>;
  remove(id: string): Promise<void>;
}

/** A page of results plus the total count of matching rows (for pagination). */
export interface Paged<T> {
  items: T[];
  total: number;
}

export interface Page {
  limit?: number;
  offset?: number;
}

export interface AuditRepository {
  append(entry: Omit<AuditEntryRecord, "id" | "createdAt"> & { createdAt?: string }): Promise<AuditEntryRecord>;
  listByAsset(assetId: string, page?: Page): Promise<Paged<AuditEntryRecord>>;
  /** Cross-asset audit query: entries for any of `assetIds`, ordered createdAt ascending (oldest→newest). Empty ids → empty result. */
  listByAssetIds(assetIds: string[], page?: Page): Promise<Paged<AuditEntryRecord>>;
}

export interface AuditAnchorRecord {
  id: string;
  assetId: string;
  seq: number;
  hash: string;
  txHash: string;
  chainId: string;
  createdAt: string;
}

export interface AuditAnchorRepository {
  create(input: Omit<AuditAnchorRecord, "id" | "createdAt">): Promise<AuditAnchorRecord>;
  /**
   * The most recent anchor (highest seq; oldest first at equal seq), or null.
   *
   * The tie-break is load-bearing, not tidiness. An asset can hold SEVERAL
   * anchors at one seq, and taking "whichever row the database returned first"
   * meant a later anchor could displace the original attestation — so a rewrite
   * plus a re-anchor could read as consistent. Oldest-wins makes the FIRST
   * attestation the one that speaks, and no later write can unseat it.
   */
  latest(assetId: string): Promise<AuditAnchorRecord | null>;
  /**
   * EVERY anchor for the asset. Verification checks all of them: a chain is
   * only consistent if it still agrees with every attestation ever made about
   * it, not merely the newest one.
   */
  list(assetId: string): Promise<AuditAnchorRecord[]>;
}

/** A writable use-case store. Also satisfies the engine's UseCaseSource. */
export type DocumentPurpose = "brand-logo";

/** An uploaded document (bytes + content-type), referenced from asset metadata. */
export interface DocumentRecord {
  id: string;
  contentType: string;
  sha256: string;
  size: number;
  bytes: Buffer;
  createdAt: string;
  /**
   * The organization these bytes belong to, or null when nobody owns them (a
   * platform upload, a pre-org KYB registration, a pre-column row). NULL IS NOT
   * "SHARED": every gate requires a non-null match, so a null-owned document is
   * referenceable by a PlatformAdmin and by no one else.
   */
  ownerOrgId: string | null;
  /**
   * What the upload was for, or null for an ordinary document. Only
   * `POST /orgs/{id}/branding/logo` writes a non-null value today.
   */
  purpose: DocumentPurpose | null;
}

/**
 * A document row WITHOUT its bytes. The prune decides what to delete from this
 * shape alone — loading 5MB buffers to compare ids would be absurd.
 */
export interface DocumentSummary {
  id: string;
  size: number;
  createdAt: string;
}

export interface DocumentRepository {
  /** `ownerOrgId` and `purpose` are both REQUIRED, not optional: an upload site
   *  that forgets who owns the bytes writes a document nobody can later be
   *  refused access to on ownership grounds, and one that forgets the purpose
   *  writes a mark the prune cannot see. An optional parameter is how both get
   *  forgotten. */
  create(input: { contentType: string; bytes: Buffer; ownerOrgId: string | null; purpose: DocumentPurpose | null }): Promise<{ id: string; sha256: string; size: number }>;
  get(id: string): Promise<DocumentRecord | null>;
  /** Every document this org owns with this purpose, WITHOUT bytes. OLDEST
   *  FIRST (`createdAt` ascending) — the memory repository's Map insertion
   *  order and Prisma's unordered query would otherwise agree by accident. */
  listByOwnerPurpose(ownerOrgId: string, purpose: DocumentPurpose): Promise<DocumentSummary[]>;
  /** Delete one document, but ONLY if it matches this owner and purpose.
   *  IDEMPOTENT — a row that is absent, or that belongs to another org, or that
   *  was uploaded for something else, is silently not deleted rather than an
   *  error. The narrow signature is the point: this is the only delete path on
   *  `Document`, and it structurally cannot reach a KYB certificate or an
   *  invoice PDF even if a caller passes the wrong id. */
  removeByOwnerPurpose(id: string, ownerOrgId: string, purpose: DocumentPurpose): Promise<void>;
}

/**
 * A materialized financial-terms cashflow (coupon or redemption) for one asset.
 * Only "scheduled"/"executing"/"executed" are persisted — "due"/"overdue" are
 * derived from the due date at read time (no background scheduler). "executing"
 * is the execute route's atomic claim: it excludes concurrent double-payment.
 */
export interface ProposalApproval {
  userId: string;
  email: string;
  at: string;
}

/**
 * A maker-checker proposal: a gated operation captured for approval. When the
 * approval count reaches `required`, the operation executes (as the proposer's
 * identity) and the proposal becomes "executed" or "failed".
 */
export interface ProposalRecord {
  id: string;
  /** null for non-token (e.g. credential) proposals. */
  useCaseKey: string | null;
  /** Set for org-scoped kinds; null for token kinds. */
  orgId: string | null;
  assetId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  proposerId: string;
  proposerLabel: string;
  required: number;
  approvals: ProposalApproval[];
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  error: string | null;
  /** Optional executor report (e.g. a CSV batch's per-row outcomes), set after execution. */
  result: Record<string, unknown> | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ProposalRepository {
  create(input: Omit<ProposalRecord, "id" | "approvals" | "status" | "error" | "result" | "createdAt" | "decidedAt">): Promise<ProposalRecord>;
  get(id: string): Promise<ProposalRecord | null>;
  /** Newest first, optionally scoped by use case and/or status. */
  list(useCaseKey?: string, status?: string): Promise<ProposalRecord[]>;
  /** Newest first, scoped to one org, optionally by status. */
  listByOrg(orgId: string, status?: string): Promise<ProposalRecord[]>;
  /** Append an approval; throws { code: "ALREADY_APPROVED" } if this userId already approved. */
  addApproval(id: string, approval: ProposalApproval): Promise<ProposalRecord>;
  /** Atomic CAS "pending"→`target` (approved | rejected). True iff this caller won the transition. */
  claimDecided(id: string, target: ProposalRecord["status"]): Promise<boolean>;
  /** Set a terminal status (+error, +decidedAt for terminal states). */
  setStatus(id: string, status: ProposalRecord["status"], error?: string | null): Promise<ProposalRecord>;
  /** Record an executor report on the proposal (e.g. a CSV batch's per-row outcomes). */
  setResult(id: string, result: Record<string, unknown>): Promise<ProposalRecord>;
}

export type OrgStatus = "pending" | "active" | "suspended" | "rejected";

/** Legal structure of an Indian company — the KYB "category". */
export type CompanyCategory = "private-limited" | "public-limited" | "llp" | "opc" | "section-8";

/** A stored KYB document reference — sha256 comes from the SERVER's document record. */
export interface KybDocumentRef {
  id: string;
  sha256: string;
}

/**
 * India-specific KYB details captured at corporate self-registration and shown to
 * the Platform Admin at approval. Statutory identifiers (CIN/PAN/GSTIN) are stored
 * as reference numbers plus REFERENCES to uploaded certificates in the document
 * store (id + sha256) — the file bytes themselves live in the store, gated behind
 * the authenticated document read route.
 */
export interface CompanyProfile {
  cin: string;
  pan: string;
  gstin: string | null;
  state: string;
  pincode: string;
  dateOfIncorporation: string; // ISO calendar date, yyyy-mm-dd
  category: CompanyCategory;
  companyStatus: "active" | "inactive";
  /** Statutory certificates uploaded at registration. CIN required, GSTIN optional. */
  documents: {
    cinCertificate: KybDocumentRef;
    gstinCertificate: KybDocumentRef | null;
  };
}

export interface OrganizationRecord {
  id: string;
  name: string;
  orgType: OrgType;
  registrationId: string | null;
  jurisdiction: string | null;
  did: string;
  didSeedEncrypted: string;
  status: OrgStatus;
  verified: boolean;
  verifiedAt: string | null;
  /** Present for self-registered corporates; null for platform-created orgs. */
  companyProfile: CompanyProfile | null;
  /** EN-A capability envelope; null = unrestricted legacy (predates EN-A or path didn't choose). */
  capabilities: OrgCapabilities | null;
  /** EN-E: an image Document id used as this org's mark. null = unbranded. */
  brandLogoDocumentId: string | null;
  /** EN-E: lowercase #rrggbb accent. null = the platform palette. */
  brandAccent: string | null;
  createdAt: string;
}

/**
 * A partial update of the two branding columns. Optional-and-nullable is
 * deliberate: an OMITTED key means "leave this alone", an explicit null means
 * "clear this". "Change my colour but keep my logo" needs both to be sayable.
 */
export interface BrandingPatch {
  brandLogoDocumentId?: string | null;
  brandAccent?: string | null;
}

export interface OrganizationRepository {
  create(input: Omit<OrganizationRecord, "id" | "createdAt">): Promise<OrganizationRecord>;
  get(id: string): Promise<OrganizationRecord | null>;
  findByName(name: string): Promise<OrganizationRecord | null>;
  /** The org whose parent DID is `did` — the issuer of a credential signed by it. */
  findByDid(did: string): Promise<OrganizationRecord | null>;
  findByRegistrationId(registrationId: string): Promise<OrganizationRecord | null>;
  list(): Promise<OrganizationRecord[]>;
  setVerified(id: string, verified: boolean, verifiedAt: string | null): Promise<OrganizationRecord>;
  setStatus(id: string, status: OrgStatus): Promise<OrganizationRecord>;
  setCapabilities(id: string, caps: OrgCapabilities | null): Promise<OrganizationRecord>;
  /** Patch branding. An OMITTED key is left alone; an explicit null clears it. */
  setBranding(orgId: string, patch: BrandingPatch): Promise<OrganizationRecord>;
  remove(id: string): Promise<void>;
}

export interface CredentialRecord {
  id: string;
  holderDid: string;
  issuerDid: string;
  type: string;
  vcJwt: string;
  subjectClaims: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
  revokedReason: string | null;
  revokedBy: string | null;
  proposalId: string | null;
  credentialUseCaseKey: string | null;
  /** Holder acceptance lifecycle (ID-L). Non-use-case issuance and use cases
   *  without `holderAcceptance` are born "accepted" (back-compat default). */
  acceptance: "accepted" | "pending" | "rejected" | "changes_requested";
  acceptanceAt: string | null;
  acceptanceNote: string | null;
  /** Receipt of the on-chain anchor write at issuance (null: no registry / pre-ID-O). */
  anchorTxHash: string | null;
  anchorChainId: string | null;
  /** Receipt of the on-chain revoke write (null until revoked on-chain). */
  revokeTxHash: string | null;
}

export interface CredentialRepository {
  /** `id` is supplied by the caller: the VC embeds it in `jti` + credentialStatus before signing. */
  create(input: CredentialRecord): Promise<CredentialRecord>;
  listByHolder(holderDid: string): Promise<CredentialRecord[]>;
  listByIssuer(issuerDid: string): Promise<CredentialRecord[]>;
  /** Every stored credential, unordered — dashboard aggregation input (callers sort/filter). */
  list(): Promise<CredentialRecord[]>;
  get(id: string): Promise<CredentialRecord | null>;
  setRevoked(id: string, revoked: boolean): Promise<CredentialRecord>;
  revoke(id: string, input: { reason: string; by: string; at: string; txHash?: string | null }): Promise<CredentialRecord>;
  setAcceptance(id: string, patch: { acceptance: CredentialRecord["acceptance"]; at: string; note: string | null }): Promise<CredentialRecord>;
}

export interface RegistryDeploymentRecord {
  chainId: string;
  didRegistry: string;
  vcRegistry: string;
  deployTxHash: string;
  createdAt: string;
}

export interface RegistryDeploymentRepository {
  get(chainId: string): Promise<RegistryDeploymentRecord | null>;
  create(input: Omit<RegistryDeploymentRecord, "createdAt">): Promise<RegistryDeploymentRecord>;
}

export interface LoginKeyRecord {
  id: string;
  userId: string;
  did: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface LoginKeyRepository {
  create(input: Omit<LoginKeyRecord, "id" | "createdAt" | "lastUsedAt">): Promise<LoginKeyRecord>;
  listByUser(userId: string): Promise<LoginKeyRecord[]>;
  getByDid(did: string): Promise<LoginKeyRecord | null>;
  get(id: string): Promise<LoginKeyRecord | null>;
  remove(id: string): Promise<void>;
  touch(id: string, at: string): Promise<void>;
}

/**
 * An org-scoped machine credential (EN-B), bound to a service user — the
 * principal the key becomes. The secret itself is NEVER stored: only its bcrypt
 * hash plus the public `prefix` used to find the row before hashing.
 */
export interface ApiKeyRecord {
  id: string;
  /** Owning org; null = platform-owned key (PlatformAdmin-minted). */
  orgId: string | null;
  /** The bound service user whose role/useCaseKey/orgId this key authenticates as. */
  userId: string;
  name: string;
  /** First 8 chars of the secret body — safe to display and index. */
  prefix: string;
  secretHash: string;
  /** Coarse scopes from core's API_SCOPES vocabulary; persisted as a JSON string. */
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  createdBy: string;
  createdAt: string;
  /**
   * EN-D2. `"test"` = a `tl_test_` key, which may act only on sandbox use cases;
   * `"live"` = the ordinary key. Always concrete on a record — an omitted `mode`
   * on create becomes `"live"`, matching the DB default that leaves every key
   * minted before EN-D2 a live key. NEVER mutated after create: rotating or
   * revoking a key cannot move it between the two worlds.
   */
  mode: ResourceMode;
}

/**
 * Lifecycle columns (`lastUsedAt`/`revokedAt`/`revokedBy`) are repo-managed and start null.
 * `mode` is optional and defaults to `"live"` — the zero-migration default. Named
 * so the interface and BOTH implementations share one definition: a per-class
 * restatement is how a signature silently drifts (and test files are not
 * typechecked here, so nothing else would notice).
 */
export type ApiKeyCreateInput = Omit<ApiKeyRecord, "id" | "createdAt" | "lastUsedAt" | "revokedAt" | "revokedBy" | "mode"> & { mode?: ResourceMode };

export interface ApiKeyRepository {
  create(input: ApiKeyCreateInput): Promise<ApiKeyRecord>;
  /** The single indexed lookup the auth path does before any hash work. */
  findByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  findById(id: string): Promise<ApiKeyRecord | null>;
  /**
   * Every key of the org, newest first — INCLUDING revoked and expired ones:
   * they are the audit trail of what was ever granted, so nothing is filtered.
   *
   * `null` lists PLATFORM-owned keys (the `orgId: null` rows). Without this the
   * null-org affordance would be write-only — a key nothing could ever
   * enumerate, which is a worse thing to own than no affordance at all. The
   * HTTP surface never mints one (a PlatformAdmin uses the platform org's real
   * id), so this is the seed/operator path.
   */
  listByOrg(orgId: string | null): Promise<ApiKeyRecord[]>;
  /**
   * Replace the secret in place: same row, same id/scopes/bound user, new
   * `prefix` + `secretHash`. The old secret dies the instant this returns.
   */
  rotate(id: string, input: { prefix: string; secretHash: string }): Promise<ApiKeyRecord>;
  /** Last-use stamp; callers throttle the write (see the design's compare-then-write). */
  touchLastUsed(id: string, at: string): Promise<void>;
  /** Soft revoke: sets `revokedAt`/`revokedBy`, keeping the row for the audit trail. */
  revoke(id: string, input: { by: string; at: string }): Promise<ApiKeyRecord>;
}

/**
 * One durable, globally ordered fact (EN-C). Deliberately NOT an AuditEntry:
 * the audit log is per-asset hash-chained for tamper evidence and has no global
 * cursor, and delivery concerns must not get a say in that structure.
 */
export interface EventRecord {
  /** Global monotonic cursor. */
  seq: number;
  /** Public, stable id sent to integrators as Tokenlayer-Event-Id. */
  id: string;
  type: string;
  /** The single owning org — the tenancy key. null = platform-scope. */
  orgId: string | null;
  useCaseKey: string | null;
  subjectId: string | null;
  data: Record<string, unknown>;
  occurredAt: string;
  /**
   * EN-D2. The mode of the use case this fact came from, denormalised onto the
   * row so the stream can be filtered without a join (D2-5 does the filtering).
   * `"live"` for everything emitted before EN-D2, via the DB default.
   */
  mode: ResourceMode;
}

/** `mode` is optional and defaults to `"live"` — the zero-migration default. */
export type EventAppendInput = Omit<EventRecord, "seq" | "id" | "occurredAt" | "mode"> & { occurredAt?: string; mode?: ResourceMode };

export interface EventRepository {
  append(input: EventAppendInput): Promise<EventRecord>;
  /**
   * Cursor read, seq-ascending. `orgId: undefined` = every org (PlatformAdmin).
   *
   * `mode: undefined` = BOTH environments, which is what a human session reads;
   * an API key narrows to its own. Filtering here rather than in the route is
   * what keeps the documented cursor contract true — a post-fetch filter would
   * return short (or empty) pages while rows remained, and `nextAfter` would
   * have to be computed from rows the caller never saw.
   */
  listAfter(after: number, opts: { orgId?: string | null; type?: string; mode?: ResourceMode; limit: number }): Promise<EventRecord[]>;
  findById(id: string): Promise<EventRecord | null>;
}

/** An org's declared interest in some slice of the event stream. */
export interface WebhookEndpointRecord {
  id: string;
  orgId: string | null;
  url: string;
  description: string | null;
  eventTypes: string[];
  useCaseKey: string | null;
  /** AES-256-GCM ciphertext. NEVER returned by any read route. */
  secretEncrypted: string;
  status: "active" | "disabled";
  disabledReason: string | null;
  disabledAt: string | null;
  /**
   * Consecutive failures where THE ENDPOINT ITSELF answered badly (non-2xx) or
   * could not be reached. Only this counter can auto-disable, because only this
   * counter is evidence about the integrator's server.
   */
  consecutiveFailures: number;
  /**
   * Consecutive failures where OUR URL GUARD refused to send — DNS did not
   * resolve, or resolved somewhere not publicly routable. Counted separately and
   * acted on by nobody: see the auto-disable note in dispatcher.ts. A high value
   * here is a signal to surface to an operator, not a reason to switch an org's
   * endpoint off, because its cause lies outside our trust boundary.
   */
  consecutiveGuardFailures: number;
  /**
   * When the CURRENT run of endpoint failures began; null whenever the endpoint
   * is healthy. This is the clock the auto-disable time floor reads, and the
   * reason a burst of failures in one dispatch pass cannot disable anything.
   */
  failingSince: string | null;
  deletedAt: string | null;
  createdBy: string;
  createdAt: string;
  lastDeliveryAt: string | null;
  /**
   * EN-D2. Which stream this endpoint subscribes to: a `"test"` endpoint hears
   * only sandbox events and a `"live"` one only real ones. `"live"` for every
   * endpoint registered before EN-D2, via the DB default. Deliberately ABSENT
   * from `update`'s patch — an endpoint cannot be moved between streams, because
   * the secret and delivery history would follow it across the boundary.
   */
  mode: ResourceMode;
}

/**
 * Lifecycle columns (`status`/`disabled*`/`consecutive*Failures`/`failingSince`/`deletedAt`/`lastDeliveryAt`) are repo-managed.
 * `mode` is optional and defaults to `"live"` — the zero-migration default.
 */
export type WebhookEndpointCreateInput = Omit<WebhookEndpointRecord, "id" | "createdAt" | "status" | "disabledReason" | "disabledAt" | "consecutiveFailures" | "consecutiveGuardFailures" | "failingSince" | "deletedAt" | "lastDeliveryAt" | "mode"> & { mode?: ResourceMode };

export interface WebhookEndpointRepository {
  create(input: WebhookEndpointCreateInput): Promise<WebhookEndpointRecord>;
  findById(id: string): Promise<WebhookEndpointRecord | null>;
  /** Live endpoints of one org. `null` lists platform-scope endpoints. */
  listByOrg(orgId: string | null): Promise<WebhookEndpointRecord[]>;
  /** Every active, non-deleted endpoint — the fan-out candidate set. */
  listActive(): Promise<WebhookEndpointRecord[]>;
  update(id: string, patch: Partial<Pick<WebhookEndpointRecord, "url" | "description" | "eventTypes" | "useCaseKey" | "secretEncrypted" | "status" | "disabledReason" | "disabledAt" | "consecutiveFailures" | "consecutiveGuardFailures" | "failingSince" | "deletedAt" | "lastDeliveryAt">>): Promise<WebhookEndpointRecord>;
}

/** One attempt chain for one (event, endpoint) pair. */
export interface WebhookDeliveryRecord {
  id: string;
  endpointId: string;
  eventId: string;
  eventSeq: number;
  status: "pending" | "inflight" | "delivered" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  responseError: string | null;
  durationMs: number | null;
  claimedAt: string | null;
  claimedBy: string | null;
  createdAt: string;
}

export interface WebhookDeliveryRepository {
  /** Idempotent on (endpointId, eventId): a duplicate returns the existing row. */
  enqueue(input: { endpointId: string; eventId: string; eventSeq: number }): Promise<WebhookDeliveryRecord>;
  findById(id: string): Promise<WebhookDeliveryRecord | null>;
  listByEndpoint(endpointId: string, limit: number): Promise<WebhookDeliveryRecord[]>;
  /** Due = (pending|failed) and nextAttemptAt <= now, oldest first. */
  listDue(now: string, limit: number): Promise<WebhookDeliveryRecord[]>;
  /**
   * CAS claim: pending|failed -> inflight, ONLY if still unclaimed. Returns the
   * claimed row or null if another instance won. Mirrors ProposalRepository's
   * claimDecided — this is what makes two dispatchers safe.
   */
  claim(id: string, workerId: string, now: string): Promise<WebhookDeliveryRecord | null>;
  /** Rows stuck inflight since before `before` — crash recovery. */
  reclaimStale(before: string): Promise<number>;
  /**
   * CAS re-queue for an operator replay: any status EXCEPT `inflight` ->
   * `pending`, attempts back to 0, due now. Returns null when the row was
   * already claimed, which the route turns into a 409.
   *
   * The predicate has to live in the write, not in a prior read. Replay used to
   * read the row, check `status !== "inflight"`, and then issue a plain update:
   * a dispatcher claiming in that gap had its claim silently reset while it was
   * mid-POST, so the row could be claimed and sent a second time and the
   * settle that followed clobbered the replay. Same compare-and-set discipline
   * as `claim` — the two are the only writers that contend for this column.
   */
  requeue(id: string, at: string): Promise<WebhookDeliveryRecord | null>;
  update(id: string, patch: Partial<Pick<WebhookDeliveryRecord, "status" | "attempts" | "nextAttemptAt" | "lastAttemptAt" | "responseStatus" | "responseError" | "durationMs" | "claimedAt" | "claimedBy">>): Promise<WebhookDeliveryRecord>;
}

export type LedgerTxStatus = "pending" | "confirmed" | "failed" | "unknown";
export type LedgerTxKind = "deploy" | "mint" | "transfer" | "burn" | "freeze" | "unfreeze" | "allow" | "anchor";

export interface LedgerTransactionRecord {
  id: string;
  chainId: string;
  txHash: string;
  kind: LedgerTxKind;
  amount: string | null;
  assetId: string | null;
  credentialId: string | null;
  status: LedgerTxStatus;
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  claimedAt: string | null;
  claimedBy: string | null;
  blockNumber: number | null;
  error: string | null;
  submittedAt: string;
  confirmedAt: string | null;
}

export interface LedgerTransactionSettlement {
  status: LedgerTxStatus;
  blockNumber?: number;
  confirmedAt?: string;
  error?: string;
}

export interface LedgerTransactionRepository {
  /** Idempotent on (chainId, txHash): re-recording the same submission returns the existing row. */
  record(input: {
    chainId: string; txHash: string; kind: LedgerTxKind; amount?: string | null;
    assetId?: string | null; credentialId?: string | null; submittedAt: string;
  }): Promise<LedgerTransactionRecord>;
  findById(id: string): Promise<LedgerTransactionRecord | null>;
  /** Confirmed mints minus confirmed burns for one asset — the believed supply. */
  settledSupply(assetId: string): Promise<string>;
  /** Due = (pending|unknown) and nextAttemptAt <= now, oldest first. */
  listDue(now: string, limit: number): Promise<LedgerTransactionRecord[]>;
  /** CAS claim, mirroring WebhookDeliveryRepository.claim — null if another worker won. */
  claim(id: string, workerId: string, now: string): Promise<LedgerTransactionRecord | null>;
  /** Claims left behind by a crashed worker. Returns how many were released. */
  reclaimStale(before: string): Promise<number>;
  /** Outstanding (pending|unknown) rows for one asset, oldest first. */
  listByAsset(assetId: string): Promise<LedgerTransactionRecord[]>;
  settle(id: string, settlement: LedgerTransactionSettlement): Promise<LedgerTransactionRecord>;
  /** Records one more failed poll and backs off. */
  defer(id: string, nextAttemptAt: string, now: string, error?: string): Promise<LedgerTransactionRecord>;
}

