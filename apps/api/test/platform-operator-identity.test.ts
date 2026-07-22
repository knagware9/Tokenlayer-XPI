/**
 * Seeded Platform Admins must be provisioned with a real identity at boot: a
 * custodial DID and an OrganizationMembership credential from the platform org,
 * while their tenancy orgId stays null (so global RBAC / maker-checker onboarding
 * are unchanged). The provisioning must be idempotent.
 */
import { describe, expect, it } from "vitest";
import { createKeystore } from "../src/keystore.js";
import { MemoryCredentialRepository, MemoryOrganizationRepository, MemoryUserRepository } from "../src/persistence/memory.js";
import { ensureNamedOrg, ensurePlatformIssuerOrg, ensureUserWallet, provisionOrgMemberIdentities, provisionPlatformOperatorIdentities } from "../src/platform-org.js";
import { MemoryAccountRepository } from "../src/persistence/memory.js";

function makeDeps() {
  return {
    organizations: new MemoryOrganizationRepository(),
    users: new MemoryUserRepository(),
    credentials: new MemoryCredentialRepository(),
    keystore: createKeystore("11".repeat(32)),
  };
}

describe("provisionPlatformOperatorIdentities", () => {
  it("issues a DID + membership credential to a Platform Admin, leaving orgId null", async () => {
    const deps = makeDeps();
    const admin = await deps.users.create({
      email: "admin@tokenlayer.dev", passwordHash: "x", role: "PlatformAdmin",
      useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    });
    const org = await ensurePlatformIssuerOrg({ ...deps, registry: undefined });

    await provisionPlatformOperatorIdentities(deps, org);

    const updated = await deps.users.findById(admin.id);
    expect(updated?.did).toBeTruthy();
    expect(updated?.orgId ?? null).toBeNull(); // tenancy unchanged — stays global

    const creds = await deps.credentials.listByHolder(updated!.did!);
    expect(creds).toHaveLength(1);
    expect(creds[0].type).toBe("OrganizationMembership");
    expect(creds[0].issuerDid).toBe(org.did);
    expect(creds[0].subjectClaims.organization).toBe(org.name);
  });

  it("is idempotent — a second run mints no new DID or credential", async () => {
    const deps = makeDeps();
    await deps.users.create({
      email: "admin@tokenlayer.dev", passwordHash: "x", role: "PlatformAdmin",
      useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    });
    const org = await ensurePlatformIssuerOrg({ ...deps, registry: undefined });

    await provisionPlatformOperatorIdentities(deps, org);
    const after1 = (await deps.users.list()).find((u) => u.email === "admin@tokenlayer.dev");
    const did1 = after1?.did;

    await provisionPlatformOperatorIdentities(deps, org);
    const after2 = (await deps.users.list()).find((u) => u.email === "admin@tokenlayer.dev");
    expect(after2?.did).toBe(did1); // unchanged
    expect(await deps.credentials.listByHolder(did1!)).toHaveLength(1); // no duplicate VC
  });

  it("provisions a named-org roster (e.g. the invoice desk) with DID + membership under that org, keeping their role", async () => {
    const deps = makeDeps();
    const issuer = await deps.users.create({
      email: "m1.issuer@tokenlayer.dev", passwordHash: "x", role: "Issuer",
      useCaseKey: "invoice-tokenization", accountId: null, active: true, kycStatus: "approved", kyc: null,
    });
    const org = await ensureNamedOrg({ ...deps, registry: undefined }, { name: "M1xchange", orgType: "corporate", jurisdiction: "IN" });
    expect(org.name).toBe("M1xchange");

    await provisionOrgMemberIdentities(deps, org, ["m1.issuer@tokenlayer.dev"]);

    const updated = await deps.users.findById(issuer.id);
    expect(updated?.did).toBeTruthy();
    expect(updated?.orgId ?? null).toBeNull(); // tenancy unchanged
    const creds = await deps.credentials.listByHolder(updated!.did!);
    expect(creds).toHaveLength(1);
    expect(creds[0].type).toBe("OrganizationMembership");
    expect(creds[0].subjectClaims.organization).toBe("M1xchange");
    expect(creds[0].subjectClaims.role).toBe("Issuer"); // carries the user's actual role
  });

  it("links a wallet to an operator that has none (idempotent)", async () => {
    const deps = { ...makeDeps(), accounts: new MemoryAccountRepository() };
    const u = await deps.users.create({
      email: "m1.issuer@tokenlayer.dev", passwordHash: "x", role: "Issuer",
      useCaseKey: "invoice-tokenization", accountId: null, active: true, kycStatus: "approved", kyc: null,
    });
    await ensureUserWallet(deps, "m1.issuer@tokenlayer.dev", "0xBcd4042DE499D14e55001CcbB24a551F3b954096", "M1xchange Desk");
    const after = await deps.users.findById(u.id);
    expect(after?.accountId).toBeTruthy();
    // Idempotent: a second call does not change the linked account.
    await ensureUserWallet(deps, "m1.issuer@tokenlayer.dev", "0x0000000000000000000000000000000000000001", "Other");
    expect((await deps.users.findById(u.id))?.accountId).toBe(after?.accountId);
  });

  it("does not provision non–Platform-Admin users", async () => {
    const deps = makeDeps();
    const issuer = await deps.users.create({
      email: "iss@x.dev", passwordHash: "x", role: "Issuer",
      useCaseKey: "carbon-credit", accountId: null, active: true, kycStatus: "approved", kyc: null,
    });
    const org = await ensurePlatformIssuerOrg({ ...deps, registry: undefined });

    await provisionPlatformOperatorIdentities(deps, org);
    expect((await deps.users.findById(issuer.id))?.did ?? null).toBeNull();
  });
});
