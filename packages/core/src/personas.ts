/**
 * WHO IS THIS CONTAINER FOR?
 *
 * `ENABLED_DOMAINS` already answers "which PRODUCT does this deployment serve"
 * (see apps/api/src/http/route-domains.ts). This file answers the next question
 * down: within one product, which AUDIENCE does a given container serve — the
 * authority issuing credentials, the relying party checking them, or the person
 * holding them?
 *
 * That distinction becomes a deployment artifact. Each persona gets its own
 * container pair: a web app narrowed to that audience's surfaces, and an EDGE —
 * an nginx reverse proxy in front of the product's API that admits only the
 * routes this persona legitimately needs and answers 404 to everything else. A
 * holder's browser cannot reach `POST /orgs/:id/users` because the container it
 * talks to does not route it, not merely because the UI omits a button.
 *
 * ── WHY EACH PRODUCT KEEPS ONE API, AND THE BOUNDARY LIVES AT THE EDGE ──────
 *
 * Six API PROCESSES — one per persona — was the first design, and it does not
 * work on SQLite. The three identity personas must read and write the SAME
 * data: an issued credential has to be visible to the holder and checkable by
 * the verifier. Three containers writing one SQLite file over a shared volume is
 * a corruption hazard, not a theoretical one.
 *
 * Six real processes therefore need a real database server, which means a
 * Postgres migration — and Prisma pins one provider per schema, so that would
 * drag the whole test suite with it. So each product keeps exactly ONE writer,
 * and the persona boundary is enforced at the edge, where it is a network fact
 * rather than a convention. Revisit if this ever moves to Postgres.
 *
 * ── WHY A TABLE, AND WHY HERE ───────────────────────────────────────────────
 *
 * An allowlist living in hand-written nginx would be a SECOND copy of routing
 * knowledge, and the second copy is always the one that goes stale: a route
 * added next year answers on the API and 404s at the edge, and the failure
 * surfaces as an unreproducible bug in one deployment shape. So the allowlist
 * lives here, in the same package the API and the web app both already import,
 * and the nginx configs are GENERATED from it (scripts/gen-persona-edges.mjs).
 * The generated files are committed, and a test regenerates them and fails on
 * any diff — the config cannot drift from this table without a red build.
 *
 * Two anti-drift controls sit in personas.test.ts, and they point in opposite
 * directions on purpose:
 *
 *   · NO DEAD RULE — every prefix below must match at least one real route.
 *     A rule for a route that was renamed is an allowlist entry nobody audits
 *     and that grants nothing; it reads as coverage while providing none.
 *   · NO ORPHAN ROUTE — every route in the API surface must be reachable by at
 *     least one persona, or be named in DELIBERATELY_UNREACHABLE with a reason.
 *     Without this, adding a route quietly makes a capability unreachable in the
 *     containerized topology, and the only symptom is a feature that "doesn't
 *     work in Docker".
 *
 * ── MATCHING ────────────────────────────────────────────────────────────────
 *
 * Rules are (method set, route-PATTERN prefix) and match on segment boundaries,
 * so `/credentials` can never capture `/credential-types`. Unlike the domain
 * table there is no longest-prefix arbitration: this is an allowlist, so ANY
 * rule that covers the pattern and permits the method admits the request. That
 * keeps the semantics of adding a rule obvious — it can only ever widen — but it
 * does mean a broad prefix grants everything beneath it. Every rule below is
 * therefore written as narrowly as the surface allows, and the ones that look
 * broad carry a comment saying why.
 */

export type PersonaKey =
  | "identity-issuer"
  | "identity-verifier"
  | "identity-holder"
  | "tokenization-issuer"
  | "tokenization-marketplace"
  | "tokenization-admin";

export type PersonaDomain = "identity" | "tokenization";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** `"ALL"` means every method; otherwise only the listed ones. */
export type MethodSet = "ALL" | readonly HttpMethod[];

