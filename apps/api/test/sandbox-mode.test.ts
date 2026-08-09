import { MockLedgerAdapter } from "@tokenlayer/adapters";
import { SANDBOX_CHAIN_ID, type CredentialUseCaseDefinition, type ResourceMode, type UseCaseDefinition } from "@tokenlayer/core";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { KEY_PREFIX_MARKERS, mintSecret, prefixOf } from "../src/api-keys.js";
import { buildChainRegistry } from "../src/chains.js";
import { emitEvent, type EmitInput } from "../src/events.js";
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
  return { h, orgId, orgAdmin: token, liveKey: liveKey.secret, testKey: testKey.secret };
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

// ---------------------------------------------------------------------------
// Task D2-5 — EVENTS AND WEBHOOK DELIVERY.
//
// The accident this whole block exists to prevent: a SANDBOX issuance arriving
// at a PRODUCTION webhook handler and being processed as a real credential.
// That is why the design rejected "one endpoint, filter on a `mode` field" —
// it puts the burden on every consumer to remember a check, and forgetting it
// is silent. Isolation is structural instead: a test event has no route to a
// live endpoint at all.
//
// Two properties carry it, and they are tested separately because they fail
// separately. (1) `Event.mode` is DERIVED inside `emitEvent` from the acting
// use case, so no call site can mislabel one. (2) `endpointMatches` compares
// modes for EQUALITY, so a mislabelled subscription cannot bridge them either.
// ---------------------------------------------------------------------------

/** Swallows the deliberate console.error in the unresolvable-use-case cases. */
const quiet = { error: () => {} };

/** A publicly routable literal — no DNS, and not in any blocked range. */
const HOOK = "https://203.0.113.10/hooks";

/** An endpoint straight into the repo, in one mode or the other. */
function seedEndpoint(h: TestAppHandle, opts: { orgId: string | null; mode: ResourceMode }) {
  return h.deps.webhookEndpoints.create({
    orgId: opts.orgId, url: HOOK, description: null, eventTypes: ["*"],
    useCaseKey: null, secretEncrypted: "cipher", createdBy: "test", mode: opts.mode,
  });
}

/** How many deliveries this endpoint was handed. */
const deliveries = async (h: TestAppHandle, endpointId: string) =>
  (await h.deps.webhookDeliveries.listByEndpoint(endpointId, 50)).length;

/** The most recently appended event row — the STORED fact, not the input. */
const lastEvent = async (h: TestAppHandle) =>
  (await h.deps.events.listAfter(0, { limit: 500 })).at(-1);

