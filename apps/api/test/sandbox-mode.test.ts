import { MockLedgerAdapter } from "@tokenlayer/adapters";
import { SANDBOX_CHAIN_ID, type CredentialUseCaseDefinition, type UseCaseDefinition } from "@tokenlayer/core";
import { describe, expect, it } from "vitest";
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
