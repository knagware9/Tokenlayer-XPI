import { CREDENTIAL_TEMPLATES, RbacPolicy, type OrgType } from "@tokenlayer/core";
import { buildApp } from "./app.js";
import { buildChainRegistry } from "./shared/chains.js";
import type { AppDeps } from "./context.js";
import { createEngine } from "./context.js";
import { loadCurrencies } from "./tokenization/currencies.js";
import { env } from "./env.js";
import { selectIdentityAssertions } from "./identity/identity-assertions.js";
import { createMemoryChallengeStore } from "./identity/identity-challenges.js";
import { createMemoryQrLoginStore } from "./identity/qr-login-sessions.js";
import { createKeystore } from "./shared/keystore.js";
import { ensureNamedOrg, ensurePlatformIssuerOrg, ensureUserWallet, provisionOrgMemberIdentities, provisionPlatformOperatorIdentities } from "./shared/platform-org.js";
import {
  PrismaAccountRepository,
  PrismaApiKeyRepository,
  PrismaAssetRepository,
  PrismaAuditAnchorRepository,
  PrismaAuditRepository,
  PrismaCashflowRepository,
  PrismaCredentialRepository,
  PrismaOrganizationRepository,
  PrismaPasswordResetTokenRepository,
  PrismaProposalRepository,
  PrismaCashRepository,
  PrismaDocumentRepository,
  PrismaEventRepository,
  PrismaLedgerTransactionRepository,
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
} from "./persistence/prisma/index.js";
import { resolveIdentityRegistry } from "./identity/registry.js";
import { seedDefaults } from "./shared/seed.js";
import { seedUseCases } from "./tokenization/use-cases.js";
import { backfillTreasuries } from "./shared/treasury-backfill.js";
import { rehydrateSimulatedLedgers } from "./tokenization/ledger-replay.js";
import { provisionTreasury } from "./shared/wallets.js";
import { createHttpSender, startDispatcher } from "./webhooks/dispatcher.js";
import { createSecretBox } from "./webhooks/secret-box.js";
import { SmtpMailer } from "./mail/mailer.js";
import { startConfirmer } from "./shared/ledger-confirmer.js";
import { captureFatalAndFlush, initObservability } from "./shared/observability.js";

