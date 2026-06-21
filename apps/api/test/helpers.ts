import { RbacPolicy } from "@tokenlayer/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildChainRegistry } from "../src/chains.js";
import { createEngine } from "../src/context.js";
import {
  MemoryAccountRepository,
  MemoryAssetRepository,
  MemoryAuditRepository,
  MemoryUseCaseRepository,
  MemoryUserRepository,
} from "../src/persistence/memory.js";
import { DEFAULT_USERS, seedDefaults } from "../src/seed.js";
import { seedUseCases } from "../src/use-cases.js";

export async function buildTestApp(): Promise<FastifyInstance> {
  const rbac = new RbacPolicy();
  const chains = buildChainRegistry({}); // simulated chains only — no EVM env
  const users = new MemoryUserRepository();
  const assets = new MemoryAssetRepository();
  const audit = new MemoryAuditRepository();
  const accounts = new MemoryAccountRepository();
  const useCases = new MemoryUseCaseRepository();
  await seedDefaults(users, accounts);
  await seedUseCases(useCases);
  const engine = createEngine(useCases, rbac, chains, audit);
  return buildApp({ useCases, rbac, engine, users, assets, audit, accounts, chains, jwtSecret: "test-secret" });
}

const PASSWORDS: Record<string, string> = Object.fromEntries(DEFAULT_USERS.map((u) => [u.role, u.password]));
const EMAILS: Record<string, string> = Object.fromEntries(DEFAULT_USERS.map((u) => [u.role, u.email]));

/** All v1 API routes live under this prefix. */
export const V1 = "/api/v1";

export async function login(app: FastifyInstance, role: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `${V1}/auth/login`,
    payload: { email: EMAILS[role], password: PASSWORDS[role] },
  });
  return res.json().token as string;
}

export function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const ACCOUNTS = { ALICE, BOB };
