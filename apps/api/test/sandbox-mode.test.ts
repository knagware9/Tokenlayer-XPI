import { MockLedgerAdapter } from "@tokenlayer/adapters";
import { SANDBOX_CHAIN_ID, type CredentialUseCaseDefinition, type ResourceMode, type UseCaseDefinition } from "@tokenlayer/core";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { KEY_PREFIX_MARKERS, mintSecret, prefixOf } from "../src/api-keys.js";
import { buildChainRegistry } from "../src/chains.js";
import {
  MemoryApiKeyRepository,
  MemoryCredentialUseCaseRepository,
  MemoryEventRepository,
  MemoryUseCaseRepository,
  MemoryWebhookEndpointRepository,
} from "../src/persistence/memory.js";
import {
  rowToApiKey,
  rowToCredentialUseCase,
  rowToEvent,
  rowToUseCase,
  rowToWebhookEndpoint,
} from "../src/persistence/prisma.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

// NOTE: importing prisma.js constructs a PrismaClient at module load. That is a
// pure construction — it opens no connection and needs no DATABASE_URL — which
// is what lets these mapper assertions run in a database-less harness.

// A dev-only throwaway key (hardhat account #1) — never used on a live network here.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/**
 * EVERY connection env this repo knows about, all set at once. Under this env
 * besu/mst are real EVM chains and fabric/canton are promoted to their real
 * adapters — which is exactly the point: it is the environment most likely to
 * drag the sandbox chain along with it.
 */
const EVERY_REAL_CHAIN_ENV = {
  BESU_RPC_URL: "http://127.0.0.1:9",
  BESU_OPERATOR_KEY: KEY,
  MST_RPC_URL: "http://127.0.0.1:9",
  MST_OPERATOR_KEY: KEY,
  EVM_OPERATOR_KEY: KEY,
  FABRIC_CONNECTION_PROFILE: "/nonexistent/connection.json",
  FABRIC_WALLET: "./wallet",
  FABRIC_IDENTITY: "appUser",
  FABRIC_CHANNEL: "mychannel",
  FABRIC_CHAINCODE: "tokenlayer",
  CANTON_LEDGER_URL: "http://127.0.0.1:9",
  CANTON_TOKEN: "token",
  CANTON_OPERATOR_PARTY: "operator",
  CANTON_TEMPLATE_ID: "Tokenlayer:Asset",
  // Speculative "promote the sandbox" envs, in the shape every other chain uses.
  // Nothing may read these — the chain has no rpcEnv/keyEnv at all.
  SANDBOX_RPC_URL: "http://127.0.0.1:9",
  SANDBOX_OPERATOR_KEY: KEY,
} as const;

const useCaseDef: UseCaseDefinition = {
  key: "d2-defaults",
  name: "D2 defaults",
  tokenStandard: "ERC-20",
  tokenType: "fungible",
  symbol: "D2D",
  allowedChainIds: ["besu"],
  defaultChainId: "besu",
  metadataSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  lifecycle: { mint: true, transfer: true, burn: false, freeze: false },
  compliance: { allowlist: false, transferRestrictions: false },
  roles: ["Issuer"],
};

const credentialUseCaseDef: CredentialUseCaseDefinition = {
  key: "d2-cred-defaults",
  name: "D2 credential defaults",
  credentialTypes: [
    {
      name: "KycCredential",
      title: "KYC",
      validityDays: 365,
      claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } },
    },
  ],
  issuer: { kind: "platform" },
  holderPolicy: { who: "any-onboarded" },
  verifier: { kind: "any" },
};

/** A UseCase row exactly as SQLite hands it back, with the DB default applied. */
function useCaseRow(sandbox: boolean) {
  return {
    key: "d2-defaults",
    name: "D2 defaults",
    description: null,
    tokenStandard: "ERC-20",
    symbol: "D2D",
    defaultChainId: "besu",
    allowedChainIds: JSON.stringify(["besu"]),
    contracts: "{}",
    metadataSchema: JSON.stringify(useCaseDef.metadataSchema),
    lifecycle: JSON.stringify(useCaseDef.lifecycle),
    compliance: JSON.stringify(useCaseDef.compliance),
    fees: "{}",
    saleTermsDefault: "{}",
    valuation: "{}",
    derivedFields: "{}",
    uniqueBy: null,
    terms: "{}",
    workflow: "{}",
    roles: JSON.stringify(["Issuer"]),
    ownerOrgId: null,
    sandbox,
  };
}

