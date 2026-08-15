import { sign as edSign } from "node:crypto";
import { allProposalKinds } from "../src/shared/proposal-kinds.js";
import { API_SCOPES, generateDidKey, type Role } from "@tokenlayer/core";
import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";
import { cachedVerification, invalidateVerifiedPrefix, mintSecret, rememberVerification, verifiedPrefixCacheStats } from "../src/shared/api-keys.js";
import { requirePrincipal } from "../src/http/support.js";
import { MemoryApiKeyRepository, MemoryUserRepository } from "../src/persistence/memory/index.js";
import { ACCOUNTS, auth, buildTestAppWithRepos, loginAs, onboardUser, V1, type TestAppHandle } from "./helpers.js";

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
    // EN-D2 added `mode` to the principal. Kept as an EXACT-shape assertion
    // rather than relaxed to toMatchObject: the point of this line is that the
    // principal carries nothing beyond what a route is meant to read, and a
    // field appearing here without anyone noticing is precisely what it
    // catches. `"live"` is the value for every key minted before EN-D2.
    expect((keyReq as { apiKey?: unknown }).apiKey).toEqual({ id: key.id, scopes: ["credentials:issue", "credentials:read"], mode: "live" });
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
   * DO NOT DELETE: this is the ONLY test pinning the `secretHash` conjunct in
   * `cachedVerification`. Removing that conjunct leaves every route-level test
   * — including the rotation one directly above — GREEN, because the rotate
   * route also changes the prefix and explicitly invalidates the old entry, so
   * both mask it. Verified by mutation, twice, independently. It looks like
   * redundant coverage and is not.
   *
   * A prefix collision between two live rows is impossible through the repos
   * (`prefix` is unique in both), so this level is the only place the binding
   * "an entry belongs to its key ROW, not just its prefix" can be observed.
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

// ---------------------------------------------------------------------------
// Task B4 — spec-review follow-ups. Three routes reachable by a key that the
// scope map missed, and the maker-checker EXECUTE half that every scoped
// issuance route defers to.
// ---------------------------------------------------------------------------

const PROVISION = `${V1}/credential-use-cases/provision`;

describe("provisioning is not a back door to human credentials (H1)", () => {
  it("a KEY cannot create desk users — that is three plaintext human passwords", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Desk Password University");
    // Even the strongest possible key: `*` scopes on an OrgAdmin service user.
    const seeded = await seedServiceKey(h, { role: "OrgAdmin", orgId, scopes: ["*"] });

    const res = await h.app.inject({
      method: "POST", url: PROVISION, headers: auth(seeded.secret),
      payload: {
        templateKey: "education-certificate",
        params: { issuerOrgName: "Desk Password University", jurisdiction: "IN" },
        provisioning: { createDeskUsers: true, deskEmailDomain: "deskpw.edu" },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "MACHINE_PRINCIPAL" });
    // Not one human account was minted, so no password ever reached the machine.
    for (const role of ["issuer", "holder", "verifier"]) {
      expect(await h.users.findByEmail(`${role}@deskpw.edu`)).toBeNull();
    }

    // A HUMAN OrgAdmin of the same org still provisions desk users normally.
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "deskpw.admin@x.dev");
    const human = await h.app.inject({
      method: "POST", url: PROVISION, headers: auth(orgAdmin),
      payload: {
        templateKey: "education-certificate",
        params: { issuerOrgName: "Desk Password University", jurisdiction: "IN" },
        provisioning: { createDeskUsers: true, deskEmailDomain: "deskpw.edu" },
      },
    });
    expect(human.statusCode).toBe(201);
    expect((human.json() as { deskUsers: unknown[] }).deskUsers).toHaveLength(3);
  });

  it("provisioning without desk users still needs the usecases:provision scope", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Scope Check University");
    const body = {
      templateKey: "education-certificate",
      params: { issuerOrgName: "Scope Check University", jurisdiction: "IN" },
      provisioning: { createDeskUsers: false },
    };

    const denied = await seedServiceKey(h, { role: "OrgAdmin", orgId, scopes: ["org:read"] });
    const no = await h.app.inject({ method: "POST", url: PROVISION, headers: auth(denied.secret), payload: body });
    expect(no.statusCode).toBe(403);
    expect(no.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "usecases:provision" } });

    const allowed = await seedServiceKey(h, { role: "OrgAdmin", orgId, scopes: ["usecases:provision"] });
    const yes = await h.app.inject({ method: "POST", url: PROVISION, headers: auth(allowed.secret), payload: body });
    expect(yes.statusCode).toBe(201);
    expect((yes.json() as { deskUsers: unknown[] }).deskUsers).toEqual([]);
  });
});

