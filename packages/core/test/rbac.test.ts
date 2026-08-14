import { describe, it, expect } from "vitest";
import { RbacPolicy } from "../src/shared/rbac.js";

describe("RbacPolicy (per-use-case roles)", () => {
  const rbac = new RbacPolicy();
  it("PlatformAdmin and UseCaseAdmin can do every lifecycle action", () => {
    for (const role of ["PlatformAdmin", "UseCaseAdmin"] as const) {
      for (const a of ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "buy", "list", "cancel-listing", "read"] as const) {
        expect(rbac.can(role, a)).toBe(true);
      }
    }
  });
  it("Issuer = issuance + KYC/compliance, not trading", () => {
    expect(rbac.can("Issuer", "mint")).toBe(true);
    expect(rbac.can("Issuer", "allow")).toBe(true);
    expect(rbac.can("Issuer", "freeze")).toBe(true);
    expect(rbac.can("Issuer", "transfer")).toBe(false);
    expect(rbac.can("Issuer", "burn")).toBe(false);
  });
  it("Trader = transfer, burn, and buy", () => {
    expect(rbac.can("Trader", "transfer")).toBe(true);
    expect(rbac.can("Trader", "burn")).toBe(true);
    expect(rbac.can("Trader", "buy")).toBe(true);
    expect(rbac.can("Trader", "mint")).toBe(false);
    expect(rbac.can("Trader", "allow")).toBe(false);
  });
  it("Buyer and Auditor are read-only", () => {
    for (const role of ["Buyer", "Auditor"] as const) {
      expect(rbac.can(role, "read")).toBe(true);
      expect(rbac.can(role, "transfer")).toBe(false);
      expect(rbac.can(role, "mint")).toBe(false);
    }
  });
  it("Buyer and Trader can buy; Auditor cannot", () => {
    expect(rbac.can("Buyer", "buy")).toBe(true);
    expect(rbac.can("Trader", "buy")).toBe(true);
    expect(rbac.can("Auditor", "buy")).toBe(false);
  });
  it("market actions: Buyer/Trader/admins may list and cancel-listing; Issuer/Auditor may not", () => {
    for (const role of ["Buyer", "Trader", "UseCaseAdmin", "PlatformAdmin"] as const) {
      expect(rbac.can(role, "list")).toBe(true);
      expect(rbac.can(role, "cancel-listing")).toBe(true);
    }
    for (const role of ["Issuer", "Auditor"] as const) {
      expect(rbac.can(role, "list")).toBe(false);
      expect(rbac.can(role, "cancel-listing")).toBe(false);
    }
  });
});
