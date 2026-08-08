import { sign as edSign } from "node:crypto";
import { generateDidKey, type Role } from "@tokenlayer/core";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { cachedVerification, invalidateVerifiedPrefix, mintSecret, rememberVerification, verifiedPrefixCacheStats } from "../src/api-keys.js";
import { requirePrincipal } from "../src/http/support.js";
import { MemoryApiKeyRepository, MemoryUserRepository } from "../src/persistence/memory.js";
import { auth, buildTestAppWithRepos, loginAs, onboardUser, V1, type TestAppHandle } from "./helpers.js";

describe("MemoryApiKeyRepository", () => {
  it("creates, finds by prefix and id, touches lastUsedAt and revokes", async () => {
    const repo = new MemoryApiKeyRepository();
    const rec = await repo.create({
      orgId: "org_1",
      userId: "user_svc",
      name: "ERP invoice sync",
      prefix: "a1b2c3d4",
      secretHash: "$2a$10$notarealhash",
      scopes: ["credentials:issue", "credentials:read"],
      expiresAt: null,
      createdBy: "user_admin",
    });
    expect(rec.id).toBeTruthy();
    expect(rec.createdAt).toBeTruthy();
    expect(rec.scopes).toEqual(["credentials:issue", "credentials:read"]);
    // Repo-managed lifecycle columns start null — a fresh key is live and unused.
    expect(rec.lastUsedAt).toBeNull();
    expect(rec.revokedAt).toBeNull();
    expect(rec.revokedBy).toBeNull();

    expect((await repo.findByPrefix("a1b2c3d4"))?.id).toBe(rec.id);
    expect(await repo.findByPrefix("zzzzzzzz")).toBeNull();
    expect((await repo.findById(rec.id))?.name).toBe("ERP invoice sync");
    expect(await repo.findById("ak_nope")).toBeNull();

    await repo.touchLastUsed(rec.id, "2026-08-08T10:00:00.000Z");
    expect((await repo.findById(rec.id))?.lastUsedAt).toBe("2026-08-08T10:00:00.000Z");
    await repo.touchLastUsed(rec.id, "2026-08-08T10:05:00.000Z");
    expect((await repo.findById(rec.id))?.lastUsedAt).toBe("2026-08-08T10:05:00.000Z");

    const revoked = await repo.revoke(rec.id, { by: "user_admin", at: "2026-08-08T11:00:00.000Z" });
    expect(revoked.revokedAt).toBe("2026-08-08T11:00:00.000Z");
    expect(revoked.revokedBy).toBe("user_admin");
    expect((await repo.findByPrefix("a1b2c3d4"))?.revokedAt).toBe("2026-08-08T11:00:00.000Z");
  });

  it("lists an org's keys INCLUDING revoked ones — they carry the audit trail", async () => {
    const repo = new MemoryApiKeyRepository();
    const base = { userId: "user_svc", secretHash: "h", scopes: ["*"], expiresAt: null, createdBy: "user_admin" };
    const live = await repo.create({ ...base, orgId: "org_1", name: "live", prefix: "aaaaaaaa" });
    const dead = await repo.create({ ...base, orgId: "org_1", name: "dead", prefix: "bbbbbbbb" });
    await repo.create({ ...base, orgId: "org_2", name: "other org", prefix: "cccccccc" });
    // A platform-owned key (orgId null) belongs to no org listing.
    await repo.create({ ...base, orgId: null, name: "platform", prefix: "dddddddd" });
    await repo.revoke(dead.id, { by: "user_admin", at: "2026-08-08T11:00:00.000Z" });

    const listed = await repo.listByOrg("org_1");
    expect(listed.map((k) => k.id).sort()).toEqual([live.id, dead.id].sort());
    expect(listed.find((k) => k.id === dead.id)?.revokedAt).toBe("2026-08-08T11:00:00.000Z");
    expect(await repo.listByOrg("org_none")).toEqual([]);
  });

  it("rejects lifecycle writes against an unknown key", async () => {
    const repo = new MemoryApiKeyRepository();
    await expect(repo.revoke("ak_nope", { by: "u", at: "2026-08-08T11:00:00.000Z" })).rejects.toThrow("unknown api key");
  });
});

/**
 * The memory repo emulates the DB's `@unique prefix`. Without this the two
 * repos diverge silently: Prisma would reject the second row while memory
 * accepted it and made findByPrefix ambiguous.
 */
