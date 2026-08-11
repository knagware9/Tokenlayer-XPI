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
    // Deciding what to delete must not drag 5MB buffers into memory.
    expect(rows[0]).not.toHaveProperty("bytes");
    expect(rows[0]).toMatchObject({ id: mine.id, size: PNG.length, createdAt: expect.any(String) });
  });

  it("remove deletes the row, and removing an absent id is not an error", async () => {
    const docs = new MemoryDocumentRepository();
    const made = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    await docs.remove(made.id);
    expect(await docs.get(made.id)).toBeNull();
    await expect(docs.remove("doc_never_existed")).resolves.toBeUndefined();
  });
});