export interface PersonaRule {
  /** A route-pattern prefix, e.g. `/orgs/:id/credentials`. */
  readonly prefix: string;
  readonly methods: MethodSet;
  /**
   * Match ONLY this exact pattern, admitting nothing beneath it.
   *
   * Needed because some routes are a prefix of routes belonging to a different
   * product. `/me` is the session — every persona needs it — but `/me/portfolio`
   * is tokenization's and `/me/credentials` is identity's. As a prefix rule,
   * baseline `/me` handed every edge both. That is not hypothetical: it is what
   * the first version of this file did, and personas.test.ts caught it.
   */
  readonly exact?: true;
  /** Why this persona needs it — read by whoever audits the boundary. */
  readonly why: string;
}

export interface PersonaDef {
  readonly key: PersonaKey;
  readonly domain: PersonaDomain;
  readonly label: string;
  /** One line for the container's landing page and the compose file. */
  readonly description: string;
  /**
   * WHICH CONSOLE this app renders, independent of the signed-in role.
   *
   * The web app picks its shell from the user's ROLE — investor portal for a
   * Buyer, operator desk for a UseCaseAdmin, platform console for an admin. In a
   * persona deployment that is the wrong question: the Marketplace container is
   * the investor app whoever signs in, and choosing by role gave a PlatformAdmin
   * the platform console's nav intersected down to "My Profile" and "Logout".
   *
   *   "self-service"  what a member of the public sees — their own wallet,
   *                   their own portfolio. Never a roster or a ledger.
   *   "console"       an organization's staff console, chosen by role as before.
   */
  readonly shell: "self-service" | "console";
  /** Web nav ids this app may render (intersected with role RBAC, never a widening). */
  readonly surfaces: readonly string[];
  readonly defaultView: string;
  readonly allow: readonly PersonaRule[];
}

/**
 * EVERY persona needs these or its app cannot function at all: a login, the
 * session, the deployment's own description, and the brand it wears.
 */
const BASELINE: readonly PersonaRule[] = [
  { prefix: "/auth", methods: "ALL", why: "sign in — password and the QR/device-key flow" },
  { prefix: "/config", methods: ["GET"], why: "which products this deployment serves; the shell reads it at boot" },
  // EXACT: `/me` is the session, but `/me/portfolio` is tokenization's and
  // `/me/credentials` is identity's. As a prefix rule this handed every edge both.
  { prefix: "/me", methods: ["GET"], exact: true, why: "the current session's own user" },
  { prefix: "/me/login-keys", methods: "ALL", why: "enrol and list this person's own device keys" },
  { prefix: "/chains", methods: ["GET"], why: "chain labels — a credential's anchor and an asset's ledger both render one" },
  // NARROW ON PURPOSE: the branding subpath only. A bare `/orgs` rule here would
  // hand every persona the roster, the API keys and the approval queue.
  { prefix: "/orgs/:id/branding/logo", methods: ["GET"], why: "the shell wears the org's logo" },
  // Public and unauthenticated by design — every app's login screen may link to it.
  { prefix: "/orgs/register", methods: "ALL", why: "public self-service signup, including its KYB document upload" },
];

/**
 * STAFF apps additionally administer their own organization. The line drawn
 * here is the load-bearing one in this file:
 *
 *   · A STAFF app (issuer, verifier, tokenization admin) belongs to an
 *     organization's employees. Roster, API keys, webhooks, the approval queue
 *     and the audit log are part of their job.
 *   · An END-USER app (holder, marketplace) belongs to a member of the public.
 *     It gets self-service only. No roster, no keys, no audit — which is why
 *     `/orgs` never appears in those two personas at any width.
 *
 * Note how `/orgs` and `/users` are ENUMERATED rather than granted whole. Both
 * host routes belonging to the identity product — `/orgs/:id/credentials`,
 * `/orgs/:id/wallet`, `/users/:id/identity` — so a blanket `/orgs` rule put
 * identity's surface on tokenization's edges. The API behind them would have
 * 404'd anyway, but an edge that leans on the service behind it is not a
 * boundary; it is a comment. persona-edges.test.ts caught exactly this.
 */
