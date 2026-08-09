import { describe, expect, it } from "vitest";
import { EVENT_TYPES, isEventType, validateEventTypes, API_SCOPES, scopeAllows } from "../src/index.js";

describe("event catalog", () => {
  it("is the closed v1 set — ten types across both domains", () => {
    expect([...EVENT_TYPES].sort()).toEqual([
      "asset.issued", "asset.redeemed", "asset.transferred",
      "credential.accepted", "credential.issued", "credential.rejected", "credential.revoked",
      "proposal.executed", "verification.completed", "verification.requested",
    ]);
  });

  it("recognises catalog members and rejects everything else", () => {
    expect(isEventType("credential.issued")).toBe(true);
    expect(isEventType("organization.registered")).toBe(false); // deliberately excluded from v1
    expect(isEventType("")).toBe(false);
    expect(isEventType("*")).toBe(false); // a subscription wildcard, never an event type
  });

  it("validateEventTypes accepts the wildcard subscription and known types", () => {
    expect(validateEventTypes(["*"])).toEqual(["*"]);
    expect(validateEventTypes(["credential.issued", "asset.issued"])).toEqual(["credential.issued", "asset.issued"]);
  });

  it("validateEventTypes rejects unknown, empty, duplicate and non-string input", () => {
    expect(() => validateEventTypes([])).toThrow(/at least one/);
    expect(() => validateEventTypes(["nope.gone"])).toThrow(/unknown event type/);
    expect(() => validateEventTypes(["credential.*"])).toThrow(/unknown event type/); // a partial wildcard is never a smuggled "*"
    expect(() => validateEventTypes(["credential.issued", "credential.issued"])).toThrow(/duplicate/);
    expect(() => validateEventTypes("credential.issued")).toThrow(/must be an array/);
    expect(() => validateEventTypes([1])).toThrow(/must be strings/);
  });
});

describe("webhook scopes", () => {
  it("are in the closed scope list", () => {
    expect(API_SCOPES).toContain("webhooks:read");
    expect(API_SCOPES).toContain("webhooks:write");
  });

  it("the webhooks:* wildcard covers both, and no other resource's wildcard does", () => {
    expect(scopeAllows(["webhooks:*"], "webhooks:read")).toBe(true);
    expect(scopeAllows(["webhooks:*"], "webhooks:write")).toBe(true);
    expect(scopeAllows(["org:*"], "webhooks:read")).toBe(false);
    expect(scopeAllows(["webhooks:read"], "webhooks:write")).toBe(false);
  });
});
