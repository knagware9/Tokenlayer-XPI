import { describe, expect, it } from "vitest";
import { certificatePageSize } from "@tokenlayer/core";
import { artworkDimensions, certificateDrawList, drawCertificate } from "../src/certificate-artwork.js";
import { buildTestApp, loginAs, onboardUser, V1, auth } from "./helpers.js";

/**
 * A real 2×1 RGB PNG whose pixel data actually inflates, so pdfkit's decoder has
 * genuine bytes to open AND to embed. Generated, not hand-copied: the plan's
 * literal parsed its header fine and then failed to inflate, which is precisely
 * the CORRUPT case below — a fixture that looks valid to `openImage` is the
 * wrong thing to call "a real PNG".
 */
const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGM4AwYAEMMEyWIMKSwAAAAASUVORK5CYII=",
  "base64",
);

/**
 * A PNG with a valid IHDR (so `openImage` reports 2×1) and an IDAT that fails
 * its zlib checksum. pdfkit decodes pixels LATER, inside a zlib callback that
 * `throw`s — an uncaughtException no try/catch around the render can see. The
 * artwork path must therefore reject this at measure time.
 */
const PNG_CORRUPT_PIXELS = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=",
  "base64",
);

/** The page pdfkit declared, read back out of the emitted PDF. */
function mediaBox(pdf: Buffer): { width: number; height: number } {
  const m = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf.toString("latin1"));
  if (!m) throw new Error("no MediaBox in the emitted PDF");
  return { width: Number(m[1]), height: Number(m[2]) };
}

