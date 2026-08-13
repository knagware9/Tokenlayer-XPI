/**
 * THE QUARTERLY QUESTION: which of these keys should not still exist?
 *
 * The failure a hygiene view invites is becoming wallpaper. Flag a key minted
 * an hour ago as "never used" and the flag means nothing within a week; count a
 * revoked key's scopes as standing power and you overstate exposure in the one
 * place someone is trying to measure it. Both are tested below.
 *
 * Precedence is pinned deliberately — revoked, then expired, then never-used,
 * then stale, then expiring — because a revoked key is DONE and listing it as
 * something to chase spends the reviewer's attention on nothing.
 */
import { describe, expect, it } from "vitest";
import { GRACE_MS, healthOf, liveScopes, STALE_AFTER_MS, summarize } from "../src/lib/key-hygiene.js";
import type { ApiKeyView } from "../src/types.js";

const NOW = Date.parse("2026-08-13T00:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

const key = (over: Partial<ApiKeyView> = {}): ApiKeyView => ({
  id: "k1", orgId: "org_1", userId: "u1", name: "ERP", prefix: "abcd1234",
  scopes: ["assets:read"], role: "Auditor", useCaseKey: null, status: "active",
  lastUsedAt: ago(DAY), expiresAt: null, revokedAt: null, revokedBy: null,
  createdBy: "u0", createdAt: ago(200 * DAY), ...over,
} as ApiKeyView);

describe("healthOf — one key's standing", () => {
  it("healthy when used recently and not near expiry", () => {
    expect(healthOf(key(), NOW)).toBe("healthy");
  });

  it("REVOKED wins — a revoked key is done, not also stale", () => {
    // Listing a revoked key as something to chase spends attention on nothing.
    expect(healthOf(key({ status: "revoked", lastUsedAt: ago(400 * DAY) }), NOW)).toBe("revoked");
  });

  it("expired beats never-used and stale — it cannot authenticate at all", () => {
    expect(healthOf(key({ expiresAt: ago(DAY), lastUsedAt: null }), NOW)).toBe("expired");
  });

  it("never-used, once it has had a chance", () => {
    expect(healthOf(key({ lastUsedAt: null, createdAt: ago(60 * DAY) }), NOW)).toBe("never-used");
  });

  it("does NOT flag a key minted moments ago — that is how a flag becomes wallpaper", () => {
    // The grace window is the whole point: a key created this morning has not
    // failed to be used, it has not been used YET.
    expect(healthOf(key({ lastUsedAt: null, createdAt: ago(GRACE_MS / 2) }), NOW)).toBe("healthy");
    expect(healthOf(key({ lastUsedAt: null, createdAt: ago(GRACE_MS + DAY) }), NOW)).toBe("never-used");
  });

  it("stale after 90 days unused", () => {
    expect(healthOf(key({ lastUsedAt: ago(STALE_AFTER_MS - DAY) }), NOW)).not.toBe("stale");
    expect(healthOf(key({ lastUsedAt: ago(STALE_AFTER_MS + DAY) }), NOW)).toBe("stale");
  });

  it("expiring inside 30 days, but only for a key still in use", () => {
    expect(healthOf(key({ expiresAt: ahead(10 * DAY) }), NOW)).toBe("expiring");
    expect(healthOf(key({ expiresAt: ahead(60 * DAY) }), NOW)).toBe("healthy");
    // Stale beats expiring: "nobody uses this" is the more useful fact than
    // "and it also lapses soon".
    expect(healthOf(key({ expiresAt: ahead(10 * DAY), lastUsedAt: ago(200 * DAY) }), NOW)).toBe("stale");
  });

  it("survives a key with no createdAt it can parse", () => {
    // Defensive: an older or hand-built row must not crash the panel.
    expect(healthOf(key({ lastUsedAt: null, createdAt: "not-a-date" as string }), NOW)).toBe("never-used");
  });
});

describe("summarize — the reviewer's queue", () => {
  it("counts each key once, and only LIVE keys need attention", () => {
    const s = summarize([
      key({ id: "a" }),                                                   // healthy
      key({ id: "b", lastUsedAt: null, createdAt: ago(60 * DAY) }),       // never used
      key({ id: "c", lastUsedAt: ago(200 * DAY) }),                       // stale
      key({ id: "d", expiresAt: ahead(5 * DAY) }),                        // expiring
      key({ id: "e", expiresAt: ago(5 * DAY) }),                          // expired
      key({ id: "f", status: "revoked" }),                                // revoked
    ], NOW);
    expect(s.total).toBe(6);
    expect(s.live).toBe(4);          // a, b, c, d — e and f cannot authenticate
    expect(s.neverUsed).toBe(1);
    expect(s.stale).toBe(1);
    expect(s.expiring).toBe(1);
    expect(s.expired).toBe(1);
    expect(s.revoked).toBe(1);
    // The queue excludes the healthy one AND both dead ones.
    expect(s.needsAttention).toBe(3);
  });

  it("an org with no keys reports zeroes, not an empty-looking problem", () => {
    expect(summarize([], NOW)).toMatchObject({ total: 0, live: 0, needsAttention: 0 });
  });
});

describe("liveScopes — what our machine credentials can actually do", () => {
  it("unions the scopes of keys that can still authenticate", () => {
    expect(liveScopes([
      key({ scopes: ["assets:read", "assets:write"] }),
      key({ scopes: ["assets:read", "credentials:issue"] }),
    ], NOW)).toEqual(["assets:read", "assets:write", "credentials:issue"]);
  });

  it("EXCLUDES revoked and expired keys — their scopes are not standing power", () => {
    // Counting them would overstate the org's exposure in the one place
    // somebody is trying to measure it.
    expect(liveScopes([
      key({ scopes: ["assets:read"] }),
      key({ scopes: ["identity:assert"], status: "revoked" }),
      key({ scopes: ["webhooks:write"], expiresAt: ago(DAY) }),
    ], NOW)).toEqual(["assets:read"]);
  });

  it("returns nothing when every key is dead", () => {
    expect(liveScopes([key({ status: "revoked" })], NOW)).toEqual([]);
  });
});
