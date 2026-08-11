/**
 * EN-F: credential → the strings a certificate prints. Shared by the built-in
 * renderer (subject name only) and the artwork renderer (the whole map), so the
 * two cannot disagree about who the holder is.
 */
import type { CertificateFieldRef, CredentialTypeSpec } from "@tokenlayer/core";
import type { CredentialRecord } from "./persistence/types.js";

/**
 * First non-blank of fullName / legalName / holderName, else the holder DID.
 * A certificate with a blank name line is worse than one showing a DID.
 *
 * NOT byte-identical to the inline expression this replaced, and the difference
 * is deliberate. The old chain was `(typeof v === "string" && v) || …`, which
 * takes the value UNTRIMMED and treats any non-empty string as a win — so
 * `fullName: "   "` printed three spaces where a name should be instead of
 * falling through, and `" Ada "` printed its padding. Both are plausible
 * outputs of a real form. This trims and tests the trimmed value, so whitespace
 * falls through and padding is dropped.
 *
 * Recorded because the plan called the extraction "behaviour-preserving" and it
 * is not: it is a small, intentional improvement to two edge cases that no
 * existing test covered. If a certificate ever needs to print a name exactly as
 * captured, that is a change here, not an accident to discover later.
 */
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

/**
 * EN-E: which logo a certificate should print: the type's own, else the
 * issuing org's brand, else none. MOST-SPECIFIC-WINS — a credential type that
 * already names its own `logoDocumentId` is untouched by an org branding
 * itself later, which is the whole point of "the org brand is a default, not
 * an override".
 *
 * A SUCCESSFUL artwork render never reaches this function: the route skips the
 * built-in logo lookup once `certificate.background` is set, and
 * `certificateDrawList`'s input has no field a logo could travel through, so
 * that much is enforced by the type checker rather than a runtime branch.
 *
 * A FAILED one does reach it, and should. When the artwork is deleted or
 * undecodable the route logs, leaves the PDF null and falls back to the
 * built-in layout — which is a layout with a logo slot, so it wants this
 * answer. An earlier version of this comment claimed artwork mode "never
 * reaches this function at all", which is the kind of invariant a later author
 * would build on; it was never true of the fallback path.
 *
 * `||`, not `??`. `validateCredentialUseCase` accepts `logoDocumentId: ""`,
 * and `"" ?? x` is `""` — an empty string would suppress the org fallback and
 * print no logo at all, which is not what "a type that already NAMES its own
 * logo" means. Blank is unset.
 */
export function certificateLogoDocumentId(
  spec: { certificate?: { logoDocumentId?: string } },
  issuerOrg: { brandLogoDocumentId: string | null } | null,
): string | null {
  return spec.certificate?.logoDocumentId?.trim() || issuerOrg?.brandLogoDocumentId || null;
}
