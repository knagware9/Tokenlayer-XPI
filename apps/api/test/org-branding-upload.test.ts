import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/shared/api-keys.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const ROUNDS = 4;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=";

/**
 * An active org plus a logged-in OrgAdmin of it.
 *
 * Copied from org-branding-route.test.ts rather than imported: it is eleven
 * lines of fixture, not shared logic, and importing across test files couples
 * two suites' evolution for no reason.
 */
async function org(h: TestAppHandle, label: string) {
  const tag = Math.random().toString(36).slice(2, 8);
  const rec = await h.organizations.create({
    name: `${label} ${tag}`, orgType: "corporate", registrationId: null, jurisdiction: null,
    did: `did:key:zB${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
    verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
    brandLogoDocumentId: null, brandAccent: null,
  });
  const email = `admin-${tag}@brandup.dev`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync("brand-secret-1", ROUNDS), role: "OrgAdmin",
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId: rec.id, kind: "human",
  });
  return { id: rec.id, token: await loginAs(h.app, email, "brand-secret-1") };
}

const upload = (h: TestAppHandle, orgId: string, token: string, body: unknown) =>
  h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/branding/logo`, headers: auth(token), payload: body });

const patchBranding = (h: TestAppHandle, orgId: string, token: string, body: unknown) =>
  h.app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/branding`, headers: auth(token), payload: body });

describe("POST /orgs/:id/branding/logo", () => {
  it("an OrgAdmin uploads a PNG for their own org, and the id is immediately usable as brandLogoDocumentId", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");

    const res = await upload(h, a.id, a.token, { contentType: "image/png", dataBase64: PNG_B64 });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ id: expect.any(String), sha256: expect.any(String), size: expect.any(Number) });

    // The round trip that is the whole point of the task: the uploaded id
    // works on the branding route without any PlatformAdmin standing in.
    const patched = await patchBranding(h, a.id, a.token, { brandLogoDocumentId: body.id });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ brandLogoDocumentId: body.id });
  });

  it("THE CROSS-TENANT CHECK: an OrgAdmin of another org may not upload into this one", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const b = await org(h, "Globex");
    const res = await upload(h, b.id, a.token, { contentType: "image/png", dataBase64: PNG_B64 });
    expect(res.statusCode).toBe(403);
  });

  it("a non-admin member of the SAME organization is refused", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const tag = Math.random().toString(36).slice(2, 8);
    const email = `buyer-${tag}@brandup.dev`;
    await h.users.create({
      email, passwordHash: bcrypt.hashSync("buyer-secret-1", ROUNDS), role: "Buyer",
      useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
      orgId: a.id, kind: "human",
    });
    const buyer = await loginAs(h.app, email, "buyer-secret-1");
    expect((await upload(h, a.id, buyer, { contentType: "image/png", dataBase64: PNG_B64 })).statusCode).toBe(403);
  });

  it("a PlatformAdmin may upload into any organization", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    expect((await upload(h, a.id, admin, { contentType: "image/png", dataBase64: PNG_B64 })).statusCode).toBe(201);
  });

  it("rejects a non-image content type — narrower than the shared document store on purpose", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const res = await upload(h, a.id, a.token, {
      contentType: "text/plain", dataBase64: Buffer.from("not an image").toString("base64"),
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe("UNSUPPORTED_DOCUMENT_TYPE");
  });

  /**
   * Same shape as PATCH .../branding's own test: an API key authenticates
   * through the same preHandler and then presents its bound user's role, which
   * a role predicate cannot tell from a session. "*" is the widest a key can
   * be — if that is refused, an empty scope list is refused for free.
   */
  it("an API key is refused outright, whatever its scopes and whoever it is bound to", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const tag = Math.random().toString(36).slice(2, 10);
    const svc = await h.users.create({
      email: `svc-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`unguessable-${tag}`, ROUNDS),
      role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
      orgId: a.id, kind: "service",
    });
    const minted = await mintSecret(ROUNDS);
    await h.apiKeys.create({
      orgId: a.id, userId: svc.id, name: `key ${tag}`, prefix: minted.prefix,
      secretHash: minted.hash, scopes: ["*"], expiresAt: null, createdBy: "test",
    });
    const withWideScope = await upload(h, a.id, minted.secret, { contentType: "image/png", dataBase64: PNG_B64 });
    expect(withWideScope.statusCode).toBe(403);
    expect(withWideScope.json().error).toBe("MACHINE_PRINCIPAL");

    const minted2 = await mintSecret(ROUNDS);
    await h.apiKeys.create({
      orgId: a.id, userId: svc.id, name: `key ${tag}-zero`, prefix: minted2.prefix,
      secretHash: minted2.hash, scopes: [], expiresAt: null, createdBy: "test",
    });
    const withNoScope = await upload(h, a.id, minted2.secret, { contentType: "image/png", dataBase64: PNG_B64 });
    expect(withNoScope.statusCode).toBe(403);
    expect(withNoScope.json().error).toBe("MACHINE_PRINCIPAL");
  });
});