function credentialUseCaseRow(sandbox: boolean) {
  return {
    key: "d2-cred-defaults",
    name: "D2 credential defaults",
    description: null,
    credentialTypes: JSON.stringify(credentialUseCaseDef.credentialTypes),
    issuer: JSON.stringify(credentialUseCaseDef.issuer),
    holderPolicy: JSON.stringify(credentialUseCaseDef.holderPolicy),
    verifier: JSON.stringify(credentialUseCaseDef.verifier),
    ownerOrgId: null,
    holderAcceptance: false,
    sandbox,
  };
}

function apiKeyRow(mode: string) {
  return {
    id: "ak_1", orgId: null, userId: "u1", name: "k", prefix: "tl_live_",
    secretHash: "h", scopes: "[]", expiresAt: null, lastUsedAt: null, revokedAt: null,
    revokedBy: null, createdBy: "u1", createdAt: new Date("2026-08-08T00:00:00.000Z"),
    mode,
  };
}

function eventRow(mode: string) {
  return {
    seq: 1, id: "evt_1", type: "asset.issued", orgId: null, useCaseKey: null,
    subjectId: null, data: "{}", occurredAt: new Date("2026-08-08T00:00:00.000Z"),
    mode,
  };
}

function webhookEndpointRow(mode: string) {
  return {
    id: "whep_1", orgId: null, url: "https://example.test/hook", description: null,
    eventTypes: JSON.stringify(["*"]), useCaseKey: null, secretEncrypted: "cipher",
    status: "active", disabledReason: null, disabledAt: null, consecutiveFailures: 0,
    consecutiveGuardFailures: 0, failingSince: null, deletedAt: null, createdBy: "u1",
    createdAt: new Date("2026-08-08T00:00:00.000Z"), lastDeliveryAt: null,
    mode,
  };
}

describe("EN-D2 · the sandbox chain", () => {
  it("the sandbox chain is simulated no matter what the env says", async () => {
    const reg = buildChainRegistry(EVERY_REAL_CHAIN_ENV);
    const byId = new Map(reg.list().map((c) => [c.id, c] as const));

    // Sanity: this env really is the promoting one. Without these the sandbox
    // assertions below could pass simply because nothing was configured.
    expect(byId.get("besu")?.mode).toBe("real");
    expect(byId.get("mst")?.mode).toBe("real");
    expect(byId.get("fabric")?.mode).toBe("real");
    expect(byId.get("canton")?.mode).toBe("real");

    const sandbox = byId.get(SANDBOX_CHAIN_ID);
    expect(sandbox).toBeDefined();
    expect(sandbox?.mode).toBe("simulated");
    expect(sandbox?.available).toBe(true);
    expect(sandbox?.family).toBe("mock");
    // The adapter itself, not just the label: an in-memory ledger and nothing else.
    expect(reg.resolveAdapter(SANDBOX_CHAIN_ID)).toBeInstanceOf(MockLedgerAdapter);
    await expect(reg.probe(SANDBOX_CHAIN_ID)).resolves.toMatchObject({ mode: "simulated", reachable: true });
  });

  it("is present and simulated with no env at all", () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    const sandbox = reg.list().find((c) => c.id === SANDBOX_CHAIN_ID);
    expect(sandbox?.mode).toBe("simulated");
    expect(sandbox?.available).toBe(true);
    expect(reg.resolveAdapter(SANDBOX_CHAIN_ID)).toBeInstanceOf(MockLedgerAdapter);
  });
});

