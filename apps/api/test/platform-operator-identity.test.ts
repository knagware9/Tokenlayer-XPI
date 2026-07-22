/**
 * Seeded Platform Admins must be provisioned with a real identity at boot: a
 * custodial DID and an OrganizationMembership credential from the platform org,
 * while their tenancy orgId stays null (so global RBAC / maker-checker onboarding
 * are unchanged). The provisioning must be idempotent.
 */
import { describe, expect, it } from "vitest";
import { createKeystore } from "../src/keystore.js";
import { MemoryCredentialRepository, MemoryOrganizationRepository, MemoryUserRepository } from "../src/persistence/memory.js";
import { ensurePlatformIssuerOrg, provisionPlatformOperatorIdentities } from "../src/platform-org.js";

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