const STAFF_BASELINE: readonly PersonaRule[] = [
  { prefix: "/orgs", methods: "ALL", exact: true, why: "list organizations and create one" },
  { prefix: "/orgs/:id", methods: ["GET"], exact: true, why: "read one organization" },
  { prefix: "/orgs/:id/members", methods: ["GET"], why: "the organization's roster" },
  { prefix: "/orgs/:id/users", methods: ["POST"], why: "onboard a member, which mints their sub-DID" },
  { prefix: "/orgs/:id/api-keys", methods: "ALL", why: "mint, list and rotate the org's integration keys" },
  { prefix: "/orgs/:id/webhooks", methods: "ALL", why: "manage endpoints, replay deliveries, rotate secrets" },
  { prefix: "/orgs/:id/branding", methods: "ALL", why: "set the logo and accent the shell wears" },
  { prefix: "/orgs/:id/capabilities", methods: "ALL", why: "request a wider capability envelope" },
  { prefix: "/orgs/:id/approve", methods: ["POST"], why: "the platform's organization approval queue" },
  { prefix: "/orgs/:id/reject", methods: ["POST"], why: "the other half of that queue" },
  { prefix: "/users", methods: "ALL", exact: true, why: "list people and propose onboarding one" },
  // EXACT again: `/users/:id/identity` and `/users/:id/revoke-identity` are the
  // identity product's, and a prefix rule here would put them on every staff edge.
  { prefix: "/users/:id", methods: ["PATCH", "DELETE"], exact: true, why: "edit or deactivate a member of the roster" },
  { prefix: "/users/batch", methods: ["POST"], why: "CSV batch onboarding" },
  { prefix: "/proposals", methods: "ALL", why: "the maker-checker queue every gated action lands in" },
  { prefix: "/audit", methods: "ALL", why: "the hash-chained log and its anchoring" },
  { prefix: "/events", methods: ["GET"], why: "the activity feed behind the audit console" },
  { prefix: "/documents", methods: "ALL", why: "upload and fetch supporting documents" },
];

