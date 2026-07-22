/**
 * End-to-end test of the Marketplace Buy (DvP) flow with CBDC payment.
 *
 * Exercises the full buyer journey:
 *   - Admin issues a fungible asset with sale terms (unitPrice + currency + treasuryAccount)
 *   - Admin KYC-allowlists buyer and treasury wallets
 *   - Admin mints tokens to treasury
 *   - Admin funds buyer's wallet with CBDC via POST /cash/credit
 *   - Buyer calls POST /assets/:id/buy — validates allowlist + balances, settles DvP atomically
 *   - Insufficient-funds case: buy is rejected with INSUFFICIENT_FUNDS, cash unchanged
 *   - Not-allowlisted case: buy on a second asset where buyer is NOT allowlisted returns 400,
 *     and the buyer's cash balance is unchanged (refund path verified)
 */
import { RbacPolicy } from "@tokenlayer/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { buildChainRegistry } from "./chains.js";
import { createMemoryChallengeStore } from "./identity-challenges.js";
import { createKeystore } from "./keystore.js";
import { createEngine } from "./context.js";
import { loadCurrencies } from "./currencies.js";
import {
  MemoryAccountRepository,
  MemoryAssetRepository,
  MemoryAuditAnchorRepository,
  MemoryAuditRepository,
  MemoryCashRepository,
  MemoryCashflowRepository,
  MemoryProposalRepository,
  MemoryDocumentRepository,
  MemoryCredentialRepository,
  MemoryOrganizationRepository,
  MemoryStagedInvoiceRepository,
  MemoryListingRepository,
  MemoryUseCaseRepository,
  MemoryUserRepository,
  MemoryVerificationRequestRepository,
} from "./persistence/memory.js";
import { DEFAULT_ACCOUNTS, seedDefaults } from "./seed.js";
import { seedUseCases } from "./use-cases.js";

