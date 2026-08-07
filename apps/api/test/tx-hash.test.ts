/**
 * ID-O task O1: the TxReceipts that anchorCredential/revokeCredential return
 * are persisted on the Credential record (anchorTxHash / anchorChainId /
 * revokeTxHash) — and stay null when no registry is wired.
 *
 * buildTestApp() does not expose its repositories and O1 adds no projections
 * (that is O2), so this suite wires the app locally — mirroring helpers.ts —
 * keeping a handle on the MemoryCredentialRepository to read the stored record
 * directly (the same direct-repo assertion style platform-operator-identity
 * uses).
 */
import { RbacPolicy } from "@tokenlayer/core";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildChainRegistry } from "../src/chains.js";
import type { AppDeps } from "../src/context.js";
import { createEngine } from "../src/context.js";
import { loadCurrencies } from "../src/currencies.js";
import { createMemoryChallengeStore } from "../src/identity-challenges.js";
import { createKeystore } from "../src/keystore.js";
import {
  MemoryAccountRepository,
  MemoryAssetRepository,
  MemoryAuditAnchorRepository,
  MemoryAuditRepository,
  MemoryCashflowRepository,
  MemoryCashRepository,
  MemoryCredentialRepository,
  MemoryCredentialUseCaseRepository,
  MemoryCredentialUseCaseTemplateRepository,
  MemoryDocumentRepository,
  MemoryListingRepository,
  MemoryLoginKeyRepository,
  MemoryOrganizationRepository,
  MemoryProposalRepository,
  MemoryStagedInvoiceRepository,
  MemoryUseCaseRepository,
  MemoryUserRepository,
  MemoryVerificationRequestRepository,
} from "../src/persistence/memory.js";
import { ensurePlatformIssuerOrg } from "../src/platform-org.js";
import { createMemoryQrLoginStore } from "../src/qr-login-sessions.js";
import type { IdentityRegistry } from "../src/registry.js";
import { seedDefaults } from "../src/seed.js";
import { seedUseCases } from "../src/use-cases.js";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";
import { auth, loginAs, onboardUser, TEST_MARKET_ESCROW, V1 } from "./helpers.js";

interface TestApp {
  app: FastifyInstance;
  credentials: MemoryCredentialRepository;
}

/** helpers.buildTestApp, but returning the credentials repo so tests can read stored records. */
async function buildAppWithDeps(registry?: IdentityRegistry): Promise<TestApp> {
  const rbac = new RbacPolicy();
  const chains = buildChainRegistry({ CHAIN_STRICT: "0" });
  const users = new MemoryUserRepository();
  const assets = new MemoryAssetRepository();
  const audit = new MemoryAuditRepository();
  const accounts = new MemoryAccountRepository();
  const useCases = new MemoryUseCaseRepository();
  const credentials = new MemoryCredentialRepository();
  await seedDefaults(users, accounts);
  const engine = createEngine(useCases, rbac, chains, audit, { users, accounts, credentials });
  await seedUseCases(useCases, {
    availableChainIds: new Set(chains.list().map((c) => c.id)),
    deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
  });
  const deps: AppDeps = {
    useCases, credentialUseCases: new MemoryCredentialUseCaseRepository(), credentialTemplates: new MemoryCredentialUseCaseTemplateRepository(),
    rbac, engine, users, assets, audit, auditAnchors: new MemoryAuditAnchorRepository(), accounts, chains,
    cash: new MemoryCashRepository(), listings: new MemoryListingRepository(), documents: new MemoryDocumentRepository(),
    cashflows: new MemoryCashflowRepository(), proposals: new MemoryProposalRepository(),
    organizations: new MemoryOrganizationRepository(), credentials, verificationRequests: new MemoryVerificationRequestRepository(),
    stagedInvoices: new MemoryStagedInvoiceRepository(), keystore: createKeystore("11".repeat(32)), didMasterConfigured: true,
    challenges: createMemoryChallengeStore(), loginKeys: new MemoryLoginKeyRepository(), qrLogin: createMemoryQrLoginStore(),
    publicWebUrl: "http://localhost:5173", enabledDomains: ["tokenization", "identity"],
    currencies: loadCurrencies(), jwtSecret: "test-secret", publicApiUrl: "http://test.local/api/v1",
    loginRateLimitMax: 100000, marketEscrowAccount: TEST_MARKET_ESCROW,
    registry,
  };
  await ensurePlatformIssuerOrg(deps);
  return { app: await buildApp(deps), credentials };
}

