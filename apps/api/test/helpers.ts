import { RbacPolicy } from "@tokenlayer/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildChainRegistry } from "../src/chains.js";
import { createEngine } from "../src/context.js";
import { loadCurrencies } from "../src/currencies.js";
import {
  MemoryAccountRepository,
  MemoryAssetRepository,
  MemoryAuditAnchorRepository,
  MemoryAuditRepository,
  MemoryCashflowRepository,
  MemoryProposalRepository,
  MemoryCashRepository,
  MemoryDocumentRepository,
  MemoryListingRepository,
  MemoryUseCaseRepository,
  MemoryUserRepository,
} from "../src/persistence/memory.js";
import { DEFAULT_USERS, seedDefaults } from "../src/seed.js";
import { seedUseCases } from "../src/use-cases.js";

/** Demo market escrow used by tests unless a test explicitly overrides it (pass `marketEscrowAccount: undefined` to disable the market). */
export const TEST_MARKET_ESCROW = "0xcd3B766CCDd6AE721141F452C550Ca635964ce71";

export async function buildTestApp(opts: { loginRateLimitMax?: number; platformFeeAccount?: string; marketEscrowAccount?: string } = {}): Promise<FastifyInstance> {
  const rbac = new RbacPolicy();
  const chains = buildChainRegistry({ CHAIN_STRICT: "0" }); // simulated chains only — besu absent, never mocked
  const users = new MemoryUserRepository();
  const assets = new MemoryAssetRepository();
  const audit = new MemoryAuditRepository();
  const auditAnchors = new MemoryAuditAnchorRepository();
  const accounts = new MemoryAccountRepository();
  const useCases = new MemoryUseCaseRepository();
  const cash = new MemoryCashRepository();
  const listings = new MemoryListingRepository();
  const documents = new MemoryDocumentRepository();
  const cashflows = new MemoryCashflowRepository();
  const proposals = new MemoryProposalRepository();
  await seedDefaults(users, accounts);
  const engine = createEngine(useCases, rbac, chains, audit, { users, accounts });
  await seedUseCases(useCases, {
    availableChainIds: new Set(chains.list().map((c) => c.id)),
    deploy: (def, chainId) => engine.deployUseCaseContract(def, chainId),
  });
  // The suite makes many logins from one IP; raise the throttle unless a test opts into it.
  return buildApp({
    useCases, rbac, engine, users, assets, audit, auditAnchors, accounts, chains, cash, listings, documents, cashflows, proposals,
    currencies: loadCurrencies(), jwtSecret: "test-secret",
    loginRateLimitMax: opts.loginRateLimitMax ?? 100000,
    platformFeeAccount: opts.platformFeeAccount,
    // Enabled by default so market routes are testable; an explicit
    // `marketEscrowAccount: undefined` disables the market (503s).
    marketEscrowAccount: "marketEscrowAccount" in opts ? opts.marketEscrowAccount : TEST_MARKET_ESCROW,
  });
}

/** All v1 API routes live under this prefix. */
export const V1 = "/api/v1";

/** Login by explicit email + password (preferred — unambiguous in the per-use-case model). */
export async function loginAs(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email, password } });
  return res.json().token as string;
}

/** Issue an asset for the given use case key, returning the new asset's id. */
export async function issueAsset(app: FastifyInstance, token: string, useCaseKey: string): Promise<string> {
  const meta: Record<string, Record<string, unknown>> = {
    "carbon-credit": { projectName: "P", registry: "Verra", vintage: 2024 },
    "gold-loan": { borrower: "R", goldWeightGrams: 1, loanAmountInr: 1 },
    "corporate-bond": { issuer: "ACME", isin: "X", faceValue: 1 },
  };
  const res = await app.inject({
    method: "POST",
    url: `${V1}/assets`,
    headers: { authorization: `Bearer ${token}` },
    payload: { useCaseKey, name: "T", symbol: "T", chainId: "fabric", metadata: meta[useCaseKey] ?? {} },
  });
  if (res.statusCode !== 201) throw new Error(`issueAsset(${useCaseKey}) failed: ${res.statusCode} ${res.body}`);
  return res.json().asset.id as string;
}

export function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const ACCOUNTS = { ALICE, BOB };

// ---------------------------------------------------------------------------
// Legacy role-based login — kept for any tests that still use old-style roles.
// Maps by the first seeded user with that role (PlatformAdmin → admin@…, etc.).
// ---------------------------------------------------------------------------
const PASSWORDS: Record<string, string> = Object.fromEntries(DEFAULT_USERS.map((u) => [u.role, u.password]));
const EMAILS: Record<string, string> = Object.fromEntries(DEFAULT_USERS.map((u) => [u.role, u.email]));

/** @deprecated Prefer loginAs(app, email, password). */
export async function login(app: FastifyInstance, role: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `${V1}/auth/login`,
    payload: { email: EMAILS[role], password: PASSWORDS[role] },
  });
  return res.json().token as string;
}
