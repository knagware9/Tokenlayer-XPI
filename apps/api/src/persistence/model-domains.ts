/**
 * WHICH PRODUCT OWNS WHICH TABLE — the persistence half of the boundary that
 * `http/route-domains.ts` draws over routes.
 *
 * The route gate stops a deployment ANSWERING for a product it does not sell.
 * It does not stop it WRITING that product's data, and the two are not the same
 * door. A `create-use-case` proposal is approved through `POST /proposals/:id/
 * approve` — a SHARED route, present on every deployment — and its executor
 * writes a tokenization `UseCase`. An identity-only deployment would happily
 * store one and then have no route to serve it. Boot is worse: it seeded
 * tokenization use cases and attempted contract deploys regardless of which
 * products the deployment ran.
 *
 * So ownership is declared here, once, and enforced at the repository seam
 * where every path — routes, proposal executors, boot, the dispatcher — has to
 * pass.
 *
 * THREE DOMAINS, AND `shared` IS NOT A SHRUG. A table is shared when BOTH
 * products genuinely need to write it on their own, not when the answer was
 * awkward. The two that deserve their reasoning stated:
 *
 *   · `Credential` is SHARED, which surprises people. Organization membership
 *     and the roster are built on VCs: adding a member to an org mints a
 *     sub-DID and a membership credential, and that happens on `/orgs/:id/
 *     members`, a shared route, on every deployment. Making it identity-owned
 *     would mean a tokenization deployment could not add a member without a
 *     round trip to the identity service — a far heavier coupling than the one
 *     assertion call the split is built on. The credentials the identity
 *     PRODUCT issues (KYC and the rest) still live only where that product runs.
 *   · `Account` is TOKENIZATION. A wallet is a tokenization concept — the same
 *     line drawn in `identity-assertions.ts`, where only a DID crosses the wire.
 *
 * NO DEFAULT, deliberately, exactly as with routes: a model absent from the
 * table below fails `classifyModel`, and a drift test walks `schema.prisma` so
 * a new model cannot be added without someone deciding who owns it.
 */
import { PolicyError } from "@tokenlayer/core";

export type DataDomain = "identity" | "tokenization" | "shared";

/** Every model in `prisma/schema.prisma`, and the product that owns it. */
export const MODEL_DOMAINS: Readonly<Record<string, DataDomain>> = {
  // ── Tokenization ────────────────────────────────────────────────────────
  UseCase: "tokenization",
  Asset: "tokenization",
  Listing: "tokenization",
  Account: "tokenization",
  CashBalance: "tokenization",
  Cashflow: "tokenization",
  StagedInvoice: "tokenization",

  // ── Identity ────────────────────────────────────────────────────────────
  CredentialUseCase: "identity",
  CredentialUseCaseTemplate: "identity",
  VerificationRequest: "identity",

  // ── Shared platform ─────────────────────────────────────────────────────
  User: "shared",
  ApiKey: "shared",
  Organization: "shared",
  Credential: "shared", // see the header — org membership is built on VCs
  LoginKey: "shared", // passwordless login is authentication, not the identity product
  Proposal: "shared", // maker-checker gates operations in both products
  AuditLog: "shared",
  AuditAnchor: "shared",
  Document: "shared",
  Event: "shared",
  WebhookEndpoint: "shared",
  WebhookDelivery: "shared",
  // Both products anchor on chain: identity writes DIDs and VCs, tokenization
  // anchors audit heads. The deployment record of the registries is shared.
  RegistryDeployment: "shared",
  // Both products write to chains — identity anchors DIDs and VCs, tokenization
  // mints and transfers — so neither owns the record of those writes.
  LedgerTransaction: "shared",
};

/**
 * `AppDeps` repository key → the model it reads and writes.
 *
 * Separate from the table above because the guard wraps REPOSITORIES while
 * ownership is a property of TABLES, and the two are not one-to-one (
 * `RegistryDeployment` has a repository that never reaches `AppDeps`). A test
 * asserts every value here names a model the table classifies.
 */
