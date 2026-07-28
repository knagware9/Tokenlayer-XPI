export type Role = "PlatformAdmin" | "OrgAdmin" | "UseCaseAdmin" | "Issuer" | "Trader" | "Buyer" | "Auditor";

/** Deployment configuration (GET /config): which domains this install has enabled. */
export interface AppConfig { domains: import("./domains.js").DomainKey[]; }

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  useCaseKey: string | null;
  walletAddress?: string | null;
  orgId?: string | null;
  did?: string | null;
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
 * `source` says where the answer came from: the chain registry, or the database when unanchored. */
export interface CredentialStatusInfo {
  id: string;
  revoked: boolean;
  revokedAt: string | null;
  reason: string | null;
  anchored: boolean;
  source: "chain" | "database";
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

export interface CredentialTypeSpec { name: string; title: string; claimSchema: { type: "object"; required?: string[]; properties: Record<string, { type: string; pattern?: string; enum?: string[] }> }; validityDays: number; requiredApprovals: number; }
export interface EligibleHolder { kind: "user" | "org"; id: string; label: string; did: string; subLabel: string | null; }
export type IssuerBinding = { kind: "platform" } | { kind: "org"; orgId: string };
export type HolderPolicy = { who: "any-onboarded" } | { who: "orgType"; orgTypes: string[] } | { who: "specific"; orgIds: string[] };
export type VerifierBinding = { kind: "any" } | { kind: "orgs"; orgIds: string[] };
export interface CredentialUseCase { key: string; name: string; description?: string; credentialTypes: CredentialTypeSpec[]; issuer: IssuerBinding; holderPolicy: HolderPolicy; verifier: VerifierBinding; ownerOrgId?: string | null; status?: string; }

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
    checks: { signature: boolean; trusted: boolean; notExpired: boolean; subjectBound: boolean; notRevoked: boolean | "unknown" };
    valid: boolean }[];
}
