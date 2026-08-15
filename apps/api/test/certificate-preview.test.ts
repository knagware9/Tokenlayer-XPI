import { inflateSync } from "node:zlib";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { certificatePageSize } from "@tokenlayer/core";
import { mintSecret } from "../src/shared/api-keys.js";
import { auth, buildTestAppWithRepos, loginAs, onboardUser, PLATFORM_ADMIN_2, V1, type TestAppHandle } from "./helpers.js";

const TEST_ROUNDS = 4;

/**
 * A real 2×1 RGB PNG whose pixel data actually INFLATES — the same fixture
 * `certificate-artwork.test.ts` uses, and reused rather than re-typed on
 * purpose. The plan's literal for this file was the corrupt one: a valid IHDR
 * over an IDAT that fails its zlib checksum. It would have made every assertion
 * below still pass, silently, through the FALLBACK path — a test of the artwork
 * renderer that never once reaches the artwork renderer.
 */
const PNG_2x1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGM4AwYAEMMEyWIMKSwAAAAASUVORK5CYII=";

/** A valid IHDR over an IDAT that cannot inflate — an interrupted upload. */
const PNG_CORRUPT_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=";

/** The page pdfkit declared, read back out of the emitted PDF. It is how this
 *  file tells the two renderers apart: artwork mode derives the page from the
 *  image's aspect, the built-in fallback is always A4 portrait. */
function mediaBox(pdf: Buffer): { width: number; height: number } {
  const m = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf.toString("latin1"));
  if (!m) throw new Error("no MediaBox in the emitted PDF");
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * What the certificate SAYS, recovered from the emitted PDF.
 *
 * Two layers of encoding sit between the two: pdfkit deflates its content
 * streams, and writes show-text operands as HEX literals broken up by kerning
 * adjustments — `[<53414d504c45> 40 <2e2e2e>] TJ`. So every stream is inflated,
 * then every `<…>` run is decoded and concatenated, and the kerning numbers
 * between them are dropped. Without the second step "SAMPLE" is present in the
 * bytes and invisible to `toContain`, which is the shape of assertion that
 * passes for the wrong reason.
 */
function pdfText(pdf: Buffer): string {
  let out = "";
  const marker = Buffer.from("stream");
  for (let i = pdf.indexOf(marker); i !== -1; i = pdf.indexOf(marker, i + 1)) {
    let start = i + marker.length;
    if (pdf[start] === 0x0d) start += 1;
    if (pdf[start] === 0x0a) start += 1;
    const end = pdf.indexOf(Buffer.from("endstream"), start);
    if (end === -1) continue;
    let inflated: string;
    try {
      inflated = inflateSync(pdf.subarray(start, end)).toString("latin1");
    } catch {
      continue; // not a deflate stream (an embedded image, say) — nothing to read
    }
    for (const m of inflated.matchAll(/<([0-9a-fA-F]+)>/g)) {
      out += Buffer.from(m[1], "hex").toString("latin1");
    }
  }
  return out;
}