const BUYER_WALLET = DEFAULT_ACCOUNTS[4]!.address; // "EcoFund Capital" — carbon.buyer's wallet
const TREASURY = DEFAULT_ACCOUNTS[3]!.address;     // "Treasury" — will hold the minted tokens

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
  const app = await buildApp({ useCases, rbac, engine, users, assets, audit, auditAnchors, accounts, chains, cash, listings, documents: new MemoryDocumentRepository(), cashflows: new MemoryCashflowRepository(), proposals: new MemoryProposalRepository(), organizations: new MemoryOrganizationRepository(), credentials: new MemoryCredentialRepository(), verificationRequests: new MemoryVerificationRequestRepository(), stagedInvoices: new MemoryStagedInvoiceRepository(), keystore: createKeystore("11".repeat(32)), didMasterConfigured: true, challenges: createMemoryChallengeStore(), currencies: loadCurrencies(), jwtSecret: "e2e", publicApiUrl: "http://localhost:4000/api/v1" });

  // Per-use-case roster seeded by seedDefaults — password is "carbon123" for all.
  const adminToken = await login(app, "carbon.admin@tokenlayer.dev", "carbon123");
  const buyerToken = await login(app, "carbon.buyer@tokenlayer.dev", "carbon123");

  section("MARKETPLACE BUY + CBDC PAYMENT (DvP)");

  // ── 1. Admin issues a fungible asset with sale terms ──────────────────────
  const issue = await post(app, "/assets", adminToken, {
    useCaseKey: "carbon-credit",
    name: "DvP Test",
    symbol: "DVP",
    chainId: "fabric",
    metadata: {
      projectName: "DvP Test Project",
      registry: "Gold Standard",
      projectId: "GS-TEST",
      vintage: 2025,
      methodology: "GS-VER",
      country: "India",
      creditType: "reduction",
    },
    sale: {
      unitPrice: "5",
      currency: "CBDC-INR",
      treasuryAccount: TREASURY,
    },
  });
  check("Admin issues asset with sale terms (201)", issue.status === 201);
  const assetId = issue.body.asset?.id as string;

  // ── 2. Admin KYC-allowlists TREASURY + BUYER_WALLET ──────────────────────
  const allowTreasury = await act(app, adminToken, assetId, "allow", { account: TREASURY });
  check("Admin allows TREASURY (200)", allowTreasury.status === 200);
  const allowBuyer = await act(app, adminToken, assetId, "allow", { account: BUYER_WALLET });
  check("Admin allows BUYER_WALLET (200)", allowBuyer.status === 200);

  // ── 3. Admin mints 100 tokens to TREASURY ────────────────────────────────
  const mint = await act(app, adminToken, assetId, "mint", { to: TREASURY, amount: "100" });
  check("Admin mints 100 tokens to TREASURY (200)", mint.status === 200);

  const accts1 = (await get(app, `/assets/${assetId}/accounts`, adminToken)).body as { address: string; balance: string }[];
  const treasuryBal1 = accts1.find((x) => x.address === TREASURY)?.balance;
  check(`TREASURY token balance = "100" (got ${treasuryBal1})`, treasuryBal1 === "100");

  // ── 4. Admin funds BUYER_WALLET with 1000 CBDC-INR ───────────────────────
  const credit = await post(app, "/cash/credit", adminToken, {
    account: BUYER_WALLET,
    currency: "CBDC-INR",
    amount: "1000",
  });
  check("Admin credits buyer 1000 CBDC-INR (200)", credit.status === 200);

  // Verify via GET /cash/balances
  const balances1 = (await get(app, `/cash/balances?address=${BUYER_WALLET}`, adminToken)).body as { currency: string; address: string; amount: string }[];
  const buyerCbdc1 = balances1.find((b) => b.currency === "CBDC-INR")?.amount;
  check(`GET /cash/balances returns buyer CBDC-INR = "1000" (got ${buyerCbdc1})`, buyerCbdc1 === "1000");

  // ── 5. Buyer buys 10 tokens ───────────────────────────────────────────────
  const buy = await post(app, `/assets/${assetId}/buy`, buyerToken, { quantity: "10" });
  check("Buyer buys 10 tokens (200)", buy.status === 200);
  const buyBody = buy.body as Record<string, Record<string, string>>;
  check(`buy response: paid.amount = "50"`, buyBody.paid?.amount === "50");
  check(`buy response: paid.currency = "CBDC-INR"`, buyBody.paid?.currency === "CBDC-INR");
  check(`buy response: delivered.to = BUYER_WALLET`, buyBody.delivered?.to === BUYER_WALLET);

  // Verify CBDC balances after buy (cost = 10 * 5 = 50)
  const buyerBalances2 = (await get(app, `/cash/balances?address=${BUYER_WALLET}`, adminToken)).body as { currency: string; amount: string }[];
  const buyerCbdc2 = buyerBalances2.find((b) => b.currency === "CBDC-INR")?.amount;
  check(`Buyer CBDC-INR = "950" after buy (got ${buyerCbdc2})`, buyerCbdc2 === "950");

  const treasuryBalances2 = (await get(app, `/cash/balances?address=${TREASURY}`, adminToken)).body as { currency: string; amount: string }[];
  const treasuryCbdc2 = treasuryBalances2.find((b) => b.currency === "CBDC-INR")?.amount;
  check(`TREASURY CBDC-INR = "50" after buy (got ${treasuryCbdc2})`, treasuryCbdc2 === "50");

  // Verify token balances after buy
  const accts2 = (await get(app, `/assets/${assetId}/accounts`, adminToken)).body as { address: string; balance: string }[];
  const buyerTokenBal = accts2.find((x) => x.address === BUYER_WALLET)?.balance;
  const treasuryTokenBal = accts2.find((x) => x.address === TREASURY)?.balance;
  check(`Buyer token balance = "10" (got ${buyerTokenBal})`, buyerTokenBal === "10");
  check(`TREASURY token balance = "90" (got ${treasuryTokenBal})`, treasuryTokenBal === "90");

  // ── 6. Buyer attempts to buy 1,000,000 tokens → INSUFFICIENT_FUNDS ────────
  const buyOver = await post(app, `/assets/${assetId}/buy`, buyerToken, { quantity: "1000000" });
  check("Overspend rejected (400)", buyOver.status === 400);
  check(`Error = INSUFFICIENT_FUNDS (got ${buyOver.body.error})`, buyOver.body.error === "INSUFFICIENT_FUNDS");

  // Cash balance must be unchanged — no deduction on failure
  const buyerBalances3 = (await get(app, `/cash/balances?address=${BUYER_WALLET}`, adminToken)).body as { currency: string; amount: string }[];
  const buyerCbdc3 = buyerBalances3.find((b) => b.currency === "CBDC-INR")?.amount;
  check(`Buyer CBDC-INR still "950" after INSUFFICIENT_FUNDS (got ${buyerCbdc3})`, buyerCbdc3 === "950");

  // ── 7. NOT_ALLOWLISTED: buy on asset2 where buyer is not allowlisted ──────
  // Issue a second asset — same sale terms, same treasury, but DON'T allow buyer
  const issue2 = await post(app, "/assets", adminToken, {
    useCaseKey: "carbon-credit",
    name: "DvP Test 2",
    symbol: "DVP2",
    chainId: "fabric",
    metadata: {
      projectName: "DvP Test Project 2",
      registry: "Gold Standard",
      projectId: "GS-TEST2",
      vintage: 2025,
      methodology: "GS-VER",
      country: "India",
      creditType: "reduction",
    },
    sale: {
      unitPrice: "5",
      currency: "CBDC-INR",
      treasuryAccount: TREASURY,
    },
  });
  check("Admin issues asset2 for NOT_ALLOWLISTED test (201)", issue2.status === 201);
  const asset2Id = issue2.body.asset?.id as string;

  // Allow TREASURY on asset2 but NOT the buyer
  await act(app, adminToken, asset2Id, "allow", { account: TREASURY });
  await act(app, adminToken, asset2Id, "mint", { to: TREASURY, amount: "100" });

  // Fund buyer with another 1000 so balance = 1950 before the NOT_ALLOWLISTED attempt
  await post(app, "/cash/credit", adminToken, {
    account: BUYER_WALLET,
    currency: "CBDC-INR",
    amount: "1000",
  });
  const buyerBalances4 = (await get(app, `/cash/balances?address=${BUYER_WALLET}`, adminToken)).body as { currency: string; amount: string }[];
  const buyerCbdc4 = buyerBalances4.find((b) => b.currency === "CBDC-INR")?.amount;
  check(`Buyer CBDC-INR = "1950" after top-up (got ${buyerCbdc4})`, buyerCbdc4 === "1950");

  // Buyer tries to buy 1 token on asset2 — should be rejected (NOT_ALLOWLISTED)
  const buyNotAllowed = await post(app, `/assets/${asset2Id}/buy`, buyerToken, { quantity: "1" });
  check("NOT_ALLOWLISTED buy rejected (400)", buyNotAllowed.status === 400);
  check(
    `Error = NOT_ALLOWLISTED (got ${buyNotAllowed.body.error})`,
    buyNotAllowed.body.error === "NOT_ALLOWLISTED",
  );

  // Cash must NOT have been deducted — the allowlist check runs post-payment inside engine.buy; the refund path compensated.
  const buyerBalances5 = (await get(app, `/cash/balances?address=${BUYER_WALLET}`, adminToken)).body as { currency: string; amount: string }[];
  const buyerCbdc5 = buyerBalances5.find((b) => b.currency === "CBDC-INR")?.amount;
  check(`Cash NOT deducted on NOT_ALLOWLISTED rejection — still "1950" (got ${buyerCbdc5})`, buyerCbdc5 === "1950");

  // Note: Carol (DEFAULT_ACCOUNTS[2]) is never allowlisted on any asset in this test.

  await app.close();
  section(failures === 0 ? "ALL MARKETPLACE BUY/DvP CHECKS PASSED" : `FAILED (${failures} checks)`);
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