/** A service user + API key BOUND TO `orgId`, in one mode or the other. */
async function seedOrgKey(h: TestAppHandle, orgId: string, mode: ResourceMode, scopes: string[] = ["*"]): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 10);
  const svc = await h.users.create({
    email: `svc-d2org-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`unguessable-${tag}`, TEST_ROUNDS),
    role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved",
    kyc: null, orgId, kind: "service",
  });
  const minted = await mintSecret(TEST_ROUNDS, mode);
  await h.apiKeys.create({
    orgId, userId: svc.id, name: `key ${tag}`, prefix: minted.prefix, secretHash: minted.hash,
    scopes, expiresAt: null, createdBy: "test", mode,
  });
  return minted.secret;
}

/** One emit, with everything but the use-case key held constant. */
const emitOn = (h: TestAppHandle, orgId: string | null, useCaseKey: string | null, extra: Record<string, unknown> = {}) =>
  emitEvent(h.deps, { type: "asset.issued", orgId, useCaseKey, subjectId: "subj1", data: {}, ...extra } as EmitInput, quiet);

describe("EN-D2 · Event.mode is derived, never supplied", () => {
  it("an event carries the mode of the use case that produced it", async () => {
    const w = await modeWorld();

    // The tokenization domain, both ways round.
    await emitOn(w.h, w.orgId, "d2-test-tok");
    expect((await lastEvent(w.h))?.mode).toBe("test");
    await emitOn(w.h, w.orgId, "d2-live-tok");
    expect((await lastEvent(w.h))?.mode).toBe("live");

    // AND the credential domain. A use-case key is unique across both, and an
    // implementation that consulted only `deps.useCases` would label every
    // sandbox credential event "live" — which is the exact failure this task
    // exists to prevent, arriving through the domain that issues credentials.
    await emitOn(w.h, w.orgId, "d2-test-kyc", { type: "credential.issued" });
    expect((await lastEvent(w.h))?.mode).toBe("test");
    await emitOn(w.h, w.orgId, "d2-live-kyc", { type: "credential.issued" });
    expect((await lastEvent(w.h))?.mode).toBe("live");
  });

  it("a caller CANNOT set an event's mode", async () => {
    // Proved on the STORED ROW, deliberately. A type-level argument is worth
    // nothing here: no test directory in this repo is typechecked, so a cast
    // compiles silently and a `@ts-expect-error` is inert. The only evidence
    // that survives is what the outbox actually holds.
    const w = await modeWorld();

    // A live use case, with `mode: "test"` smuggled in. This is the direction
    // that would matter least; do it anyway, because the rule is that the field
    // is IGNORED, not that it is clamped one way.
    await emitOn(w.h, w.orgId, "d2-live-tok", { mode: "test" });
    expect((await lastEvent(w.h))?.mode).toBe("live");

    // THE DANGEROUS DIRECTION: a sandbox use case relabelled live. If a caller
    // could do this, one sloppy emit site turns a sandbox fact into a real one
    // and hands it to the production handler.
    const liveEp = await seedEndpoint(w.h, { orgId: w.orgId, mode: "live" });
    const testEp = await seedEndpoint(w.h, { orgId: w.orgId, mode: "test" });
    await emitOn(w.h, w.orgId, "d2-test-tok", { mode: "live" });
    expect((await lastEvent(w.h))?.mode).toBe("test");
    // …and the DELIVERY follows the derived mode, not the claimed one.
    expect(await deliveries(w.h, liveEp.id)).toBe(0);
    expect(await deliveries(w.h, testEp.id)).toBe(1);
  });

  it("an event with no use case follows the stated default", async () => {
    // THE STATED RULE: no use case => "live". It is the column's default and
    // the pre-EN-D2 world, so a governance event (`proposal.executed` with no
    // use-case key) behaves exactly as it did before this feature existed.
    const w = await modeWorld();
    const liveEp = await seedEndpoint(w.h, { orgId: w.orgId, mode: "live" });
    const testEp = await seedEndpoint(w.h, { orgId: w.orgId, mode: "test" });

    await emitOn(w.h, w.orgId, null, { type: "proposal.executed" });
    expect((await lastEvent(w.h))?.mode).toBe("live");

    // "" is not a use case either — it is what a legacy row stores — and it must
    // reach the same default rather than becoming a lookup for the empty key.
    await emitOn(w.h, w.orgId, "", { type: "proposal.executed" });
    expect((await lastEvent(w.h))?.mode).toBe("live");

    // A key that resolves to NOTHING (deleted, or never existed) also lands on
    // the default, and — the property that matters — does not take the emit down
    // with it: the event is still recorded and still fanned out.
    await emitOn(w.h, w.orgId, "d2-vanished-use-case");
    const vanished = await lastEvent(w.h);
    expect(vanished?.mode).toBe("live");
    expect(vanished?.useCaseKey).toBe("d2-vanished-use-case");

    expect(await deliveries(w.h, liveEp.id)).toBe(3);
    expect(await deliveries(w.h, testEp.id)).toBe(0);
  });

  it("still never throws into its caller when the use-case lookup itself fails", async () => {
    // The derivation added a REPOSITORY READ to a function whose contract is
    // that observing must not break acting. A use-case repo that is down must
    // therefore lose the label, not the event.
    const w = await modeWorld();
    w.h.deps.useCases.get = async () => { throw new Error("use-case repo is down"); };
    w.h.deps.credentialUseCases.get = async () => { throw new Error("use-case repo is down"); };

    await expect(emitOn(w.h, w.orgId, "d2-test-tok")).resolves.toBeUndefined();
    expect((await lastEvent(w.h))?.mode).toBe("live");
  });
});

describe("EN-D2 · mode-scoped webhook delivery", () => {
  it("a TEST event reaches a test endpoint and NOT a live endpoint of the same org", async () => {
    const w = await modeWorld();
    const liveEp = await seedEndpoint(w.h, { orgId: w.orgId, mode: "live" });
    const testEp = await seedEndpoint(w.h, { orgId: w.orgId, mode: "test" });

    await emitOn(w.h, w.orgId, "d2-test-tok");

    expect((await lastEvent(w.h))?.mode).toBe("test");
    expect(await deliveries(w.h, testEp.id)).toBe(1);
    // THE POINT OF THE WHOLE TASK. Same org, same `["*"]` subscription, same
    // event — and the production handler never hears about it.
    expect(await deliveries(w.h, liveEp.id)).toBe(0);
  });

  it("a LIVE event reaches a live endpoint and not a test one", async () => {
    // The mirror, and not merely for symmetry: an implementation written as
    // "keep test events out of live endpoints" (`ev.mode !== "test" || …`)
    // passes the test above and fails this one, leaving every real issuance
    // copied into the sandbox subscriber an integrator is debugging against.
    const w = await modeWorld();
    const liveEp = await seedEndpoint(w.h, { orgId: w.orgId, mode: "live" });
    const testEp = await seedEndpoint(w.h, { orgId: w.orgId, mode: "test" });

    await emitOn(w.h, w.orgId, "d2-live-tok");

    expect((await lastEvent(w.h))?.mode).toBe("live");
    expect(await deliveries(w.h, liveEp.id)).toBe(1);
    expect(await deliveries(w.h, testEp.id)).toBe(0);
  });

  it("a platform-scope endpoint still only sees its own mode", async () => {
    // MODE IS EQUALITY WHERE ORG IS A DISJUNCTION, and this is where the two
    // rules visibly differ. A platform endpoint (orgId null) legitimately spans
    // every org — so it must still receive an ORG's event — but nothing
    // legitimately spans modes, so it must not receive the other stream's.
    const w = await modeWorld();
    const platformLive = await seedEndpoint(w.h, { orgId: null, mode: "live" });
    const platformTest = await seedEndpoint(w.h, { orgId: null, mode: "test" });

    await emitOn(w.h, w.orgId, "d2-test-tok");
    expect(await deliveries(w.h, platformTest.id)).toBe(1);
    expect(await deliveries(w.h, platformLive.id)).toBe(0);

    await emitOn(w.h, w.orgId, "d2-live-tok");
    expect(await deliveries(w.h, platformLive.id)).toBe(1);
    expect(await deliveries(w.h, platformTest.id)).toBe(1);

    // The org disjunction is UNTOUCHED: a platform endpoint of the matching
    // mode still receives a platform-scope (orgId null) event too. Without this
    // the mode clause could have been written as something that quietly broke
    // the org rule and no assertion above would have noticed.
    await emitOn(w.h, null, "d2-live-tok");
    expect(await deliveries(w.h, platformLive.id)).toBe(2);
    expect(await deliveries(w.h, platformTest.id)).toBe(1);
  });
});

describe("EN-D2 · endpoint mode at registration", () => {
  /** POST /orgs/:id/webhooks as the org's own admin. */
  const register = (h: TestAppHandle, token: string, orgId: string, body: Record<string, unknown>) =>
    h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/webhooks`, headers: auth(token), payload: { url: HOOK, eventTypes: ["*"], ...body } });

  it("defaults to live and accepts an explicit test endpoint", async () => {
    const h = await buildTestAppWithRepos();
    const { orgId, token } = await seedOrgAdmin(h);

    // NO `mode` AT ALL — every endpoint registered before EN-D2, and every
    // client that has not heard of the field.
    const dflt = await register(h, token, orgId, {});
    expect(dflt.statusCode).toBe(201);
    expect(dflt.json().endpoint.mode).toBe("live");
    expect((await h.deps.webhookEndpoints.findById(dflt.json().endpoint.id))?.mode).toBe("live");

    const test = await register(h, token, orgId, { mode: "test" });
    expect(test.statusCode).toBe(201);
    expect(test.json().endpoint.mode).toBe("test");
    expect((await h.deps.webhookEndpoints.findById(test.json().endpoint.id))?.mode).toBe("test");

    // The READ route surfaces it too — a field that only exists in the 201 is a
    // field an integrator cannot audit afterwards.
    const list = await h.app.inject({ method: "GET", url: `${V1}/orgs/${orgId}/webhooks`, headers: auth(token) });
    expect(list.json().endpoints.map((e: { mode: string }) => e.mode).sort()).toEqual(["live", "test"]);

    // A third value is not a mode. Refused by the schema, so nothing is stored.
    const bogus = await register(h, token, orgId, { mode: "staging" });
    expect(bogus.statusCode).toBe(400);
  });

  it("an endpoint cannot be MOVED between streams afterwards", async () => {
    // The secret and the delivery history would follow it across the boundary,
    // so `mode` is deliberately absent from the update patch AND from the
    // repository's patch type — a re-point, not a re-registration, is how a live
    // handler would inherit a sandbox history.
    //
    // The PATCH is a 200, not a 400: fastify's ajv runs with `removeAdditional`,
    // so an undeclared `mode` is STRIPPED before the handler sees it. That makes
    // "the stored row did not move" the only assertion worth anything here — a
    // status code would have been satisfied by a route that accepted the field
    // and applied it.
    const h = await buildTestAppWithRepos();
    const { orgId, token } = await seedOrgAdmin(h);
    const whId = (await register(h, token, orgId, { mode: "test" })).json().endpoint.id as string;

    const moved = await h.app.inject({
      method: "PATCH", url: `${V1}/orgs/${orgId}/webhooks/${whId}`, headers: auth(token),
      payload: { mode: "live", description: "still test" },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().endpoint).toMatchObject({ description: "still test", mode: "test" });
    expect((await h.deps.webhookEndpoints.findById(whId))?.mode).toBe("test");
  });

  it("a tl_test_ key may not register a LIVE endpoint, and a tl_live_ key may not register a test one", async () => {
    // FOUND WHILE WIRING THIS UP, and closed here. Endpoint mode is not a use
    // case, so `modeGate` never sees this route: without a check, a sandbox key
    // holding `webhooks:write` could register a LIVE endpoint and start
    // receiving production events — the very crossing D2-4 refuses everywhere
    // else. `modeAllows` is the same predicate, so a human session (no mode)
    // still registers either, which is what makes the sandbox configurable.
    const h = await buildTestAppWithRepos();
    const { orgId } = await seedOrgAdmin(h);
    const testKey = await seedOrgKey(h, orgId, "test");
    const liveKey = await seedOrgKey(h, orgId, "live");

    // The default is still "live", so a test key that says nothing is refused
    // rather than quietly handed a production subscription.
    const implicit = await register(h, testKey, orgId, {});
    expect(implicit.statusCode).toBe(403);
    expect(implicit.json()).toMatchObject({ error: "WRONG_MODE", details: { keyMode: "test", endpointMode: "live" } });

    const explicit = await register(h, liveKey, orgId, { mode: "test" });
    expect(explicit.statusCode).toBe(403);
    expect(explicit.json().error).toBe("WRONG_MODE");

    // THE CONTROL: each key succeeds on its own side, so the two refusals above
    // are about mode and not about a key that could do nothing at all.
    expect((await register(h, testKey, orgId, { mode: "test" })).json().endpoint.mode).toBe("test");
    expect((await register(h, liveKey, orgId, { mode: "live" })).json().endpoint.mode).toBe("live");
    expect((await h.deps.webhookEndpoints.listByOrg(orgId))).toHaveLength(2);
  });
});

