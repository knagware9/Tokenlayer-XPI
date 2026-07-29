import { LifecycleEngine, RbacPolicy, type UseCaseSource } from "@tokenlayer/core";
import { RepositoryAuditSink } from "./audit-sink.js";
import type { ChainRegistry } from "./chains.js";
import { createComplianceProvider } from "./compliance-provider.js";
import type { Currency } from "./currencies.js";
import type { ChallengeStore } from "./identity-challenges.js";
import type { Keystore } from "./keystore.js";
import type { QrLoginStore } from "./qr-login-sessions.js";
import type {
  AccountRepository,
  AssetRepository,
  AuditAnchorRepository,
  AuditRepository,
  CashflowRepository,
  CashRepository,
  CredentialRepository,
  DocumentRepository,
  ListingRepository,
  LoginKeyRepository,
  OrganizationRepository,
  ProposalRepository,
  StagedInvoiceRepository,
  CredentialUseCaseRepository,
  CredentialUseCaseTemplateRepository,
  UseCaseRepository,
  UserRepository,
  VerificationRequestRepository,
} from "./persistence/types.js";
import type { IdentityRegistry } from "./registry.js";

export interface AppDeps {
  useCases: UseCaseRepository;
  credentialUseCases: CredentialUseCaseRepository;
  credentialTemplates: CredentialUseCaseTemplateRepository;
  rbac: RbacPolicy;
  engine: LifecycleEngine;
  users: UserRepository;
  assets: AssetRepository;
  audit: AuditRepository;
  auditAnchors: AuditAnchorRepository;
  accounts: AccountRepository;
  chains: ChainRegistry;
  cash: CashRepository;
  listings: ListingRepository;
  documents: DocumentRepository;
  cashflows: CashflowRepository;
  proposals: ProposalRepository;
  organizations: OrganizationRepository;
  credentials: CredentialRepository;
  verificationRequests: VerificationRequestRepository;
  stagedInvoices: StagedInvoiceRepository;
  keystore: Keystore;
  /** True iff DID_MASTER_KEY was explicitly configured (production must set it). */
  didMasterConfigured: boolean;
  challenges: ChallengeStore;
  /** Self-custody device login keys (public did:key) for passwordless login. */
  loginKeys: LoginKeyRepository;
  /** In-memory single-use QR passwordless-login sessions. */
  qrLogin: QrLoginStore;
  /** Public base URL of the web app, embedded in QR-login sign URLs. */
  publicWebUrl: string;
  /** Domains this deployment runs (tokenization, identity). Never empty. */
  enabledDomains: string[];
  /** Allowlist of trusted KYC credential issuer DIDs; empty/absent ⇒ no issuer is trusted (fail closed). */
  trustedKycIssuers?: string[];
  /** Dev-only deterministic issuer seed for the demo mint route (never set in production). */
  devIssuerSeed?: string;
  currencies: Currency[];
  jwtSecret: string;
  /** Public base URL of this API (e.g. "http://localhost:4000/api/v1"), used to build resolvable credentialStatus URLs. */
  publicApiUrl: string;
  /** CORS origin allowlist; defaults to the local dashboard when omitted (tests/demo). */
  corsOrigins?: string[];
  /** When true, hides API docs and other dev-only surfaces. */
  isProduction?: boolean;
  /** Max login attempts per IP per 15-min window (default 10). */
  loginRateLimitMax?: number;
  /**
   * Platform fee account (address) receiving marketplace/issuance fees. When
   * absent, fees are disabled (treated as 0) regardless of use-case config.
   */
  platformFeeAccount?: string;
  /**
   * Secondary-market escrow account (address) holding listed tokens. When
   * absent, the market is disabled: all market endpoints return 503
   * MARKET_DISABLED.
   */
  marketEscrowAccount?: string;
  /** The on-chain identity registry. ABSENT when no chain hosts one — consumers must handle that explicitly. */
  registry?: IdentityRegistry;
}

/**
 * Wires a LifecycleEngine over the use-case source, chains, and audit store.
 * When the repos needed to answer data-dependent compliance rules (users +
 * accounts) are supplied, a ComplianceProvider is injected so the engine can
 * enforce maxHolders / lockupDays / allowedJurisdictions. Omit them (e.g. a
 * deploy-only harness) and those rules are simply not consulted.
 */
export function createEngine(
  useCases: UseCaseSource,
  rbac: RbacPolicy,
  chains: ChainRegistry,
  audit: AuditRepository,
  complianceRepos?: { users: UserRepository; accounts: AccountRepository },
): LifecycleEngine {
  return new LifecycleEngine({
    useCases,
    rbac,
    resolveAdapter: (chainId) => chains.resolveAdapter(chainId),
    audit: new RepositoryAuditSink(audit),
    compliance: complianceRepos
      ? createComplianceProvider({ audit, users: complianceRepos.users, accounts: complianceRepos.accounts })
      : undefined,
  });
}
