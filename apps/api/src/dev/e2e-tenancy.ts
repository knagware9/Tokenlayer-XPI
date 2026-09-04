import { RbacPolicy } from "@tokenlayer/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { buildChainRegistry } from "../shared/chains.js";
import { createEngine } from "../context.js";
import { createMemoryChallengeStore } from "../identity/identity-challenges.js";
import { createMemoryQrLoginStore } from "../identity/qr-login-sessions.js";
import { createKeystore } from "../shared/keystore.js";
import { createSecretBox } from "../webhooks/secret-box.js";
import { NullMailer } from "../mail/mailer.js";
import { loadCurrencies } from "../tokenization/currencies.js";
import { ensurePlatformIssuerOrg } from "../shared/platform-org.js";
import { provisionTreasury } from "../shared/wallets.js";
import { MemoryAccountRepository, MemoryApiKeyRepository, MemoryAssetRepository, MemoryAuditAnchorRepository, MemoryAuditRepository, MemoryCashRepository,
  MemoryCashflowRepository,
  MemoryProposalRepository,
  MemoryDocumentRepository,
  MemoryEventRepository,
  MemoryCredentialRepository,
  MemoryOrganizationRepository,
  MemoryPasswordResetTokenRepository,
  MemoryListingRepository,
  MemoryLoginKeyRepository,
  MemoryStagedInvoiceRepository,
  MemoryWebhookDeliveryRepository,
  MemoryLedgerTransactionRepository,
  MemoryWebhookEndpointRepository,
  MemoryCredentialUseCaseRepository, MemoryCredentialUseCaseTemplateRepository, MemoryUseCaseRepository, MemoryUserRepository, MemoryVerificationRequestRepository } from "../persistence/memory/index.js";
import { seedDefaults } from "../shared/seed.js";
import { seedUseCases } from "../tokenization/use-cases.js";

let failures = 0;
const check = (label: string, ok: boolean): void => { console.log(`   ${ok ? "✓" : "✗"} ${label}`); if (!ok) failures++; };

