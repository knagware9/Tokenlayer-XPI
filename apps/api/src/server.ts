import { RbacPolicy } from "@tokenlayer/core";
import { buildApp } from "./app.js";
import { buildChainRegistry } from "./chains.js";
import { createEngine } from "./context.js";
import { env } from "./env.js";
import {
  PrismaAccountRepository,
  PrismaAssetRepository,
  PrismaAuditRepository,
  PrismaUseCaseRepository,
  PrismaUserRepository,
} from "./persistence/prisma.js";
import { seedDefaults } from "./seed.js";
import { seedUseCases } from "./use-cases.js";

async function main(): Promise<void> {
  const rbac = new RbacPolicy();
  const chains = buildChainRegistry();

  const users = new PrismaUserRepository();
  const assets = new PrismaAssetRepository();
  const audit = new PrismaAuditRepository();
  const accounts = new PrismaAccountRepository();
  const useCases = new PrismaUseCaseRepository();
  await seedDefaults(users, accounts);
  await seedUseCases(useCases);

  const engine = createEngine(useCases, rbac, chains, audit);
  const app = await buildApp({ useCases, rbac, engine, users, assets, audit, accounts, chains, jwtSecret: env.jwtSecret });

  await app.listen({ port: env.port, host: "0.0.0.0" });
  const chainList = chains.list().map((c) => c.id).join(", ");
  console.log(`TokenLayer API listening on http://localhost:${env.port}  (chains: ${chainList})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
