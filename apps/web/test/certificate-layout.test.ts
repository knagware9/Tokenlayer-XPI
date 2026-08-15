import { describe, expect, it } from "vitest";
import {
  addPlacement,
  clampFontSize,
  fieldLabel,
  movePlacement,
  paletteFields,
  removePlacement,
  stalePlacementFields,
  withoutStalePlacements,
} from "../src/lib/identity/certificate-layout.js";
import { DEFAULT_QR_WIDTH, MAX_CERTIFICATE_PLACEMENTS, type CertificateFieldPlacement } from "../src/types.js";

const CLAIMS = ["fullName", "district"];

describe("paletteFields", () => {
  it("offers every claim first, then the fixed fields", () => {
    const palette = paletteFields(CLAIMS, []);
    expect(palette.slice(0, 2)).toEqual(["claim:fullName", "claim:district"]);
    expect(palette).toContain("subject.name");
    expect(palette).toContain("qr");
  });

  it("withdraws the QR once one is placed — a second is refused server-side", () => {
    expect(paletteFields(CLAIMS, [{ field: "qr", x: 0.8, y: 0.8 }])).not.toContain("qr");
  });

  it("keeps a claim available after placing it — the same value may print twice", () => {
    const palette = paletteFields(CLAIMS, [{ field: "claim:fullName", x: 0.5, y: 0.5 }]);
    expect(palette).toContain("claim:fullName");
  });
});

describe("addPlacement", () => {
  it("drops a new field at the canvas centre", () => {
    const next = addPlacement([], "subject.name");
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ field: "subject.name", x: 0.5, y: 0.5 });
  });

  it("gives a QR its default width so the chip has a size before anyone edits it", () => {
    expect(addPlacement([], "qr")[0]!.width).toBe(DEFAULT_QR_WIDTH);
  });

  it("refuses to exceed the server-side cap instead of building a config that 400s on save", () => {
    const full: CertificateFieldPlacement[] = Array.from(
      { length: MAX_CERTIFICATE_PLACEMENTS },
      () => ({ field: "subject.name", x: 0.5, y: 0.5 }),
    );
    expect(addPlacement(full, "subject.did")).toHaveLength(MAX_CERTIFICATE_PLACEMENTS);
  });
});

describe("movePlacement", () => {
  const one: CertificateFieldPlacement[] = [{ field: "subject.name", x: 0.5, y: 0.5 }];

  it("converts a pointer position inside the canvas to normalized coordinates", () => {
    const box = { left: 100, top: 50, width: 400, height: 200 };
    const moved = movePlacement(one, 0, { clientX: 300, clientY: 150 }, box);
    expect(moved[0]!.x).toBeCloseTo(0.5, 6);
    expect(moved[0]!.y).toBeCloseTo(0.5, 6);
  });

  it("CLAMPS to the page — a drag off the edge must not store x > 1, which the server rejects", () => {
    const box = { left: 0, top: 0, width: 100, height: 100 };
    const off = movePlacement(one, 0, { clientX: 500, clientY: -80 }, box);
    expect(off[0]!.x).toBe(1);
    expect(off[0]!.y).toBe(0);
  });

  it("ignores a zero-sized canvas rather than dividing by zero", () => {
    const box = { left: 0, top: 0, width: 0, height: 0 };
    expect(movePlacement(one, 0, { clientX: 10, clientY: 10 }, box)).toEqual(one);
  });

  it("leaves the other placements untouched", () => {
    const two: CertificateFieldPlacement[] = [
      { field: "subject.name", x: 0.1, y: 0.1 },
      { field: "subject.did", x: 0.9, y: 0.9 },
    ];
    const moved = movePlacement(two, 0, { clientX: 50, clientY: 50 }, { left: 0, top: 0, width: 100, height: 100 });
    expect(moved[1]).toEqual(two[1]);
  });
});

describe("removePlacement", () => {
  it("removes by index and leaves the rest in order", () => {
    const three: CertificateFieldPlacement[] = [
      { field: "subject.name", x: 0, y: 0 },
      { field: "subject.did", x: 0.5, y: 0.5 },
      { field: "qr", x: 1, y: 1 },
    ];
    expect(removePlacement(three, 1).map((p) => p.field)).toEqual(["subject.name", "qr"]);
  });
});

describe("fieldLabel", () => {
  it("labels a fixed field from the catalog and a claim by its key", () => {
    expect(fieldLabel("subject.name")).toBe("Holder name");
    expect(fieldLabel("qr")).toBe("Verification QR");
    expect(fieldLabel("claim:fullName")).toBe("fullName");
  });
});

// The two suites below close paths the plan's designer left open — both end in
// the same place as an unclamped drag: a 400 on the save button, minutes after
// the interaction that caused it.

describe("clampFontSize", () => {
  it("keeps a size the server accepts", () => {
    expect(clampFontSize("24")).toBe(24);
  });

  it("CLAMPS below 4 and above 96 — `min`/`max` on a number input do not stop typing", () => {
    // <input type="number" min={4} max={96}> reports an out-of-range value to
    // `onChange` unimpeded; the attributes only gate native FORM validation,
    // which this panel never runs. The server rejects fontSize outside 4–96.
    expect(clampFontSize("1")).toBe(4);
    expect(clampFontSize("500")).toBe(96);
  });

  it("reads a cleared box as UNSET, not as zero", () => {
    // Number("") is 0, which the server rejects. Absent is valid and renders at
    // the default size, so clearing the box means "no override".
    expect(clampFontSize("")).toBeUndefined();
    expect(clampFontSize("   ")).toBeUndefined();
    expect(clampFontSize("abc")).toBeUndefined();
  });
});

describe("stale claim references", () => {
  const placed: CertificateFieldPlacement[] = [
    { field: "subject.name", x: 0.1, y: 0.1 },
    { field: "claim:fullName", x: 0.2, y: 0.2 },
    { field: "claim:district", x: 0.3, y: 0.3 },
  ];

  it("names the claims a placement references that the schema no longer defines", () => {
    // Reachable in the wizard: place claim:district, then go back and rename or
    // delete that field. The server rejects "references unknown claim".
    expect(stalePlacementFields(placed, ["fullName"])).toEqual(["district"]);
  });

  it("is empty when every referenced claim still exists", () => {
    expect(stalePlacementFields(placed, ["fullName", "district"])).toEqual([]);
  });

  it("never calls a FIXED field stale — it exists independently of the schema", () => {
    expect(stalePlacementFields([{ field: "qr", x: 0, y: 0 }], [])).toEqual([]);
  });

  it("drops only the stale ones, keeping the rest in order", () => {
    expect(withoutStalePlacements(placed, ["fullName"]).map((p) => p.field)).toEqual([
      "subject.name",
      "claim:fullName",
    ]);
  });
});
