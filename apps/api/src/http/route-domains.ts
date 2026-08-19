/**
 * WHICH PRODUCT DOES A ROUTE BELONG TO?
 *
 * XI Tokenize ships as two products that can be deployed separately —
 * Tokenization and Identity — plus the platform both stand on (auth,
 * organizations, users, maker-checker proposals, the audit chain, documents,
 * webhooks). `ENABLED_DOMAINS` says which products THIS deployment serves.
 *
 * Before this file, that setting reached exactly one route: `GET /config`, which
 * tells the console which navigation to draw. Every identity route still
 * answered on a deployment that had switched identity off — the separation was
 * a menu, not a boundary. This table is what makes it real.
 *
 * MATCHING is longest-prefix on the ROUTE PATTERN (`/orgs/:id/wallet`, not a
 * concrete URL), and a prefix only matches on a segment boundary so
 * `/credential-types` can never be captured by a `/credential` rule. Longest
 * wins, which is what lets a shared prefix host routes of both products:
 *
 *     /me                     shared        (the session)
 *     /me/portfolio           tokenization  (holdings)
 *     /me/credentials         identity      (the wallet)
 *
 * UNCLASSIFIED IS A BOOT FAILURE, not a default. A default would be the
 * null-as-allow trap this codebase keeps meeting: a new identity route added
 * next year would quietly answer on a tokenization-only deployment, and nothing
 * would say so. `classifyRoute` returns undefined and the caller refuses to
 * start, naming the route. You cannot ship an unclassified route.
 */

export type RouteDomain = "identity" | "tokenization" | "shared";

/**
 * Rules are (pattern prefix → domain). Order is irrelevant: the LONGEST
 * matching prefix wins, so a specific rule always beats the general one it sits
 * under. Every route in the surface must be covered by exactly one longest
 * match; `assertEveryRouteClassified` proves it at boot.
 */
const RULES: ReadonlyArray<readonly [string, RouteDomain]> = [
  // ── Identity ────────────────────────────────────────────────────────────
  // Credential use cases, their templates, and the certificate designer.
  ["/credential-use-cases", "identity"],
  ["/credential-use-case-templates", "identity"],
  ["/credential-templates", "identity"],
  ["/credential-types", "identity"],
  // Issued credentials: the public status endpoint, revocation, the PDF.
  ["/credentials", "identity"],
  // Presentation exchange.
  ["/verification-requests", "identity"],
  ["/me/verification-requests", "identity"],
  // The holder's wallet and the acceptance lifecycle.
  ["/me/credentials", "identity"],
  // An organization's own wallet of held credentials.
  ["/orgs/:id/credentials", "identity"],
  ["/orgs/:id/wallet", "identity"],
  // DID resolution, the dev issuer, the identity dashboard.
  ["/dids", "identity"],
  ["/identity", "identity"],
  // Per-user identity verification and its reversal.
  ["/users/:id/identity", "identity"],
  ["/users/:id/revoke-identity", "identity"],
  // The on-chain DidRegistry/VcRegistry deployment this instance anchors to.
  ["/registry", "identity"],

  // ── Tokenization ────────────────────────────────────────────────────────
  ["/use-cases", "tokenization"],
  ["/assets", "tokenization"],
  ["/listings", "tokenization"],
  ["/accounts", "tokenization"],
  ["/cash", "tokenization"],
  ["/currencies", "tokenization"],
  ["/analytics", "tokenization"],
  ["/me/portfolio", "tokenization"],
  ["/me/activity", "tokenization"],

  // ── Shared platform ─────────────────────────────────────────────────────
  // Sessions. NOTE the QR/device-key routes are here, not under identity: they
  // are an AUTHENTICATION mechanism that happens to be built on a DID, and
  // disabling them with the identity product would lock existing operators out
  // of a tokenization-only deployment. Flagged deliberately — if the product
  // decision is that passwordless login is sold WITH Identity, move
  // "/auth/qr" and "/me/login-keys" into the identity block above and nothing
  // else needs to change.
  ["/auth", "shared"],
  ["/me/login-keys", "shared"],
  ["/me", "shared"],
  ["/config", "shared"],
  // Tenancy, roster, capability envelopes, branding, API keys, webhooks.
  ["/orgs", "shared"],
  ["/users", "shared"],
  // Maker-checker, the hash-chained audit log and its anchoring, the document
  // store, the event feed, and the ledger catalogue — Identity anchors DIDs and
  // VCs on a chain too, so `/chains` is not tokenization's alone.
  ["/proposals", "shared"],
  ["/audit", "shared"],
  // Believed-vs-chain supply, across every use case — same platform-wide
  // integrity family as /audit, not owned by either product alone.
  ["/reconciliation", "shared"],
  ["/documents", "shared"],
  ["/events", "shared"],
  ["/chains", "shared"],
];

