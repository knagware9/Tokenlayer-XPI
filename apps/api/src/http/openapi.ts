/**
 * EN-D1: the OpenAPI document's IDENTITY — who this API is, how you prove who
 * you are, and what the groups mean. Deliberately knows nothing about any
 * individual route: per-route `security` and response documentation belong on
 * the route schemas, and mixing the two is how the old inline block in app.ts
 * drifted three sub-projects out of date without anyone noticing.
 *
 * The document is the ONLY thing a machine integrator reads before writing
 * code against us, so a wrong sentence here is a wrong instruction delivered at
 * scale. Two of the three things it used to say were false:
 *
 *  - It declared ONE credential, `bearerAuth` with `bearerFormat: "JWT"`. EN-B
 *    keys are opaque `tl_live_…` strings — not JWTs, not decodable, carrying no
 *    claims. Every integrator who followed the document would have tried to
 *    read an expiry out of a random secret.
 *  - It described 6 of the 23 tags in use, so API Keys, Webhooks, Credentials
 *    and Verification — the entire integration surface EN-B and EN-C added —
 *    rendered as an unlabelled heap.
 *
 * `openapiConfig` is a pure function of the one thing that varies per
 * deployment (the public base URL), which is what makes it testable from the
 * contract test without booting a server.
 */
import { createRequire } from "node:module";

/**
 * The version is READ, never written. A literal here is a promise nobody
 * renews: `1.0.0` survived EN-A, EN-B and EN-C unchanged while the surface it
 * described tripled.
 */
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

/** The prefix every route is registered under, and which every documented path therefore already carries. */
const API_PREFIX = "/api/v1";

/**
 * The `servers` entry, derived from the deployment's public API URL.
 *
 * `deps.publicApiUrl` points at the VERSIONED root (`https://host/api/v1`) —
 * it is what credential status URLs are built from — but the document's paths
 * are Fastify's route paths, which already begin `/api/v1`. Naming the
 * versioned root as the server would make every URL resolve to
 * `…/api/v1/api/v1/assets`, and `@fastify/swagger` "helpfully" avoids that by
 * STRIPPING the matching prefix off all 121 paths instead — a silently
 * different document, and one the pre-EN-D1 `api.test.ts` contract (paths are
 * fully qualified) already forbids.
 *
 * So the server is the public root with that one suffix removed, leaving
 * server + path composing back to exactly the URL a caller must hit. Any
 * deeper mount point (`https://host/xi/api/v1`) is preserved, which is why this
 * trims the suffix rather than taking the origin.
 */
function serverUrlFor(publicApiUrl: string): string {
  const trimmed = publicApiUrl.replace(/\/+$/, "");
  return trimmed.endsWith(API_PREFIX) ? trimmed.slice(0, -API_PREFIX.length) : trimmed;
}

/**
 * The two credentials this API accepts, and the difference between them.
 *
 * Both arrive in the SAME header (`Authorization: Bearer …`) and are told apart
 * by the token's shape, so documenting them as one scheme was not merely
 * imprecise — it hid an entire authentication path.
 */
const securitySchemes = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "A HUMAN session token, minted by `POST /auth/login` and valid for 8 hours. " +
      "Carries the signed-in user's identity, role and scope as claims. " +
      "Service accounts cannot log in — a machine integration must use an org API key instead (see `apiKeyAuth`).",
  },
  apiKeyAuth: {
    type: "http",
    scheme: "bearer",
    // NO `bearerFormat`. The value is an OPAQUE secret — there is no payload to
    // decode, no expiry to read out of it, nothing to parse. Naming a format
    // invites integrators to treat it as structured, which is exactly the bug
    // this module exists to correct.
    description:
      "An ORGANIZATION API key, sent as `Authorization: Bearer tl_live_…`. The value is an opaque secret " +
      "shown once at creation and stored only as a hash — it is not a JWT and carries no readable claims.\n\n" +
      "A key authenticates AS its bound service user, so every check that applies to that person still applies to " +
      "the key: their role, their organization's capability envelope, and maker-checker on anything that mutates. " +
      "A key's scopes only ever NARROW that — they subtract from what the bound user could already do and can never " +
      "widen it, so a scope cannot buy access the underlying account does not have.",
  },
} as const;

/**
 * Every tag any route uses, in the order integrators meet them: the machine
 * integration surface first, then administration, then reference data.
 * `openapi-contract.test.ts` fails the build if a route ever uses a tag that is
 * not described here — an undescribed tag renders as an unlabelled group, which
 * is how four of these went missing for three sub-projects.
 */
