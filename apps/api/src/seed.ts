import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import type { Role } from "@tokenlayer/core";
import type { AccountRepository, UserRepository } from "./persistence/types.js";

export interface SeedUser {
  email: string;
  password: string;
  role: Role;
  useCaseKey: string | null;
  walletLabel?: string; // links a Buyer/Trader to a DEFAULT_ACCOUNTS label
}

/** The single global Platform Admin. */
export const PLATFORM_ADMIN: SeedUser = { email: "admin@tokenlayer.dev", password: "admin123", role: "PlatformAdmin", useCaseKey: null };

/** Generates a full demo roster for one use case. */
function rosterFor(useCaseKey: string, prefix: string, buyerWalletLabel: string, traderWalletLabel: string): SeedUser[] {
  return [
    { email: `${prefix}.admin@tokenlayer.dev`, password: `${prefix}123`, role: "UseCaseAdmin", useCaseKey },
    { email: `${prefix}.issuer@tokenlayer.dev`, password: `${prefix}123`, role: "Issuer", useCaseKey },
    { email: `${prefix}.trader@tokenlayer.dev`, password: `${prefix}123`, role: "Trader", useCaseKey, walletLabel: traderWalletLabel },
    { email: `${prefix}.buyer@tokenlayer.dev`, password: `${prefix}123`, role: "Buyer", useCaseKey, walletLabel: buyerWalletLabel },
    { email: `${prefix}.auditor@tokenlayer.dev`, password: `${prefix}123`, role: "Auditor", useCaseKey },
  ];
}

export const DEFAULT_USERS: SeedUser[] = [
  PLATFORM_ADMIN,
  ...rosterFor("carbon-credit", "carbon", "EcoFund Capital", "Treasury"),
  ...rosterFor("gold-loan", "gold", "Alice", "Treasury"),
  ...rosterFor("corporate-bond", "bond", "Bob", "Treasury"),
];

/**
 * Hardhat dev accounts #1–#10 — valid addresses that work on the simulated
 * ledgers and on EVM alike. #1–#4 are the generic demo holders; #5–#10 are a
 * roster of KYC-eligible carbon-credit buyers (institutions, corporates, brokers).
 */
export const DEFAULT_ACCOUNTS: { address: string; label: string }[] = [
  { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", label: "Alice" },
  { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", label: "Bob" },
  { address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", label: "Carol" },
  { address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", label: "Treasury" },
  { address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", label: "EcoFund Capital" },
  { address: "0x976EA74026E726554dB657fA54763abd0C3a0aa9", label: "GreenWing Airlines" },
  { address: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955", label: "Helios Energy Corp" },
  { address: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", label: "Nordic Pension Fund" },
  { address: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720", label: "TerraNova Trading" },
  { address: "0xBcd4042DE499D14e55001CcbB24a551F3b954096", label: "Summit Tech Net-Zero" },
];

/** Idempotently seeds the default users and demo accounts. */
export async function seedDefaults(users: UserRepository, accounts: AccountRepository): Promise<void> {
  for (const a of DEFAULT_ACCOUNTS) {
    await accounts.upsert(a.address, a.label);
  }
  for (const u of DEFAULT_USERS) {
    if (await users.findByEmail(u.email)) continue;
    let accountId: string | null = null;
    if (u.walletLabel) {
      const acct = DEFAULT_ACCOUNTS.find((a) => a.label === u.walletLabel);
      if (acct) accountId = (await accounts.upsert(acct.address, acct.label)).id;
    }
    await users.create({ email: u.email, passwordHash: bcrypt.hashSync(u.password, 10), role: u.role, useCaseKey: u.useCaseKey, accountId, active: true, kycStatus: "approved", kyc: null });
  }
}

// CLI entry: `tsx src/seed.ts` seeds the Prisma database.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { PrismaUserRepository, PrismaAccountRepository, prisma } = await import("./persistence/prisma.js");
  await seedDefaults(new PrismaUserRepository(), new PrismaAccountRepository());
  await prisma.$disconnect();
  console.log("Seeded default users and accounts.");
}
