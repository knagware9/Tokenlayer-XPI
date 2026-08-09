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
  /** Public base URL of this API, embedded in credentialStatus pointers on issued VCs. */
  publicApiUrl: string;
  /** Public base URL of the web app, embedded in QR-login sign URLs. */
  publicWebUrl: string;
  /** The single chain hosting the identity registries. Absent/unavailable ⇒ credentials issue unanchored. */
  registryChainId: string;
  /** Domains this deployment runs (tokenization, identity). Empty/all-unknown ⇒ both. */
  enabledDomains: string[];
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
  trustedKycIssuers: (process.env.TRUSTED_KYC_ISSUERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  devKycIssuerSeed: process.env.DEV_KYC_ISSUER_SEED,
  didMasterKey: process.env.DID_MASTER_KEY ?? DEV_DID_MASTER_KEY,
  didMasterConfigured: !!process.env.DID_MASTER_KEY,
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
  webhooksEnabled: process.env.WEBHOOKS_ENABLED !== "0",
  webhooksPollMs: process.env.WEBHOOKS_POLL_MS ? Number(process.env.WEBHOOKS_POLL_MS) : 2000,
  webhooksAllowInsecure: process.env.WEBHOOKS_ALLOW_INSECURE === "1",
  webhooksTimeoutMs: process.env.WEBHOOKS_TIMEOUT_MS ? Number(process.env.WEBHOOKS_TIMEOUT_MS) : 10_000,
};

if (!env.didMasterConfigured) {
  console.warn(
    "[keystore] DID_MASTER_KEY is not set — using an INSECURE dev key to encrypt custodial DID seeds. " +
      "Set DID_MASTER_KEY (openssl rand -hex 32) before any production use.",
  );
}
