import { describe, it, expect } from "vitest";
import { UseCaseRegistry, RbacPolicy, PolicyError } from "../src/index.js";
import { FUNGIBLE_USE_CASE, NO_TRANSFER_USE_CASE } from "./fixtures.js";

describe("UseCaseRegistry", () => {
  it("registers and retrieves definitions", () => {
    const reg = new UseCaseRegistry([FUNGIBLE_USE_CASE, NO_TRANSFER_USE_CASE]);
    expect(reg.has("generic-asset")).toBe(true);
    expect(reg.get("generic-asset").name).toBe("Generic Asset");
    expect(reg.list()).toHaveLength(2);
  });

  it("throws on unknown key", () => {
    const reg = new UseCaseRegistry([FUNGIBLE_USE_CASE]);
    expect(() => reg.get("nope")).toThrowError(/unknown use case/);
  });

  it("rejects duplicate keys", () => {
    expect(() => new UseCaseRegistry([FUNGIBLE_USE_CASE, FUNGIBLE_USE_CASE])).toThrowError(/duplicate/);
  });

  it("validates definitions at construction", () => {
    expect(() => new UseCaseRegistry([{ key: "x" }])).toThrowError(PolicyError);
  });
});

describe("RbacPolicy", () => {
  const rbac = new RbacPolicy();

  it("lets Admin do everything", () => {
    for (const action of ["issue", "mint", "transfer", "burn", "freeze", "allow", "read"] as const) {
      expect(rbac.can("Admin", action)).toBe(true);
    }
  });

  it("limits Viewer to read", () => {
    expect(rbac.can("Viewer", "read")).toBe(true);
    expect(rbac.can("Viewer", "mint")).toBe(false);
  });

  it("lets Issuer mint but not transfer", () => {
    expect(rbac.can("Issuer", "mint")).toBe(true);
    expect(rbac.can("Issuer", "transfer")).toBe(false);
  });

  it("lets Operator transfer/freeze but not issue", () => {
    expect(rbac.can("Operator", "transfer")).toBe(true);
    expect(rbac.can("Operator", "freeze")).toBe(true);
    expect(rbac.can("Operator", "issue")).toBe(false);
  });

  it("authorize throws FORBIDDEN", () => {
    expect(() => rbac.authorize({ id: "u1", role: "Viewer" }, "mint")).toThrowError(/may not perform/);
  });
});
