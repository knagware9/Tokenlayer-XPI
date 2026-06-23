import { LifecycleEngine, RbacPolicy, type UseCaseSource } from "@tokenlayer/core";
import { RepositoryAuditSink } from "./audit-sink.js";
import type { ChainRegistry } from "./chains.js";
import type { Currency } from "./currencies.js";
import type {
  AccountRepository,
  AssetRepository,
  AuditRepository,
  CashRepository,
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
  currencies: Currency[];
  jwtSecret: string;
  /** CORS origin allowlist; defaults to the local dashboard when omitted (tests/demo). */
  corsOrigins?: string[];
  /** When true, hides API docs and other dev-only surfaces. */
  isProduction?: boolean;
  /** Max login attempts per IP per 15-min window (default 10). */
  loginRateLimitMax?: number;
}

/** Wires a LifecycleEngine over the use-case source, chains, and audit store. */
export function createEngine(
  useCases: UseCaseSource,
  rbac: RbacPolicy,
  chains: ChainRegistry,
  audit: AuditRepository,
): LifecycleEngine {
  return new LifecycleEngine({
    useCases,
    rbac,
    resolveAdapter: (chainId) => chains.resolveAdapter(chainId),
    audit: new RepositoryAuditSink(audit),
  });
}
