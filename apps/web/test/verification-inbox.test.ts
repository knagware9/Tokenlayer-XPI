/**
 * Unit cover for the pure pieces of the holder's consent panel
 * (VerificationInbox.tsx) — on the same terms as webhooks-panel.test.ts:
 * apps/web has no DOM test environment, so rendering is verified in the
 * browser and what is asserted here is the logic those renders delegate to.
 *
 * `defaultDisclosuresFor` is the fix for a backward-compatibility bug: it used
 * to default every field to `{ kind: "withhold" }` unless the verifier's
 * request explicitly named it, which meant every pre-existing verifier flow
 * (none of which sends `requestedFields` — it is a brand-new optional
 * feature) discloses NOTHING by default, while `/verify` still reports
 * `valid: true`. The fix: default to full `value` disclosure unless the
 * verifier's request suggests otherwise for that field.
 */
import { describe, expect, it } from "vitest";
import { defaultDisclosuresFor, disclosableFields } from "../src/components/identity/VerificationInbox.js";
import type { FieldRequest } from "../src/types.js";

describe("disclosableFields", () => {
  it("lists every claim field except the subject id", () => {
    expect(disclosableFields({ id: "did:key:zHolder", holderName: "Ramesh", year: 2010 })).toEqual(["holderName", "year"]);
  });
  it("handles missing/undefined claims without throwing", () => {
    expect(disclosableFields(undefined)).toEqual([]);
    expect(disclosableFields(null)).toEqual([]);
  });
});

describe("defaultDisclosuresFor", () => {
  const CLAIMS = { id: "did:key:zHolder", holderName: "Ramesh Kumar", continuousResidenceSinceYear: 2010 };

  it("defaults every field to full value disclosure when the request has no requestedFields at all — backward compatibility", () => {
    const out = defaultDisclosuresFor(CLAIMS, undefined);
    expect(out).toEqual({
      holderName: { kind: "value" },
      continuousResidenceSinceYear: { kind: "value" },
    });
  });

  it("defaults every field to full value disclosure when requestedFields exists but has no entry for this credential's type", () => {
    const out = defaultDisclosuresFor(CLAIMS, {});
    expect(out).toEqual({
      holderName: { kind: "value" },
      continuousResidenceSinceYear: { kind: "value" },
    });
  });

  it("never includes the subject id as a disclosable field", () => {
    const out = defaultDisclosuresFor(CLAIMS, undefined);
    expect(out).not.toHaveProperty("id");
  });

  it("pre-fills a requested predicate as a starting suggestion, not a restriction", () => {
    const requested: Record<string, FieldRequest> = {
      continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 },
    };
    const out = defaultDisclosuresFor(CLAIMS, requested);
    expect(out.continuousResidenceSinceYear).toEqual({ kind: "predicate", op: "lte", threshold: 2011 });
    // A field the request named as "value" — or didn't name at all — still
    // defaults to full value disclosure.
    expect(out.holderName).toEqual({ kind: "value" });
  });

  it("a field requested with kind 'value' defaults to value disclosure", () => {
    const requested: Record<string, FieldRequest> = { holderName: { kind: "value" } };
    const out = defaultDisclosuresFor(CLAIMS, requested);
    expect(out.holderName).toEqual({ kind: "value" });
  });
});
