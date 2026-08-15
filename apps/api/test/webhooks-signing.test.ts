import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { endpointMatches } from "../src/webhooks/matching.js";
import { createSecretBox } from "../src/webhooks/secret-box.js";
import { SIGNATURE_TOLERANCE_SECONDS, signPayload, signatureHeader, verifySignature } from "../src/webhooks/signing.js";
import type { EventRecord, WebhookEndpointRecord } from "../src/persistence/types/index.js";

const SECRET = "whsec_test_0123456789abcdef";
const BODY = JSON.stringify({ id: "evt_1", type: "credential.issued" });
const T = 1754697600;

describe("webhook signing", () => {
  it("matches an independently computed HMAC over `${t}.${rawBody}`", () => {
    // Computed HERE, not by calling signPayload on both sides — otherwise the
    // assertion holds for any scheme at all, including the broken ones below.
    const expected = createHmac("sha256", SECRET).update(`${T}.${BODY}`).digest("hex");
    expect(signPayload(SECRET, T, BODY)).toEqual(expected);
    // ...and is NOT the HMAC of the body alone, which is the mutation that
    // makes a captured delivery replayable forever.
    expect(signPayload(SECRET, T, BODY)).not.toEqual(createHmac("sha256", SECRET).update(BODY).digest("hex"));
  });

  it("emits the documented header format", () => {
    expect(signatureHeader(SECRET, T, BODY)).toEqual(`t=${T},v1=${signPayload(SECRET, T, BODY)}`);
    expect(signatureHeader(SECRET, T, BODY)).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("a single byte changed in the body invalidates it", () => {
    const header = signatureHeader(SECRET, T, BODY);
    expect(verifySignature(SECRET, header, BODY, { nowSeconds: T })).toBe(true);
    expect(verifySignature(SECRET, header, BODY.replace("evt_1", "evt_2"), { nowSeconds: T })).toBe(false);
  });

  it("the timestamp is INSIDE the signed material, so it cannot be re-stamped", () => {
    const header = signatureHeader(SECRET, T, BODY);
    // The whole attack in one line: take a delivery captured at T, move its
    // clock forward, resend the untouched body and signature. If `t` were not
    // signed this would verify, and the freshness check would be decoration.
    const restamped = header.replace(`t=${T}`, `t=${T + 10}`);
    expect(verifySignature(SECRET, restamped, BODY, { nowSeconds: T + 10 })).toBe(false);
    // Re-stamping far enough to escape a stale delivery is the real-world form.
    const revived = header.replace(`t=${T}`, `t=${T + 4000}`);
    expect(verifySignature(SECRET, revived, BODY, { nowSeconds: T + 4000 })).toBe(false);
  });

  it("rejects a stale delivery outside the tolerance", () => {
    const header = signatureHeader(SECRET, T, BODY);
    expect(verifySignature(SECRET, header, BODY, { nowSeconds: T + 299 })).toBe(true);
    expect(verifySignature(SECRET, header, BODY, { nowSeconds: T + 301 })).toBe(false);
    // Symmetric: a delivery stamped in the future is just as stale.
    expect(verifySignature(SECRET, header, BODY, { nowSeconds: T - 299 })).toBe(true);
    expect(verifySignature(SECRET, header, BODY, { nowSeconds: T - 301 })).toBe(false);
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
  });

  it("honours an explicit tolerance override", () => {
    const header = signatureHeader(SECRET, T, BODY);
    expect(verifySignature(SECRET, header, BODY, { nowSeconds: T + 30, toleranceSeconds: 10 })).toBe(false);
    expect(verifySignature(SECRET, header, BODY, { nowSeconds: T + 30, toleranceSeconds: 60 })).toBe(true);
  });

  it("rejects a wrong secret and a malformed header", () => {
    const header = signatureHeader(SECRET, T, BODY);
    expect(verifySignature("whsec_other", header, BODY, { nowSeconds: T })).toBe(false);
    expect(verifySignature(SECRET, "garbage", BODY, { nowSeconds: T })).toBe(false);
    expect(verifySignature(SECRET, `t=${T},v2=abc`, BODY, { nowSeconds: T })).toBe(false);
  });

  it("rejects every degenerate header shape without throwing", () => {
    const sig = signPayload(SECRET, T, BODY);
    for (const header of [
      "",
      `v1=${sig}`, // no timestamp at all
      `t=,v1=${sig}`, // empty t: Number("") is 0, not NaN — must not slip through
      `t=notanumber,v1=${sig}`,
      `t=${T}`, // no signature
      `t=${T},v1=`,
      `t=${T},v1=zzzz`, // not hex
      `t=${T},v1=${sig.slice(0, 60)}`, // truncated: timingSafeEqual would THROW
      `t=${T},v1=${sig}00`, // over-long
      `=${T},v1=${sig}`, // empty parameter name
    ]) {
      expect(() => verifySignature(SECRET, header, BODY, { nowSeconds: T }), header).not.toThrow();
      expect(verifySignature(SECRET, header, BODY, { nowSeconds: T }), header).toBe(false);
    }
  });

  it("tolerates whitespace and unknown parameters, so v1 can be extended", () => {
    const sig = signPayload(SECRET, T, BODY);
    expect(verifySignature(SECRET, `t=${T}, v1=${sig}`, BODY, { nowSeconds: T })).toBe(true);
    expect(verifySignature(SECRET, `t=${T},v1=${sig},v2=futurescheme`, BODY, { nowSeconds: T })).toBe(true);
  });
});

describe("webhook secret box", () => {
  const KEY = randomBytes(32).toString("hex");

  it("round-trips a secret through the sealed envelope", () => {
    const box = createSecretBox(KEY);
    const secret = box.mint();
    expect(box.open(box.seal(secret))).toBe(secret);
  });

  it("mints a prefixed, high-entropy, url-safe secret", () => {
    const box = createSecretBox(KEY);
    const a = box.mint();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/); // 24 bytes base64url
    expect(box.mint()).not.toEqual(a);
  });

  it("seals with a fresh IV every time — one plaintext, two ciphertexts", () => {
    // Nonce reuse is the catastrophic failure mode of GCM, so this is the one
    // property of the envelope worth asserting directly.
    const box = createSecretBox(KEY);
    const [x, y] = [box.seal("whsec_same"), box.seal("whsec_same")];
    expect(x).not.toEqual(y);
    expect([box.open(x), box.open(y)]).toEqual(["whsec_same", "whsec_same"]);
  });

  it("refuses a master key that is not 32 bytes", () => {
    expect(() => createSecretBox("abcd")).toThrow(/32 bytes/);
    expect(() => createSecretBox(randomBytes(16).toString("hex"))).toThrow(/32 bytes/);
    expect(() => createSecretBox("")).toThrow(/32 bytes/);
  });

  it("fails loudly on a tampered envelope and on the wrong key", () => {
    // The GCM tag is what stops a database row being edited into a signing key
    // of the attacker's choosing; without it, open() would return garbage and
    // the dispatcher would sign with it.
    const box = createSecretBox(KEY);
    const sealed = box.seal("whsec_original");
    const bytes = Buffer.from(sealed, "base64");
    bytes[bytes.length - 1] ^= 0xff;
    expect(() => box.open(bytes.toString("base64"))).toThrow();
    expect(() => createSecretBox(randomBytes(32).toString("hex")).open(sealed)).toThrow();
  });
});

const ep = (o: Partial<WebhookEndpointRecord>): WebhookEndpointRecord => ({
  id: "e", orgId: "org1", url: "https://x.test", description: null, eventTypes: ["*"],
  useCaseKey: null, secretEncrypted: "", status: "active" as const, disabledReason: null,
  disabledAt: null, consecutiveFailures: 0, deletedAt: null, createdBy: "u", createdAt: "",
  lastDeliveryAt: null, ...o,
});
const ev = (o: Partial<EventRecord>): EventRecord => ({
  seq: 1, id: "evt", type: "credential.issued", orgId: "org1", useCaseKey: null,
  subjectId: null, data: {}, occurredAt: "", ...o,
});

describe("webhook fan-out matching", () => {
  it("an org endpoint sees its own org's events and no others", () => {
    expect(endpointMatches(ep({}), ev({ orgId: "org1" }))).toBe(true);
    expect(endpointMatches(ep({}), ev({ orgId: "org2" }))).toBe(false);
  });

  it("an org endpoint NEVER sees a platform-scope event (the null === null trap)", () => {
    expect(endpointMatches(ep({ orgId: null }), ev({ orgId: null }))).toBe(true); // platform sees platform
    expect(endpointMatches(ep({ orgId: "org1" }), ev({ orgId: null }))).toBe(false); // org must not
    // The two lines above are NOT enough on their own, and it is worth saying
    // why: collapsing the rule to `ep.orgId === ev.orgId` satisfies both of them
    // (null === null is true, "org1" === null is false). What that collapse
    // actually destroys is the OTHER arm of the disjunction — a platform
    // endpoint's licence to see an org's events — so the trap is only really
    // sprung by asserting all three together.
    expect(endpointMatches(ep({ orgId: null }), ev({ orgId: "org9" }))).toBe(true);
  });

  it("a platform endpoint sees every org's events", () => {
    expect(endpointMatches(ep({ orgId: null }), ev({ orgId: "org7" }))).toBe(true);
  });

  it("a useCaseKey filter narrows, and a disabled endpoint receives nothing", () => {
    expect(endpointMatches(ep({ useCaseKey: "uc1" }), ev({ useCaseKey: "uc2" }))).toBe(false);
    expect(endpointMatches(ep({ useCaseKey: "uc1" }), ev({ useCaseKey: "uc1" }))).toBe(true);
    // A use-case-scoped endpoint must not receive an org-wide event either.
    expect(endpointMatches(ep({ useCaseKey: "uc1" }), ev({ useCaseKey: null }))).toBe(false);
    expect(endpointMatches(ep({ status: "disabled" }), ev({}))).toBe(false);
    expect(endpointMatches(ep({ deletedAt: "2026-08-09T00:00:00.000Z" }), ev({}))).toBe(false);
  });

  it("the type subscription filters, and '*' takes everything", () => {
    expect(endpointMatches(ep({ eventTypes: ["asset.issued"] }), ev({ type: "credential.issued" }))).toBe(false);
    expect(endpointMatches(ep({ eventTypes: ["asset.issued", "credential.issued"] }), ev({ type: "credential.issued" }))).toBe(true);
    expect(endpointMatches(ep({ eventTypes: ["*"] }), ev({ type: "proposal.executed" }))).toBe(true);
  });
});
