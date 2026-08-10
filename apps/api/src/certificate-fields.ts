/**
 * EN-F: credential → the strings a certificate prints. Shared by the built-in
 * renderer (subject name only) and the artwork renderer (the whole map), so the
 * two cannot disagree about who the holder is.
 */
import type { CertificateFieldRef, CredentialTypeSpec } from "@tokenlayer/core";
import type { CredentialRecord } from "./persistence/types.js";

/** First non-blank of fullName / legalName / holderName, else the holder DID.
 *  A certificate with a blank name line is worse than one showing a DID. */
export function certificateSubjectName(credential: CredentialRecord): string {
  const claims = (credential.subjectClaims ?? {}) as Record<string, unknown>;
  for (const key of ["fullName", "legalName", "holderName"]) {
    const v = claims[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return credential.holderDid;
}

export interface ResolveCertificateFieldsInput {
  credential: CredentialRecord;
  spec: CredentialTypeSpec;
  issuerName: string | null;
}

const asDate = (iso: string): string => new Date(iso).toLocaleDateString();

/**
 * Every printable value, keyed by field ref. A field with no value is ABSENT
 * rather than empty-string, so the draw list can skip it and a placement for a
 * claim the holder does not have simply prints nothing — which is the whole of
 * the "conditional visibility" the spec deliberately excluded.
 *
 * `qr` never appears: it is an op, not a string.
 */
export function resolveCertificateFields(input: ResolveCertificateFieldsInput): Map<CertificateFieldRef, string> {
  const { credential: c, spec, issuerName } = input;
  const claims = (c.subjectClaims ?? {}) as Record<string, unknown>;
  const out = new Map<CertificateFieldRef, string>();
  const put = (k: CertificateFieldRef, v: string | null | undefined): void => {
    if (v !== null && v !== undefined && String(v).trim()) out.set(k, String(v));
  };

  for (const [key, value] of Object.entries(claims)) {
    if (key === "id") continue; // never a printable claim; matches the built-in renderer
    put(`claim:${key}`, value === null || value === undefined ? null : String(value));
  }

  put("subject.name", certificateSubjectName(c));
  put("subject.did", c.holderDid);
  put("credential.id", c.id);
  put("credential.type", spec.title);
  put("credential.issuedAt", asDate(c.issuedAt));
  // Not left blank: an empty expiry line reads as a rendering bug.
  put("credential.expiresAt", c.expiresAt ? asDate(c.expiresAt) : "No expiry");
  put("issuer.name", issuerName ?? c.issuerDid);
  put("issuer.did", c.issuerDid);
  put("config.heading", spec.certificate?.heading?.trim() || spec.title);
  put("config.subheading", spec.certificate?.subheading);

  return out;
}
