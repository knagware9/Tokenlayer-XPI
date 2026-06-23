export type PolicyErrorCode =
  | "FORBIDDEN"
  | "ACTION_DISABLED"
  | "ALLOWLIST_DISABLED"
  | "NOT_ALLOWLISTED"
  | "ACCOUNT_FROZEN"
  | "UNKNOWN_USECASE"
  | "INVALID_METADATA"
  | "INVALID_USECASE"
  | "CHAIN_NOT_ALLOWED"
  | "WRONG_TOKEN_TYPE"
  | "INSUFFICIENT_FUNDS";

/** Raised when a request violates RBAC, lifecycle, or compliance policy. */
export class PolicyError extends Error {
  readonly code: PolicyErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: PolicyErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
    this.details = details;
  }
}
