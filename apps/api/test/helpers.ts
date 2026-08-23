import { RbacPolicy } from "@tokenlayer/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildChainRegistry } from "../src/shared/chains.js";
import type { AppDeps } from "../src/context.js";
import { createEngine } from "../src/context.js";
import { loadCurrencies } from "../src/tokenization/currencies.js";
import { createMemoryChallengeStore } from "../src/identity/identity-challenges.js";
import { createKeystore } from "../src/shared/keystore.js";
import { createSecretBox } from "../src/webhooks/secret-box.js";
import { createMemoryQrLoginStore } from "../src/identity/qr-login-sessions.js";
import {
  MemoryAccountRepository,
  MemoryApiKeyRepository,
  MemoryAssetRepository,
  MemoryAuditAnchorRepository,
  MemoryAuditRepository,
  MemoryCashflowRepository,
  MemoryCredentialRepository,
  MemoryLoginKeyRepository,
  MemoryOrganizationRepository,
  MemoryProposalRepository,
  MemoryCashRepository,
  MemoryDocumentRepository,
  MemoryEventRepository,
  MemoryLedgerTransactionRepository,
  MemoryListingRepository,
  MemoryStagedInvoiceRepository,
  MemoryCredentialUseCaseRepository,
  MemoryCredentialUseCaseTemplateRepository,
  MemoryUseCaseRepository,
  MemoryUserRepository,
  MemoryVerificationRequestRepository,
  MemoryWebhookDeliveryRepository,
  MemoryWebhookEndpointRepository,
} from "../src/persistence/memory/index.js";
import { ensurePlatformIssuerOrg } from "../src/shared/platform-org.js";
import { provisionTreasury } from "../src/shared/wallets.js";
import type { IdentityRegistry } from "../src/identity/registry.js";
import { DEFAULT_USERS, seedDefaults } from "../src/shared/seed.js";
import { seedUseCases } from "../src/tokenization/use-cases.js";

/** Demo market escrow used by tests unless a test explicitly overrides it (pass `marketEscrowAccount: undefined` to disable the market). */
export const TEST_MARKET_ESCROW = "0xcd3B766CCDd6AE721141F452C550Ca635964ce71";

/** A second seeded PlatformAdmin (test-only) — the SoD checker for null-scope / brand-new-use-case onboarding proposals the sole admin proposes. */
export const PLATFORM_ADMIN_2 = { email: "admin2@tokenlayer.dev", password: "admin123" } as const;

export interface TestAppOptions { loginRateLimitMax?: number; apiKeyRateLimitMax?: number; apiKeyFailedAttemptMax?: number; apiKeyReserveIntervalMs?: number; platformFeeAccount?: string; marketEscrowAccount?: string; trustedKycIssuers?: string[]; devIssuerSeed?: string; isProduction?: boolean; didMasterConfigured?: boolean; registry?: IdentityRegistry; enabledDomains?: string[]; subjectIdentifiers?: "did" | "plain"; brandLogoPruneGraceMs?: number }

/**
 * The app plus the repositories tests need to reach directly — used where a
 * fixture cannot be built through the HTTP surface (e.g. an API key before its
 * management routes exist). `buildTestApp` is the app-only shorthand.
 */
export interface TestAppHandle {
  app: FastifyInstance;
  users: MemoryUserRepository;
  apiKeys: MemoryApiKeyRepository;
  loginKeys: MemoryLoginKeyRepository;
  organizations: MemoryOrganizationRepository;
  audit: MemoryAuditRepository;
  /**
   * The very deps this app was built over. Needed where a test must drive a
   * NON-HTTP path of the same instance — EN-C's emit/fan-out is the case:
   * `emitEvent(deps, …)` is what a domain route calls internally, and the
   * webhook tests have to prove which endpoints a real fan-out reaches.
   */
  deps: AppDeps;
}

export async function buildTestApp(opts: TestAppOptions = {}): Promise<FastifyInstance> {
  return (await buildTestAppWithRepos(opts)).app;
}

