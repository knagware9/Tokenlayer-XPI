import { CREDENTIAL_TEMPLATES, RbacPolicy, type OrgType } from "@tokenlayer/core";
import { buildApp } from "./app.js";
import { buildChainRegistry } from "./chains.js";
import type { AppDeps } from "./context.js";
import { createEngine } from "./context.js";
import { loadCurrencies } from "./currencies.js";
import { env } from "./env.js";
import { selectIdentityAssertions } from "./identity-assertions.js";
import { createMemoryChallengeStore } from "./identity-challenges.js";
import { createMemoryQrLoginStore } from "./qr-login-sessions.js";
import { createKeystore } from "./keystore.js";
import { ensureNamedOrg, ensurePlatformIssuerOrg, ensureUserWallet, provisionOrgMemberIdentities, provisionPlatformOperatorIdentities } from "./platform-org.js";
import {
  PrismaAccountRepository,
  PrismaApiKeyRepository,
  PrismaAssetRepository,
  PrismaAuditAnchorRepository,
  PrismaAuditRepository,
  PrismaCashflowRepository,
  PrismaCredentialRepository,
  PrismaOrganizationRepository,
  PrismaProposalRepository,
  PrismaCashRepository,
  PrismaDocumentRepository,
  PrismaEventRepository,
  PrismaListingRepository,
  PrismaLoginKeyRepository,
  PrismaRegistryDeploymentRepository,
  PrismaStagedInvoiceRepository,
  PrismaCredentialUseCaseRepository,
  PrismaCredentialUseCaseTemplateRepository,
  PrismaUseCaseRepository,
  PrismaUserRepository,
  PrismaVerificationRequestRepository,
  PrismaWebhookDeliveryRepository,
  PrismaWebhookEndpointRepository,
} from "./persistence/prisma.js";
import { resolveIdentityRegistry } from "./registry.js";
import { seedDefaults } from "./seed.js";
import { seedUseCases } from "./use-cases.js";
import { createHttpSender, startDispatcher } from "./webhooks/dispatcher.js";
import { createSecretBox } from "./webhooks/secret-box.js";

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
  const credentialTemplates = new PrismaCredentialUseCaseTemplateRepository();
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
  const apiKeys = new PrismaApiKeyRepository();
  const events = new PrismaEventRepository();
  const webhookEndpoints = new PrismaWebhookEndpointRepository();
  const webhookDeliveries = new PrismaWebhookDeliveryRepository();
  const keystore = createKeystore(env.didMasterKey);
  // Demo users/accounts (with predictable passwords) are seeded only outside
  // production. The ROSTER is seeded on every deployment — it is how anyone logs
  // in — but the demo WALLETS behind it only where tokenization is sold.
  if (env.nodeEnv !== "production") {
    await seedDefaults(users, accounts, undefined, env.enabledDomains.includes("tokenization"));
  }

  // WHERE "is this holder verified?" is answered on THIS deployment — the local
  // credential store, a remote Identity service, or nowhere (and it says so).
  const identity = selectIdentityAssertions({
    enabledDomains: env.enabledDomains,
    serviceUrl: env.identityServiceUrl,
    serviceKey: env.identityServiceKey,
    timeoutMs: env.identityServiceTimeoutMs,
    credentials,
  });
  console.log(
    `[identity] verified-identity answers come from: ${
      env.identityServiceUrl
        ? `remote ${env.identityServiceUrl}`
        : env.enabledDomains.includes("identity")
          ? "the local credential store"
          : "NOWHERE — requireVerifiedIdentity use cases will refuse"
    }`,
  );

  const engine = createEngine(useCases, rbac, chains, audit, { users, accounts, credentials, identity });
  // Seed default use cases and deploy their contracts on each allowed+available
  // chain (best-effort; never crashes boot). Available = present in the registry.
  //
  // ONLY WHERE TOKENIZATION IS SOLD. This ran unconditionally, so an
  // identity-only deployment wrote tokenization use cases it had no route to
  // serve and — worse — spent boot deploying their contracts on a real chain.
  // Boot happens before `buildApp` installs the repository guard, so this is
  // the explicit condition rather than a caught refusal.
  if (env.enabledDomains.includes("tokenization")) {
    await seedUseCases(useCases, {
      availableChainIds: new Set(chains.list().map((c) => c.id)),
      deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
    });
  }
  const registry = await resolveIdentityRegistry({
    chainId: env.registryChainId,
    chains,
    deployments: new PrismaRegistryDeploymentRepository(),
  });
  const deps: AppDeps = {
    useCases,
    credentialUseCases,
    credentialTemplates,
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
    apiKeys,
    events,
    webhookEndpoints,
    webhookDeliveries,
    webhooksAllowInsecure: env.webhooksAllowInsecure,
    // ONE box, shared by the registration routes (which seal a freshly minted
    // secret) and the dispatcher below (which opens it to sign). A DEDICATED key
    // where the operator has set one; falls back to the DID key so an existing
    // deployment keeps working without re-encrypting.
    secretBox: createSecretBox(env.webhookMasterKey),
    keystore,
    didMasterConfigured: env.didMasterConfigured,
    challenges: createMemoryChallengeStore(),
    loginKeys,
    qrLogin: createMemoryQrLoginStore(),
    publicWebUrl: env.publicWebUrl,
    enabledDomains: env.enabledDomains,
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
    apiKeyRateLimitMax: env.apiKeyRateLimitMax,
    apiKeyFailedAttemptMax: env.apiKeyFailedAttemptMax,
    apiKeyReserveIntervalMs: env.apiKeyReserveIntervalMs,
    brandLogoPruneGraceMs: env.brandLogoPruneGraceMs,
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
      // A wallet is tokenization data (Account) — no wallet to link where that product is not sold.
      if (d.issuerWallet && env.enabledDomains.includes("tokenization")) {
        await ensureUserWallet(deps, `${d.prefix}.issuer@tokenlayer.dev`, d.issuerWallet, `${d.name} Desk`);
      }
    }
    // Seed one example credential use case (Identity domain) so the Identity
    // section is populated on a fresh boot. Idempotent — and only where that
    // product is sold: this ran unconditionally, writing an identity row into a
    // tokenization-only deployment that has no route to serve it.
    if (env.enabledDomains.includes("identity") && !(await credentialUseCases.has("corp-trade-credentials"))) {
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

  // Started HERE and nowhere else — deliberately NOT inside buildApp, so the
  // test harness (which builds hundreds of apps) never starts a live timer that
  // outlives the test that created it.
  //
  // The dispatcher is in-process: while this API is down, the emit path is down
  // with it, so nothing accumulates AND nothing is delivered. An integrator that
  // missed deliveries catches up through the cursor API (GET /events?after=),
  // which is the documented recovery path — not this worker.
  if (env.webhooksEnabled) {
    const stop = startDispatcher(
      {
        events,
        webhookEndpoints,
        webhookDeliveries,
        // The SAME box the routes sealed with — see deps.secretBox above. A
        // second `createSecretBox` here would work only by coincidence of both
        // reading the same env var, and would break silently the day they did not.
        secretBox: deps.secretBox,
        // Configuration is read HERE and handed in. dispatcher.ts imports no
        // env at all: it used to, and that made `import`ing it a boot-time
        // assertion which crashed the dispatcher TEST FILE in any checkout
        // without a .env — sixteen security tests that stopped running while
        // the suite still went green.
        send: createHttpSender(env.webhooksTimeoutMs),
        // The SAME guard posture the registration route uses, or a URL that was
        // legal to save would be permanently undeliverable.
        guard: { allowInsecureLoopback: env.webhooksAllowInsecure },
      },
      env.webhooksPollMs,
    );
    // AWAIT the running pass before exiting, rather than merely cancelling the
    // timer and exiting immediately — that cancelled the ticker while killing
    // the pass mid-send, stranding every row it had claimed as `inflight`,
    // which is precisely what this handler exists to avoid.
    //
    // Bounded, because a pass can legitimately take batchSize × the per-attempt
    // timeout, and an orchestrator will SIGKILL long before that. So: wait for
    // the pass, but no longer than the grace below, then go. Anything still
    // claimed when we give up is picked up by `reclaimStale` on the next
    // process's first pass — that sweep, not this handler, is the guarantee.
    const SHUTDOWN_GRACE_MS = 5_000;
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.once(sig, () => {
        void Promise.race([stop(), new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS).unref?.())]).then(() => {
          process.exit(0);
        });
      });
    }
    console.log(`[webhooks] dispatcher polling every ${env.webhooksPollMs}ms`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
