/**
 * The credential catalog: every type the platform can issue, with the claim
 * schema it must satisfy, who may issue it, and how many approvals it needs.
 *
 * This is deliberately a closed, typed registry. Claims are validated against
 * `claimSchema` with the same `validateMetadata` used for use-case issuance
 * metadata — an unvalidated claim set must never reach a signed credential.
 */
import { PolicyError } from "../shared/errors.js";
import type { MetadataSchema, OrgType } from "../shared/types.js";

export type CredentialType = "KycCredential" | "AccreditedInvestor" | "AuthorizedSignatory" | "OrganizationCredential";

export interface CredentialTypeDefinition {
  type: CredentialType;
  description: string;
  /** orgTypes permitted to issue this credential. */
  allowedIssuerOrgTypes: OrgType[];
  /** Approvals required before issuance or revocation takes effect. Always >= 1. */
  requiredApprovals: number;
  /** Claim shape the request must satisfy (validated via validateMetadata). */
  claimSchema: MetadataSchema;
  validityDays: number;
  /** When true, the issuing org must be the subject's own org. */
  selfIssuedOnly?: boolean;
}

export const CREDENTIAL_TYPES: Record<CredentialType, CredentialTypeDefinition> = {
  KycCredential: {
    type: "KycCredential",
    description: "Know-your-customer verification of a natural or legal person.",
    allowedIssuerOrgTypes: ["verifier", "bank", "government"],
    requiredApprovals: 1,
    validityDays: 365,
    claimSchema: {
      type: "object",
      required: ["legalName", "country"],
      properties: {
        legalName: { type: "string", description: "Verified legal name" },
        country: { type: "string", description: "ISO 3166-1 alpha-2 country code", pattern: "^[A-Z]{2}$" },
        idType: { type: "string", description: "Identity document type", enum: ["passport", "national-id", "driving-licence"] },
        idNumber: { type: "string", description: "Identity document number" },
      },
    },
  },
  AccreditedInvestor: {
    type: "AccreditedInvestor",
    description: "Attests the subject qualifies as an accredited/professional investor.",
    allowedIssuerOrgTypes: ["verifier", "bank"],
    requiredApprovals: 1,
    validityDays: 365,
    claimSchema: {
      type: "object",
      required: ["basis", "jurisdiction"],
      properties: {
        basis: { type: "string", description: "Basis of accreditation", enum: ["income", "net-worth", "professional"] },
        jurisdiction: { type: "string", description: "Jurisdiction the accreditation is asserted under", pattern: "^[A-Z]{2}$" },
      },
    },
  },
  AuthorizedSignatory: {
    type: "AuthorizedSignatory",
    description: "Declares that the subject may act for the issuing organization.",
    // Any org may declare its own signatories — but only its own (selfIssuedOnly).
    allowedIssuerOrgTypes: ["bank", "corporate", "msme", "government", "verifier"],
    // Two approvals: this credential confers authority to act for the org, the
    // highest-stakes claim in the catalog.
    requiredApprovals: 2,
    validityDays: 365,
    selfIssuedOnly: true,
    claimSchema: {
      type: "object",
      required: ["role", "scope"],
      properties: {
        role: { type: "string", description: "Title the signatory holds" },
        scope: { type: "string", description: "What they may authorize", enum: ["issuance", "treasury", "all"] },
      },
    },
  },
  OrganizationCredential: {
    type: "OrganizationCredential",
    description: "Attests a legal entity's verified registration (KYB) and binds it to its organization DID.",
    // Issued by the platform (a verifier org) at corporate approval; also
    // requestable through the standard maker-checker path by verifier orgs.
    allowedIssuerOrgTypes: ["verifier"],
    requiredApprovals: 1,
    validityDays: 365,
    claimSchema: {
      type: "object",
      required: ["name", "cin", "pan"],
      properties: {
        name: { type: "string", description: "Registered legal name" },
        cin: { type: "string", description: "Corporate Identity Number" },
        pan: { type: "string", description: "Permanent Account Number" },
        gstin: { type: "string", description: "GST identification number" },
        state: { type: "string", description: "State of registration" },
        pincode: { type: "string", description: "Registered-office pincode" },
        dateOfIncorporation: { type: "string", description: "ISO date of incorporation" },
        category: { type: "string", description: "Legal structure (private-limited, llp, …)" },
        orgType: { type: "string", description: "Platform organization type" },
      },
    },
  },
};

/** The definition for `type`, or a coded PolicyError (→ HTTP 400) if unknown. */
export function credentialTypeDef(type: string): CredentialTypeDefinition {
  const def = CREDENTIAL_TYPES[type as CredentialType];
  if (!def) {
    throw new PolicyError("UNKNOWN_CREDENTIAL_TYPE", `unknown credential type '${type}'`, { type, known: Object.keys(CREDENTIAL_TYPES) });
  }
  return def;
}
