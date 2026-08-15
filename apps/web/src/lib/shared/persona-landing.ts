/**
 * WHAT EACH PERSONA'S FRONT DOOR SAYS.
 *
 * Every persona container was serving the same page: "No-code tokenization
 * infrastructure for real-world assets" — including the three IDENTITY ones. A
 * citizen opening their credential wallet was told about cross-chain asset
 * issuance, and nothing anywhere named which of the six apps they had reached.
 *
 * The copy lives here, apart from the component, for the same reason the rest of
 * the persona vocabulary does: it is data with a test on it. The specific thing
 * worth testing is that no page promises a capability its own edge refuses — a
 * landing page is a contract with the reader, and "issue credentials" on the
 * Wallet's front door would be a lie the container itself enforces.
 */
import type { WebPersona } from "../../personas.js";

export interface PersonaLanding {
  /** The product line, shown as an eyebrow above the title. */
  product: string;
  /** What this app IS, in the reader's words rather than the org chart's. */
  headline: string;
  /** One paragraph: who it is for and what they do here. */
  blurb: string;
  /** Three concrete things this audience does — never anything the edge refuses. */
  does: readonly string[];
  /** The primary call to action's label. */
  cta: string;
  /** True when a member of the public might be arriving without an account. */
  publicSignup: boolean;
}

const PRODUCT: Record<string, string> = {
  identity: "XI Identity",
  tokenization: "XI Tokenize",
};

const LANDINGS: Record<string, Omit<PersonaLanding, "product">> = {
  "identity-issuer": {
    headline: "Issue verifiable credentials your holders actually own",
    blurb:
      "The console for an authority that defines credential programmes and issues against them — a university registrar, " +
      "a district office, a licensing body. Credentials are signed by your organization's DID and anchored on-chain, so a " +
      "verifier can check them without asking you.",
    does: [
      "Define a credential programme: claim types, who may hold it, who may verify it",
      "Issue, reissue and revoke — every action through maker-checker approval",
      "Design the printed certificate and watch acceptance across your programmes",
    ],
    cta: "Sign in to the issuer console",
    publicSignup: true,
  },
  "identity-verifier": {
    headline: "Ask for a credential. Get an answer you can rely on.",
    blurb:
      "The console for a relying party — a bank, an employer, a government counter. Request exactly the credentials you " +
      "need, let the holder consent, and check the result against the issuer's DID and the on-chain revocation registry " +
      "rather than against a PDF.",
    does: [
      "Raise a verification request naming the credentials you need",
      "Read the holder's signed presentation once they consent",
      "See the verdict with its provenance — which registry answered, and when",
    ],
    cta: "Sign in to the verifier console",
    publicSignup: true,
  },
  "identity-holder": {
    headline: "Your credentials, held by you",
    blurb:
      "Your wallet. Credentials issued to you arrive here for you to accept or decline, and nobody sees them unless you " +
      "consent to share. Sign in with a password, or with a key that never leaves this device.",
    does: [
      "Accept, decline or ask for changes to a credential offered to you",
      "Consent to share — or refuse — when someone asks to verify",
      "Download your certificate, and check it is still in force",
    ],
    cta: "Open my wallet",
    publicSignup: false,
  },
  "tokenization-issuer": {
    headline: "Bring real-world assets on-chain, without writing a contract",
    blurb:
      "The desk for an issuer. Configure a use case, stage what you are tokenizing — invoices, bonds, credits — and mint " +
      "onto the ledger you choose. Compliance rules, approval workflow and the audit trail come with it.",
    does: [
      "Configure a use case and deploy its contract to a real chain",
      "Stage invoices from a file or your ERP, then tokenize selectively",
      "Mint, allowlist and run cashflows through to redemption",
    ],
    cta: "Sign in to the issuer desk",
    publicSignup: true,
  },
  "tokenization-marketplace": {
    headline: "Own a piece of what was never divisible",
    blurb:
      "The investor portal. Browse what issuers have brought on-chain, buy units, and sell them on the secondary market. " +
      "Your holdings and every transaction stay visible to you, settled on the ledger.",
    does: [
      "Browse live offerings and what backs each one",
      "Buy units, and list your own for another holder to take",
      "Watch your portfolio and your full transaction history",
    ],
    cta: "Sign in to the marketplace",
    publicSignup: false,
  },
  "tokenization-admin": {
    headline: "The whole platform, and everything that happened on it",
    blurb:
      "The platform operator's console. Approve the organizations that want to issue, oversee every use case across every " +
      "ledger, and audit the hash-chained record that says what was done and by whom.",
    does: [
      "Review and approve organizations applying to issue",
      "Oversee every use case, asset and settlement account",
      "Verify the audit chain and its on-chain anchors",
    ],
    cta: "Sign in to the admin console",
    publicSignup: false,
  },
};

/** The landing copy for this build's persona, or null for the full application. */
export function landingFor(persona: WebPersona | null): PersonaLanding | null {
  if (!persona) return null;
  const copy = LANDINGS[persona.key];
  if (!copy) return null;
  return { product: PRODUCT[persona.domain] ?? "XI", ...copy };
}
