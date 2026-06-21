import { LifecycleEngine, RbacPolicy, type UseCaseSource } from "@tokenlayer/core";
import { RepositoryAuditSink } from "./audit-sink.js";
import type { ChainRegistry } from "./chains.js";
import type {
  AccountRepository,
  AssetRepository,
  AuditRepository,
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
  jwtSecret: string;
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
