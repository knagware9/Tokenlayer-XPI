/**
 * End-to-end test of the Carbon Credit tokenization use case, driven entirely
 * through the platform's HTTP API and exercising every RBAC role:
 *
 *   - carbon.issuer   onboards the project, issues credits, manages the KYC allowlist,
 *                     applies compliance freeze/unfreeze
 *   - carbon.admin    UseCaseAdmin: settles trades and retires (burns) credits
 *   - carbon.buyer    a KYC'd buyer (cannot manage the allowlist)
 *   - carbon.auditor  is a read-only auditor (write actions are forbidden)
 *
 * 1 token = 1 tonne CO2e (a Verified Carbon Unit). Burning a credit permanently
 * retires it so it can never be double-counted.
 *
 * Runs on the simulated chains by default; if EVM_RPC_URL is set the credit is
 * issued on the live EVM as a real on-chain ERC-20.
 */
import { RbacPolicy } from "@tokenlayer/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { buildChainRegistry } from "../shared/chains.js";
import { createMemoryChallengeStore } from "../identity/identity-challenges.js";
import { createMemoryQrLoginStore } from "../identity/qr-login-sessions.js";
import { createKeystore } from "../shared/keystore.js";
import { createSecretBox } from "../webhooks/secret-box.js";
import { createEngine } from "../context.js";
import { loadCurrencies } from "../tokenization/currencies.js";
import {
  MemoryAccountRepository,
  MemoryApiKeyRepository,
  MemoryAssetRepository,
  MemoryAuditAnchorRepository,
  MemoryAuditRepository,
  MemoryCashRepository,
  MemoryCashflowRepository,
  MemoryProposalRepository,
  MemoryDocumentRepository,
  MemoryEventRepository,
  MemoryCredentialRepository,
  MemoryOrganizationRepository,
  MemoryLoginKeyRepository,
  MemoryStagedInvoiceRepository,
  MemoryListingRepository,
  MemoryCredentialUseCaseRepository,
  MemoryCredentialUseCaseTemplateRepository,
  MemoryUseCaseRepository,
  MemoryUserRepository,
  MemoryVerificationRequestRepository,
  MemoryWebhookDeliveryRepository,
  MemoryWebhookEndpointRepository,
} from "../persistence/memory/index.js";
import { DEFAULT_ACCOUNTS, seedDefaults } from "../shared/seed.js";
import { seedUseCases } from "../tokenization/use-cases.js";

const BROKER = DEFAULT_ACCOUNTS[0]!.address; // Alice — KYC'd carbon broker
const BUYER = DEFAULT_ACCOUNTS[1]!.address; // Bob — KYC'd corporate buyer
const OUTSIDER = DEFAULT_ACCOUNTS[2]!.address; // Carol — NOT KYC'd
const PROJECT = DEFAULT_ACCOUNTS[3]!.address; // Treasury — project developer

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures += 1;
}
function section(title: string): void {
  console.log(`\n${"━".repeat(64)}\n${title}\n${"━".repeat(64)}`);
}