describe("MemoryApiKeyRepository — unique prefix parity", () => {
  it("rejects a duplicate prefix with a P2002-shaped error", async () => {
    const repo = new MemoryApiKeyRepository();
    const base = { orgId: "org_1", userId: "u", name: "n", secretHash: "h", scopes: ["*"], expiresAt: null, createdBy: "c" };
    await repo.create({ ...base, prefix: "aaaaaaaa" });
    await expect(repo.create({ ...base, prefix: "aaaaaaaa" })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("MemoryApiKeyRepository — rotation and platform-owned listing (EN-B task B4)", () => {
  it("rotate replaces prefix + hash in place, keeping id, scopes and bound user", async () => {
    const repo = new MemoryApiKeyRepository();
    const rec = await repo.create({
      orgId: "org_1", userId: "user_svc", name: "rotating", prefix: "aaaaaaaa",
      secretHash: "old-hash", scopes: ["credentials:issue"], expiresAt: null, createdBy: "user_admin",
    });
    const rotated = await repo.rotate(rec.id, { prefix: "bbbbbbbb", secretHash: "new-hash" });
    expect(rotated).toMatchObject({ id: rec.id, userId: "user_svc", scopes: ["credentials:issue"], prefix: "bbbbbbbb", secretHash: "new-hash" });
    // The old prefix no longer resolves — the old secret is dead the moment this returns.
    expect(await repo.findByPrefix("aaaaaaaa")).toBeNull();
    expect((await repo.findByPrefix("bbbbbbbb"))?.id).toBe(rec.id);

    // Unique-prefix parity holds on the rotate path too.
    const other = await repo.create({ orgId: "org_1", userId: "u2", name: "other", prefix: "cccccccc", secretHash: "h", scopes: ["*"], expiresAt: null, createdBy: "c" });
    await expect(repo.rotate(other.id, { prefix: "bbbbbbbb", secretHash: "h2" })).rejects.toMatchObject({ code: "P2002" });
    await expect(repo.rotate("ak_nope", { prefix: "dddddddd", secretHash: "h" })).rejects.toThrow("unknown api key");
  });

  it("listByOrg(null) enumerates PLATFORM-owned keys — the null-org row is not write-only", async () => {
    const repo = new MemoryApiKeyRepository();
    const base = { userId: "u", secretHash: "h", scopes: ["*"], expiresAt: null, createdBy: "c" };
    const platform = await repo.create({ ...base, orgId: null, name: "platform", prefix: "pppppppp" });
    await repo.create({ ...base, orgId: "org_1", name: "org", prefix: "oooooooo" });
    expect((await repo.listByOrg(null)).map((k) => k.id)).toEqual([platform.id]);
  });
});

// ---------------------------------------------------------------------------
// Task B3 — the principal seam. A key and a JWT must arrive at the SAME
// TokenClaims, so every existing gate (RBAC, maker-checker, the nine EN-A
// envelope gates) judges a key exactly as it judges a human, with no route
// changes. These tests build keys directly through the repos: the management
// routes are B4, and the seam must be provable without them.
// ---------------------------------------------------------------------------

/** Cheap rounds — these tests hash on every request and cost is not what's under test. */
const TEST_ROUNDS = 4;

const b64u = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

interface SeededKey { userId: string; keyId: string; secret: string; prefix: string }

/**
 * A live service user + key, created straight through the repos — so the seam
 * is provable without the management routes. (B4 has since parameterized the
 * org member-creation path with `kind`, and mints real service users through
 * it; these tests deliberately keep using the repos so they stay independent
 * of that route.)
 */
async function seedServiceKey(
  h: TestAppHandle,
  opts: { role?: Role; useCaseKey?: string | null; orgId?: string | null; expiresAt?: string | null; scopes?: string[]; password?: string } = {},
): Promise<SeededKey> {
  const tag = Math.random().toString(36).slice(2, 10);
  const svc = await h.users.create({
    email: `svc-${tag}@tokenlayer.dev`,
    passwordHash: bcrypt.hashSync(opts.password ?? `unguessable-${tag}`, TEST_ROUNDS),
    role: opts.role ?? "PlatformAdmin",
    useCaseKey: opts.useCaseKey ?? null,
    accountId: null,
    active: true,
    kycStatus: "approved",
    kyc: null,
    orgId: opts.orgId ?? null,
    kind: "service",
  });
  const minted = await mintSecret(TEST_ROUNDS);
  const key = await h.apiKeys.create({
    orgId: opts.orgId ?? null,
    userId: svc.id,
    name: `key ${tag}`,
    prefix: minted.prefix,
    secretHash: minted.hash,
    scopes: opts.scopes ?? ["*"],
    expiresAt: opts.expiresAt ?? null,
    createdBy: "test",
  });
  return { userId: svc.id, keyId: key.id, secret: minted.secret, prefix: minted.prefix };
}

describe("API key auth seam (EN-B task B3)", () => {
  it("a key authenticates and resolves to its service user's claims", async () => {
    const h = await buildTestAppWithRepos();
    const seeded = await seedServiceKey(h, { role: "PlatformAdmin" });

    const me = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) });
    expect(me.statusCode).toBe(200);
    // The claims a JWT session would carry — same shape, same source of truth.
    expect(me.json()).toMatchObject({ id: seeded.userId, role: "PlatformAdmin", useCaseKey: null });

    // ...and the role gate on a role-restricted route passes on those claims.
    const users = await h.app.inject({ method: "GET", url: `${V1}/users`, headers: auth(seeded.secret) });
    expect(users.statusCode).toBe(200);
  });

  it("the key branch stamps lastUsedAt, and throttles the write to once a minute", async () => {
    const h = await buildTestAppWithRepos();
    const seeded = await seedServiceKey(h);
    expect((await h.apiKeys.findById(seeded.keyId))?.lastUsedAt).toBeNull();

    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200);
    const first = (await h.apiKeys.findById(seeded.keyId))?.lastUsedAt;
    expect(first).toBeTruthy();

    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200);
    // Compare-then-write: a busy integration must not turn every call into a DB write.
    expect((await h.apiKeys.findById(seeded.keyId))?.lastUsedAt).toBe(first);
  });

  it("every rejection path returns the SAME 401 body — no oracle", async () => {
    const h = await buildTestAppWithRepos();

    const revoked = await seedServiceKey(h);
    await h.apiKeys.revoke(revoked.keyId, { by: "test", at: new Date().toISOString() });

    const expired = await seedServiceKey(h, { expiresAt: new Date(Date.now() - 60_000).toISOString() });

    const deactivated = await seedServiceKey(h);
    await h.users.update(deactivated.userId, { active: false });

    const live = await seedServiceKey(h);
    // Same 8-char prefix (so the row IS found), different secret body.
    const wrongSecret = `${live.secret.slice(0, "tl_live_".length + 8)}${"X".repeat(14)}`;
    const garbage = "tl_live_zzzzzzzzzzzzzzzzzzzzzz";

    const responses = await Promise.all(
      [revoked.secret, expired.secret, deactivated.secret, garbage, wrongSecret].map((cred) =>
        h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(cred) }),
      ),
    );

    for (const res of responses) expect(res.statusCode).toBe(401);
    // The property that matters: an attacker cannot tell unknown from revoked
    // from expired from deactivated from wrong-secret.
    const bodies = responses.map((r) => r.json());
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0]).toEqual({ error: "UNAUTHORIZED", message: "missing or invalid bearer token" });
  });

  it("an unparseable expiresAt fails CLOSED — a corrupt row cannot keep a key alive", async () => {
    const h = await buildTestAppWithRepos();
    const seeded = await seedServiceKey(h, { expiresAt: "not-a-date" });
    const res = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) });
    // Date.parse gives NaN; treating that as "no expiry" would be fail-open.
    expect(res.statusCode).toBe(401);
  });

  it("a rejected key never stamps lastUsedAt", async () => {
    const h = await buildTestAppWithRepos();
    const seeded = await seedServiceKey(h);
    const wrongSecret = `${seeded.secret.slice(0, "tl_live_".length + 8)}${"X".repeat(14)}`;
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(wrongSecret) })).statusCode).toBe(401);
    expect((await h.apiKeys.findById(seeded.keyId))?.lastUsedAt).toBeNull();
  });

  it("JWT sessions are unaffected by the seam", async () => {
    const h = await buildTestAppWithRepos();
    const token = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const me = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: "PlatformAdmin" });
    // A JWT request is not a key request: nothing in the key store is touched.
    expect(await h.apiKeys.listByOrg("org_1")).toEqual([]);
  });

  it("a service user cannot be driven interactively — login 403s SERVICE_ACCOUNT", async () => {
    const h = await buildTestAppWithRepos();
    const tag = Math.random().toString(36).slice(2, 10);
    const svc = await h.users.create({
      email: `svc-login-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync("known-password", TEST_ROUNDS),
      role: "PlatformAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null, kind: "service",
    });
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: svc.email, password: "known-password" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "SERVICE_ACCOUNT" });
  });

  it("an API key cannot enrol a device login key", async () => {
    const h = await buildTestAppWithRepos();
    const seeded = await seedServiceKey(h);
    const device = generateDidKey();

    const asKey = await h.app.inject({
      method: "POST", url: `${V1}/me/login-keys`, headers: auth(seeded.secret), payload: { did: device.did, label: "attacker device" },
    });
    expect(asKey.statusCode).toBe(403);
    expect(asKey.json()).toMatchObject({ error: "MACHINE_PRINCIPAL" });
    // Nothing durable was left behind for the org to never see.
    expect(await h.loginKeys.listByUser(seeded.userId)).toEqual([]);

    // The same route, same body, from a human session: still works.
    const token = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const asHuman = await h.app.inject({
      method: "POST", url: `${V1}/me/login-keys`, headers: auth(token), payload: { did: device.did, label: "my laptop" },
    });
    expect(asHuman.statusCode).toBe(201);
  });

  it("a service user cannot trade an enrolled device key for a JWT via the QR path", async () => {
    const h = await buildTestAppWithRepos();
    const seeded = await seedServiceKey(h);

    // Enrol STRAIGHT THROUGH THE REPO, deliberately bypassing the route guard
    // above: the two defences must be pinned independently, or removing the
    // enrolment guard would leave this test passing for the wrong reason.
    const device = generateDidKey();
    await h.loginKeys.create({ userId: seeded.userId, did: device.did, label: "attacker device" });

    const start = await h.app.inject({ method: "POST", url: `${V1}/auth/qr/start` });
    const { sessionId, challenge } = start.json() as { sessionId: string; challenge: string };
    const signature = b64u(edSign(null, Buffer.from(`qr-login:${sessionId}:${challenge}`, "utf8"), device.privateKey));
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/qr/${sessionId}/authenticate`, payload: { did: device.did, signature } });

    // The OTHER JWT-minting path must refuse a service user exactly as login does,
    // or the key becomes a durable human session that survives its own revocation.
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "SERVICE_ACCOUNT" });
  });

  /**
   * `request.apiKey` has no consumer until B4's requireScope, and a Fastify
   * hook cannot observe it (global preHandlers run BEFORE the route-level one
   * that sets it). So drive the preHandler directly — it is a plain function.
   */
  it("populates request.apiKey for a key request, leaves it undefined for a JWT, and hands routes a COPY of the scopes", async () => {
    const users = new MemoryUserRepository();
    const apiKeys = new MemoryApiKeyRepository();
    const preHandler = requirePrincipal({ users, apiKeys });

    const human = await users.create({
      email: "human@tokenlayer.dev", passwordHash: "x", role: "PlatformAdmin", useCaseKey: null,
      accountId: null, active: true, kycStatus: "approved", kyc: null, kind: "human",
    });
    const svc = await users.create({
      email: "svc@tokenlayer.dev", passwordHash: "x", role: "PlatformAdmin", useCaseKey: null,
      accountId: null, active: true, kycStatus: "approved", kyc: null, kind: "service",
    });
    const minted = await mintSecret(TEST_ROUNDS);
    const key = await apiKeys.create({
      orgId: null, userId: svc.id, name: "k", prefix: minted.prefix, secretHash: minted.hash,
      scopes: ["credentials:issue", "credentials:read"], expiresAt: null, createdBy: "test",
    });

    const replyStub = { code: () => replyStub, send: async () => {} } as never;
    const reqFor = (credential: string, onJwtVerify?: () => void): never =>
      ({ headers: { authorization: `Bearer ${credential}` }, jwtVerify: async () => onJwtVerify?.() }) as never;

    const keyReq = reqFor(minted.secret);
    await preHandler(keyReq, replyStub);
    expect((keyReq as { apiKey?: unknown }).apiKey).toEqual({ id: key.id, scopes: ["credentials:issue", "credentials:read"] });
    expect((keyReq as { user?: unknown }).user).toMatchObject({ id: svc.id, role: "PlatformAdmin" });

    const jwtReq = reqFor("a.jwt.token", function (this: void) { (jwtReq as { user?: unknown }).user = { id: human.id }; });
    await preHandler(jwtReq, replyStub);
    expect((jwtReq as { apiKey?: unknown }).apiKey).toBeUndefined();
    expect((jwtReq as { user?: unknown }).user).toMatchObject({ id: human.id });

    // The scopes handed to routes are a COPY — a route mutating them must not
    // rewrite what the store believes was granted.
    ((keyReq as { apiKey: { scopes: string[] } }).apiKey).scopes.push("*");
    expect((await apiKeys.findById(key.id))?.scopes).toEqual(["credentials:issue", "credentials:read"]);
  });

  it("a human user with the same password still logs in", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "admin@tokenlayer.dev", password: "admin123" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Task B4 — scopes bite, keys become manageable, and the cost of verifying one
// is bounded. Everything below is NEW behaviour; the B3 seam above is the
// oracle for "a key and a JWT arrive at the same principal".
// ---------------------------------------------------------------------------

const KYC_CLAIMS = { legalName: "Acme Ltd", country: "IN" };
/** No such credential — the routes below only need the PRE-handler's verdict. */
const NO_SUCH_CREDENTIAL = "cred_does_not_exist";

const platformAdmin = (h: TestAppHandle): Promise<string> => loginAs(h.app, "admin@tokenlayer.dev", "admin123");

/** A credential use case (platform issuer unless overridden). */
async function createCredUseCase(h: TestAppHandle, admin: string, key: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await h.app.inject({
    method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin),
    payload: {
      key, name: key, description: "d",
      credentialTypes: [{
        name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["legalName", "country"], properties: { legalName: { type: "string" }, country: { type: "string", pattern: "^[A-Z]{2}$" } } },
      }],
      issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      ...over,
    },
  });
  if (res.statusCode !== 201) throw new Error(`createCredUseCase(${key}) failed: ${res.statusCode} ${res.payload}`);
  return key;
}

