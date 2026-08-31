/**
 * IDENTITY PERSISTENCE CONTRACTS — credential programmes and verification.
 *
 * Everything `model-domains.ts` marks `"identity"`. Note what is NOT here:
 * `Credential` itself is SHARED, because organization membership is built on
 * verifiable credentials and both products need that.
 */
import type { CredentialUseCaseDefinition, UseCaseTemplate } from "@tokenlayer/core";
import type { FieldRequest, ResolvedDisclosure } from "../../identity/selective-disclosure.js";

export interface CredentialUseCaseRepository {
  create(def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition>;
  get(key: string): Promise<CredentialUseCaseDefinition | null>;
  has(key: string): Promise<boolean>;
  list(): Promise<CredentialUseCaseDefinition[]>;
  update(key: string, def: CredentialUseCaseDefinition): Promise<CredentialUseCaseDefinition>;
}

/** Customer-saved use-case templates (built-in templates live in TEMPLATE_CATALOG, not persisted). */
export interface CredentialUseCaseTemplateRepository {
  list(): Promise<UseCaseTemplate[]>;
  get(key: string): Promise<UseCaseTemplate | null>;
  create(t: UseCaseTemplate): Promise<UseCaseTemplate>;
}

/** A secondary-market sell listing. `quantity` is the REMAINING quantity. */
export type VerificationStatus = "pending" | "consented" | "rejected" | "expired";

export interface VerificationRequestRecord {
  id: string;
  verifierOrgId: string;
  holderDid: string;
  requestedTypes: string[];
  purpose: string;
  credentialUseCaseKey: string | null;
  challenge: string;
  status: VerificationStatus;
  presentationVpJwt: string | null;
  consentedAt: string | null;
  consentedCredentialIds: string[] | null;
  /** The verifier's advisory per-field ask, set at create time. Never a floor
   *  on disclosure — see `consentedDisclosures`. */
  requestedFields: Record<string, Record<string, FieldRequest>> | null;
  /** What the holder actually chose to disclose, resolved (predicates
   *  evaluated to a boolean, never a raw value) at consent time. `null` means
   *  "no `disclosures` was supplied" — every field of every consented
   *  credential discloses in full, same as before this feature existed. */
  consentedDisclosures: Record<string, Record<string, ResolvedDisclosure>> | null;
  verifierResult: Record<string, unknown> | null;
  verifiedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface VerificationRequestRepository {
  create(input: Omit<VerificationRequestRecord, "id" | "createdAt">): Promise<VerificationRequestRecord>;
  get(id: string): Promise<VerificationRequestRecord | null>;
  listByHolder(holderDid: string, status?: string): Promise<VerificationRequestRecord[]>;
  listByVerifierOrg(orgId: string, status?: string): Promise<VerificationRequestRecord[]>;
  /** Every stored request, unordered — dashboard aggregation input (callers sort/filter). */
  list(): Promise<VerificationRequestRecord[]>;
  setConsented(id: string, input: { vpJwt: string; credentialIds: string[]; at: string; disclosures: Record<string, Record<string, ResolvedDisclosure>> | null }): Promise<VerificationRequestRecord>;
  setStatus(id: string, status: VerificationStatus): Promise<VerificationRequestRecord>;
  setVerifierResult(id: string, input: { result: Record<string, unknown>; at: string }): Promise<VerificationRequestRecord>;
}

