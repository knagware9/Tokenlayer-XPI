import type { Role } from "./types.js";

export type Action =
  | "issue"
  | "mint"
  | "transfer"
  | "burn"
  | "freeze"
  | "unfreeze"
  | "allow"
  | "disallow"
  | "buy"
  | "list"
  | "cancel-listing"
  | "read";

// Mirrors the server's RbacPolicy so the UI hides actions the role can't perform.
// The server remains the source of truth and re-checks every request.
const MATRIX: Record<Role, Action[]> = {
  PlatformAdmin: ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "buy", "list", "cancel-listing", "read"],
  UseCaseAdmin: ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "buy", "list", "cancel-listing", "read"],
  Issuer: ["issue", "mint", "allow", "disallow", "freeze", "unfreeze", "read"],
  Trader: ["transfer", "burn", "buy", "list", "cancel-listing", "read"],
  Buyer: ["read", "buy", "list", "cancel-listing"],
  Auditor: ["read"],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].includes(action);
}

/** Roles that can manage a use case's user roster. */
export function canManageUsers(role: Role): boolean {
  return role === "PlatformAdmin" || role === "UseCaseAdmin";
}
