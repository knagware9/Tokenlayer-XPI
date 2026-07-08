import { LifecycleEngine, RbacPolicy, type UseCaseSource } from "@tokenlayer/core";
import { RepositoryAuditSink } from "./audit-sink.js";
import type { ChainRegistry } from "./chains.js";
import { createComplianceProvider } from "./compliance-provider.js";
import type { Currency } from "./currencies.js";
import type {
  AccountRepository,
  AssetRepository,
  AuditRepository,
  CashflowRepository,
  CashRepository,
  DocumentRepository,
  ListingRepository,
  ProposalRepository,
  UseCaseRepository,
  UserRepository,
} from "./persistence/types.js";

export interface AppDeps {
  useCases: UseCaseRepository;
  rbac: RbacPolicy;
  engine: LifecycleEngine;
  users: UserRepository;
  assets: AssetRepository;
  audit: AuditRepository;
  accounts: AccountRepository;
  chains: ChainRegistry;
  cash: CashRepository;
  listings: ListingRepository;
  documents: DocumentRepository;
  cashflows: CashflowRepository;
  proposals: ProposalRepository;
  currencies: Currency[];
  jwtSecret: string;
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
