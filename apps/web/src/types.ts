import type { ResourceMode } from "./lib/modes.js";

export type Role = "PlatformAdmin" | "OrgAdmin" | "UseCaseAdmin" | "Issuer" | "Trader" | "Buyer" | "Auditor" | "Holder" | "Verifier";

// ---- EN-A: organization capability envelope --------------------------------
// Mirrors @tokenlayer/core's org-capabilities. `null` anywhere an envelope is
// expected means the UNRESTRICTED LEGACY envelope (org predates EN-A) — render
// it as "unrestricted (legacy)", never as "no capabilities". An explicit
// envelope with empty arrays is fully restrictive: [] ≠ null.
export const ORG_DOMAINS = ["tokenization", "identity"] as const;
export type OrgDomain = (typeof ORG_DOMAINS)[number];
export const ORG_OPERATING_ROLES = ["Issuer", "Holder", "Verifier"] as const;
export type OrgOperatingRole = (typeof ORG_OPERATING_ROLES)[number];

export interface OrgCapabilities {
  domains: OrgDomain[];
  roles: OrgOperatingRole[];
}

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  useCaseKey: string | null;
  walletAddress?: string | null;
  orgId?: string | null;
  did?: string | null;
  useCaseDomain?: "tokenization" | "identity" | null;
  /** The signed-in user's org envelope; null (or absent) = unrestricted legacy. */
  orgCapabilities?: OrgCapabilities | null;
  /** EN-E: the org's mark and accent, from `GET /me`. ABSENT and `null` differ
   * here — `POST /auth/login` does not carry either field, so `undefined` means
   * "not yet fetched" and `null` means "fetched, and this org is unbranded".
   * `AppShell` reads exactly that distinction to decide whether to refresh. */
  brandLogoDocumentId?: string | null;
  brandAccent?: string | null;
}

/**
 * Exactly what `GET /me` returns — a STRICT SUBSET of SessionUser: no email,
 * no orgId, no did, no walletAddress. Refreshing a session must therefore MERGE
 * this over the stored user, never replace it.
 */
export interface SessionPrincipal {
  id: string;
  role: Role;
  useCaseKey: string | null;
  useCaseDomain?: "tokenization" | "identity" | null;
  orgCapabilities?: OrgCapabilities | null;
  brandLogoDocumentId?: string | null;
  brandAccent?: string | null;
}

export type TokenStandard = "ERC-20" | "ERC-721" | "ERC-3643";
export type ChainFamily = "evm" | "fabric" | "canton" | "mock";

export interface ChainInfo {
  id: string;
  label: string;
  family: ChainFamily;
  kind: "simulated" | "evm";
  mode: "real" | "simulated";
  /** false = a supported DLT from the catalog that is not currently connected. It can
   * be selected as an allowed chain when configuring a use case, but no assets can be
   * issued on it until it is brought online. Absent/undefined is treated as available. */
  available?: boolean;
  /** EVM chains: RPC + operator key env present. Absent chains are configured:false. */
  configured?: boolean;
  /** EVM chains: the numeric chain id the RPC must report (e.g. 91562037 for MST Testnet). */
  expectedChainId?: number;
  faucetUrl?: string;
  explorerUrl?: string;
  currencySymbol?: string;
  /** Hostname of the configured RPC endpoint — never the full URL (hosted RPCs can embed keys). */
  rpcHost?: string;
}

/** Result of GET /chains/:id/status — an on-demand connectivity probe. */
export interface ChainStatus {
  id: string;
  reachable: boolean;
  mode: "real" | "simulated";
  /** The numeric chain id the RPC reports (EVM), as a string. */
  chainId?: string;
  operator?: string;
  balance?: string;
  /** Failure detail — sanitised server-side (never contains the RPC URL). */
  error?: string;
}

/** The contract code that backs a use case on one chain (GET /use-cases/:key/code, POST /use-cases/preview-code). */
export interface ContractCode {
  chainId: string;
  family: ChainFamily;
  mode: "real" | "simulated";
  language: string;
  filename: string;
  source: string;
  constructorArgs: { name: string; value: string }[];
  deployed?: { contractRef: string; deployTxHash: string };
}