/** A subject user carrying a custodial DID (onboarding mints one unconditionally). */
async function subjectWithDid(h: TestAppHandle): Promise<string> {
  const maker = await platformAdmin(h);
  const checker = await loginAs(h.app, "admin2@tokenlayer.dev", "admin123");
  const email = `subj-${Math.random().toString(36).slice(2)}@x.dev`;
  const u = await onboardUser(h.app, maker, checker, {
    email, password: "secret1", role: "Buyer", useCaseKey: "invoice-tokenization",
    walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  });
  return u.id;
}

const issueWith = (h: TestAppHandle, credential: string, key: string, subjectId: string) =>
  h.app.inject({
    method: "POST", url: `${V1}/credential-use-cases/${key}/credentials`, headers: auth(credential),
    payload: { credentialType: "KycCredential", subjectUserId: subjectId, claims: KYC_CLAIMS },
  });

const revokeWith = (h: TestAppHandle, credential: string, credentialId = NO_SUCH_CREDENTIAL) =>
  h.app.inject({ method: "POST", url: `${V1}/credentials/${credentialId}/revoke`, headers: auth(credential), payload: { reason: "test" } });

async function makeOrg(h: TestAppHandle, admin: string, name: string, capabilities?: unknown): Promise<string> {
  const res = await h.app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name, orgType: "corporate" } });
  if (res.statusCode !== 201) throw new Error(`makeOrg(${name}) failed: ${res.statusCode} ${res.payload}`);
  const id = res.json().id as string;
  if (capabilities !== undefined) {
    const patched = await h.app.inject({ method: "PATCH", url: `${V1}/orgs/${id}/capabilities`, headers: auth(admin), payload: { capabilities } });
    if (patched.statusCode !== 200) throw new Error(`capabilities patch failed: ${patched.statusCode} ${patched.payload}`);
  }
  return id;
}