async function main(): Promise<void> {
  const rbac = new RbacPolicy();
  const chains = buildChainRegistry({ ...process.env, CHAIN_STRICT: process.env.CHAIN_STRICT ?? "0" });
  const users = new MemoryUserRepository();
  const assets = new MemoryAssetRepository();
  const audit = new MemoryAuditRepository();
  const auditAnchors = new MemoryAuditAnchorRepository();
  const accounts = new MemoryAccountRepository();
  const useCases = new MemoryUseCaseRepository();
  const organizations = new MemoryOrganizationRepository();
  const keystore = createKeystore("11".repeat(32));
  await seedDefaults(users, accounts); // Platform Admin + per-use-case rosters
  const engine = createEngine(useCases, rbac, chains, audit);
  const platformOrg = await ensurePlatformIssuerOrg({ organizations, keystore, registry: undefined });
  await seedUseCases(useCases, platformOrg.id, (label) => provisionTreasury({ accounts }, platformOrg.id, label), {
    availableChainIds: new Set(chains.list().map((c) => c.id)),
    deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
  });
  const cash = new MemoryCashRepository();
  const listings = new MemoryListingRepository();
  const app = await buildApp({ useCases, credentialUseCases: new MemoryCredentialUseCaseRepository(), credentialTemplates: new MemoryCredentialUseCaseTemplateRepository(), rbac, engine, users, assets, audit, auditAnchors, accounts, chains, cash, listings, documents: new MemoryDocumentRepository(), cashflows: new MemoryCashflowRepository(), proposals: new MemoryProposalRepository(), organizations, credentials: new MemoryCredentialRepository(), verificationRequests: new MemoryVerificationRequestRepository(), stagedInvoices: new MemoryStagedInvoiceRepository(), apiKeys: new MemoryApiKeyRepository(), passwordResetTokens: new MemoryPasswordResetTokenRepository(), events: new MemoryEventRepository(), webhookEndpoints: new MemoryWebhookEndpointRepository(), webhookDeliveries: new MemoryWebhookDeliveryRepository(), ledgerTransactions: new MemoryLedgerTransactionRepository(), webhooksAllowInsecure: false, secretBox: createSecretBox("22".repeat(32)), mail: new NullMailer(), keystore, didMasterConfigured: true, challenges: createMemoryChallengeStore(), loginKeys: new MemoryLoginKeyRepository(), qrLogin: createMemoryQrLoginStore(), publicWebUrl: "http://localhost:5173", enabledDomains: ["tokenization", "identity"], currencies: loadCurrencies(), jwtSecret: "e2e", publicApiUrl: "http://localhost:4000/api/v1" });

  const platform = await login(app, "admin@tokenlayer.dev", "admin123");
  const carbonAdmin = await login(app, "carbon.admin@tokenlayer.dev", "carbon123");
  const carbonIssuer = await login(app, "carbon.issuer@tokenlayer.dev", "carbon123");
  const goldIssuer = await login(app, "gold.issuer@tokenlayer.dev", "gold123");

  const buyerWallet = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
  const secondWallet = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";

  const newBuyer = await post(app, "/users", carbonAdmin, { email: "extra.buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: buyerWallet });
  check("UseCaseAdmin creates a scoped Buyer with a wallet", newBuyer.status === 201 && newBuyer.body.useCaseKey === "carbon-credit");
  check("UseCaseAdmin cannot create a UseCaseAdmin", (await post(app, "/users", carbonAdmin, { email: "x@x.dev", password: "secret1", role: "UseCaseAdmin" })).status === 403);

  const issue = await post(app, "/assets", carbonIssuer, { useCaseKey: "carbon-credit", name: "VCU Test", symbol: "VCUT", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 } });
  check("Carbon Issuer issues a credit", issue.status === 201);
  const id = issue.body.asset.id as string;
  await post(app, `/assets/${id}/actions/allow`, carbonIssuer, { account: buyerWallet });
  check("Carbon Issuer mints to the buyer wallet", (await post(app, `/assets/${id}/actions/mint`, carbonIssuer, { to: buyerWallet, amount: "1000" })).status === 200);

  await post(app, `/assets/${id}/actions/allow`, carbonIssuer, { account: secondWallet });
  check("Carbon Admin settles a transfer", (await post(app, `/assets/${id}/actions/transfer`, carbonAdmin, { from: buyerWallet, to: secondWallet, amount: "100" })).status === 200);
  check("Carbon Issuer cannot transfer (role)", (await post(app, `/assets/${id}/actions/transfer`, carbonIssuer, { from: buyerWallet, to: secondWallet, amount: "1" })).status === 403);

  check("Gold Issuer cannot read the carbon asset (404)", (await get(app, `/assets/${id}`, goldIssuer)).status === 404);
  check("Gold Issuer cannot act on the carbon asset (403)", (await post(app, `/assets/${id}/actions/mint`, goldIssuer, { to: buyerWallet, amount: "1" })).status === 403);
  const goldIssue = await post(app, "/assets", goldIssuer, { useCaseKey: "gold-loan", name: "GL Test", symbol: "GLT", chainId: "fabric", metadata: { borrower: "R", goldWeightGrams: 1, loanAmountInr: 1 } });
  check("Gold Issuer issues a gold-loan asset", goldIssue.status === 201);
  const goldList = await get(app, "/assets?limit=50", goldIssuer);
  const goldRows = goldList.body.data as { useCaseKey: string }[];
  check("Gold Issuer's list is non-empty and excludes carbon assets", goldRows.length > 0 && goldRows.every((a) => a.useCaseKey === "gold-loan"));

  await app.close();
  console.log(failures === 0 ? "\n✅ TENANCY E2E PASSED" : `\n❌ FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

async function login(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
  return res.json().token as string;
}
async function post(app: FastifyInstance, url: string, token: string, payload: unknown) {
  const res = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
}
async function get(app: FastifyInstance, url: string, token: string) {
  const res = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  return { status: res.statusCode, body: res.json() };
}

main().catch((err) => { console.error(err); process.exit(1); });