describe("EN-D2 · persisted mode/sandbox defaults", () => {
  it("existing rows default to live / non-sandbox", async () => {
    // --- memory repos: create WITHOUT the new field ---
    const useCases = new MemoryUseCaseRepository();
    const created = await useCases.create(useCaseDef);
    expect(created.sandbox).toBe(false);
    expect((await useCases.get("d2-defaults")).sandbox).toBe(false);
    expect((await useCases.update("d2-defaults", useCaseDef)).sandbox).toBe(false);

    const credentialUseCases = new MemoryCredentialUseCaseRepository();
    const cuc = await credentialUseCases.create(credentialUseCaseDef);
    expect(cuc.sandbox).toBe(false);
    expect((await credentialUseCases.get("d2-cred-defaults"))?.sandbox).toBe(false);

    const apiKeys = new MemoryApiKeyRepository();
    const key = await apiKeys.create({
      orgId: null, userId: "u1", name: "k", prefix: "tl_live_", secretHash: "h",
      scopes: [], expiresAt: null, createdBy: "u1",
    });
    expect(key.mode).toBe("live");
    expect((await apiKeys.findById(key.id))?.mode).toBe("live");

    const endpoints = new MemoryWebhookEndpointRepository();
    const endpoint = await endpoints.create({
      orgId: null, url: "https://example.test/hook", description: null, eventTypes: ["*"],
      useCaseKey: null, secretEncrypted: "cipher", createdBy: "u1",
    });
    expect(endpoint.mode).toBe("live");
    expect((await endpoints.findById(endpoint.id))?.mode).toBe("live");

    const events = new MemoryEventRepository();
    const event = await events.append({ type: "asset.issued", orgId: null, useCaseKey: null, subjectId: null, data: {} });
    expect(event.mode).toBe("live");
    expect((await events.findById(event.id))?.mode).toBe("live");

    // --- prisma repos: the harness has no database, so the half that only a
    // live walkthrough would otherwise reach is covered at its mapper. A column
    // dropped from a row->record mapper is invisible to every memory-backed
    // test, and that is precisely the drift THE PARITY RULE exists to stop.
    expect(rowToUseCase(useCaseRow(false)).sandbox).toBe(false);
    expect(rowToCredentialUseCase(credentialUseCaseRow(false)).sandbox).toBe(false);
    expect(rowToApiKey(apiKeyRow("live")).mode).toBe("live");
    expect(rowToWebhookEndpoint(webhookEndpointRow("live")).mode).toBe("live");
    expect(rowToEvent(eventRow("live")).mode).toBe("live");
  });

  it("carries a non-default mode/sandbox through both repos", async () => {
    // The mirror of the defaults test: proves the mappers READ the column
    // rather than hardcoding the default.
    const useCases = new MemoryUseCaseRepository();
    expect((await useCases.create({ ...useCaseDef, sandbox: true })).sandbox).toBe(true);

    const credentialUseCases = new MemoryCredentialUseCaseRepository();
    expect((await credentialUseCases.create({ ...credentialUseCaseDef, sandbox: true })).sandbox).toBe(true);

    const apiKeys = new MemoryApiKeyRepository();
    const key = await apiKeys.create({
      orgId: null, userId: "u1", name: "k", prefix: "tl_test_", secretHash: "h",
      scopes: [], expiresAt: null, createdBy: "u1", mode: "test",
    });
    expect(key.mode).toBe("test");
    expect((await apiKeys.findByPrefix("tl_test_"))?.mode).toBe("test");

    const endpoints = new MemoryWebhookEndpointRepository();
    const endpoint = await endpoints.create({
      orgId: null, url: "https://example.test/hook", description: null, eventTypes: ["*"],
      useCaseKey: null, secretEncrypted: "cipher", createdBy: "u1", mode: "test",
    });
    expect(endpoint.mode).toBe("test");
    expect((await endpoints.listActive())[0]?.mode).toBe("test");

    const events = new MemoryEventRepository();
    const event = await events.append({
      type: "asset.issued", orgId: null, useCaseKey: null, subjectId: null, data: {}, mode: "test",
    });
    expect(event.mode).toBe("test");
    expect((await events.listAfter(0, { limit: 10 }))[0]?.mode).toBe("test");

    expect(rowToUseCase(useCaseRow(true)).sandbox).toBe(true);
    expect(rowToCredentialUseCase(credentialUseCaseRow(true)).sandbox).toBe(true);
    expect(rowToApiKey(apiKeyRow("test")).mode).toBe("test");
    expect(rowToWebhookEndpoint(webhookEndpointRow("test")).mode).toBe("test");
    expect(rowToEvent(eventRow("test")).mode).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// Task D2-3 — the secret STRING carries the mode, and the string is checked
// against the row.
//
// The record already knows its mode, so the marker buys exactly one thing: a
// human can see, in a log line or a config file, that a `tl_test_` secret is
// not a production credential. That is worth nothing unless the two agree —
// hence the disagreement test below, which is the real subject of this block.
// ---------------------------------------------------------------------------

/** Cheap rounds — these tests hash per request and cost is not what's under test. */
const TEST_ROUNDS = 4;

/** The single 401 every rejection path answers with (EN-B: no oracle). */
const GENERIC_401 = { error: "UNAUTHORIZED", message: "missing or invalid bearer token" };

/**
 * A service user + key straight through the repos, with the STORED mode and the
 * MINTED marker chosen independently — `mintAs` defaults to `mode`, so the
 * honest cases read as one argument and only the divergent case names two.
 */
async function seedKey(
  h: TestAppHandle,
  opts: { mode?: ResourceMode; mintAs?: ResourceMode } = {},
): Promise<{ secret: string; keyId: string; userId: string; prefix: string }> {
  const mode = opts.mode ?? "live";
  const tag = Math.random().toString(36).slice(2, 10);
  const svc = await h.users.create({
    email: `svc-d2-${tag}@tokenlayer.dev`,
    passwordHash: bcrypt.hashSync(`unguessable-${tag}`, TEST_ROUNDS),
    role: "PlatformAdmin", useCaseKey: null, accountId: null, active: true,
    kycStatus: "approved", kyc: null, orgId: null, kind: "service",
  });
  const minted = await mintSecret(TEST_ROUNDS, opts.mintAs ?? mode);
  const key = await h.apiKeys.create({
    orgId: null, userId: svc.id, name: `key ${tag}`, prefix: minted.prefix,
    secretHash: minted.hash, scopes: ["*"], expiresAt: null, createdBy: "test", mode,
  });
  return { secret: minted.secret, keyId: key.id, userId: svc.id, prefix: minted.prefix };
}

describe("EN-D2 · the tl_test_ marker", () => {
  it("mints a test secret with tl_test_ and a live one with tl_live_", async () => {
    const live = await mintSecret(TEST_ROUNDS, "live");
    const test = await mintSecret(TEST_ROUNDS, "test");

    expect(live.secret.startsWith("tl_live_")).toBe(true);
    expect(test.secret.startsWith("tl_test_")).toBe(true);

    // The stored/displayed prefix is the BODY in both cases — the marker is not
    // part of it, or every test key would share the same first 8 chars.
    expect(live.prefix).toBe(live.secret.slice("tl_live_".length, "tl_live_".length + 8));
    expect(test.prefix).toBe(test.secret.slice("tl_test_".length, "tl_test_".length + 8));
    expect(live.prefix).not.toBe(test.prefix);
    expect(await bcrypt.compare(test.secret, test.hash)).toBe(true);
    // The hash covers the FULL secret, marker included: a live-marked copy of a
    // test body is not the same credential.
    expect(await bcrypt.compare(`tl_live_${test.secret.slice("tl_test_".length)}`, test.hash)).toBe(false);

    // Omitting the mode still mints a LIVE key: every pre-EN-D2 call site.
    expect((await mintSecret(TEST_ROUNDS)).secret.startsWith("tl_live_")).toBe(true);

    // ONE map, so mint and parse cannot drift and a third mode is one entry.
    expect(KEY_PREFIX_MARKERS).toEqual({ live: "tl_live_", test: "tl_test_" });
  });

  it("the auth path accepts BOTH markers and refuses an unknown one", async () => {
    // --- the parser ---
    expect(prefixOf(`tl_live_${"a".repeat(22)}`)).toEqual({ prefix: "aaaaaaaa", mode: "live" });
    expect(prefixOf(`tl_test_${"b".repeat(22)}`)).toEqual({ prefix: "bbbbbbbb", mode: "test" });
    // tl_prod_… is refused, not silently taken for a live key.
    expect(prefixOf(`tl_prod_${"c".repeat(22)}`)).toBeNull();
    expect(prefixOf(`tl_${"c".repeat(22)}`)).toBeNull();
    expect(prefixOf(`tl_live${"c".repeat(22)}`)).toBeNull();
    expect(prefixOf("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.x")).toBeNull();
    expect(prefixOf("")).toBeNull();
    expect(prefixOf("tl_test_short")).toBeNull(); // body shorter than the prefix

    // --- end to end ---
    const h = await buildTestAppWithRepos();
    const live = await seedKey(h, { mode: "live" });
    const test = await seedKey(h, { mode: "test" });

    for (const cred of [live.secret, test.secret]) {
      const me = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(cred) });
      expect(me.statusCode).toBe(200);
    }

    // An unknown marker over a REAL test key's body: the string is not a
    // credential at all, so it falls to the JWT path and 401s generically.
    const disguised = `tl_prod_${test.secret.slice("tl_test_".length)}`;
    const res = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(disguised) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(GENERIC_401);
  });

  it("REFUSES a key whose marker disagrees with its stored mode", async () => {
    const h = await buildTestAppWithRepos();

    // Both directions — a live-looking secret on a test row is the dangerous
    // one, but a test-looking secret on a LIVE row is equally a lie.
    const liveStringTestRow = await seedKey(h, { mode: "test", mintAs: "live" });
    const testStringLiveRow = await seedKey(h, { mode: "live", mintAs: "test" });
    // The reference: a prefix no row has at all.
    const unknown = `tl_live_${"z".repeat(22)}`;

    const [a, b, u] = await Promise.all(
      [liveStringTestRow.secret, testStringLiveRow.secret, unknown].map((cred) =>
        h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(cred) }),
      ),
    );

    for (const res of [a, b, u]) expect(res.statusCode).toBe(401);
    // Same generic body as an unknown key: the endpoint must not become an
    // oracle for "this prefix exists but its mode is wrong".
    expect(a.json()).toEqual(GENERIC_401);
    expect(b.json()).toEqual(GENERIC_401);
    expect(a.json()).toEqual(u.json());
    expect(b.json()).toEqual(u.json());

    // Sanity: the rows really do exist and the secrets really are otherwise
    // valid — without this the test could pass because nothing was found.
    const rowA = await h.apiKeys.findByPrefix(liveStringTestRow.prefix);
    expect(rowA?.mode).toBe("test");
    expect(await bcrypt.compare(liveStringTestRow.secret, rowA!.secretHash)).toBe(true);
    // A refused request leaves no trace of use, exactly as every other 401 path.
    expect(rowA?.lastUsedAt).toBeNull();
    expect((await h.apiKeys.findById(testStringLiveRow.keyId))?.lastUsedAt).toBeNull();
  });

  it("a live key still authenticates exactly as before", async () => {
    const h = await buildTestAppWithRepos();
    // No mode anywhere: the shape of every key minted before EN-D2.
    const seeded = await seedKey(h);
    expect(seeded.secret.startsWith("tl_live_")).toBe(true);
    expect((await h.apiKeys.findById(seeded.keyId))?.mode).toBe("live");

    const me = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(seeded.secret) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: seeded.userId, role: "PlatformAdmin" });
    expect((await h.apiKeys.findById(seeded.keyId))?.lastUsedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Task D2-4 — THE ENFORCEMENT.
//
// Everything above this line proves the two modes can be STORED. What follows
// proves they are kept apart: that a `tl_test_` key cannot reach a live use
// case, that a `tl_live_` key cannot reach a sandbox one, that a human session
// — which has no mode — reaches both, and that the flag itself cannot be
// forged at the write or flipped afterwards.
//
// `mode-coverage.test.ts` is the other half of this task and answers a
// different question: not "does the gate work" but "is it PRESENT on every
// route that needs it". Neither test subsumes the other — a gate that works on
// the two routes exercised here and is missing from thirty others would pass
// this file completely.
// ---------------------------------------------------------------------------

/** A tokenization use case straight into the repo — no deploy, no chain. */
async function seedUseCase(h: TestAppHandle, key: string, sandbox: boolean) {
  return h.deps.useCases.create({
    ...useCaseDef, key, name: key, sandbox,
    allowedChainIds: sandbox ? [SANDBOX_CHAIN_ID] : ["fabric"],
    defaultChainId: sandbox ? SANDBOX_CHAIN_ID : "fabric",
  });
}

/** A credential use case bound to `orgId` as its issuer, in one mode or the other. */
async function seedCredentialUseCase(h: TestAppHandle, key: string, sandbox: boolean, orgId: string) {
  return h.deps.credentialUseCases.create({
    ...credentialUseCaseDef, key, name: key, sandbox, issuer: { kind: "org", orgId }, ownerOrgId: orgId,
  });
}

/**
 * An org with a LEGACY (null) capability envelope and its OrgAdmin, built
 * straight through the repos.
 *
 * The null envelope is deliberate: EN-A's capability checks all pass for a
 * legacy org, so nothing but the mode gate can be the reason a request
 * succeeds or fails below. A test whose control case could have been refused
 * for a second reason proves nothing about the first.
 */
async function seedOrgAdmin(h: TestAppHandle): Promise<{ orgId: string; token: string }> {
  const tag = Math.random().toString(36).slice(2, 10);
  const org = await h.organizations.create({
    name: `D2 Issuer ${tag}`, orgType: "issuer", registrationId: null, jurisdiction: null,
    did: `did:key:zD2${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
    verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
  });
  const email = `orgadmin-d2-${tag}@tokenlayer.dev`;
  const password = `orgadmin-${tag}`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync(password, TEST_ROUNDS), role: "OrgAdmin",
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId: org.id, kind: "human",
  });
  return { orgId: org.id, token: await loginAs(h.app, email, password) };
}

/** The one credential-issuance call both the keys and the human make below. */
const issueOn = (h: TestAppHandle, key: string, cred: string) => h.app.inject({
  method: "POST", url: `${V1}/credential-use-cases/${key}/credentials`, headers: auth(cred),
  payload: { credentialType: "KycCredential", claims: { legalName: "Acme Ltd" } },
});

/** A whole world: an org, both credential use cases, both token use cases, both keys. */
async function modeWorld() {
  const h = await buildTestAppWithRepos();
  const { orgId, token } = await seedOrgAdmin(h);
  await seedCredentialUseCase(h, "d2-live-kyc", false, orgId);
  await seedCredentialUseCase(h, "d2-test-kyc", true, orgId);
  await seedUseCase(h, "d2-live-tok", false);
  await seedUseCase(h, "d2-test-tok", true);
  const liveKey = await seedKey(h, { mode: "live" });
  const testKey = await seedKey(h, { mode: "test" });
  return { h, orgAdmin: token, liveKey: liveKey.secret, testKey: testKey.secret };
}

describe("EN-D2 · the mode gate", () => {
  it("a tl_test_ key is refused on a LIVE use case — 403 WRONG_MODE", async () => {
    const w = await modeWorld();

    // The act: issuing a credential against a live programme.
    const issued = await issueOn(w.h, "d2-live-kyc", w.testKey);
    expect(issued.statusCode).toBe(403);
    expect(issued.json()).toMatchObject({
      error: "WRONG_MODE",
      details: { keyMode: "test", useCaseMode: "live" },
    });

    // The read: live CONFIGURATION is not a sandbox key's to see either.
    const read = await w.h.app.inject({ method: "GET", url: `${V1}/use-cases/d2-live-tok`, headers: auth(w.testKey) });
    expect(read.statusCode).toBe(403);
    expect(read.json().error).toBe("WRONG_MODE");

    // THE CONTROL, and the point of it: the very same key succeeds on the
    // matching-mode use case. Without this the two assertions above would be
    // satisfied by a key that could do nothing at all — an authorization test
    // whose subject is broken proves only that broken things are refused.
    const own = await w.h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/d2-test-kyc`, headers: auth(w.testKey) });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ key: "d2-test-kyc", sandbox: true });
  });

  it("a tl_live_ key is refused on a SANDBOX use case — 403 WRONG_MODE", async () => {
    // THE OTHER DIRECTION, and the one an implementation is most likely to
    // forget: "keep test keys out of production" is the instinct, and a gate
    // written as that instinct (`actor !== "test" || …`) leaves live keys free
    // to mint into the sandbox — corrupting the very register an integrator is
    // using to check their own work, with real credentials, invisibly.
    const w = await modeWorld();

    const issued = await issueOn(w.h, "d2-test-kyc", w.liveKey);
    expect(issued.statusCode).toBe(403);
    expect(issued.json()).toMatchObject({
      error: "WRONG_MODE",
      details: { keyMode: "live", useCaseMode: "test" },
    });

    const read = await w.h.app.inject({ method: "GET", url: `${V1}/use-cases/d2-test-tok`, headers: auth(w.liveKey) });
    expect(read.statusCode).toBe(403);
    expect(read.json().error).toBe("WRONG_MODE");

    const own = await w.h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/d2-live-kyc`, headers: auth(w.liveKey) });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ key: "d2-live-kyc", sandbox: false });
  });

  it("a human OrgAdmin succeeds on BOTH", async () => {
    // THE SESSION ASYMMETRY, exercised rather than asserted about. A human has
    // no mode, and an OrgAdmin who could not open their own sandbox could not
    // configure it — which would make the whole feature unusable by the person
    // it is for. It is the single asymmetry in the design and therefore the
    // thing a later "tighten the gate" change is most likely to break.
    const w = await modeWorld();

    for (const key of ["d2-live-kyc", "d2-test-kyc"]) {
      const read = await w.h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/${key}`, headers: auth(w.orgAdmin) });
      expect(read.statusCode, `${key} read`).toBe(200);

      // And an ACT on both, not just a read. The request is deliberately
      // incomplete (no subject), so the 400 it earns is proof it ran the whole
      // issuer-binding gate and reached claim validation — i.e. that nothing
      // about its ENVIRONMENT stopped it.
      const issued = await issueOn(w.h, key, w.orgAdmin);
      expect(issued.json().error, `${key} issue`).toBe("SUBJECT_REQUIRED");
      expect(issued.statusCode).toBe(400);
    }
  });
});

