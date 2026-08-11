import { describe, expect, it } from "vitest";
import { MemoryOrganizationRepository } from "../src/persistence/memory.js";
import type { OrganizationRepository } from "../src/persistence/types.js";

/**
 * Parity, exercised against the MEMORY repo here. The prisma repo cannot be
 * exercised without a database, so its half of the rule is enforced by the
 * type checker (the record type gains the fields, so an explicit mapper that
 * omits them fails to compile) plus the mapper review in Step 4. If you find
 * yourself able to compile prisma.ts without touching it, stop — that means the
 * mapper is spreading and the drift risk lives somewhere else.
 */
function seed(repo: OrganizationRepository) {
  return repo.create({
    name: `Brandable ${Math.random().toString(36).slice(2, 8)}`, orgType: "corporate",
    registrationId: null, jurisdiction: null,
    did: `did:key:zBrand${Math.random().toString(36).slice(2, 8)}`, didSeedEncrypted: "enc",
    status: "active", verified: true, verifiedAt: new Date().toISOString(),
    companyProfile: null, capabilities: null,
    brandLogoDocumentId: null, brandAccent: null,
  });
}

describe("organization branding persistence", () => {
  it("a new organization starts unbranded — every pre-EN-E org is unchanged", async () => {
    const repo = new MemoryOrganizationRepository();
    const org = await seed(repo);
    expect(org.brandLogoDocumentId).toBeNull();
    expect(org.brandAccent).toBeNull();
  });

  it("setBranding writes both fields and they survive a re-read", async () => {
    const repo = new MemoryOrganizationRepository();
    const org = await seed(repo);
    const updated = await repo.setBranding(org.id, { brandLogoDocumentId: "doc_1", brandAccent: "#0e8c75" });
    expect(updated).toMatchObject({ brandLogoDocumentId: "doc_1", brandAccent: "#0e8c75" });
    expect(await repo.get(org.id)).toMatchObject({ brandLogoDocumentId: "doc_1", brandAccent: "#0e8c75" });
  });

  it("an OMITTED field is left alone; an explicit null CLEARS it", async () => {
    // The whole reason the patch type is `field?: T | null` rather than `T | null`:
    // "leave my logo, change my colour" has to be expressible.
    const repo = new MemoryOrganizationRepository();
    const org = await seed(repo);
    await repo.setBranding(org.id, { brandLogoDocumentId: "doc_1", brandAccent: "#0e8c75" });

    await repo.setBranding(org.id, { brandAccent: "#112233" });
    expect(await repo.get(org.id)).toMatchObject({ brandLogoDocumentId: "doc_1", brandAccent: "#112233" });

    await repo.setBranding(org.id, { brandLogoDocumentId: null });
    expect(await repo.get(org.id)).toMatchObject({ brandLogoDocumentId: null, brandAccent: "#112233" });
  });

  it("leaves every other field untouched", async () => {
    const repo = new MemoryOrganizationRepository();
    const org = await seed(repo);
    const after = await repo.setBranding(org.id, { brandAccent: "#112233" });
    expect(after).toMatchObject({ id: org.id, name: org.name, did: org.did, status: org.status, verified: org.verified });
  });
});
