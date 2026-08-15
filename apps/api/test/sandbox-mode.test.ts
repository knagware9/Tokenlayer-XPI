import { MockLedgerAdapter } from "@tokenlayer/adapters";
import { SANDBOX_CHAIN_ID, type CredentialUseCaseDefinition, type ResourceMode, type UseCaseDefinition } from "@tokenlayer/core";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { KEY_PREFIX_MARKERS, mintSecret, prefixOf } from "../src/shared/api-keys.js";
import { buildChainRegistry } from "../src/shared/chains.js";
import { emitEvent, type EmitInput } from "../src/shared/events.js";
import {
  MemoryApiKeyRepository,
  MemoryCredentialUseCaseRepository,
  MemoryEventRepository,
  MemoryUseCaseRepository,
  MemoryWebhookEndpointRepository,
} from "../src/persistence/memory/index.js";
import {
  rowToApiKey,
  rowToCredentialUseCase,
  rowToEvent,
  rowToUseCase,
  rowToWebhookEndpoint,
} from "../src/persistence/prisma/index.js";
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
    brandLogoDocumentId: null, brandAccent: null,
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

// ---------------------------------------------------------------------------
// Task D2-6 — THE WAY OUT OF THE SANDBOX, AND KEEPING SANDBOX OUT OF THE
// NUMBERS.
//
// Two halves of one idea. `sandbox` is immutable (D2-4), so a programme built
// and debugged in the sandbox needs a supported way to become real: that is
// clone-to-live, and its whole value rests on copying CONFIGURATION and
// nothing else — a clone that dragged along the assets an integrator minted
// while learning the API would put invented invoices into a real register.
//
// The other half is the reporting default. A sandbox asset counted in a
// customer's headline supply figure is a defect that nobody notices, because
// the number still looks like a number. So sandbox is out of the numbers
// unless somebody asks for it by name.
// ---------------------------------------------------------------------------

/** A seeded demo wallet, used as the treasury an initial supply mints into. */
const CLONE_TREASURY = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

/**
 * Every configuration field a clone must carry across, each set to a NON-DEFAULT
 * value. A test built on the defaults would pass against a clone that copied
 * nothing at all and simply re-derived them.
 */
const CLONE_CONFIG = {
  description: "the source programme",
  tokenStandard: "ERC-20" as const,
  tokenType: "fungible" as const,
  symbol: "CLN",
  metadataSchema: {
    type: "object" as const,
    properties: { ref: { type: "string" }, amount: { type: "number" } },
    required: ["ref"],
  },
  lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
  compliance: { allowlist: false, transferRestrictions: false, maxHolders: 25, lockupDays: 7 },
  fees: { marketplaceBps: 125, issuanceFlat: "500" },
  saleTermsDefault: { unitPrice: "1000", currency: "INR" },
  valuation: { metadataField: "amount", currency: "INR" },
  uniqueBy: "ref",
  workflow: { approvals: { burn: 2 } },
  roles: ["Issuer", "Trader"] as const,
};

/** POST /use-cases, with the sandbox/live pair chosen by `sandbox`. */
async function createUseCaseOverHttp(h: TestAppHandle, token: string, key: string, sandbox: boolean, over: Record<string, unknown> = {}) {
  const chain = sandbox ? SANDBOX_CHAIN_ID : "fabric";
  const res = await h.app.inject({
    method: "POST", url: `${V1}/use-cases`, headers: auth(token),
    payload: {
      ...useCaseDef, ...CLONE_CONFIG, key, name: key, sandbox,
      allowedChainIds: [chain], defaultChainId: chain, ...over,
    },
  });
  return res;
}

/** Mint one asset with a live initial supply into the seeded treasury. */
const issueAsset = (h: TestAppHandle, token: string, useCaseKey: string, chainId: string, ref: string) => h.app.inject({
  method: "POST", url: `${V1}/assets`, headers: auth(token),
  payload: {
    useCaseKey, name: `asset ${ref}`, chainId,
    metadata: { ref, amount: 1000 },
    treasuryAccount: CLONE_TREASURY, initialSupply: "100",
  },
});

