export type PolicyErrorCode =
  | "FORBIDDEN"
  | "ACTION_DISABLED"
  | "ALLOWLIST_DISABLED"
  | "NOT_ALLOWLISTED"
  | "ACCOUNT_FROZEN"
  | "UNKNOWN_USECASE"
  | "INVALID_METADATA"
  | "INVALID_USECASE"
  // EN-F: distinct from INVALID_USECASE — "your chip is off the page" and
  // "your use case is malformed" have different fixes, and callers (the 400
  // handler, the designer UI) branch on the code rather than sniffing the
  // message.
  | "INVALID_CERTIFICATE_PLACEMENT"
  | "INVALID_TERMS"
  | "CHAIN_NOT_ALLOWED"
  | "USE_CASE_NOT_DEPLOYED_ON_CHAIN"
  | "WRONG_TOKEN_TYPE"
  | "INSUFFICIENT_FUNDS"
  | "HOLDER_LIMIT_EXCEEDED"
  | "LOCKUP_ACTIVE"
  | "JURISDICTION_NOT_ALLOWED"
  | "IDENTITY_NOT_VERIFIED"
  | "UNKNOWN_CREDENTIAL_TYPE"
  | "INVALID_TEMPLATE"
  | "INVALID_TEMPLATE_PARAMS"
  | "UNKNOWN_TEMPLATE"
  | "INVALID_CAPABILITIES"
  | "INVALID_SCOPES"
  | "INVALID_EVENT_TYPES"
  | "UNKNOWN_EVENT_TYPE";

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
