import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Minimal, dependency-free .env loader for local development. Reads apps/api/.env
 * and populates process.env for any key not already set by the real environment.
 * In production, set real environment variables and ship no .env file.
 */
function loadDotenv(): void {
  try {
    const path = fileURLToPath(new URL("../.env", import.meta.url));
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      if (process.env[key] !== undefined) continue;
      process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env present — rely on the real environment */
  }
}

loadDotenv();

/** The insecure placeholder that must never be used to sign tokens. */
const INSECURE_SECRET = "dev-secret-change-me";

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret === INSECURE_SECRET || jwtSecret.length < 16) {
  throw new Error(
    "JWT_SECRET is missing, too short, or uses the insecure development default. " +
      "Set a strong secret in apps/api/.env or the environment, e.g. `openssl rand -hex 32`.",
  );
}

/**
 * Demo platform fee account seeded when PLATFORM_FEE_ACCOUNT is unset but fees
 * should still be exercisable (dev/demo). A recognisable Hardhat dev address not
 * used as a buyer/treasury in the seed roster.
 */
export const DEMO_PLATFORM_FEE_ACCOUNT = "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097";

/**
 * Demo secondary-market escrow account seeded when MARKET_ESCROW_ACCOUNT is
 * unset outside production. Hardhat dev account #15 — distinct from the demo
 * fee account (#14) and every seeded holder/treasury address (#1–#10).
 */
export const DEMO_MARKET_ESCROW_ACCOUNT = "0xcd3B766CCDd6AE721141F452C550Ca635964ce71";

/**
 * Fixed DEV DID master key used only when DID_MASTER_KEY is unset — enables the
 * custodial keystore out of the box for local/demo runs. NEVER use in production;
 * a real deployment MUST set DID_MASTER_KEY (32 bytes hex, e.g. `openssl rand -hex 32`).
 */
export const DEV_DID_MASTER_KEY = "0".repeat(64);

