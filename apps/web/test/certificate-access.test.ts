import { describe, expect, it } from "vitest";
import { canDesignCertificate } from "../src/lib/identity/certificate-access.js";

const useCase = (ownerOrgId: string | null | undefined) => ({ ownerOrgId }) as never;

describe("canDesignCertificate — the web mirror of the server's ownership gate", () => {
  it("a PlatformAdmin may design any use case, owned or not", () => {
    expect(canDesignCertificate({ role: "PlatformAdmin", orgId: null }, useCase(null))).toBe(true);
    expect(canDesignCertificate({ role: "PlatformAdmin", orgId: "org_1" }, useCase("org_2"))).toBe(true);
  });

  it("an OrgAdmin may design only their own org's use case", () => {
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: "org_1" }, useCase("org_1"))).toBe(true);
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: "org_1" }, useCase("org_2"))).toBe(false);
  });

  it("a null owner is nobody's — the null-as-allow shape the server guards against", () => {
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: "org_1" }, useCase(null))).toBe(false);
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: null }, useCase(null))).toBe(false);
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: undefined }, useCase(undefined))).toBe(false);
    expect(canDesignCertificate({ role: "OrgAdmin", orgId: "  " }, useCase("  "))).toBe(false);
  });

  it("no other role, and no user at all", () => {
    expect(canDesignCertificate({ role: "Issuer", orgId: "org_1" }, useCase("org_1"))).toBe(false);
    expect(canDesignCertificate({ role: "Holder", orgId: "org_1" }, useCase("org_1"))).toBe(false);
    expect(canDesignCertificate(null, useCase("org_1"))).toBe(false);
  });
});
