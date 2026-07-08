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

  it("accepts a document field type", () => {
    const ok = {
      ...FUNGIBLE_USE_CASE,
      metadataSchema: { type: "object", properties: { prospectus: { type: "document" } } },
    };
    expect(() => validateUseCaseDefinition(ok)).not.toThrow();
  });

  it("rejects enum on a non-string field", () => {
    const bad = {
      ...FUNGIBLE_USE_CASE,
      metadataSchema: { type: "object", properties: { n: { type: "number", enum: ["a"] } } },
    };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/enum/);
  });

  it("rejects an empty enum", () => {
    const bad = {
      ...FUNGIBLE_USE_CASE,
      metadataSchema: { type: "object", properties: { s: { type: "string", enum: [] } } },
    };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/enum must be a non-empty array/);
  });

  it("rejects min > max on a number field", () => {
    const bad = {
      ...FUNGIBLE_USE_CASE,
      metadataSchema: { type: "object", properties: { n: { type: "number", min: 10, max: 5 } } },
    };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/min > max/);
  });

  it("rejects min/max on a non-number field", () => {
    const bad = {
      ...FUNGIBLE_USE_CASE,
      metadataSchema: { type: "object", properties: { s: { type: "string", min: 1 } } },
    };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/min'\/'max/);
  });

  it("rejects a pattern that does not compile", () => {
    const bad = {
      ...FUNGIBLE_USE_CASE,
      metadataSchema: { type: "object", properties: { s: { type: "string", pattern: "(" } } },
    };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/not a valid RegExp/);
  });

  it("rejects a marketplaceBps out of range", () => {
    const bad = { ...FUNGIBLE_USE_CASE, fees: { marketplaceBps: 20000 } };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/marketplaceBps/);
  });

  it("rejects a negative issuanceFlat", () => {
    const bad = { ...FUNGIBLE_USE_CASE, fees: { issuanceFlat: "-5" } };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/issuanceFlat/);
  });

  it("accepts valid fees and compliance rules", () => {
    const ok = {
      ...FUNGIBLE_USE_CASE,
      compliance: { ...FUNGIBLE_USE_CASE.compliance, maxHolders: 3, lockupDays: 30, allowedJurisdictions: ["IN"] },
      fees: { marketplaceBps: 250, issuanceFlat: "100" },
      saleTermsDefault: { unitPrice: "5", currency: "CBDC-INR" },
    };
    expect(() => validateUseCaseDefinition(ok)).not.toThrow();
  });

  it("rejects a non-positive maxHolders", () => {
    const bad = { ...FUNGIBLE_USE_CASE, compliance: { ...FUNGIBLE_USE_CASE.compliance, maxHolders: 0 } };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/maxHolders/);
  });

  it("rejects an empty allowedJurisdictions", () => {
    const bad = { ...FUNGIBLE_USE_CASE, compliance: { ...FUNGIBLE_USE_CASE.compliance, allowedJurisdictions: [] } };
    expect(() => validateUseCaseDefinition(bad)).toThrowError(/allowedJurisdictions/);
  });

  // A base definition that declares an `invoiceHash` metadata property, so the
  // derivedFields/uniqueBy positive cases below have a real target field.
  const withInvoiceHash = {
    ...FUNGIBLE_USE_CASE,
    metadataSchema: {
      ...FUNGIBLE_USE_CASE.metadataSchema,
      properties: { ...FUNGIBLE_USE_CASE.metadataSchema.properties, invoiceHash: { type: "string" as const } },
    },
  };

  it("accepts derivedFields.invoiceHash = invoiceFingerprint and uniqueBy = invoiceHash", () => {
    const def = { ...withInvoiceHash, derivedFields: { invoiceHash: "invoiceFingerprint" }, uniqueBy: "invoiceHash" };
    expect(() => validateUseCaseDefinition(def)).not.toThrow();
  });

  it("rejects an unknown derivedFields generator", () => {
    const def = { ...withInvoiceHash, derivedFields: { invoiceHash: "nope" } };
    expect(() => validateUseCaseDefinition(def)).toThrow(/derivedFields/);
  });

  it("rejects uniqueBy that is not a declared metadata field", () => {
    const def = { ...withInvoiceHash, uniqueBy: "notAField" };
    expect(() => validateUseCaseDefinition(def)).toThrow(/uniqueBy/);
  });

  // A base definition with invoice-style `amountInr` + `dueDate` metadata
  // fields, so the `terms` cases below can point at real declared properties.
  const withInvoiceFields = (extra: Record<string, unknown>) => ({
    ...FUNGIBLE_USE_CASE,
    metadataSchema: {
      ...FUNGIBLE_USE_CASE.metadataSchema,
      properties: {
        ...FUNGIBLE_USE_CASE.metadataSchema.properties,
        amountInr: { type: "number" as const },
        dueDate: { type: "string" as const },
      },
    },
    ...extra,
  });

  it("accepts a valid terms block", () => {
    const def = withInvoiceFields({ terms: { principalField: "amountInr", maturityField: "dueDate", currency: "CBDC-INR" } });
    expect(() => validateUseCaseDefinition(def)).not.toThrow();
  });
  it("rejects terms pointing at undeclared metadata fields", () => {
    const def = withInvoiceFields({ terms: { principalField: "nope", maturityField: "dueDate", currency: "CBDC-INR" } });
    expect(() => validateUseCaseDefinition(def)).toThrow(/terms/);
  });
  it("rejects a periodic frequency without a rateField, and an unknown frequency", () => {
    expect(() => validateUseCaseDefinition(withInvoiceFields({ terms: { principalField: "amountInr", maturityField: "dueDate", frequency: "quarterly", currency: "CBDC-INR" } }))).toThrow(/rateField/);
    expect(() => validateUseCaseDefinition(withInvoiceFields({ terms: { principalField: "amountInr", maturityField: "dueDate", frequency: "weekly", currency: "CBDC-INR" } }))).toThrow(/frequency/);
  });

  it("accepts a valid workflow block", () => {
    const def = { ...FUNGIBLE_USE_CASE, workflow: { approvals: { issue: 1, "cashflow-execute": 2 } } };
    expect(() => validateUseCaseDefinition(def)).not.toThrow();
  });
  it("rejects unknown gated ops and non-positive counts", () => {
    expect(() => validateUseCaseDefinition({ ...FUNGIBLE_USE_CASE, workflow: { approvals: { list: 1 } } })).toThrow(/workflow/);
    expect(() => validateUseCaseDefinition({ ...FUNGIBLE_USE_CASE, workflow: { approvals: { issue: 0 } } })).toThrow(/workflow/);
    expect(() => validateUseCaseDefinition({ ...FUNGIBLE_USE_CASE, workflow: { approvals: { issue: 1.5 } } })).toThrow(/workflow/);
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

  it("enforces enum membership", () => {
    const s = { type: "object" as const, properties: { grade: { type: "string" as const, enum: ["A", "B"] } } };
    expect(() => validateMetadata({ grade: "A" }, s)).not.toThrow();
    expect(() => validateMetadata({ grade: "C" }, s)).toThrowError(/must be one of/);
  });

  it("enforces numeric min/max at the boundary (inclusive)", () => {
    const s = { type: "object" as const, properties: { pct: { type: "number" as const, min: 0, max: 100 } } };
    expect(() => validateMetadata({ pct: 0 }, s)).not.toThrow();
    expect(() => validateMetadata({ pct: 100 }, s)).not.toThrow();
    expect(() => validateMetadata({ pct: -1 }, s)).toThrowError(/must be >= 0/);
    expect(() => validateMetadata({ pct: 101 }, s)).toThrowError(/must be <= 100/);
  });

  it("enforces string pattern", () => {
    const s = { type: "object" as const, properties: { code: { type: "string" as const, pattern: "^[A-Z]{3}$" } } };
    expect(() => validateMetadata({ code: "ABC" }, s)).not.toThrow();
    expect(() => validateMetadata({ code: "abc" }, s)).toThrowError(/must match pattern/);
  });

  it("enforces document URL format", () => {
    const s = { type: "object" as const, properties: { doc: { type: "document" as const } } };
    expect(() => validateMetadata({ doc: "https://example.com/x.pdf" }, s)).not.toThrow();
    expect(() => validateMetadata({ doc: "not-a-url" }, s)).toThrowError(/http\(s\) URL/);
    // a non-string document value fails the string type check
    expect(() => validateMetadata({ doc: 42 }, s)).toThrowError(/should be string/);
  });
});