const tags = [
  // --- Integration surface: what a machine caller is here to do ------------
  { name: "Auth", description: "Human sign-in: password login, session identity, device and QR enrolment. Service accounts cannot log in — machines use an org API key." },
  { name: "API Keys", description: "Org-scoped machine credentials (`tl_live_…`): mint, list, revoke. Each key binds to a service user and carries scopes that only narrow what that user may do." },
  { name: "Webhooks", description: "Outbound event delivery: register endpoints, rotate signing secrets, and inspect the durable delivery log. Payloads are HMAC-signed; verify the signature before trusting one." },
  { name: "Credentials", description: "W3C Verifiable Credentials: issue, present, accept, revoke, and the public status endpoint a verifier resolves." },
  { name: "Credential Use Cases", description: "Low-code definitions of a credential type — its claim schema, issuance rules and certificate design — plus the templates new ones are provisioned from." },
  { name: "Verification", description: "Verifier-side requests: ask a holder to present a credential, then read the verified result." },
  { name: "Identity", description: "DIDs and the identity domain's wallet: resolution, challenges, and the holder's own credential store." },
  { name: "Assets", description: "Tokenized asset issuance and queries across chains and token standards (ERC-20/721/3643)." },
  { name: "Use Cases", description: "Low-code asset-type definitions: fields, compliance rules, fees, and the contracts they deploy." },
  { name: "Lifecycle", description: "Compliance-aware token operations: mint, transfer, burn, freeze, allow." },
  { name: "Marketplace", description: "Secondary market: escrowed listings, offers and settlement." },
  { name: "Invoice Register", description: "Server-side invoice staging: import or pull from an ERP, then selectively tokenize." },
  { name: "Cashflows", description: "Scheduled and realized cashflows attached to an asset — coupons, redemptions, distributions." },
  { name: "Proposals", description: "Maker-checker: the pending record most mutations create, and the approve/reject decisions that execute or discard it." },

  // --- Administration: running the tenant --------------------------------
  { name: "Organizations", description: "The top-level tenant: KYB onboarding, DID issuance, membership, roles and the capability envelope that bounds every request its members make." },
  { name: "Users", description: "Scoped user provisioning and account administration, gated by maker-checker." },
  { name: "Documents", description: "Uploaded evidence — KYB certificates, asset documentation — and their download endpoints." },
  { name: "Audit", description: "The append-only audit trail and its on-chain anchors, with verification of the hash chain." },
  { name: "Analytics", description: "Aggregate dashboards over issuance, holders, lifecycle activity and credential operations." },
  { name: "Investor", description: "The holder-facing portal: portfolio, holdings and available offerings." },
  { name: "Cash", description: "Off-chain cash balances and ledger entries backing settlement." },

  // --- Reference data ------------------------------------------------------
  { name: "Catalog", description: "Reference data: available chains, their live status, and platform accounts." },
  { name: "Config", description: "Deployment configuration a client needs to render itself: enabled domains, currencies and feature availability." },
];

const description = `XI is one platform over two domains: **tokenization** (configure use cases, issue assets across DLTs and token standards, run the compliance-aware lifecycle, trade on the secondary market) and **identity** (issue, present, verify and revoke W3C Verifiable Credentials).

**Most mutations return \`202\` with a proposal, not the object you asked to create.** Maker-checker is the platform's default posture: the request records an intent, and the work happens when a second, distinct authorized person approves it. Write your integration to read \`proposal.id\` from a 202 and follow the proposal to its terminal state — treating a 202 as a completed create is the single most common integration mistake here. The routes that do complete synchronously say so in their own responses.

**Two credentials, one header.** A human sends a session JWT from \`POST /auth/login\`; a machine sends an opaque organization API key (\`tl_live_…\`). Both go in \`Authorization: Bearer …\`. See the security schemes for which routes accept which.

**Every request is additionally bounded by the caller organization's capability envelope.** Beyond role and scope, an organization is provisioned with the domains and operating roles it may exercise; an act outside that envelope is refused with \`403 ORG_CAPABILITY_MISSING\` regardless of how privileged the caller is.

Events for anything durable are emitted to the event log and delivered to registered webhook endpoints, HMAC-signed.`;

/** The document's identity, as `@fastify/swagger` expects it. */
export function openapiConfig(publicApiUrl: string) {
  return {
    openapi: {
      info: { title: "XI Tokenize API", version, description },
      // Where the API actually lives. Absent before EN-D1, which left every
      // generated client and every "Try it" button guessing at a base URL.
      servers: [{ url: serverUrlFor(publicApiUrl) }],
      components: { securitySchemes },
      tags,
    },
  };
}
