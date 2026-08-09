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
import { auth, buildTestAppWithRepos, V1, type TestAppHandle } from "./helpers.js";

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
