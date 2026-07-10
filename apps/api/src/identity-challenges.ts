import { randomBytes } from "node:crypto";

export interface ChallengeStore {
  /** Issue a single-use challenge for a user, valid for `ttlMs`. */
  issue(userId: string): { challenge: string; expiresAt: string };
  /** Consume a challenge: true iff it matches an unexpired issued challenge for the user (then removes it). */
  consume(userId: string, challenge: string): boolean;
}

/** In-memory single-use challenges (single-instance demo scope). `nowMs` is injectable for tests. */
export function createMemoryChallengeStore(ttlMs = 5 * 60_000, nowMs: () => number = () => Date.now()): ChallengeStore {
  const byUser = new Map<string, { challenge: string; exp: number }>();
  return {
    issue(userId) {
      const challenge = randomBytes(24).toString("base64url");
      const exp = nowMs() + ttlMs;
      byUser.set(userId, { challenge, exp });
      return { challenge, expiresAt: new Date(exp).toISOString() };
    },
    consume(userId, challenge) {
      const rec = byUser.get(userId);
      if (!rec || rec.challenge !== challenge || rec.exp < nowMs()) return false;
      byUser.delete(userId);
      return true;
    },
  };
}