/** Identity use case + one issued credential; returns tokens + the credential id. */
async function issueOne(app: FastifyInstance) {
  const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
  const key = `txh-${Math.random().toString(36).slice(2)}`;
  const mk = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: {
    key, name: "TxHash UC",
    credentialTypes: [{ name: "ScoreCredential", title: "Score", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
  } });
  expect(mk.statusCode).toBe(201);
  const email = `txh-${Math.random().toString(36).slice(2)}@x.dev`;
  const subject = await onboardUser(app, admin, admin2, { email, password: "secret123", role: "Holder", useCaseKey: key });
  const draft = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/${key}/credentials`, headers: auth(admin),
    payload: { credentialType: "ScoreCredential", subjectUserId: subject.id, claims: { legalName: "T" } } });
  expect(draft.statusCode).toBe(202);
  const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
  expect(approve.statusCode).toBe(200);
  const holder = await loginAs(app, email, "secret123");
  const held = ((await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holder) })).json() as { id: string; type: string[] }[])
    .find((c) => c.type.includes("ScoreCredential"));
  expect(held).toBeTruthy();
  return { admin, admin2, holder, credId: held!.id, key };
}

describe("tx-hash capture (ID-O task O1)", () => {
  it("issuing under a registry stores the anchor receipt's txHash + chainId", async () => {
    const anchor = new FakeAnchor();
    const { app, credentials } = await buildAppWithDeps(fakeRegistry(anchor));
    const { credId } = await issueOne(app);
    const stored = await credentials.get(credId);
    expect(stored!.anchorTxHash).toMatch(/^0xfake/);
    expect(stored!.anchorChainId).toBe("besu");
    expect(stored!.revokeTxHash).toBeNull(); // not revoked yet
  });

  it("revoking under a registry stores the revoke receipt's txHash", async () => {
    const anchor = new FakeAnchor();
    const { app, credentials } = await buildAppWithDeps(fakeRegistry(anchor));
    const { admin, admin2, credId } = await issueOne(app);
    const rv = await app.inject({ method: "POST", url: `${V1}/credentials/${credId}/revoke`, headers: auth(admin), payload: { reason: "test" } });
    expect(rv.statusCode).toBe(202);
    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${rv.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    expect(approve.statusCode).toBe(200);
    const stored = await credentials.get(credId);
    expect(stored!.revoked).toBe(true);
    expect(stored!.revokeTxHash).toMatch(/^0xfake/);
    expect(stored!.anchorTxHash).toMatch(/^0xfake/); // anchor receipt untouched by revoke
  });

  it("without a registry all three fields stay null", async () => {
    const { app, credentials } = await buildAppWithDeps(); // no registry
    const { admin, admin2, credId } = await issueOne(app);
    const afterIssue = await credentials.get(credId);
    expect(afterIssue!.anchorTxHash).toBeNull();
    expect(afterIssue!.anchorChainId).toBeNull();
    expect(afterIssue!.revokeTxHash).toBeNull();
    const rv = await app.inject({ method: "POST", url: `${V1}/credentials/${credId}/revoke`, headers: auth(admin), payload: { reason: "test" } });
    expect(rv.statusCode).toBe(202);
    await app.inject({ method: "POST", url: `${V1}/proposals/${rv.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    const afterRevoke = await credentials.get(credId);
    expect(afterRevoke!.revoked).toBe(true);
    expect(afterRevoke!.revokeTxHash).toBeNull();
  });
});
