import { CREDENTIAL_TEMPLATES, RbacPolicy, type OrgType } from "@tokenlayer/core";
import { buildApp } from "./app.js";
import { buildChainRegistry } from "./chains.js";
import type { AppDeps } from "./context.js";
import { createEngine } from "./context.js";
import { loadCurrencies } from "./currencies.js";
import { env } from "./env.js";
import { createMemoryChallengeStore } from "./identity-challenges.js";
import { createMemoryQrLoginStore } from "./qr-login-sessions.js";
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
  PrismaLoginKeyRepository,
  PrismaRegistryDeploymentRepository,
  PrismaStagedInvoiceRepository,
  PrismaCredentialUseCaseRepository,
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
  const credentialUseCases = new PrismaCredentialUseCaseRepository();
  const cash = new PrismaCashRepository();
  const listings = new PrismaListingRepository();
  const documents = new PrismaDocumentRepository();
  const cashflows = new PrismaCashflowRepository();
  const proposals = new PrismaProposalRepository();
  const organizations = new PrismaOrganizationRepository();
  const credentials = new PrismaCredentialRepository();
  const verificationRequests = new PrismaVerificationRequestRepository();
  const stagedInvoices = new PrismaStagedInvoiceRepository();
  const loginKeys = new PrismaLoginKeyRepository();
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
    credentialUseCases,
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
    loginKeys,
    qrLogin: createMemoryQrLoginStore(),
    publicWebUrl: env.publicWebUrl,
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
    // Each demo use-case desk is an organization; its seeded roster (admin,
    // issuer, buyer, auditor) holds a DID + OrganizationMembership credential so
    // their profile/credentials pages are populated. Tenancy orgId stays null.
    const desks: { name: string; orgType: OrgType; jurisdiction: string | null; prefix: string; issuerWallet?: string }[] = [
      { name: "M1xchange", orgType: "corporate", jurisdiction: "IN", prefix: "m1", issuerWallet: "0xBcd4042DE499D14e55001CcbB24a551F3b954096" },
      { name: "Verra Carbon Registry", orgType: "verifier", jurisdiction: null, prefix: "carbon" },
      { name: "Muthoot Finance", orgType: "bank", jurisdiction: "IN", prefix: "gold" },
      { name: "ACME Capital", orgType: "corporate", jurisdiction: "IN", prefix: "bond" },
    ];
    for (const d of desks) {
      const org = await ensureNamedOrg(deps, { name: d.name, orgType: d.orgType, jurisdiction: d.jurisdiction });
      await provisionOrgMemberIdentities(deps, org, [
        `${d.prefix}.admin@tokenlayer.dev`, `${d.prefix}.issuer@tokenlayer.dev`,
        `${d.prefix}.buyer@tokenlayer.dev`, `${d.prefix}.auditor@tokenlayer.dev`,
      ]);
      if (d.issuerWallet) await ensureUserWallet(deps, `${d.prefix}.issuer@tokenlayer.dev`, d.issuerWallet, `${d.name} Desk`);
    }
    // Seed one example credential use case (Identity domain) so the Identity
    // section is populated on a fresh boot. Idempotent.
    if (!(await credentialUseCases.has("corp-trade-credentials"))) {
      await credentialUseCases.create({
        key: "corp-trade-credentials", name: "Corporate Trade Credentials",
        description: "Government-issued trade credentials (MCA, GSTIN) for registered corporates.",
        credentialTypes: [CREDENTIAL_TEMPLATES.MCACredential!, CREDENTIAL_TEMPLATES.GSTINCredential!],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
        ownerOrgId: null,
      });
    }
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