describe("assets:issue is not bypassable through the invoice register (H2)", () => {
  it("tokenize is gated exactly like POST /assets", async () => {
    const h = await buildTestAppWithRepos();
    const readOnly = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["assets:read"] });
    const issuer = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["assets:issue"] });
    const tokenize = (credential: string) => h.app.inject({
      method: "POST", url: `${V1}/use-cases/invoice-tokenization/invoices/tokenize`, headers: auth(credential),
      payload: { ids: ["inv_none"], chainId: "fabric", treasuryAccount: ACCOUNTS.ALICE },
    });

    // Same key, same authority — the two doors onto issueAssetCore must agree.
    const direct = await h.app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(readOnly.secret),
      payload: { useCaseKey: "invoice-tokenization", name: "T", symbol: "T", chainId: "fabric", metadata: {} },
    });
    expect(direct.statusCode).toBe(403);
    expect(direct.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "assets:issue" } });

    const blocked = await tokenize(readOnly.secret);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "assets:issue" } });

    // The properly-scoped key gets PAST the scope gate (into the route body).
    expect((await tokenize(issuer.secret)).json().error).not.toBe("INSUFFICIENT_SCOPE");
  });

  it("the staging siblings are scoped too — nothing enters the register unscoped", async () => {
    const h = await buildTestAppWithRepos();
    const readOnly = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["assets:read"] });
    const base = `${V1}/use-cases/invoice-tokenization/invoices`;
    const writes = await Promise.all([
      h.app.inject({ method: "POST", url: `${base}/import`, headers: auth(readOnly.secret), payload: { rows: [] } }),
      h.app.inject({ method: "POST", url: `${base}/pull-erp`, headers: auth(readOnly.secret), payload: {} }),
      h.app.inject({ method: "POST", url: base, headers: auth(readOnly.secret), payload: { metadata: {} } }),
      h.app.inject({ method: "DELETE", url: `${base}/inv_none`, headers: auth(readOnly.secret) }),
    ]);
    for (const res of writes) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "assets:issue" } });
    }
    // The READ is allowed by the read scope.
    expect((await h.app.inject({ method: "GET", url: base, headers: auth(readOnly.secret) })).statusCode).toBe(200);
  });
});

describe("maker-checker approval is scope-gated (H3)", () => {
  /** Draft an issuance proposal as a HUMAN, so a key can be the second approver. */
  async function pendingIssuance(h: TestAppHandle): Promise<string> {
    const admin = await platformAdmin(h);
    const ucKey = await createCredUseCase(h, admin, `approve-uc-${Math.random().toString(36).slice(2, 8)}`);
    const subject = await subjectWithDid(h);
    const drafted = await issueWith(h, admin, ucKey, subject);
    expect(drafted.statusCode).toBe(202);
    return drafted.json().proposal.id as string;
  }

  const approve = (h: TestAppHandle, credential: string, proposalId: string) =>
    h.app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(credential), payload: {} });

  it("gating the DRAFT is worthless if the EXECUTE half is open", async () => {
    const h = await buildTestAppWithRepos();
    const proposalId = await pendingIssuance(h);
    const wrongScope = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["org:read"] });

    const denied = await approve(h, wrongScope.secret, proposalId);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "credentials:issue" } });
    // Nothing moved: no approval recorded, nothing executed.
    const still = await h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(await platformAdmin(h)) });
    const row = (still.json() as { id: string; status: string; approvals: unknown[] }[]).find((p) => p.id === proposalId);
    expect(row).toMatchObject({ status: "pending" });
    expect(row?.approvals).toHaveLength(0);
  });

  it("a correctly-scoped key IS a legitimate second approver", async () => {
    const h = await buildTestAppWithRepos();
    const proposalId = await pendingIssuance(h);
    const rightScope = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["credentials:issue"] });

    const res = await approve(h, rightScope.secret, proposalId);
    expect(res.statusCode).toBe(200);
    expect(res.json().proposal.status).toBe("executed");
  });

  it("rejecting is gated by the same scope as approving", async () => {
    const h = await buildTestAppWithRepos();
    const proposalId = await pendingIssuance(h);
    const wrongScope = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["org:read"] });
    const res = await h.app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/reject`, headers: auth(wrongScope.secret), payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("INSUFFICIENT_SCOPE");
  });

  it("a governance kind has NO scope that can authorize it — a key is refused outright", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Governance Org");
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "gov.admin@x.dev");
    const requested = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/capabilities/request`, headers: auth(orgAdmin),
      payload: { capabilities: { domains: ["identity"], roles: ["Issuer", "Holder", "Verifier"] } },
    });
    expect(requested.statusCode).toBe(202);
    const proposalId = requested.json().proposal.id as string;

    // `*` is the widest grant that exists, and it still cannot widen the
    // envelope that bounds every key in the org.
    const wildcard = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["*"] });
    const res = await h.app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(wildcard.secret), payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "MACHINE_PRINCIPAL" });
    expect((await h.app.inject({ method: "GET", url: `${V1}/orgs/${orgId}`, headers: auth(admin) })).json().capabilities).toBeNull();
  });

  it("EVERY registered proposal kind declares an apiScope — an unmapped kind fails closed", () => {
    const kinds = allProposalKinds();
    expect(kinds.length).toBeGreaterThan(10);
    for (const k of kinds) {
      // null = "no key may ever decide this"; otherwise it must be a real scope.
      expect(k.apiScope === null || (API_SCOPES as readonly string[]).includes(k.apiScope)).toBe(true);
    }
  });
});

