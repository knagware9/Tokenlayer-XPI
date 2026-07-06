/**
 * Builds a ComplianceProvider (the core interface the LifecycleEngine consumes
 * for data-dependent rules) from the app's repositories. holderCount/acquiredAt
 * derive from the per-asset audit stream — the same fold the analytics dashboard
 * uses (shared via ./holders). jurisdictionOf maps a holder address to the KYC
 * country of the user whose linked account resolves to that address.
 *
 * Failures propagate (fail-closed): the engine treats a rejected provider call
 * as a policy failure rather than silently allowing the operation.
 */
import type { AssetRef, ComplianceProvider } from "@tokenlayer/core";
import { firstAcquisitionOf, holderCountOf } from "./holders.js";
import type { AccountRepository, AuditRepository, UserRepository } from "./persistence/types.js";

export interface ComplianceProviderDeps {
  audit: AuditRepository;
  users: UserRepository;
  accounts: AccountRepository;
}

export function createComplianceProvider(deps: ComplianceProviderDeps): ComplianceProvider {
  const { audit, users, accounts } = deps;

  // Full audit stream for one asset, oldest→newest (fold is order-sensitive).
  async function entriesFor(ref: AssetRef) {
    const { items } = await audit.listByAsset(ref.id, { limit: 100000, offset: 0 });
    return [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return {
    async holderCount(ref: AssetRef): Promise<number> {
      return holderCountOf(await entriesFor(ref));
    },
    async acquiredAt(ref: AssetRef, account: string): Promise<string | null> {
      return firstAcquisitionOf(await entriesFor(ref), account);
    },
    async jurisdictionOf(account: string): Promise<string | null> {
      // Resolve address → account id → the user linked to that account → kyc.country.
      const acct = (await accounts.list()).find((a) => a.address === account);
      if (!acct) return null;
      const user = (await users.list()).find((u) => u.accountId === acct.id);
      return user?.kyc?.country ?? null;
    },
  };
}
