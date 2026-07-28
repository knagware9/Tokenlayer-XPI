import type { Role } from "./types.js";
import type { UseCaseDomain } from "./use-case-domain.js";

/** Identity of the user performing a management action. */
export interface ManagerRef {
  role: Role;
  useCaseKey: string | null;
}

/** Org-internal roles an OrgAdmin (or PlatformAdmin) may assign to a member. */
const ORG_INTERNAL_ROLES: Role[] = ["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor", "Holder", "Verifier"];

/** Roles allowed to provision other users. */
export function canManageUsers(role: Role): boolean {
  return role === "PlatformAdmin" || role === "OrgAdmin" || role === "UseCaseAdmin";
}

/** Which roles a given manager may assign to a new user in a use case of `domain`.
 *  PlatformAdmin/OrgAdmin may also mint a UseCaseAdmin; a UseCaseAdmin mints only
 *  the domain roster. Tokenization behavior is unchanged; identity adds Holder/Verifier. */
export function assignableRoles(role: Role, domain: UseCaseDomain = "tokenization"): Role[] {
  const adminRoster: Role[] = domain === "identity" ? ["Issuer", "Holder", "Verifier"] : ["Issuer", "Trader", "Buyer", "Auditor"];
  const ucaRoster: Role[] = domain === "identity" ? ["Issuer", "Holder", "Verifier"] : ["Issuer", "Buyer", "Auditor"];
  if (role === "PlatformAdmin" || role === "OrgAdmin") return ["UseCaseAdmin", ...adminRoster];
  if (role === "UseCaseAdmin") return ucaRoster;
  return [];
}

/**
 * May `manager` create a user with `targetRole` in `targetUseCaseKey` (of `targetDomain`)?
 * - PlatformAdmin: any roster role for that domain, and a use case must be named.
 * - UseCaseAdmin: only roster roles for that domain, and only in their own use case.
 */
export function canCreateUser(
  manager: ManagerRef,
  targetRole: Role,
  targetUseCaseKey: string | null,
  targetDomain: UseCaseDomain = "tokenization",
): boolean {
  if (!assignableRoles(manager.role, targetDomain).includes(targetRole)) return false;
  if (manager.role === "PlatformAdmin") return targetUseCaseKey !== null;
  if (manager.role === "UseCaseAdmin") return targetUseCaseKey !== null && targetUseCaseKey === manager.useCaseKey;
  return false;
}

/**
 * May a manager create an ORG member with `targetRole`? Org membership is scoped
 * by organization (not use case), so the org route enforces org-scope separately;
 * this only governs which target roles each manager may mint.
 * - PlatformAdmin: any org-internal role, plus an OrgAdmin.
 * - OrgAdmin: any org-internal role, but never another OrgAdmin or a PlatformAdmin.
 */
export function canCreateOrgMember(managerRole: Role, targetRole: Role): boolean {
  if (targetRole === "PlatformAdmin") return false;
  if (targetRole === "OrgAdmin") return managerRole === "PlatformAdmin";
  if (ORG_INTERNAL_ROLES.includes(targetRole)) return managerRole === "PlatformAdmin" || managerRole === "OrgAdmin";
  return false;
}
