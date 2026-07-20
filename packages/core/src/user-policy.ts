import type { Role } from "./types.js";

/** Identity of the user performing a management action. */
export interface ManagerRef {
  role: Role;
  useCaseKey: string | null;
}

/** Org-internal roles an OrgAdmin (or PlatformAdmin) may assign to a member. */
const ORG_INTERNAL_ROLES: Role[] = ["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"];

/** Roles allowed to provision other users. */
export function canManageUsers(role: Role): boolean {
  return role === "PlatformAdmin" || role === "OrgAdmin" || role === "UseCaseAdmin";
}

/** Which roles a given manager may assign to a new user. */
export function assignableRoles(role: Role): Role[] {
  // PlatformAdmin may provision the full roster (gated onboarding approves it),
  // not just UseCaseAdmins; scoping still requires a named use case below.
  if (role === "PlatformAdmin") return ["UseCaseAdmin", ...ORG_INTERNAL_ROLES.filter((r) => r !== "UseCaseAdmin")];
  if (role === "OrgAdmin") return [...ORG_INTERNAL_ROLES];
  if (role === "UseCaseAdmin") return ["Issuer", "Buyer", "Auditor"];
  return [];
}

/**
 * May `manager` create a user with `targetRole` in `targetUseCaseKey`?
 * - PlatformAdmin: any roster role, and a use case must be named.
 * - UseCaseAdmin: only roster roles, and only in their own use case.
 */
export function canCreateUser(manager: ManagerRef, targetRole: Role, targetUseCaseKey: string | null): boolean {
  if (!assignableRoles(manager.role).includes(targetRole)) return false;
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
