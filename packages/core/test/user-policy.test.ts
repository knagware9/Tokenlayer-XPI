import { describe, it, expect } from "vitest";
import { RbacPolicy } from "../src/rbac.js";
import { assignableRoles, canCreateOrgMember, canManageUsers, canCreateUser } from "../src/user-policy.js";
import { ROLES } from "../src/types.js";

describe("user-policy", () => {
  it("PlatformAdmin may mint any roster role, in an explicit use case (gated onboarding)", () => {
    expect(assignableRoles("PlatformAdmin")).toEqual(["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"]);
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "UseCaseAdmin", "carbon-credit")).toBe(true);
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "UseCaseAdmin", null)).toBe(false);
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "Issuer", "carbon-credit")).toBe(true);
  });
  it("UseCaseAdmin may create roster roles only in their own use case", () => {
    expect(assignableRoles("UseCaseAdmin")).toEqual(["Issuer", "Buyer", "Auditor"]);
    const admin = { role: "UseCaseAdmin", useCaseKey: "carbon-credit" } as const;
    expect(canCreateUser(admin, "Issuer", "carbon-credit")).toBe(true);
    expect(canCreateUser(admin, "Buyer", "carbon-credit")).toBe(true);
    expect(canCreateUser(admin, "Issuer", "gold-loan")).toBe(false);
    expect(canCreateUser(admin, "UseCaseAdmin", "carbon-credit")).toBe(false);
    expect(canCreateUser(admin, "PlatformAdmin", "carbon-credit")).toBe(false);
    expect(canCreateUser(admin, "Issuer", null)).toBe(false); // a UseCaseAdmin cannot create a user with no use case
  });
  it("roster roles cannot manage users at all", () => {
    expect(canManageUsers("Issuer")).toBe(false);
    expect(canManageUsers("Buyer")).toBe(false);
    expect(canManageUsers("PlatformAdmin")).toBe(true);
    expect(canManageUsers("UseCaseAdmin")).toBe(true);
  });
});

describe("OrgAdmin role", () => {
  it("is a known role", () => {
    expect(ROLES).toContain("OrgAdmin");
  });

  it("has only read authority in the RBAC matrix", () => {
    const rbac = new RbacPolicy();
    expect(rbac.can("OrgAdmin", "read")).toBe(true);
    for (const action of ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "buy", "list", "cancel-listing"] as const) {
      expect(rbac.can("OrgAdmin", action)).toBe(false);
    }
  });

  it("can manage users and assign org-internal roles", () => {
    expect(canManageUsers("OrgAdmin")).toBe(true);
    expect(assignableRoles("OrgAdmin")).toEqual(["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"]);
  });
});

describe("canCreateOrgMember", () => {
  it("lets PlatformAdmin create an OrgAdmin but OrgAdmin cannot", () => {
    expect(canCreateOrgMember("PlatformAdmin", "OrgAdmin")).toBe(true);
    expect(canCreateOrgMember("OrgAdmin", "OrgAdmin")).toBe(false);
  });
  it("lets both admins create org-internal roles", () => {
    for (const r of ["PlatformAdmin", "OrgAdmin"] as const) {
      expect(canCreateOrgMember(r, "Issuer")).toBe(true);
      expect(canCreateOrgMember(r, "Buyer")).toBe(true);
    }
  });
  it("never allows creating a PlatformAdmin", () => {
    expect(canCreateOrgMember("PlatformAdmin", "PlatformAdmin")).toBe(false);
    expect(canCreateOrgMember("OrgAdmin", "PlatformAdmin")).toBe(false);
  });
});

describe("PlatformAdmin assignable roles (gated onboarding)", () => {
  it("PlatformAdmin may assign every roster role", () => {
    expect(assignableRoles("PlatformAdmin")).toEqual(["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"]);
  });
  it("PlatformAdmin may create a Buyer in a named use case, but never without one", () => {
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "Buyer", "invoice-tokenization")).toBe(true);
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "Buyer", null)).toBe(false);
  });
  it("UseCaseAdmin scope is unchanged", () => {
    expect(canCreateUser({ role: "UseCaseAdmin", useCaseKey: "a" }, "Buyer", "a")).toBe(true);
    expect(canCreateUser({ role: "UseCaseAdmin", useCaseKey: "a" }, "Buyer", "b")).toBe(false);
  });
});