describe("EN-D2 · clone to live", () => {
  it("clone-to-live copies CONFIGURATION and provably no data", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");

    const src = await createUseCaseOverHttp(h, admin, "d2-clone-src", true);
    expect(src.statusCode).toBe(201);
    expect(src.json()).toMatchObject({ sandbox: true, contracts: { [SANDBOX_CHAIN_ID]: expect.anything() } });

    // ISSUE FIRST, so "no data came with it" is a real assertion rather than a
    // vacuous one. A clone of an EMPTY use case has no assets either way.
    const asset = await issueAsset(h, admin, "d2-clone-src", SANDBOX_CHAIN_ID, "SRC-1");
    expect(asset.statusCode).toBe(201);
    // …and a staged invoice row too: the register is a second store keyed by
    // use case, and a clone that copied one and not the other is still a clone
    // that carried data across.
    await h.deps.stagedInvoices.create({
      useCaseKey: "d2-clone-src", status: "staged", metadata: { invoiceNumber: "SRC-1" },
      invoiceHash: "0xsrc1", source: "manual", documentId: null, documentSha256: null,
      assetId: null, tokenizedAt: null, createdBy: "test",
    });

    const cloned = await h.app.inject({
      method: "POST", url: `${V1}/use-cases/d2-clone-src/clone-to-live`, headers: auth(admin),
      payload: { allowedChainIds: ["fabric"], defaultChainId: "fabric" },
    });
    expect(cloned.statusCode).toBe(201);
    const clone = cloned.json();

    // --- the key, said out loud in the response ---------------------------
    expect(clone.key).toBe("d2-clone-src-live");
    expect(clone.sandbox).toBe(false);

    // --- CONFIGURATION came across, field for field -----------------------
    const stored = await h.deps.useCases.get("d2-clone-src-live");
    for (const [field, value] of Object.entries(CLONE_CONFIG)) {
      expect(clone[field], `${field} on the wire`).toEqual(value);
      expect((stored as unknown as Record<string, unknown>)[field], `${field} in the store`).toEqual(value);
    }

    // --- the CHAINS did not: contracts are redeployed against the real one --
    expect(clone.allowedChainIds).toEqual(["fabric"]);
    expect(clone.defaultChainId).toBe("fabric");
    expect(Object.keys(clone.contracts)).toEqual(["fabric"]);
    expect(clone.contracts[SANDBOX_CHAIN_ID]).toBeUndefined();
    // A DISTINCT deployment, not the sandbox contract relabelled. The field is
    // `contractRef` (see UseCaseContract) — an earlier draft asserted on
    // `.address`, which exists on neither side, so `undefined !== undefined`
    // was the only thing being compared.
    expect(clone.contracts.fabric.contractRef).toBeTruthy();
    expect(src.json().contracts[SANDBOX_CHAIN_ID].contractRef).toBeTruthy();
    expect(clone.contracts.fabric.contractRef).not.toBe(src.json().contracts[SANDBOX_CHAIN_ID].contractRef);

    // --- and PROVABLY no data ---------------------------------------------
    const assetsOf = async (key: string) =>
      (await h.app.inject({ method: "GET", url: `${V1}/assets?useCaseKey=${key}`, headers: auth(admin) })).json().data;
    expect(await assetsOf("d2-clone-src-live")).toHaveLength(0);
    // The control: the SOURCE still holds everything, so the emptiness above is
    // a clone that copied nothing rather than a query that found nothing.
    expect(await assetsOf("d2-clone-src")).toHaveLength(1);
    expect(await h.deps.stagedInvoices.listByUseCase("d2-clone-src-live")).toHaveLength(0);
    expect(await h.deps.stagedInvoices.listByUseCase("d2-clone-src")).toHaveLength(1);
    expect(await h.deps.proposals.list("d2-clone-src-live")).toHaveLength(0);
    expect((await h.deps.credentials.list()).filter((c) => c.credentialUseCaseKey === "d2-clone-src-live")).toHaveLength(0);
  });

  it("returns 202 with a proposal for an OrgAdmin, like POST /use-cases", async () => {
    // Cloning creates a LIVE use case. Giving that act a different name must
    // not become a way around the maker-checker the platform already applies
    // to creating one.
    const h = await buildTestAppWithRepos();
    const { orgId, token } = await seedOrgAdmin(h);
    await h.deps.useCases.create({
      ...useCaseDef, ...CLONE_CONFIG, key: "d2-org-src", name: "d2-org-src", sandbox: true,
      ownerOrgId: orgId, allowedChainIds: [SANDBOX_CHAIN_ID], defaultChainId: SANDBOX_CHAIN_ID,
    });

    const res = await h.app.inject({
      method: "POST", url: `${V1}/use-cases/d2-org-src/clone-to-live`, headers: auth(token),
      payload: { allowedChainIds: ["fabric"], defaultChainId: "fabric" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().key).toBe("d2-org-src-live");
    expect(res.json().proposal).toMatchObject({ kind: "create-use-case", status: "pending", orgId });
    // The proposal's payload is the LIVE definition — the flag and the chains
    // are decided at propose time, not left for the approver to get right.
    expect(res.json().proposal.payload).toMatchObject({ key: "d2-org-src-live", sandbox: false, allowedChainIds: ["fabric"], ownerOrgId: orgId });

    // NOTHING exists yet. A 202 that had already created the use case would be
    // maker-checker in name only.
    expect(await h.deps.useCases.has("d2-org-src-live")).toBe(false);

    // …and a PlatformAdmin still gets the direct 201, exactly as POST /use-cases
    // gives one. Two policies for one act is how the two drift apart.
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const direct = await h.app.inject({
      method: "POST", url: `${V1}/use-cases/d2-org-src/clone-to-live`, headers: auth(admin),
      payload: { key: "d2-org-src-direct", allowedChainIds: ["fabric"], defaultChainId: "fabric" },
    });
    expect(direct.statusCode).toBe(201);
    expect(direct.json().key).toBe("d2-org-src-direct");
    expect(await h.deps.useCases.has("d2-org-src-direct")).toBe(true);
  });

  it("refuses to clone a use case that is not sandbox", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    expect((await createUseCaseOverHttp(h, admin, "d2-already-live", false)).statusCode).toBe(201);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/use-cases/d2-already-live/clone-to-live`, headers: auth(admin),
      payload: { allowedChainIds: ["fabric"], defaultChainId: "fabric" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("NOT_SANDBOX");
    expect(await h.deps.useCases.has("d2-already-live-live")).toBe(false);

    // The credential domain answers the same way, for the same reason.
    await h.deps.credentialUseCases.create({ ...credentialUseCaseDef, key: "d2-cred-already-live", sandbox: false });
    const cred = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/d2-cred-already-live/clone-to-live`, headers: auth(admin), payload: {},
    });
    expect(cred.statusCode).toBe(400);
    expect(cred.json().error).toBe("NOT_SANDBOX");
  });

  it("a live use case may not be cloned onto the sandbox chain, and the new key must be free", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await createUseCaseOverHttp(h, admin, "d2-clone-rules", true);

    // The clone is LIVE, so the chain rule applies to it in the live direction
    // — naming the always-simulated chain is the forgery D2-4 refuses at every
    // other write.
    const onSandbox = await h.app.inject({
      method: "POST", url: `${V1}/use-cases/d2-clone-rules/clone-to-live`, headers: auth(admin),
      payload: { allowedChainIds: [SANDBOX_CHAIN_ID], defaultChainId: SANDBOX_CHAIN_ID },
    });
    expect(onSandbox.statusCode).toBe(400);
    expect(onSandbox.json()).toMatchObject({ error: "INVALID_SANDBOX_CHAINS", details: { sandbox: false } });

    // A key already taken — in EITHER domain, because a slug is unique across both.
    await h.deps.credentialUseCases.create({ ...credentialUseCaseDef, key: "d2-taken-slug" });
    const taken = await h.app.inject({
      method: "POST", url: `${V1}/use-cases/d2-clone-rules/clone-to-live`, headers: auth(admin),
      payload: { key: "d2-taken-slug", allowedChainIds: ["fabric"], defaultChainId: "fabric" },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("KEY_TAKEN");
  });

  it("the clone is live: a tl_test_ key is refused on it, a tl_live_ key is not", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await createUseCaseOverHttp(h, admin, "d2-clone-modes", true);
    const testKey = (await seedKey(h, { mode: "test" })).secret;
    const liveKey = (await seedKey(h, { mode: "live" })).secret;

    const cloned = await h.app.inject({
      method: "POST", url: `${V1}/use-cases/d2-clone-modes/clone-to-live`, headers: auth(admin),
      payload: { allowedChainIds: ["fabric"], defaultChainId: "fabric" },
    });
    expect(cloned.statusCode).toBe(201);

    const read = (cred: string, key: string) =>
      h.app.inject({ method: "GET", url: `${V1}/use-cases/${key}`, headers: auth(cred) });

    // The clone is a LIVE use case in every sense the gate cares about.
    expect((await read(testKey, "d2-clone-modes-live")).statusCode).toBe(403);
    expect((await read(testKey, "d2-clone-modes-live")).json().error).toBe("WRONG_MODE");
    expect((await read(liveKey, "d2-clone-modes-live")).statusCode).toBe(200);
    // …and the SOURCE is still the sandbox's, the other way round.
    expect((await read(liveKey, "d2-clone-modes")).statusCode).toBe(403);
    expect((await read(testKey, "d2-clone-modes")).statusCode).toBe(200);

    // CLONING ITSELF SPANS BOTH ENVIRONMENTS, so no key can perform it: a test
    // key is refused on the live thing it would create, a live key on the
    // sandbox thing it would read. Only a principal with no mode — a human
    // session — sits on both sides, which is the same asymmetry the gate has
    // everywhere else.
    for (const cred of [testKey, liveKey]) {
      const res = await h.app.inject({
        method: "POST", url: `${V1}/use-cases/d2-clone-modes/clone-to-live`, headers: auth(cred),
        payload: { key: `d2-by-key-${cred.slice(-4)}`, allowedChainIds: ["fabric"], defaultChainId: "fabric" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("WRONG_MODE");
    }
    expect((await h.deps.useCases.list()).filter((u) => u.key.startsWith("d2-by-key-"))).toHaveLength(0);
  });

  it("the credential-use-case clone copies configuration and no credentials", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const { orgId } = await seedOrgAdmin(h);
    await seedCredentialUseCase(h, "d2-cred-clone-src", true, orgId);
    // A credential ON the sandbox programme, so "no credentials came with it"
    // is a claim about a non-empty source.
    const issued = await issueOn(h, "d2-cred-clone-src", admin);
    expect(issued.statusCode).toBe(400); // SUBJECT_REQUIRED — see below
    await h.deps.credentials.create({
      subjectDid: "did:key:zHolder", type: "KycCredential", claims: {}, issuerDid: "did:key:zIssuer",
      vcJwt: "jwt", status: "active", credentialUseCaseKey: "d2-cred-clone-src", issuedBy: "test",
      expiresAt: null, revokedAt: null, revokedBy: null, anchorTxHash: null, anchorChainId: null,
    } as never);

    const cloned = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/d2-cred-clone-src/clone-to-live`, headers: auth(admin), payload: {},
    });
    expect(cloned.statusCode).toBe(201);
    expect(cloned.json()).toMatchObject({ key: "d2-cred-clone-src-live", sandbox: false });
    expect(cloned.json().credentialTypes).toEqual(credentialUseCaseDef.credentialTypes);
    expect(cloned.json().issuer).toEqual({ kind: "org", orgId });

    const all = await h.deps.credentials.list();
    expect(all.filter((c) => c.credentialUseCaseKey === "d2-cred-clone-src-live")).toHaveLength(0);
    expect(all.filter((c) => c.credentialUseCaseKey === "d2-cred-clone-src")).toHaveLength(1);
  });
});

describe("EN-D2 · sandbox is out of the numbers", () => {
  it("a sandbox asset is absent from analytics by default and present with includeSandbox=true", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await createUseCaseOverHttp(h, admin, "d2-num-live", false);
    await createUseCaseOverHttp(h, admin, "d2-num-sandbox", true);
    expect((await issueAsset(h, admin, "d2-num-live", "fabric", "LIVE-1")).statusCode).toBe(201);
    expect((await issueAsset(h, admin, "d2-num-sandbox", SANDBOX_CHAIN_ID, "SBX-1")).statusCode).toBe(201);

    const analytics = async (query = "") =>
      (await h.app.inject({ method: "GET", url: `${V1}/analytics${query}`, headers: auth(admin) })).json();

    const dflt = await analytics();
    expect(dflt.byUseCase.map((r: { useCaseKey: string }) => r.useCaseKey)).toEqual(["d2-num-live"]);
    expect(dflt.byLedger.map((r: { chainId: string }) => r.chainId)).toEqual(["fabric"]);
    expect(dflt.totals.assets).toBe(1);
    expect(dflt.totals.supply).toBe("100");
    // The headline VALUE figure is the one that matters most: an invented
    // invoice inflating a customer's tokenized total is the reporting defect.
    expect(dflt.totals.valueByCurrency).toEqual({ INR: "1000" });

    const opted = await analytics("?includeSandbox=true");
    expect(opted.byUseCase.map((r: { useCaseKey: string }) => r.useCaseKey)).toEqual(["d2-num-live", "d2-num-sandbox"]);
    expect(opted.totals.assets).toBe(2);
    expect(opted.totals.supply).toBe("200");
    expect(opted.totals.valueByCurrency).toEqual({ INR: "2000" });
    expect(opted.byLedger.map((r: { chainId: string }) => r.chainId)).toEqual(["fabric", SANDBOX_CHAIN_ID]);
  });

  it("the register excludes sandbox rows by default", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    // The seeded invoice programme, in both environments.
    const invoiceDef = await h.deps.useCases.get("invoice-tokenization");
    await h.deps.useCases.create({
      ...invoiceDef, key: "d2-reg-sandbox", name: "d2-reg-sandbox", sandbox: true,
      allowedChainIds: [SANDBOX_CHAIN_ID], defaultChainId: SANDBOX_CHAIN_ID, contracts: {},
    });
    const row = { invoiceNumber: "REG-D2", invoiceDate: "2026-07-05", buyerName: "JSW Steel", currency: "INR", amount: 1800000, dueDate: "2026-10-15" };
    const stage = (key: string, invoiceNumber: string) => h.app.inject({
      method: "POST", url: `${V1}/use-cases/${key}/invoices`, headers: auth(admin),
      payload: { metadata: { ...row, invoiceNumber } },
    });
    expect((await stage("d2-reg-sandbox", "SBX-REG")).statusCode).toBe(201);
    expect((await stage("invoice-tokenization", "LIVE-REG")).statusCode).toBe(201);

    const list = async (key: string, query = "") =>
      (await h.app.inject({ method: "GET", url: `${V1}/use-cases/${key}/invoices${query}`, headers: auth(admin) })).json();

    expect(await list("d2-reg-sandbox")).toHaveLength(0);
    expect(await list("d2-reg-sandbox", "?includeSandbox=true")).toHaveLength(1);
    // THE CONTROL: the live register is untouched by the default. A filter that
    // emptied every register would satisfy the assertion above.
    expect(await list("invoice-tokenization")).toHaveLength(1);
    expect(await list("invoice-tokenization", "?includeSandbox=true")).toHaveLength(1);
  });

  it("the identity dashboard leaves sandbox programmes out by default", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const { orgId } = await seedOrgAdmin(h);
    await seedCredentialUseCase(h, "d2-dash-live", false, orgId);
    await seedCredentialUseCase(h, "d2-dash-sandbox", true, orgId);

    const dash = async (query = "") =>
      (await h.app.inject({ method: "GET", url: `${V1}/identity/dashboard${query}`, headers: auth(admin) })).json();

    const keysOf = (d: { byUseCase?: { key: string }[] }) => (d.byUseCase ?? []).map((u) => u.key);
    expect(keysOf(await dash())).not.toContain("d2-dash-sandbox");
    expect(keysOf(await dash())).toContain("d2-dash-live");
    expect(keysOf(await dash("?includeSandbox=true"))).toContain("d2-dash-sandbox");
  });

  it("a machine principal's use-case catalog holds only its own environment", async () => {
    // The list projections `mode-coverage.test.ts` left exempt. Gating a list
    // per row would 403 the whole page because one row is in the other
    // environment; the right answer is to filter, and this is the filter.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const { orgId } = await seedOrgAdmin(h);
    await createUseCaseOverHttp(h, admin, "d2-cat-live", false);
    await createUseCaseOverHttp(h, admin, "d2-cat-sandbox", true);
    await seedCredentialUseCase(h, "d2-catc-live", false, orgId);
    await seedCredentialUseCase(h, "d2-catc-sandbox", true, orgId);
    const testKey = (await seedKey(h, { mode: "test" })).secret;
    const liveKey = (await seedKey(h, { mode: "live" })).secret;

    const keys = async (path: string, cred: string) =>
      ((await h.app.inject({ method: "GET", url: `${V1}/${path}`, headers: auth(cred) })).json() as { key: string }[]).map((u) => u.key);

    expect(await keys("use-cases", testKey)).toEqual(["d2-cat-sandbox"]);
    expect(await keys("use-cases", liveKey)).toContain("d2-cat-live");
    expect(await keys("use-cases", liveKey)).not.toContain("d2-cat-sandbox");
    expect(await keys("credential-use-cases", testKey)).toEqual(["d2-catc-sandbox"]);
    expect(await keys("credential-use-cases", liveKey)).toEqual(["d2-catc-live"]);

    // The human still sees both — they are labelled in the UI, not hidden, and
    // an OrgAdmin who could not see their own sandbox could not configure it.
    expect(await keys("use-cases", admin)).toEqual(expect.arrayContaining(["d2-cat-live", "d2-cat-sandbox"]));
    expect(await keys("credential-use-cases", admin)).toEqual(expect.arrayContaining(["d2-catc-live", "d2-catc-sandbox"]));
  });

  it("a machine principal's ASSET list holds only its own environment", async () => {
    // THE CROSSING FOUND WHILE WIRING D2-6. `GET /assets` resolves no use case
    // at all, so `mode-coverage.test.ts` never considered it — and for a
    // PlatformAdmin principal it selects across EVERY use case. A `tl_test_`
    // key would have read the entire live register with one GET, which is
    // precisely what D2-5 closed for `GET /events`.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await createUseCaseOverHttp(h, admin, "d2-al-live", false);
    await createUseCaseOverHttp(h, admin, "d2-al-sandbox", true);
    await issueAsset(h, admin, "d2-al-live", "fabric", "AL-LIVE");
    await issueAsset(h, admin, "d2-al-sandbox", SANDBOX_CHAIN_ID, "AL-SBX");
    const testKey = (await seedKey(h, { mode: "test" })).secret;
    const liveKey = (await seedKey(h, { mode: "live" })).secret;

    const listed = async (cred: string) => {
      const res = await h.app.inject({ method: "GET", url: `${V1}/assets`, headers: auth(cred) });
      return { keys: (res.json().data as { useCaseKey: string }[]).map((a) => a.useCaseKey), body: res.payload, total: res.json().pagination.total };
    };

    const asTest = await listed(testKey);
    expect(asTest.keys).toEqual(["d2-al-sandbox"]);
    // Not merely absent from the parsed list — absent from the raw text, and
    // absent from the PAGINATION TOTAL, which a post-fetch filter would leave
    // announcing rows the caller cannot see.
    expect(asTest.body).not.toContain("AL-LIVE");
    expect(asTest.total).toBe(1);

    const asLive = await listed(liveKey);
    expect(asLive.keys).toContain("d2-al-live");
    expect(asLive.keys).not.toContain("d2-al-sandbox");
    expect(asLive.body).not.toContain("AL-SBX");

    // The human sees both, as everywhere else.
    expect((await listed(admin)).keys).toEqual(expect.arrayContaining(["d2-al-live", "d2-al-sandbox"]));
  });
});

// ---------------------------------------------------------------------------
// THE FOURTH CROSSING, found while wiring D2-6 (D2-3 found the key marker,
// D2-4 the write-time chain rule, D2-5 the event cursor).
//
// APPROVING A PROPOSAL IS THE OPERATION. Every scoped mutating route on this
// platform answers 202 and a proposal; the mint, the deploy, the signature all
// happen on final approval, in `decide`. And `decide` resolved no use case at
// all — it loads a PROPOSAL — so `mode-coverage.test.ts` never even considered
// it, exactly as it never considered `GET /assets`.
//
// The consequence is worse than a disclosure. A `tl_test_` key holding
// `usecases:provision` could approve an OrgAdmin's pending create-use-case
// proposal for a LIVE programme — deploying real contracts on a real chain
// with a sandbox credential — and one holding `credentials:issue` could sign a
// real credential the same way. EN-B closed the SCOPE half of this same gap
// ("gating only the routes that DRAFT would gate nothing"); this is its mode
// twin, and it was still open.
// ---------------------------------------------------------------------------

describe("EN-D2 · approving a proposal is the operation, so it is gated too", () => {
  /** An OrgAdmin's pending create-use-case proposal, live or sandbox. */
  async function pendingUseCaseProposal(h: TestAppHandle, orgAdmin: string, key: string, sandbox: boolean) {
    const res = await createUseCaseOverHttp(h, orgAdmin, key, sandbox);
    expect(res.statusCode).toBe(202);
    return res.json().proposal.id as string;
  }

  const decide = (h: TestAppHandle, cred: string, id: string, verdict: "approve" | "reject" = "approve") =>
    h.app.inject({ method: "POST", url: `${V1}/proposals/${id}/${verdict}`, headers: auth(cred), payload: {} });

  it("a tl_test_ key may not approve a LIVE proposal, and a tl_live_ key may not approve a sandbox one", async () => {
    const h = await buildTestAppWithRepos();
    const { token: orgAdmin } = await seedOrgAdmin(h);
    const liveProposal = await pendingUseCaseProposal(h, orgAdmin, "d2-prop-live", false);
    const sandboxProposal = await pendingUseCaseProposal(h, orgAdmin, "d2-prop-sandbox", true);
    const testKey = (await seedKey(h, { mode: "test" })).secret;
    const liveKey = (await seedKey(h, { mode: "live" })).secret;

    // THE HOLE: a sandbox credential deploying real contracts on a real chain.
    const crossed = await decide(h, testKey, liveProposal);
    expect(crossed.statusCode).toBe(403);
    expect(crossed.json().error).toBe("WRONG_MODE");
    // Nothing was recorded and nothing ran — the refusal is BEFORE the approval
    // is written, so a refused decision cannot even consume the threshold.
    expect(await h.deps.useCases.has("d2-prop-live")).toBe(false);
    expect((await h.deps.proposals.get(liveProposal))?.status).toBe("pending");
    expect((await h.deps.proposals.get(liveProposal))?.approvals).toHaveLength(0);

    // The mirror, and REJECT as well as approve: rejecting runs compensation,
    // which is just as much a decision on the other environment's business.
    expect((await decide(h, liveKey, sandboxProposal)).statusCode).toBe(403);
    expect((await decide(h, liveKey, sandboxProposal, "reject")).statusCode).toBe(403);
    expect((await h.deps.proposals.get(sandboxProposal))?.status).toBe("pending");

    // THE CONTROLS: each key decides its OWN environment, and the whole
    // maker-checker path still works end to end. Without these the test would
    // pass against a gate that simply refused everything.
    const own = await decide(h, testKey, sandboxProposal);
    expect(own.statusCode).toBe(200);
    expect(own.json().proposal.status).toBe("executed");
    expect(await h.deps.useCases.has("d2-prop-sandbox")).toBe(true);

    const live = await decide(h, liveKey, liveProposal);
    expect(live.statusCode).toBe(200);
    expect(live.json().proposal.status).toBe("executed");
    expect(await h.deps.useCases.has("d2-prop-live")).toBe(true);
  });

  it("a proposal that names its use case only in its PAYLOAD is gated the same way", async () => {
    // `issue-usecase-credential` carries `useCaseKey: null` on the record and
    // names its programme as `credentialUseCaseKey` INSIDE the payload — so a
    // gate that read only the column would wave it straight through, which is
    // the quietest possible version of this bug.
    const h = await buildTestAppWithRepos();
    const { orgId, token: orgAdmin } = await seedOrgAdmin(h);
    await seedCredentialUseCase(h, "d2-prop-cred-sbx", true, orgId);
    const holder = await h.users.create({
      email: `holder-d2-prop@tokenlayer.dev`, passwordHash: "x", role: "Holder", useCaseKey: null,
      accountId: null, active: true, kycStatus: "approved", kyc: null, orgId, kind: "human",
      did: "did:key:zD2PropHolder", didSeedEncrypted: "enc",
    } as never);
    const drafted = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/d2-prop-cred-sbx/credentials`, headers: auth(orgAdmin),
      payload: { credentialType: "KycCredential", claims: { legalName: "Acme Ltd" }, subjectUserId: holder.id },
    });
    expect(drafted.statusCode).toBe(202);
    const id = drafted.json().proposal.id as string;
    expect((await h.deps.proposals.get(id))?.useCaseKey).toBeNull();

    const liveKey = (await seedKey(h, { mode: "live" })).secret;
    const testKey = (await seedKey(h, { mode: "test" })).secret;

    const crossed = await decide(h, liveKey, id);
    expect(crossed.statusCode).toBe(403);
    expect(crossed.json().error).toBe("WRONG_MODE");
    expect((await h.deps.proposals.get(id))?.status).toBe("pending");

    // The control: its own environment's key still signs it.
    expect((await decide(h, testKey, id)).statusCode).toBe(200);
  });

  it("a machine principal's proposal LIST holds only its own environment", async () => {
    const h = await buildTestAppWithRepos();
    const { token: orgAdmin } = await seedOrgAdmin(h);
    await pendingUseCaseProposal(h, orgAdmin, "d2-plist-live", false);
    await pendingUseCaseProposal(h, orgAdmin, "d2-plist-sandbox", true);
    const testKey = (await seedKey(h, { mode: "test" })).secret;
    const liveKey = (await seedKey(h, { mode: "live" })).secret;

    const listed = async (cred: string) => {
      const res = await h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(cred) });
      return { keys: (res.json() as { payload: { key: string } }[]).map((p) => p.payload?.key), body: res.payload };
    };

    const asTest = await listed(testKey);
    expect(asTest.keys).toEqual(["d2-plist-sandbox"]);
    expect(asTest.body).not.toContain("d2-plist-live");
    const asLive = await listed(liveKey);
    expect(asLive.keys).toEqual(["d2-plist-live"]);
    expect(asLive.body).not.toContain("d2-plist-sandbox");
    // The human decides both, so the human sees both.
    expect((await listed(orgAdmin)).keys).toEqual(expect.arrayContaining(["d2-plist-live", "d2-plist-sandbox"]));
  });
});

