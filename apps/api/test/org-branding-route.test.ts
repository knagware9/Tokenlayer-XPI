import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/api-keys.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const ROUNDS = 4;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=";

/** An active org plus a logged-in OrgAdmin of it. */
async function org(h: TestAppHandle, label: string) {
  const tag = Math.random().toString(36).slice(2, 8);
  const rec = await h.organizations.create({
    name: `${label} ${tag}`, orgType: "corporate", registrationId: null, jurisdiction: null,
    did: `did:key:zB${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
    verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
    brandLogoDocumentId: null, brandAccent: null,
  });
  const email = `admin-${tag}@brand.dev`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync("brand-secret-1", ROUNDS), role: "OrgAdmin",
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId: rec.id, kind: "human",
  });
  return { id: rec.id, token: await loginAs(h.app, email, "brand-secret-1") };
}

/**
 * A stored document of a known type, OWNED BY `ownerOrgId`.
 *
 * Was: upload as the PLATFORM ADMIN through `POST /documents`, because
 * `rbac.can("OrgAdmin", "issue")` is false and an OrgAdmin could not upload at
 * all. Two things have since changed and both matter here. Task 3b built the
 * org's own upload door, so the workaround is obsolete; and the
 * certificate-artwork review gave every document an `ownerOrgId` and made the
 * branding door refuse one this org does not own — so a platform-uploaded
 * document is no longer a realistic stand-in for an org's own logo, and using
 * one made these tests assert against a state the product cannot produce.
 *
 * Written straight to the repository rather than through the branding upload
 * route because one case below needs a `text/plain` document, which that route
 * refuses at 415 — by design. The ownership fact is what these tests need; the
 * upload path is `org-branding-upload.test.ts`'s subject, not theirs.
 */
async function upload(h: TestAppHandle, contentType: string, dataBase64: string, ownerOrgId: string): Promise<string> {
  const doc = await h.deps.documents.create({ contentType, bytes: Buffer.from(dataBase64, "base64"), ownerOrgId });
  return doc.id;
}

const patch = (h: TestAppHandle, orgId: string, token: string, body: unknown) =>
  h.app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/branding`, headers: auth(token), payload: body });

describe("PATCH /orgs/:id/branding", () => {
  it("an OrgAdmin brands their own organization, and it comes back on GET /orgs/:id", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const docId = await upload(h, "image/png", PNG_B64, a.id);

    const res = await patch(h, a.id, a.token, { brandLogoDocumentId: docId, brandAccent: "#0E8C75" });
    expect(res.statusCode).toBe(200);
    // Normalized to lowercase by the core validator.
    expect(res.json()).toMatchObject({ brandAccent: "#0e8c75", brandLogoDocumentId: docId });

    const read = await h.app.inject({ method: "GET", url: `${V1}/orgs/${a.id}`, headers: auth(a.token) });
    expect(read.json()).toMatchObject({ brandAccent: "#0e8c75" });
  });

  it("THE CROSS-TENANT CHECK: an OrgAdmin cannot brand somebody else's organization", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const b = await org(h, "Globex");
    const res = await patch(h, b.id, a.token, { brandAccent: "#112233" });
    expect(res.statusCode).toBe(403);
    // And nothing moved.
    expect((await h.organizations.get(b.id))?.brandAccent).toBeNull();
  });

  it("a non-admin member of the SAME organization is refused", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const tag = Math.random().toString(36).slice(2, 8);
    const email = `buyer-${tag}@brand.dev`;
    await h.users.create({
      email, passwordHash: bcrypt.hashSync("buyer-secret-1", ROUNDS), role: "Buyer",
      useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
      orgId: a.id, kind: "human",
    });
    const buyer = await loginAs(h.app, email, "buyer-secret-1");
    expect((await patch(h, a.id, buyer, { brandAccent: "#112233" })).statusCode).toBe(403);
  });

  it("a PlatformAdmin may brand any organization", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    expect((await patch(h, a.id, admin, { brandAccent: "#112233" })).statusCode).toBe(200);
  });

  it("rejects a malformed accent by name rather than silently correcting it", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const res = await patch(h, a.id, a.token, { brandAccent: "red" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_BRAND_ACCENT");
  });

  it("rejects a logo document that is not an image", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const txtId = await upload(h, "text/plain", Buffer.from("not an image").toString("base64"), a.id);
    const res = await patch(h, a.id, a.token, { brandLogoDocumentId: txtId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BRAND_LOGO_NOT_AN_IMAGE");
  });

  it("rejects a logo document id that does not exist", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    expect((await patch(h, a.id, a.token, { brandLogoDocumentId: "doc_nope" })).statusCode).toBe(400);
  });

  it("an explicit null clears, an omitted key is left alone", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await patch(h, a.id, a.token, { brandAccent: "#0e8c75" });
    await patch(h, a.id, a.token, {});                       // touches nothing
    expect((await h.organizations.get(a.id))?.brandAccent).toBe("#0e8c75");
    await patch(h, a.id, a.token, { brandAccent: null });
    expect((await h.organizations.get(a.id))?.brandAccent).toBeNull();
  });

  it("GET /me carries the brand, so the shell needs no extra fetch", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await patch(h, a.id, a.token, { brandAccent: "#0e8c75" });
    const me = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(a.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ brandAccent: "#0e8c75" });
  });

  /**
   * NOT in the plan, and added because the measurement contradicted it. The
   * route carries no `authScoped`, which withholds a SCOPE — it does not
   * withhold the route. A key authenticates through the same preHandler and
   * then presents its bound user's role, so before the MACHINE_PRINCIPAL
   * refusal a key with an EMPTY scope list rewrote the brand.
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
    // "*" is the widest a key can be: if THAT is refused, no narrower one passes.
    await h.apiKeys.create({
      orgId: a.id, userId: svc.id, name: `key ${tag}`, prefix: minted.prefix,
      secretHash: minted.hash, scopes: ["*"], expiresAt: null, createdBy: "test",
    });
    const res = await patch(h, a.id, minted.secret, { brandAccent: "#112233" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("MACHINE_PRINCIPAL");
    expect((await h.organizations.get(a.id))?.brandAccent).toBeNull();
  });

  it("a session with no organization gets no brand", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const me = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(admin) });
    expect(me.json().brandAccent ?? null).toBeNull();
  });
});