/** True when `pattern` is `prefix` exactly, or a child segment of it. */
function coversPattern(prefix: string, pattern: string): boolean {
  return pattern === prefix || pattern.startsWith(prefix + "/");
}

/**
 * Strip the mount prefix so rules can be written against the surface an
 * integrator sees. Fastify's `onRoute` reports the fully-prefixed url, but the
 * routes are also registered bare in some test harnesses — accept both rather
 * than depend on which.
 */
export function bareRoutePattern(url: string): string {
  return url.startsWith("/api/v1") ? url.slice("/api/v1".length) || "/" : url;
}

/** The domain owning this route pattern, or undefined when no rule covers it. */
export function classifyRoute(url: string): RouteDomain | undefined {
  const pattern = bareRoutePattern(url);
  let best: RouteDomain | undefined;
  let bestLength = -1;
  for (const [prefix, domain] of RULES) {
    if (coversPattern(prefix, pattern) && prefix.length > bestLength) {
      best = domain;
      bestLength = prefix.length;
    }
  }
  return best;
}

/**
 * True when a deployment serving `enabled` products should answer this route.
 * Shared routes always answer: without them there is no login, no tenant and no
 * approval queue, so neither product would work.
 */
export function routeEnabled(url: string, enabled: readonly string[]): boolean {
  const domain = classifyRoute(url);
  return domain === "shared" || (domain !== undefined && enabled.includes(domain));
}

/** The shape of a Fastify route this gate needs — kept structural so the gate
 *  is testable without standing up a server. */
export interface GateableRoute {
  method: string | string[];
  url: string;
  schema?: unknown;
  handler: unknown;
}

/**
 * Apply the product boundary to one route, in place. Called from the `onRoute`
 * hook in app.ts — which is to say once per route AT REGISTRATION, so the
 * failure below happens at BOOT rather than on some unlucky request.
 *
 * THROWS for an unclassified route. That is the anti-drift control and it is
 * deliberately the harshest one available: a test can be forgotten and a
 * default is a silent lie, but a server that will not start gets fixed.
 *
 * A disabled route keeps its preHandler chain and loses only its handler, so an
 * anonymous caller still meets the 401 it met before — switching a product off
 * must not hand out a free oracle for which products a deployment runs. It is
 * also hidden from the OpenAPI document: a published surface advertising routes
 * that cannot answer is a lie told to every integrator who reads it.
 */
export function applyDomainGate(route: GateableRoute, enabled: readonly string[]): void {
  const domain = classifyRoute(route.url);
  if (!domain) {
    throw new Error(
      `[domains] route ${String(route.method)} ${route.url} is not classified by product domain. ` +
        "Add it to RULES in src/http/route-domains.ts — identity, tokenization or shared. " +
        "There is no default: an unclassified route would answer on a deployment that does not sell it.",
    );
  }
  if (domain === "shared" || enabled.includes(domain)) return;
  route.schema = { ...(route.schema as object), hide: true };
  route.handler = async (_request: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(404).send({
      error: "DOMAIN_NOT_ENABLED",
      message: `this deployment does not serve the '${domain}' product`,
    });
}