export interface Env {
  port: number;
  nodeEnv: string;
  jwtSecret: string;
  corsOrigins: string[];
  evmRpcUrl?: string;
  evmOperatorKey?: string;
  /**
   * Platform fee account (address). When unset, marketplace/issuance fees are
   * DISABLED (treated as 0) regardless of use-case config. Defaults to a demo
   * address outside production so fees are usable out of the box for demos.
   */
  platformFeeAccount?: string;
  /**
   * Secondary-market escrow account (address) that holds listed tokens. When
   * unset, ALL market endpoints return 503 MARKET_DISABLED. Defaults to a demo
   * address outside production so the market is usable out of the box.
   */
  marketEscrowAccount?: string;
  /**
   * Max login attempts per IP per 15-min window. Unset → the route default (10),
   * which is the right security posture for production; raise it for shared
   * demo/load environments where many users authenticate from one egress IP.
   */
  loginRateLimitMax?: number;
  /** Max requests per API KEY per minute. Unset → the route default (600). */
  apiKeyRateLimitMax?: number;
  /**
   * Max FAILED key verifications per prefix per minute before the prefix is
   * refused without bcrypt work. Unset → the route default (20). Prefixes are
   * public, so this is what bounds an attacker's CPU cost on this process.
   */
  apiKeyFailedAttemptMax?: number;
  /** Minimum gap between bcrypt attempts for an over-budget prefix. Unset → 5000ms. */
  apiKeyReserveIntervalMs?: number;
  /**
   * How old (ms) an unpinned brand-logo upload must be before
   * `POST /orgs/{id}/branding/logo`'s prune will delete it. Unset → the
   * module default (`BRAND_LOGO_PRUNE_GRACE_MS`, 60s). Left `undefined`
   * rather than defaulted here so the number lives in exactly one place.
   *
   * This is a SAFETY floor, not a tuning knob: it is the whole reason two
   * concurrent uploads no longer delete each other, so `0` disables that
   * protection. Validated at boot rather than coerced — see below.
   */
  brandLogoPruneGraceMs?: number;
  /**
   * Allowlist of trusted KYC credential issuer DIDs (comma-separated in the env).
   * Empty ⇒ no issuer is trusted, so identity verification fails closed.
   */
  trustedKycIssuers: string[];
  /** Dev-only deterministic issuer seed for the demo mint route (unset in production). */
  devKycIssuerSeed?: string;
  /** 32-byte hex master key encrypting custodial DID seeds (real or dev default). */
  didMasterKey: string;
  /** True iff DID_MASTER_KEY was explicitly set (production must set it). */
  didMasterConfigured: boolean;
  /**
   * 32-byte hex master key encrypting WEBHOOK ENDPOINT SIGNING SECRETS.
   *
   * Falls back to didMasterKey so nothing breaks and no migration is needed, but
   * they protect different things and should be different keys: one compromise
   * currently loses every custodial DID seed AND every integrator signing
   * secret, and neither can be rotated without re-encrypting the other's data.
   * Setting WEBHOOK_MASTER_KEY separates them.
   */
  webhookMasterKey: string;
  /** True iff WEBHOOK_MASTER_KEY was explicitly set (i.e. not sharing the DID key). */
  webhookMasterConfigured: boolean;
  /** Public base URL of this API, embedded in credentialStatus pointers on issued VCs. */
  publicApiUrl: string;
  /** Public base URL of the web app, embedded in QR-login sign URLs. */
  publicWebUrl: string;
  /** The single chain hosting the identity registries. Absent/unavailable ⇒ credentials issue unanchored. */
  registryChainId: string;
  /** Domains this deployment runs (tokenization, identity). Empty/all-unknown ⇒ both. */
  enabledDomains: string[];
  /**
   * A separately-deployed Identity service to ask "does this DID hold a valid
   * credential?" — set BOTH or NEITHER (see the boot check below).
   *
   * Absent on a deployment that runs the identity domain itself: it owns the
   * credentials and answers from its own store. Absent on a tokenization-only
   * deployment means nothing can answer, and `requireVerifiedIdentity` use cases
   * refuse loudly rather than quietly denying every holder.
   */
  /**
   * Do the PEOPLE in this deployment carry DIDs?
   *
   *   "did"    onboarding mints a custodial DID per user (and a KycCredential
   *            when asked), exactly as before. The default, so nothing changes
   *            for an existing deployment.
   *   "plain"  users are ordinary accounts with an id, an email and a role.
   *            No custodial seed, no credential, nothing to present.
   *
   * ORGANIZATIONS ALWAYS CARRY A DID whichever this is. An org's DID signs its
   * members' credentials and is what the on-chain registry trusts; dropping it
   * would take the platform's own issuer identity with it, which is a different
   * and much larger decision than "our users are not credential holders".
   */
  subjectIdentifiers: "did" | "plain";
  identityServiceUrl?: string;
  /** A peer API key on the identity service holding the `identity:assert` scope. */
  identityServiceKey?: string;
  /** Per-call timeout for the remote assertion; a compliance check must not hang a mint. */
  identityServiceTimeoutMs?: number;
  /**
   * Whether THIS process runs the webhook dispatcher (EN-C). Default on.
   *
   * The CAS claim makes several instances SAFE (no row is ever sent twice) but
   * not COORDINATED (there is no fair distribution of work, and every instance
   * polls the same table). An operator running replicas therefore sets
   * WEBHOOKS_ENABLED=0 on all but one to keep exactly one dispatcher.
   */
  webhooksEnabled: boolean;
  /** Dispatcher poll interval. The floor on delivery latency for a fresh event. */
  webhooksPollMs: number;
  /**
   * Dev/demo only: permits an http:// webhook URL pointing at loopback, so a
   * local receiver can be a legal endpoint. NEVER set in production — it is what
   * stands between an org-supplied URL and the operator's own localhost services.
   */
  webhooksAllowInsecure: boolean;
  /** Per-attempt HTTP timeout. Bounds how long one bad endpoint holds a worker. */
  webhooksTimeoutMs: number;
}

const platformFeeAccount =
  process.env.PLATFORM_FEE_ACCOUNT ??
  (process.env.NODE_ENV === "production" ? undefined : DEMO_PLATFORM_FEE_ACCOUNT);

const marketEscrowAccount =
  process.env.MARKET_ESCROW_ACCOUNT ??
  (process.env.NODE_ENV === "production" ? undefined : DEMO_MARKET_ESCROW_ACCOUNT);

/**
 * Parse a millisecond duration that must be a non-negative finite number, or
 * refuse to boot.
 *
 * The bare `Number(...)` used by the tunables below is how a typo becomes a
 * silent behaviour change, and for a SAFETY floor that is not acceptable:
 * `Number("6o")` is `NaN`, `ageMs >= NaN` is false for every row, so a
 * fat-fingered grace period would switch the brand-logo prune off completely
 * and say nothing — the storage leak it exists to fix would quietly return. A
 * NEGATIVE value is worse than useless: it makes every row instantly reapable,
 * re-opening by configuration the exact concurrency bug the grace period was
 * added to close (two simultaneous uploads deleting each other). Refuse both at
 * boot, the way `JWT_SECRET` is refused, rather than start in a state nobody
 * chose. `0` is allowed and meaningful — it is what the test harness passes.
 */
