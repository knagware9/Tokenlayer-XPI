import type { Role } from "./types.js";

/** Identity of the user performing a management action. */
export interface ManagerRef {
  role: Role;
  useCaseKey: string | null;
}

/** Roles allowed to provision other users. */
export function canManageUsers(role: Role): boolean {
  return role === "PlatformAdmin" || role === "UseCaseAdmin";
}

/** Which roles a given manager may assign to a new user. */
export function assignableRoles(role: Role): Role[] {
  if (role === "PlatformAdmin") return ["UseCaseAdmin"];
  if (role === "UseCaseAdmin") return ["Issuer", "Buyer", "Auditor"];
  return [];
}

/**
 * May `manager` create a user with `targetRole` in `targetUseCaseKey`?
 * - PlatformAdmin: only UseCaseAdmin, and a use case must be named.
 * - UseCaseAdmin: only roster roles, and only in their own use case.
 */
export function canCreateUser(manager: ManagerRef, targetRole: Role, targetUseCaseKey: string | null): boolean {
  if (!assignableRoles(manager.role).includes(targetRole)) return false;
  if (manager.role === "PlatformAdmin") return targetUseCaseKey !== null;
  if (manager.role === "UseCaseAdmin") return targetUseCaseKey !== null && targetUseCaseKey === manager.useCaseKey;
  return false;
}
