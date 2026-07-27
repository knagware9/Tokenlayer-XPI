/**
 * The Identity domain's configurable "credential use case": custom credential
 * types (claim schemas) plus Issuer / Holder / Verifier bindings. Parallel to
 * the tokenization UseCaseDefinition, sharing the metadata-schema validator.
 */
import { PolicyError } from "./errors.js";
import type { MetadataSchema, OrgType } from "./types.js";
import { validateMetadataSchema } from "./validation.js";

export interface CredentialTypeSpec {
  /** Machine name, unique within the use case, e.g. "MCACredential". */
  name: string;
  /** Human label, e.g. "MCA Company Master". */
  title: string;
  /** Claim shape (same schema the token builder emits for metadataSchema). */
  claimSchema: MetadataSchema;
  /** Days the issued credential remains valid. */
  validityDays: number;
  /** Maker-checker approvals needed to issue this type. Missing ⇒ 1. */
  requiredApprovals: number;
}

export type IssuerBinding = { kind: "platform" } | { kind: "org"; orgId: string };
export type HolderPolicy =
  | { who: "any-onboarded" }
  | { who: "orgType"; orgTypes: OrgType[] }
  | { who: "specific"; orgIds: string[] };
export type VerifierBinding = { kind: "any" } | { kind: "orgs"; orgIds: string[] };

export interface CredentialUseCaseDefinition {
  key: string;
  name: string;
  description?: string;
  credentialTypes: CredentialTypeSpec[];
  issuer: IssuerBinding;
  holderPolicy: HolderPolicy;
  verifier: VerifierBinding;
  /** Owning organization id (null/undefined for platform-owned). */
  ownerOrgId?: string | null;
}

/** Editable starter templates surfaced by the builder. */
export const CREDENTIAL_TEMPLATES: Record<string, CredentialTypeSpec> = {
  KycCredential: {
    name: "KycCredential", title: "KYC Verification", validityDays: 365, requiredApprovals: 1,
    claimSchema: { type: "object", required: ["legalName", "country"], properties: {
      legalName: { type: "string" }, country: { type: "string", pattern: "^[A-Z]{2}$" },
      idType: { type: "string" }, idNumber: { type: "string" } } },
  },
  MCACredential: {
    name: "MCACredential", title: "MCA Company Master", validityDays: 365, requiredApprovals: 1,
    claimSchema: { type: "object", required: ["cin", "companyName"], properties: {
      cin: { type: "string" }, companyName: { type: "string" },
      incorporationDate: { type: "string" }, companyStatus: { type: "string" } } },
  },
  GSTINCredential: {
    name: "GSTINCredential", title: "GSTIN Registration", validityDays: 365, requiredApprovals: 1,
    claimSchema: { type: "object", required: ["gstin", "legalName"], properties: {
      gstin: { type: "string" }, legalName: { type: "string" }, stateCode: { type: "string" } } },
  },
  EmploymentCredential: {
    name: "EmploymentCredential", title: "Employment", validityDays: 365, requiredApprovals: 1,
    claimSchema: { type: "object", required: ["employeeName", "employer"], properties: {
      employeeName: { type: "string" }, employer: { type: "string" }, title: { type: "string" } } },
  },
  OrganizationMembership: {
    name: "OrganizationMembership", title: "Organization Membership", validityDays: 365, requiredApprovals: 1,
    claimSchema: { type: "object", required: ["organization", "role"], properties: {
      organization: { type: "string" }, role: { type: "string" }, memberSince: { type: "string" } } },
  },
};

/** Throws PolicyError on any structural problem. `orgExists` checks org ids. */
export function validateCredentialUseCase(
  def: CredentialUseCaseDefinition,
  ctx: { orgExists: (id: string) => boolean },
): void {
  const fail = (msg: string): never => { throw new PolicyError("INVALID_USECASE", msg); };
  if (!def.key || !/^[a-z0-9-]+$/.test(def.key)) fail("key must be a non-empty lowercase slug");
  if (!def.name?.trim()) fail("name is required");
  if (!Array.isArray(def.credentialTypes) || def.credentialTypes.length === 0) fail("at least one credential type is required");
  const seen = new Set<string>();
  for (const ct of def.credentialTypes) {
    if (!ct.name?.trim()) fail("each credential type needs a name");
    if (seen.has(ct.name)) fail(`duplicate credential-type name '${ct.name}'`);
    seen.add(ct.name);
    if (!(ct.validityDays > 0)) fail(`credential type '${ct.name}' needs a positive validityDays`);
    if (ct.requiredApprovals !== undefined && !(Number.isInteger(ct.requiredApprovals) && ct.requiredApprovals >= 1))
      fail(`credential type '${ct.name}' has an invalid requiredApprovals (must be an integer >= 1)`);
    validateMetadataSchema(ct.claimSchema, `${def.key}:${ct.name}`, fail);
  }
  if (def.issuer.kind === "org" && !ctx.orgExists(def.issuer.orgId)) fail(`unknown issuer org '${def.issuer.orgId}'`);
  if (def.holderPolicy.who === "specific") for (const id of def.holderPolicy.orgIds) if (!ctx.orgExists(id)) fail(`unknown holder org '${id}'`);
  if (def.verifier.kind === "orgs") for (const id of def.verifier.orgIds) if (!ctx.orgExists(id)) fail(`unknown verifier org '${id}'`);
}

/** Resolve a credential type within a use case by name. Normalises a missing
 *  requiredApprovals to 1. Throws UNKNOWN_CREDENTIAL_TYPE when absent. */
export function credentialUseCaseType(def: CredentialUseCaseDefinition, typeName: string): CredentialTypeSpec {
  const spec = def.credentialTypes.find((t) => t.name === typeName);
  if (!spec) throw new PolicyError("UNKNOWN_CREDENTIAL_TYPE", `unknown credential type '${typeName}' in use case '${def.key}'`);
  const requiredApprovals = Number.isInteger(spec.requiredApprovals) && spec.requiredApprovals >= 1 ? spec.requiredApprovals : 1;
  return { ...spec, requiredApprovals };
}

/** May the caller act as this use case's issuer? A PlatformAdmin may act as any
 *  bound issuer; an OrgAdmin only for an `org` binding to their own org. */
export function issuerBindingAllows(binding: IssuerBinding, ctx: { callerOrgId: string | null; isPlatformAdmin: boolean }): boolean {
  if (ctx.isPlatformAdmin) return true;
  return binding.kind === "org" && !!ctx.callerOrgId && binding.orgId === ctx.callerOrgId;
}

/** May this holder org hold a credential of this use case? */
export function holderPolicyAllows(policy: HolderPolicy, holderOrg: { id: string; orgType: OrgType } | null): boolean {
  switch (policy.who) {
    case "any-onboarded": return true;
    case "orgType": return !!holderOrg && policy.orgTypes.includes(holderOrg.orgType);
    case "specific": return !!holderOrg && policy.orgIds.includes(holderOrg.id);
  }
}

/** May this verifier org request proofs for this use case? */
export function verifierBindingAllows(binding: VerifierBinding, verifierOrgId: string): boolean {
  return binding.kind === "any" || binding.orgIds.includes(verifierOrgId);
}
