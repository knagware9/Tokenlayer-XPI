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
import { auth, buildTestApp, loginAs, onboardUser, TEST_MARKET_ESCROW, V1 } from "./helpers.js";

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

// ---------------------------------------------------------------------------
// O2 — the stored hashes are PROJECTED onto every credential surface. These
// tests need no repo handle (everything is asserted through real HTTP, which
// also proves the fields survive fast-json-stringify serialization), so they
// use plain buildTestApp.
// ---------------------------------------------------------------------------

interface HeldTx { id: string; anchorTxHash: string | null; anchorChainId: string | null; revokeTxHash: string | null }

describe("tx-hash projections (ID-O task O2)", () => {
  async function heldRow(app: FastifyInstance, holder: string, credId: string): Promise<HeldTx> {
    const res = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holder) });
    expect(res.statusCode).toBe(200);
    const row = (res.json() as HeldTx[]).find((c) => c.id === credId);
    expect(row).toBeTruthy();
    return row!;
  }

  it("/me/credentials rows carry the anchor receipt, and the revoke receipt after revocation", async () => {
    const app = await buildTestApp({ registry: fakeRegistry(new FakeAnchor()) });
    const { admin, admin2, holder, credId } = await issueOne(app);
    const before = await heldRow(app, holder, credId);
    expect(before.anchorTxHash).toMatch(/^0xfake/);
    expect(before.anchorChainId).toBe("besu");
    expect(before.revokeTxHash).toBeNull();
    const rv = await app.inject({ method: "POST", url: `${V1}/credentials/${credId}/revoke`, headers: auth(admin), payload: { reason: "test" } });
    expect(rv.statusCode).toBe(202);
    const ap = await app.inject({ method: "POST", url: `${V1}/proposals/${rv.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    expect(ap.statusCode).toBe(200);
    const after = await heldRow(app, holder, credId);
    expect(after.revokeTxHash).toMatch(/^0xfake/);
    expect(after.anchorTxHash).toMatch(/^0xfake/); // anchor pointer survives revocation
  });

  it("public /credentials/:id/status carries the fields under a registry (chain source), no auth", async () => {
    const app = await buildTestApp({ registry: fakeRegistry(new FakeAnchor()) });
    const { credId } = await issueOne(app);
    const res = await app.inject({ method: "GET", url: `${V1}/credentials/${credId}/status` }); // NO auth header
    expect(res.statusCode).toBe(200);
    const body = res.json() as HeldTx & { source: string; anchored: boolean };
    expect(body.source).toBe("chain");
    expect(body.anchored).toBe(true);
    expect(body.anchorTxHash).toMatch(/^0xfake/);
    expect(body.anchorChainId).toBe("besu");
    expect(body.revokeTxHash).toBeNull();
  });

  // Database-source status responses are shape-pinned byte-identical by
  // pre-ID-O tests (credential-issuance + onchain-registry), so the tx
  // pointers ride the CHAIN answer only and must stay absent here.
  it("public /credentials/:id/status without a registry omits the tx fields (database source)", async () => {
    const app = await buildTestApp(); // no registry
    const { credId } = await issueOne(app);
    const res = await app.inject({ method: "GET", url: `${V1}/credentials/${credId}/status` }); // NO auth header
    expect(res.statusCode).toBe(200);
    const body = res.json() as HeldTx & { source: string; anchored: boolean };
    expect(body.source).toBe("database");
    expect(body.anchored).toBe(false);
    expect(body).not.toHaveProperty("anchorTxHash");
    expect(body).not.toHaveProperty("anchorChainId");
    expect(body).not.toHaveProperty("revokeTxHash");
  });

  // Full request → consent → verify flow, mirroring verification.test.ts: the
  // issuer org must exist ON-CHAIN (POST /orgs registers its DID under the fake
  // registry) or the verify route marks every credential UNTRUSTED.
  it("verify result per-credential rows carry the three tx fields", async () => {
    const app = await buildTestApp({ registry: fakeRegistry(new FakeAnchor()) });
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const mkOrg = async (orgType: string, name: string): Promise<{ id: string; did: string }> => {
      const res = await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name, orgType } });
      expect(res.statusCode).toBe(201);
      return res.json() as { id: string; did: string };
    };
    const addMember = async (orgId: string, role: string, email: string): Promise<{ id: string; did: string; token: string }> => {
      const res = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(admin), payload: { email, password: "secret1", role } });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; did: string };
      return { ...body, token: await loginAs(app, email, "secret1") };
    };

    const issuer = await mkOrg("verifier", "TxH Issuer");
    const maker = await addMember(issuer.id, "OrgAdmin", "txh.maker@x.io");
    const checker = await addMember(issuer.id, "OrgAdmin", "txh.checker@x.io");
    const subject = await addMember((await mkOrg("corporate", "TxH Holder Co")).id, "Issuer", "txh.subject@x.io");
    const req = await app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(maker.token),
      payload: { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Ada Lovelace", country: "IN", idType: "passport", idNumber: "P1234567" } } });
    expect(req.statusCode).toBe(202);
    const ap = await app.inject({ method: "POST", url: `${V1}/proposals/${req.json().proposal.id}/approve`, headers: auth(checker.token), payload: {} });
    expect(ap.json().proposal.status).toBe("executed");
    const credentialId = ((await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subject.token) })).json() as { id: string; type: string[] }[])
      .find((c) => c.type.includes("KycCredential"))!.id;

    const vAdmin = await addMember((await mkOrg("verifier", "TxH Verifier")).id, "OrgAdmin", "txh.vadmin@x.io");
    const created = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(vAdmin.token),
      payload: { holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "onboarding" } });
    expect(created.statusCode).toBe(201);
    const requestId = (created.json() as { id: string }).id;
    const consented = await app.inject({ method: "POST", url: `${V1}/verification-requests/${requestId}/consent`, headers: auth(subject.token), payload: { credentialIds: [credentialId] } });
    expect(consented.statusCode).toBe(200);

    const vRes = await app.inject({ method: "GET", url: `${V1}/verification-requests/${requestId}/verify`, headers: auth(vAdmin.token) });
    expect(vRes.statusCode).toBe(200);
    const result = vRes.json() as { valid: boolean; credentials: (HeldTx & { valid: boolean })[] };
    expect(result.valid).toBe(true);
    expect(result.credentials).toHaveLength(1);
    const row = result.credentials[0];
    expect(row.id).toBe(credentialId);
    expect(row.anchorTxHash).toMatch(/^0xfake/);
    expect(row.anchorChainId).toBe("besu");
    expect(row.revokeTxHash).toBeNull();
  });
});
