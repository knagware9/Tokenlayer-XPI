/**
 * Unit cover for `redact`'s FORBIDDEN_KEYS list — the belt to each `emitEvent`
 * call site's brace (see the file comment on events.ts). `consentedDisclosures`
 * is a new field on `VerificationRequestRecord` carrying raw disclosed claim
 * values (see apps/api/src/identity/selective-disclosure.ts); no current call
 * site spreads it into an event payload, but the list's own stated purpose is
 * to catch that class of mistake before it happens, not after.
 */
import { describe, expect, it } from "vitest";
import { redact } from "../src/shared/events.js";

describe("redact", () => {
  it("strips consentedDisclosures at any nesting depth", () => {
    const payload = {
      requestId: "req_1",
      consentedDisclosures: { cred_1: { holderName: { kind: "value", value: "Ramesh Kumar" } } },
      nested: { consentedDisclosures: { cred_1: {} } },
    };
    const out = redact(payload) as Record<string, unknown>;
    expect(out).not.toHaveProperty("consentedDisclosures");
    expect(out.nested).not.toHaveProperty("consentedDisclosures");
    expect(out.requestId).toBe("req_1");
  });

  it("still strips the existing forbidden keys (no regression)", () => {
    const out = redact({ passwordHash: "x", vcJwt: "a.b.c", ok: 1 }) as Record<string, unknown>;
    expect(out).not.toHaveProperty("passwordHash");
    expect(out).not.toHaveProperty("vcJwt");
    expect(out.ok).toBe(1);
  });
});