export async function buildTestAppWithRepos(opts: TestAppOptions = {}): Promise<TestAppHandle> {
  const rbac = new RbacPolicy();
  const chains = buildChainRegistry({ CHAIN_STRICT: "0" }); // simulated chains only — besu absent, never mocked
  const users = new MemoryUserRepository();
  const assets = new MemoryAssetRepository();
  const audit = new MemoryAuditRepository();
  const auditAnchors = new MemoryAuditAnchorRepository();
  const accounts = new MemoryAccountRepository();
  const useCases = new MemoryUseCaseRepository();
  const credentialUseCases = new MemoryCredentialUseCaseRepository();
  const credentialTemplates = new MemoryCredentialUseCaseTemplateRepository();
  const cash = new MemoryCashRepository();
  const listings = new MemoryListingRepository();
  const documents = new MemoryDocumentRepository();
  const cashflows = new MemoryCashflowRepository();
  const proposals = new MemoryProposalRepository();
  const organizations = new MemoryOrganizationRepository();
  const credentials = new MemoryCredentialRepository();
  const verificationRequests = new MemoryVerificationRequestRepository();
  const stagedInvoices = new MemoryStagedInvoiceRepository();
  const apiKeys = new MemoryApiKeyRepository();
  const events = new MemoryEventRepository();
  const webhookEndpoints = new MemoryWebhookEndpointRepository();
  const webhookDeliveries = new MemoryWebhookDeliveryRepository();
  const ledgerTransactions = new MemoryLedgerTransactionRepository();
  const loginKeys = new MemoryLoginKeyRepository();
  const keystore = createKeystore("11".repeat(32));
  // seedDefaults now creates the second PlatformAdmin (admin2@tokenlayer.dev) so
  // gated onboarding of a brand-new use case's FIRST UseCaseAdmin (and any
  // null-scope user) has an eligible second approver: SoD forbids
  // proposer===approver, and only PlatformAdmins can approve those proposals.
  await seedDefaults(users, accounts);
  const engine = createEngine(useCases, rbac, chains, audit, { users, accounts, credentials });
  const platformOrg = await ensurePlatformIssuerOrg({ organizations, keystore, registry: opts.registry });
  await seedUseCases(useCases, platformOrg.id, (label) => provisionTreasury({ accounts }, platformOrg.id, label), {
    availableChainIds: new Set(chains.list().map((c) => c.id)),
    deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
  });
  // The suite makes many logins from one IP; raise the throttle unless a test opts into it.
  const deps: AppDeps = {
    useCases, credentialUseCases, credentialTemplates, rbac, engine, users, assets, audit, auditAnchors, accounts, chains, cash, listings, documents, cashflows, proposals,
    organizations, credentials, verificationRequests, stagedInvoices, apiKeys, events, webhookEndpoints, webhookDeliveries, ledgerTransactions,
    // The harness never delivers anything (no dispatcher runs in tests); this is
    // the registration-time posture, and the secure default is the right one to
    // exercise by default.
    webhooksAllowInsecure: false,
    // A fixed test master key: the suite needs `open(seal(x)) === x` across a
    // single app instance, not secrecy.
    secretBox: createSecretBox("22".repeat(32)),
    keystore, didMasterConfigured: opts.didMasterConfigured ?? true,
    challenges: createMemoryChallengeStore(), loginKeys, qrLogin: createMemoryQrLoginStore(), publicWebUrl: "http://localhost:5173", enabledDomains: opts.enabledDomains ?? ["tokenization", "identity"], subjectIdentifiers: opts.subjectIdentifiers, trustedKycIssuers: opts.trustedKycIssuers,
    devIssuerSeed: opts.devIssuerSeed, isProduction: opts.isProduction,
    currencies: loadCurrencies(), jwtSecret: "test-secret", publicApiUrl: "http://test.local/api/v1",
    loginRateLimitMax: opts.loginRateLimitMax ?? 100000,
    // As with loginRateLimitMax: the suite makes many key requests per instance,
    // so the production default (600/min) would eventually fail a test file for
    // reasons that look nothing like its subject. Tests that are ABOUT the limit
    // set it low explicitly.
    apiKeyRateLimitMax: opts.apiKeyRateLimitMax ?? 100000,
    apiKeyFailedAttemptMax: opts.apiKeyFailedAttemptMax,
    apiKeyReserveIntervalMs: opts.apiKeyReserveIntervalMs,
    platformFeeAccount: opts.platformFeeAccount,
    // Enabled by default so market routes are testable; an explicit
    // `marketEscrowAccount: undefined` disables the market (503s).
    marketEscrowAccount: "marketEscrowAccount" in opts ? opts.marketEscrowAccount : TEST_MARKET_ESCROW,
    registry: opts.registry,
    // 0 by default: almost every test's uploads happen milliseconds apart on
    // purpose (that's the whole point of testing "the second prunes the
    // first"), and the production default (60s) would make every one of them
    // wait real wall-clock time to see a delete. Tests that specifically want
    // to prove the production grace period protects a fresh sibling pass
    // `BRAND_LOGO_PRUNE_GRACE_MS` explicitly.
    brandLogoPruneGraceMs: opts.brandLogoPruneGraceMs ?? 0,
  };
  return { app: await buildApp(deps), users, apiKeys, loginKeys, organizations, audit, deps };
}

/** All v1 API routes live under this prefix. */
export const V1 = "/api/v1";

/** Login by explicit email + password (preferred — unambiguous in the per-use-case model). */
export async function loginAs(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email, password } });
  return res.json().token as string;
}

/**
 * Gated onboarding for tests: POST /users now returns a proposal; a second
 * user-manager approves it. Returns the created user's summary (from GET /users).
 * `maker` proposes, `checker` approves — they MUST be different managers who can
 * both see the proposal's scope (SELF_APPROVAL forbids proposer===approver).
 */
