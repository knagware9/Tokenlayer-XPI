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

  it("useOrgLogo prefers the org door, and the shell passes the org id so it takes it", () => {
    const hook = shell.slice(shell.indexOf("export function useOrgLogo"), shell.indexOf("export function AppShell"));
    expect(hook).toContain("api.brandLogo(token, orgId)");
    // The document-store call survives ON PURPOSE: it is the only way to render
    // a logo that has been uploaded but not yet saved as the org's mark, which
    // is what the brand editor's preview shows.
    expect(hook).toContain("api.downloadDocument(token, documentId)");
    expect(shell).toContain("useOrgLogo(user?.brandLogoDocumentId, token, user?.orgId)");
  });

  it("the object-URL lifecycle is intact — a leaked blob outlives the tab", () => {
    const hook = shell.slice(shell.indexOf("export function useOrgLogo"), shell.indexOf("export function AppShell"));
    expect(hook).toContain("URL.revokeObjectURL(objectUrl)");
    // The late-resolving fetch must not install its blob over a newer one.
    expect(hook).toContain("if (cancelled) return;");
  });
});
