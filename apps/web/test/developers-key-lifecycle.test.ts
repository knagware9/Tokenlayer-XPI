/**
 * Unit cover for the two pure pieces of the Developers (EN-B) surface that carry
 * a real invariant: which key statuses may be rotated, and the shell-level guard
 * that stops a navigation from silently destroying an unacknowledged secret.
 *
 * These are deliberately narrow. apps/web has no DOM test environment, so the
 * component's rendering is verified in the browser rather than here; what is
 * asserted below is the logic those renders delegate to.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_KEY_DRAFT, canRotate, checkKeyDraft } from "../src/components/Developers.js";
import { confirmNavigation, setNavGuard } from "../src/lib/nav-guard.js";

describe("canRotate", () => {
  it("offers rotation for an active key", () => {
    expect(canRotate("active")).toBe(true);
  });

  it("refuses rotation for an EXPIRED key", () => {
    // The server allows this rotation (it only refuses on revokedAt), and it
    // leaves expiresAt untouched — so the secret it mints is already expired and
    // 401s on its first call. The console must not offer the ceremony.
    expect(canRotate("expired")).toBe(false);
  });

  it("refuses rotation for a revoked key", () => {
    expect(canRotate("revoked")).toBe(false);
  });

  it("admits exactly one status", () => {
    const statuses = ["active", "expired", "revoked"] as const;
    expect(statuses.filter(canRotate)).toEqual(["active"]);
  });
});

describe("create-key draft", () => {
  it("starts with no role at all", () => {
    // The whole point: not "the least privileged role", not "the first offered
    // role" — nothing. KEY_ROLES is ordered most→least privileged, so any
    // seeded default is a privileged default.
    expect(EMPTY_KEY_DRAFT.role).toBe("");
  });

  it("refuses the exact path that used to mint an OrgAdmin key", () => {
    // Type a name, tick one scope, submit — never opening the role select.
    const check = checkKeyDraft({ ...EMPTY_KEY_DRAFT, name: "ERP invoice sync", scopes: ["assets:read"] });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.message).toMatch(/role/i);
  });

  it("accepts the same draft once a role is chosen, and narrows it", () => {
    const check = checkKeyDraft({ name: "ERP invoice sync", role: "Auditor", scopes: ["assets:read"] });
    expect(check).toEqual({ ok: true, role: "Auditor" });
  });

  it("still requires a name and at least one scope", () => {
    expect(checkKeyDraft({ name: "   ", role: "Issuer", scopes: ["assets:read"] }).ok).toBe(false);
    expect(checkKeyDraft({ name: "n", role: "Issuer", scopes: [] }).ok).toBe(false);
  });
});

describe("nav guard", () => {
  it("permits navigation when nothing is registered", () => {
    expect(confirmNavigation()).toBe(true);
  });

  it("blocks navigation when the registered guard declines", () => {
    const release = setNavGuard(() => false);
    try {
      expect(confirmNavigation()).toBe(false);
    } finally {
      release();
    }
    expect(confirmNavigation()).toBe(true);
  });

  it("permits navigation when the registered guard consents", () => {
    const release = setNavGuard(() => true);
    try {
      expect(confirmNavigation()).toBe(true);
    } finally {
      release();
    }
  });

  it("keeps an EARLIER guard alive after a later one is released", () => {
    // THE REGRESSION CASE, and the only one here that a single-slot
    // implementation fails. EN-C puts two surfaces that each hold a one-time
    // secret on the Developers screen (the API key and a webhook signing
    // secret), so both can have a live guard at the same time. With one slot the
    // second registration silently REPLACED the first, and releasing the second
    // — acknowledging the webhook secret — left nothing registered while the API
    // key secret was still unacknowledged: a click could then discard it with no
    // confirmation at all.
    //
    // The two guards must disagree for the test to have teeth. The sibling case
    // below registers false + false, which a single slot also passes, since
    // whichever guard survives says the same thing.
    const releaseA = setNavGuard(() => false);
    const releaseB = setNavGuard(() => true);
    try {
      // A is still registered and still refusing, so navigation is refused.
      releaseB();
      expect(confirmNavigation()).toBe(false);
    } finally {
      releaseA();
    }
    expect(confirmNavigation()).toBe(true);
  });

  it("does not let a stale release clear a newer guard", () => {
    // Two reveals in a row remount the panel, so an old effect's cleanup can run
    // after the new effect registered. If that cleanup cleared the live guard,
    // the second secret would be losable without a confirmation.
    const releaseOld = setNavGuard(() => false);
    const releaseNew = setNavGuard(() => false);
    releaseOld();
    expect(confirmNavigation()).toBe(false);
    releaseNew();
    expect(confirmNavigation()).toBe(true);
  });
});
