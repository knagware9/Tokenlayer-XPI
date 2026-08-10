import { describe, expect, it } from "vitest";
import {
  A4_LONG_EDGE_PT,
  AUTO_QR_PLACEMENT,
  CERTIFICATE_FIXED_FIELDS,
  MAX_CERTIFICATE_PLACEMENTS,
  certificatePageSize,
  claimKeyOf,
  isClaimRef,
  validateCertificatePlacements,
  type CertificateFieldPlacement,
} from "../src/certificate-fields.js";

const CLAIMS = ["fullName", "district"] as const;
const ok = (p: Partial<CertificateFieldPlacement> = {}): CertificateFieldPlacement =>
  ({ field: "subject.name", x: 0.5, y: 0.4, ...p }) as CertificateFieldPlacement;

/** Run the validator and return the thrown PolicyError's message, or null. */
function failure(placements: unknown): string | null {
  try {
    validateCertificatePlacements(placements, CLAIMS, "DomicileCredential");
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

describe("certificate field refs", () => {
  it("splits claim refs from the closed fixed list", () => {
    expect(isClaimRef("claim:fullName")).toBe(true);
    expect(isClaimRef("subject.name")).toBe(false);
    expect(claimKeyOf("claim:fullName")).toBe("fullName");
    // The QR is a field like any other — that is what makes it PLACEABLE.
    expect(CERTIFICATE_FIXED_FIELDS).toContain("qr");
    // …and heading/subheading stay placeable so a parameterised template
    // heading still prints once artwork replaces the built-in layout.
    expect(CERTIFICATE_FIXED_FIELDS).toContain("config.heading");
  });
});

describe("certificatePageSize", () => {
  it("gives the artwork's aspect with A4's long edge, in both orientations", () => {
    const landscape = certificatePageSize(1600, 900);
    expect(landscape.width).toBeCloseTo(A4_LONG_EDGE_PT, 2);
    expect(landscape.height).toBeCloseTo(A4_LONG_EDGE_PT * (900 / 1600), 2);

    const portrait = certificatePageSize(900, 1600);
    expect(portrait.height).toBeCloseTo(A4_LONG_EDGE_PT, 2);
    expect(portrait.width).toBeCloseTo(A4_LONG_EDGE_PT * (900 / 1600), 2);

    const square = certificatePageSize(1000, 1000);
    expect(square.width).toBeCloseTo(square.height, 2);
  });

  it("falls back to A4 portrait for a degenerate image rather than emitting NaN", () => {
    // A zero dimension would divide to NaN and produce an unopenable PDF.
    for (const [w, h] of [[0, 100], [100, 0], [-1, 5], [Number.NaN, 10]]) {
      const page = certificatePageSize(w as number, h as number);
      expect(Number.isFinite(page.width) && Number.isFinite(page.height)).toBe(true);
      expect(page.height).toBeCloseTo(A4_LONG_EDGE_PT, 2);
    }
  });
});

describe("validateCertificatePlacements", () => {
  it("accepts a well-formed set", () => {
    expect(failure([
      ok(),
      ok({ field: "claim:fullName", fontSize: 18, font: "serif", bold: true, color: "#112233", align: "center", width: 0.6 }),
      ok({ field: "qr", width: 0.2 }),
    ])).toBeNull();
  });

  it("accepts undefined and an empty array", () => {
    expect(failure(undefined)).toBeNull();
    expect(failure([])).toBeNull();
  });

  it("names the credential type and the index so the designer knows which chip is wrong", () => {
    const msg = failure([ok(), ok({ x: 1.5 })]);
    expect(msg).toContain("DomicileCredential");
    expect(msg).toContain("[1]");
  });

  it("rejects an unknown fixed field and an unknown claim", () => {
    expect(failure([ok({ field: "subject.shoeSize" as never })])).toContain("unknown field");
    expect(failure([ok({ field: "claim:notAClaim" as never })])).toContain("notAClaim");
  });

  it("rejects out-of-range geometry in both directions", () => {
    for (const p of [{ x: -0.01 }, { x: 1.01 }, { y: -0.01 }, { y: 1.01 }, { width: 0 }, { width: 1.01 }]) {
      expect(failure([ok(p)]), JSON.stringify(p)).not.toBeNull();
    }
  });

  it("rejects bad styling values", () => {
    expect(failure([ok({ fontSize: 3 })])).not.toBeNull();
    expect(failure([ok({ fontSize: 97 })])).not.toBeNull();
    expect(failure([ok({ font: "comic" as never })])).not.toBeNull();
    expect(failure([ok({ align: "justify" as never })])).not.toBeNull();
    expect(failure([ok({ color: "red" })])).not.toBeNull();
    expect(failure([ok({ color: "#abc" })])).not.toBeNull();
    expect(failure([ok({ color: "#AABBCC" })])).toBeNull(); // uppercase hex is fine
  });

  it("caps the count and allows at most one qr", () => {
    const many = Array.from({ length: MAX_CERTIFICATE_PLACEMENTS + 1 }, () => ok());
    expect(failure(many)).toContain("at most");
    // The same CLAIM may print twice — a name in the body and again on a signature line.
    expect(failure([ok({ field: "claim:fullName" }), ok({ field: "claim:fullName" })])).toBeNull();
    expect(failure([ok({ field: "qr" }), ok({ field: "qr" })])).toContain("qr");
  });

  it("rejects a non-array", () => {
    expect(failure({ field: "subject.name" })).not.toBeNull();
  });

  it("exposes the auto-inserted QR geometry as data, so the renderer and the tests agree", () => {
    expect(AUTO_QR_PLACEMENT.field).toBe("qr");
    expect(AUTO_QR_PLACEMENT.x).toBeGreaterThan(0.5);
    expect(AUTO_QR_PLACEMENT.y).toBeGreaterThan(0.5);
  });
});

describe("the QR must actually land on the page", () => {
  // Rule 1 says a QR is ALWAYS drawn. Enforcing that against the draw list only
  // — exactly one op — let a designer place it entirely outside the MediaBox or
  // shrink it below anything scannable, and still emit a valid PDF.
  it("refuses a QR that would fall off the page", () => {
    expect(failure([{ field: "qr", x: 1, y: 1, width: 0.14 }])).toContain("past the page");
    expect(failure([{ field: "qr", x: 0.95, y: 0.5, width: 0.14 }])).toContain("past the page");
    expect(failure([{ field: "qr", x: 0.5, y: 0.95, width: 0.14 }])).toContain("past the page");
  });

  it("refuses a QR too small to scan", () => {
    expect(failure([{ field: "qr", x: 0.5, y: 0.5, width: 0.0001 }])).toContain("reliably scan");
  });

  it("still accepts a QR that fits, including one hard against the far corner", () => {
    expect(failure([{ field: "qr", x: 0.86, y: 0.86, width: 0.14 }])).toBeNull();
    expect(failure([{ field: "qr", x: 0.5, y: 0.5 }])).toBeNull(); // default width
  });

  it("applies none of this to TEXT placements, which may legitimately sit at the edge", () => {
    expect(failure([{ field: "subject.name", x: 1, y: 1 }])).toBeNull();
  });

  it("AUTO_QR_PLACEMENT itself satisfies the rule — the fallback cannot be off-page", () => {
    expect(failure([AUTO_QR_PLACEMENT])).toBeNull();
  });
});
