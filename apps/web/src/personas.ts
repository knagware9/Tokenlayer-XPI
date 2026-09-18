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
  /**
   * True when this persona's UI needs use-case metadata to render something
   * it does show (e.g. an asset's compliance/lifecycle rules), even though it
   * has no "use-cases" surface of its own. This is deliberately NOT a mirror
   * of a server route grant — it carries no prefix or method, only "does this
   * screen need this data" — so it stays outside the boundary the class doc
   * above says never to restate. `surfaces.includes("use-cases")` answers a
   * different question (does the Use Cases nav item/tab appear); conflating
   * the two previously meant a persona like this one could only ever see a
   * loading skeleton for screens that needed the data but not the tab.
   */
  needsUseCaseData?: boolean;
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
    needsUseCaseData: true,
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

/**
 * Whether the active persona's edge can be asked for use-case data — true for
 * the combined console (no persona narrows it), for any persona whose Use
 * Cases surface is shown, and for one that needs the data without the surface
 * (see `needsUseCaseData`). Centralised so nav-visibility and data-fetch
 * permission are computed the same way everywhere that needs it, instead of
 * each call site re-deriving (and risking re-diverging on) the same check.
 */
export function personaReadsUseCases(persona: WebPersona | null | undefined): boolean {
  return !persona || persona.surfaces.includes("use-cases") || !!persona.needsUseCaseData;
}
