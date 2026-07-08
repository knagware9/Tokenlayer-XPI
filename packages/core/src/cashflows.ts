/**
 * Pure cashflow math for the use-case `terms` template: schedule generation
 * (coupons + redemption) and pro-rata payout splitting. No I/O, no Date.now —
 * callers inject `issuedAt`. All money math is BigInt over integer amounts.
 */
import { PolicyError } from "./errors.js";

export interface TermsConfig {
  principalField: string;
  maturityField: string;
  rateField?: string;
  frequency?: "atMaturity" | "monthly" | "quarterly" | "semiannual" | "annual";
  currency: string;
}

export interface ScheduledCashflow {
  seq: number;
  kind: "coupon" | "redemption";
  dueDate: string; // YYYY-MM-DD
  amount: string;  // integer decimal string
}

const MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const base = new Date(Date.UTC(y!, m! - 1 + months, d!));
  // Clamp month-end overflow (e.g. Jan 31 + 1mo → Feb 28) back to the last day.
  if (base.getUTCDate() !== d) base.setUTCDate(0);
  return base.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Coupon for `days` of accrual: principal × rate% p.a. × days/365 in basis points (non-negative, uncapped — a long/high-rate period may exceed the principal), floored. */
function couponAmount(principal: bigint, ratePct: number, days: number): bigint {
  const bp = Math.max(0, Math.round((ratePct * days) / 365 * 100));
  return (principal * BigInt(bp)) / 10000n;
}

/**
 * Materialized schedule for one asset. Absent principal/maturity metadata →
 * empty schedule (terms inapplicable); present-but-invalid → INVALID_TERMS.
 */
export function computeCashflowSchedule(
  terms: TermsConfig,
  metadata: Record<string, unknown>,
  issuedAt: string,
): ScheduledCashflow[] {
  const rawPrincipal = metadata[terms.principalField];
  const rawMaturity = metadata[terms.maturityField];
  if (rawPrincipal === undefined || rawMaturity === undefined) return [];

  const n = typeof rawPrincipal === "number" ? rawPrincipal : Number(rawPrincipal);
  if (!Number.isFinite(n) || n <= 0) {
    throw new PolicyError("INVALID_TERMS", `terms: '${terms.principalField}' must be a positive number`);
  }
  const principal = BigInt(Math.round(n));
  const maturity = String(rawMaturity);
  if (!YMD.test(maturity) || Number.isNaN(Date.parse(maturity))) {
    throw new PolicyError("INVALID_TERMS", `terms: '${terms.maturityField}' must be a YYYY-MM-DD date`);
  }

  const rows: ScheduledCashflow[] = [];
  const frequency = terms.frequency ?? "atMaturity";
  if (frequency !== "atMaturity") {
    const rateRaw = terms.rateField ? metadata[terms.rateField] : undefined;
    const rate = typeof rateRaw === "number" ? rateRaw : Number(rateRaw);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new PolicyError("INVALID_TERMS", `terms: '${terms.rateField}' must be a non-negative number`);
    }
    const step = MONTHS[frequency]!;
    let prev = issuedAt.slice(0, 10);
    let due = addMonths(prev, step);
    while (due < maturity) {
      rows.push({ seq: rows.length + 1, kind: "coupon", dueDate: due, amount: couponAmount(principal, rate, daysBetween(prev, due)).toString() });
      prev = due;
      due = addMonths(due, step);
    }
    // Final stub accrual from the last coupon (or issue) to maturity.
    const stubDays = daysBetween(prev, maturity);
    if (stubDays > 0 && rate > 0) {
      rows.push({ seq: rows.length + 1, kind: "coupon", dueDate: maturity, amount: couponAmount(principal, rate, stubDays).toString() });
    }
  }
  rows.push({ seq: rows.length + 1, kind: "redemption", dueDate: maturity, amount: principal.toString() });
  return rows;
}

/** Pro-rata split of `total` over positive balances; BigInt floor, dust undistributed. */
export function splitProRata(total: bigint, balances: Map<string, bigint>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (total <= 0n) return out;
  let supply = 0n;
  for (const b of balances.values()) if (b > 0n) supply += b;
  if (supply <= 0n) return out;
  for (const [addr, bal] of balances) {
    if (bal <= 0n) continue;
    const share = (total * bal) / supply;
    if (share > 0n) out.set(addr, share);
  }
  return out;
}