async function keyWith(h: TestAppHandle, scopes: string[]): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 10);
  const svc = await h.users.create({
    email: `svc-cert-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`unguessable-${tag}`, TEST_ROUNDS),
    role: "PlatformAdmin", useCaseKey: null, accountId: null, active: true,
    kycStatus: "approved", kyc: null, kind: "service",
  });
  const minted = await mintSecret(TEST_ROUNDS);
  await h.apiKeys.create({
    orgId: null, userId: svc.id, name: `key ${tag}`, prefix: minted.prefix,
    secretHash: minted.hash, scopes, expiresAt: null, createdBy: "test",
  });
  return minted.secret;
}

function body(documentId: string | null) {
  return {
    credentialType: {
      name: "ArtCredential", title: "Art Certificate", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" }, district: { type: "string" } } },
      certificate: {
        enabled: true,
        ...(documentId ? { background: { documentId } } : {}),
        placements: [{ field: "claim:fullName", x: 0.5, y: 0.4, align: "center", fontSize: 22 }],
      },
    },
    sampleClaims: { fullName: "Ada Lovelace" },
  };
}

async function uploadPng(h: TestAppHandle, token: string, b64: string): Promise<string> {
  const doc = await h.app.inject({
    method: "POST", url: `${V1}/documents`, headers: auth(token),
    payload: { contentType: "image/png", dataBase64: b64 },
  });
  expect(doc.statusCode).toBe(201);
  return doc.json().id as string;
}

describe("POST /credential-use-cases/preview-certificate", () => {
  it("renders the draft config as a real PDF, before the use case is saved", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const docId = await uploadPng(h, admin, PNG_2x1_B64);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`,
      headers: auth(admin), payload: body(docId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.rawPayload.subarray(0, 4).toString("latin1")).toBe("%PDF");
    // The page is the ARTWORK's, so this really went through the artwork
    // renderer rather than falling back and still answering 200.
    expect(mediaBox(res.rawPayload)).toEqual(certificatePageSize(2, 1));
  });

  it("stamps SAMPLE — NOT A CREDENTIAL on every artwork preview", async () => {
    // THE RULE THIS ROUTE EXISTS TO KEEP. It renders arbitrary caller-supplied
    // claims through the same code that renders real certificates, over the
    // customer's own artwork; without the stamp it is a certificate generator
    // for made-up facts.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const docId = await uploadPng(h, admin, PNG_2x1_B64);

    for (const payload of [
      body(docId),
      // No sample claims at all, and no placements: the stamp does not depend
      // on anything the caller sends.
      { credentialType: { ...body(docId).credentialType, certificate: { enabled: true, background: { documentId: docId }, placements: [] } } },
    ]) {
      const res = await h.app.inject({
        method: "POST", url: `${V1}/credential-use-cases/preview-certificate`,
        headers: auth(admin), payload,
      });
      expect(res.statusCode).toBe(200);
      expect(pdfText(res.rawPayload)).toContain("SAMPLE");
    }
  });

  it("works with no background at all — previewing the built-in layout", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`,
      headers: auth(admin), payload: body(null),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("falls back to the built-in layout when the artwork cannot be decoded", async () => {
    // A truncated upload must not 500 the designer mid-keystroke.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const docId = await uploadPng(h, admin, PNG_CORRUPT_B64);
    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`,
      headers: auth(admin), payload: body(docId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(mediaBox(res.rawPayload)).not.toEqual(certificatePageSize(2, 1));
  });

  it("a background naming a document that does not exist falls back rather than erroring", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`,
      headers: auth(admin), payload: body("doc_does_not_exist"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("prints a humanized key for a claim the caller sent no sample value for", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const docId = await uploadPng(h, admin, PNG_2x1_B64);
    const payload = body(docId);
    payload.credentialType.certificate.placements = [{ field: "claim:district", x: 0.2, y: 0.6, align: "left", fontSize: 22 }];
    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`,
      headers: auth(admin), payload,
    });
    expect(res.statusCode).toBe(200);
    // Every placement must be VISIBLE in a preview, or the designer cannot see
    // where the chip they just dropped landed.
    expect(pdfText(res.rawPayload)).toContain("District");
  });

  it("rejects an invalid placement with the placement error code, naming the chip", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const bad = body(null);
    bad.credentialType.certificate.placements = [{ field: "claim:fullName", x: 4, y: 0.4 } as never];
    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`, headers: auth(admin), payload: bad,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_CERTIFICATE_PLACEMENT");
    expect(res.json().message).toContain("[0]");
  });

  it("is gated by usecases:provision — a key without it is refused", async () => {
    const h = await buildTestAppWithRepos();
    const wrong = await keyWith(h, ["credentials:read"]);
    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`, headers: auth(wrong), payload: body(null),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "usecases:provision" } });

    const right = await keyWith(h, ["usecases:provision"]);
    const ok = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`, headers: auth(right), payload: body(null),
    });
    expect(ok.statusCode).toBe(200);
  });
});


/**
 * THE FINAL REVIEW'S FINDINGS, each pinned by the exploit it was proved with.
 */
describe("EN-F final review — the preview route is role-gated, not scope-gated alone", () => {
  it("a Buyer with no business here is refused, though authScoped admits every human", async () => {
    // `requireScope` short-circuits on `if (!key) return` — scopes narrow API
    // KEYS only. So for a browser session `authScoped` gated authentication and
    // nothing else, and the reviewer walked a seeded tokenization Buyer through:
    // 403 from GET /documents/:id, then 200 from HERE naming the same id, with
    // those bytes embedded full-bleed in the returned PDF.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    await onboardUser(h.app, admin, admin2, {
      email: "prev-buyer@tokenlayer.dev", password: "buyer-secret-1", role: "Buyer", useCaseKey: "carbon-credit",
    });
    const buyer = await loginAs(h.app, "prev-buyer@tokenlayer.dev", "buyer-secret-1");

    const denied = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`, headers: auth(buyer), payload: body(null),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("FORBIDDEN");

    // THE CONTROL: the same call as a PlatformAdmin still renders.
    const ok = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`, headers: auth(admin), payload: body(null),
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("EN-F final review — a template never STORES artwork, not merely never instantiates it", () => {
  it("saving a design as a template strips background before it is readable", async () => {
    // `instantiateTemplate` dropped it, but the stored RECORD kept the id and
    // `GET /credential-use-case-templates/:key` is open to any authenticated
    // user — so the reviewer read Org A's artwork id out of the template and
    // rendered their letterhead. The defence was one layer too late.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const template = {
      key: `enf-strip-${Math.random().toString(36).slice(2, 8)}`, name: "Design", category: "education",
      parameters: [{ name: "orgName", label: "Org", type: "string", required: true }],
      body: {
        keyTemplate: "${orgName}-c", nameTemplate: "${orgName} C",
        credentialTypes: [{
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          required: ["fullName"], properties: { fullName: { type: "string" } },
          certificate: {
            enabled: true,
            background: { documentId: "doc_org_a_letterhead" },
            placements: [{ field: "claim:fullName", x: 0.5, y: 0.4, align: "center" }],
          },
        }],
        holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    };
    const created = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-case-templates`, headers: auth(admin), payload: template,
    });
    expect(created.statusCode).toBe(201);

    const read = await h.app.inject({
      method: "GET", url: `${V1}/credential-use-case-templates/${template.key}`, headers: auth(admin),
    });
    expect(read.statusCode).toBe(200);
    const cert = read.json().body.credentialTypes[0].certificate;
    expect(cert.background).toBeUndefined();
    // The layout — the reusable part — still travels.
    expect(cert.placements).toHaveLength(1);
    // And nothing anywhere in the stored record still names the document.
    expect(read.payload).not.toContain("doc_org_a_letterhead");
  });
});