interface UserSummary { id: string; email: string; role: string; useCaseKey: string | null; accountId: string | null; kycStatus: string; kyc: Record<string, unknown> | null }
export async function onboardUser(
  app: FastifyInstance, maker: string, checker: string,
  body: { email: string; password: string; role: string; useCaseKey?: string; walletAddress?: string; kyc?: Record<string, unknown> },
): Promise<UserSummary> {
  const res = await app.inject({ method: "POST", url: `${V1}/users`, headers: { authorization: `Bearer ${maker}` }, payload: body });
  if (res.statusCode !== 202) throw new Error(`onboardUser expected 202, got ${res.statusCode}: ${res.payload}`);
  const proposalId = res.json().proposal.id;
  const ap = await app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: { authorization: `Bearer ${checker}` }, payload: {} });
  if (ap.statusCode !== 200) throw new Error(`onboardUser approve expected 200, got ${ap.statusCode}: ${ap.payload}`);
  const list = await app.inject({ method: "GET", url: `${V1}/users`, headers: { authorization: `Bearer ${checker}` } });
  const user = (list.json() as UserSummary[]).find((u) => u.email === body.email);
  if (!user) throw new Error(`onboardUser: user ${body.email} not found after approval`);
  return user;
}

/** Issue an asset for the given use case key, returning the new asset's id. */
export async function issueAsset(app: FastifyInstance, token: string, useCaseKey: string): Promise<string> {
  const meta: Record<string, Record<string, unknown>> = {
    "carbon-credit": { projectName: "P", registry: "Verra", vintage: 2024 },
    "gold-loan": { borrower: "R", goldWeightGrams: 1, loanAmountInr: 1 },
    "corporate-bond": { issuer: "ACME", isin: "X", faceValue: 1 },
  };
  const res = await app.inject({
    method: "POST",
    url: `${V1}/assets`,
    headers: { authorization: `Bearer ${token}` },
    payload: { useCaseKey, name: "T", symbol: "T", chainId: "fabric", metadata: meta[useCaseKey] ?? {} },
  });
  if (res.statusCode !== 201) throw new Error(`issueAsset(${useCaseKey}) failed: ${res.statusCode} ${res.body}`);
  return res.json().asset.id as string;
}

export function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/**
 * The real, server-derived treasury address for a use case (org-treasury-accounts
 * Task 5: the treasury is the use case's own registered `Account`, resolved from
 * `treasuryAccountId` — never client-supplied). Tests that used to pass an
 * arbitrary `treasuryAccount` in the issue payload and then assert against that
 * same literal must instead look the real address up here, since the platform
 * now picks it. `token` needs read access to both endpoints (a platform token
 * always qualifies).
 */
export async function treasuryAddressOf(app: FastifyInstance, token: string, useCaseKey: string): Promise<string> {
  const uc = await app.inject({ method: "GET", url: `${V1}/use-cases/${useCaseKey}`, headers: auth(token) });
  if (uc.statusCode !== 200) throw new Error(`treasuryAddressOf(${useCaseKey}): GET use-case failed ${uc.statusCode}: ${uc.body}`);
  const treasuryAccountId = uc.json().treasuryAccountId as string | null | undefined;
  if (!treasuryAccountId) throw new Error(`treasuryAddressOf(${useCaseKey}): use case has no treasuryAccountId`);
  const accts = await app.inject({ method: "GET", url: `${V1}/accounts`, headers: auth(token) });
  if (accts.statusCode !== 200) throw new Error(`treasuryAddressOf(${useCaseKey}): GET accounts failed ${accts.statusCode}: ${accts.body}`);
  const acct = (accts.json() as { id: string; address: string }[]).find((a) => a.id === treasuryAccountId);
  if (!acct) throw new Error(`treasuryAddressOf(${useCaseKey}): account ${treasuryAccountId} not in GET /accounts`);
  return acct.address;
}

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const ACCOUNTS = { ALICE, BOB };

// ---------------------------------------------------------------------------
// Legacy role-based login — kept for any tests that still use old-style roles.
// Maps by the first seeded user with that role (PlatformAdmin → admin@…, etc.).
// ---------------------------------------------------------------------------
const PASSWORDS: Record<string, string> = {};
const EMAILS: Record<string, string> = {};
// First-wins so each role maps to its FIRST seeded user (e.g. PlatformAdmin →
// admin@…, not the later admin2@… added for SoD).
for (const u of DEFAULT_USERS) {
  if (!(u.role in EMAILS)) { EMAILS[u.role] = u.email; PASSWORDS[u.role] = u.password; }
}

/** @deprecated Prefer loginAs(app, email, password). */
export async function login(app: FastifyInstance, role: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `${V1}/auth/login`,
    payload: { email: EMAILS[role], password: PASSWORDS[role] },
  });
  return res.json().token as string;
}
