import { describe, expect, it } from "vitest";
import { AUTO_QR_PLACEMENT, certificatePageSize, type CertificateFieldPlacement, type CertificateFieldRef } from "@tokenlayer/core";
import { certificateDrawList, type DrawOp } from "../src/certificate-artwork.js";

const PAGE = certificatePageSize(1600, 900); // landscape
const values = new Map<CertificateFieldRef, string>([
  ["claim:fullName", "Ada Lovelace"],
  ["subject.name", "Ada Lovelace"],
  ["credential.id", "cred_1"],
]);

const base = {
  values,
  page: PAGE,
  statusUrl: "https://api.example/api/v1/credentials/cred_1/status",
  banner: null as { label: string; detail: string | null } | null,
  sample: false,
};

const texts = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: "text" }> => o.kind === "text");
const qrs = (ops: DrawOp[]) => ops.filter((o): o is Extract<DrawOp, { kind: "qr" }> => o.kind === "qr");

describe("certificateDrawList", () => {
  it("draws the artwork first, filling the page", () => {
    const ops = certificateDrawList({ ...base, placements: [] });
    expect(ops[0]).toEqual({ kind: "image", x: 0, y: 0, w: PAGE.width, h: PAGE.height });
  });

  it("resolves normalized coordinates to absolute points", () => {
    const p: CertificateFieldPlacement = { field: "claim:fullName", x: 0.25, y: 0.5, fontSize: 20, align: "center", width: 0.5 };
    const t = texts(certificateDrawList({ ...base, placements: [p] }))[0]!;
    expect(t.text).toBe("Ada Lovelace");
    expect(t.x).toBeCloseTo(PAGE.width * 0.25, 4);
    expect(t.y).toBeCloseTo(PAGE.height * 0.5, 4);
    expect(t.width).toBeCloseTo(PAGE.width * 0.5, 4);
    expect(t.fontSize).toBe(20);
    expect(t.align).toBe("center");
  });

  it("applies documented defaults when styling is omitted", () => {
    const t = texts(certificateDrawList({ ...base, placements: [{ field: "subject.name", x: 0.1, y: 0.1 }] }))[0]!;
    expect(t.fontSize).toBe(11);
    expect(t.font).toBe("sans");
    expect(t.bold).toBe(false);
    expect(t.color).toBe("#0f172a");
    expect(t.align).toBe("left");
    expect(t.width).toBeNull(); // omitted width ⇒ one unwrapped line
  });

  it("treats an explicit null width as unwrapped, not as a zero-width box", () => {
    // Reachable only on the unvalidated path the duplicate-`qr` guard also
    // defends: `validateCertificatePlacements` rejects a null width, but a
    // hand-written config or a future caller can still produce one, and `0`
    // means "wrap to nothing" to pdfkit — an empty line where a name should be.
    const p = { field: "subject.name", x: 0.1, y: 0.1, width: null } as unknown as CertificateFieldPlacement;
    expect(texts(certificateDrawList({ ...base, placements: [p] }))[0]!.width).toBeNull();
  });

  it("skips a placement whose value is absent, instead of printing 'undefined'", () => {
    const ops = certificateDrawList({ ...base, placements: [{ field: "claim:missing" as CertificateFieldRef, x: 0.5, y: 0.5 }] });
    expect(texts(ops)).toHaveLength(0);
  });

  // ---- THE RULES CONFIG CANNOT OVERRIDE -----------------------------------

  it("inserts a QR when none is placed, at the documented default position", () => {
    const ops = certificateDrawList({ ...base, placements: [] });
    const qr = qrs(ops);
    expect(qr).toHaveLength(1);
    expect(qr[0]!.url).toBe(base.statusUrl);
    expect(qr[0]!.x).toBeCloseTo(PAGE.width * AUTO_QR_PLACEMENT.x, 4);
    expect(qr[0]!.caption).toBe("Scan to verify");
  });

  it("uses the placed QR when there is one, and still draws exactly one", () => {
    const ops = certificateDrawList({ ...base, placements: [{ field: "qr", x: 0.05, y: 0.8, width: 0.2 }] });
    const qr = qrs(ops);
    expect(qr).toHaveLength(1);
    expect(qr[0]!.x).toBeCloseTo(PAGE.width * 0.05, 4);
    expect(qr[0]!.size).toBeCloseTo(PAGE.width * 0.2, 4);
    // A placed QR carries no caption: the designer positioned it deliberately
    // and a stray label would land on their artwork.
    expect(qr[0]!.caption).toBeNull();
  });

  it("draws the revocation watermark LAST, over every placement", () => {
    const ops = certificateDrawList({
      ...base,
      placements: [{ field: "subject.name", x: 0.5, y: 0.5 }],
      banner: { label: "REVOKED", detail: "Revoked: fraud" },
    });
    expect(ops.at(-1)).toEqual({ kind: "watermark", label: "REVOKED", detail: "Revoked: fraud" });
  });

  it("has no watermark for a live credential", () => {
    const ops = certificateDrawList({ ...base, placements: [] });
    expect(ops.some((o) => o.kind === "watermark")).toBe(false);
  });

  it("stamps SAMPLE in preview mode and never outside it", () => {
    expect(certificateDrawList({ ...base, placements: [], sample: true }).some((o) => o.kind === "sample")).toBe(true);
    expect(certificateDrawList({ ...base, placements: [], sample: false }).some((o) => o.kind === "sample")).toBe(false);
  });

  it("keeps the watermark last even in preview mode", () => {
    const ops = certificateDrawList({ ...base, placements: [], sample: true, banner: { label: "EXPIRED", detail: null } });
    expect(ops.at(-1)!.kind).toBe("watermark");
    expect(ops.at(-2)!.kind).toBe("sample");
  });
});
