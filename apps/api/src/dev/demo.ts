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
import {
  MemoryAccountRepository,
  MemoryApiKeyRepository,
  MemoryPasswordResetTokenRepository,
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
  MemoryLedgerTransactionRepository,
  MemoryWebhookEndpointRepository,
} from "../persistence/memory/index.js";
import { DEFAULT_ACCOUNTS, seedDefaults } from "../shared/seed.js";
import { seedUseCases } from "../tokenization/use-cases.js";
import { completeDueDiligence } from "./dev-helpers.js";

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
  const auditAnchors = new MemoryAuditAnchorRepository();
  const accounts = new MemoryAccountRepository();
  const useCases = new MemoryUseCaseRepository();
  const organizations = new MemoryOrganizationRepository();
  const keystore = createKeystore("11".repeat(32));
  await seedDefaults(users, accounts);
  const engine = createEngine(useCases, rbac, chains, audit);
  const platformOrg = await ensurePlatformIssuerOrg({ organizations, keystore, registry: undefined });
  await seedUseCases(useCases, platformOrg.id, (label) => provisionTreasury({ accounts }, platformOrg.id, label), {
    availableChainIds: new Set(chains.list().map((c) => c.id)),
    deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
  });
  const cash = new MemoryCashRepository();
  const listings = new MemoryListingRepository();
  const app = await buildApp({ useCases, credentialUseCases: new MemoryCredentialUseCaseRepository(), credentialTemplates: new MemoryCredentialUseCaseTemplateRepository(), rbac, engine, users, assets, audit, auditAnchors, accounts, chains, cash, listings, documents: new MemoryDocumentRepository(), cashflows: new MemoryCashflowRepository(), proposals: new MemoryProposalRepository(), organizations, credentials: new MemoryCredentialRepository(), verificationRequests: new MemoryVerificationRequestRepository(), stagedInvoices: new MemoryStagedInvoiceRepository(), apiKeys: new MemoryApiKeyRepository(), passwordResetTokens: new MemoryPasswordResetTokenRepository(), events: new MemoryEventRepository(), webhookEndpoints: new MemoryWebhookEndpointRepository(), webhookDeliveries: new MemoryWebhookDeliveryRepository(), ledgerTransactions: new MemoryLedgerTransactionRepository(), webhooksAllowInsecure: false, secretBox: createSecretBox("22".repeat(32)), mail: new NullMailer(), keystore, didMasterConfigured: true, challenges: createMemoryChallengeStore(), loginKeys: new MemoryLoginKeyRepository(), qrLogin: createMemoryQrLoginStore(), publicWebUrl: "http://localhost:5173", enabledDomains: ["tokenization", "identity"], currencies: loadCurrencies(), jwtSecret: "demo", publicApiUrl: "http://localhost:4000/api/v1" });
  const token = (await post(app, "/auth/login", null, { email: "admin@tokenlayer.dev", password: "admin123" })).body.token;
  // A second PlatformAdmin to DECIDE every asset's due-diligence review below
  // — review-decision refuses a creator deciding their own asset, and `token`
  // (admin@tokenlayer.dev) is the creator of every asset this script issues.
  // A PlatformAdmin may decide ANY asset's review (not just one whose use
  // case happens to have no UseCaseAdmin onboarded — see review-decision's
  // own comment), which is what makes one universal decider workable here
  // even for corporate-bond (which DOES have a seeded UseCaseAdmin) and for
  // generic-asset/generic-certificate/forest-offset (which have none at all).
  const decider = (await post(app, "/auth/login", null, { email: "admin2@tokenlayer.dev", password: "admin123" })).body.token;

  // 1. ERC-20 across every available DLT — identical behaviour everywhere.
  for (const chain of chains.list()) {
    console.log(`\n=== ERC-20 "Generic Asset" on ${chain.label} (${chain.family}) ===`);
    const id = (await issue(app, token, decider, "generic-asset", "Gold Bar", "GOLD", chain.id, { issuer: "ACME", assetClass: "commodity", valuation: 250000 })).id;
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
  const sec = (await issue(app, token, decider, "corporate-bond", "Acme Bond", "ACMEB", "canton", { issuer: "ACME", isin: "INE000A01001", faceValue: 1000 })).id;
  const unregistered = await post(app, `/assets/${sec}/actions/mint`, token, { to: ALICE, amount: "100" });
  check("mint to unregistered holder rejected", unregistered.status === 400 && unregistered.body.error === "NOT_ALLOWLISTED");
  await post(app, `/assets/${sec}/actions/allow`, token, { account: ALICE });
  check("mint after identity registration", (await post(app, `/assets/${sec}/actions/mint`, token, { to: ALICE, amount: "100" })).status === 200);

  // 3. ERC-721 — non-fungible, token-id based.
  console.log(`\n=== ERC-721 "Generic Certificate" on Fabric (simulated) ===`);
  const cert = (await issue(app, token, decider, "generic-certificate", "Reg Cert", "CERT", "fabric", { category: "registration", authority: "Gov" })).id;
  check("mint token #1 to Alice", (await post(app, `/assets/${cert}/actions/mint`, token, { to: ALICE, tokenId: "1", uri: "ipfs://c1" })).status === 200);
  const tokens = (await get(app, `/assets/${cert}/tokens`, token)).body as { tokenId: string; owner: string }[];
  check("token #1 owned by Alice", tokens.length === 1 && tokens[0]!.owner === ALICE);
  const certTransfer = await post(app, `/assets/${cert}/actions/transfer`, token, { from: ALICE, to: BOB, tokenId: "1" });
  check("certificate transfer disabled by config", certTransfer.status === 400 && certTransfer.body.error === "ACTION_DISABLED");

  // 3b. Real T-REX (ERC-3643) on a live EVM, if configured — deploys the full
  // ONCHAINID + registries + modular-compliance suite through the platform.
  if (chains.list().some((c) => c.id === "besu")) {
    console.log(`\n=== ERC-3643 real T-REX on Besu (deploys ONCHAINID + registries) ===`);
    const trex = (await issue(app, token, decider, "corporate-bond", "Onchain Bond", "OBND", "besu", { issuer: "ACME", isin: "INE000A01002", faceValue: 1000 })).id;
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
  // Every new asset starts pending_approval now (202), never active (201) —
  // see the due-diligence review feature.
  check("asset issued from new use case (202, pending review)", cc.status === 202);
  await completeDueDiligence(app, cc.body.asset.id, token, decider);
  check("asset activates once its due-diligence review is approved", (await get(app, `/assets/${cc.body.asset.id}`, token)).body.status === "active");

  await app.close();
  console.log(`\n${failures === 0 ? "✅ DEMO PASSED" : `❌ DEMO FAILED (${failures} checks)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function issue(
  app: FastifyInstance,
  actorToken: string,
  deciderToken: string,
  useCaseKey: string,
  name: string,
  symbol: string,
  chainId: string,
  metadata: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await post(app, "/assets", actorToken, { useCaseKey, name, symbol, chainId, metadata });
  // Every new asset now starts pending_approval — POST /assets returns 202
  // (asset created, awaiting review), never 201 (immediately active). Every
  // caller of this helper acts on the returned asset right afterward
  // (mint/allow/...), so complete the due-diligence review here, once, rather
  // than in each of this script's call sites.
  if (res.status !== 202) throw new Error(`issue failed: ${JSON.stringify(res.body)}`);
  const id = res.body.asset.id as string;
  await completeDueDiligence(app, id, actorToken, deciderToken);
  return { id };
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
