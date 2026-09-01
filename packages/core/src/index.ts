export * from "./shared/types.js";
export * from "./shared/errors.js";
export * from "./shared/validation.js";
export * from "./tokenization/use-case-registry.js";
export * from "./tokenization/use-case-source.js";
export * from "./shared/rbac.js";
export * from "./tokenization/lifecycle-engine.js";
export * from "./shared/user-policy.js";
export { useCaseDomainOf, type UseCaseDomain } from "./shared/use-case-domain.js";
export * from "./identity/credential-types.js";
export * from "./identity/credential-use-cases.js";
export * from "./identity/certificate-fields.js";
export * from "./shared/branding.js";
export * from "./identity/use-case-templates.js";
export { invoiceFingerprint, genericMetadataFingerprint, type InvoiceFingerprintInput } from "./tokenization/invoice-fingerprint.js";
export { computeCashflowSchedule, splitProRata, type TermsConfig, type ScheduledCashflow } from "./tokenization/cashflows.js";
export { auditGenesis, auditEntryHash, verifyChain, type AuditChainFields, type ChainEntry, type VerifyResult } from "./shared/audit-chain.js";
export { ORG_DOMAINS, ORG_OPERATING_ROLES, orgDomainEnabled, orgRoleEnabled, validateOrgCapabilities, type OrgDomain, type OrgOperatingRole, type OrgCapabilities } from "./shared/org-capabilities.js";
export { API_SCOPES, API_SCOPE_RESOURCES, scopeAllows, validateScopes, type ApiScope, type ApiScopeGrant } from "./shared/api-scopes.js";
export {
  PERSONAS, DELIBERATELY_UNREACHABLE, personaByKey, personaRules, personaAllows, personaMethodsFor, personasForDomain,
  type PersonaKey, type PersonaDomain, type PersonaDef, type PersonaRule, type MethodSet, type HttpMethod,
} from "./shared/personas.js";
export { EVENT_TYPES, isEventType, validateEventTypes, type EventType, type EventSubscription } from "./shared/events.js";
export { scrubEvent, type ScrubbableEvent } from "./shared/pii-scrub.js";
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
  verifyDidSignature,
  issueCredential,
  presentCredential,
  verifyPresentation,
  presentCredentials,
  verifyPresentationCredentials,
  type DidKey,
  type IssueInput as CredentialIssueInput,
  type PresentInput,
  type VerifiedCredential,
  type PresentationResult,
  type VerifyInput,
  type PresentManyInput,
  type PerCredentialResult,
  type MultiPresentationResult,
  type VerifyManyInput,
} from "./identity/did-vc.js";