async function makeOrgAdmin(h: TestAppHandle, admin: string, orgId: string, email: string): Promise<string> {
  const res = await h.app.inject({
    method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(admin),
    payload: { email, password: "secret1", role: "OrgAdmin" },
  });
  if (res.statusCode !== 201) throw new Error(`makeOrgAdmin failed: ${res.statusCode} ${res.payload}`);
  return loginAs(h.app, email, "secret1");
}

interface KeyView { id: string; userId: string; name: string; prefix: string; scopes: string[]; role: string; useCaseKey: string | null; status: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null }

/** Mint a key through the REAL management route (the path B5's UI will drive). */
async function mintKey(
  h: TestAppHandle, credential: string, orgId: string,
  body: { name: string; role: string; scopes: string[]; useCaseKey?: string; expiresAt?: string },
): Promise<{ key: KeyView; secret: string }> {
  const res = await h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(credential), payload: body });
  if (res.statusCode !== 201) throw new Error(`mintKey failed: ${res.statusCode} ${res.payload}`);
  return res.json() as { key: KeyView; secret: string };
}

describe("API key scopes (EN-B task B4)", () => {
  it("a credentials:issue key issues, and is refused INSUFFICIENT_SCOPE on revoke", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const ucKey = await createCredUseCase(h, admin, "scope-issue-uc");
    const subject = await subjectWithDid(h);
    const seeded = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["credentials:issue"] });

    expect((await issueWith(h, seeded.secret, ucKey, subject)).statusCode).toBe(202);

    const denied = await revokeWith(h, seeded.secret);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: "INSUFFICIENT_SCOPE",
      details: { required: "credentials:revoke", granted: ["credentials:issue"] },
    });
  });

  it("the global wildcard and a resource wildcard both pass the scope gate", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const ucKey = await createCredUseCase(h, admin, "scope-wildcard-uc");
    const subject = await subjectWithDid(h);

    for (const scopes of [["*"], ["credentials:*"]]) {
      const seeded = await seedServiceKey(h, { role: "PlatformAdmin", scopes });
      expect((await issueWith(h, seeded.secret, ucKey, subject)).statusCode).toBe(202);
      // 404 (not 403) proves the scope gate PASSED and the route body ran.
      expect((await revokeWith(h, seeded.secret)).statusCode).toBe(404);
    }
  });

  it("NARROWING ONLY: a credentials:issue key on a role that cannot issue is refused by the ROLE gate", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const ucKey = await createCredUseCase(h, admin, "scope-narrowing-uc");
    const subject = await subjectWithDid(h);
    // The scope is present, so INSUFFICIENT_SCOPE cannot be what fires: only the
    // role gate can refuse this, which is the whole narrowing-only invariant.
    const seeded = await seedServiceKey(h, { role: "Buyer", scopes: ["credentials:issue"] });

    const res = await issueWith(h, seeded.secret, ucKey, subject);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("a JWT session is never scope-gated — scopes are a property of keys", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    // The human carries no scopes at all, yet every scoped route is open to them.
    expect((await revokeWith(h, admin)).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `${V1}/orgs`, headers: auth(admin) })).statusCode).toBe(200);
  });

  it("a key without users:onboard cannot mint an org member; with it, it can", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Onboard Scope Org");
    const member = (scopes: string[], email: string) => async () => {
      const seeded = await seedServiceKey(h, { role: "OrgAdmin", orgId, scopes });
      return h.app.inject({
        method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(seeded.secret),
        payload: { email, password: "secret1", role: "Issuer" },
      });
    };
    // A route that hands out a HUMAN password must be explicitly granted: the
    // resulting session outlives the key that created it.
    const denied = await member(["credentials:read"], "no-scope@x.dev")();
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "users:onboard" } });

    const allowed = await member(["users:onboard"], "with-scope@x.dev")();
    expect(allowed.statusCode).toBe(201);
  });

  it("the EN-A envelope still fires through the key path (ORG_CAPABILITY_MISSING)", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Enveloped Issuer", { domains: ["identity"], roles: ["Issuer"] });
    const ucKey = await createCredUseCase(h, admin, "envelope-uc", { issuer: { kind: "org", orgId } });
    const subject = await subjectWithDid(h);
    const seeded = await seedServiceKey(h, { role: "OrgAdmin", orgId, scopes: ["*"] });

    expect((await issueWith(h, seeded.secret, ucKey, subject)).statusCode).toBe(202);

    // Tighten the org out of the Issuer role — no new code runs; EN-A's gate does.
    const patched = await h.app.inject({
      method: "PATCH", url: `${V1}/orgs/${orgId}/capabilities`, headers: auth(admin),
      payload: { capabilities: { domains: ["identity"], roles: [] } },
    });
    expect(patched.statusCode).toBe(200);

    const after = await issueWith(h, seeded.secret, ucKey, subject);
    expect(after.statusCode).toBe(403);
    expect(after.json().error).toBe("ORG_CAPABILITY_MISSING");
  });
});

