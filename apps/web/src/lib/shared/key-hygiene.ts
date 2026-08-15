/**
 * KEY HYGIENE — the question a security review actually asks about API keys.
 *
 * The keys table already shows every fact: scopes, last used, expiry, status.
 * What it could not do was answer "which of these should not still exist?"
 * across twenty rows, and that is the question an enterprise admin is asked
 * once a quarter and cannot answer by reading dates.
 *
 * NOTHING NEW IS FETCHED. These are derivations over `ApiKeyView` — no new
 * route, no new field. Deliberately so: a hygiene view that needed server-side
 * usage counters would be a different (and much larger) piece of work, and this
 * one is useful today.
 *
 * WHAT THIS IS NOT: it is not a risk score. Every classification below names a
 * specific, checkable fact ("minted 4 months ago, never used"), because a
 * number an operator cannot reconstruct is a number they will either ignore or
 * over-trust. Nothing here says a key is unsafe; it says what is true of it.
 */
import type { ApiKeyView } from "../../types.js";

export type KeyHealth = "revoked" | "expired" | "never-used" | "stale" | "expiring" | "healthy";

/** Unused for this long and we call it stale — a quarter, the usual review cycle. */
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
/** Expiring inside this window is a renewal to schedule, not a surprise. */
export const EXPIRING_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;
/** A key minted moments ago has not had time to be used; do not call it stale. */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One key's standing.
 *
 * Precedence matters and is stated rather than left to whichever branch runs
 * first: a REVOKED key is done — it is not also "stale", and listing it as
 * something to chase wastes the reviewer's attention. Then expiry (it cannot
 * authenticate), then never-used, then staleness, then an upcoming expiry.
 */
export function healthOf(key: ApiKeyView, nowMs: number = Date.now()): KeyHealth {
  if (key.status === "revoked") return "revoked";
  if (key.expiresAt !== null && Date.parse(key.expiresAt) < nowMs) return "expired";

  if (key.lastUsedAt === null) {
    // NEVER USED is only interesting once it has had a chance to be used.
    // Flagging a key minted an hour ago would train people to ignore the flag —
    // which is how a hygiene view becomes noise and then wallpaper.
    const created = key.createdAt ? Date.parse(key.createdAt) : NaN;
    if (Number.isFinite(created) && nowMs - created < GRACE_MS) return "healthy";
    return "never-used";
  }
  if (nowMs - Date.parse(key.lastUsedAt) > STALE_AFTER_MS) return "stale";
  if (key.expiresAt !== null && Date.parse(key.expiresAt) - nowMs <= EXPIRING_WITHIN_MS) return "expiring";
  return "healthy";
}

/** One plain sentence per state — what is true, not what to feel about it. */
export const HEALTH_NOTE: Record<KeyHealth, string> = {
  revoked: "Revoked. It cannot authenticate and needs no action.",
  expired: "Past its expiry. It cannot authenticate; delete it or mint a replacement.",
  "never-used": "Minted but never used. Either the integration never shipped, or the key leaked into something that does not call us.",
  stale: "Not used in over 90 days. If the integration is gone, the key should be too.",
  expiring: "Expires within 30 days. Rotate before it lapses rather than after.",
  healthy: "In use and not near expiry.",
};

export const HEALTH_LABEL: Record<KeyHealth, string> = {
  revoked: "Revoked", expired: "Expired", "never-used": "Never used",
  stale: "Stale", expiring: "Expiring", healthy: "Healthy",
};

export interface HygieneSummary {
  total: number;
  /** Keys that could authenticate right now (not revoked, not expired). */
  live: number;
  neverUsed: number;
  stale: number;
  expiring: number;
  expired: number;
  revoked: number;
  /** The reviewer's actual queue: live keys that want a decision. */
  needsAttention: number;
}

export function summarize(keys: ApiKeyView[], nowMs: number = Date.now()): HygieneSummary {
  const s: HygieneSummary = { total: keys.length, live: 0, neverUsed: 0, stale: 0, expiring: 0, expired: 0, revoked: 0, needsAttention: 0 };
  for (const k of keys) {
    const h = healthOf(k, nowMs);
    if (h === "revoked") { s.revoked += 1; continue; }
    if (h === "expired") { s.expired += 1; continue; }
    s.live += 1;
    if (h === "never-used") { s.neverUsed += 1; s.needsAttention += 1; }
    else if (h === "stale") { s.stale += 1; s.needsAttention += 1; }
    else if (h === "expiring") { s.expiring += 1; s.needsAttention += 1; }
  }
  return s;
}

/**
 * The scopes an org's live keys collectively hold.
 *
 * A reviewer asks "what can our machine credentials do?" and the answer is the
 * UNION over keys that can still authenticate — a revoked key's scopes are not
 * a standing power, and counting them would overstate the org's exposure in the
 * one place someone is trying to measure it.
 */
export function liveScopes(keys: ApiKeyView[], nowMs: number = Date.now()): string[] {
  const scopes = new Set<string>();
  for (const k of keys) {
    const h = healthOf(k, nowMs);
    if (h === "revoked" || h === "expired") continue;
    for (const s of k.scopes) scopes.add(s);
  }
  return [...scopes].sort();
}
