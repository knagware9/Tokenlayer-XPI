import { sign as edSign } from "node:crypto";
import { generateDidKey, type Role } from "@tokenlayer/core";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/api-keys.js";
import { requirePrincipal } from "../src/http/support.js";
import { MemoryApiKeyRepository, MemoryUserRepository } from "../src/persistence/memory.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

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
 * A live service user + key, created straight through the repos. NOTE: the org
 * member-creation route hardcodes `kind: "human"` today — minting service users
 * through it is task B4's job, so B3 does not touch that route.
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