describe("key-only binding re-check (EN-B task B4)", () => {
  it("an unbound issuer desk stops working for a KEY while the equivalent HUMAN session still issues", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const deskOrg = await makeOrg(h, admin, "Desk Org");
    const otherOrg = await makeOrg(h, admin, "Other Issuer Org");
    const ucKey = await createCredUseCase(h, admin, "desk-binding-uc", { issuer: { kind: "org", orgId: deskOrg } });
    const subject = await subjectWithDid(h);

    // A scoped Issuer DESK key, and a human desk operator with identical claims.
    const minted = await mintKey(h, admin, deskOrg, { name: "desk key", role: "Issuer", useCaseKey: ucKey, scopes: ["credentials:issue"] });
    const humanRes = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${deskOrg}/users`, headers: auth(admin),
      payload: { email: "desk.human@x.dev", password: "secret1", role: "Issuer", useCaseKey: ucKey },
    });
    expect(humanRes.statusCode).toBe(201);
    const human = await loginAs(h.app, "desk.human@x.dev", "secret1");

    expect((await issueWith(h, minted.secret, ucKey, subject)).statusCode).toBe(202);
    expect((await issueWith(h, human, ucKey, subject)).statusCode).toBe(202);

    // Re-point the use case's issuer at a DIFFERENT org: the desk org is no
    // longer bound to it.
    const repointed = await h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${ucKey}`, headers: auth(admin),
      payload: {
        key: ucKey, name: ucKey, description: "d",
        credentialTypes: [{
          name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["legalName", "country"], properties: { legalName: { type: "string" }, country: { type: "string", pattern: "^[A-Z]{2}$" } } },
        }],
        issuer: { kind: "org", orgId: otherOrg }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(repointed.statusCode).toBe(200);

    // The unattended key is re-checked against the CURRENT config…
    const keyAfter = await issueWith(h, minted.secret, ucKey, subject);
    expect(keyAfter.statusCode).toBe(403);
    expect(keyAfter.json().error).toBe("ISSUER_NOT_PERMITTED");
    // …while the interactive desk keeps EN-A's recorded non-retroactivity.
    expect((await issueWith(h, human, ucKey, subject)).statusCode).toBe(202);
  });
});