export interface PropertySchema {
  type: "string" | "number" | "boolean" | "document";
  description?: string;
  enum?: string[];
  min?: number;
  max?: number;
  pattern?: string;
}

export interface MetadataSchema {
  type: "object";
  properties: Record<string, PropertySchema>;
  required?: string[];
}

export interface UseCaseContract {
  contractRef: string;
  deployTxHash: string;
}

export interface UseCase {
  key: string;
  name: string;
  description?: string;
  tokenStandard: TokenStandard;
  tokenType: "fungible" | "nonfungible";
  symbol: string;
  allowedChainIds: string[];
  defaultChainId: string;
  /** Deployed contract per chainId; a chain is deployed iff it has an entry. */
  contracts?: Record<string, UseCaseContract>;
  metadataSchema: MetadataSchema;
  lifecycle: { mint: boolean; transfer: boolean; burn: boolean; freeze: boolean };
  compliance: {
    allowlist: boolean;
    transferRestrictions: boolean;
    maxHolders?: number;
    lockupDays?: number;
    allowedJurisdictions?: string[];
    /** When true, a buy/mint/transfer to a wallet is refused unless its user
     * holds a valid, unrevoked KYC credential (DID/VC identity gate). */
    requireVerifiedIdentity?: boolean;
  };
  fees?: { marketplaceBps?: number; issuanceFlat?: string };
  saleTermsDefault?: { unitPrice?: string; currency?: string };
  /** How analytics values tokens with no unitPrice (e.g. invoice face value). */
  valuation?: { metadataField: string; currency: string };
  /** Metadata fields the platform derives on issue (client value ignored). */
  derivedFields?: Record<string, string>;
  /** A metadata field whose value must be unique across the use case's assets. */
  uniqueBy?: string;
  /** Financial terms template driving the cashflow schedule. */
  terms?: { principalField: string; maturityField: string; rateField?: string; frequency?: string; currency: string };
  /** Maker-checker policy: gated op → required approvals. */
  workflow?: { approvals?: Record<string, number> };
  roles: Role[];
  /** The organization that owns this use case. */
  ownerOrgId?: string | null;
  /**
   * EN-D2 test mode. A sandbox use case runs ONLY on the always-simulated
   * `sandbox` chain, is invisible to a `tl_live_` key, and is left out of
   * analytics and the invoice register unless asked for by name.
   *
   * OPTIONAL, and absent means LIVE: it is a column with a DB default, so it is
   * missing from every row that predates EN-D2 — read it through `modeOf`
   * (src/lib/modes.ts) rather than by hand. It is set at CREATION and never
   * after (409 SANDBOX_IMMUTABLE); the supported way to a live copy is
   * `POST /use-cases/:key/clone-to-live`.
   */
  sandbox?: boolean;
}

export interface Asset {
  id: string;
  useCaseKey: string;
  name: string;
  symbol: string;
  chainId: string;
  contractRef: string;
  tokenType: "fungible" | "nonfungible";
  tokenStandard: TokenStandard;
  metadata: Record<string, unknown>;
  status: string;
  createdBy: string;
  createdAt: string;
  totalSupply?: string | null;
  availableSupply?: string | null;
  unitPrice?: string | null;
  currency?: string | null;
  treasuryAccount?: string | null;
}

export interface TokenInfo {
  tokenId: string;
  owner: string;
  ownerLabel: string;
  frozen: boolean;
}

export interface AccountState {
  address: string;
  label: string;
  balance: string;
  frozen: boolean;
  allowed: boolean;
}

export interface Listing {
  id: string;
  /** Present on create/take responses; the asset-scoped list omits it. */
  assetId?: string;
  seller: string;
  /** REMAINING quantity on the listing. */
  quantity: string;
  unitPrice: string;
  currency: string;
  status?: "open" | "filled" | "cancelled";
  createdAt: string;
  updatedAt?: string;
}

