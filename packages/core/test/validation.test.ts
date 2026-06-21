import { describe, it, expect } from "vitest";
import { validateUseCaseDefinition, validateMetadata, PolicyError } from "../src/index.js";
import { FUNGIBLE_USE_CASE } from "./fixtures.js";

describe("validateUseCaseDefinition", () => {
  it("accepts a well-formed definition", () => {
    expect(() => validateUseCaseDefinition(FUNGIBLE_USE_CASE)).not.toThrow();
  });

  it("rejects a missing key", () => {
    const bad = { ...FUNGIBLE_USE_CASE, key: "" };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(PolicyError);
  });

  it("rejects an invalid tokenType", () => {
    const bad = { ...FUNGIBLE_USE_CASE, tokenType: "weird" };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/tokenType/);
  });

  it("rejects a non-boolean lifecycle flag", () => {
    const bad = { ...FUNGIBLE_USE_CASE, lifecycle: { ...FUNGIBLE_USE_CASE.lifecycle, mint: "yes" } };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/lifecycle.mint/);
  });

  it("rejects an unknown role", () => {
    const bad = { ...FUNGIBLE_USE_CASE, roles: ["Wizard"] };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/role/);
  });

  it("rejects a required field absent from properties", () => {
    const bad = {
      ...FUNGIBLE_USE_CASE,
      metadataSchema: { type: "object", properties: { a: { type: "string" } }, required: ["b"] },
    };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/requires unknown property/);
  });
});

describe("validateMetadata", () => {
  const schema = FUNGIBLE_USE_CASE.metadataSchema;

  it("accepts valid metadata", () => {
    expect(() => validateMetadata({ issuer: "ACME", valuation: 100 }, schema)).not.toThrow();
  });

  it("flags a missing required field", () => {
    expect(() => validateMetadata({ valuation: 100 }, schema)).toThrowError(/missing required field 'issuer'/);
  });

  it("flags a wrong field type", () => {
    expect(() => validateMetadata({ issuer: "ACME", valuation: "lots" }, schema)).toThrowError(/should be number/);
  });

  it("tolerates extra fields", () => {
    expect(() => validateMetadata({ issuer: "ACME", extra: true }, schema)).not.toThrow();
  });
});