describe("platform governance is closed to machine principals", () => {
  it("a key may not approve/reject an org, nor patch the envelope that bounds it", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Governance Direct Org");
    // The strongest key that can exist: `*` on a PlatformAdmin service user.
    const wildcard = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["*"] });

    const attempts = [
      h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: auth(wildcard.secret), payload: {} }),
      h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/reject`, headers: auth(wildcard.secret), payload: { reason: "x" } }),
      h.app.inject({
        method: "PATCH", url: `${V1}/orgs/${orgId}/capabilities`, headers: auth(wildcard.secret),
        payload: { capabilities: { domains: ["identity", "tokenization"], roles: ["Issuer", "Holder", "Verifier"] } },
      }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("MACHINE_PRINCIPAL");
    }
    // Refusing this at the PROPOSAL path while leaving the direct PATCH open
    // would have been the entire gate, bypassed — so pin the envelope unmoved.
    expect((await h.app.inject({ method: "GET", url: `${V1}/orgs/${orgId}`, headers: auth(admin) })).json().capabilities).toBeNull();

    // A human PlatformAdmin still patches it.
    const human = await h.app.inject({
      method: "PATCH", url: `${V1}/orgs/${orgId}/capabilities`, headers: auth(admin),
      payload: { capabilities: { domains: ["identity"], roles: ["Issuer"] } },
    });
    expect(human.statusCode).toBe(200);
  });
});

describe("the failure bound cannot deny a legitimate key indefinitely (M4)", () => {
  it("a cold key over budget gets a reserved hash attempt and recovers", async () => {
    const h = await buildTestAppWithRepos({ apiKeyFailedAttemptMax: 2, apiKeyReserveIntervalMs: 150 });
    const seeded = await seedServiceKey(h);
    const wrong = `${seeded.secret.slice(0, "tl_live_".length + 8)}${"X".repeat(14)}`;

    for (let i = 0; i < 2; i++) {
      expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(wrong) })).statusCode).toBe(401);
    }
    // Immediately over budget: still refused without hashing (the DoS bound holds).
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(401);

    // One reserved attempt per interval means an attacker holding the public
    // prefix cannot keep a live integration off the air — it recovers on retry.
    await new Promise((r) => setTimeout(r, 200));
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200);
  });

  it("the cache TTL slides on use, so a busy key never goes cold on a timer", () => {
    const minted = { hash: "$2a$10$stub", secret: "tl_live_slidingttlsecret000" };
    const key = { id: "ak_sliding", secretHash: minted.hash };
    const prefix = `slide-${Math.random().toString(36).slice(2, 8)}`;
    const t0 = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(t0);
      rememberVerification(prefix, minted.secret, key);
      // Two hits, each 40s apart: an ABSOLUTE 60s TTL would have expired between
      // them, dropping a busy key back onto bcrypt (and onto the failure bound).
      vi.setSystemTime(t0 + 40_000);
      expect(cachedVerification(prefix, minted.secret, key)).toBe(true);
      vi.setSystemTime(t0 + 80_000);
      expect(cachedVerification(prefix, minted.secret, key)).toBe(true);
      // Idle past the window from the LAST use: now it is cold.
      vi.setSystemTime(t0 + 141_000);
      expect(cachedVerification(prefix, minted.secret, key)).toBe(false);
    } finally {
      vi.useRealTimers();
      invalidateVerifiedPrefix(prefix);
    }
  });
});

describe("liveness checks the cache must never mask", () => {
  it("a key that EXPIRES underneath a hot cache stops working", async () => {
    const h = await buildTestAppWithRepos();
    const seeded = await seedServiceKey(h, { expiresAt: new Date(Date.now() + 1200).toISOString() });
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200); // hot

    await new Promise((r) => setTimeout(r, 1400));
    // Expiry is read off the LIVE row before the cache is consulted.
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(401);
  });

  it("a service user DEACTIVATED underneath a hot cache stops working", async () => {
    const h = await buildTestAppWithRepos();
    const seeded = await seedServiceKey(h);
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(200); // hot

    await h.users.update(seeded.userId, { active: false });
    // The cache only ever skips bcrypt — the principal is still re-read every request.
    expect((await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) })).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Re-proof review: the READ half of the surface. A scope map that only gates
// mutations leaves every disclosure ungated — including proposal payloads,
// which carry the bcrypt hash of a pending human's password.
// ---------------------------------------------------------------------------

describe("proposal payloads never leak credential material (read sweep)", () => {
  /** A pending onboard-user proposal — its payload holds a real bcrypt hash. */
  async function pendingOnboard(h: TestAppHandle): Promise<{ admin: string; proposalId: string }> {
    const admin = await platformAdmin(h);
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(admin),
      payload: { email: "leak.target@x.dev", password: "leak-secret-1", role: "Buyer", useCaseKey: "invoice-tokenization" },
    });
    expect(res.statusCode).toBe(202);
    return { admin, proposalId: res.json().proposal.id as string };
  }

  it("a key with an unrelated scope cannot see an onboard-user proposal at all", async () => {
    const h = await buildTestAppWithRepos();
    const { proposalId } = await pendingOnboard(h);
    const unrelated = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["assets:read"] });

    const listed = await h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(unrelated.secret) });
    expect(listed.statusCode).toBe(200);
    // A key sees only the proposals it could actually DECIDE — an `assets:read`
    // key has no business reading a human onboarding's payload.
    expect((listed.json() as { id: string }[]).map((p) => p.id)).not.toContain(proposalId);
    expect(listed.payload).not.toContain("passwordHash");
    expect(listed.payload).not.toContain("leak.target@x.dev");
  });

  it("a key that COULD decide it sees it — but never the password hash", async () => {
    const h = await buildTestAppWithRepos();
    const { proposalId } = await pendingOnboard(h);
    const onboarder = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["users:onboard"] });

    const listed = await h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(onboarder.secret) });
    expect(listed.statusCode).toBe(200);
    const row = (listed.json() as { id: string; payload: Record<string, unknown> }[]).find((p) => p.id === proposalId);
    // Visible, and still described well enough to approve knowingly…
    expect(row?.payload).toMatchObject({ email: "leak.target@x.dev", role: "Buyer" });
    // …but the credential itself is gone. An offline-crackable hash is never
    // approval evidence, so it is stripped for HUMANS too (below).
    expect(row?.payload).not.toHaveProperty("passwordHash");
  });

  it("the hash is stripped for a human PlatformAdmin too, on list AND on decide", async () => {
    const h = await buildTestAppWithRepos();
    const { proposalId } = await pendingOnboard(h);
    const admin2 = await loginAs(h.app, "admin2@tokenlayer.dev", "admin123");

    const listed = await h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(admin2) });
    expect(listed.statusCode).toBe(200);
    expect(listed.payload).not.toContain("passwordHash");

    const decided = await h.app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(admin2), payload: {} });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().proposal.status).toBe("executed");
    expect(decided.payload).not.toContain("passwordHash");
    // Stripping the projection must not break the executor — the onboarded user
    // still exists with a working password.
    expect(await loginAs(h.app, "leak.target@x.dev", "leak-secret-1")).toBeTruthy();
  });

  it("the 202 that DRAFTS a proposal does not echo the hash back either", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(admin),
      payload: { email: "echo.target@x.dev", password: "echo-secret-1", role: "Buyer", useCaseKey: "invoice-tokenization" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.payload).not.toContain("passwordHash");
  });

  it("a governance proposal is invisible to every key — no scope can decide it", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Invisible Governance Org");
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "invisible.admin@x.dev");
    const requested = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/capabilities/request`, headers: auth(orgAdmin),
      payload: { capabilities: { domains: ["identity"], roles: ["Issuer"] } },
    });
    expect(requested.statusCode).toBe(202);
    const proposalId = requested.json().proposal.id as string;

    const wildcard = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["*"] });
    const listed = await h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(wildcard.secret) });
    expect((listed.json() as { id: string }[]).map((p) => p.id)).not.toContain(proposalId);
    // The human PlatformAdmin who must decide it still sees it.
    const human = await h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(admin) });
    expect((human.json() as { id: string }[]).map((p) => p.id)).toContain(proposalId);
  });

  it("an unanswered apiScope refuses at RUNTIME, not just at compile time", async () => {
    const h = await buildTestAppWithRepos();
    const { proposalId } = await pendingOnboard(h);
    const wildcard = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["*"] });
    const handler = allProposalKinds().find((k) => k.kind === "onboard-user")!;
    const declared = handler.apiScope;

    // TypeScript makes `apiScope` required, but types are not a runtime guard:
    // a JS caller, a stale build or a serialization round-trip can still present
    // `undefined`. The refusal must key on "no answer", not on "null".
    (handler as { apiScope: unknown }).apiScope = undefined;
    try {
      const res = await h.app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(wildcard.secret), payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("MACHINE_PRINCIPAL");
    } finally {
      (handler as { apiScope: unknown }).apiScope = declared;
    }
  });
});

