/**
 * Pure identity-dashboard aggregation (ID-N). Takes already-loaded,
 * already-scope-filtered data and folds it into stat tiles, a per-use-case
 * breakdown, a capped status board, an issued-per-day activity window, and
 * verification counters. No I/O — `now` is injected so tests are deterministic.
 * Mirrors the tokenization analytics.ts contract.
 */
import type { CredentialUseCaseDefinition } from "@tokenlayer/core";
import type { CredentialRecord, VerificationRequestRecord } from "./persistence/types.js";

/** One pill per credential. Precedence: rejected → revoked → expired → acceptance.
 *  Rejected is checked FIRST because ID-L's holder-reject revokes on-chain before
 *  recording the rejection — revoked-first would zero the rejected tile forever. */
export type DerivedCredentialStatus = "accepted" | "pending" | "changes_requested" | "rejected" | "revoked" | "expired";

export function derivedCredentialStatus(
  c: Pick<CredentialRecord, "revoked" | "expiresAt" | "acceptance">,
  now: string,
): DerivedCredentialStatus {
  if (c.acceptance === "rejected") return "rejected";
  if (c.revoked) return "revoked";
  // Both sides are Date.toISOString() output (fixed-width UTC), so string order = time order.
  if (c.expiresAt && c.expiresAt < now) return "expired";
  return c.acceptance;
}

export interface StatusCounts {
  issued: number;
  accepted: number;
  pendingAcceptance: number;
  changesRequested: number;
  rejectedByHolder: number;
  revoked: number;
  expired: number;
}

export interface UseCaseTypeCounts { type: string; counts: StatusCounts }
export interface DashboardUseCase { key: string; name: string; counts: StatusCounts; byType: UseCaseTypeCounts[] }

export interface BoardRow {
  credentialId: string;
  useCaseKey: string;
  useCaseName: string;
  type: string;
  holderDid: string;
  holderLabel: string;
  issuedAt: string;
  expiresAt: string | null;
  status: DerivedCredentialStatus;
  /** Only populated while the status is changes_requested (the TalentPass table shows the reason inline). */
  acceptanceNote: string | null;
}

export interface ActivityDayRow { date: string; issued: number }

export interface VerificationCounts {
  pending: number;
  /** Consented but not yet verified by the verifier. */
  consented: number;
  rejected: number;
  expired: number;
  verifiedValid: number;
  verifiedInvalid: number;
}

export interface IdentityDashboard {
  totals: StatusCounts;
  byUseCase: DashboardUseCase[];
  board: BoardRow[];
  boardTotal: number;
  activity: ActivityDayRow[];
  verification: VerificationCounts;
}

export interface IdentityDashboardInput {
  /** The caller's scoped slice of the credential use-case catalog. */
  useCases: CredentialUseCaseDefinition[];
  /** May be pre-filtered by the route; the fold re-filters against `useCases` regardless. */
  credentials: CredentialRecord[];
  verifications: VerificationRequestRecord[];
  /** holderDid → display label (user email / org name). Misses fall back to a truncated DID. */
  holderLabels: Map<string, string>;
  now: string;
  days: number;
}

const BOARD_CAP = 200;

const zeroCounts = (): StatusCounts =>
  ({ issued: 0, accepted: 0, pendingAcceptance: 0, changesRequested: 0, rejectedByHolder: 0, revoked: 0, expired: 0 });

const COUNT_FIELD: Record<DerivedCredentialStatus, keyof Omit<StatusCounts, "issued">> = {
  accepted: "accepted", pending: "pendingAcceptance", changes_requested: "changesRequested",
  rejected: "rejectedByHolder", revoked: "revoked", expired: "expired",
};

const truncateDid = (did: string): string => (did.length > 24 ? `${did.slice(0, 16)}…${did.slice(-4)}` : did);

export function computeIdentityDashboard(input: IdentityDashboardInput): IdentityDashboard {
  const nameByKey = new Map(input.useCases.map((u) => [u.key, u.name]));

  // Defense in depth: only credentials/requests inside the scope count, even if
  // the route's pre-filter and this disagree.
  const creds = input.credentials.filter((c) => c.credentialUseCaseKey !== null && nameByKey.has(c.credentialUseCaseKey));
  const vreqs = input.verifications.filter((v) => v.credentialUseCaseKey !== null && nameByKey.has(v.credentialUseCaseKey));

  const totals = zeroCounts();
  // Seed every configured type at zero so an idle type still renders a row.
  const perUseCase = new Map<string, { counts: StatusCounts; byType: Map<string, StatusCounts> }>();
  for (const u of input.useCases) {
    perUseCase.set(u.key, { counts: zeroCounts(), byType: new Map(u.credentialTypes.map((t) => [t.name, zeroCounts()])) });
  }

  for (const c of creds) {
    const status = derivedCredentialStatus(c, input.now);
    const ucAgg = perUseCase.get(c.credentialUseCaseKey!)!;
    let typeAgg = ucAgg.byType.get(c.type);
    if (!typeAgg) { typeAgg = zeroCounts(); ucAgg.byType.set(c.type, typeAgg); } // type renamed since issuance
    for (const bucket of [totals, ucAgg.counts, typeAgg]) {
      bucket.issued += 1;
      bucket[COUNT_FIELD[status]] += 1;
    }
  }

  const byUseCase: DashboardUseCase[] = input.useCases.map((u) => {
    const agg = perUseCase.get(u.key)!;
    return { key: u.key, name: u.name, counts: agg.counts, byType: [...agg.byType].map(([type, counts]) => ({ type, counts })) };
  });

  const board: BoardRow[] = [...creds]
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
    .slice(0, BOARD_CAP)
    .map((c) => {
      const status = derivedCredentialStatus(c, input.now);
      return {
        credentialId: c.id,
        useCaseKey: c.credentialUseCaseKey!,
        useCaseName: nameByKey.get(c.credentialUseCaseKey!) ?? c.credentialUseCaseKey!,
        type: c.type,
        holderDid: c.holderDid,
        holderLabel: input.holderLabels.get(c.holderDid) ?? truncateDid(c.holderDid),
        issuedAt: c.issuedAt,
        expiresAt: c.expiresAt,
        status,
        acceptanceNote: status === "changes_requested" ? c.acceptanceNote : null,
      };
    });

  // Last `days` UTC days ending on `now`'s date, oldest first.
  const dayMs = 24 * 60 * 60 * 1000;
  const end = Date.parse(input.now.slice(0, 10) + "T00:00:00.000Z");
  const byDay = new Map<string, number>();
  for (const c of creds) {
    const day = c.issuedAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const activity: ActivityDayRow[] = [];
  for (let i = input.days - 1; i >= 0; i--) {
    const date = new Date(end - i * dayMs).toISOString().slice(0, 10);
    activity.push({ date, issued: byDay.get(date) ?? 0 });
  }

  const verification: VerificationCounts = { pending: 0, consented: 0, rejected: 0, expired: 0, verifiedValid: 0, verifiedInvalid: 0 };
  for (const v of vreqs) {
    if (v.status === "pending") verification.pending += 1;
    else if (v.status === "rejected") verification.rejected += 1;
    else if (v.status === "expired") verification.expired += 1;
    else if (v.status === "consented") {
      if (v.verifierResult === null) verification.consented += 1;
      else if (v.verifierResult.valid === true) verification.verifiedValid += 1;
      else verification.verifiedInvalid += 1;
    }
  }

  return { totals, byUseCase, board, boardTotal: creds.length, activity, verification };
}
