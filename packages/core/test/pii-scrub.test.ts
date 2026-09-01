import { describe, expect, it } from "vitest";
import { scrubEvent } from "../src/index.js";

describe("scrubEvent", () => {
  it("redacts known PII/KYC fields wherever they appear, nested or not", () => {
    const event = {
      extra: {
        buyerEmail: "alice@example.com",
        // The whole object is redacted wholesale — anything filed under a
        // `kyc` key is presumptively sensitive, not just its known subfields.
        kyc: { panNumber: "ABCDE1234F", dob: "1990-01-01" },
        assetName: "Gold Bar #12", // NOT sensitive — must survive untouched
      },
      contexts: { user: { walletKey: "0xdeadbeef", accountId: "acct_1" } },
    };

    const scrubbed = scrubEvent(event);

    expect(scrubbed.extra!.buyerEmail).toBe("[Redacted]");
    expect(scrubbed.extra!.kyc).toBe("[Redacted]");
    expect(scrubbed.extra!.assetName).toBe("Gold Bar #12");
    expect((scrubbed.contexts!.user as Record<string, unknown>).walletKey).toBe("[Redacted]");
    expect((scrubbed.contexts!.user as Record<string, unknown>).accountId).toBe("acct_1");
  });

  it("strips request cookies and headers entirely, and redacts sensitive request data", () => {
    const event = {
      request: {
        data: { password: "hunter2", assetId: "asset_1" },
        cookies: { session: "abc123" },
        headers: { authorization: "Bearer xyz", "content-type": "application/json" },
      },
    };

    const scrubbed = scrubEvent(event);

    expect((scrubbed.request!.data as Record<string, unknown>).password).toBe("[Redacted]");
    expect((scrubbed.request!.data as Record<string, unknown>).assetId).toBe("asset_1");
    expect(scrubbed.request!.cookies).toBeUndefined();
    expect((scrubbed.request!.headers as Record<string, unknown>).authorization).toBe("[Redacted]");
    expect((scrubbed.request!.headers as Record<string, unknown>)["content-type"]).toBe("application/json");
  });

  it("redacts sensitive breadcrumb data and always drops user identity", () => {
    const event = {
      breadcrumbs: [{ data: { phoneNumber: "+1-555-0100" } }, { data: { status: 200 } }],
      user: { id: "u1", email: "bob@example.com" },
    };

    const scrubbed = scrubEvent(event);

    expect((scrubbed.breadcrumbs![0]!.data as Record<string, unknown>).phoneNumber).toBe("[Redacted]");
    expect((scrubbed.breadcrumbs![1]!.data as Record<string, unknown>).status).toBe(200);
    expect(scrubbed.user).toBeUndefined();
  });

  it("preserves fields the event doesn't declare in ScrubbableEvent, e.g. Sentry's own event_id", () => {
    const event = { event_id: "abc", extra: { email: "x@y.com" } };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.event_id).toBe("abc");
    expect(scrubbed.extra.email).toBe("[Redacted]");
  });
});
