import { describe, expect, it } from "vitest";
import { MemoryDocumentRepository } from "../src/persistence/memory.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=", "base64");

describe("MemoryDocumentRepository — purpose", () => {
  it("stores the purpose and reads it back on the record", async () => {
    const docs = new MemoryDocumentRepository();
    const made = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    expect((await docs.get(made.id))?.purpose).toBe("brand-logo");

    const plain = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: null });
    expect((await docs.get(plain.id))?.purpose).toBeNull();
  });

  it("listByOwnerPurpose filters on BOTH owner and purpose, and never returns bytes", async () => {
    const docs = new MemoryDocumentRepository();
    const mine = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    // Same org, different purpose — this is the certificate-artwork / invoice-evidence
    // case that a naive `ownerOrgId`-only query would have swept up.
    await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: null });
    // Same purpose, different org — the cross-tenant half.
    await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_b", purpose: "brand-logo" });

    const rows = await docs.listByOwnerPurpose("org_a", "brand-logo");
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
    // This only proves the SUMMARY SHAPE returned to the caller has no `bytes`
    // property — it would still pass if the underlying query fetched the blob
    // and the mapping simply dropped it. That the SQL itself never reads the
    // column is enforced by the `select` clause in prisma.ts, not by this test.
    expect(rows[0]).not.toHaveProperty("bytes");
    expect(rows[0]).toMatchObject({ id: mine.id, size: PNG.length, createdAt: expect.any(String) });
  });

  it("removeByOwnerPurpose deletes only a row that matches BOTH owner and purpose", async () => {
    const docs = new MemoryDocumentRepository();
    const mine = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    const wrongOrg = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_b", purpose: "brand-logo" });
    const wrongPurpose = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: null });

    // The guard bites: neither a foreign-org row nor a different-purpose row
    // is deleted, even though the id is otherwise valid.
    await docs.removeByOwnerPurpose(wrongOrg.id, "org_a", "brand-logo");
    expect(await docs.get(wrongOrg.id)).not.toBeNull();
    await docs.removeByOwnerPurpose(wrongPurpose.id, "org_a", "brand-logo");
    expect(await docs.get(wrongPurpose.id)).not.toBeNull();

    await docs.removeByOwnerPurpose(mine.id, "org_a", "brand-logo");
    expect(await docs.get(mine.id)).toBeNull();

    // Idempotent: an absent id, under the same owner/purpose, is not an error.
    await expect(docs.removeByOwnerPurpose("doc_never_existed", "org_a", "brand-logo")).resolves.toBeUndefined();
  });
});