export interface Cashflow {
  id: string;
  assetId: string;
  seq: number;
  kind: "coupon" | "redemption";
  dueDate: string;
  amount: string;
  currency: string;
  status: "scheduled" | "due" | "overdue" | "executing" | "executed";
  executedAt: string | null;
}

export interface CashflowPreview {
  cashflowId: string;
  split: { address: string; amount: string }[];
}

export interface Trade {
  at: string;
  amount: string | null;
  unitPrice: string | null;
  currency: string | null;
  from: string | null;
  to: string | null;
  secondary: boolean;
}

export interface ProposalApproval {
  userId: string;
  email: string;
  at: string;
}

/** A maker-checker proposal: a gated operation captured pending approval. */
export interface Proposal {
  id: string;
  /** null for org-scoped proposals (e.g. credential issuance/revocation). */
  useCaseKey: string | null;
  /** Set on org-scoped proposals; absent/null on use-case proposals. */
  orgId?: string | null;
  assetId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  proposerId: string;
  proposerLabel: string;
  required: number;
  approvals: ProposalApproval[];
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** Set on executed batch proposals (onboard-user-batch, issue-usecase-credential-batch): the per-row report. */
  result?: BatchReport | Record<string, unknown> | null;
}

/** Per-row report on an executed batch proposal — total/succeeded/failed counts plus one row per input. */
export interface BatchReport {
  total: number;
  succeeded: number;
  failed: number;
  rows: { index: number; email?: string; subjectEmail?: string; status: "ok" | "failed"; credentialId?: string; error?: string }[];
}

/** Result of verifying one asset's audit hash chain + on-ledger anchor. */
export interface AuditVerify {
  assetId: string;
  valid: boolean;
  count: number;
  head: string | null;
  brokenAt: number | null;
  reason: string | null;
  lastAnchor: { seq: number; hash: string; txHash: string; chainId: string; at: string } | null;
  anchorConsistent: boolean;
}

export interface AuditSummary {
  assets: number;
  verified: number;
  anchoredAssets: number;
  tampered: { assetId: string; brokenAt: number | null; reason: string | null }[];
}

export interface AuditEntry {
  id: string;
  assetId?: string;
  actorId: string;
  action: string;
  payload: Record<string, unknown>;
  txHash?: string;
  chainId?: string;
  createdAt: string;
}

export interface AnalyticsSummary {
  scope: "platform" | "use-case";
  useCaseKey: string | null;
  totals: {
    assets: number;
    useCases: number;
    holders: number;
    supply: string;
    valueByCurrency: Record<string, string>;
    tradedByCurrency: Record<string, string>;
    trades: number;
  };
  byLedger: { chainId: string; mode: "real" | "simulated"; assets: number; supply: string; holders: number }[];
  byUseCase: { useCaseKey: string; name: string; symbol: string; chainId: string; supply: string; holders: number; valueByCurrency: Record<string, string> }[];
  activity: { date: string; count: number; tradedByCurrency: Record<string, string> }[];
  recent: { at: string; action: string; assetId: string; assetName: string; useCaseKey: string | null; chainId: string; summary: string }[];
}

export interface IdentityResult {
  status: string;
  did: string;
  claims: Record<string, unknown>;
  issuer: string;
}

export interface Holding {
  assetId: string; name: string; symbol: string; useCaseKey: string; chainId: string;
  units: string; unitPrice: string | null; currency: string | null; value: string | null;
}
export interface Portfolio {
  wallet: string;
  cash: { currency: string; amount: string }[];
  holdings: Holding[];
  totalByCurrency: Record<string, string>;
}
export interface ActivityEvent {
  at: string; kind: "subscribed" | "received" | "sent" | "coupon" | "redemption";
  assetId: string; assetName: string; units: string | null; amount: string | null;
  currency: string | null; txHash: string | null;
}

export type OrgType = "bank" | "corporate" | "msme" | "government" | "verifier";

export type CompanyCategory = "private-limited" | "public-limited" | "llp" | "opc" | "section-8";

/** Reference to an uploaded KYB certificate (stored server-side, fetched by id). */
export interface KybDocumentRef { id: string; sha256: string }