/**
 * FOUND BY MERGING `main` INTO THIS BRANCH, not by writing the branch.
 *
 * The certificate-artwork review established that a document id is not a
 * capability and gave every stored document an `ownerOrgId`. This branch was
 * written before that landed, so its branding door still accepted any document
 * id that existed and happened to be an image. Pinning one is a PUBLISH:
 * `GET /orgs/:id/branding/logo` serves whatever the column names to every
 * member of that org, so a borrowed id hands another tenant's mark to this
 * org's whole roster.
 *
 * A NOTE ON WHAT THIS DOES AND DOES NOT ASSUME. An earlier draft of this
 * comment justified the guard by claiming org B can read org A's logo id off
 * the org list. It cannot: `GET /orgs` is PlatformAdmin-only and `GET /orgs/:id`
 * goes through `orgScoped`. The guard is still right — it is what makes the
 * publish safe no matter which id a caller obtains, and it is the check the
 * PlatformAdmin case below actually needs — but it does not rest on a
 * disclosure that exists.
 *
 * Same shape as the artwork finding, on a different column. Recorded here
 * because "two features written in parallel each satisfy their own review and
 * the hole is in the seam" is the failure this program keeps repeating.
 */
describe("PATCH /orgs/:id/branding — a logo must be a document the org OWNS", () => {
  it("org B cannot pin org A's brand logo, whatever route hands B the id", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const b = await org(h, "Beta");

    // A uploads and applies its own mark, the ordinary way.
    const up = await upload(h, a.id, a.token, { contentType: "image/png", dataBase64: PNG_B64 });
    expect(up.statusCode).toBe(201);
    const aLogoId = up.json().id as string;
    expect((await patchBranding(h, a.id, a.token, { brandLogoDocumentId: aLogoId })).statusCode).toBe(200);

    // B cannot read A's org record today — pinned here so that if that ever
    // changes, this line is where a reader is reminded the guard below is what
    // keeps the change safe.
    expect((await h.app.inject({ method: "GET", url: `${V1}/orgs/${a.id}`, headers: auth(b.token) })).statusCode).toBe(403);

    // B has the id anyway (it was minted above), and cannot use it. ONE ANSWER for "gone" and "not yours", so the route
    // is not an existence oracle over the document store — the same choice
    // `checkBackgroundDocument` made for certificate artwork.
    const stolen = await patchBranding(h, b.id, b.token, { brandLogoDocumentId: aLogoId });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().error).toBe("BRAND_LOGO_NOT_FOUND");
    const absent = await patchBranding(h, b.id, b.token, { brandLogoDocumentId: "doc_nope" });
    expect(absent.statusCode).toBe(stolen.statusCode);
    expect(absent.json().error).toBe(stolen.json().error);

    // B's own upload still works, so the guard refuses theft and nothing else.
    const own = await upload(h, b.id, b.token, { contentType: "image/png", dataBase64: PNG_B64 });
    expect(own.statusCode).toBe(201);
    const ok = await patchBranding(h, b.id, b.token, { brandLogoDocumentId: own.json().id });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().brandLogoDocumentId).toBe(own.json().id);
  });
});

/**
 * FINAL-REVIEW FINDINGS. Both are the same shape this program keeps producing:
 * a check that answers the wrong question confidently.
 */
describe("final review", () => {
  it("a PlatformAdmin cannot republish one org's mark as another org's brand", async () => {
    // The first draft exempted a PlatformAdmin from the ownership check, on the
    // reasoning that they may read every document anyway so refusing forbade
    // nothing. Reading bytes and granting ANOTHER ORG'S ROSTER access to them
    // are different powers: `GET /orgs/:id/branding/logo` serves the pinned
    // document to every member of the org, so the exemption turned a read
    // capability into a publish capability across a tenant boundary.
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const b = await org(h, "Beta");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");

    const up = await upload(h, a.id, a.token, { contentType: "image/png", dataBase64: PNG_B64 });
    const aLogoId = up.json().id as string;

    const cross = await patchBranding(h, b.id, admin, { brandLogoDocumentId: aLogoId });
    expect(cross.statusCode).toBe(400);
    expect(cross.json().error).toBe("BRAND_LOGO_NOT_FOUND");

    // And the path the exemption claimed to protect never needed it: a
    // PlatformAdmin uploading THROUGH the org's own door stamps that org as
    // owner, so it passes the check with no exemption at all.
    const onBehalf = await upload(h, b.id, admin, { contentType: "image/png", dataBase64: PNG_B64 });
    expect(onBehalf.statusCode).toBe(201);
    const applied = await patchBranding(h, b.id, admin, { brandLogoDocumentId: onBehalf.json().id });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().brandLogoDocumentId).toBe(onBehalf.json().id);
  });

  it("refuses image/webp at BOTH doors — pdfkit cannot draw it, and the failure is silent", async () => {
    // `startsWith("image/")` answers "is it an image", not "can we draw it".
    // pdfkit reads PNG and JPEG; the certificate renderer catches and ignores
    // its throw, so a webp mark would show in the console and never on a
    // certificate, with nothing telling the org why.
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");

    const up = await upload(h, a.id, a.token, { contentType: "image/webp", dataBase64: PNG_B64 });
    expect(up.statusCode).toBe(415);
    expect(up.json().error).toBe("UNSUPPORTED_DOCUMENT_TYPE");

    // The store's own allowlist DOES admit webp, so the second door has to
    // refuse it independently — a webp can reach the store another way.
    const doc = await h.deps.documents.create({ contentType: "image/webp", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: a.id, purpose: null });
    const pinned = await patchBranding(h, a.id, a.token, { brandLogoDocumentId: doc.id });
    expect(pinned.statusCode).toBe(400);
    expect(pinned.json().error).toBe("BRAND_LOGO_NOT_AN_IMAGE");

    // A PNG owned by the org still works, so the guard refuses only the undrawable.
    const ok = await upload(h, a.id, a.token, { contentType: "image/png", dataBase64: PNG_B64 });
    expect(ok.statusCode).toBe(201);
    expect((await patchBranding(h, a.id, a.token, { brandLogoDocumentId: ok.json().id })).statusCode).toBe(200);
  });
});
