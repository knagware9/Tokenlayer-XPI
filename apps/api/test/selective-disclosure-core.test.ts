import { describe, expect, it } from "vitest";
import {
  evaluatePredicate, validateRequestedFields, resolveDisclosures, redactClaims,
  type FieldRequest, type DisclosureChoice, type ResolvedDisclosure,
} from "../src/identity/selective-disclosure.js";

describe("evaluatePredicate", () => {
  it("evaluates every operator correctly", () => {
    expect(evaluatePredicate(2011, "lte", 2011)).toBe(true);
    expect(evaluatePredicate(2012, "lte", 2011)).toBe(false);
    expect(evaluatePredicate(2011, "gte", 2011)).toBe(true);
    expect(evaluatePredicate(2010, "gte", 2011)).toBe(false);
    expect(evaluatePredicate(5, "gt", 4)).toBe(true);
    expect(evaluatePredicate(4, "gt", 4)).toBe(false);
    expect(evaluatePredicate(3, "lt", 4)).toBe(true);
    expect(evaluatePredicate(4, "lt", 4)).toBe(false);
    expect(evaluatePredicate(7, "eq", 7)).toBe(true);
    expect(evaluatePredicate(7, "eq", 8)).toBe(false);
  });
});

const SCHEMAS = new Map([
  ["DomicileCredential", { properties: { holderName: { type: "string" }, continuousResidenceSinceYear: { type: "number" } } }],
]);

describe("validateRequestedFields", () => {
  it("passes through undefined unchanged", () => {
    expect(validateRequestedFields(undefined, SCHEMAS)).toBeNull();
  });
  it("accepts a value request and a predicate request on a numeric field", () => {
    const req: Record<string, Record<string, FieldRequest>> = {
      DomicileCredential: { holderName: { kind: "value" }, continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 } },
    };
    expect(validateRequestedFields(req, SCHEMAS)).toBeNull();
  });
  it("rejects an unknown credential type", () => {
    const req: Record<string, Record<string, FieldRequest>> = { NotAType: { x: { kind: "value" } } };
    const err = validateRequestedFields(req, SCHEMAS);
    expect(err?.error).toBe("UNKNOWN_FIELD");
  });
  it("rejects an unknown field on a known type", () => {
    const req: Record<string, Record<string, FieldRequest>> = { DomicileCredential: { notAField: { kind: "value" } } };
    const err = validateRequestedFields(req, SCHEMAS);
    expect(err?.error).toBe("UNKNOWN_FIELD");
  });
  it("rejects a predicate on a non-numeric field", () => {
    const req: Record<string, Record<string, FieldRequest>> = { DomicileCredential: { holderName: { kind: "predicate", op: "eq", threshold: 1 } } };
    const err = validateRequestedFields(req, SCHEMAS);
    expect(err?.error).toBe("INVALID_PREDICATE_FIELD");
  });
});

const CLAIMS = new Map([
  ["cred_1", { holderName: "Ramesh Kumar", continuousResidenceSinceYear: 2010 }],
]);

describe("resolveDisclosures", () => {
  it("returns resolved: null when disclosures is undefined", () => {
    const r = resolveDisclosures(undefined, CLAIMS);
    expect(r).toEqual({ ok: true, resolved: null });
  });
  it("rejects a credential id not in claimsByCredentialId", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = { cred_missing: { holderName: { kind: "value" } } };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("UNKNOWN_CREDENTIAL");
  });
  it("rejects an unknown field on a known credential", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = { cred_1: { notAField: { kind: "value" } } };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("UNKNOWN_FIELD");
  });
  it("rejects a predicate on a non-numeric claim", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = { cred_1: { holderName: { kind: "predicate", op: "eq", threshold: 1 } } };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("INVALID_PREDICATE_FIELD");
  });
  it("resolves a value disclosure, a true predicate, a false predicate, and omits a withheld field", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = {
      cred_1: {
        holderName: { kind: "value" },
        continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 },
      },
    };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.resolved).toEqual({
      cred_1: {
        holderName: { kind: "value", value: "Ramesh Kumar" },
        continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011, result: true },
      },
    });
  });
  it("a withheld field produces no entry in the resolved map", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = { cred_1: { holderName: { kind: "withhold" } } };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.resolved).toEqual({ cred_1: {} });
  });
  it("a failing predicate still resolves ok with result: false", () => {
    const d: Record<string, Record<string, DisclosureChoice>> = {
      cred_1: { continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2005 } },
    };
    const r = resolveDisclosures(d, CLAIMS);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.resolved.cred_1.continuousResidenceSinceYear).toEqual({ kind: "predicate", op: "lte", threshold: 2005, result: false });
  });
});

describe("redactClaims", () => {
  it("falls back to full claims when resolved is undefined", () => {
    const full = { a: 1, b: "x" };
    expect(redactClaims(full, undefined)).toBe(full);
  });
  it("falls back to null full claims unchanged when resolved is undefined", () => {
    expect(redactClaims(null, undefined)).toBeNull();
  });
  it("builds a value field and a predicate field, omitting anything not in resolved", () => {
    const resolved: Record<string, ResolvedDisclosure> = {
      holderName: { kind: "value", value: "Ramesh Kumar" },
      continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011, result: true },
    };
    const out = redactClaims({ holderName: "Ramesh Kumar", continuousResidenceSinceYear: 2010, state: "Maharashtra" }, resolved);
    expect(out).toEqual({
      holderName: "Ramesh Kumar",
      continuousResidenceSinceYear: { predicate: { op: "lte", threshold: 2011, result: true } },
    });
    expect(out).not.toHaveProperty("state");
  });
  it("an empty resolved map (everything withheld) produces an empty claims object", () => {
    expect(redactClaims({ a: 1 }, {})).toEqual({});
  });
});
