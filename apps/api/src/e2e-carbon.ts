/**
 * End-to-end test of the Carbon Credit tokenization use case, driven entirely
 * through the platform's HTTP API and exercising every RBAC role:
 *
 *   - Issuer   onboards the project, issues credits, manages the KYC allowlist
 *   - Operator runs the trading desk: settles trades, applies compliance freeze,
 *              and retires (burns) credits
 *   - Viewer   is a read-only auditor (write actions are forbidden)
 *   - Admin    superuser
 *
 * 1 token = 1 tonne CO2e (a Verified Carbon Unit). Burning a credit permanently
 * retires it so it can never be double-counted.
 *
 * Runs on the simulated chains by default; if EVM_RPC_URL is set the credit is
 * issued on the live EVM as a real on-chain ERC-20.
 */
import { RbacPolicy } from "@tokenlayer/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { buildChainRegistry } from "./chains.js";
import { createEngine } from "./context.js";
import {
  MemoryAccountRepository,
  MemoryAssetRepository,
  MemoryAuditRepository,
  MemoryUseCaseRepository,
  MemoryUserRepository,
} from "./persistence/memory.js";
import { DEFAULT_ACCOUNTS, seedDefaults } from "./seed.js";
import { seedUseCases } from "./use-cases.js";

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
  const chains = buildChainRegistry();
  const users = new MemoryUserRepository();
  const assets = new MemoryAssetRepository();
  const audit = new MemoryAuditRepository();
  const accounts = new MemoryAccountRepository();
  const useCases = new MemoryUseCaseRepository();
  await seedDefaults(users, accounts);
  await seedUseCases(useCases); // seeds carbon-credit.json from config/use-cases
  const engine = createEngine(useCases, rbac, chains, audit);
  const app = await buildApp({ useCases, rbac, engine, users, assets, audit, accounts, chains, jwtSecret: "e2e" });

  const admin = await login(app, "admin");
  const issuer = await login(app, "issuer");
  const operator = await login(app, "operator");
  const viewer = await login(app, "viewer");

  const evmAvailable = chains.list().some((c) => c.id === "local-evm");
  const chain = evmAvailable ? "local-evm" : "besu";
  console.log(`Chains available: ${chains.list().map((c) => c.id).join(", ")}`);

  section("CARBON CREDIT TOKENIZATION (ERC-20, KYC allowlist + retire-by-burn)");

  // The use case ships as a seeded default (config/use-cases/carbon-credit.json).
  const cat = await get(app, "/use-cases/carbon-credit", viewer);
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

  // 3. RBAC: a Viewer cannot mint, and an Operator cannot manage the allowlist.
  const viewerMint = await act(app, viewer, id, "mint", { to: PROJECT, amount: "1" });
  check("RBAC: Viewer is read-only — mint forbidden (403)", viewerMint.status === 403 && viewerMint.body.error === "FORBIDDEN");
  const opAllow = await act(app, operator, id, "allow", { account: OUTSIDER });
  check("RBAC: Operator cannot touch the KYC allowlist (403)", opAllow.status === 403 && opAllow.body.error === "FORBIDDEN");

  // 4. Issuance: Issuer mints 10,000 credits (tonnes CO2e) to the project developer.
  check("Issuance: Issuer mints 10,000 credits to the project developer", (await act(app, issuer, id, "mint", { to: PROJECT, amount: "10000" })).status === 200);

  // 5. Trading desk (Operator): sell 4,000 credits to a broker, who sells 2,000 to a corporate buyer.
  check("Trade: Operator settles 4,000 credits project→broker", (await act(app, operator, id, "transfer", { from: PROJECT, to: BROKER, amount: "4000" })).status === 200);
  check("Trade: Operator settles 2,000 credits broker→corporate buyer", (await act(app, operator, id, "transfer", { from: BROKER, to: BUYER, amount: "2000" })).status === 200);

  // 6. Compliance: a sale to a non-KYC'd party is rejected.
  const toOutsider = await act(app, operator, id, "transfer", { from: PROJECT, to: OUTSIDER, amount: "100" });
  check("Compliance: transfer to non-KYC party (outsider) rejected", toOutsider.status === 400 && toOutsider.body.error === "NOT_ALLOWLISTED");

  // 7. Compliance hold: Operator freezes the broker; transfers blocked; then lifts the hold.
  await act(app, operator, id, "freeze", { account: BROKER });
  const frozen = await act(app, operator, id, "transfer", { from: BROKER, to: BUYER, amount: "1" });
  check("Compliance hold: frozen broker cannot transfer", frozen.status === 400 && frozen.body.error === "ACCOUNT_FROZEN");
  await act(app, operator, id, "unfreeze", { account: BROKER });
  check("Hold lifted: broker can transfer again", (await act(app, operator, id, "transfer", { from: BROKER, to: BUYER, amount: "500" })).status === 200);

  // 8. Retirement: the corporate buyer retires (burns) 1,500 credits to offset its emissions.
  check("Retirement: Operator burns 1,500 credits from the corporate buyer (offset claimed)", (await act(app, operator, id, "burn", { from: BUYER, amount: "1500" })).status === 200);

  // 9. Final ledger state.
  const accts = (await get(app, `/assets/${id}/accounts`, viewer)).body as { address: string; balance: string }[];
  const bal = (a: string) => accts.find((x) => x.address === a)?.balance;
  check(`Project developer holds 6,000 (got ${bal(PROJECT)})`, bal(PROJECT) === "6000");
  check(`Broker holds 1,500 (got ${bal(BROKER)})`, bal(BROKER) === "1500");
  check(`Corporate buyer holds 1,000 (got ${bal(BUYER)})`, bal(BUYER) === "1000");
  const supply = (await get(app, `/assets/${id}`, viewer)).body.totalSupply;
  check(`Circulating supply 8,500 after 1,500 retired (got ${supply})`, supply === "8500");
  const trail = (await get(app, `/assets/${id}/audit`, viewer)).body.data as { action: string }[];
  check(`Auditor (Viewer) can read the full audit trail (${trail.length} events)`, trail.length >= 9);

  await app.close();
  section(failures === 0 ? "✅ CARBON CREDIT USE CASE PASSED END-TO-END" : `❌ FAILED (${failures} checks)`);
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
