/**
 * THE PUBLIC PORTAL'S JUDGEMENT CALLS, kept out of the component so they can be
 * tested — and because they are the part that must not drift.
 *
 * `verdictOf` and `provenanceOf` are separate on purpose. A credential can be
 * REVOKED and that revocation confirmed on-chain; it can be VALID on this
 * platform's word alone. Folding the two into one badge is the overclaim the
 * portal exists to avoid: a reader would take "green" to mean "independently
 * confirmed" when it may mean nothing of the sort.
 */
import type { CredentialStatusInfo } from "../../types.js";

/**
 * Pull a credential id out of whatever the user actually pasted.
 *
 * People do not paste ids; they paste the URL from a QR code, the status link
 * out of a PDF, or the id with a stray space. Accepting only a bare id would
 * make the page look broken for the commonest input it will ever receive.
 */
export function credentialIdFrom(input: string): string {
  const t = input.trim();
  if (!t) return "";
  // …/credentials/<id>/status, …/credentials/<id>/certificate.pdf, or a plain id.
  const m = /\/credentials\/([^/?#]+)/.exec(t);
  if (m?.[1]) return decodeURIComponent(m[1]);
  try {
    const q = new URL(t).searchParams.get("id");
    if (q) return q;
  } catch { /* not a URL — fall through to the raw value */ }
  return t;
}

/** The verdict a reader should walk away with, and how loudly to say it. */
type Verdict = { tone: "ok" | "warn" | "danger" | "muted"; headline: string; detail: string };

export function verdictOf(s: CredentialStatusInfo): Verdict {
  if (s.revoked) {
    return {
      tone: "danger",
      headline: "Revoked",
      detail: s.reason
        ? `The issuer withdrew this credential — stated reason: ${s.reason}.`
        : "The issuer withdrew this credential. It should not be relied on.",
    };
  }
  // Acceptance is only present once the ceremony has actually happened, so its
  // absence means "accepted" — not "unknown".
  if (s.acceptance && s.acceptance !== "accepted") {
    return {
      tone: "warn",
      headline: "Not yet accepted",
      detail: `Issued, but the holder has not accepted it (${s.acceptance}). It is not in force.`,
    };
  }
  return { tone: "ok", headline: "Valid", detail: "Issued, not revoked, and accepted by its holder." };
}

/**
 * How this answer was reached — the distinction rule 1 exists to protect.
 * Separate from the verdict because a REVOKED credential can be confirmed
 * on-chain, and a VALID one might be attested by the platform alone; collapsing
 * them into one badge is exactly the overclaim to avoid.
 */
export function provenanceOf(s: CredentialStatusInfo): { tone: "ok" | "warn" | "muted"; label: string; detail: string } {
  if (s.source === "chain") {
    return {
      tone: "ok",
      label: "Confirmed on-chain",
      detail: "Read from the credential registry contract on the ledger, not from this platform's database.",
    };
  }
  return {
    tone: "warn",
    label: "Platform record only",
    detail: "This deployment anchors no on-chain registry, or the anchor is missing — so this answer rests on the platform's own record and nothing independent.",
  };
}