// ---------------------------------------------------------------------------
// Task D2-8 — A TEST KEY YOU CANNOT MINT IS NOT A FEATURE.
//
// Everything above this line assumes a `tl_test_` key exists: the marker, the
// gate, the mode-scoped event stream, the console's pills. Every one of those
// tests SEEDS one straight through the repos, because the only route that
// mints a key never learned the word. `POST /orgs/:id/api-keys` has an
// `additionalProperties: false` body, so a `mode` an integrator sends is
// DROPPED rather than refused — a 201 carrying a `tl_live_` secret in answer to
// a request for a sandbox one, which is the worst of the three possible
// outcomes (the other two being a working test key and an honest 400).
//
// The rotate route carries the same defect one step further along: it minted
// with the DEFAULT mode and never read the row's, so rotating a test key would
// stamp `tl_live_` on a row stored as `test` — and `requirePrincipal` refuses
// exactly that disagreement with a 401. The operator would be walked through
// the one-time-secret ceremony and handed a credential that is dead on
// arrival. Unreachable only while test keys cannot be minted, which is what
// the rest of this block fixes, so the two belong in one change.
// ---------------------------------------------------------------------------

/** The create route, with whatever body the caller wants to try. */
const mintKeyOverHttp = (h: TestAppHandle, cred: string, orgId: string, body: Record<string, unknown>) =>
  h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(cred), payload: body });