/** India KYB details captured at corporate self-registration. */
export interface CompanyProfile {
  cin: string;
  pan: string;
  gstin: string | null;
  state: string;
  pincode: string;
  dateOfIncorporation: string;
  category: CompanyCategory;
  companyStatus: "active" | "inactive";
  /** Absent on legacy rows registered before certificate uploads were required. */
  documents?: { cinCertificate: KybDocumentRef; gstinCertificate: KybDocumentRef | null };
}

export interface Organization {
  id: string;
  name: string;
  orgType: OrgType;
  registrationId: string | null;
  jurisdiction: string | null;
  did: string;
  verified: boolean;
  status: string;
  companyProfile?: CompanyProfile | null;
  credentials?: { id: string; type: string; issuerDid: string; issuedAt: string; revoked: boolean }[];
  /** EN-A capability envelope; null = unrestricted legacy. Absent on pre-EN-A responses. */
  capabilities?: OrgCapabilities | null;
  /** EN-E: an image Document id used as this org's mark; null = unbranded. */
  brandLogoDocumentId?: string | null;
  /** EN-E: lowercase `#rrggbb`; null = the platform palette. */
  brandAccent?: string | null;
  createdAt?: string;
}

export interface OrgMember {
  id: string;
  email: string;
  role: Role;
  useCaseKey: string | null;
  did: string | null;
  active: boolean;
  kycStatus: string;
}

// ---- EN-B: machine API access (org-scoped API keys) ------------------------
/**
 * A DELIBERATE MIRROR of `@tokenlayer/core`'s `API_SCOPES`
 * (packages/core/src/api-scopes.ts). The web app has no dependency on core —
 * every shared vocabulary here is copied the same way `ORG_DOMAINS` above is —
 * so this list must be updated when core's is. It is only ever a display and
 * pick-list: the server runs core's `validateScopes` and answers 400
 * INVALID_SCOPES for anything it does not recognise, so a stale copy here can
 * never grant a scope, only fail to offer one.
 *
 * A stored grant may also be `*` or `resource:*`; the console only ever mints
 * exact scopes, but the table renders whatever the server returns.
 */
