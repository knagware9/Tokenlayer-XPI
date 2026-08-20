import { randomBytes } from "node:crypto";
import type { Role } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";

/** The only roles that ever hold a token balance. Everyone else's wallet stays
 *  null unless an admin explicitly supplies one at creation time. */
export const WALLET_ELIGIBLE_ROLES: ReadonlySet<Role> = new Set<Role>(["Buyer", "Trader", "Issuer"]);

/**
 * Resolve the `accountId` for a user being created or updated. An explicitly
 * supplied address always wins — an admin's or the user's own choice is never
 * overridden by auto-generation. Absent one, an eligible role gets a fresh
 * synthetic address so `NO_WALLET` never blocks a first purchase; an
 * ineligible role stays null, matching today's behavior.
 */
export async function resolveAccountId(
  deps: Pick<AppDeps, "accounts">, role: Role, suppliedWalletAddress: string | null | undefined, label: string,
): Promise<string | null> {
  if (suppliedWalletAddress) return (await deps.accounts.upsert(suppliedWalletAddress, label)).id;
  if (!WALLET_ELIGIBLE_ROLES.has(role)) return null;
  const address = "0x" + randomBytes(20).toString("hex");
  return (await deps.accounts.upsert(address, label)).id;
}

/**
 * One-time backfill for users who existed before wallet auto-assignment
 * shipped: every eligible role still sitting on `accountId: null` gets one.
 * Idempotent — re-running only ever touches rows still missing a wallet, so
 * it is safe to run again after a partial failure or against an already-
 * backfilled database.
 */
export async function backfillWallets(deps: Pick<AppDeps, "users" | "accounts">): Promise<{ assigned: number }> {
  const all = await deps.users.list();
  const eligible = all.filter((u) => u.accountId === null && WALLET_ELIGIBLE_ROLES.has(u.role));
  for (const u of eligible) {
    const accountId = await resolveAccountId(deps, u.role, null, u.email);
    if (accountId) await deps.users.update(u.id, { accountId });
  }
  return { assigned: eligible.length };
}