export const PERSONAS: readonly PersonaDef[] = [
  // ── Identity ────────────────────────────────────────────────────────────
  {
    key: "identity-issuer",
    shell: "console",
    domain: "identity",
    label: "Issuer Console",
    description: "An authority defines credential programmes and issues, reissues and revokes credentials.",
    defaultView: "identity",
    surfaces: [
      "identity", "identity-dashboard", "issue-credentials", "schemes", "credentials",
      "organizations", "developers", "users", "approvals", "audit", "profile", "logout", "back",
    ],
    allow: [
      { prefix: "/credential-use-cases", methods: "ALL", why: "define programmes, issue against them, batch-issue, design certificates" },
      { prefix: "/credential-use-case-templates", methods: "ALL", why: "save and instantiate programme templates" },
      { prefix: "/credential-templates", methods: ["GET"], why: "the built-in template catalogue" },
      { prefix: "/credential-types", methods: ["GET"], why: "the credential-type vocabulary" },
      { prefix: "/credentials", methods: "ALL", why: "revoke, read status, render the certificate, take issuance requests" },
      { prefix: "/identity/dashboard", methods: ["GET"], why: "issuance and acceptance figures for its own programmes" },
      { prefix: "/dids", methods: ["GET"], why: "resolve a subject's DID before issuing to it" },
      { prefix: "/registry", methods: ["GET"], why: "which on-chain registries this deployment anchors to" },
      { prefix: "/users/:id/revoke-identity", methods: ["POST"], why: "withdraw a person's identity, chain-first" },
      { prefix: "/users/:id/identity", methods: "ALL", why: "the per-user verification challenge and its check" },
      // Identity-owned subpaths of the shared /orgs tree — granted here rather
      // than in STAFF_BASELINE so a tokenization edge never carries them.
      { prefix: "/orgs/:id/credentials", methods: ["GET"], why: "this authority's own register of what it has issued" },
      { prefix: "/orgs/:id/wallet", methods: ["GET"], why: "credentials the organization itself holds" },
    ],
  },
  {
    key: "identity-verifier",
    shell: "console",
    domain: "identity",
    label: "Verifier Console",
    description: "A relying party asks a holder for credentials and checks the answer against the chain.",
    defaultView: "verify",
    surfaces: [
      "verify", "credentials", "organizations", "developers", "users", "approvals", "audit", "profile", "logout", "back",
    ],
    allow: [
      { prefix: "/verification-requests", methods: "ALL", why: "raise a request, read the inbox, run the verification" },
      // NOT `/credentials` — a verifier must never reach revoke or the issuance
      // request queue. Only the two read paths it genuinely needs.
      { prefix: "/credentials/:id/status", methods: ["GET"], why: "the chain-backed revocation check" },
      { prefix: "/credential-use-cases", methods: ["GET"], why: "pick which programme's credential to ask for" },
      { prefix: "/credential-types", methods: ["GET"], why: "the credential-type vocabulary" },
      { prefix: "/dids", methods: ["GET"], why: "resolve the holder's DID and the issuer's" },
      { prefix: "/registry", methods: ["GET"], why: "name the registry that answered a revocation check" },
    ],
  },
  {
    key: "identity-holder",
    shell: "self-service",
    domain: "identity",
    label: "Wallet",
    description: "A person holds their credentials, accepts or rejects what is offered, and consents to share.",
    defaultView: "credentials",
    surfaces: ["credentials", "profile", "logout"],
    allow: [
      { prefix: "/me/credentials", methods: "ALL", why: "the wallet, and accept / reject / request-changes on each offer" },
      { prefix: "/me/verification-requests", methods: ["GET"], why: "requests awaiting this holder's consent" },
      // The holder answers a request; it must not be able to LIST or VERIFY
      // them, which is why `/verification-requests` is not allowed at any width
      // and only these two leaf actions are.
      { prefix: "/verification-requests/:id/consent", methods: ["POST"], why: "consent to share, which signs the presentation" },
      { prefix: "/verification-requests/:id/reject", methods: ["POST"], why: "decline to share" },
      { prefix: "/credentials/:id/certificate.pdf", methods: ["GET"], why: "download one's own certificate" },
      { prefix: "/credentials/:id/status", methods: ["GET"], why: "see whether one's own credential is still in force" },
      { prefix: "/dids", methods: ["GET"], why: "show and resolve one's own DID" },
    ],
  },

  // ── Tokenization ────────────────────────────────────────────────────────
  {
    key: "tokenization-issuer",
    shell: "console",
    domain: "tokenization",
    label: "Issuer Desk",
    description: "An issuer configures use cases, stages invoices and mints assets onto a ledger.",
    defaultView: "dashboard",
    surfaces: [
      "dashboard", "use-cases", "create", "assets", "invoices", "credentials",
      "organizations", "developers", "users", "approvals", "audit", "profile", "logout", "back",
    ],
    allow: [
      { prefix: "/use-cases", methods: "ALL", why: "configure, deploy, and run the invoice register" },
      { prefix: "/assets", methods: "ALL", why: "mint, allowlist, transfer, run cashflows" },
      { prefix: "/accounts", methods: ["GET"], why: "settlement accounts within its scope" },
      { prefix: "/currencies", methods: ["GET"], why: "the settlement-currency catalogue" },
      { prefix: "/analytics", methods: ["GET"], why: "its own issuance dashboard" },
    ],
  },
  {
    key: "tokenization-marketplace",
    shell: "self-service",
    domain: "tokenization",
    label: "Marketplace",
    description: "An investor browses offerings, buys and sells units, and watches their portfolio.",
    defaultView: "portfolio",
    surfaces: ["portfolio", "offerings", "transactions", "profile", "logout"],
    allow: [
      { prefix: "/me/portfolio", methods: ["GET"], why: "own holdings" },
      { prefix: "/me/activity", methods: ["GET"], why: "own transaction history" },
      // READ-ONLY on the asset surface, plus the two actions an investor takes.
      // A bare `/assets` ALL rule would hand a retail user mint and freeze.
      { prefix: "/assets", methods: ["GET"], why: "browse offerings and their detail" },
      { prefix: "/assets/:id/buy", methods: ["POST"], why: "buy units of an offering" },
      { prefix: "/assets/:id/listings", methods: "ALL", why: "list one's own units for sale" },
      { prefix: "/listings", methods: "ALL", why: "take another holder's listing off the secondary market" },
      { prefix: "/cash/balances", methods: ["GET"], why: "own settlement balance" },
      { prefix: "/currencies", methods: ["GET"], why: "render prices in the right currency" },
    ],
  },
  {
    key: "tokenization-admin",
    shell: "console",
    domain: "tokenization",
    label: "Platform Admin",
    description: "The platform operator approves organizations, oversees every use case, and audits the ledger.",
    defaultView: "dashboard",
    surfaces: [
      "dashboard", "use-cases", "create", "assets", "invoices", "networks", "credentials",
      "organizations", "developers", "users", "approvals", "audit", "profile", "logout", "back",
    ],
    allow: [
      { prefix: "/use-cases", methods: "ALL", why: "oversee and configure every use case" },
      { prefix: "/assets", methods: "ALL", why: "the whole asset ledger" },
      { prefix: "/listings", methods: "ALL", why: "oversee the secondary market" },
      { prefix: "/accounts", methods: ["GET"], why: "the settlement account catalogue" },
      { prefix: "/cash", methods: "ALL", why: "credit settlement accounts and read balances" },
      { prefix: "/currencies", methods: ["GET"], why: "the settlement-currency catalogue" },
      { prefix: "/analytics", methods: ["GET"], why: "the platform dashboard" },
    ],
  },
];

