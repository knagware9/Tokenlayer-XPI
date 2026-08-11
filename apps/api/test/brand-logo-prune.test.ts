import { describe, expect, it } from "vitest";
import { MemoryDocumentRepository } from "../src/persistence/memory.js";
import { pruneSupersededBrandLogos } from "../src/brand-logo-prune.js";

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

describe("pruneSupersededBrandLogos", () => {
  it("deletes the org's other brand logos, sparing the new one and the pinned one", async () => {
    const docs = new MemoryDocumentRepository();
    const make = () => docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" as const });
    const pinned = await make();
    const abandoned = await make();
    const fresh = await make();

    const removed = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, pinned: pinned.id });

    expect(removed).toEqual([abandoned.id]);
    expect(await docs.get(abandoned.id)).toBeNull();
    expect(await docs.get(pinned.id)).not.toBeNull();
    expect(await docs.get(fresh.id)).not.toBeNull();
  });

  it("spares nothing but the new upload when the org has no logo pinned", async () => {
    const docs = new MemoryDocumentRepository();
    const make = () => docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" as const });
    const first = await make();
    const second = await make();

    const removed = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: second.id, pinned: null });

    expect(removed).toEqual([first.id]);
    expect(await docs.get(second.id)).not.toBeNull();
  });

  it("never touches another org's rows, or this org's non-brand-logo documents", async () => {
    const docs = new MemoryDocumentRepository();
    const mine = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    const fresh = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    const artwork = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: null });
    const theirs = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_b", purpose: "brand-logo" });

    const removed = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, pinned: null });

    expect(removed).toEqual([mine.id]);
    expect(await docs.get(artwork.id)).not.toBeNull();
    expect(await docs.get(theirs.id)).not.toBeNull();
  });

  it("is best-effort: one failing delete does not stop the others, and nothing throws", async () => {
    const docs = new MemoryDocumentRepository();
    const doomed = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    const other = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    const fresh = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });

    const realRemove = docs.removeByOwnerPurpose.bind(docs);
    docs.removeByOwnerPurpose = async (id: string, ownerOrgId: string, purpose: "brand-logo") => {
      if (id === doomed.id) throw new Error("database is on fire");
      await realRemove(id, ownerOrgId, purpose);
    };

    const removed = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, pinned: null });

    expect(removed).toEqual([other.id]);
    expect(await docs.get(doomed.id)).not.toBeNull();
  });

  it("returns an empty list when listing itself fails", async () => {
    const docs = new MemoryDocumentRepository();
    const fresh = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    docs.listByOwnerPurpose = async () => { throw new Error("database is on fire"); };

    await expect(pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, pinned: null })).resolves.toEqual([]);
  });
});