describe("read routes are scope-gated (read sweep)", () => {
  it("asset detail and aggregates need assets:read, not merely a key", async () => {
    const h = await buildTestAppWithRepos();
    const wrong = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["credentials:read"] });
    const right = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["assets:read"] });
    const reads = ["/analytics", "/accounts", "/audit/verify", "/me/portfolio", "/me/activity"];

    for (const path of reads) {
      const denied = await h.app.inject({ method: "GET", url: `${V1}${path}`, headers: auth(wrong.secret) });
      expect({ path, code: denied.statusCode, error: denied.json().error })
        .toEqual({ path, code: 403, error: "INSUFFICIENT_SCOPE" });
      // The right scope gets PAST the gate and into the route body. Not every
      // one of these answers 200 for a service user (the investor routes want a
      // wallet the key's user has none of) — what is under test is the gate, and
      // the JWT test below pins the 200s.
      const allowed = await h.app.inject({ method: "GET", url: `${V1}${path}`, headers: auth(right.secret) });
      expect({ path, error: allowed.json().error ?? null }).not.toEqual({ path, error: "INSUFFICIENT_SCOPE" });
    }
  });

  it("the user roster behind eligible-holders needs users:read", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const ucKey = await createCredUseCase(h, admin, "roster-uc");
    await subjectWithDid(h);
    const issueOnly = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["credentials:issue"] });
    const withRoster = await seedServiceKey(h, { role: "PlatformAdmin", scopes: ["credentials:issue", "users:read"] });
    const url = `${V1}/credential-use-cases/${ucKey}/eligible-holders`;

    // The picker returns every DID-bearing user's email and org — a roster, not
    // a credential act, so issuing does not imply reading it.
    const denied = await h.app.inject({ method: "GET", url, headers: auth(issueOnly.secret) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "users:read" } });
    expect((await h.app.inject({ method: "GET", url, headers: auth(withRoster.secret) })).statusCode).toBe(200);
  });

  it("a JWT session reads everything it could read before", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    for (const path of ["/analytics", "/accounts", "/audit/verify", "/me/portfolio", "/me/activity", "/proposals", "/identity/dashboard"]) {
      const res = await h.app.inject({ method: "GET", url: `${V1}${path}`, headers: auth(admin) });
      expect({ path, code: res.statusCode }).toEqual({ path, code: 200 });
    }
  });
});

