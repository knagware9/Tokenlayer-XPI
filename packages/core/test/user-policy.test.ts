import { describe, it, expect } from "vitest";
import { assignableRoles, canManageUsers, canCreateUser } from "../src/user-policy.js";

describe("user-policy", () => {
  it("PlatformAdmin may only mint UseCaseAdmins, in an explicit use case", () => {
    expect(assignableRoles("PlatformAdmin")).toEqual(["UseCaseAdmin"]);
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "UseCaseAdmin", "carbon-credit")).toBe(true);
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "UseCaseAdmin", null)).toBe(false);
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "Issuer", "carbon-credit")).toBe(false);
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