/** The one call every "does this credential work at all" assertion below makes. */
const meWith = (h: TestAppHandle, cred: string) =>
  h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(cred) });

/**
 * An org created THROUGH the platform rather than straight into the repo.
 *
 * `seedOrgAdmin` above fakes `didSeedEncrypted`, which is fine for everything
 * that only READS the org — but minting a key mints a member, and a member gets
 * a membership VC signed with that seed. Only a real ceremony produces one that
 * decrypts.
 */
async function keyOrg(h: TestAppHandle, admin: string): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 10);
  const res = await h.app.inject({
    method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `D2 Keys ${tag}`, orgType: "corporate" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** `seedUseCase`, but OWNED by an org — so an OrgAdmin principal can see it. */
const seedOrgUseCase = (h: TestAppHandle, orgId: string, key: string, sandbox: boolean) =>
  h.deps.useCases.create({
    ...useCaseDef, key, name: key, sandbox, ownerOrgId: orgId,
    allowedChainIds: sandbox ? [SANDBOX_CHAIN_ID] : ["fabric"],
    defaultChainId: sandbox ? SANDBOX_CHAIN_ID : "fabric",
  });

describe("EN-D2 · minting and rotating a tl_test_ key", () => {
  it("mints a test key whose secret carries tl_test_ and whose row says test", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgId = await keyOrg(h, admin);

    const res = await mintKeyOverHttp(h, admin, orgId, { name: "sandbox erp", role: "Issuer", scopes: ["assets:read"], mode: "test" });
    expect(res.statusCode).toBe(201);
    const { key, secret } = res.json() as { key: { id: string; prefix: string; mode?: string }; secret: string };

    // THE STRING, THE VIEW AND THE ROW — all three, because any two of them
    // agreeing while the third does not is precisely the failure the marker
    // check exists to catch.
    expect(secret.startsWith("tl_test_")).toBe(true);
    expect(key.prefix).toBe(secret.slice("tl_test_".length, "tl_test_".length + 8));
    expect(key.mode).toBe("test");
    expect((await h.apiKeys.findById(key.id))?.mode).toBe("test");
  });

  it("defaults to live when no mode is given — every existing caller is unaffected", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgId = await keyOrg(h, admin);

    // The pre-EN-D2 body, byte for byte: no `mode` field at all.
    const res = await mintKeyOverHttp(h, admin, orgId, { name: "erp", role: "Issuer", scopes: ["assets:read"] });
    expect(res.statusCode).toBe(201);
    const { key, secret } = res.json() as { key: { id: string; mode?: string }; secret: string };
    expect(secret.startsWith("tl_live_")).toBe(true);
    expect(key.mode).toBe("live");
    expect((await h.apiKeys.findById(key.id))?.mode).toBe("live");

    // …and an EXPLICIT live is the same key, not a second dialect.
    const explicit = await mintKeyOverHttp(h, admin, orgId, { name: "erp2", role: "Issuer", scopes: ["assets:read"], mode: "live" });
    expect(explicit.statusCode).toBe(201);
    expect((explicit.json().secret as string).startsWith("tl_live_")).toBe(true);
    expect(explicit.json().key.mode).toBe("live");
  });

  it("refuses a mode that is not a mode, rather than quietly minting a live key", async () => {
    // The body is `additionalProperties: false`, so before this task a `mode`
    // was DROPPED. Now that the field exists it is also ENUMERATED: `"sandbox"`
    // — the word the UI and the errors use for the environment — must not
    // silently produce a production credential.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgId = await keyOrg(h, admin);

    const res = await mintKeyOverHttp(h, admin, orgId, { name: "typo", role: "Issuer", scopes: ["assets:read"], mode: "sandbox" });
    expect(res.statusCode).toBe(400);
    expect(await h.apiKeys.listByOrg(orgId)).toEqual([]);
  });

  it("a minted test key AUTHENTICATES", async () => {
    // THE END-TO-END CLAIM. Everything above asserts on strings and columns;
    // this one takes the secret the route actually returned and presents it.
    // It is what proves the marker/mode agreement check in `requirePrincipal`
    // passes for a key this route produced — a mint that stamped the marker and
    // the column independently would satisfy every other assertion here and
    // 401 on the very first call.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgId = await keyOrg(h, admin);
    await seedOrgUseCase(h, orgId, "d2-mint-sbx", true);
    await seedOrgUseCase(h, orgId, "d2-mint-live", false);

    const minted = await mintKeyOverHttp(h, admin, orgId, { name: "sandbox erp", role: "OrgAdmin", scopes: ["*"], mode: "test" });
    expect(minted.statusCode).toBe(201);
    const secret = minted.json().secret as string;

    const me = await meWith(h, secret);
    expect(me.statusCode).toBe(200);

    // …and it authenticates AS A TEST PRINCIPAL. `request.apiKey.mode` is what
    // every gate downstream reads, so a mint that got the marker right and the
    // principal wrong would still 200 above. The catalog is narrowed by
    // `modeFilter` off exactly that field: this key's org owns one use case in
    // each environment and the key may see only its own.
    const catalog = async (cred: string) => {
      const res = await h.app.inject({ method: "GET", url: `${V1}/use-cases`, headers: auth(cred) });
      expect(res.statusCode).toBe(200);
      return (res.json() as { key: string }[]).map((u) => u.key).sort();
    };
    expect(await catalog(secret)).toEqual(["d2-mint-sbx"]);

    // The control: the same mint one word different sees the other half, so
    // the narrowing above is the MODE and not some accident of this org.
    const liveMint = await mintKeyOverHttp(h, admin, orgId, { name: "live erp", role: "OrgAdmin", scopes: ["*"] });
    expect(liveMint.statusCode).toBe(201);
    expect(await catalog(liveMint.json().secret as string)).toEqual(["d2-mint-live"]);
  });

  it("ROTATING a test key preserves its mode and the rotated secret still authenticates", async () => {
    // Without the fix this yields a `tl_live_` secret on a row stored as
    // `test`, and `requirePrincipal` refuses the disagreement: the operator
    // acknowledges a one-time secret and every call it makes is a 401 with no
    // hint as to why.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgId = await keyOrg(h, admin);

    const minted = await mintKeyOverHttp(h, admin, orgId, { name: "rotating sandbox", role: "Issuer", scopes: ["assets:read"], mode: "test" });
    expect(minted.statusCode).toBe(201);
    const first = minted.json() as { key: { id: string }; secret: string };
    expect((await meWith(h, first.secret)).statusCode).toBe(200);

    const rotated = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/api-keys/${first.key.id}/rotate`, headers: auth(admin), payload: {},
    });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json() as { key: { id: string; prefix: string; mode?: string }; secret: string };

    expect(next.secret).not.toBe(first.secret);
    expect(next.secret.startsWith("tl_test_")).toBe(true);
    expect(next.key.prefix).toBe(next.secret.slice("tl_test_".length, "tl_test_".length + 8));
    expect(next.key.mode).toBe("test");
    expect((await h.apiKeys.findById(first.key.id))?.mode).toBe("test");

    // THE POINT OF THE WHOLE TEST: the rotated credential works.
    expect((await meWith(h, next.secret)).statusCode).toBe(200);
    // …and the old one is dead, exactly as it is for a live key.
    expect((await meWith(h, first.secret)).statusCode).toBe(401);

    // The live half of rotation is unchanged — a rotated live key stays live.
    const liveMint = await mintKeyOverHttp(h, admin, orgId, { name: "rotating live", role: "Issuer", scopes: ["assets:read"] });
    const liveId = liveMint.json().key.id as string;
    const liveRotated = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/api-keys/${liveId}/rotate`, headers: auth(admin), payload: {},
    });
    expect(liveRotated.statusCode).toBe(200);
    expect((liveRotated.json().secret as string).startsWith("tl_live_")).toBe(true);
    expect(liveRotated.json().key.mode).toBe("live");
    expect((await meWith(h, liveRotated.json().secret)).statusCode).toBe(200);
  });

  it("a read route reveals a key's environment", async () => {
    // `apiKeyView` is the ONLY projection of a key, so a mode it does not
    // name is a mode no read route can ever show — and the console would
    // render a sandbox credential with a `tl_live_` marker beside it. (The
    // schema half matters just as much: fast-json-stringify strips whatever
    // `ApiKeyView#` does not declare, so the field can be present in the
    // handler and absent on the wire.)
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgId = await keyOrg(h, admin);

    const test = await mintKeyOverHttp(h, admin, orgId, { name: "sbx", role: "Issuer", scopes: ["assets:read"], mode: "test" });
    const live = await mintKeyOverHttp(h, admin, orgId, { name: "prod", role: "Issuer", scopes: ["assets:read"] });
    expect([test.statusCode, live.statusCode]).toEqual([201, 201]);

    const listed = await h.app.inject({ method: "GET", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(admin) });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json() as { id: string; name: string; mode?: string }[];
    expect(Object.fromEntries(rows.map((k) => [k.name, k.mode]))).toEqual({ sbx: "test", prod: "live" });

    // Revoke answers with the same view, so it must carry the field too.
    const revoked = await h.app.inject({
      method: "DELETE", url: `${V1}/orgs/${orgId}/api-keys/${test.json().key.id}`, headers: auth(admin), payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().key.mode).toBe("test");
  });

  it("a key may not be minted into an environment its bound use case does not live in", async () => {
    // THE CROSSING THIS TASK TURNED UP. `modeGate` asks what the CALLING
    // principal may act on, and the caller here is always a human (see the
    // MACHINE_PRINCIPAL test below), so that question has no answer on this
    // route. The one that does: the key being minted has a mode, and the use
    // case it is BOUND to has one — and a disagreement produces a credential
    // that is refused by `modeGate` at every single call it will ever make.
    // Minting it is worse than refusing it: the operator leaves the one-time
    // secret ceremony holding a key that works nowhere, and nothing said so.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgId = await keyOrg(h, admin);
    await seedUseCase(h, "d2-bind-live", false);
    await seedUseCase(h, "d2-bind-sbx", true);

    const crossed = await mintKeyOverHttp(h, admin, orgId, { name: "x", role: "Issuer", scopes: ["assets:read"], mode: "test", useCaseKey: "d2-bind-live" });
    expect(crossed.statusCode).toBe(403);
    expect(crossed.json().error).toBe("WRONG_MODE");

    // The mirror — and it bites the DEFAULT mode, which is the direction an
    // operator hits by accident the first time they bind a key to the sandbox
    // programme they just built.
    const mirrored = await mintKeyOverHttp(h, admin, orgId, { name: "y", role: "Issuer", scopes: ["assets:read"], useCaseKey: "d2-bind-sbx" });
    expect(mirrored.statusCode).toBe(403);
    expect(mirrored.json().error).toBe("WRONG_MODE");

    // NOTHING WAS CREATED. The refusal runs before the service user is minted,
    // so a refused mint leaves no principal behind — the partial-rollback path
    // exists for a reason and this must not depend on it.
    expect(await h.apiKeys.listByOrg(orgId)).toEqual([]);
    expect((await h.users.listByOrg(orgId)).filter((u) => u.kind === "service")).toEqual([]);

    // THE CONTROLS, both ways round, or the test above would pass against a
    // gate that simply refused every bound key.
    const sandboxOk = await mintKeyOverHttp(h, admin, orgId, { name: "ok-sbx", role: "Issuer", scopes: ["assets:read"], mode: "test", useCaseKey: "d2-bind-sbx" });
    expect(sandboxOk.statusCode).toBe(201);
    expect(sandboxOk.json().key).toMatchObject({ mode: "test", useCaseKey: "d2-bind-sbx" });
    expect((sandboxOk.json().secret as string).startsWith("tl_test_")).toBe(true);
    // …and the bound test key really can act on its own programme.
    expect((await h.app.inject({ method: "GET", url: `${V1}/use-cases/d2-bind-sbx`, headers: auth(sandboxOk.json().secret) })).statusCode).toBe(200);

    const liveOk = await mintKeyOverHttp(h, admin, orgId, { name: "ok-live", role: "Issuer", scopes: ["assets:read"], useCaseKey: "d2-bind-live" });
    expect(liveOk.statusCode).toBe(201);
    expect(liveOk.json().key).toMatchObject({ mode: "live", useCaseKey: "d2-bind-live" });

    // An UNBOUND key crosses nothing at mint time — it is gated per act, on
    // its own mode, by `modeGate` — so both modes are mintable without a key.
    expect((await mintKeyOverHttp(h, admin, orgId, { name: "free", role: "Issuer", scopes: ["assets:read"], mode: "test" })).statusCode).toBe(201);
  });

  it("a tl_test_ key cannot mint or rotate ANY key — the crossing is unreachable, not merely gated", async () => {
    // WHAT THE MODE GATE ON KEY CREATION AMOUNTS TO. `createOrgMember` does
    // carry `modeGateByKey`, and a key mints its principal through it — but
    // `apiKeyScope` refuses every machine principal on all four key routes
    // FIRST, so `actorMode` on this route is always null and that gate can
    // never fire here. This test is the proof of that claim rather than an
    // assumption about it: if the machine-principal refusal were ever relaxed,
    // this fails and the mode question on these routes becomes live again.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgId = await keyOrg(h, admin);
    const target = await mintKeyOverHttp(h, admin, orgId, { name: "target", role: "Issuer", scopes: ["assets:read"], mode: "test" });
    expect(target.statusCode).toBe(201);
    const targetId = target.json().key.id as string;

    // An OrgAdmin-roled SANDBOX key: it has the rank to mint members, so only
    // the machine-principal refusal stands between it and a fresh credential.
    const testKey = await seedOrgKey(h, orgId, "test");
    const liveKey = await seedOrgKey(h, orgId, "live");

    for (const cred of [testKey, liveKey]) {
      const attempts = await Promise.all([
        mintKeyOverHttp(h, cred, orgId, { name: "wider", role: "Issuer", scopes: ["*"], mode: "live" }),
        mintKeyOverHttp(h, cred, orgId, { name: "wider", role: "Issuer", scopes: ["*"], mode: "test" }),
        h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/api-keys/${targetId}/rotate`, headers: auth(cred), payload: {} }),
        h.app.inject({ method: "GET", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(cred) }),
      ]);
      for (const res of attempts) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe("MACHINE_PRINCIPAL");
      }
    }
    // Nothing was minted — the two seeded keys and the target are all that
    // exist — and the target's secret was not rotated out from under its holder.
    const names = (await h.apiKeys.listByOrg(orgId)).map((k) => k.name);
    expect(names.filter((n) => n === "wider")).toEqual([]);
    expect(names).toContain("target");
    expect((await h.apiKeys.findById(targetId))?.prefix).toBe(target.json().key.prefix);
  });
});

// ---------------------------------------------------------------------------
// Task D2-8 — A FLAG WITH NO ROUTE TO SET IT.
//
// A live walkthrough could not create a sandbox CREDENTIAL programme at all.
// Everything above this line is reachable only once a sandbox use case exists,
// and for the Identity domain the primary way to make one is
// `POST /credential-use-cases/provision` — the console wizard's path and the
// EN-D1 guides' path, and the ONLY path an OrgAdmin has (authoring a credential
// use case directly is PlatformAdmin-only). Provisioning built its definition
// from a template, and a template names no `sandbox`, so the flag was dropped —
// with a 201 on the way out.
//
// SILENTLY DROPPING IT IS THE WORST OF THE THREE POSSIBLE ANSWERS. A refusal is
// survivable: the operator reads it and fixes the call. A 201 that quietly
// hands back a LIVE programme is not: every later refusal looks like a bug in
// the gate rather than a misconfiguration, and in the meantime real credentials
// are issued on a real chain by someone who believes they are testing.
//
// So the rule this block pins is not "provision honours sandbox" — that is one
// route, and the next creation route would reintroduce the gap. It is: EVERY
// path that can create a use case of either kind must either HONOUR `sandbox`
// or REFUSE the request. None may answer 2xx having dropped it.
// ---------------------------------------------------------------------------

/** The parameters the `education-certificate` built-in template needs. */
const eduParams = (issuerOrgName: string) => ({ issuerOrgName, jurisdiction: "IN" });

/** `education-certificate`'s keyTemplate is `education-${issuerOrgNameSlug}` — the key it will claim. */
const eduKey = (issuerOrgName: string) =>
  `education-${issuerOrgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48)}`;

const provision = (h: TestAppHandle, cred: string, payload: Record<string, unknown>) =>
  h.app.inject({ method: "POST", url: `${V1}/credential-use-cases/provision`, headers: auth(cred), payload });

describe("EN-D2 · provisioning a sandbox programme", () => {
  it("provisioning a SANDBOX credential programme stores sandbox: true", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");

    const res = await provision(h, admin, {
      templateKey: "education-certificate",
      params: eduParams("Sandbox University"),
      sandbox: true,
      provisioning: { issuerOrgType: "government", createDeskUsers: false },
    });
    expect(res.statusCode).toBe(201);
    const key = eduKey("Sandbox University");
    expect(res.json().useCase.key).toBe(key);
    // The RESPONSE says so — a stored flag the caller cannot see is a flag the
    // caller cannot trust (fast-json-stringify strips undeclared fields, so
    // this assertion is also the schema's).
    expect(res.json().useCase.sandbox).toBe(true);
    // …and so does the record.
    expect((await h.deps.credentialUseCases.get(key))?.sandbox).toBe(true);
    // And reading it back over HTTP, which is where the console looks.
    const read = await h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/${key}`, headers: auth(admin) });
    expect(read.json().sandbox).toBe(true);

    // RE-PROVISIONING IS A NO-OP, not a promotion: the same call again keeps the
    // flag, and asking for the OTHER environment is the immutability 409 rather
    // than a silent reclassification of everything already issued under it.
    const again = await provision(h, admin, {
      templateKey: "education-certificate", params: eduParams("Sandbox University"), sandbox: true,
      provisioning: { createDeskUsers: false },
    });
    expect(again.statusCode).toBe(200);
    expect((await h.deps.credentialUseCases.get(key))?.sandbox).toBe(true);

    const promoted = await provision(h, admin, {
      templateKey: "education-certificate", params: eduParams("Sandbox University"), sandbox: false,
      provisioning: { createDeskUsers: false },
    });
    expect(promoted.statusCode).toBe(409);
    expect(promoted.json().error).toBe("SANDBOX_IMMUTABLE");
    // …and it names the IDENTITY clone route. Pointing a credential operator at
    // POST /use-cases/:key/clone-to-live would be a 404 for their key — a
    // refusal with a dead end in it is barely better than no refusal.
    expect(promoted.json().message).toContain("POST /credential-use-cases/:key/clone-to-live");
    expect((await h.deps.credentialUseCases.get(key))?.sandbox).toBe(true);
  });

  it("provisioning without the flag stores sandbox: false — existing callers unaffected", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");

    // The pre-EN-D2 body, verbatim: no `sandbox` anywhere.
    const res = await provision(h, admin, {
      templateKey: "education-certificate",
      params: eduParams("Live University"),
      provisioning: { issuerOrgType: "government", createDeskUsers: false },
    });
    expect(res.statusCode).toBe(201);
    const key = eduKey("Live University");
    expect(res.json().useCase.sandbox).toBe(false);
    expect((await h.deps.credentialUseCases.get(key))?.sandbox).toBe(false);

    // A live programme's re-provision is equally unmoved.
    const again = await provision(h, admin, {
      templateKey: "education-certificate", params: eduParams("Live University"),
      provisioning: { createDeskUsers: false },
    });
    expect(again.statusCode).toBe(200);
    expect((await h.deps.credentialUseCases.get(key))?.sandbox).toBe(false);
  });

  it("an ORG ADMIN can provision one — the only credential-creation path they have", async () => {
    // The walkthrough's persona. `POST /credential-use-cases` is
    // PlatformAdmin-only, so if provisioning cannot express `sandbox`, an
    // enterprise tenant has NO way to make a sandbox credential programme at
    // all — the feature is not merely awkward for them, it is unreachable.
    const h = await buildTestAppWithRepos();
    const { orgId, token } = await seedOrgAdmin(h);
    const orgName = (await h.organizations.get(orgId)).name;

    const res = await provision(h, token, {
      templateKey: "education-certificate", params: eduParams(orgName), sandbox: true,
      provisioning: { createDeskUsers: false },
    });
    expect(res.statusCode).toBe(201);
    const stored = await h.deps.credentialUseCases.get(eduKey(orgName));
    expect(stored?.sandbox).toBe(true);
    expect(stored?.ownerOrgId).toBe(orgId);
  });

  it("a sandbox programme created via provision refuses a tl_live_ key and accepts a tl_test_ one", async () => {
    // THE END-TO-END CLAIM. Not "the flag was stored" but "the programme the
    // operator just provisioned behaves as a sandbox": the whole point of
    // creating one is that a test credential can act on it and a live one
    // cannot.
    const h = await buildTestAppWithRepos();
    const { orgId, token } = await seedOrgAdmin(h);
    const orgName = (await h.organizations.get(orgId)).name;
    const key = eduKey(orgName);
    expect((await provision(h, token, {
      templateKey: "education-certificate", params: eduParams(orgName), sandbox: true,
      provisioning: { createDeskUsers: false },
    })).statusCode).toBe(201);

    const testKey = (await seedKey(h, { mode: "test" })).secret;
    const liveKey = (await seedKey(h, { mode: "live" })).secret;

    // The live key cannot even READ it, let alone issue on it.
    const readLive = await h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/${key}`, headers: auth(liveKey) });
    expect(readLive.statusCode).toBe(403);
    expect(readLive.json().error).toBe("WRONG_MODE");
    const issuedLive = await issueOn(h, key, liveKey);
    expect(issuedLive.statusCode).toBe(403);
    expect(issuedLive.json().error).toBe("WRONG_MODE");

    // The test key reads it and gets all the way THROUGH the mode gate on
    // issuance — SUBJECT_REQUIRED is a payload-level complaint about the very
    // credential type this programme declares, i.e. nothing about its
    // ENVIRONMENT stopped it.
    const read = await h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/${key}`, headers: auth(testKey) });
    expect(read.statusCode).toBe(200);
    const credentialType = read.json().credentialTypes[0].name as string;
    const issuedTest = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/credentials`, headers: auth(testKey),
      payload: { credentialType, claims: {} },
    });
    expect(issuedTest.statusCode).toBe(400);
    expect(issuedTest.json().error).toBe("SUBJECT_REQUIRED");

    // THE CONTROL, or the two assertions above would pass against a programme
    // that simply refused everyone: a LIVE programme from the same route is the
    // exact mirror.
    const liveName = `${orgName} Live`;
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    expect((await provision(h, admin, {
      templateKey: "education-certificate", params: eduParams(liveName), provisioning: { createDeskUsers: false },
    })).statusCode).toBe(201);
    const liveKeyUseCase = eduKey(liveName);
    expect((await h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/${liveKeyUseCase}`, headers: auth(liveKey) })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/${liveKeyUseCase}`, headers: auth(testKey) })).statusCode).toBe(403);
  });
});

/**
 * One creation path, asked to make a SANDBOX thing.
 *
 * `run` performs the request; `stored` reads back whatever that path would have
 * created (null = it created nothing). NEITHER declares the expected verdict —
 * the assertion derives it from the response, which is the whole point: a path
 * may answer however it likes, so long as a 2xx means the flag was honoured.
 */
interface CreationPath {
  name: string;
  run(w: PathWorld): Promise<{ statusCode: number; json(): { proposal?: { id: string } } }>;
  stored?(w: PathWorld): Promise<{ sandbox?: boolean } | null>;
  /** Defaults to `key`-based lookup in both use-case repositories. */
  key?: string;
}

interface PathWorld {
  h: TestAppHandle;
  admin: string;
  orgAdmin: string;
  orgId: string;
  orgName: string;
}

async function pathWorld(): Promise<PathWorld> {
  const h = await buildTestAppWithRepos();
  const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
  const { orgId, token } = await seedOrgAdmin(h);
  return { h, admin, orgAdmin: token, orgId, orgName: (await h.organizations.get(orgId)).name };
}

/** Every route that can bring a use case of either kind into existence. */
const CREATION_PATHS: CreationPath[] = [
  {
    name: "POST /use-cases (PlatformAdmin, direct)",
    key: "d2-path-token-direct",
    run: (w) => createUseCaseOverHttp(w.h, w.admin, "d2-path-token-direct", true),
  },
  {
    name: "POST /use-cases (OrgAdmin ⇒ create-use-case proposal ⇒ approval)",
    key: "d2-path-token-proposed",
    run: (w) => createUseCaseOverHttp(w.h, w.orgAdmin, "d2-path-token-proposed", true),
  },
  {
    name: "POST /use-cases/:key/clone-to-live (body asking for sandbox)",
    key: "d2-path-clone-live",
    async run(w) {
      await seedUseCase(w.h, "d2-path-clone-src", true);
      return w.h.app.inject({
        method: "POST", url: `${V1}/use-cases/d2-path-clone-src/clone-to-live`, headers: auth(w.admin),
        payload: { key: "d2-path-clone-live", allowedChainIds: ["fabric"], sandbox: true },
      });
    },
  },
  {
    name: "POST /credential-use-cases (PlatformAdmin, direct)",
    key: "d2-path-cred-direct",
    run: (w) => w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(w.admin),
      payload: { ...credentialUseCaseDef, key: "d2-path-cred-direct", sandbox: true },
    }),
  },
  {
    name: "POST /credential-use-cases/:key/clone-to-live (body asking for sandbox)",
    key: "d2-path-cred-clone-live",
    async run(w) {
      await seedCredentialUseCase(w.h, "d2-path-cred-clone-src", true, w.orgId);
      return w.h.app.inject({
        method: "POST", url: `${V1}/credential-use-cases/d2-path-cred-clone-src/clone-to-live`, headers: auth(w.admin),
        payload: { key: "d2-path-cred-clone-live", sandbox: true },
      });
    },
  },
  {
    name: "POST /credential-use-cases/provision (PlatformAdmin, sandbox at the top level)",
    key: eduKey("Path Platform University"),
    run: (w) => provision(w.h, w.admin, {
      templateKey: "education-certificate", params: eduParams("Path Platform University"), sandbox: true,
      provisioning: { createDeskUsers: false },
    }),
  },
  {
    name: "POST /credential-use-cases/provision (OrgAdmin, sandbox at the top level)",
    run: (w) => provision(w.h, w.orgAdmin, {
      templateKey: "education-certificate", params: eduParams(w.orgName), sandbox: true,
      provisioning: { createDeskUsers: false },
    }),
    stored: (w) => w.h.deps.credentialUseCases.get(eduKey(w.orgName)),
  },
  {
    name: "POST /credential-use-cases/provision (sandbox misplaced inside `provisioning`)",
    key: eduKey("Path Misplaced University"),
    run: (w) => provision(w.h, w.admin, {
      templateKey: "education-certificate", params: eduParams("Path Misplaced University"),
      provisioning: { createDeskUsers: false, sandbox: true },
    }),
  },
  {
    name: "POST /credential-use-case-templates (a template claiming to be sandbox)",
    run: (w) => w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-case-templates`, headers: auth(w.admin),
      payload: {
        key: "d2-path-template", name: "D2 path template", category: "custom", parameters: [],
        body: {
          keyTemplate: "d2-path-from-template", nameTemplate: "D2 from template", sandbox: true,
          credentialTypes: [{
            name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
            required: ["legalName"], properties: { legalName: { type: "string" } },
          }],
          holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
        },
      },
    }),
    // A template is not a use case, so it can never come back "sandbox": the
    // only outcome that is not a silent drop is a refusal.
    stored: async (w) => (await w.h.deps.credentialTemplates.get("d2-path-template")) as { sandbox?: boolean } | null,
  },
];