export const REPOSITORY_MODELS: Readonly<Record<string, string>> = {
  useCases: "UseCase",
  assets: "Asset",
  listings: "Listing",
  accounts: "Account",
  cash: "CashBalance",
  cashflows: "Cashflow",
  stagedInvoices: "StagedInvoice",

  credentialUseCases: "CredentialUseCase",
  credentialTemplates: "CredentialUseCaseTemplate",
  verificationRequests: "VerificationRequest",

  users: "User",
  apiKeys: "ApiKey",
  organizations: "Organization",
  credentials: "Credential",
  loginKeys: "LoginKey",
  proposals: "Proposal",
  audit: "AuditLog",
  auditAnchors: "AuditAnchor",
  documents: "Document",
  events: "Event",
  webhookEndpoints: "WebhookEndpoint",
  webhookDeliveries: "WebhookDelivery",
  ledgerTransactions: "LedgerTransaction",
};

/** The product that owns `model`, or a refusal naming the missing decision. */
export function classifyModel(model: string): DataDomain {
  const domain = MODEL_DOMAINS[model];
  if (!domain) {
    throw new Error(
      `[domains] model '${model}' is not classified by product domain. ` +
        "Add it to MODEL_DOMAINS in src/persistence/model-domains.ts — identity, tokenization or shared. " +
        "There is no default: an unclassified table would be written by a deployment that does not sell it.",
    );
  }
  return domain;
}

/** True when a deployment serving `enabled` products may touch `model` at all. */
export function modelEnabled(model: string, enabled: readonly string[]): boolean {
  const domain = classifyModel(model);
  return domain === "shared" || enabled.includes(domain);
}

/**
 * Wraps a repository so every call REJECTS when this deployment does not own
 * its table. Returns the repository untouched when it does — so the default
 * both-products deployment carries no proxy and no behaviour change at all.
 *
 * REJECTS RATHER THAN THROWS, and rather than answering empty:
 *
 *   · Rejecting (not throwing synchronously) is what lets the existing
 *     `repo.get(k).catch(() => null)` cross-domain lookups keep working — a
 *     synchronous throw would fire before `.catch` was ever attached.
 *   · Answering empty was the tempting alternative and is the same mistake as
 *     returning `false` for an unreachable identity service: "there are none
 *     here" and "this deployment does not keep them" read identically to the
 *     caller and have completely different fixes. The call sites that genuinely
 *     mean "if the other namespace exists here, check it" say so explicitly.
 */
export function guardRepository<T extends object>(repo: T, model: string, enabled: readonly string[]): T {
  if (modelEnabled(model, enabled)) return repo;
  const domain = classifyModel(model);
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return () =>
        Promise.reject(
          new PolicyError(
            "DOMAIN_NOT_ENABLED",
            `this deployment does not serve the '${domain}' product, so it keeps no ${model} data (${model}.${prop})`,
            { domain, model, operation: prop },
          ),
        );
    },
  });
}

/**
 * Applies `guardRepository` to every repository on an `AppDeps`-shaped object.
 *
 * Returns a shallow copy: the caller's object is left alone, so a construction
 * site that also uses the raw repositories (boot seeding) does not silently
 * acquire the guard halfway through.
 *
 * WHAT IT DOES NOT COVER, stated rather than implied: the LifecycleEngine is
 * built over raw repositories before this runs, so engine-internal reads are
 * unguarded. That is deliberate — the engine is tokenization machinery reached
 * only through tokenization routes, which a deployment without that product
 * does not serve — but it means the guard is a second lock on the same door,
 * not the only one.
 */
export function guardRepositories<T extends object>(deps: T, enabled: readonly string[]): T {
  const guarded: Record<string, unknown> = { ...(deps as Record<string, unknown>) };
  for (const [key, model] of Object.entries(REPOSITORY_MODELS)) {
    const repo = (deps as Record<string, unknown>)[key];
    if (repo && typeof repo === "object") guarded[key] = guardRepository(repo as object, model, enabled);
  }
  return guarded as T;
}