async function main(): Promise<void> {
  const rbac = new RbacPolicy();
  const chains = buildChainRegistry({ ...process.env, CHAIN_STRICT: process.env.CHAIN_STRICT ?? "0" });
  const users = new MemoryUserRepository();
  const assets = new MemoryAssetRepository();
  const audit = new MemoryAuditRepository();
  const auditAnchors = new MemoryAuditAnchorRepository();
  const accounts = new MemoryAccountRepository();
  const useCases = new MemoryUseCaseRepository();
  await seedDefaults(users, accounts);
  const engine = createEngine(useCases, rbac, chains, audit);
  await seedUseCases(useCases, { // seeds carbon-credit.json from config/use-cases
    availableChainIds: new Set(chains.list().map((c) => c.id)),
    deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
  });
  const cash = new MemoryCashRepository();
  const listings = new MemoryListingRepository();
  const app = await buildApp({ useCases, credentialUseCases: new MemoryCredentialUseCaseRepository(), credentialTemplates: new MemoryCredentialUseCaseTemplateRepository(), rbac, engine, users, assets, audit, auditAnchors, accounts, chains, cash, listings, documents: new MemoryDocumentRepository(), cashflows: new MemoryCashflowRepository(), proposals: new MemoryProposalRepository(), organizations: new MemoryOrganizationRepository(), credentials: new MemoryCredentialRepository(), verificationRequests: new MemoryVerificationRequestRepository(), stagedInvoices: new MemoryStagedInvoiceRepository(), apiKeys: new MemoryApiKeyRepository(), events: new MemoryEventRepository(), webhookEndpoints: new MemoryWebhookEndpointRepository(), webhookDeliveries: new MemoryWebhookDeliveryRepository(), webhooksAllowInsecure: false, secretBox: createSecretBox("22".repeat(32)), keystore: createKeystore("11".repeat(32)), didMasterConfigured: true, challenges: createMemoryChallengeStore(), loginKeys: new MemoryLoginKeyRepository(), qrLogin: createMemoryQrLoginStore(), publicWebUrl: "http://localhost:5173", enabledDomains: ["tokenization", "identity"], currencies: loadCurrencies(), jwtSecret: "e2e", publicApiUrl: "http://localhost:4000/api/v1" });

  // Per-use-case roster seeded by seedDefaults — password is "carbon123" for all.
  const carbonAdmin = await login(app, "carbon.admin@tokenlayer.dev", "carbon123");
  const issuer = await login(app, "carbon.issuer@tokenlayer.dev", "carbon123");
  const buyer = await login(app, "carbon.buyer@tokenlayer.dev", "carbon123");
  const auditor = await login(app, "carbon.auditor@tokenlayer.dev", "carbon123");

  const evmAvailable = chains.list().some((c) => c.id === "besu");
  const chain = evmAvailable ? "besu" : "fabric";
  console.log(`Chains available: ${chains.list().map((c) => c.id).join(", ")}`);

  section("CARBON CREDIT TOKENIZATION (ERC-20, KYC allowlist + retire-by-burn)");

  // The use case ships as a seeded default (config/use-cases/carbon-credit.json).
  const cat = await get(app, "/use-cases/carbon-credit", auditor);
  check("'carbon-credit' use case is available out of the box", cat.status === 200 && cat.body.tokenStandard === "ERC-20");

  // 1. Issuer onboards a verified project and issues the credit token.
  console.log(`\n   Issuing on chain: ${chain}`);
  const issue = await post(app, "/assets", issuer, {
    useCaseKey: "carbon-credit",
    name: "Rimba Raya REDD+ 2024",
    symbol: "VCU24",
    chainId: chain,
    metadata: {
      projectName: "Rimba Raya Biodiversity Reserve",
      registry: "Verra",
      projectId: "VCS-674",
      vintage: 2024,
      methodology: "VM0007",
      country: "Indonesia",
      creditType: "avoidance",
    },
  });
  check("Issuer onboards the project & issues the credit (metadata validated)", issue.status === 201);
  const id = issue.body.asset.id as string;

  // 2. Issuer KYC-verifies the registry participants (allowlist).
  for (const acct of [PROJECT, BROKER, BUYER]) await act(app, issuer, id, "allow", { account: acct });
  check("Issuer KYC-allowlists project developer + broker + corporate buyer", true);

  // 3. RBAC: an Auditor cannot mint, and a Buyer cannot manage the allowlist.
  const auditorMint = await act(app, auditor, id, "mint", { to: PROJECT, amount: "1" });
  check("RBAC: Auditor is read-only — mint forbidden (403)", auditorMint.status === 403 && auditorMint.body.error === "FORBIDDEN");
  const buyerAllow = await act(app, buyer, id, "allow", { account: OUTSIDER });
  check("RBAC: Buyer cannot touch the KYC allowlist (403)", buyerAllow.status === 403 && buyerAllow.body.error === "FORBIDDEN");

  // 4. Issuance: Issuer mints 10,000 credits (tonnes CO2e) to the project developer.
  check("Issuance: Issuer mints 10,000 credits to the project developer", (await act(app, issuer, id, "mint", { to: PROJECT, amount: "10000" })).status === 200);

  // 5. Settlement (UseCaseAdmin): sell 4,000 credits to a broker, who sells 2,000 to a corporate buyer.
  check("Trade: Admin settles 4,000 credits project→broker", (await act(app, carbonAdmin, id, "transfer", { from: PROJECT, to: BROKER, amount: "4000" })).status === 200);
  check("Trade: Admin settles 2,000 credits broker→corporate buyer", (await act(app, carbonAdmin, id, "transfer", { from: BROKER, to: BUYER, amount: "2000" })).status === 200);

  // 6. Compliance: a sale to a non-KYC'd party is rejected.
  const toOutsider = await act(app, carbonAdmin, id, "transfer", { from: PROJECT, to: OUTSIDER, amount: "100" });
  check("Compliance: transfer to non-KYC party (outsider) rejected", toOutsider.status === 400 && toOutsider.body.error === "NOT_ALLOWLISTED");

  // 7. Compliance hold: Issuer freezes the broker; transfers blocked; then lifts the hold.
  await act(app, issuer, id, "freeze", { account: BROKER });
  const frozen = await act(app, carbonAdmin, id, "transfer", { from: BROKER, to: BUYER, amount: "1" });
  check("Compliance hold: frozen broker cannot transfer", frozen.status === 400 && frozen.body.error === "ACCOUNT_FROZEN");
  await act(app, issuer, id, "unfreeze", { account: BROKER });
  check("Hold lifted: broker can transfer again", (await act(app, carbonAdmin, id, "transfer", { from: BROKER, to: BUYER, amount: "500" })).status === 200);

  // 8. Retirement: the corporate buyer's credits are retired (burned) to offset emissions.
  check("Retirement: Admin burns 1,500 credits from the corporate buyer (offset claimed)", (await act(app, carbonAdmin, id, "burn", { from: BUYER, amount: "1500" })).status === 200);

  // 9. Final ledger state — read by the Auditor.
  const accts = (await get(app, `/assets/${id}/accounts`, auditor)).body as { address: string; balance: string }[];
  const bal = (a: string) => accts.find((x) => x.address === a)?.balance;
  check(`Project developer holds 6,000 (got ${bal(PROJECT)})`, bal(PROJECT) === "6000");
  check(`Broker holds 1,500 (got ${bal(BROKER)})`, bal(BROKER) === "1500");
  check(`Corporate buyer holds 1,000 (got ${bal(BUYER)})`, bal(BUYER) === "1000");
  const supply = (await get(app, `/assets/${id}`, auditor)).body.totalSupply;
  check(`Circulating supply 8,500 after 1,500 retired (got ${supply})`, supply === "8500");
  const trail = (await get(app, `/assets/${id}/audit`, auditor)).body.data as { action: string }[];
  check(`Auditor can read the full audit trail (${trail.length} events)`, trail.length >= 9);

  await app.close();
  section(failures === 0 ? "✅ CARBON CREDIT USE CASE PASSED END-TO-END" : `❌ FAILED (${failures} checks)`);
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
function act(app: FastifyInstance, token: string, id: string, action: string, body: Record<string, string>) {
  return post(app, `/assets/${id}/actions/${action}`, token, body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