describe("EN-D2 · no creation path may silently drop sandbox", () => {
  it("every creation path either honours sandbox or REFUSES it — none silently drops it", async () => {
    // THE TEST THAT STOPS THE NEXT ROUTE FROM REINTRODUCING THE GAP. It asserts
    // no verdict per path — each entry merely asks for a sandbox thing and says
    // where to look for it. The rule is derived from the answer:
    //
    //   2xx  ⇒ the created record MUST have sandbox: true
    //   4xx  ⇒ nothing was created
    //
    // The forbidden third outcome — 2xx with sandbox falsy — has no branch,
    // which is exactly how it fails, naming the path that did it.
    for (const path of CREATION_PATHS) {
      const w = await pathWorld();
      const res = await path.run(w);

      // A 202 is a maker-checker path, not a decision: approve it and judge
      // what the executor actually created, or the flag could be lost between
      // the proposal and the record with the test none the wiser.
      if (res.statusCode === 202) {
        const id = res.json().proposal!.id;
        const decided = await w.h.app.inject({ method: "POST", url: `${V1}/proposals/${id}/approve`, headers: auth(w.admin), payload: {} });
        expect(decided.statusCode, `${path.name}: approving its proposal`).toBe(200);
      }

      const stored = path.stored
        ? await path.stored(w)
        : ((await w.h.deps.useCases.get(path.key!).catch(() => null)) ?? (await w.h.deps.credentialUseCases.get(path.key!)));

      if (res.statusCode < 400) {
        expect(stored, `${path.name} answered ${res.statusCode} but created nothing`).toBeTruthy();
        expect(
          stored?.sandbox,
          `${path.name} answered ${res.statusCode} to a request for a SANDBOX use case and stored sandbox=${String(stored?.sandbox)} — a SILENT DROP: the operator believes they have a sandbox programme and does not`,
        ).toBe(true);
      } else {
        expect(res.statusCode, `${path.name} must refuse with a 4xx, not fail`).toBeLessThan(500);
        expect(
          stored,
          `${path.name} refused with ${res.statusCode} but created something anyway`,
        ).toBeNull();
      }
    }
    // Builds a FRESH app per creation path — deliberately, so one path's writes
    // cannot mask another's — which makes the cost grow with CREATION_PATHS,
    // and it has outgrown vitest's 5s default. The 5s was never a claim about
    // this test; leaving it would make the next added path fail the suite for
    // being the straw, with a timeout that says nothing about sandbox.
  }, 60_000);

  it("the misplaced-flag refusal says where the flag belongs, and provisions NOTHING", async () => {
    // A refusal that does not say what to do instead is only a slower silent
    // drop: the operator retries the same body, or gives up and takes the live
    // programme. `provisioning.sandbox` is exactly where a reader of the
    // provisioning body puts it, so this is the likely mistake, not a contrived
    // one — and it must cost nothing, i.e. no org and no use case.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const res = await provision(h, admin, {
      templateKey: "education-certificate", params: eduParams("Misplaced University"),
      provisioning: { createDeskUsers: false, sandbox: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("SANDBOX_MISPLACED");
    expect(res.json().message).toContain("sandbox");
    expect(await h.deps.credentialUseCases.get(eduKey("Misplaced University"))).toBeNull();
    expect((await h.organizations.list()).some((o) => o.name === "Misplaced University")).toBe(false);
  });

  it("a sandbox value that is not a boolean is refused, never read for truthiness", async () => {
    // `sandbox` is DECLARED as a boolean in the body schema, so a value that is
    // not one fails validation. The alternative — `!!body.sandbox` — would read
    // every non-empty string as "yes", including the string "false".
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const res = await provision(h, admin, {
      templateKey: "education-certificate", params: eduParams("Stringly University"),
      sandbox: "yes", provisioning: { createDeskUsers: false },
    });
    expect(res.statusCode).toBe(400);
    expect(await h.deps.credentialUseCases.get(eduKey("Stringly University"))).toBeNull();
  });
});
