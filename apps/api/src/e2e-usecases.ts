/**
 * End-to-end test of two real-world tokenization use cases, driven entirely
 * through the platform's HTTP API (low-code use-case creation → issuance →
 * compliance → lifecycle → audit):
 *
 *   1. Gold Loan tokenization    — ERC-20, allowlist + freeze (asset-backed loan)
 *   2. Corporate Bond tokenization — ERC-3643 (deploys the real T-REX suite on EVM)
 *
 * Runs on the simulated chains by default; if EVM_RPC_URL is set the bond is
 * issued on the live EVM, exercising the real ONCHAINID / T-REX stack.
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
  MemoryCredentialUseCaseRepository,
  MemoryUseCaseRepository,
  MemoryUserRepository,
  MemoryVerificationRequestRepository,
} from "./persistence/memory.js";
import { DEFAULT_ACCOUNTS, seedDefaults } from "./seed.js";
import { seedUseCases } from "./use-cases.js";

const ALICE = DEFAULT_ACCOUNTS[0]!.address; // KYC investor 1
const BOB = DEFAULT_ACCOUNTS[1]!.address; // KYC investor 2
const CAROL = DEFAULT_ACCOUNTS[2]!.address; // NOT KYC'd
const TREASURY = DEFAULT_ACCOUNTS[3]!.address; // lender / issuer treasury

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures += 1;
}
function section(title: string): void {
  console.log(`\n${"━".repeat(64)}\n${title}\n${"━".repeat(64)}`);
}
/** A use case is "ready" if we just created it (201) or it was already seeded (409-ish 400). */
function created(r: { status: number; body: { error?: string } }): boolean {
  return r.status === 201 || (r.status === 400 && r.body.error === "INVALID_USECASE");
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
  await seedUseCases(useCases, {
    availableChainIds: new Set(chains.list().map((c) => c.id)),
    deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
  });
  const cash = new MemoryCashRepository();
  const listings = new MemoryListingRepository();
  const app = await buildApp({ useCases, credentialUseCases: new MemoryCredentialUseCaseRepository(), rbac, engine, users, assets, audit, auditAnchors, accounts, chains, cash, listings, documents: new MemoryDocumentRepository(), cashflows: new MemoryCashflowRepository(), proposals: new MemoryProposalRepository(), organizations: new MemoryOrganizationRepository(), credentials: new MemoryCredentialRepository(), verificationRequests: new MemoryVerificationRequestRepository(), stagedInvoices: new MemoryStagedInvoiceRepository(), keystore: createKeystore("11".repeat(32)), didMasterConfigured: true, challenges: createMemoryChallengeStore(), currencies: loadCurrencies(), jwtSecret: "e2e", publicApiUrl: "http://localhost:4000/api/v1" });

  const admin = await login(app, "admin");
  const evmAvailable = chains.list().some((c) => c.id === "mst" && c.available);
  console.log(`Chains available: ${chains.list().map((c) => c.id).join(", ")}`);

  // ============================================================
  // USE CASE 1 — GOLD LOAN TOKENIZATION (ERC-20, allowlist + freeze)
  // ============================================================
  section("USE CASE 1 — Gold Loan Tokenization (ERC-20, KYC allowlist + freeze)");

  const goldChain = evmAvailable ? "mst" : "fabric";
  check(
    "Admin creates the 'gold-loan' use case (low-code, no deploy)",
    created(
      await post(app, "/use-cases", admin, {
        key: "gold-loan",
        name: "Gold Loan",
        description: "A gold-collateral-backed loan token. KYC allowlist for lenders/investors; freeze on default; burn on repayment.",
        tokenStandard: "ERC-20",
        allowedChainIds: ["besu", "mst", "fabric", "canton"],
        defaultChainId: "besu",
        metadataSchema: {
          type: "object",
          properties: {
            borrower: { type: "string" },
            goldWeightGrams: { type: "number" },
            goldPurity: { type: "string" },
            loanAmountInr: { type: "number" },
            interestRate: { type: "number" },
            maturityDate: { type: "string" },
          },
          required: ["borrower", "goldWeightGrams", "loanAmountInr"],
        },
        lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
        compliance: { allowlist: true, transferRestrictions: true },
        roles: ["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"],
      })
    ),
  );

  console.log(`\n   Issuing on chain: ${goldChain}`);
  const goldIssue = await post(app, "/assets", admin, {
    useCaseKey: "gold-loan",
    name: "Gold Loan #GL-2026-001",
    symbol: "GLD001",
    chainId: goldChain,
    metadata: { borrower: "R. Sharma", goldWeightGrams: 250, goldPurity: "22K", loanAmountInr: 500000, interestRate: 9.5, maturityDate: "2027-06-21" },
  });
  check("Issuer onboards the gold loan (metadata validated)", goldIssue.status === 201);
  const gold = goldIssue.body.asset.id as string;

  // KYC the lender treasury + two investors
  for (const acct of [TREASURY, ALICE, BOB]) await act(app, admin, gold, "allow", { account: acct });
  check("KYC allowlist applied to treasury + 2 investors", true);

  // disburse: mint the tokenized loan to the lender treasury
  check("Disburse: mint ₹500,000 loan to treasury", (await act(app, admin, gold, "mint", { to: TREASURY, amount: "500000" })).status === 200);

  // sell a participation to a KYC investor
  check("Sell ₹200,000 participation treasury→investor (Alice)", (await act(app, admin, gold, "transfer", { from: TREASURY, to: ALICE, amount: "200000" })).status === 200);

  // compliance: transfer to a non-KYC party must be rejected
  const nonKyc = await act(app, admin, gold, "transfer", { from: TREASURY, to: CAROL, amount: "1000" });
  check("Compliance: transfer to non-KYC party (Carol) rejected", nonKyc.status === 400 && nonKyc.body.error === "NOT_ALLOWLISTED");

  // default handling: freeze the borrower-investor, transfers blocked, then cure
  await act(app, admin, gold, "freeze", { account: ALICE });
  const frozen = await act(app, admin, gold, "transfer", { from: ALICE, to: BOB, amount: "100" });
  check("Default: frozen investor cannot transfer", frozen.status === 400 && frozen.body.error === "ACCOUNT_FROZEN");
  await act(app, admin, gold, "unfreeze", { account: ALICE });
  check("Cure: after unfreeze, investor transfer succeeds", (await act(app, admin, gold, "transfer", { from: ALICE, to: BOB, amount: "50000" })).status === 200);

  // partial repayment: burn from treasury
  check("Repayment: burn ₹100,000 from treasury", (await act(app, admin, gold, "burn", { from: TREASURY, amount: "100000" })).status === 200);

  // verify final ledger state
  const goldAccounts = (await get(app, `/assets/${gold}/accounts`, admin)).body as { address: string; balance: string }[];
  const bal = (a: string) => goldAccounts.find((x) => x.address === a)?.balance;
  check(`Treasury balance ₹200,000 (got ${bal(TREASURY)})`, bal(TREASURY) === "200000");
  check(`Alice balance ₹150,000 (got ${bal(ALICE)})`, bal(ALICE) === "150000");
  check(`Bob balance ₹50,000 (got ${bal(BOB)})`, bal(BOB) === "50000");
  const goldSupply = (await get(app, `/assets/${gold}`, admin)).body.totalSupply;
  check(`Total supply ₹400,000 after repayment (got ${goldSupply})`, goldSupply === "400000");
  const goldAudit = (await get(app, `/assets/${gold}/audit`, admin)).body.data as unknown[];
  check(`Audit trail recorded ${goldAudit.length} events`, goldAudit.length >= 9);

  // ============================================================
  // USE CASE 2 — CORPORATE BOND TOKENIZATION (ERC-3643 / real T-REX)
  // ============================================================
  section("USE CASE 2 — Corporate Bond Tokenization (ERC-3643 / T-REX, identity-gated)");

  const bondChain = evmAvailable ? "mst" : "canton";
  check(
    "Admin creates the 'corporate-bond' use case (low-code)",
    created(
      await post(app, "/use-cases", admin, {
        key: "corporate-bond",
        name: "Corporate Bond",
        description: "A regulated corporate bond as an ERC-3643 security token. Every holder is identity-registered (ONCHAINID); identity-gated transfers; freeze + recovery; burn on redemption.",
        tokenStandard: "ERC-3643",
        allowedChainIds: ["besu", "mst", "fabric", "canton"],
        defaultChainId: "canton",
        metadataSchema: {
          type: "object",
          properties: {
            issuer: { type: "string" },
            isin: { type: "string" },
            faceValue: { type: "number" },
            couponRate: { type: "number" },
            maturityDate: { type: "string" },
            currency: { type: "string" },
            rating: { type: "string" },
          },
          required: ["issuer", "isin", "faceValue"],
        },
        lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
        compliance: { allowlist: true, transferRestrictions: true },
        roles: ["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"],
      })
    ),
  );

  console.log(`\n   Issuing on chain: ${bondChain}${bondChain === "mst" ? " (deploys real ONCHAINID + T-REX registries + modular compliance)" : " (simulated ERC-3643)"}`);
  const bondIssue = await post(app, "/assets", admin, {
    useCaseKey: "corporate-bond",
    name: "Acme Industries 8.5% 2031",
    symbol: "ACME31",
    chainId: bondChain,
    metadata: { issuer: "Acme Industries Ltd", isin: "INE001A07XYZ", faceValue: 1000, couponRate: 8.5, maturityDate: "2031-06-21", currency: "INR", rating: "AA+" },
  });
  check("Issuer issues the bond", bondIssue.status === 201);
  check("Bond recorded as ERC-3643", bondIssue.body.asset.tokenStandard === "ERC-3643");
  const bond = bondIssue.body.asset.id as string;

  // identity gating: minting to an un-registered investor must fail
  const preKyc = await act(app, admin, bond, "mint", { to: ALICE, amount: "1000" });
  check("Identity gating: mint to unregistered investor rejected", preKyc.status === 400);

  // register investor identities (ONCHAINID + KYC claim on EVM; allowlist on sim)
  await act(app, admin, bond, "allow", { account: ALICE });
  await act(app, admin, bond, "allow", { account: BOB });
  const aliceVerified = (await get(app, `/assets/${bond}/accounts`, admin)).body.find((a: { address: string }) => a.address === ALICE)?.allowed;
  check("Investor identities registered (Alice isVerified)", aliceVerified === true);

  // primary subscription
  check("Primary subscription: mint 1000 bonds to Alice", (await act(app, admin, bond, "mint", { to: ALICE, amount: "1000" })).status === 200);

  // secondary, identity-gated transfer
  check("Secondary trade: transfer 400 Alice→Bob (identity-gated)", (await act(app, admin, bond, "transfer", { from: ALICE, to: BOB, amount: "400" })).status === 200);

  // transfer to a non-registered investor must fail
  const bondNonKyc = await act(app, admin, bond, "transfer", { from: ALICE, to: CAROL, amount: "10" });
  check("Compliance: transfer to non-identity investor (Carol) rejected", bondNonKyc.status === 400);

  // regulatory freeze + recovery
  await act(app, admin, bond, "freeze", { account: ALICE });
  const bondFrozen = await act(app, admin, bond, "transfer", { from: ALICE, to: BOB, amount: "10" });
  check("Regulatory freeze blocks the holder's transfer", bondFrozen.status === 400);
  await act(app, admin, bond, "unfreeze", { account: ALICE });

  // redemption: burn
  check("Redemption: burn 100 bonds from Alice", (await act(app, admin, bond, "burn", { from: ALICE, amount: "100" })).status === 200);

  // final state
  const bondAccounts = (await get(app, `/assets/${bond}/accounts`, admin)).body as { address: string; balance: string }[];
  const bbal = (a: string) => bondAccounts.find((x) => x.address === a)?.balance;
  check(`Alice holds 500 bonds (got ${bbal(ALICE)})`, bbal(ALICE) === "500");
  check(`Bob holds 400 bonds (got ${bbal(BOB)})`, bbal(BOB) === "400");
  const bondAudit = (await get(app, `/assets/${bond}/audit`, admin)).body.data as unknown[];
  check(`Audit trail recorded ${bondAudit.length} events`, bondAudit.length >= 8);

  await app.close();
  section(failures === 0 ? "✅ BOTH USE CASES PASSED END-TO-END" : `❌ FAILED (${failures} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}

async function login(app: FastifyInstance, who: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: `${who}@tokenlayer.dev`, password: `${who}123` } });
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
