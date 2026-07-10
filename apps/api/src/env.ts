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
  /**
   * Allowlist of trusted KYC credential issuer DIDs (comma-separated in the env).
   * Empty ⇒ no issuer is trusted, so identity verification fails closed.
   */
  trustedKycIssuers: string[];
  /** Dev-only deterministic issuer seed for the demo mint route (unset in production). */
  devKycIssuerSeed?: string;
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
  trustedKycIssuers: (process.env.TRUSTED_KYC_ISSUERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  devKycIssuerSeed: process.env.DEV_KYC_ISSUER_SEED,
};
