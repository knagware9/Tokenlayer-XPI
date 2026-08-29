import type { Role } from "@tokenlayer/core";
import { randomBytes } from "node:crypto";
import type { AppDeps } from "../context.js";
import { coded } from "./executors.js";

/** The only roles that ever hold a token balance. Everyone else's wallet stays
 *  null unless an admin explicitly supplies one at creation time. */
export const WALLET_ELIGIBLE_ROLES: ReadonlySet<Role> = new Set<Role>(["Buyer", "Trader", "Issuer"]);

/**
 * AN ORG-OWNED ACCOUNT IS NOT A PERSONAL WALLET, AND MUST NEVER BECOME ONE.
 *
 * `Account.ownerOrgId` is non-null on exactly one kind of row: a use case's
 * auto-provisioned treasury (see `provisionTreasury`). That address is
 * DISCOVERABLE — `Asset.treasuryAccount` is returned on every asset read to
 * anyone scoped to the use case — and it carries the compliance exemption
 * `isUseCaseTreasury` grants, which short-circuits `requireJurisdiction` and
 * `requireVerifiedIdentity`. It also has NO linked user, so an
 * "is this address already someone else's?" check answers "no" and waves the
 * claim through. Linking a person to it would hand that person the exemption
 * the branch was built to respect, not to sell.
 *
 * So the discriminator is ownership, not linkage: refuse the address outright
 * whenever the Account it resolves to belongs to an org.
 */
export async function refuseIfOrgOwned(
  deps: Pick<AppDeps, "accounts">, address: string,
): Promise<{ error: string; message: string } | null> {
  const existing = await deps.accounts.findByAddress(address);
  if (!existing?.ownerOrgId) return null;
  return {
    error: "ADDRESS_IS_ORG_TREASURY",
    message: "this address is an organization's use-case treasury and cannot be linked as a personal wallet",
  };
}

/**
 * Resolve the `accountId` for a user being created or updated. An explicitly
 * supplied address always wins — an admin's or the user's own choice is never
 * overridden by auto-generation. Absent one, an eligible role gets a fresh
 * synthetic address so `NO_WALLET` never blocks a first purchase; an
 * ineligible role stays null, matching today's behavior.
 *
 * The one address that never wins is an org-owned treasury: it is refused with
 * `ADDRESS_IS_ORG_TREASURY` → 400, the same refusal `PATCH /me/wallet` makes
 * (as a 409) on the other door into wallet linkage. Both doors, or the gate is
 * one door of two — this program's recurring defect.
 */
export async function resolveAccountId(
  deps: Pick<AppDeps, "accounts" | "enabledDomains">, role: Role, suppliedWalletAddress: string | null | undefined, label: string,
): Promise<string | null> {
  // A wallet is a tokenization concept, full stop — including "Issuer", a role
  // name both domains use for different things (identity's Issuer signs
  // credentials, never token transfers). On a deployment that does not serve
  // tokenization, Account is disabled store-wide (see context.ts's own
  // `!deps.enabledDomains.includes("tokenization")` guard), so provisioning one
  // here would only fail — and for identity's Issuer it would be wrong to try:
  // that role has nothing to hold a balance in.
  if (!deps.enabledDomains.includes("tokenization")) return null;
  if (suppliedWalletAddress) {
    const refusal = await refuseIfOrgOwned(deps, suppliedWalletAddress);
    if (refusal) throw coded(400, refusal.error, refusal.message);
    return (await deps.accounts.upsert(suppliedWalletAddress, label)).id;
  }
  if (!WALLET_ELIGIBLE_ROLES.has(role)) return null;
  const address = "0x" + randomBytes(20).toString("hex");
  return (await deps.accounts.upsert(address, label)).id;
}

/** Auto-provisions a fresh, org-owned treasury Account. One per use case —
 *  called by every path that creates one (org self-service, PlatformAdmin
 *  direct-create, the create-use-case proposal executor, and boot seeding). */
export async function provisionTreasury(
  deps: Pick<AppDeps, "accounts">, ownerOrgId: string, label: string,
): Promise<string> {
  const address = "0x" + randomBytes(20).toString("hex");
  const account = await deps.accounts.upsert(address, label, ownerOrgId);
  return account.id;
}

/**
 * One-time backfill for users who existed before wallet auto-assignment
 * shipped: every eligible role still sitting on `accountId: null` gets one.
 * Idempotent — re-running only ever touches rows still missing a wallet, so
 * it is safe to run again after a partial failure or against an already-
 * backfilled database.
 */
export async function backfillWallets(deps: Pick<AppDeps, "users" | "accounts" | "enabledDomains">): Promise<{ assigned: number }> {
  const all = await deps.users.list();
  const eligible = all.filter((u) => u.accountId === null && WALLET_ELIGIBLE_ROLES.has(u.role));
  for (const u of eligible) {
    const accountId = await resolveAccountId(deps, u.role, null, u.email);
    if (accountId) await deps.users.update(u.id, { accountId });
  }
  return { assigned: eligible.length };
}
