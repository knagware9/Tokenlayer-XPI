export * from "./types.js";
export * from "./errors.js";
export * from "./validation.js";
export * from "./use-case-registry.js";
export * from "./use-case-source.js";
export * from "./rbac.js";
export * from "./lifecycle-engine.js";
export * from "./user-policy.js";
export * from "./credential-types.js";
export { invoiceFingerprint, type InvoiceFingerprintInput } from "./invoice-fingerprint.js";
export { computeCashflowSchedule, splitProRata, type TermsConfig, type ScheduledCashflow } from "./cashflows.js";
export { auditGenesis, auditEntryHash, verifyChain, type AuditChainFields, type ChainEntry, type VerifyResult } from "./audit-chain.js";
// Explicit re-export (not `export *`) because identity's `IssueInput` would
// otherwise collide with lifecycle-engine's asset `IssueInput` (TS2308).
export {
  didKeyFromPublicKey,
  publicKeyFromDidKey,
  generateDidKey,
  didKeyFromSeed,
  signJwt,
  decodeJwt,
  verifyJwtSignature,
  issueCredential,
  presentCredential,
  verifyPresentation,
  type DidKey,
  type IssueInput as CredentialIssueInput,
  type PresentInput,
  type VerifiedCredential,
  type PresentationResult,
  type VerifyInput,
} from "./identity.js";
