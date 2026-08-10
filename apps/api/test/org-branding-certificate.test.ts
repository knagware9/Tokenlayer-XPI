import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { certificatePageSize } from "@tokenlayer/core";
import { certificateDrawList } from "../src/certificate-artwork.js";
import { certificateLogoDocumentId } from "../src/certificate-fields.js";
import { auth, buildTestAppWithRepos, loginAs, onboardUser, V1, type TestAppHandle } from "./helpers.js";

// ---------------------------------------------------------------------------
// The precedence rule is a pure function — test it directly rather than
// through PDF bytes. Verbatim from the plan.
// ---------------------------------------------------------------------------

describe("certificateLogoDocumentId", () => {
  const branded = { brandLogoDocumentId: "doc_org" };
  const unbranded = { brandLogoDocumentId: null };

  it("uses the org's brand when the credential type has no logo of its own", () => {
    expect(certificateLogoDocumentId({ certificate: { enabled: true } }, branded)).toBe("doc_org");
  });

  it("MOST-SPECIFIC-WINS: the type's own logo beats the org brand, so no configured certificate changes", () => {
    expect(certificateLogoDocumentId({ certificate: { enabled: true, logoDocumentId: "doc_type" } }, branded)).toBe("doc_type");
  });

  it("is null when neither is set, and when there is no issuing org at all", () => {
    expect(certificateLogoDocumentId({ certificate: { enabled: true } }, unbranded)).toBeNull();
    expect(certificateLogoDocumentId({ certificate: { enabled: true } }, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// certificateDrawList never reads a logo at all — the artwork-mode guarantee
// that makes "case 3" true regardless of what the org or the route wire up.
// Asserted through the SEAM (the pure draw list), not by parsing PDF pixels:
// CertificateDrawListInput carries no field a logo — the type's own OR the
// org's brand — could travel through, so this is a structural fact, not a
// runtime coincidence.
// ---------------------------------------------------------------------------

describe("certificateDrawList: artwork mode never draws a second image", () => {
  it("the ops for an artwork-mode certificate contain exactly one image op — the artwork itself", () => {
    const page = certificatePageSize(2, 1);
    const ops = certificateDrawList({
      placements: [{ field: "subject.name", x: 0.5, y: 0.5, align: "center" }],
      values: new Map([["subject.name", "Ada Lovelace"]]),
      page, statusUrl: "https://api.example/status", banner: null,
    });
    const imageOps = ops.filter((op) => op.kind === "image");
    expect(imageOps).toHaveLength(1);
    expect(imageOps[0]).toMatchObject({ x: 0, y: 0, w: page.width, h: page.height });
  });
});

// ---------------------------------------------------------------------------
// Route-level coverage: GET /credentials/:id/certificate.pdf actually WIRES
// the precedence rule (and the artwork-mode exclusion) into what it renders,
// on a real issue -> approve -> accept path. An org issuer is required (not
// the platform org) so a branded `Organization` record sits behind the
// credential's issuerDid.
// ---------------------------------------------------------------------------

/** A real, tiny, pdfkit-decodable PNG. Two different fixtures so a route
 *  bug that draws the WRONG logo produces a differently-sized PDF. */
const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGM4AwYAEMMEyWIMKSwAAAAASUVORK5CYII=",
  "base64",
);
const PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAC0lEQVR4nGNgwAUAABoAAbw84EEAAAAASUVORK5CYII=",
  "base64",
);

async function makeIssuerOrg(h: TestAppHandle, admin: string, name: string): Promise<string> {
  const res = await h.app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name, orgType: "corporate" } });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  // The EN-A envelope: an org must hold the Issuer role or execution 403s
  // with ORG_CAPABILITY_MISSING at approval time.
  const patched = await h.app.inject({
    method: "PATCH", url: `${V1}/orgs/${id}/capabilities`, headers: auth(admin),
    payload: { capabilities: { domains: ["identity"], roles: ["Issuer"] } },
  });
  expect(patched.statusCode).toBe(200);
  return id;
}

async function uploadImage(h: TestAppHandle, admin: string, bytes: Buffer): Promise<string> {
  const res = await h.app.inject({
    method: "POST", url: `${V1}/documents`, headers: auth(admin),
    payload: { contentType: "image/png", dataBase64: bytes.toString("base64") },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function seedUseCase(h: TestAppHandle, admin: string, key: string, orgId: string, certificate: Record<string, unknown>): Promise<void> {
  const DEF = {
    key, name: key,
    credentialTypes: [{
      name: "BrandedCredential", title: "Branded Certificate", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
      certificate,
    }],
    issuer: { kind: "org", orgId }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
  };
  const r = await h.app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
  expect(r.statusCode).toBe(201);
}

/** A subject user with a DID (onboarding mints one unconditionally). */
async function subjectWithDid(h: TestAppHandle): Promise<{ id: string; email: string; password: string }> {
  const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
  const checker = await loginAs(h.app, "admin2@tokenlayer.dev", "admin123");
  const email = `brand-cert-subj-${Math.random().toString(36).slice(2)}@x.dev`;
  const password = "secret1";
  const u = await onboardUser(h.app, maker, checker, {
    email, password, role: "Buyer", useCaseKey: "invoice-tokenization",
    walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  });
  return { id: u.id, email, password };
}

async function issueApproveAndFetchId(
  h: TestAppHandle, admin: string, admin2: string, ucKey: string, subject: { id: string; email: string; password: string },
): Promise<string> {
  const issued = await h.app.inject({
    method: "POST", url: `${V1}/credential-use-cases/${ucKey}/credentials`, headers: auth(admin),
    payload: { credentialType: "BrandedCredential", subjectUserId: subject.id, claims: { fullName: "Ada Lovelace" } },
  });
  expect(issued.statusCode).toBe(202);
  const approve = await h.app.inject({ method: "POST", url: `${V1}/proposals/${issued.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
  expect(approve.statusCode).toBe(200);

  const subjTok = await loginAs(h.app, subject.email, subject.password);
  const held = await h.app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
  const cred = (held.json() as { id: string; type: string[] }[]).find((c) => c.type.includes("BrandedCredential"))!;
  return cred.id;
}

function pdfBuf(res: { rawPayload?: Buffer; payload: string }): Buffer {
  return res.rawPayload ?? Buffer.from(res.payload, "binary");
}

/**
 * Insert an already-ACCEPTED credential straight into the repo rather than
 * going through issue -> approve -> onboard. The route is a public capability
 * URL keyed only by credential id — it never checks that the holder is a real
 * onboarded user — so this is a faithful shortcut, and a deliberate one: a
 * real onboarding mints a fresh random DID (and, at these fixture sizes,
 * pdfkit's per-document font *subsetting* varies with which characters that
 * DID happens to contain), which was making two "identical" renders differ by
 * tens of bytes for reasons that have nothing to do with logos. Fixing every
 * field except the org's branding is what makes an EXACT byte-length
 * comparison a valid discriminator below, instead of a coin flip against noise.
 */
async function insertFixedCredential(h: TestAppHandle, issuerOrgDid: string, ucKey: string): Promise<string> {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await h.deps.credentials.create({
    id,
    holderDid: "did:key:zFixedHolderDidUsedOnlyByCertBrandingTests",
    issuerDid: issuerOrgDid,
    type: "BrandedCredential",
    vcJwt: "unsigned.test.jwt", // the PDF route never verifies it
    subjectClaims: { fullName: "Ada Lovelace" },
    issuedAt: new Date(now * 1000).toISOString(),
    expiresAt: new Date((now + 365 * 24 * 3600) * 1000).toISOString(),
    revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
    proposalId: null,
    credentialUseCaseKey: ucKey,
    acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
    anchorTxHash: null, anchorChainId: null, revokeTxHash: null,
  });
  return id;
}

describe("GET /credentials/:id/certificate.pdf — org brand logo precedence", () => {
  it("case 1: a type with no logo of its own falls back to the issuing org's brand logo", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgId = await makeIssuerOrg(h, admin, "Cert Org");
    const org = await h.organizations.get(orgId);
    await seedUseCase(h, admin, "case1-uc", orgId, { enabled: true }); // no logoDocumentId
    const credId = await insertFixedCredential(h, org!.did, "case1-uc");

    // SAME credential, fetched twice — only the org's live branding changes
    // between the two calls, so any length difference is attributable to it.
    const before = pdfBuf(await h.app.inject({ method: "GET", url: `${V1}/credentials/${credId}/certificate.pdf` }));

    const orgLogoDocId = await uploadImage(h, admin, PNG_A);
    await h.organizations.setBranding(orgId, { brandLogoDocumentId: orgLogoDocId });
    const after = pdfBuf(await h.app.inject({ method: "GET", url: `${V1}/credentials/${credId}/certificate.pdf` }));

    expect(after.length).toBeGreaterThan(before.length);
  });

  it("THE CROSS-TENANT CASE: org B's brand never reaches a certificate org A issued", async () => {
    // Verified by construction — the route resolves exactly one organization,
    // `findByDid(cred.issuerDid)`, and `issuerDid` is stamped immutably at
    // issuance — but "structurally impossible" is what every cross-tenant
    // defect this program has found also looked like before someone tried it.
    // So: brand a SECOND organization loudly, and prove the first org's
    // certificate does not move.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgA = await makeIssuerOrg(h, admin, "Alpha Issuer");
    const orgB = await makeIssuerOrg(h, admin, "Beta Issuer");
    const a = await h.organizations.get(orgA);
    await seedUseCase(h, admin, "cross-uc", orgA, { enabled: true }); // no logo of its own
    const credId = await insertFixedCredential(h, a!.did, "cross-uc");

    const before = pdfBuf(await h.app.inject({ method: "GET", url: `${V1}/credentials/${credId}/certificate.pdf` }));

    // Brand ONLY org B. Org A stays unbranded.
    await h.organizations.setBranding(orgB, { brandLogoDocumentId: await uploadImage(h, admin, PNG_B) });
    const after = pdfBuf(await h.app.inject({ method: "GET", url: `${V1}/credentials/${credId}/certificate.pdf` }));

    // Byte-for-byte identical length: nothing of B's was drawn. (Case 1 proves
    // this comparison is sensitive — branding the ISSUING org does move it.)
    expect(after.length).toBe(before.length);
    expect((await h.organizations.get(orgA))?.brandLogoDocumentId).toBeNull();
  });

  it("case 2: MOST-SPECIFIC-WINS — the type's own logo beats a DIFFERENT org brand logo", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgId = await makeIssuerOrg(h, admin, "Cert Org");
    const org = await h.organizations.get(orgId);
    const typeLogoDocId = await uploadImage(h, admin, PNG_A);
    await seedUseCase(h, admin, "case2-uc", orgId, { enabled: true, logoDocumentId: typeLogoDocId });
    const credId = await insertFixedCredential(h, org!.did, "case2-uc");

    // SAME credential again. Org starts unbranded (the type's own logo A is
    // the only image in play), then gets branded with a DIFFERENT logo B.
    const control = pdfBuf(await h.app.inject({ method: "GET", url: `${V1}/credentials/${credId}/certificate.pdf` }));

    const orgLogoDocId = await uploadImage(h, admin, PNG_B);
    await h.organizations.setBranding(orgId, { brandLogoDocumentId: orgLogoDocId });
    const withDifferentOrgBrand = pdfBuf(await h.app.inject({ method: "GET", url: `${V1}/credentials/${credId}/certificate.pdf` }));

    // Byte-for-byte identical: the org's brand never gets FETCHED at all once
    // the type has its own logo, so the render input is unchanged and the
    // output must be too. If B had leaked in — instead of, or alongside, A —
    // the embedded image XObject would differ and so would this length.
    expect(withDifferentOrgBrand.length).toBe(control.length);
  });

  it("an org's brand logo whose document was later deleted renders no logo, not a 500", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(h.app, "admin2@tokenlayer.dev", "admin123");
    const orgId = await makeIssuerOrg(h, admin, "Org With A Gone Logo");
    // A document id that was never stored — the state after deletion, same
    // fixture shape certificate-artwork.test.ts uses for the artwork branch.
    await h.organizations.setBranding(orgId, { brandLogoDocumentId: "doc_does_not_exist" });
    await seedUseCase(h, admin, "gone-logo-uc", orgId, { enabled: true });

    const subject = await subjectWithDid(h);
    const credId = await issueApproveAndFetchId(h, admin, admin2, "gone-logo-uc", subject);
    const res = await h.app.inject({ method: "GET", url: `${V1}/credentials/${credId}/certificate.pdf` });
    expect(res.statusCode).toBe(200);
    expect(pdfBuf(res).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("case 3: artwork mode renders through the artwork path even when the org is branded", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(h.app, "admin2@tokenlayer.dev", "admin123");
    const orgId = await makeIssuerOrg(h, admin, "Artwork Org");
    const orgLogoDocId = await uploadImage(h, admin, PNG_A);
    await h.organizations.setBranding(orgId, { brandLogoDocumentId: orgLogoDocId });
    // Stands in for the customer's own full-page design.
    const artworkDocId = await uploadImage(h, admin, PNG_A);
    await seedUseCase(h, admin, "artwork-brand-uc", orgId, {
      enabled: true,
      background: { documentId: artworkDocId },
      placements: [{ field: "subject.name", x: 0.5, y: 0.5, align: "center" }],
    });

    const subject = await subjectWithDid(h);
    const credId = await issueApproveAndFetchId(h, admin, admin2, "artwork-brand-uc", subject);
    const res = await h.app.inject({ method: "GET", url: `${V1}/credentials/${credId}/certificate.pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/pdf/);
    const buf = pdfBuf(res);
    // The discriminator: PNG_A is 2x1, so the artwork path's page is
    // landscape. The built-in renderer is always A4 portrait and could never
    // produce this — same technique as certificate-artwork.test.ts. Whether a
    // SECOND image (a stamped logo) rides along is proven structurally by the
    // `certificateDrawList` seam test above, not by parsing this PDF further.
    const m = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(buf.toString("latin1"))!;
    expect(Number(m[1])).toBeGreaterThan(Number(m[2]));
  });
});