/**
 * Routes no persona edge exposes, and why. The orphan-route test consults this,
 * so adding a route without either granting it to a persona or naming it here
 * fails the build rather than silently becoming unreachable in Docker.
 */
export const DELIBERATELY_UNREACHABLE: ReadonlyArray<readonly [string, string]> = [
  ["/identity/assertions", "service-to-service only: tokenization's API asks identity's whether a subject holds a credential, with an identity:assert peer key. Exposing it at a public edge would publish an identity oracle."],
  ["/identity/mint", "a development-only issuer used to seed demo credentials; it has no place on any deployed edge."],
];

const ALL_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** True when `pattern` is `prefix` exactly, or a child segment of it. */
function coversPattern(rule: PersonaRule, pattern: string): boolean {
  if (rule.exact) return pattern === rule.prefix;
  return pattern === rule.prefix || pattern.startsWith(rule.prefix + "/");
}

function methodPermitted(methods: MethodSet, method: string): boolean {
  return methods === "ALL" || (methods as readonly string[]).includes(method.toUpperCase());
}

export function personaByKey(key: string): PersonaDef | undefined {
  return PERSONAS.find((p) => p.key === key);
}

/** Every rule this persona's edge enforces, baseline included, in match order. */
export function personaRules(persona: PersonaDef): readonly PersonaRule[] {
  const staff = persona.key !== "identity-holder" && persona.key !== "tokenization-marketplace";
  return [...BASELINE, ...(staff ? STAFF_BASELINE : []), ...persona.allow];
}

/**
 * Does this persona's edge admit `method pattern`?
 *
 * ALLOWLIST semantics: any covering rule that permits the method admits it.
 * Absence is refusal — there is no default-allow anywhere in this file, which is
 * the whole point of putting the boundary in a container.
 */
export function personaAllows(persona: PersonaDef, method: string, pattern: string): boolean {
  return personaRules(persona).some((r) => coversPattern(r, pattern) && methodPermitted(r.methods, method));
}

/** The methods a persona admits on a pattern — what the edge's method guard emits. */
export function personaMethodsFor(persona: PersonaDef, pattern: string): readonly HttpMethod[] {
  return ALL_METHODS.filter((m) => personaAllows(persona, m, pattern));
}

/** Personas serving one product — the edges a domain's compose stanza needs. */
export function personasForDomain(domain: PersonaDomain): readonly PersonaDef[] {
  return PERSONAS.filter((p) => p.domain === domain);
}
