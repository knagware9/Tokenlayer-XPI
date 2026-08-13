/**
 * WHAT A SCHEME'S NUMBERS MEAN — the rollup behind the scheme console.
 *
 * A scheme here is a CREDENTIAL PROGRAMME: one credential use case, its
 * beneficiaries, and the credentials it has issued them. Nothing new is stored
 * for it; these functions are the read model over what the issuer already has.
 *
 * THE DISTINCTION THAT MATTERS, and the reason this is a tested module rather
 * than inline JSX: "issued" is not "in force". A credential can be issued and
 * revoked, issued and never accepted by the holder, or issued and lapsed. An
 * operator reporting on a scheme needs those apart — a single "issued: 4,812"
 * is the number that gets quoted in a review and is wrong in every direction at
 * once.
 *
 * PRECEDENCE IS DELIBERATE: revoked beats everything (the issuer withdrew it),
 * then acceptance (the holder never took it up), then expiry. The same order
 * the identity dashboard and the certificate renderer use — a beneficiary must
 * not be counted "active" in one screen and "lapsed" in another.
 */
import type { CredentialUseCase, IssuedCredential } from "../types.js";

export type BeneficiaryStatus = "revoked" | "pending" | "rejected" | "expired" | "active";

/** One credential's standing, by the precedence above. */
export function statusOf(c: IssuedCredential, nowMs: number = Date.now()): BeneficiaryStatus {
  if (c.revoked) return "revoked";
  // `acceptance` is absent on a credential that was born accepted and never
  // went through the ceremony — absence means accepted, not unknown.
  if (c.acceptance === "pending") return "pending";
  if (c.acceptance === "rejected" || c.acceptance === "changes_requested") return "rejected";
  // Instants, not strings: a timestamp carrying an offset sorts wrongly as text
  // (the same rule the server's identity predicate follows).
  if (c.expiresAt !== null && Date.parse(c.expiresAt) < nowMs) return "expired";
  return "active";
}

export interface SchemeCounts {
  /** Distinct holders with at least one credential in this scheme. */
  beneficiaries: number;
  issued: number;
  active: number;
  pending: number;
  revoked: number;
  expired: number;
  rejected: number;
  /** Active today, lapsing within 30 days — the operator's actual work queue. */
  expiringSoon: number;
}

const EXPIRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function countsFor(credentials: IssuedCredential[], nowMs: number = Date.now()): SchemeCounts {
  const counts: SchemeCounts = {
    beneficiaries: new Set(credentials.map((c) => c.holderDid)).size,
    issued: credentials.length,
    active: 0, pending: 0, revoked: 0, expired: 0, rejected: 0, expiringSoon: 0,
  };
  for (const c of credentials) {
    const s = statusOf(c, nowMs);
    counts[s] += 1;
    if (s === "active" && c.expiresAt !== null) {
      const at = Date.parse(c.expiresAt);
      if (at >= nowMs && at - nowMs <= EXPIRY_WINDOW_MS) counts.expiringSoon += 1;
    }
  }
  return counts;
}

/**
 * Credentials grouped by the programme that issued them.
 *
 * A null `credentialUseCaseKey` is NOT a scheme — it is a platform-catalog
 * credential (the KycCredential minted at onboarding, an organization
 * credential). Folding those into a scheme would inflate every count with
 * enrolment paperwork; they are returned separately so a caller can show them
 * for what they are rather than silently dropping them.
 */
export function groupByScheme(credentials: IssuedCredential[]): {
  byScheme: Map<string, IssuedCredential[]>;
  unscoped: IssuedCredential[];
} {
  const byScheme = new Map<string, IssuedCredential[]>();
  const unscoped: IssuedCredential[] = [];
  for (const c of credentials) {
    const key = c.credentialUseCaseKey ?? null;
    if (key === null) { unscoped.push(c); continue; }
    const list = byScheme.get(key);
    if (list) list.push(c); else byScheme.set(key, [c]);
  }
  return { byScheme, unscoped };
}

/** One beneficiary: a holder DID and everything this scheme issued them. */
export interface BeneficiaryRow {
  holderDid: string;
  /** Best label available from the claims — schemes name their subject differently. */
  name: string | null;
  status: BeneficiaryStatus;
  latest: IssuedCredential;
  credentials: IssuedCredential[];
}

/** The claim keys a subject's name hides behind, in order of preference. */
const NAME_KEYS = ["holderName", "legalName", "name", "businessName", "fullName"];

export function nameFrom(claims: Record<string, unknown>): string | null {
  for (const k of NAME_KEYS) {
    const v = claims[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * The beneficiary register: one row per holder, newest credential first.
 *
 * A holder can hold several credentials in one scheme (a reissue, a correction,
 * a renewal). The ROW's status is the newest credential's, because that is the
 * one in force — summing statuses across a holder's history would report
 * someone whose lapsed certificate was reissued last week as both expired and
 * active.
 */
export function beneficiariesOf(credentials: IssuedCredential[], nowMs: number = Date.now()): BeneficiaryRow[] {
  const byHolder = new Map<string, IssuedCredential[]>();
  for (const c of credentials) {
    const list = byHolder.get(c.holderDid);
    if (list) list.push(c); else byHolder.set(c.holderDid, [c]);
  }
  const rows: BeneficiaryRow[] = [];
  for (const [holderDid, list] of byHolder) {
    const sorted = [...list].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    const latest = sorted[0]!;
    rows.push({
      holderDid,
      name: nameFrom(latest.claims),
      status: statusOf(latest, nowMs),
      latest,
      credentials: sorted,
    });
  }
  return rows.sort((a, b) => b.latest.issuedAt.localeCompare(a.latest.issuedAt));
}

/** Case-insensitive match over the things an operator actually types. */
export function matchesQuery(row: BeneficiaryRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.holderDid.toLowerCase().includes(q)) return true;
  if (row.name?.toLowerCase().includes(q)) return true;
  return row.credentials.some((c) =>
    c.id.toLowerCase().includes(q) ||
    Object.values(c.claims).some((v) => typeof v === "string" && v.toLowerCase().includes(q)));
}

/**
 * WHICH PROGRAMMES AN AUTHORITY ACTUALLY RUNS.
 *
 * Two different fields could answer this and only one of them is right most of
 * the time:
 *
 *   · `issuer` is the BINDING — who signs the credentials. That is who runs the
 *     programme, and it is what every seeded government use case carries.
 *   · `ownerOrgId` is CONFIGURATION ownership — who may edit the definition. It
 *     is null on every platform-provisioned use case, including all four
 *     government ones.
 *
 * Filtering on `ownerOrgId` alone was the first version of this, and it showed
 * every authority an empty console: they issue under these programmes, they
 * just do not own the config rows. Both are accepted — an org that owns the
 * definition is running it too — with the issuer binding as the primary.
 */
export function schemesRunBy(useCases: CredentialUseCase[], orgId: string | null): CredentialUseCase[] {
  if (!orgId) return [];
  return useCases.filter((u) =>
    (u.issuer.kind === "org" && u.issuer.orgId === orgId) || u.ownerOrgId === orgId);
}
