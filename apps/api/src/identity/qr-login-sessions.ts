import { randomBytes, randomUUID } from "node:crypto";

export type QrLoginStatus = "pending" | "authenticated" | "consumed" | "expired";
export interface QrLoginSession {
  id: string;
  challenge: string;
  status: QrLoginStatus;
  userId: string | null;
  token: string | null;
  createdAt: string;
  expiresAt: string;
}
export interface QrLoginStore {
  start(): QrLoginSession;
  get(id: string): QrLoginSession | null;
  authenticate(id: string, v: { userId: string; token: string }): boolean;
  consume(id: string): QrLoginSession | null;
}

/** In-memory single-use QR-login sessions (single-instance demo scope). */
export function createMemoryQrLoginStore(ttlMs = 3 * 60_000, nowMs: () => number = () => Date.now()): QrLoginStore {
  const byId = new Map<string, QrLoginSession>();
  const fresh = (s: QrLoginSession): QrLoginSession => {
    if (s.status === "pending" && new Date(s.expiresAt).getTime() < nowMs()) s.status = "expired";
    return s;
  };
  return {
    start() {
      const now = nowMs();
      const s: QrLoginSession = {
        id: randomUUID(), challenge: randomBytes(24).toString("base64url"), status: "pending",
        userId: null, token: null, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
      };
      byId.set(s.id, s);
      return s;
    },
    get(id) { const s = byId.get(id); return s ? { ...fresh(s) } : null; },
    authenticate(id, v) {
      const s = byId.get(id);
      if (!s || fresh(s).status !== "pending") return false;
      s.status = "authenticated"; s.userId = v.userId; s.token = v.token;
      return true;
    },
    consume(id) {
      const s = byId.get(id);
      if (!s || fresh(s).status !== "authenticated") return null;
      s.status = "consumed";
      return { ...s };
    },
  };
}
