import { describe, expect, it } from "vitest";
import { MemoryCredentialRepository, MemoryOrganizationRepository, MemoryUserRepository } from "../src/persistence/memory/index.js";

describe("MemoryOrganizationRepository", () => {
  it("creates, finds, lists, and updates status/verified", async () => {
    const repo = new MemoryOrganizationRepository();
    const org = await repo.create({
      name: "Acme Bank", orgType: "bank", registrationId: "REG-1", jurisdiction: "IN",
      did: "did:key:zOrg", didSeedEncrypted: "enc", status: "active", verified: true, verifiedAt: "2026-07-11T00:00:00.000Z",
      companyProfile: null,
    });
    expect(org.id).toBeTruthy();
    expect((await repo.get(org.id))?.name).toBe("Acme Bank");
    expect((await repo.findByName("Acme Bank"))?.id).toBe(org.id);
    expect((await repo.findByRegistrationId("REG-1"))?.id).toBe(org.id);
    expect(await repo.list()).toHaveLength(1);
    expect((await repo.setStatus(org.id, "suspended")).status).toBe("suspended");
    expect((await repo.setVerified(org.id, false, null)).verified).toBe(false);
  });
});

describe("MemoryCredentialRepository", () => {
  it("stores and lists credentials by holder", async () => {
    const repo = new MemoryCredentialRepository();
    const c = await repo.create({
      holderDid: "did:key:zH", issuerDid: "did:key:zI", type: "OrganizationMembership",
      vcJwt: "a.b.c", subjectClaims: { role: "Issuer" }, issuedAt: "2026-07-11T00:00:00.000Z", expiresAt: null, revoked: false,
    });
    expect(await repo.listByHolder("did:key:zH")).toHaveLength(1);
    expect(await repo.listByHolder("did:key:zX")).toHaveLength(0);
    expect((await repo.setRevoked(c.id, true)).revoked).toBe(true);
  });
});

describe("MemoryUserRepository org fields", () => {
  it("persists orgId and lists by org", async () => {
    const repo = new MemoryUserRepository();
    const u = await repo.create({
      email: "a@x.io", passwordHash: "h", role: "Issuer", useCaseKey: null, accountId: null,
      active: true, kycStatus: "approved", kyc: null, orgId: "org_1", didSeedEncrypted: "enc", did: "did:key:zU",
    });
    expect(u.orgId).toBe("org_1");
    expect(await repo.listByOrg("org_1")).toHaveLength(1);
    expect(await repo.listByOrg("org_2")).toHaveLength(0);
    expect((await repo.update(u.id, { orgId: "org_2" })).orgId).toBe("org_2");
  });
});
