/**
 * Unit cover for the pure pieces of the Webhooks (EN-C) console — the ones that
 * carry a real invariant: which event types an organization may be OFFERED,
 * what a fresh draft is subscribed to, what a draft must satisfy before it is
 * worth sending, and which affordances a row may show.
 *
 * Deliberately narrow, on the same terms as developers-key-lifecycle.test.ts:
 * apps/web has no DOM test environment, so rendering is verified in the browser
 * and what is asserted here is the logic those renders delegate to.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_WEBHOOK_DRAFT,
  canRetry,
  canSendTest,
  checkWebhookDraft,
  subscribableEventTypes,
} from "../src/components/Webhooks.js";
import { EVENT_TYPES, type EventType, type OrgCapabilities } from "../src/types.js";

const IDENTITY_ONLY: OrgCapabilities = { domains: ["identity"], roles: ["Issuer", "Holder", "Verifier"] };
const TOKENIZATION_ONLY: OrgCapabilities = { domains: ["tokenization"], roles: ["Issuer", "Holder", "Verifier"] };

describe("subscribableEventTypes", () => {
  it("offers everything for a legacy (null) envelope", () => {
    // null is UNRESTRICTED LEGACY, not "no capabilities" — an org that predates
    // EN-A must not silently lose the ability to subscribe to anything.
    expect(subscribableEventTypes(null, "OrgAdmin")).toEqual([...EVENT_TYPES]);
  });

  it("gives an identity-only org no asset events", () => {
    const offered = subscribableEventTypes(IDENTITY_ONLY, "OrgAdmin");
    expect(offered.filter((t) => t.startsWith("asset."))).toEqual([]);
    // …and it still gets everything it IS entitled to, so the filter is a
    // filter and not an accidental blanket refusal.
    expect(offered).toContain("credential.issued");
    expect(offered).toContain("verification.completed");
    // proposal.executed is domain-neutral — maker-checker governance, which
    // both domains use — so it survives every envelope.
    expect(offered).toContain("proposal.executed");
  });

  it("gives a tokenization-only org no credential or verification events", () => {
    const offered = subscribableEventTypes(TOKENIZATION_ONLY, "OrgAdmin");
    expect(offered.filter((t) => t.startsWith("credential.") || t.startsWith("verification."))).toEqual([]);
    expect(offered).toContain("asset.issued");
    expect(offered).toContain("asset.transferred");
    expect(offered).toContain("asset.redeemed");
    expect(offered).toContain("proposal.executed");
  });

  it("does not filter a PlatformAdmin, whatever the org's envelope says", () => {
    // The server does not apply the envelope to a PlatformAdmin either, so
    // filtering here would hide types they can legitimately register.
    expect(subscribableEventTypes(IDENTITY_ONLY, "PlatformAdmin")).toEqual([...EVENT_TYPES]);
    expect(subscribableEventTypes(TOKENIZATION_ONLY, "PlatformAdmin")).toEqual([...EVENT_TYPES]);
  });

  it("actually consults the envelope — the two orgs are offered different lists", () => {
    // Pins the filter itself rather than either list in isolation: an
    // implementation that ignored `capabilities` and returned EVENT_TYPES would
    // satisfy "identity-only has no asset events" only by accident of the
    // assertion above, so make the DIFFERENCE the thing under test.
    const identity = subscribableEventTypes(IDENTITY_ONLY, "OrgAdmin");
    const tokenization = subscribableEventTypes(TOKENIZATION_ONLY, "OrgAdmin");
    expect(identity).not.toEqual(tokenization);
    expect(identity.length).toBeLessThan(EVENT_TYPES.length);
    expect(tokenization.length).toBeLessThan(EVENT_TYPES.length);
    // Their only overlap is the domain-neutral type.
    expect(identity.filter((t) => tokenization.includes(t))).toEqual(["proposal.executed"]);
  });

  it("treats an explicitly empty envelope as fully restrictive, not as legacy", () => {
    // [] ≠ null. An org granted nothing may still subscribe to the
    // domain-neutral governance event, and to nothing else.
    expect(subscribableEventTypes({ domains: [], roles: [] }, "OrgAdmin")).toEqual(["proposal.executed"]);
  });
});

describe("webhook draft", () => {
  it("starts subscribed to nothing at all", () => {
    // Not "everything", not "everything this org is entitled to" — nothing.
    // A default subscription points a firehose at a URL that was registered to
    // hear about one thing.
    expect(EMPTY_WEBHOOK_DRAFT.eventTypes).toEqual([]);
    expect(EMPTY_WEBHOOK_DRAFT.url).toBe("");
    expect(EMPTY_WEBHOOK_DRAFT.useCaseKey).toBe("");
  });

  it("refuses an empty url", () => {
    const check = checkWebhookDraft({ ...EMPTY_WEBHOOK_DRAFT, eventTypes: ["asset.issued"] });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.message).toMatch(/url/i);
  });

  it("refuses the exact path that would subscribe an endpoint to nothing", () => {
    // Paste a URL, submit — never opening the event list. An endpoint
    // subscribed to nothing is never delivered anything, silently.
    const check = checkWebhookDraft({ ...EMPTY_WEBHOOK_DRAFT, url: "https://api.example.com/hooks" });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.message).toMatch(/event type/i);
  });

  it("refuses a plainly non-https url before the round trip", () => {
    const check = checkWebhookDraft({
      ...EMPTY_WEBHOOK_DRAFT,
      url: "http://api.example.com/hooks",
      eventTypes: ["asset.issued"],
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.message).toMatch(/https/i);
  });

  it("refuses something that is not a URL at all", () => {
    const check = checkWebhookDraft({ ...EMPTY_WEBHOOK_DRAFT, url: "api.example.com/hooks", eventTypes: ["asset.issued"] });
    expect(check.ok).toBe(false);
  });

  it("accepts a good draft and narrows it, trimming the url", () => {
    const check = checkWebhookDraft({
      url: "  https://api.example.com/hooks/tokenlayer  ",
      description: "ERP inbound listener",
      eventTypes: ["asset.issued", "proposal.executed"],
      useCaseKey: "",
    });
    expect(check).toEqual({
      ok: true,
      url: "https://api.example.com/hooks/tokenlayer",
      eventTypes: ["asset.issued", "proposal.executed"],
    });
    // The narrowing is the point: the validated values exist ONLY on the ok
    // arm, so an incomplete draft has nothing to hand the create call.
    if (check.ok) {
      const url: string = check.url;
      const types: EventType[] = check.eventTypes;
      expect(url.startsWith("https://")).toBe(true);
      expect(types).toHaveLength(2);
    }
  });
});

describe("delivery affordances", () => {
  it("offers Replay for a settled failure", () => {
    expect(canRetry("failed")).toBe(true);
    expect(canRetry("dead")).toBe(true);
  });

  it("refuses Replay for an INFLIGHT delivery", () => {
    // A dispatcher has already claimed the row and is mid-POST. The server
    // answers 409 DELIVERY_INFLIGHT, and resetting it anyway would let a second
    // worker claim it while the first is still sending — a double delivery.
    expect(canRetry("inflight")).toBe(false);
  });

  it("refuses Replay for pending and delivered", () => {
    // pending is already queued for the next pass; delivered already arrived,
    // and replaying it would send the integrator a duplicate.
    expect(canRetry("pending")).toBe(false);
    expect(canRetry("delivered")).toBe(false);
  });

  it("admits exactly two of the five statuses", () => {
    const statuses = ["pending", "inflight", "delivered", "failed", "dead"] as const;
    expect(statuses.filter(canRetry)).toEqual(["failed", "dead"]);
  });
});

describe("test-ping affordance", () => {
  it("offers a test only for an active endpoint", () => {
    expect(canSendTest("active")).toBe(true);
  });

  it("refuses a test for a disabled endpoint", () => {
    // The dispatcher settles a delivery to a non-active endpoint as `dead`
    // without sending, so the server 409s rather than report success for
    // something guaranteed not to happen. Re-enable is the control that applies.
    expect(canSendTest("disabled")).toBe(false);
  });
});
