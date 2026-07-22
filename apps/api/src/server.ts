import { RbacPolicy } from "@tokenlayer/core";
import { buildApp } from "./app.js";
import { buildChainRegistry } from "./chains.js";
import type { AppDeps } from "./context.js";
import { createEngine } from "./context.js";
import { loadCurrencies } from "./currencies.js";
import { env } from "./env.js";
import { createMemoryChallengeStore } from "./identity-challenges.js";
import { createKeystore } from "./keystore.js";
import { ensureNamedOrg, ensurePlatformIssuerOrg, ensureUserWallet, provisionOrgMemberIdentities, provisionPlatformOperatorIdentities } from "./platform-org.js";
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
  PrismaRegistryDeploymentRepository,
  PrismaStagedInvoiceRepository,
  PrismaUseCaseRepository,
  PrismaUserRepository,
  PrismaVerificationRequestRepository,
} from "./persistence/prisma.js";
import { resolveIdentityRegistry } from "./registry.js";
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
  const verificationRequests = new PrismaVerificationRequestRepository();
  const stagedInvoices = new PrismaStagedInvoiceRepository();
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
  const registry = await resolveIdentityRegistry({
    chainId: env.registryChainId,
    chains,
    deployments: new PrismaRegistryDeploymentRepository(),
  });
  const deps: AppDeps = {
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
    verificationRequests,
    stagedInvoices,
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
    registry,
  };
  const platformOrg = await ensurePlatformIssuerOrg(deps);
  // Demo operators get a real identity so their profile/credentials pages are
  // populated like any org member (outside production only).
  if (env.nodeEnv !== "production") {
    // Platform Admins → the TokenLayer Platform org.
    await provisionPlatformOperatorIdentities(deps, platformOrg);
    // Invoice-tokenization desk (the M1xchange TReDS POC): its operators are
    // members of the M1xchange organization, each holding a DID + membership VC.
    const m1xchange = await ensureNamedOrg(deps, { name: "M1xchange", orgType: "corporate", jurisdiction: "IN" });
    await provisionOrgMemberIdentities(deps, m1xchange, [
      "m1.admin@tokenlayer.dev", "m1.issuer@tokenlayer.dev", "m1.buyer@tokenlayer.dev", "m1.auditor@tokenlayer.dev",
    ]);
    // Link the invoice issuer to a demo desk wallet so its profile shows one.
    await ensureUserWallet(deps, "m1.issuer@tokenlayer.dev", "0xBcd4042DE499D14e55001CcbB24a551F3b954096", "M1xchange Desk");
  }
  const app = await buildApp(deps);

  await app.listen({ port: env.port, host: "0.0.0.0" });
  const chainList = chains.list().map((c) => c.id).join(", ");
  console.log(`TokenLayer API listening on http://localhost:${env.port}  (chains: ${chainList})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
