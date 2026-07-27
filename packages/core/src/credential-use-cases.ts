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
    name: "KycCredential", title: "KYC Verification", validityDays: 365,
    claimSchema: { type: "object", required: ["legalName", "country"], properties: {
      legalName: { type: "string" }, country: { type: "string", pattern: "^[A-Z]{2}$" },
      idType: { type: "string" }, idNumber: { type: "string" } } },
  },
  MCACredential: {
    name: "MCACredential", title: "MCA Company Master", validityDays: 365,
    claimSchema: { type: "object", required: ["cin", "companyName"], properties: {
      cin: { type: "string" }, companyName: { type: "string" },
      incorporationDate: { type: "string" }, companyStatus: { type: "string" } } },
  },
  GSTINCredential: {
    name: "GSTINCredential", title: "GSTIN Registration", validityDays: 365,
    claimSchema: { type: "object", required: ["gstin", "legalName"], properties: {
      gstin: { type: "string" }, legalName: { type: "string" }, stateCode: { type: "string" } } },
  },
  EmploymentCredential: {
    name: "EmploymentCredential", title: "Employment", validityDays: 365,
    claimSchema: { type: "object", required: ["employeeName", "employer"], properties: {
      employeeName: { type: "string" }, employer: { type: "string" }, title: { type: "string" } } },
  },
  OrganizationMembership: {
    name: "OrganizationMembership", title: "Organization Membership", validityDays: 365,
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
    validateMetadataSchema(ct.claimSchema, `${def.key}:${ct.name}`, fail);
  }
  if (def.issuer.kind === "org" && !ctx.orgExists(def.issuer.orgId)) fail(`unknown issuer org '${def.issuer.orgId}'`);
  if (def.holderPolicy.who === "specific") for (const id of def.holderPolicy.orgIds) if (!ctx.orgExists(id)) fail(`unknown holder org '${id}'`);
  if (def.verifier.kind === "orgs") for (const id of def.verifier.orgIds) if (!ctx.orgExists(id)) fail(`unknown verifier org '${id}'`);
}
