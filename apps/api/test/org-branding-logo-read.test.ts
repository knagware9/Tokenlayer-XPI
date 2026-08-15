import { sign as edSign } from "node:crypto";
import { generateDidKey } from "@tokenlayer/core";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/shared/api-keys.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const ROUNDS = 4;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=";

/**
 * An active org plus a logged-in OrgAdmin of it.
 *
 * Copied from org-branding-upload.test.ts rather than imported, for the reason
 * that file states: it is a dozen lines of fixture, not shared logic.
 */
async function org(h: TestAppHandle, label: string) {
  const tag = Math.random().toString(36).slice(2, 8);
  const rec = await h.organizations.create({
    name: `${label} ${tag}`, orgType: "corporate", registrationId: null, jurisdiction: null,
    did: `did:key:zB${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
    verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
    brandLogoDocumentId: null, brandAccent: null,
  });
  const email = `admin-${tag}@brandread.dev`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync("brand-secret-1", ROUNDS), role: "OrgAdmin",
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId: rec.id, kind: "human",
  });
  return { id: rec.id, token: await loginAs(h.app, email, "brand-secret-1") };
}

/** A logged-in member of `orgId` with an arbitrary role. `null` = org-less. */
async function member(h: TestAppHandle, orgId: string | null, role: string): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 10);
  const email = `${role.toLowerCase()}-${tag}@brandread.dev`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync("member-secret-1", ROUNDS), role: role as never,
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId, kind: "human",
  });
  return loginAs(h.app, email, "member-secret-1");
}

/** Upload through the Task 3b door and pin it as the org's mark. Returns the id. */
async function brand(h: TestAppHandle, orgId: string, token: string): Promise<string> {
  const up = await h.app.inject({
    method: "POST", url: `${V1}/orgs/${orgId}/branding/logo`, headers: auth(token),
    payload: { contentType: "image/png", dataBase64: PNG_B64 },
  });
  expect(up.statusCode).toBe(201);
  const docId = up.json().id as string;
  const patched = await h.app.inject({
    method: "PATCH", url: `${V1}/orgs/${orgId}/branding`, headers: auth(token),
    payload: { brandLogoDocumentId: docId },
  });
  expect(patched.statusCode).toBe(200);
  return docId;
}

const fetchLogo = (h: TestAppHandle, orgId: string, token: string) =>
  h.app.inject({ method: "GET", url: `${V1}/orgs/${orgId}/branding/logo`, headers: auth(token) });

/**
 * EN-E, Task 6b: the READ half of the door Task 3b opened.
 *
 * Task 3b gave an OrgAdmin a way to UPLOAD their org's mark because
 * `POST /documents` gates on `rbac.can(role, "issue")` and MATRIX.OrgAdmin is
 * ["read"] alone. Nobody measured the way back: `GET /documents/:id` gates on
 * the same `issue` capability (plus Auditor), so the OrgAdmin was refused the
 * very bytes they had just stored, and the sidebar mark was invisible to every
 * member role that is not a desk operator.
 */
describe("GET /orgs/:id/branding/logo", () => {
  it("THE TASK-3B ROUND TRIP CLOSES: an OrgAdmin reads back the logo they uploaded", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await brand(h, a.id, a.token);

    const res = await fetchLogo(h, a.id, a.token);
    expect(res.statusCode).toBe(200);
    // The BYTES, not a JSON envelope — and the same bytes that went in.
    expect(res.rawPayload.equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
    // The same hardening GET /documents/:id applies: pinned stored type, no
    // sniffing, never rendered inline as the API origin.
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment;/);
  });

  it("THE MEASURED DEFECT: the general document store still refuses the same OrgAdmin the same bytes", async () => {
    // The point of a dedicated door. If this ever returns 200, somebody widened
    // `GET /documents/:id` — which also serves off-ledger invoice evidence and
    // KYB certificates — and this route stopped being the reason those stayed
    // shut. Delete this route before you delete this assertion.
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const docId = await brand(h, a.id, a.token);

    const direct = await h.app.inject({ method: "GET", url: `${V1}/documents/${docId}`, headers: auth(a.token) });
    expect(direct.statusCode).toBe(403);
    expect((await fetchLogo(h, a.id, a.token)).statusCode).toBe(200);
  });

  it("WIDER THAN ITS TWO SIBLINGS ON PURPOSE: every member role of the org can read the mark", async () => {
    // These are exactly the roles the shell paints for and `canReadDoc` refuses.
    // The PATCH/upload routes refuse them too, and that difference is deliberate:
    // setting the brand is an admin act, seeing it is every member's sidebar.
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await brand(h, a.id, a.token);

    for (const role of ["Trader", "Buyer", "Holder", "Verifier"]) {
      const token = await member(h, a.id, role);
      expect((await fetchLogo(h, a.id, token)).statusCode, `${role} must see its own org's mark`).toBe(200);
      // …and the write half stays shut for them.
      const write = await h.app.inject({
        method: "PATCH", url: `${V1}/orgs/${a.id}/branding`, headers: auth(token), payload: { brandAccent: "#123456" },
      });
      expect(write.statusCode, `${role} must not be able to SET the brand`).toBe(403);
    }
  });

  it("THE CROSS-TENANT CHECK: a member of another org gets 403, not another org's mark", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const b = await org(h, "Globex");
    await brand(h, a.id, a.token);

    const res = await fetchLogo(h, a.id, b.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("an org-less principal is refused — a null orgId must never match an org id", async () => {
    // `claims.orgId` is nullable, and `undefined === undefined` is the shape
    // this program's reviews keep finding. A principal belonging to no org
    // belongs to no org's brand.
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await brand(h, a.id, a.token);

    const orgless = await member(h, null, "Buyer");
    const res = await fetchLogo(h, a.id, orgless);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("a PlatformAdmin may read any organization's mark", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await brand(h, a.id, a.token);
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    expect((await fetchLogo(h, a.id, admin)).statusCode).toBe(200);
  });

  /**
   * Same shape as the two branding routes' own key tests. "*" is the widest a
   * key can be; a zero-scope key is the one that matters most, because omitting
   * `authScoped` means scopes are never consulted at all — so if the refusal
   * were not written in the handler, an EMPTY scope list would sail through.
   */
  it("an API key is refused outright, whatever its scopes and whoever it is bound to", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await brand(h, a.id, a.token);
    const tag = Math.random().toString(36).slice(2, 10);
    const svc = await h.users.create({
      email: `svc-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`unguessable-${tag}`, ROUNDS),
      role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
      orgId: a.id, kind: "service",
    });

    const wide = await mintSecret(ROUNDS);
    await h.apiKeys.create({
      orgId: a.id, userId: svc.id, name: `key ${tag}`, prefix: wide.prefix,
      secretHash: wide.hash, scopes: ["*"], expiresAt: null, createdBy: "test",
    });
    const withWideScope = await fetchLogo(h, a.id, wide.secret);
    expect(withWideScope.statusCode).toBe(403);
    expect(withWideScope.json().error).toBe("MACHINE_PRINCIPAL");

    const zero = await mintSecret(ROUNDS);
    await h.apiKeys.create({
      orgId: a.id, userId: svc.id, name: `key ${tag}-zero`, prefix: zero.prefix,
      secretHash: zero.hash, scopes: [], expiresAt: null, createdBy: "test",
    });
    const withNoScope = await fetchLogo(h, a.id, zero.secret);
    expect(withNoScope.statusCode).toBe(403);
    expect(withNoScope.json().error).toBe("MACHINE_PRINCIPAL");
  });

  it("an unbranded org is 404, and so is a brand whose document has gone", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");

    // Never branded.
    const unbranded = await fetchLogo(h, a.id, a.token);
    expect(unbranded.statusCode).toBe(404);

    // Branded, then the row points at bytes that are not there. Set through the
    // repository on purpose: the PATCH route validates the document exists, so
    // this state is only reachable behind its back — which is exactly the state
    // a deleted document would leave, and the handler must not 500 on it.
    await h.organizations.setBranding(a.id, { brandLogoDocumentId: `doc-gone-${Math.random().toString(36).slice(2, 8)}` });
    const dangling = await fetchLogo(h, a.id, a.token);
    expect(dangling.statusCode).toBe(404);
    expect(dangling.json().error).toBe("NOT_FOUND");
  });

  it("an unknown organization is 404 for a PlatformAdmin (and 403 for everyone else, before the lookup)", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    expect((await fetchLogo(h, "org-does-not-exist", admin)).statusCode).toBe(404);
    // A member of some other org learns nothing about whether it exists.
    expect((await fetchLogo(h, "org-does-not-exist", a.token)).statusCode).toBe(403);
  });
});

/**
 * EN-E, Task 6b: THE BRAND MUST BE ON THE WIRE, NOT MERELY IN THE HANDLER.
 *
 * The web builds its SessionUser from `POST /auth/login` and from the QR poll,
 * never from `/me`. Before this task neither carried `brandLogoDocumentId` or
 * `brandAccent`, so a branded org painted the PLATFORM palette on every sign-in
 * and every reload until a follow-up fetch landed.
 *
 * These assertions read the SERIALIZED HTTP BODY (`res.payload`, parsed here
 * rather than by `res.json()`), because that is the only thing that can catch
 * the trap: fast-json-stringify silently drops response fields a schema does
 * not admit, so a handler can return the two fields perfectly and the caller
 * still receive neither. A test on the handler's return value proves nothing.
 */
describe("the session payload carries the brand over the wire", () => {
  it("POST /auth/login: the RAW response body names both fields, with the org's values", async () => {
    const h = await buildTestAppWithRepos();
    const tag = Math.random().toString(36).slice(2, 8);
    const rec = await h.organizations.create({
      name: `Wire ${tag}`, orgType: "corporate", registrationId: null, jurisdiction: null,
      did: `did:key:zW${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
      verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
      brandLogoDocumentId: null, brandAccent: null,
    });
    const email = `admin-${tag}@wire.dev`;
    await h.users.create({
      email, passwordHash: bcrypt.hashSync("wire-secret-1", ROUNDS), role: "OrgAdmin",
      useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
      orgId: rec.id, kind: "human",
    });
    const token = await loginAs(h.app, email, "wire-secret-1");
    const docId = await brand(h, rec.id, token);
    const patched = await h.app.inject({
      method: "PATCH", url: `${V1}/orgs/${rec.id}/branding`, headers: auth(token), payload: { brandAccent: "#0E8C75" },
    });
    expect(patched.statusCode).toBe(200);

    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email, password: "wire-secret-1" } });
    expect(res.statusCode).toBe(200);
    // Parsed from the wire text, and the KEYS are asserted present — not just
    // their values, because a stripped field reads as `undefined`, which
    // `toBe(null)` would also accept for an unbranded org.
    const body = JSON.parse(res.payload) as { user: Record<string, unknown> };
    expect(Object.keys(body.user)).toEqual(expect.arrayContaining(["brandLogoDocumentId", "brandAccent"]));
    expect(body.user.brandLogoDocumentId).toBe(docId);
    expect(body.user.brandAccent).toBe("#0e8c75");
    // The fields that already rode this response must still ride it: declaring
    // `properties` on a fast-json-stringify object is exactly how undeclared
    // siblings get dropped, so the regression is asserted, not assumed.
    expect(Object.keys(body.user)).toEqual(expect.arrayContaining(["id", "email", "role", "orgId", "walletAddress", "useCaseDomain", "orgCapabilities"]));
  });

  it("POST /auth/login: an unbranded org sends null — the KEYS are still there", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "admin@tokenlayer.dev", password: "admin123" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { user: Record<string, unknown> };
    // `null` is a real answer and `undefined` is not: the web's shell treats an
    // ABSENT brandAccent as "unknown, go ask /me" and a null one as "unbranded".
    expect(Object.keys(body.user)).toEqual(expect.arrayContaining(["brandLogoDocumentId", "brandAccent"]));
    expect(body.user.brandAccent).toBeNull();
    expect(body.user.brandLogoDocumentId).toBeNull();
  });

  it("GET /auth/qr/:id: the OTHER session-building route agrees with login, on the wire", async () => {
    const h = await buildTestAppWithRepos();
    const tag = Math.random().toString(36).slice(2, 8);
    const rec = await h.organizations.create({
      name: `QR ${tag}`, orgType: "corporate", registrationId: null, jurisdiction: null,
      did: `did:key:zQ${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
      verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
      brandLogoDocumentId: null, brandAccent: null,
    });
    const email = `admin-${tag}@qrwire.dev`;
    await h.users.create({
      email, passwordHash: bcrypt.hashSync("qr-secret-1", ROUNDS), role: "OrgAdmin",
      useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
      orgId: rec.id, kind: "human",
    });
    const token = await loginAs(h.app, email, "qr-secret-1");
    const docId = await brand(h, rec.id, token);
    await h.app.inject({ method: "PATCH", url: `${V1}/orgs/${rec.id}/branding`, headers: auth(token), payload: { brandAccent: "#B21E4F" } });

    const key = generateDidKey();
    const enrol = await h.app.inject({ method: "POST", url: `${V1}/me/login-keys`, headers: auth(token), payload: { did: key.did, label: "Device" } });
    expect(enrol.statusCode).toBe(201);
    const start = await h.app.inject({ method: "POST", url: `${V1}/auth/qr/start` });
    const { sessionId, challenge } = start.json();
    const signature = edSign(null, Buffer.from(`qr-login:${sessionId}:${challenge}`, "utf8"), key.privateKey)
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const authn = await h.app.inject({ method: "POST", url: `${V1}/auth/qr/${sessionId}/authenticate`, payload: { did: key.did, signature } });
    expect(authn.statusCode).toBe(200);

    const poll = await h.app.inject({ method: "GET", url: `${V1}/auth/qr/${sessionId}` });
    const body = JSON.parse(poll.payload) as { user: Record<string, unknown> };
    expect(Object.keys(body.user)).toEqual(expect.arrayContaining(["brandLogoDocumentId", "brandAccent"]));
    expect(body.user.brandLogoDocumentId).toBe(docId);
    expect(body.user.brandAccent).toBe("#b21e4f");
  });

  it("the two session doors and /me agree — one shell, three ways in", async () => {
    // /me was already correct. The bug was that the two routes the web actually
    // builds from disagreed with it, so a sign-in and a refresh painted
    // different chrome. Pin the agreement rather than each route separately.
    const h = await buildTestAppWithRepos();
    const tag = Math.random().toString(36).slice(2, 8);
    const rec = await h.organizations.create({
      name: `Agree ${tag}`, orgType: "corporate", registrationId: null, jurisdiction: null,
      did: `did:key:zA${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
      verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
      brandLogoDocumentId: null, brandAccent: null,
    });
    const email = `admin-${tag}@agree.dev`;
    await h.users.create({
      email, passwordHash: bcrypt.hashSync("agree-secret-1", ROUNDS), role: "OrgAdmin",
      useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
      orgId: rec.id, kind: "human",
    });
    const token = await loginAs(h.app, email, "agree-secret-1");
    const docId = await brand(h, rec.id, token);
    await h.app.inject({ method: "PATCH", url: `${V1}/orgs/${rec.id}/branding`, headers: auth(token), payload: { brandAccent: "#0e8c75" } });

    const login = JSON.parse((await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email, password: "agree-secret-1" } })).payload) as { token: string; user: Record<string, unknown> };
    const me = JSON.parse((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(login.token) })).payload) as Record<string, unknown>;
    const brandOf = (o: Record<string, unknown>) => ({ brandLogoDocumentId: o.brandLogoDocumentId, brandAccent: o.brandAccent });
    expect(brandOf(login.user)).toEqual({ brandLogoDocumentId: docId, brandAccent: "#0e8c75" });
    expect(brandOf(me)).toEqual(brandOf(login.user));
  });
});