describe("drawCertificate", () => {
  it("produces an openable PDF from a draw list", async () => {
    const page = certificatePageSize(2, 1);
    const ops = certificateDrawList({
      placements: [{ field: "subject.name", x: 0.3, y: 0.4, fontSize: 24, font: "serif", bold: true, color: "#112233", align: "center" }],
      values: new Map([["subject.name", "Ada Lovelace"]]),
      page,
      statusUrl: "https://api.example/status",
      banner: { label: "REVOKED", detail: "Revoked: test" },
      sample: true,
    });
    const pdf = await drawCertificate(ops, PNG_2x1, page);
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1000);
    // The page is the artwork's, not pdfkit's A4 default.
    expect(mediaBox(pdf)).toEqual(page);
  });

  it("renders every font family and alignment without throwing", async () => {
    const page = certificatePageSize(2, 1);
    for (const font of ["sans", "serif", "mono"] as const) {
      for (const align of ["left", "center", "right"] as const) {
        for (const bold of [true, false]) {
          const ops = certificateDrawList({
            placements: [{ field: "subject.name", x: 0.5, y: 0.5, font, align, bold, width: 0.8 }],
            values: new Map([["subject.name", "Ada"]]),
            page, statusUrl: "https://api.example/status", banner: null,
          });
          const pdf = await drawCertificate(ops, PNG_2x1, page);
          expect(pdf.subarray(0, 4).toString("latin1"), `${font}/${align}/${bold}`).toBe("%PDF");
        }
      }
    }
  });

  it("centres an unwidthed placement against the rest of the page, not against nothing", async () => {
    // A width-less text op still has to be renderable: the adapter substitutes a
    // box, and a zero/negative one would make pdfkit throw.
    const page = certificatePageSize(2, 1);
    const ops = certificateDrawList({
      placements: [{ field: "subject.name", x: 0.999, y: 0.5, align: "center" }],
      values: new Map([["subject.name", "Ada"]]),
      page, statusUrl: "https://api.example/status", banner: null,
    });
    const pdf = await drawCertificate(ops, PNG_2x1, page);
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("throws on unusable artwork rather than emitting a blank page", async () => {
    const page = certificatePageSize(2, 1);
    const ops = certificateDrawList({
      placements: [], values: new Map(), page, statusUrl: "https://api.example/status", banner: null,
    });
    // The ROUTE turns this into a fallback to the built-in layout (below);
    // the adapter's job is to fail loudly so the route can.
    await expect(drawCertificate(ops, Buffer.from("not an image"), page)).rejects.toThrow();
  });

  it("rejects a PNG whose pixels do not decode, instead of crashing the process later", async () => {
    const page = certificatePageSize(2, 1);
    const ops = certificateDrawList({
      placements: [], values: new Map(), page, statusUrl: "https://api.example/status", banner: null,
    });
    await expect(drawCertificate(ops, PNG_CORRUPT_PIXELS, page)).rejects.toThrow();
  });
});

describe("artworkDimensions", () => {
  it("measures real artwork", () => {
    expect(artworkDimensions(PNG_2x1)).toEqual({ width: 2, height: 1 });
  });

  it("throws on bytes that are not an image", () => {
    expect(() => artworkDimensions(Buffer.from("not an image"))).toThrow();
  });

  it("throws on a PNG whose pixel data is corrupt", () => {
    expect(() => artworkDimensions(PNG_CORRUPT_PIXELS)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The route dispatch.
// ---------------------------------------------------------------------------

/** A credential use case whose type has artwork + one placement. */
async function seedArtworkUseCase(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, documentId: string) {
  const DEF = {
    key: "artwork-cert", name: "Artwork",
    credentialTypes: [{
      name: "ArtCredential", title: "Art Certificate", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
      certificate: {
        enabled: true,
        background: { documentId },
        placements: [{ field: "claim:fullName", x: 0.5, y: 0.4, align: "center", fontSize: 22 }],
      },
    }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
  };
  const r = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
  expect(r.statusCode).toBe(201);
  return DEF;
}

/** Store the PNG and seed the use case over it; returns the document id. */
async function seedOverArtwork(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, bytes: Buffer): Promise<string> {
  const doc = await app.inject({
    method: "POST", url: `${V1}/documents`, headers: auth(admin),
    payload: { contentType: "image/png", dataBase64: bytes.toString("base64") },
  });
  expect(doc.statusCode).toBe(201);
  const id = doc.json().id as string;
  await seedArtworkUseCase(app, admin, id);
  return id;
}

/**
 * issue → approve → the holder's own copy of the credential id.
 *
 * The route serves only an ACCEPTED credential. This use case does not set
 * `holderAcceptance`, so its credentials are born accepted (the back-compat
 * default) and no explicit accept call is needed — the same reason the built-in
 * renderer's tests reach a 200 without one.
 */
async function issueAcceptedArtCredential(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string): Promise<string> {
  const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
  const email = `art-subj-${Math.random().toString(36).slice(2)}@x.dev`;
  const password = "secret1";
  const subject = await onboardUser(app, admin, admin2, {
    email, password, role: "Buyer", useCaseKey: "invoice-tokenization",
    walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  });

  const issued = await app.inject({
    method: "POST", url: `${V1}/credential-use-cases/artwork-cert/credentials`, headers: auth(admin),
    payload: { credentialType: "ArtCredential", subjectUserId: subject.id, claims: { fullName: "Ada Lovelace" } },
  });
  expect(issued.statusCode).toBe(202);
  const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${issued.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
  expect(approve.statusCode).toBe(200);

  const subjTok = await loginAs(app, email, password);
  const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
  const cred = (held.json() as { id: string; type: string[]; acceptance?: string }[]).find((c) => c.type.includes("ArtCredential"));
  expect(cred, "the holder should hold the issued ArtCredential").toBeDefined();
  return cred!.id;
}

async function fetchCertificate(app: Awaited<ReturnType<typeof buildTestApp>>, credentialId: string) {
  const res = await app.inject({ method: "GET", url: `${V1}/credentials/${credentialId}/certificate.pdf` });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("application/pdf");
  const buf = res.rawPayload ?? Buffer.from(res.payload, "binary");
  expect(buf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  return buf;
}

/** What the built-in renderer always produces: A4 portrait. */
const A4_PORTRAIT = certificatePageSize(0, 0);

describe("GET /credentials/:id/certificate.pdf — artwork mode", () => {
  it("renders through the ARTWORK path end to end", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedOverArtwork(app, admin, PNG_2x1);
    const credentialId = await issueAcceptedArtCredential(app, admin);

    const pdf = await fetchCertificate(app, credentialId);
    // The discriminator. A 2×1 artwork gives a LANDSCAPE page; the built-in
    // renderer is A4 portrait and can never produce this box. (Asserting merely
    // that the bytes contain "841.89" would prove nothing — that number is A4's
    // long edge and appears in the portrait MediaBox too.)
    expect(mediaBox(pdf)).toEqual(certificatePageSize(2, 1));
    expect(mediaBox(pdf).width).toBeGreaterThan(mediaBox(pdf).height);
  });

  it("a missing background document falls back to the built-in layout rather than erroring", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // A documentId that was never stored — the state after someone deletes it.
    await seedArtworkUseCase(app, admin, "doc_does_not_exist");
    const read = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/artwork-cert`, headers: auth(admin) });
    expect(read.statusCode).toBe(200);
    expect(read.json().credentialTypes[0].certificate.background.documentId).toBe("doc_does_not_exist");

    // The rule that matters: deleting a document must not turn every certificate
    // of that type into a 500 — it degrades to the built-in layout.
    const credentialId = await issueAcceptedArtCredential(app, admin);
    expect(mediaBox(await fetchCertificate(app, credentialId))).toEqual(A4_PORTRAIT);
  });

  it("unreadable artwork bytes fall back to the built-in layout", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // Stored, right content type, undecodable pixels — the shape a truncated
    // upload takes. It must degrade, not 500 and not kill the process.
    await seedOverArtwork(app, admin, PNG_CORRUPT_PIXELS);
    const credentialId = await issueAcceptedArtCredential(app, admin);
    expect(mediaBox(await fetchCertificate(app, credentialId))).toEqual(A4_PORTRAIT);
  });
});

/**
 * Crafted PNGs whose zlib stream is VALID and whose scanlines are not. Natural
 * corruption trips the adler checksum, which `inflateSync` catches; these do not,
 * and they reach png-js's per-scanline walk — which `throw`s from inside an async
 * zlib callback, i.e. as an uncaughtException that no try/catch on the render and
 * no rejected promise can see. On a PUBLIC, unauthenticated certificate URL that
 * is a remote kill switch for the API process.
 *
 * Generated by hand (4×2 truecolour, correct chunk CRCs) rather than found: the
 * reachable version of this bug is the deliberate one.
 */
const PNG_FILTER_POISONED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAADklEQVR4nEtmQALJyBwADy8AxxFo/a8AAAAASUVORK5CYII=",
  "base64",
);
const PNG_INTERLACED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAAGHzdqiAAAAC0lEQVR4nGNgwAUAABoAAbw84EEAAAAASUVORK5CYII=",
  "base64",
);
/** The same generator's clean output — the control, so the refusals above are about the defect. */
const PNG_4x2_GOOD = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAC0lEQVR4nGNgwAUAABoAAbw84EEAAAAASUVORK5CYII=",
  "base64",
);

describe("undecodable artwork is refused synchronously, never left to crash the process", () => {
  const page = certificatePageSize(4, 2);
  const ops = () => certificateDrawList({
    placements: [], values: new Map(), page, statusUrl: "https://api.example/status", banner: null,
  });

  it("a valid-zlib PNG with out-of-range filter bytes REJECTS instead of killing the process", async () => {
    // If this regresses, the symptom is not a failing assertion — it is vitest
    // dying. That is the tell.
    await expect(drawCertificate(ops(), PNG_FILTER_POISONED, page)).rejects.toThrow(/filter algorithm/i);
  });

  it("an interlaced PNG is refused rather than half-checked", async () => {
    // Adam7 lays scanlines out as seven sub-images; validating it means
    // reimplementing the decoder, and a half-check is bypassed by flipping one
    // header flag. Refusing costs an issuer nothing — the route falls back.
    await expect(drawCertificate(ops(), PNG_INTERLACED, page)).rejects.toThrow(/interlaced/i);
  });

  it("THE CONTROL: the same generator's clean PNG renders", async () => {
    const pdf = await drawCertificate(ops(), PNG_4x2_GOOD, page);
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});