function requireNonNegativeMs(name: string, raw: string): number {
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`${name} must be a non-negative number of milliseconds; got ${JSON.stringify(raw)}.`);
  }
  return ms;
}

export const env: Env = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  jwtSecret,
  // Comma-separated allowlist; defaults to the local dashboard origin.
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
  evmRpcUrl: process.env.EVM_RPC_URL,
  evmOperatorKey: process.env.EVM_OPERATOR_KEY,
  platformFeeAccount,
  marketEscrowAccount,
  loginRateLimitMax: process.env.LOGIN_RATE_LIMIT_MAX ? Number(process.env.LOGIN_RATE_LIMIT_MAX) : undefined,
  apiKeyRateLimitMax: process.env.API_KEY_RATE_LIMIT_MAX ? Number(process.env.API_KEY_RATE_LIMIT_MAX) : undefined,
  apiKeyFailedAttemptMax: process.env.API_KEY_FAILED_ATTEMPT_MAX ? Number(process.env.API_KEY_FAILED_ATTEMPT_MAX) : undefined,
  apiKeyReserveIntervalMs: process.env.API_KEY_RESERVE_INTERVAL_MS ? Number(process.env.API_KEY_RESERVE_INTERVAL_MS) : undefined,
  // NOTE `"0"` is a truthy string, so an explicit zero reaches the parser and
  // is honoured; only an unset/empty value falls through to the module default.
  brandLogoPruneGraceMs: process.env.BRAND_LOGO_PRUNE_GRACE_MS
    ? requireNonNegativeMs("BRAND_LOGO_PRUNE_GRACE_MS", process.env.BRAND_LOGO_PRUNE_GRACE_MS)
    : undefined,
  trustedKycIssuers: (process.env.TRUSTED_KYC_ISSUERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  devKycIssuerSeed: process.env.DEV_KYC_ISSUER_SEED,
  didMasterKey: process.env.DID_MASTER_KEY ?? DEV_DID_MASTER_KEY,
  didMasterConfigured: !!process.env.DID_MASTER_KEY,
  webhookMasterKey: process.env.WEBHOOK_MASTER_KEY ?? process.env.DID_MASTER_KEY ?? DEV_DID_MASTER_KEY,
  webhookMasterConfigured: !!process.env.WEBHOOK_MASTER_KEY,
  publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${Number(process.env.PORT ?? 4000)}/api/v1`,
  publicWebUrl: process.env.PUBLIC_WEB_URL ?? (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",")[0]!.trim(),
  registryChainId: process.env.REGISTRY_CHAIN_ID ?? "besu",
  enabledDomains: (() => {
    const known = ["tokenization", "identity"];
    const raw = (process.env.ENABLED_DOMAINS ?? "tokenization,identity").split(",").map((s) => s.trim()).filter(Boolean);
    const parsed = raw.filter((d) => known.includes(d));
    const dropped = raw.filter((d) => !known.includes(d));
    if (dropped.length) console.warn(`[env] ENABLED_DOMAINS: ignoring unknown domain(s): ${dropped.join(", ")}`);
    if (parsed.length === 0) { if (raw.length) console.warn("[env] ENABLED_DOMAINS had no known domains — defaulting to both"); return known; }
    return parsed; // empty/all-unknown ⇒ both (never zero)
  })(),
  subjectIdentifiers: (() => {
    const raw = (process.env.SUBJECT_IDENTIFIERS ?? "did").trim().toLowerCase();
    if (raw === "did" || raw === "plain") return raw;
    // NOT a silent default. Misreading "none" or "off" as "did" would hand every
    // user a custodial seed in a deployment whose operator asked for the
    // opposite, and nothing would say so.
    throw new Error(
      `SUBJECT_IDENTIFIERS must be 'did' or 'plain'; got ${JSON.stringify(process.env.SUBJECT_IDENTIFIERS)}. ` +
        "'did' mints a custodial DID per user; 'plain' gives users ordinary accounts. " +
        "Organizations carry a DID either way.",
    );
  })(),
  identityServiceUrl: process.env.IDENTITY_SERVICE_URL?.trim() || undefined,
  identityServiceKey: process.env.IDENTITY_SERVICE_KEY?.trim() || undefined,
  identityServiceTimeoutMs: process.env.IDENTITY_SERVICE_TIMEOUT_MS
    ? requireNonNegativeMs("IDENTITY_SERVICE_TIMEOUT_MS", process.env.IDENTITY_SERVICE_TIMEOUT_MS)
    : undefined,
  webhooksEnabled: process.env.WEBHOOKS_ENABLED !== "0",
  webhooksPollMs: process.env.WEBHOOKS_POLL_MS ? Number(process.env.WEBHOOKS_POLL_MS) : 2000,
  webhooksAllowInsecure: process.env.WEBHOOKS_ALLOW_INSECURE === "1",
  webhooksTimeoutMs: process.env.WEBHOOKS_TIMEOUT_MS ? Number(process.env.WEBHOOKS_TIMEOUT_MS) : 10_000,
};

/**
 * A URL without a key, or a key without a URL, is a half-configured remote
 * identity service — and the failure it produces is the worst kind: the process
 * boots, the deployment looks configured, and then every single
 * `requireVerifiedIdentity` mint fails at runtime with an authorization error
 * against a service the operator believes they wired up. Refuse at boot, where
 * the fix is one line and nobody's transaction is in flight.
 */
if (!!env.identityServiceUrl !== !!env.identityServiceKey) {
  throw new Error(
    "IDENTITY_SERVICE_URL and IDENTITY_SERVICE_KEY must be set together (or neither): " +
      `got URL=${env.identityServiceUrl ? "set" : "unset"}, KEY=${env.identityServiceKey ? "set" : "unset"}. ` +
      "A URL with no key cannot authenticate; a key with no URL has nowhere to go.",
  );
}

/**
 * Running the identity domain AND pointing at a remote identity service is a
 * contradiction, and the failure it produces is silent: the identity desk in
 * THIS process issues a credential into THIS database, while the compliance
 * gate asks a DIFFERENT service and is told the holder has nothing. Nobody sees
 * a stack trace; they see a holder who was just verified being refused, and
 * they go looking in the wrong database.
 *
 * Refuse, and name the fix. `ENABLED_DOMAINS` defaults to both, so this is
 * mostly a prompt to state the topology once: a deployment that delegates
 * identity is a tokenization deployment.
 */
if (env.identityServiceUrl && env.enabledDomains.includes("identity")) {
  throw new Error(
    "IDENTITY_SERVICE_URL is set, but this deployment also runs the 'identity' domain. " +
      "One deployment cannot both own credentials and delegate them: the desk would write here " +
      "while the compliance gate reads there. Set ENABLED_DOMAINS=tokenization to delegate, " +
      "or unset IDENTITY_SERVICE_URL/IDENTITY_SERVICE_KEY to answer locally.",
  );
}

/**
 * The identity PRODUCT issues credentials to subjects. Subjects with no DID
 * cannot hold one, so a deployment that serves identity with plain identifiers
 * is asking for a credential registry with nobody to put in it — and the failure
 * would arrive as a confusing 400 at the first issuance rather than here.
 */
if (env.subjectIdentifiers === "plain" && env.enabledDomains.includes("identity")) {
  throw new Error(
    "SUBJECT_IDENTIFIERS=plain, but this deployment runs the 'identity' domain, whose whole business is " +
      "issuing credentials to subjects — and a subject with no DID cannot hold one. " +
      "Set SUBJECT_IDENTIFIERS=did, or drop 'identity' from ENABLED_DOMAINS.",
  );
}

/**
 * Delegating identity means asking another service whether THIS deployment's
 * users hold a credential. With plain identifiers there is no DID to ask about,
 * so every such question would be asked of `undefined` and answered "no" —
 * a gate that refuses everyone, for a reason nobody could see.
 */
if (env.subjectIdentifiers === "plain" && env.identityServiceUrl) {
  throw new Error(
    "SUBJECT_IDENTIFIERS=plain, but IDENTITY_SERVICE_URL is set. There would be no subject DID to ask about: " +
      "every verified-identity check would refuse. Set SUBJECT_IDENTIFIERS=did to link an identity deployment, " +
      "or unset IDENTITY_SERVICE_URL/IDENTITY_SERVICE_KEY to run tokenization alone.",
  );
}

if (env.subjectIdentifiers === "plain") {
  console.log(
    "[identity] SUBJECT_IDENTIFIERS=plain — users are ordinary accounts (no custodial DIDs, no credentials). " +
      "Organizations still carry a DID. Use cases requiring a verified identity cannot be satisfied here.",
  );
}

if (!env.didMasterConfigured) {
  console.warn(
    "[keystore] DID_MASTER_KEY is not set — using an INSECURE dev key to encrypt custodial DID seeds. " +
      "Set DID_MASTER_KEY (openssl rand -hex 32) before any production use.",
  );
}

if (!env.webhookMasterConfigured) {
  console.warn(
    "[webhooks] WEBHOOK_MASTER_KEY is not set — webhook signing secrets are encrypted with the DID master key. " +
      "One key compromise then loses every custodial DID seed AND every integrator signing secret, and neither " +
      "can be rotated independently. Set WEBHOOK_MASTER_KEY (openssl rand -hex 32) before any production use.",
  );
}