export const API_SCOPES = [
  "credentials:read",
  "credentials:issue",
  "credentials:revoke",
  "credentials:present",
  "verifications:read",
  "verifications:request",
  "verifications:verify",
  "assets:read",
  "assets:issue",
  "assets:transfer",
  "users:read",
  "users:onboard",
  "org:read",
  // These two were added to core by EN-C and NOT mirrored here, so the console
  // could not mint a key for the Webhooks section on its own screen. The
  // mirror's stated failure mode ("can never grant a scope, only fail to offer
  // one") is exactly what happened; caught while adding credentials:present.
  "webhooks:read",
  "webhooks:write",
  "usecases:provision",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

// ---- EN-F: certificate designer ------------------------------------------
/**
 * A DELIBERATE MIRROR of `@tokenlayer/core`'s `CERTIFICATE_FIXED_FIELDS`
 * (packages/core/src/certificate-fields.ts), on the same terms as `API_SCOPES`
 * above: the web app has no dependency on core.
 *
 * Unlike those, this one is PINNED — `apps/api/test/certificate-mirror.test.ts`
 * reads this file and fails the API suite if the list or a label drifts. That
 * check exists because this mirror pattern has silently drifted twice.
 */
export const CERTIFICATE_FIXED_FIELDS = [
  "subject.name",
  "subject.did",
  "credential.id",
  "credential.type",
  "credential.issuedAt",
  "credential.expiresAt",
  "issuer.name",
  "issuer.did",
  "config.heading",
  "config.subheading",
  "qr",
] as const;

export type CertificateFixedField = (typeof CERTIFICATE_FIXED_FIELDS)[number];
export type CertificateFieldRef = CertificateFixedField | `claim:${string}`;
export type CertificateFont = "sans" | "serif" | "mono";
export type CertificateAlign = "left" | "center" | "right";

export const CERTIFICATE_FIELD_LABELS: Record<CertificateFixedField, string> = {
  "subject.name": "Holder name",
  "subject.did": "Holder DID",
  "credential.id": "Credential ID",
  "credential.type": "Credential type",
  "credential.issuedAt": "Issue date",
  "credential.expiresAt": "Expiry date",
  "issuer.name": "Issuer name",
  "issuer.did": "Issuer DID",
  "config.heading": "Heading (from config)",
  "config.subheading": "Subheading (from config)",
  "qr": "Verification QR",
};

export interface CertificateFieldPlacement {
  field: CertificateFieldRef;
  x: number;
  y: number;
  width?: number;
  fontSize?: number;
  font?: CertificateFont;
  bold?: boolean;
  color?: string;
  align?: CertificateAlign;
}

export const MAX_CERTIFICATE_PLACEMENTS = 40;
export const DEFAULT_QR_WIDTH = 0.14;

/** Derived server-side from `revokedAt` + `expiresAt` — never stored. */
export type ApiKeyStatus = "active" | "revoked" | "expired";

/** The public projection of a key. NEVER carries the secret or its hash. */
export interface ApiKeyView {
  id: string;
  /** null = a platform-owned key (not mintable from this surface). */
  orgId: string | null;
  /** The bound service user whose role this key authenticates as. */
  userId: string;
  name: string;
  /** First 8 chars of the secret body — the only part that is ever displayable. */
  prefix: string;
  scopes: string[];
  role: Role | null;
  useCaseKey: string | null;
  status: ApiKeyStatus;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  createdBy: string;
  createdAt: string;
  /**
   * EN-D2: which environment this key acts in. A `test` key acts only on
   * sandbox use cases and reads `tl_test_…`; a `live` one only on real ones.
   *
   * SENT ON EVERY KEY SINCE D2-8 — `apiKeyView` projects it and `ApiKeyView#`
   * declares it, which are both required (fast-json-stringify strips whatever
   * the schema does not name). Still OPTIONAL here, and only for the version
   * skew this console cannot rule out: a browser tab left open across a deploy,
   * or a build pointed at an older API. Absent is read as `live`, which is what
   * the column's own default says, so the wrong guess is impossible rather than
   * merely unlikely.
   */
  mode?: ResourceMode;
}

/**
 * The create/rotate response — the ONLY moment `secret` exists anywhere outside
 * the caller's own storage. It is never persisted by this app: see Developers.tsx.
 */
export interface MintedApiKey {
  key: ApiKeyView;
  secret: string;
}

// ---- EN-C: webhooks & events ----------------------------------------------
/**
 * A DELIBERATE MIRROR of `@tokenlayer/core`'s `EVENT_TYPES`
 * (packages/core/src/events.ts), on the same terms as `API_SCOPES` above: the
 * web app has no dependency on core, so this list must be updated when core's
 * is. It is only ever a display and pick-list — the server runs core's
 * `validateEventTypes` and answers 400 UNKNOWN_EVENT_TYPE for anything it does
 * not recognise, so a stale copy here can never subscribe to something that
 * does not exist, only fail to offer something that does.
 *
 * A STORED subscription may also be `"*"` (subscribe to everything the org is
 * entitled to). This console only ever mints exact types, but the table renders
 * whatever the server returns, so nothing here assumes the list is exhaustive.
 *
 * `ping` is deliberately NOT here: it is a fact about a test API call, not a
 * platform fact, and the server excludes it from the catalog for that reason.
 * Testing an endpoint is a button, never a subscription.
 */
export const EVENT_TYPES = [
  // Identity
  "credential.issued",
  "credential.accepted",
  "credential.rejected",
  "credential.revoked",
  "verification.requested",
  "verification.completed",
  // Tokenization
  "asset.issued",
  "asset.transferred",
  "asset.redeemed",
  // Governance
  "proposal.executed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * One plain line per event type, for the integrator choosing them — typed as a
 * TOTAL record, so adding a type to the mirrored vocabulary above without
 * describing it here fails the build rather than shipping a blank checkbox.
 * (The same discipline as SCOPE_DESCRIPTIONS in Developers.tsx.)
 */
export const EVENT_DESCRIPTIONS: Record<EventType, string> = {
  "credential.issued": "A credential was issued to a holder.",
  "credential.accepted": "A holder accepted a credential you issued them.",
  "credential.rejected": "A holder rejected a credential you issued them.",
  "credential.revoked": "A credential was revoked by its issuer.",
  "verification.requested": "A verifier asked a holder to present credentials.",
  "verification.completed": "A verification finished and has a result.",
  "asset.issued": "An asset was tokenized and minted on-chain.",
  "asset.transferred": "Tokens moved between accounts.",
  "asset.redeemed": "Tokens were redeemed and burned.",
  "proposal.executed": "A maker-checker proposal was approved and carried out.",
};

/** The public projection of a webhook endpoint. NEVER carries the secret. */
export interface WebhookEndpoint {
  id: string;
  /** null = a platform-scope endpoint (not registrable from this surface). */
  orgId: string | null;
  url: string;
  description: string | null;
  /** Exact types, or `["*"]`. Typed as strings because `*` is not an EventType. */
  eventTypes: string[];
  useCaseKey: string | null;
  status: "active" | "disabled";
  /** Why it was switched off — the ONLY place an auto-disable is ever explained. */
  disabledReason: string | null;
  disabledAt: string | null;
  /**
   * Failed attempts in a row against the integrator's SERVER (non-2xx, timeout,
   * unreachable host). This is the counter that auto-disables an endpoint, once
   * it reaches the platform threshold AND the run is old enough.
   */
  consecutiveFailures: number;
  /**
   * Attempts in a row the platform REFUSED TO SEND because the URL failed its
   * safety re-check at delivery time — its DNS moved, or it now resolves to a
   * private address. A different fact entirely from `consecutiveFailures`: the
   * integrator's server was never contacted, so it says nothing about its
   * health. These NEVER auto-disable an endpoint, by design (otherwise anyone
   * able to degrade a hostname's resolution could silence an org's webhooks).
   */
  consecutiveGuardFailures: number;
  /** When the current failure run started — not when it last failed. */
  failingSince: string | null;
  deletedAt?: string | null;
  createdBy?: string;
  createdAt: string;
  lastDeliveryAt: string | null;
  /**
   * EN-D2: which stream this endpoint receives. A `test` endpoint hears ONLY
   * sandbox events and a `live` one ONLY real ones — the two never cross, so a
   * sandbox event can never reach a production handler. FIXED at registration.
   *
   * Unlike `ApiKeyView.mode` this is genuinely sent by the server (it is in the
   * `WebhookEndpoint` response schema and `required` there), and the create
   * route accepts it in the body. Typed optional all the same, so a row from an
   * older API build renders as live rather than as a blank pill.
   */
  mode?: ResourceMode;
}

/** One queued/attempted delivery. Carries no payload — read that from /events. */
export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventSeq: number;
  status: "pending" | "inflight" | "delivered" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  responseError: string | null;
  durationMs: number | null;
  createdAt?: string;
}

/**
 * The create/rotate response — the ONLY moment `secret` exists anywhere outside
 * the integrator's own storage. Never persisted by this app: see Webhooks.tsx.
 */
export interface MintedWebhook {
  endpoint: WebhookEndpoint;
  secret: string;
}

/** A row from the durable cursor log (`GET /events`). */
export interface PlatformEvent {
  seq: number;
  id: string;
  /** `string`, not EventType: the log also carries `ping`. */
  type: string;
  orgId: string | null;
  useCaseKey: string | null;
  subjectId: string | null;
  data: Record<string, unknown>;
  occurredAt: string;
}

export interface HeldCredential {
  id: string;
  type: string[];
  credentialUseCaseKey?: string | null;
  issuerDid: string;
  issuerName?: string | null;
  holderDid: string;
  claims: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
  revokedReason: string | null;
  vcJwt: string;
  certificateAvailable?: boolean;
  acceptance?: "accepted" | "pending" | "rejected" | "changes_requested";
  acceptanceAt?: string | null;
  acceptanceNote?: string | null;
  /** ID-O: on-chain receipts (absent/null when unanchored or pre-ID-O — no backfill). */
  anchorTxHash?: string | null;
  anchorChainId?: string | null;
  revokeTxHash?: string | null;
}

export interface DidDocument {
  id: string;
  verificationMethod: { id: string; type: string; controller: string; publicKeyMultibase: string }[];
  authentication: string[];
  assertionMethod: string[];
  /** On-chain registration of this DID, when a chain hosts the registry; null when unanchored. */
  registration?: { registered: boolean; active: boolean; chainId: string; registry: string } | null;
}

/** A credential type the platform can issue, with the claim shape it expects. */
export interface CredentialTypeInfo {
  type: string;
  description: string;
  allowedIssuerOrgTypes: string[];
  requiredApprovals: number;
  validityDays: number;
  selfIssuedOnly: boolean;
  claimSchema: { type: "object"; required?: string[]; properties: Record<string, { type: string; description?: string; enum?: string[]; pattern?: string; min?: number; max?: number }> };
}

/** The deployed identity registry contracts (GET /registry); null when no chain hosts them. */
export interface IdentityRegistryInfo {
  chainId: string;
  didRegistry: string;
  vcRegistry: string;
  deployTxHash: string;
}

/** Revocation status of a credential (GET /credentials/:id/status — public, no auth).
 * `source` says where the answer came from: the chain registry, the database when
 * unanchored — or `sandbox` (EN-D2), which is NOT the database fallback: a sandbox
 * credential was never anchored and never will be, by design. */
export interface CredentialStatusInfo {
  id: string;
  revoked: boolean;
  revokedAt: string | null;
  reason: string | null;
  anchored: boolean;
  source: "chain" | "database" | "sandbox";
  /** True only for a credential issued in a SANDBOX use case (EN-D2): unanchored by design. */
  sandbox?: boolean;
  acceptance?: string;
  /** Present only when source === "chain". */
  chainId?: string;
  registry?: string;
  vcHash?: string;
}

/** A credential an organization has issued (GET /orgs/:id/credentials). */
export interface IssuedCredential {
  id: string;
  type: string;
  holderDid: string;
  claims: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface VerificationRequest {
  id: string;
  verifierOrgId: string;
  holderDid: string;
  requestedTypes: string[];
  purpose: string;
  credentialUseCaseKey?: string | null;
  status: "pending" | "consented" | "rejected" | "expired";
  consentedCredentialIds: string[] | null;
  consentedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  expiresAt: string;
  eligibleCredentials?: { id: string; type: string; issuerDid: string; issuedAt: string }[];
}
export interface StagedInvoice {
  id: string; useCaseKey: string; source: "upload" | "erp" | "manual";
  metadata: Record<string, unknown>; invoiceHash: string;
  documentId: string | null; documentSha256: string | null;
  status: "staged" | "tokenized"; assetId: string | null;
  createdBy: string; createdAt: string; tokenizedAt: string | null;
}
export interface InvoiceRowResult { index: number; status: "staged" | "duplicate" | "invalid"; id?: string; error?: string }
export interface TokenizeResult { id: string; status: "tokenized" | "skipped" | "failed"; assetId?: string; error?: string }

export interface CertificateConfig {
  enabled: boolean;
  heading?: string;
  subheading?: string;
  claimOrder?: string[];
  logoDocumentId?: string;
  /** EN-F. Full-page artwork, referencing a stored image Document. Its PRESENCE
   *  selects the renderer: with it, the built-in layout is replaced entirely and
   *  only `placements` are drawn. Mirrors core's `CertificateConfig`. */
  background?: { documentId: string; sha256?: string };
  /** EN-F. Where each field prints on the artwork. Inert without `background`,
   *  which is exactly the state a template instantiation lands in. */
  placements?: CertificateFieldPlacement[];
}
export interface CredentialTypeSpec { name: string; title: string; claimSchema: { type: "object"; required?: string[]; properties: Record<string, { type: string; pattern?: string; enum?: string[] }> }; validityDays: number; requiredApprovals: number; certificate?: CertificateConfig; }
export interface EligibleHolder { kind: "user" | "org"; id: string; label: string; did: string; subLabel: string | null; }
export type IssuerBinding = { kind: "platform" } | { kind: "org"; orgId: string };
export type HolderPolicy = { who: "any-onboarded" } | { who: "orgType"; orgTypes: string[] } | { who: "specific"; orgIds: string[] };
export type VerifierBinding = { kind: "any" } | { kind: "orgs"; orgIds: string[] };
/** `sandbox` is the Identity-domain twin of `UseCase.sandbox` — same optionality,
 *  same "absent means live" reading, same immutability after creation. */
export interface CredentialUseCase { key: string; name: string; description?: string; credentialTypes: CredentialTypeSpec[]; issuer: IssuerBinding; holderPolicy: HolderPolicy; verifier: VerifierBinding; holderAcceptance?: boolean; ownerOrgId?: string | null; status?: string; sandbox?: boolean; }

export type TemplateParamType = "text" | "number" | "enum" | "boolean";
export interface TemplateParam { name: string; label: string; type: TemplateParamType; required: boolean; default?: string | number | boolean; options?: string[]; min?: number; max?: number; help?: string; }
export interface UseCaseTemplateMeta { key: string; name: string; category: string; description?: string; parameters: TemplateParam[]; builtIn?: boolean; }
export interface UseCaseTemplate extends UseCaseTemplateMeta { body: unknown; } // body shape is server-owned; opaque to the client
export interface ProvisionedDeskUser { email: string; password: string; role: "Issuer" | "Holder" | "Verifier"; }
export interface ProvisionResult { org: { id: string; name: string; did: string }; useCase: CredentialUseCase; deskUsers: ProvisionedDeskUser[]; }

export interface LoginKeyInfo { id: string; did: string; label: string; createdAt: string; lastUsedAt: string | null; }
export interface QrLoginStart { sessionId: string; challenge: string; signUrl: string; qrSvg: string; expiresAt: string; }
export interface QrLoginPoll { status: "pending" | "authenticated" | "consumed" | "expired"; token?: string; user?: SessionUser; }

export interface VerificationResult {
  valid: boolean;
  holderDid: string | null;
  reason: string | null;
  purpose: string;
  verifiedAt: string;
  credentials: { id: string | null; type: string | null; issuer: string | null; reason: string | null;
    claims: Record<string, unknown> | null;
    /** Absent on pre-ID-O stored results — render no ticks when missing. */
    checks?: { signature: boolean; trusted: boolean; notExpired: boolean; subjectBound: boolean; notRevoked: boolean | "unknown" };
    issuerResolution?: { registered: boolean; active: boolean; chainId: string } | null;
    /** ID-O: on-chain receipts of the stored credential (absent on pre-ID-O results). */
    anchorTxHash?: string | null;
    anchorChainId?: string | null;
    revokeTxHash?: string | null;
    valid: boolean }[];
}

// ---- ID-N: identity dashboard ----------------------------------------------

export type DerivedCredentialStatus = "accepted" | "pending" | "changes_requested" | "rejected" | "revoked" | "expired";

export interface IdentityStatusCounts {
  issued: number;
  accepted: number;
  pendingAcceptance: number;
  changesRequested: number;
  rejectedByHolder: number;
  revoked: number;
  expired: number;
}

export interface IdentityBoardRow {
  credentialId: string;
  useCaseKey: string;
  useCaseName: string;
  type: string;
  holderDid: string;
  holderLabel: string;
  issuedAt: string;
  expiresAt: string | null;
  status: DerivedCredentialStatus;
  acceptanceNote: string | null;
}

export interface IdentityDashboardData {
  totals: IdentityStatusCounts;
  byUseCase: { key: string; name: string; counts: IdentityStatusCounts; byType: { type: string; counts: IdentityStatusCounts }[] }[];
  board: IdentityBoardRow[];
  boardTotal: number;
  activity: { date: string; issued: number }[];
  verification: { pending: number; consented: number; rejected: number; expired: number; verifiedValid: number; verifiedInvalid: number };
}