async function main(): Promise<void> {
  // Before anything else can throw — boot failures (a down chain, a bad
  // migration) are exactly the kind of thing a pilot operator needs paged on.
  initObservability({ dsn: env.sentryDsn, environment: env.sentryEnvironment });
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
  const passwordResetTokens = new PrismaPasswordResetTokenRepository();
  const events = new PrismaEventRepository();
  const webhookEndpoints = new PrismaWebhookEndpointRepository();
  const webhookDeliveries = new PrismaWebhookDeliveryRepository();
  const ledgerTransactions = new PrismaLedgerTransactionRepository();
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
    subjectIdentifiers: env.subjectIdentifiers,
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
    passwordResetTokens,
    events,
    webhookEndpoints,
    webhookDeliveries,
    ledgerTransactions,
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
    subjectIdentifiers: env.subjectIdentifiers,
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
    mail: new SmtpMailer(env.mailFrom, { host: env.smtpHost, port: env.smtpPort, user: env.smtpUser, pass: env.smtpPass }),
  };
  // Resolved BEFORE seedUseCases now: every seeded use case needs an owner.
  const platformOrg = await ensurePlatformIssuerOrg(deps);
  // Seed default use cases and deploy their contracts on each allowed+available
  // chain (best-effort; never crashes boot). Available = present in the registry.
  //
  // ONLY WHERE TOKENIZATION IS SOLD. This ran unconditionally, so an
  // identity-only deployment wrote tokenization use cases it had no route to
  // serve and — worse — spent boot deploying their contracts on a real chain.
  // Boot happens before `buildApp` installs the repository guard, so this is
  // the explicit condition rather than a caught refusal.
  if (env.enabledDomains.includes("tokenization")) {
    await seedUseCases(
      useCases,
      platformOrg.id,
      (label) => provisionTreasury(deps, platformOrg.id, label),
      {
        availableChainIds: new Set(chains.list().map((c) => c.id)),
        // Simulated chains keep their ledger in memory, so a recorded deployment on
        // one is stale the moment this process restarts — seedUseCases re-registers
        // those, and only those. See redeployOnSimulatedChains.
        simulatedChainIds: new Set(chains.list().filter((c) => c.mode === "simulated").map((c) => c.id)),
        deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
      },
    );
    // THE UPGRADE PATH, NOT A SEED. `seedUseCases` deliberately `continue`s on
    // a use case that already exists, so an EXISTING deployment upgraded to
    // this branch would come up with every one of its use cases on
    // `treasuryAccountId: null` — and every issuance with supply or sale terms,
    // and every `setPrice`, 400s MISSING_TREASURY until an operator remembers
    // to run a script against all three live databases. Nobody remembers.
    //
    // Idempotent (it touches only rows still missing an owner or a treasury —
    // see its own tests), so running it on every boot costs one `list()` on a
    // healthy database and closes the gap entirely. `scripts/backfill-
    // treasuries.ts` stays as the one-off/fallback tool, not a required step.
    const backfilled = await backfillTreasuries(deps);
    if (backfilled.ownersAssigned > 0 || backfilled.treasuriesAssigned > 0) {
      console.log(
        `[treasury] boot backfill: ${backfilled.ownersAssigned} use case(s) assigned an owner, ${backfilled.treasuriesAssigned} assigned a treasury`,
      );
    }
    // seedUseCases just re-deployed every simulated-chain contract, which wipes
    // its in-memory balances/supply/allowlist back to empty — replay the audit
    // trail on top so a restart is invisible to totalSupply, balanceOf, and
    // allow/freeze reads (the Buyer's own portfolio already survives a restart
    // because it reads the same audit log instead of live ledger state).
    const rehydrated = await rehydrateSimulatedLedgers(deps);
    if (rehydrated.contracts > 0) {
      console.log(`[ledger-replay] rehydrated ${rehydrated.contracts} simulated contract(s) from ${rehydrated.entries} audit entries`);
    }
  }
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
  const stopDispatcher = env.webhooksEnabled
    ? startDispatcher(
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
      )
    : null;
  if (stopDispatcher) console.log(`[webhooks] dispatcher polling every ${env.webhooksPollMs}ms`);

  // Resolves outstanding LedgerTransaction rows (Task 4) — started unconditionally
  // (not gated on webhooksEnabled: it has nothing to do with webhooks) and, like
  // the dispatcher, ONLY here, never inside buildApp.
  const stopConfirmer = startConfirmer(deps, {
    getReceipt: async (chainId, txHash) => {
      let adapter;
      try {
        adapter = deps.chains.resolveAdapter(chainId);
      } catch {
        // Unknown/absent chain (or CHAIN_STRICT=0 left it unconfigured) is not a
        // failed transaction — leaving the row due means it resolves once the
        // chain is reachable again, rather than dead-ending the row here.
        return null;
      }
      // Optional on the interface: simulated adapters (fabric, canton) confirm
      // on submission and never implement it.
      if (!adapter.getReceipt) return null;
      return adapter.getReceipt(txHash);
    },
  });
  console.log("[ledger] confirmer polling started");

  // ONE shutdown path for both workers, registered unconditionally: stopping the
  // confirmer is synchronous (it only clears a timer — see ledger-confirmer.ts),
  // so it happens first and always. The dispatcher's stop is async and must be
  // AWAITED (not merely cancelled) before exiting, or a pass killed mid-send
  // strands every row it had claimed as `inflight` — exactly what this handler
  // exists to avoid. Bounded by a grace period because a pass can legitimately
  // take batchSize × the per-attempt timeout, and an orchestrator will SIGKILL
  // long before that; anything still claimed when we give up is picked up by
  // `reclaimStale` on the next process's first pass — that sweep, not this
  // handler, is the guarantee.
  const SHUTDOWN_GRACE_MS = 5_000;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      stopConfirmer();
      void Promise.race([
        stopDispatcher ? stopDispatcher() : Promise.resolve(),
        new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS).unref?.()),
      ]).then(() => {
        process.exit(0);
      });
    });
  }
}

main().catch(async (err) => {
  console.error(err);
  await captureFatalAndFlush(err);
  process.exit(1);
});
