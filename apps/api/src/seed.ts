import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import type { Role } from "@tokenlayer/core";
import type { AccountRepository, UserRepository } from "./persistence/types.js";

export interface SeedUser {
  email: string;
  password: string;
  role: Role;
}

/** Demo credentials, one per role, so every permission path can be exercised. */
export const DEFAULT_USERS: SeedUser[] = [
  { email: "admin@tokenlayer.dev", password: "admin123", role: "Admin" },
  { email: "issuer@tokenlayer.dev", password: "issuer123", role: "Issuer" },
  { email: "operator@tokenlayer.dev", password: "operator123", role: "Operator" },
  { email: "viewer@tokenlayer.dev", password: "viewer123", role: "Viewer" },
];

/** Hardhat dev accounts #1–#4 — valid addresses that work on mock and EVM alike. */
export const DEFAULT_ACCOUNTS: { address: string; label: string }[] = [
  { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", label: "Alice" },
  { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", label: "Bob" },
  { address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", label: "Carol" },
  { address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", label: "Treasury" },
];

/** Idempotently seeds the default users and demo accounts. */
export async function seedDefaults(users: UserRepository, accounts: AccountRepository): Promise<void> {
  for (const u of DEFAULT_USERS) {
    if (!(await users.findByEmail(u.email))) {
      await users.create({ email: u.email, passwordHash: bcrypt.hashSync(u.password, 10), role: u.role });
    }
  }
  for (const a of DEFAULT_ACCOUNTS) {
    await accounts.upsert(a.address, a.label);
  }
}

// CLI entry: `tsx src/seed.ts` seeds the Prisma database.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { PrismaUserRepository, PrismaAccountRepository, prisma } = await import("./persistence/prisma.js");
  await seedDefaults(new PrismaUserRepository(), new PrismaAccountRepository());
  await prisma.$disconnect();
  console.log("Seeded default users and accounts.");
}
