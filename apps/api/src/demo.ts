import { RbacPolicy } from "@tokenlayer/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { buildChainRegistry } from "./chains.js";
import { createEngine } from "./context.js";
import { loadCurrencies } from "./currencies.js";
import {
  MemoryAccountRepository,
  MemoryAssetRepository,
  MemoryAuditRepository,
  MemoryCashRepository,
  MemoryCashflowRepository,
  MemoryDocumentRepository,
  MemoryListingRepository,
  MemoryUseCaseRepository,
  MemoryUserRepository,
} from "./persistence/memory.js";
import { DEFAULT_ACCOUNTS, seedDefaults } from "./seed.js";
import { seedUseCases } from "./use-cases.js";

const ALICE = DEFAULT_ACCOUNTS[0]!.address;
const BOB = DEFAULT_ACCOUNTS[1]!.address;

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const rbac = new RbacPolicy();
  const chains = buildChainRegistry({ ...process.env, CHAIN_STRICT: process.env.CHAIN_STRICT ?? "0" }); // includes EVM chains if their RPC envs are set
  const users = new MemoryUserRepository();
  const assets = new MemoryAssetRepository();
  const audit = new MemoryAuditRepository();
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
  const app = await buildApp({ useCases, rbac, engine, users, assets, audit, accounts, chains, cash, listings, documents: new MemoryDocumentRepository(), cashflows: new MemoryCashflowRepository(), currencies: loadCurrencies(), jwtSecret: "demo" });
  const token = (await post(app, "/auth/login", null, { email: "admin@tokenlayer.dev", password: "admin123" })).body.token;

  // 1. ERC-20 across every available DLT — identical behaviour everywhere.
  for (const chain of chains.list()) {
    console.log(`\n=== ERC-20 "Generic Asset" on ${chain.label} (${chain.family}) ===`);
    const id = (await issue(app, token, "generic-asset", "Gold Bar", "GOLD", chain.id, { issuer: "ACME", assetClass: "commodity", valuation: 250000 })).id;
    await post(app, `/assets/${id}/actions/allow`, token, { account: ALICE });
    await post(app, `/assets/${id}/actions/allow`, token, { account: BOB });
    check("mint to Alice", (await post(app, `/assets/${id}/actions/mint`, token, { to: ALICE, amount: "1000" })).status === 200);
    check("transfer Alice→Bob", (await post(app, `/assets/${id}/actions/transfer`, token, { from: ALICE, to: BOB, amount: "400" })).status === 200);
    await post(app, `/assets/${id}/actions/freeze`, token, { account: ALICE });
    const frozen = await post(app, `/assets/${id}/actions/transfer`, token, { from: ALICE, to: BOB, amount: "10" });
    check("frozen transfer rejected", frozen.status === 400 && frozen.body.error === "ACCOUNT_FROZEN");
    const acc = (await get(app, `/assets/${id}/accounts`, token)).body as { address: string; balance: string }[];
    check("Alice balance 600", acc.find((a) => a.address === ALICE)?.balance === "600");
  }

  // 2. ERC-3643 — identity allowlist is mandatory.
  console.log(`\n=== ERC-3643 "Corporate Bond" on Canton (simulated) ===`);
  const sec = (await issue(app, token, "corporate-bond", "Acme Bond", "ACMEB", "canton", { issuer: "ACME", isin: "INE000A01001", faceValue: 1000 })).id;
  const unregistered = await post(app, `/assets/${sec}/actions/mint`, token, { to: ALICE, amount: "100" });
  check("mint to unregistered holder rejected", unregistered.status === 400 && unregistered.body.error === "NOT_ALLOWLISTED");
  await post(app, `/assets/${sec}/actions/allow`, token, { account: ALICE });
  check("mint after identity registration", (await post(app, `/assets/${sec}/actions/mint`, token, { to: ALICE, amount: "100" })).status === 200);

  // 3. ERC-721 — non-fungible, token-id based.
  console.log(`\n=== ERC-721 "Generic Certificate" on Fabric (simulated) ===`);
  const cert = (await issue(app, token, "generic-certificate", "Reg Cert", "CERT", "fabric", { category: "registration", authority: "Gov" })).id;
  check("mint token #1 to Alice", (await post(app, `/assets/${cert}/actions/mint`, token, { to: ALICE, tokenId: "1", uri: "ipfs://c1" })).status === 200);
  const tokens = (await get(app, `/assets/${cert}/tokens`, token)).body as { tokenId: string; owner: string }[];
  check("token #1 owned by Alice", tokens.length === 1 && tokens[0]!.owner === ALICE);
  const certTransfer = await post(app, `/assets/${cert}/actions/transfer`, token, { from: ALICE, to: BOB, tokenId: "1" });
  check("certificate transfer disabled by config", certTransfer.status === 400 && certTransfer.body.error === "ACTION_DISABLED");

  // 3b. Real T-REX (ERC-3643) on a live EVM, if configured — deploys the full
  // ONCHAINID + registries + modular-compliance suite through the platform.
  if (chains.list().some((c) => c.id === "local-evm")) {
    console.log(`\n=== ERC-3643 real T-REX on Local EVM (deploys ONCHAINID + registries) ===`);
    const trex = (await issue(app, token, "corporate-bond", "Onchain Bond", "OBND", "local-evm", { issuer: "ACME", isin: "INE000A01002", faceValue: 1000 })).id;
    const unregistered = await post(app, `/assets/${trex}/actions/mint`, token, { to: ALICE, amount: "100" });
    check("mint to non-identity holder rejected on-chain", unregistered.status === 400);
    await post(app, `/assets/${trex}/actions/allow`, token, { account: ALICE }); // registers an ONCHAINID identity
    check("isVerified after ONCHAINID registration", (await get(app, `/assets/${trex}/accounts`, token)).body.find((a: any) => a.address === ALICE)?.allowed === true);
    check("mint after identity registration", (await post(app, `/assets/${trex}/actions/mint`, token, { to: ALICE, amount: "100" })).status === 200);
  }

  // 4. Low-code — create a brand-new use case at runtime, then issue it.
  console.log(`\n=== Low-code: create a use case via API, then issue it ===`);
  const createdUc = await post(app, "/use-cases", token, {
    key: "forest-offset",
    name: "Forest Offset Credit",
    tokenStandard: "ERC-20",
    allowedChainIds: ["besu", "fabric", "canton"],
    defaultChainId: "fabric",
    metadataSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
    compliance: { allowlist: false, transferRestrictions: false },
    roles: ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"],
  });
  check("use case created (201)", createdUc.status === 201);
  const cc = await post(app, "/assets", token, { useCaseKey: "forest-offset", name: "Forest Offset", symbol: "CO2", chainId: "fabric", metadata: { project: "Amazon-1" } });
  check("asset issued from new use case", cc.status === 201);

  await app.close();
  console.log(`\n${failures === 0 ? "✅ DEMO PASSED" : `❌ DEMO FAILED (${failures} checks)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function issue(
  app: FastifyInstance,
  token: string,
  useCaseKey: string,
  name: string,
  symbol: string,
  chainId: string,
  metadata: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await post(app, "/assets", token, { useCaseKey, name, symbol, chainId, metadata });
  if (res.status !== 201) throw new Error(`issue failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.asset.id };
}

async function post(app: FastifyInstance, url: string, token: string | null, payload: unknown) {
  const res = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
}

async function get(app: FastifyInstance, url: string, token: string) {
  const res = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  return { status: res.statusCode, body: res.json() };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
