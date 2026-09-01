/**
 * A DELIBERATE MIRROR of `@tokenlayer/core`'s persona catalogue — the SHELL half.
 *
 * The web package does not depend on core (see the same note on API_SCOPES and
 * CERTIFICATE_FIXED_FIELDS in types.ts), so the fields the sidebar needs are
 * restated here and `apps/api/test/persona-mirror.test.ts` fails if the two ever
 * disagree. The API package is the only one that can import core AND read this
 * file, which is why the drift test lives over there.
 *
 * ONLY THE SHELL FIELDS ARE MIRRORED. The `allow` rules — which HTTP routes each
 * persona's edge admits — are deliberately absent: they are enforced by nginx
 * and the API, and a copy in the browser bundle would be a fourth description of
 * the boundary that no user agent consults and nobody would think to audit.
 */
export type PersonaKey =
  | "identity-issuer" | "identity-verifier" | "identity-holder"
  | "tokenization-issuer" | "tokenization-marketplace" | "tokenization-admin";

export interface WebPersona {
  key: PersonaKey;
  domain: "identity" | "tokenization";
  label: string;
  description: string;
  /** Which console this app renders, independent of the signed-in role. */
  shell: "self-service" | "console";
  surfaces: string[];
  defaultView: string;
}

export const PERSONAS: WebPersona[] = [
  {
    key: "identity-issuer", shell: "console", domain: "identity", label: "Issuer Console",
    description: "An authority defines credential programmes and issues, reissues and revokes credentials.",
    defaultView: "identity",
    surfaces: ["identity", "identity-dashboard", "issue-credentials", "credential-schemas", "schemes", "credentials",
      "organizations", "developers", "users", "approvals", "audit", "profile", "logout", "back"],
  },
  {
    key: "identity-verifier", shell: "console", domain: "identity", label: "Verifier Console",
    description: "A relying party asks a holder for credentials and checks the answer against the chain.",
    defaultView: "verify",
    surfaces: ["verify-dashboard", "verify", "credentials", "organizations", "developers", "users", "approvals", "audit", "profile", "logout", "back"],
  },
  {
    key: "identity-holder", shell: "self-service", domain: "identity", label: "Wallet",
    description: "A person holds their credentials, accepts or rejects what is offered, and consents to share.",
    defaultView: "credentials",
    surfaces: ["holder-dashboard", "credentials", "requests", "profile", "logout"],
  },
  {
    key: "tokenization-issuer", shell: "console", domain: "tokenization", label: "Issuer Desk",
    description: "An issuer configures use cases, stages invoices and mints assets onto a ledger.",
    defaultView: "dashboard",
    surfaces: ["dashboard", "use-cases", "create", "assets", "invoices", "activity", "credentials",
      "organizations", "developers", "users", "approvals", "audit", "profile", "logout", "back"],
  },
  {
    key: "tokenization-marketplace", shell: "self-service", domain: "tokenization", label: "Marketplace",
    description: "An investor browses offerings, buys and sells units, and watches their portfolio.",
    defaultView: "portfolio",
    surfaces: ["portfolio", "offerings", "transactions", "profile", "logout"],
  },
  {
    key: "tokenization-admin", shell: "console", domain: "tokenization", label: "Platform Admin",
    description: "The platform operator approves organizations, oversees every use case, and audits the ledger.",
    defaultView: "dashboard",
    surfaces: ["dashboard", "use-cases", "create", "assets", "invoices", "networks", "credentials",
      "organizations", "developers", "users", "approvals", "audit", "profile", "logout", "back"],
  },
];

export function personaByKey(key: string): WebPersona | undefined {
  return PERSONAS.find((p) => p.key === key);
}