describe("EN-D2 · sandbox is validated at the WRITE", () => {
  /** POST /use-cases as the seeded PlatformAdmin. */
  const create = (h: TestAppHandle, token: string, over: Record<string, unknown>) => h.app.inject({
    method: "POST", url: `${V1}/use-cases`, headers: auth(token),
    payload: { ...useCaseDef, ...over },
  });

  it("creating a live use case that names the sandbox chain is 400", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    // No `sandbox` at all — the default — reaching for the always-simulated
    // chain. Allowed, this would deploy a REAL use case's contract to an
    // in-memory ledger and hand its holders assets that do not exist.
    const res = await create(h, admin, { key: "d2-live-on-sandbox", allowedChainIds: ["fabric", SANDBOX_CHAIN_ID], defaultChainId: "fabric" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "INVALID_SANDBOX_CHAINS", details: { sandbox: false } });
    expect(res.json().message).toContain(SANDBOX_CHAIN_ID);
    expect(await h.deps.useCases.has("d2-live-on-sandbox")).toBe(false);
  });

  it("creating a sandbox use case that names besu is 400", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const res = await create(h, admin, { key: "d2-sandbox-on-besu", sandbox: true, allowedChainIds: ["besu"], defaultChainId: "besu" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "INVALID_SANDBOX_CHAINS", details: { sandbox: true, allowedChainIds: ["besu"] } });
    expect(await h.deps.useCases.has("d2-sandbox-on-besu")).toBe(false);
  });

  it("POST /use-cases cannot smuggle sandbox:true past validation", async () => {
    // THE HOLE D2-2 LEFT OPEN, ON PURPOSE, FOR D2-4 TO CLOSE.
    // `normalizeUseCaseDefinition` spreads the request body, so `sandbox`
    // reached the repository untouched — no validator ever looked at it. It was
    // harmless only for as long as nothing READ the flag; the moment the gate
    // above started reading it, an unvalidated client-supplied boolean became
    // the whole of a tenancy decision. Enforcing at the read is not enough:
    // this is what closing it at the WRITE means.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");

    const smuggled = await create(h, admin, { key: "d2-smuggled", sandbox: true, allowedChainIds: ["fabric"], defaultChainId: "fabric" });
    expect(smuggled.statusCode).toBe(400);
    expect(smuggled.json().error).toBe("INVALID_SANDBOX_CHAINS");
    expect(await h.deps.useCases.has("d2-smuggled")).toBe(false);

    // And the mirror: the HONEST combination is accepted and persists the flag.
    // Without this the test above would also pass against an implementation
    // that simply refused every `sandbox: true` — proving a bug, not a rule.
    const honest = await create(h, admin, { key: "d2-honest", sandbox: true, allowedChainIds: [SANDBOX_CHAIN_ID], defaultChainId: SANDBOX_CHAIN_ID });
    expect(honest.statusCode).toBe(201);
    expect(honest.json().sandbox).toBe(true);
    expect((await h.deps.useCases.get("d2-honest")).sandbox).toBe(true);
  });

  it("changing sandbox on an existing use case is 409 SANDBOX_IMMUTABLE", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(h, "d2-immutable", true);

    const flipped = await h.app.inject({
      method: "PUT", url: `${V1}/use-cases/d2-immutable`, headers: auth(admin),
      payload: { ...useCaseDef, key: "d2-immutable", sandbox: false, allowedChainIds: ["fabric"], defaultChainId: "fabric" },
    });
    expect(flipped.statusCode).toBe(409);
    expect(flipped.json()).toMatchObject({ error: "SANDBOX_IMMUTABLE", details: { key: "d2-immutable", sandbox: true } });
    // The message must point somewhere: "no" without a next step is how an
    // integrator ends up deleting and recreating a programme by hand.
    expect(flipped.json().message).toContain("clone-to-live");
    expect((await h.deps.useCases.get("d2-immutable")).sandbox).toBe(true);

    // An UNCHANGED flag is not a change — the update goes through. Every
    // pre-EN-D2 client round-trips a definition without the field at all, and
    // an omitted flag must neither 409 nor silently clear the stored one.
    const renamed = await h.app.inject({
      method: "PUT", url: `${V1}/use-cases/d2-immutable`, headers: auth(admin),
      payload: { ...useCaseDef, key: "d2-immutable", name: "Renamed", allowedChainIds: [SANDBOX_CHAIN_ID], defaultChainId: SANDBOX_CHAIN_ID },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Renamed", sandbox: true });

    // The credential domain has the same rule and the same 409.
    await h.deps.credentialUseCases.create({ ...credentialUseCaseDef, key: "d2-cred-immutable", sandbox: true });
    const cred = await h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/d2-cred-immutable`, headers: auth(admin),
      payload: { ...credentialUseCaseDef, key: "d2-cred-immutable", sandbox: false },
    });
    expect(cred.statusCode).toBe(409);
    expect(cred.json().error).toBe("SANDBOX_IMMUTABLE");
    expect((await h.deps.credentialUseCases.get("d2-cred-immutable"))?.sandbox).toBe(true);
  });
});
