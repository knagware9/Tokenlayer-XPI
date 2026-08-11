import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * EN-E, Task 6b: THE SHELL MUST FETCH THE MARK THROUGH THE ORG'S OWN DOOR.
 *
 * `GET /documents/:id` requires the `issue` capability or the Auditor role, so
 * it 403s for every role that renders this shell except a desk operator's — the
 * OrgAdmin who uploaded the logo included. Pointing the sidebar back at it
 * would make the mark invisible again for OrgAdmin, Trader, Buyer, Holder and
 * Verifier, and nothing would fail: the hook swallows the error on purpose,
 * because a missing logo is not worth an error surface in the chrome.
 *
 * A SOURCE-TEXT TEST, deliberately. There is no DOM in this package's suite and
 * the failure being guarded is a silent one, so what is pinned is the wiring an
 * author would change. It is narrow — three claims — and each names the call it
 * is about, so a rename fails loudly rather than passing vacuously.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the org logo goes through GET /orgs/:id/branding/logo", () => {
  const api = read("../src/api.ts");
  const shell = read("../src/components/AppShell.tsx");

  it("the client method exists, returns a Blob, and puts NO document id in the URL", () => {
    const method = api.slice(api.indexOf("brandLogo: async"), api.indexOf("orgMembers:"));
    expect(method).toContain("Promise<Blob>");
    expect(method).toContain("/branding/logo`");
    // The containment that keeps this from becoming a second way into the
    // document store: the server reads the org's own brandLogoDocumentId.
    expect(method).not.toContain("/documents/");
    expect(method).toContain("res.blob()");
  });

  it("useOrgLogo uses the org door and has NO id-addressed fallback", () => {
    const hook = shell.slice(shell.indexOf("export function useOrgLogo"), shell.indexOf("export function AppShell"));
    expect(hook).toContain("api.brandLogo(token, orgId)");
    // TIGHTENED after Task 6b. The hook first kept a `downloadDocument` fallback
    // for the one case the org door cannot serve — a logo UPLOADED but not yet
    // saved, which is not the org's mark yet. But that path 403s for an
    // OrgAdmin, so the brand editor's own preview was still blank for the role
    // the editor exists for: the 403 moved rather than closed.
    //
    // The editor now previews a pending upload from the `File` the browser
    // already read to upload it — no request, no gate, same bytes — so the
    // fallback has no remaining caller. Asserting its ABSENCE is the stronger
    // claim: nobody can quietly reintroduce the 403 by reaching for it.
    expect(hook).not.toContain("downloadDocument");
    expect(shell).toContain("useOrgLogo(user?.brandLogoDocumentId, token, user?.orgId)");
  });

  it("the brand editor previews a pending upload locally, not through the document store", () => {
    const orgs = read("../src/components/Organizations.tsx");
    const card = orgs.slice(orgs.indexOf("function OrgBrandingCard"), orgs.indexOf("export function Organizations"));
    // The saved mark comes through the org's door...
    expect(card).toContain("useOrgLogo(org.brandLogoDocumentId ?? null, token, org.id)");
    // ...and the pending one from the File itself, never re-fetched by id.
    expect(card).toContain("URL.createObjectURL(file)");
    expect(card).not.toContain("downloadDocument");
    // One object URL alive at a time, tracked in a REF rather than read out of
    // a `setState` updater. `<StrictMode>` double-invokes updaters, so the
    // create/revoke-inside-the-updater shape this replaced leaked one blob per
    // pick, and React promises nothing about an updater running on unmount.
    expect(card).toContain("URL.revokeObjectURL(pendingUrl.current)");
    expect(card).toContain("pendingUrl.current = file ? URL.createObjectURL(file) : null");
  });

  it("the editor saves only what CHANGED, so a logo-only save cannot pin the platform's own colour", () => {
    const orgs = read("../src/components/Organizations.tsx");
    const card = orgs.slice(orgs.indexOf("function OrgBrandingCard"), orgs.indexOf("export function Organizations"));
    // Sending both keys made an OrgAdmin who only uploaded a logo persist
    // DEFAULT_ACCENT — the platform's teal — as their org's accent, which then
    // ran through clampAccent and repainted the console a colour nobody chose.
    // The omitted-key semantics exist end to end; this is the caller using them.
    expect(card).toContain("void save(changedBranding())");
    expect(card).toContain("if (accent !== (org.brandAccent ?? DEFAULT_ACCENT)) patch.brandAccent = accent;");
    expect(card).toContain("if (logoId !== (org.brandLogoDocumentId ?? null)) patch.brandLogoDocumentId = logoId;");
    // Clear still sends both, explicitly null — that is a different act.
    expect(card).toContain("void save({ brandAccent: null, brandLogoDocumentId: null })");
  });

  it("the object-URL lifecycle is intact — a leaked blob outlives the tab", () => {
    const hook = shell.slice(shell.indexOf("export function useOrgLogo"), shell.indexOf("export function AppShell"));
    expect(hook).toContain("URL.revokeObjectURL(objectUrl)");
    // The late-resolving fetch must not install its blob over a newer one.
    expect(hook).toContain("if (cancelled) return;");
  });
});