// ---------------------------------------------------------------------------
// Final whole-branch review fixes (EN-B). Both findings are the SAME class: a
// tenancy predicate that decides authority without ever consulting the
// organization. EN-B did not introduce either — binding a key to an ordinary
// org member is what made both reachable by an unattended machine credential.
// ---------------------------------------------------------------------------

const suspend = (h: TestAppHandle, cred: string, id: string) =>
  h.app.inject({ method: "PATCH", url: `${V1}/users/${id}`, headers: auth(cred), payload: { active: false } });
const removeUser = (h: TestAppHandle, cred: string, id: string) =>
  h.app.inject({ method: "DELETE", url: `${V1}/users/${id}`, headers: auth(cred) });
const revokeIdentity = (h: TestAppHandle, cred: string, id: string) =>
  h.app.inject({ method: "POST", url: `${V1}/users/${id}/revoke-identity`, headers: auth(cred), payload: { reason: "test" } });
const idChallenge = (h: TestAppHandle, cred: string, id: string) =>
  h.app.inject({ method: "POST", url: `${V1}/users/${id}/identity/challenge`, headers: auth(cred), payload: {} });

/** Every route that administers an EXISTING account through `canAdministerUser`. */
const administerAll = async (h: TestAppHandle, cred: string, id: string) => [
  { route: "PATCH /users/:id", res: await suspend(h, cred, id) },
  { route: "DELETE /users/:id", res: await removeUser(h, cred, id) },
  { route: "POST /users/:id/revoke-identity", res: await revokeIdentity(h, cred, id) },
  { route: "POST /users/:id/identity/challenge", res: await idChallenge(h, cred, id) },
];