describe("EN-D2 · the event cursor is mode-scoped too", () => {
  it("a tl_test_ key reads ONLY sandbox events, and a tl_live_ key only real ones", async () => {
    // FOUND WHILE WIRING THE EMIT PATH, and closed here. `GET /events` is the
    // documented catch-up route for a missed delivery — so isolating DELIVERY
    // and leaving the cursor open would have left the same crossing reachable
    // with a sandbox credential and one GET: the full payload of every LIVE
    // event the org ever produced, handed to a `tl_test_` key.
    const w = await modeWorld();
    const testKey = await seedOrgKey(w.h, w.orgId, "test", ["webhooks:read"]);
    const liveKey = await seedOrgKey(w.h, w.orgId, "live", ["webhooks:read"]);

    await emitOn(w.h, w.orgId, "d2-live-tok", { subjectId: "live-asset" });
    await emitOn(w.h, w.orgId, "d2-test-tok", { subjectId: "test-asset" });
    await emitOn(w.h, w.orgId, null, { type: "proposal.executed", subjectId: "governance" });

    const read = async (cred: string) =>
      (await w.h.app.inject({ method: "GET", url: `${V1}/events`, headers: auth(cred) })).json();

    const asTest = await read(testKey);
    expect(asTest.events.map((e: { subjectId: string }) => e.subjectId)).toEqual(["test-asset"]);
    // Not merely absent from the list — absent from the RAW TEXT. A payload
    // nested one level deeper than the assertion looked is how this leak comes
    // back.
    const rawTest = await w.h.app.inject({ method: "GET", url: `${V1}/events`, headers: auth(testKey) });
    expect(rawTest.payload).not.toContain("live-asset");

    // The live key sees the live event AND the use-case-less governance one,
    // which follows the stated default — so the sandbox key's page above is a
    // narrowing, not an empty log.
    const asLive = await read(liveKey);
    expect(asLive.events.map((e: { subjectId: string }) => e.subjectId)).toEqual(["live-asset", "governance"]);

    // The HUMAN, who has no mode, still reads both — the same asymmetry as the
    // gate, and the reason an OrgAdmin can inspect their own sandbox.
    const asHuman = (await w.h.app.inject({ method: "GET", url: `${V1}/events`, headers: auth(w.orgAdmin) })).json();
    expect(asHuman.events).toHaveLength(3);
    // …and `mode` survives the serializer. fast-json-stringify SILENTLY STRIPS
    // an undeclared field, so a fact that cannot say which environment it came
    // from is one schema omission away at all times.
    expect(asHuman.events.map((e: { mode: string }) => e.mode)).toEqual(["live", "test", "live"]);

    // THE CURSOR CONTRACT SURVIVES THE NARROWING: `nextAfter` still comes from
    // rows the caller was actually shown, so the documented `after = nextAfter`
    // loop neither re-reads nor skips. A post-fetch filter would have broken
    // exactly this.
    expect(asTest.nextAfter).toBe(asTest.events.at(-1).seq);
    const nothingNew = await w.h.app.inject({ method: "GET", url: `${V1}/events?after=${asTest.nextAfter}`, headers: auth(testKey) });
    expect(nothingNew.json()).toEqual({ events: [], nextAfter: asTest.nextAfter });
  });
});
