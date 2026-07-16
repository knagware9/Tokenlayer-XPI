import { RbacPolicy } from "@tokenlayer/core";
import { buildApp } from "./app.js";
import { buildChainRegistry } from "./chains.js";
import { createEngine } from "./context.js";
import { loadCurrencies } from "./currencies.js";
import { env } from "./env.js";
import { createMemoryChallengeStore } from "./identity-challenges.js";
import { createKeystore } from "./keystore.js";
import {
  PrismaAccountRepository,
  PrismaAssetRepository,
  PrismaAuditAnchorRepository,
  PrismaAuditRepository,
  PrismaCashflowRepository,
  PrismaCredentialRepository,
  PrismaOrganizationRepository,
  PrismaProposalRepository,
  PrismaCashRepository,
  PrismaDocumentRepository,
  PrismaListingRepository,
  PrismaUseCaseRepository,
  PrismaUserRepository,
} from "./persistence/prisma.js";
import { seedDefaults } from "./seed.js";
import { seedUseCases } from "./use-cases.js";

async function main(): Promise<void> {
  const rbac = new RbacPolicy();
  const chains = buildChainRegistry();
  await chains.assertConnectivity(); // fail fast: configured EVM chains must be reachable

  const users = new PrismaUserRepository();
  const assets = new PrismaAssetRepository();
  const audit = new PrismaAuditRepository();
  const auditAnchors = new PrismaAuditAnchorRepository();
  const accounts = new PrismaAccountRepository();
  const useCases = new PrismaUseCaseRepository();
  const cash = new PrismaCashRepository();
  const listings = new PrismaListingRepository();
  const documents = new PrismaDocumentRepository();
  const cashflows = new PrismaCashflowRepository();
  const proposals = new PrismaProposalRepository();
  const organizations = new PrismaOrganizationRepository();
  const credentials = new PrismaCredentialRepository();
  const keystore = createKeystore(env.didMasterKey);
  // Demo users/accounts (with predictable passwords) are seeded only outside production.
  if (env.nodeEnv !== "production") await seedDefaults(users, accounts);

  const engine = createEngine(useCases, rbac, chains, audit, { users, accounts });
  // Seed default use cases and deploy their contracts on each allowed+available
  // chain (best-effort; never crashes boot). Available = present in the registry.
  await seedUseCases(useCases, {
    availableChainIds: new Set(chains.list().map((c) => c.id)),
    deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
  });
  const app = await buildApp({
    useCases,
    rbac,
    engine,
    users,
    assets,
    audit,
    auditAnchors,
    accounts,
    chains,
    cash,
    listings,
    documents,
    cashflows,
    proposals,
    organizations,
    credentials,
    keystore,
    didMasterConfigured: env.didMasterConfigured,
    challenges: createMemoryChallengeStore(),
    trustedKycIssuers: env.trustedKycIssuers,
    devIssuerSeed: env.devKycIssuerSeed,
    currencies: loadCurrencies(),
    jwtSecret: env.jwtSecret,
    publicApiUrl: env.publicApiUrl,
    corsOrigins: env.corsOrigins,
    isProduction: env.nodeEnv === "production",
    platformFeeAccount: env.platformFeeAccount,
    marketEscrowAccount: env.marketEscrowAccount,
    loginRateLimitMax: env.loginRateLimitMax,
  });

  await app.listen({ port: env.port, host: "0.0.0.0" });
  const chainList = chains.list().map((c) => c.id).join(", ");
  console.log(`TokenLayer API listening on http://localhost:${env.port}  (chains: ${chainList})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