describe("administering an existing account is bounded by RANK and TENANCY (final review, HIGH)", () => {
  /**
   * An org, its human OrgAdmin, and a key holding nothing but `users:onboard`.
   * The key is OrgAdmin-roled — the strongest this surface can produce, and it
   * takes a PlatformAdmin to mint (canCreateOrgMember stops an OrgAdmin minting
   * a peer). An OrgAdmin-bound service user carries `useCaseKey: null`, which is
   * the whole bug: so does every PlatformAdmin and every other org's OrgAdmin.
   */
  async function attacker(h: TestAppHandle, admin: string, label: string) {
    const orgId = await makeOrg(h, admin, `${label} Co`);
    const humanTok = await makeOrgAdmin(h, admin, orgId, `${label}.admin@x.dev`);
    const key = await mintKey(h, admin, orgId, { name: `${label} key`, role: "OrgAdmin", scopes: ["users:onboard"] });
    return { orgId, humanTok, secret: key.secret };
  }

  it("a users:onboard key cannot suspend, delete or revoke-identity a PlatformAdmin", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const atk = await attacker(h, admin, "atk1");
    const victim = (await h.users.findByEmail("admin2@tokenlayer.dev"))!;

    for (const { route, res } of await administerAll(h, atk.secret, victim.id)) {
      expect({ route, code: res.statusCode }).toEqual({ route, code: 403 });
      expect({ route, error: res.json().error }).toEqual({ route, error: "FORBIDDEN" });
    }
    // The assertion that actually matters: the platform's second admin is still
    // there, still active, and can still log in. The review's proof of the hole
    // was a 200 on suspend, a 401 ACCOUNT_SUSPENDED on login, and a 204 that
    // removed the row.
    const still = await h.users.findById(victim.id);
    expect(still?.active).toBe(true);
    const login = await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "admin2@tokenlayer.dev", password: "admin123" } });
    expect(login.statusCode).toBe(200);
  });

  it("…nor a FOREIGN org's OrgAdmin, nor a foreign org's use-case-less member", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const atk = await attacker(h, admin, "atk2");
    const victimOrg = await makeOrg(h, admin, "Victim Co");
    await makeOrgAdmin(h, admin, victimOrg, "victim.admin@x.dev");
    const victimAdmin = (await h.users.findByEmail("victim.admin@x.dev"))!;
    // A plain member with NO use case. Use-case equality alone said `null ===
    // null` and called this the attacker's own tenant; only the org says otherwise.
    const made = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${victimOrg}/users`, headers: auth(admin),
      payload: { email: "victim.trader@x.dev", password: "secret1", role: "Trader" },
    });
    expect(made.statusCode).toBe(201);
    const victimMember = made.json().id as string;

    for (const target of [victimAdmin.id, victimMember]) {
      for (const cred of [atk.secret, atk.humanTok]) { // the key AND the human behind it
        for (const { route, res } of await administerAll(h, cred, target)) {
          expect({ route, code: res.statusCode }).toEqual({ route, code: 403 });
        }
      }
    }
    expect((await h.users.findById(victimMember))?.active).toBe(true);
    expect(await h.users.findById(victimAdmin.id)).not.toBeNull();
  });

  /**
   * The RANK rule on its own. The PlatformAdmin cases above are actually killed
   * by the org rule (a PlatformAdmin carries `orgId: null`, so it matches no
   * org), which would leave rank untested — and a guard no test kills is
   * decoration. A PEER OrgAdmin inside the attacker's OWN org is the case only
   * rank can refuse: same org, same null use case, equal rank.
   */
  it("a key cannot turn on its own org's OTHER OrgAdmin — rank, not tenancy", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const atk = await attacker(h, admin, "peer");
    // A second OrgAdmin in the SAME org. Only a PlatformAdmin can mint one
    // (canCreateOrgMember), which is precisely why destroying one must not be
    // available a tier lower.
    await makeOrgAdmin(h, admin, atk.orgId, "peer.other@x.dev");
    const peer = (await h.users.findByEmail("peer.other@x.dev"))!;
    expect(peer.orgId).toBe(atk.orgId); // same tenant — tenancy cannot be what refuses this

    for (const cred of [atk.secret, atk.humanTok]) {
      for (const { route, res } of await administerAll(h, cred, peer.id)) {
        expect({ route, code: res.statusCode }).toEqual({ route, code: 403 });
      }
    }
    expect((await h.users.findById(peer.id))?.active).toBe(true);
    expect((await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "peer.other@x.dev", password: "secret1" } })).statusCode).toBe(200);
  });

  it("a HUMAN OrgAdmin cannot delete a PlatformAdmin either — the predicate was always wrong", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const atk = await attacker(h, admin, "atk3");
    const victim = (await h.users.findByEmail("admin2@tokenlayer.dev"))!;

    for (const { route, res } of await administerAll(h, atk.humanTok, victim.id)) {
      expect({ route, code: res.statusCode }).toEqual({ route, code: 403 });
    }
    expect(await h.users.findById(victim.id)).not.toBeNull();
  });

  it("the legitimate paths are untouched: own-org members, and a PlatformAdmin over anyone", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Legit Co");
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "legit.admin@x.dev");
    const key = await mintKey(h, admin, orgId, { name: "legit key", role: "OrgAdmin", scopes: ["users:onboard"] });
    const addMember = async (email: string) => {
      const res = await h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(orgAdmin), payload: { email, password: "secret1", role: "Trader" } });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    };

    // The human OrgAdmin still suspends and still deletes their own member.
    const byHuman = await addMember("legit.one@x.dev");
    expect((await suspend(h, orgAdmin, byHuman)).statusCode).toBe(200);
    expect((await removeUser(h, orgAdmin, byHuman)).statusCode).toBe(204);
    expect(await h.users.findById(byHuman)).toBeNull();

    // …and so does the key. Delegating onboarding still delegates something.
    const byKey = await addMember("legit.two@x.dev");
    expect((await suspend(h, key.secret, byKey)).statusCode).toBe(200);
    expect((await h.users.findById(byKey))?.active).toBe(false);
    expect((await removeUser(h, key.secret, byKey)).statusCode).toBe(204);

    // A PlatformAdmin still reaches anyone at all, including another PlatformAdmin.
    const admin2 = (await h.users.findByEmail("admin2@tokenlayer.dev"))!;
    expect((await suspend(h, admin, admin2.id)).statusCode).toBe(200);
  });

  it("a USE-CASE-scoped manager still manages their own use case's members", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const checker = await loginAs(h.app, "admin2@tokenlayer.dev", "admin123");
    const uca = await onboardUser(h.app, admin, checker, { email: "uca@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: "invoice-tokenization" });
    const buyer = await onboardUser(h.app, admin, checker, { email: "uca.buyer@x.dev", password: "secret1", role: "Buyer", useCaseKey: "invoice-tokenization" });
    const ucaTok = await loginAs(h.app, "uca@x.dev", "secret1");

    // Same use case, below them in rank: unchanged, 200.
    expect((await suspend(h, ucaTok, buyer.id)).statusCode).toBe(200);
    // A peer UseCaseAdmin (here, themselves) stays out of reach.
    expect((await suspend(h, ucaTok, uca.id)).statusCode).toBe(403);
    // An unscoped PlatformAdmin is not in their use case, and outranks them.
    const admin2 = (await h.users.findByEmail("admin2@tokenlayer.dev"))!;
    expect((await removeUser(h, ucaTok, admin2.id)).statusCode).toBe(403);
    expect(await h.users.findById(admin2.id)).not.toBeNull();

    // The USE-CASE equality rule on its own: an identical role, identically
    // ranked, in a DIFFERENT use case. Nothing but that comparison refuses this.
    const stranger = await onboardUser(h.app, admin, checker, { email: "other.buyer@x.dev", password: "secret1", role: "Buyer", useCaseKey: "carbon-credit" });
    for (const { route, res } of await administerAll(h, ucaTok, stranger.id)) {
      expect({ route, code: res.statusCode }).toEqual({ route, code: 403 });
    }
    expect((await h.users.findById(stranger.id))?.active).toBe(true);
  });
});

/** A complete, schema-valid TOKENIZATION definition deployable on the test stack (fabric). */
const TOK_DEF = (key: string) => ({
  key, name: `Notes ${key}`, symbol: "NTS", tokenStandard: "ERC-20",
  allowedChainIds: ["fabric"], defaultChainId: "fabric",
  metadataSchema: { type: "object", properties: {} },
  lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
  compliance: { allowlist: true, transferRestrictions: false },
  roles: ["UseCaseAdmin", "Issuer"],
});

/** The real org self-service path to an org-OWNED tokenization use case: draft → PlatformAdmin approves. */
async function ownedUseCase(h: TestAppHandle, admin: string, orgAdmin: string, key: string): Promise<string> {
  const draft = await h.app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(orgAdmin), payload: TOK_DEF(key) });
  if (draft.statusCode !== 202) throw new Error(`ownedUseCase draft failed: ${draft.statusCode} ${draft.payload}`);
  const appr = await h.app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(admin), payload: {} });
  // "executed" (not merely "approved"): the create-use-case executor deploys and
  // persists on approval, stamping ownerOrgId from the PROPOSER's org.
  const p = appr.json().proposal as { status: string; payload: { ownerOrgId?: string } };
  if (p?.status !== "executed") throw new Error(`ownedUseCase approve failed: ${appr.statusCode} ${appr.payload}`);
  expect(p.payload.ownerOrgId).toBeTruthy();
  return key;
}

describe("a member — and so a KEY — binds only to a use case its org owns (final review, MEDIUM)", () => {
  it("binding to a tokenization use case the org does not own is ORG_NOT_BOUND, on both mint paths", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Foreign Binder Co");
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "binder.admin@x.dev");

    // The review's exact proof-of-concept: this used to return 201, and the key
    // then read the victim tenant's whole register through `scopedToCaller`.
    const mint = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(orgAdmin),
      payload: { name: "exfil", role: "Trader", useCaseKey: "invoice-tokenization", scopes: ["assets:read", "assets:transfer"] },
    });
    expect(mint.statusCode).toBe(403);
    expect(mint.json()).toMatchObject({ error: "ORG_NOT_BOUND", details: { orgId, useCaseKey: "invoice-tokenization" } });

    // The human member path is the same function, so it is closed identically —
    // otherwise the OrgAdmin just mints the member and logs in as them.
    const member = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(orgAdmin),
      payload: { email: "binder.trader@x.dev", password: "secret1", role: "Trader", useCaseKey: "invoice-tokenization" },
    });
    expect(member.statusCode).toBe(403);
    expect(member.json().error).toBe("ORG_NOT_BOUND");

    // Nothing was created by either attempt — no user, no key, no service account.
    expect((await h.app.inject({ method: "GET", url: `${V1}/orgs/${orgId}/members`, headers: auth(orgAdmin) })).json()).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ useCaseKey: "invoice-tokenization" })]),
    );
    expect((await h.app.inject({ method: "GET", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(orgAdmin) })).json()).toEqual([]);

    // An unknown key fails CLOSED rather than being stored for later.
    const unknown = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(orgAdmin),
      payload: { name: "future", role: "Trader", useCaseKey: "not-a-use-case", scopes: ["assets:read"] },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("USE_CASE_NOT_FOUND");

    // The unknown-key refusal is a check in its OWN right, not a side effect of
    // the ownership lookup: it must also bite on the two paths that skip
    // ownership entirely — a Holder (ungated by design) and a PlatformAdmin
    // (exempt by design). Otherwise "name a key nobody has created yet, and
    // acquire the use case when someone else creates it" stays open for them.
    const holderUnknown = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(orgAdmin),
      payload: { email: "binder.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: "not-a-use-case" },
    });
    expect(holderUnknown.statusCode).toBe(404);
    expect(holderUnknown.json().error).toBe("USE_CASE_NOT_FOUND");

    const platformUnknown = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(admin),
      payload: { name: "platform future", role: "Trader", useCaseKey: "not-a-use-case", scopes: ["assets:read"] },
    });
    expect(platformUnknown.statusCode).toBe(404);
    expect(platformUnknown.json().error).toBe("USE_CASE_NOT_FOUND");
  });

  it("the org's OWN use case still mints a working key, and that key sees only its own register", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Owner Co");
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "owner.admin@x.dev");
    const ownKey = await ownedUseCase(h, admin, orgAdmin, "owner-notes");
    // Something confidential in the use case the org does NOT own — this is the
    // asset the review's foreign-bound key read back in full.
    const confidential = await h.app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(admin),
      payload: {
        useCaseKey: "invoice-tokenization", name: "CONFIDENTIAL-INV-1", chainId: "fabric",
        metadata: { invoiceNumber: "CONFIDENTIAL-INV-1", invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2099-12-31" },
      },
    });
    expect(confidential.statusCode).toBe(201);

    const minted = await mintKey(h, orgAdmin, orgId, { name: "own erp", role: "Trader", useCaseKey: ownKey, scopes: ["assets:read"] });
    expect(minted.key).toMatchObject({ role: "Trader", useCaseKey: ownKey, status: "active" });

    const assets = await h.app.inject({ method: "GET", url: `${V1}/assets`, headers: auth(minted.secret) });
    expect(assets.statusCode).toBe(200);
    const rows = (assets.json() as { data: { useCaseKey: string; name: string }[] }).data;
    expect(rows.every((a) => a.useCaseKey === ownKey)).toBe(true);
    expect(rows.some((a) => a.name === "CONFIDENTIAL-INV-1")).toBe(false);
  });

  it("a PlatformAdmin is exempt, and a Holder stays deliberately ungated", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Exempt Co");
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "exempt.admin@x.dev");

    // The platform override: a PlatformAdmin still assigns platform-seeded use cases.
    const byPlatform = await mintKey(h, admin, orgId, { name: "platform bound", role: "Trader", useCaseKey: "invoice-tokenization", scopes: ["assets:read"] });
    expect(byPlatform.key.useCaseKey).toBe("invoice-tokenization");

    // Holder: no route authorizes on `role === "Holder"`, so the key grants
    // nothing and holderPolicy decides at issuance time. Unchanged.
    const holder = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(orgAdmin),
      payload: { email: "exempt.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: "invoice-tokenization" },
    });
    expect(holder.statusCode).toBe(201);
  });
});
