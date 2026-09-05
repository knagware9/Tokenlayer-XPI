import { describe, expect, it } from "vitest";
import { isExpiringOrExpired } from "../src/lib/shared/kyc-expiry.js";

const NOW = Date.parse("2026-09-05T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("isExpiringOrExpired", () => {
  it("a null expiresAt (grandfathered approval) never counts as expiring", () => {
    expect(isExpiringOrExpired(null, NOW)).toBe(false);
  });

  it("an undefined expiresAt never counts as expiring", () => {
    expect(isExpiringOrExpired(undefined, NOW)).toBe(false);
  });

  it("a past expiresAt counts as expired", () => {
    expect(isExpiringOrExpired(new Date(NOW - DAY).toISOString(), NOW)).toBe(true);
  });

  it("an expiresAt within the 30-day warning window counts as expiring", () => {
    expect(isExpiringOrExpired(new Date(NOW + 10 * DAY).toISOString(), NOW)).toBe(true);
  });

  it("an expiresAt outside the 30-day warning window does not count as expiring", () => {
    expect(isExpiringOrExpired(new Date(NOW + 60 * DAY).toISOString(), NOW)).toBe(false);
  });
});
