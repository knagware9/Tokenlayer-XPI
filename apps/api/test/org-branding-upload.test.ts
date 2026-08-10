import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/api-keys.js";
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