describe("API key management routes (EN-B task B4)", () => {
  it("create → list → rotate → revoke, with the secret returned exactly twice and never listed", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Managed Org");
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "managed.admin@x.dev");

    const created = await mintKey(h, orgAdmin, orgId, { name: "ERP sync", role: "Issuer", scopes: ["credentials:issue"] });
    expect(created.secret.startsWith("tl_live_")).toBe(true);
    expect(created.key.prefix).toBe(created.secret.slice("tl_live_".length, "tl_live_".length + 8));
    expect(created.key).toMatchObject({ name: "ERP sync", role: "Issuer", scopes: ["credentials:issue"], status: "active" });
    // Nothing secret-shaped rides the view.
    expect(JSON.stringify(created.key)).not.toContain(created.secret);
    expect(created.key).not.toHaveProperty("secretHash");

    const listed = await h.app.inject({ method: "GET", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(orgAdmin) });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json() as KeyView[];
    expect(rows.map((k) => k.id)).toEqual([created.key.id]);
    expect(listed.payload).not.toContain(created.secret);
    expect(rows[0]).not.toHaveProperty("secretHash");

    // The key works before rotation.
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(created.secret) })).statusCode).toBe(200);

    const rotated = await h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/api-keys/${created.key.id}/rotate`, headers: auth(orgAdmin), payload: {} });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json() as { key: KeyView; secret: string };
    expect(next.secret).not.toBe(created.secret);
    expect(next.key.id).toBe(created.key.id);
    expect(next.key.scopes).toEqual(["credentials:issue"]); // rotation keeps identity + grant
    // The OLD secret is dead immediately; the new one works.
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(created.secret) })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(next.secret) })).statusCode).toBe(200);

    const revoked = await h.app.inject({ method: "DELETE", url: `${V1}/orgs/${orgId}/api-keys/${created.key.id}`, headers: auth(orgAdmin), payload: {} });
    expect(revoked.statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(next.secret) })).statusCode).toBe(401);
    // Revoked rows stay listed — they are the audit trail of what was granted.
    const afterRevoke = (await h.app.inject({ method: "GET", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(orgAdmin) })).json() as KeyView[];
    expect(afterRevoke[0]).toMatchObject({ id: created.key.id, status: "revoked" });
    // The bound service user has no live key left, so it is deactivated too.
    expect((await h.users.findById(created.key.userId))?.active).toBe(false);
  });

  it("THE SILENT NO-OP TRAP: a minted key's service user is refused at /auth/login", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Trap Org");
    const created = await mintKey(h, admin, orgId, { name: "trap", role: "Issuer", scopes: ["*"] });

    const svc = await h.users.findById(created.key.userId);
    expect(svc?.kind).toBe("service");

    // Give the service user a KNOWN password (PlatformAdmin, human session) so
    // the login refusal is proven by the SERVICE_ACCOUNT gate and not merely by
    // an unguessable hash. If the mint path ever created a `human` again, this
    // login would return 200 + a token that outlives the key.
    const patched = await h.app.inject({ method: "PATCH", url: `${V1}/users/${created.key.userId}`, headers: auth(admin), payload: { password: "known-password-1" } });
    expect(patched.statusCode).toBe(200);

    const login = await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: svc?.email, password: "known-password-1" } });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({ error: "SERVICE_ACCOUNT" });
  });

  it("a foreign OrgAdmin is refused on every management route; a PlatformAdmin may act on any org", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const mine = await makeOrg(h, admin, "Mine Org");
    const theirs = await makeOrg(h, admin, "Theirs Org");
    const foreign = await makeOrgAdmin(h, admin, mine, "foreign.admin@x.dev");
    const created = await mintKey(h, admin, theirs, { name: "theirs", role: "Issuer", scopes: ["*"] });

    const attempts = [
      h.app.inject({ method: "POST", url: `${V1}/orgs/${theirs}/api-keys`, headers: auth(foreign), payload: { name: "x", role: "Issuer", scopes: ["*"] } }),
      h.app.inject({ method: "GET", url: `${V1}/orgs/${theirs}/api-keys`, headers: auth(foreign) }),
      h.app.inject({ method: "POST", url: `${V1}/orgs/${theirs}/api-keys/${created.key.id}/rotate`, headers: auth(foreign), payload: {} }),
      h.app.inject({ method: "DELETE", url: `${V1}/orgs/${theirs}/api-keys/${created.key.id}`, headers: auth(foreign), payload: {} }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("FORBIDDEN");
    }
    // A key belonging to another org is not reachable through one's OWN org path.
    const crossPath = await h.app.inject({ method: "DELETE", url: `${V1}/orgs/${mine}/api-keys/${created.key.id}`, headers: auth(foreign), payload: {} });
    expect(crossPath.statusCode).toBe(404);
  });

  it("rejects an unknown scope and refuses to mint a role the caller may not create", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Validation Org");
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "validation.admin@x.dev");

    const badScope = await h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(orgAdmin), payload: { name: "x", role: "Issuer", scopes: ["ledger:drop"] } });
    expect(badScope.statusCode).toBe(400);
    expect(badScope.json().error).toBe("INVALID_SCOPES");

    // canCreateOrgMember: an OrgAdmin may never mint another OrgAdmin — and a key
    // is only ever as strong as the member it binds to.
    const escalation = await h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(orgAdmin), payload: { name: "x", role: "OrgAdmin", scopes: ["*"] } });
    expect(escalation.statusCode).toBe(403);
    expect(escalation.json().error).toBe("FORBIDDEN");
  });

  it("never audits the secret", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Audit Org");
    const created = await mintKey(h, admin, orgId, { name: "audited", role: "Issuer", scopes: ["credentials:issue"] });
    await h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/api-keys/${created.key.id}/rotate`, headers: auth(admin), payload: {} });

    const entries = await h.audit.list();
    const keyEntries = entries.filter((e) => String(e.action).startsWith("api-key-"));
    expect(keyEntries.map((e) => e.action).sort()).toEqual(["api-key-created", "api-key-rotated"]);
    // The id + name + scopes are the audit trail; the secret never is.
    expect(keyEntries[0]?.payload).toMatchObject({ keyId: created.key.id, name: "audited", scopes: ["credentials:issue"] });
    expect(JSON.stringify(entries)).not.toContain(created.secret);
  });

  it("an API KEY may not manage API keys — the one path that could WIDEN a key's scopes", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "No Self Mint Org");
    const target = await mintKey(h, admin, orgId, { name: "target", role: "Issuer", scopes: ["credentials:issue"] });
    // An OrgAdmin-roled key: it has the ROLE to mint members, so only the
    // machine-principal refusal stands between it and a `*`-scoped key.
    const seeded = await seedServiceKey(h, { role: "OrgAdmin", orgId, scopes: ["*"] });

    const attempts = [
      h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(seeded.secret), payload: { name: "wider", role: "Issuer", scopes: ["*"] } }),
      h.app.inject({ method: "GET", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(seeded.secret) }),
      h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/api-keys/${target.key.id}/rotate`, headers: auth(seeded.secret), payload: {} }),
      h.app.inject({ method: "DELETE", url: `${V1}/orgs/${orgId}/api-keys/${target.key.id}`, headers: auth(seeded.secret), payload: {} }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("MACHINE_PRINCIPAL");
    }
    // Nothing was minted (only the target and the key doing the asking exist),
    // and the target key is untouched.
    expect((await h.apiKeys.listByOrg(orgId)).map((k) => k.id).sort()).toEqual([target.key.id, seeded.keyId].sort());
    expect((await h.apiKeys.findById(target.key.id))?.revokedAt).toBeNull();
  });

  it("an API KEY may not set an existing user's password, but may still deactivate one", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Password Org");
    const victimRes = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(admin),
      payload: { email: "victim@x.dev", password: "secret1", role: "Issuer" },
    });
    expect(victimRes.statusCode).toBe(201);
    const victimId = victimRes.json().id as string;
    const seeded = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["*"] });

    // Resetting a human's password would hand the machine a durable interactive
    // session that survives the key's own revocation.
    const takeover = await h.app.inject({ method: "PATCH", url: `${V1}/users/${victimId}`, headers: auth(seeded.secret), payload: { password: "attacker-chosen" } });
    expect(takeover.statusCode).toBe(403);
    expect(takeover.json().error).toBe("MACHINE_PRINCIPAL");
    expect((await loginAs(h.app, "victim@x.dev", "secret1"))).toBeTruthy();

    const suspend = await h.app.inject({ method: "PATCH", url: `${V1}/users/${victimId}`, headers: auth(seeded.secret), payload: { active: false } });
    expect(suspend.statusCode).toBe(200);
  });
});

describe("per-key rate limit (EN-B task B4)", () => {
  it("trips at the configured ceiling with 429 RATE_LIMITED + Retry-After, per key", async () => {
    const h = await buildTestAppWithRepos({ apiKeyRateLimitMax: 3 });
    const a = await seedServiceKey(h);
    const b = await seedServiceKey(h);

    for (let i = 0; i < 3; i++) {
      expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(a.secret) })).statusCode).toBe(200);
    }
    const tripped = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(a.secret) });
    expect(tripped.statusCode).toBe(429);
    expect(tripped.json()).toMatchObject({ error: "RATE_LIMITED" });
    expect(Number(tripped.headers["retry-after"])).toBeGreaterThan(0);

    // The budget is PER KEY: one integration cannot starve another.
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(b.secret) })).statusCode).toBe(200);

    // A human session is not rate-limited by the key bucket at all.
    const admin = await platformAdmin(h);
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(admin) })).statusCode).toBe(200);
  });
});

describe("failed-attempt bounding (EN-B task B4)", () => {
  it("bounds bcrypt work per prefix: a cold key locks out once its failure budget is spent", async () => {
    const h = await buildTestAppWithRepos({ apiKeyFailedAttemptMax: 2 });
    const seeded = await seedServiceKey(h);
    const other = await seedServiceKey(h);
    const wrong = `${seeded.secret.slice(0, "tl_live_".length + 8)}${"X".repeat(14)}`;

    for (let i = 0; i < 2; i++) {
      expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(wrong) })).statusCode).toBe(401);
    }
    // Budget spent: further traffic on this prefix is refused BEFORE any hash
    // work — including, deliberately, the real secret. The tradeoff is stated in
    // support.ts: an attacker who knows a public prefix can lock out a COLD key,
    // which is bounded and preferable to unbounded CPU burn.
    const blocked = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json()).toEqual({ error: "UNAUTHORIZED", message: "missing or invalid bearer token" });

    // The bound is per prefix — another key is untouched.
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(other.secret) })).statusCode).toBe(200);
  });

  it("a HOT key rides the verified-prefix cache straight through an attack on its prefix", async () => {
    const h = await buildTestAppWithRepos({ apiKeyFailedAttemptMax: 2 });
    const seeded = await seedServiceKey(h);
    const wrong = `${seeded.secret.slice(0, "tl_live_".length + 8)}${"X".repeat(14)}`;

    // One good call first: the cache now holds this exact (prefix, hash, secret).
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(wrong) })).statusCode).toBe(401);
    }
    // The cache is consulted BEFORE the failure bound, precisely so a live
    // integration is not collateral damage.
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200);
  });
});

describe("verified-prefix cache (EN-B task B4)", () => {
  it("serves repeat traffic without re-hashing", async () => {
    const h = await buildTestAppWithRepos();
    const seeded = await seedServiceKey(h);

    const before = verifiedPrefixCacheStats().hits;
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200);
    expect(verifiedPrefixCacheStats().hits).toBe(before); // first call must hash
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200);
    expect(verifiedPrefixCacheStats().hits).toBe(before + 1);
  });

  it("a REVOKED key never survives on a cache hit", async () => {
    const h = await buildTestAppWithRepos();
    const seeded = await seedServiceKey(h);
    // Warm the cache with a successful verification…
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200);
    await h.apiKeys.revoke(seeded.keyId, { by: "test", at: new Date().toISOString() });
    // …the revocation check reads the LIVE row and runs before the cache is
    // ever consulted, so there is no staleness window at all.
    const res = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "UNAUTHORIZED", message: "missing or invalid bearer token" });
  });

  it("a key revoked through the ROUTE dies immediately even when hot", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Hot Revoke Org");
    const created = await mintKey(h, admin, orgId, { name: "hot", role: "Issuer", scopes: ["*"] });

    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(created.secret) })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(created.secret) })).statusCode).toBe(200); // cached
    expect((await h.app.inject({ method: "DELETE", url: `${V1}/orgs/${orgId}/api-keys/${created.key.id}`, headers: auth(admin), payload: {} })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(created.secret) })).statusCode).toBe(401);
  });

  it("a ROTATED key's old secret never survives on a cache hit", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Rotate Cache Org");
    const created = await mintKey(h, admin, orgId, { name: "rotating", role: "Issuer", scopes: ["*"] });

    // Warm the cache on the OLD secret (twice: the second call is a cache hit).
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(created.secret) })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(created.secret) })).statusCode).toBe(200);

    const rotated = await h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/api-keys/${created.key.id}/rotate`, headers: auth(admin), payload: {} });
    expect(rotated.statusCode).toBe(200);
    const next = (rotated.json() as { secret: string }).secret;

    // The cache entry is bound to the row's secretHash, so rotation invalidates
    // it by construction — no TTL is involved in the correctness argument.
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(created.secret) })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(next) })).statusCode).toBe(200);
  });

  /**
   * The cache's three-part binding, unit-tested. A prefix collision between two
   * live rows is impossible through the repos (`prefix` is unique in both), so
   * the only way to pin "an entry is bound to its key row, not just its prefix"
   * is at this level — and it is the property the route-level rotation and
   * revocation tests above are ultimately relying on.
   */
  it("an entry is bound to the key id, the row's secretHash AND the presented secret", async () => {
    const minted = await mintSecret(TEST_ROUNDS);
    const key = { id: "ak_one", secretHash: minted.hash };
    const prefix = `unit-${Math.random().toString(36).slice(2, 8)}`;

    expect(cachedVerification(prefix, minted.secret, key)).toBe(false); // cold
    rememberVerification(prefix, minted.secret, key);
    expect(cachedVerification(prefix, minted.secret, key)).toBe(true);

    // A different key row that happens to sit on this prefix: no hit.
    expect(cachedVerification(prefix, minted.secret, { id: "ak_two", secretHash: minted.hash })).toBe(false);
    // The same key AFTER a rotation (its stored hash changed): no hit.
    expect(cachedVerification(prefix, minted.secret, { id: "ak_one", secretHash: `${minted.hash}x` })).toBe(false);
    // A different presented secret: no hit.
    expect(cachedVerification(prefix, `${minted.secret}x`, key)).toBe(false);

    invalidateVerifiedPrefix(prefix);
    expect(cachedVerification(prefix, minted.secret, key)).toBe(false);
  });
});
