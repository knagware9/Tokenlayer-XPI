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
  OrgAdmin: ["read"],
  // Manages the use case, not the investor side of it — keeps every operator
  // action but not the marketplace-investor actions (buy/list/cancel-listing).
  UseCaseAdmin: ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "read"],
  Issuer: ["issue", "mint", "allow", "disallow", "freeze", "unfreeze", "read"],
  Trader: ["transfer", "burn", "buy", "list", "cancel-listing", "read"],
  Buyer: ["read", "buy", "list", "cancel-listing"],
  Auditor: ["read"],
  Holder: ["read"],
  Verifier: ["read"],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].includes(action);
}

/** Roles that can manage a use case's user roster. */
export function canManageUsers(role: Role): boolean {
  return role === "PlatformAdmin" || role === "OrgAdmin" || role === "UseCaseAdmin";
}

/** Which roles a given manager may assign to a new user. Mirrors core's user-policy. */
export function assignableRoles(role: Role, domain: "tokenization" | "identity" = "tokenization"): Role[] {
  const adminRoster: Role[] = domain === "identity" ? ["Issuer", "Holder", "Verifier"] : ["Issuer", "Trader", "Buyer", "Auditor"];
  const ucaRoster: Role[] = domain === "identity" ? ["Issuer", "Holder", "Verifier"] : ["Issuer", "Buyer", "Auditor"];
  if (role === "PlatformAdmin" || role === "OrgAdmin") return ["UseCaseAdmin", ...adminRoster];
  if (role === "UseCaseAdmin") return ucaRoster;
  return [];
}
