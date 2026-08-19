import { LifecycleEngine, RbacPolicy, type UseCaseSource } from "@tokenlayer/core";
import { RepositoryAuditSink } from "./shared/audit-sink.js";
import type { ChainRegistry } from "./shared/chains.js";
import { createComplianceProvider } from "./tokenization/compliance-provider.js";
import { localIdentityAssertions, type IdentityAssertions } from "./identity/identity-assertions.js";
import type { Currency } from "./tokenization/currencies.js";
import type { ChallengeStore } from "./identity/identity-challenges.js";
import type { Keystore } from "./shared/keystore.js";
import type { QrLoginStore } from "./identity/qr-login-sessions.js";
import type {
  AccountRepository,
  ApiKeyRepository,
  AssetRepository,
  AuditAnchorRepository,
  AuditRepository,
  CashflowRepository,
  CashRepository,
  CredentialRepository,
  CredentialUseCaseRepository,
  CredentialUseCaseTemplateRepository,
  DocumentRepository,
  EventRepository,
  LedgerTransactionRepository,
  ListingRepository,
  LoginKeyRepository,
  OrganizationRepository,
  ProposalRepository,
  StagedInvoiceRepository,
  UseCaseRepository,
  UserRepository,
  VerificationRequestRepository,
  WebhookDeliveryRepository,
  WebhookEndpointRepository,
} from "./persistence/types/index.js";
import type { IdentityRegistry } from "./identity/registry.js";
import type { SecretBox } from "./webhooks/secret-box.js";

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
  /** Machine credentials (EN-B): the auth seam resolves `tl_live_…` bearers through this. */
  apiKeys: ApiKeyRepository;
  /** EN-C event outbox: the durable, globally ordered log integrators read. */
  events: EventRepository;
  webhookEndpoints: WebhookEndpointRepository;
  webhookDeliveries: WebhookDeliveryRepository;
  /** The durable record of every chain write — see ledger-transactions-repo.test.ts. */
  ledgerTransactions: LedgerTransactionRepository;
  /**
   * Dev/demo only: permits an http:// webhook endpoint on loopback. REQUIRED,
   * not optional, so that every construction site has to state its posture —
   * an omitted-and-therefore-undefined flag would silently mean "secure" in one
   * harness and be forgotten in the one that mattered. The registration-time URL
   * guard and the dispatcher's delivery-time re-check must be given the SAME
   * value, or a URL that was legal to save becomes undeliverable (or worse, the
   * reverse).
   */
  webhooksAllowInsecure: boolean;
  /**
   * Endpoint signing secrets at rest. REQUIRED, and on AppDeps rather than
   * constructed per call site, because BOTH halves of the system must use the
   * same box: the routes seal a freshly minted secret, the dispatcher opens it
   * to sign. Two independently built boxes over two different master keys would
   * pass every unit test and then fail to sign a single real delivery. Required
   * (not optional) so a missed construction site is a compile error rather than
   * an `undefined` that only shows up on the first webhook a customer registers.
   */
  secretBox: SecretBox;
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
  /**
   * Do the PEOPLE here carry DIDs? Absent means "did" — the behaviour every
   * deployment had before this existed, so no construction site changes.
   *
   * ORGANIZATIONS carry a DID either way: an org's DID signs its members'
   * credentials and is what the on-chain registry trusts.
   */
  subjectIdentifiers?: "did" | "plain";
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
  /** Max requests per API KEY per minute (default 600) — 429 RATE_LIMITED past it. */
  apiKeyRateLimitMax?: number;
  /**
   * Max FAILED key verifications per prefix per minute (default 20) before the
   * prefix is refused without any bcrypt work. Prefixes are public, so this is
   * what stops a stranger burning the event loop with garbage secrets.
   */
  apiKeyFailedAttemptMax?: number;
  /**
   * Minimum gap between bcrypt attempts for an OVER-BUDGET key prefix (default
   * 5000ms). This reserve is what stops the failed-attempt bound from becoming a
   * denial of service against a legitimate cold key.
   */
  apiKeyReserveIntervalMs?: number;
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
  /**
   * Minimum age (ms) a `purpose = "brand-logo"` document must have before
   * `POST /orgs/{id}/branding/logo`'s prune will delete it — see
   * `BRAND_LOGO_PRUNE_GRACE_MS` in `brand-logo-prune.ts` for why a plain
   * timestamp/listing-order comparison isn't enough and this is the actual
   * concurrency guard. Absent ⇒ that production default (60s). Tests
   * override this to a small value so an ordinary, non-concurrent test's
   * second upload still prunes the first immediately.
   */
  brandLogoPruneGraceMs?: number;
}

/**
 * Wires a LifecycleEngine over the use-case source, chains, and audit store.
 * When the repos needed to answer data-dependent compliance rules (users +
 * accounts + credentials) are supplied, a ComplianceProvider is injected so
 * the engine can enforce maxHolders / lockupDays / allowedJurisdictions /
 * requireVerifiedIdentity. Omit them (e.g. a deploy-only harness) and those
 * rules are simply not consulted.
 */
export function createEngine(
  useCases: UseCaseSource,
  rbac: RbacPolicy,
  chains: ChainRegistry,
  audit: AuditRepository,
  complianceRepos?: {
    users: UserRepository;
    accounts: AccountRepository;
    /** Local credential store — used only when `identity` is not supplied. */
    credentials: CredentialRepository;
    /**
     * Where the "is this subject verified" answer comes from. Omit and the
     * local store answers, which is every single-deployment caller and every
     * test — so this stays a one-line change for the split, not a rewrite of
     * every construction site.
     */
    identity?: IdentityAssertions;
  },
): LifecycleEngine {
  return new LifecycleEngine({
    useCases,
    rbac,
    resolveAdapter: (chainId) => chains.resolveAdapter(chainId),
    audit: new RepositoryAuditSink(audit),
    compliance: complianceRepos
      ? createComplianceProvider({
          audit,
          users: complianceRepos.users,
          accounts: complianceRepos.accounts,
          identity: complianceRepos.identity ?? localIdentityAssertions(complianceRepos.credentials),
        })
      : undefined,
  });
}
