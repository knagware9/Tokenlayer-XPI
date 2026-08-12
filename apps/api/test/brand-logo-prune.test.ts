import { describe, expect, it } from "vitest";
import { MemoryDocumentRepository } from "../src/persistence/memory.js";
import { BRAND_LOGO_PRUNE_GRACE_MS, pruneSupersededBrandLogos } from "../src/brand-logo-prune.js";

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

/** Force a row's `createdAt` into the past by `ms`, so age-floor tests are
 *  deterministic and don't depend on real elapsed wall-clock time.
 *  `docs.get()` returns the live stored object (no copy), so this mutation
 *  is visible to the repository. */
async function ageBy(docs: MemoryDocumentRepository, id: string, ms: number): Promise<void> {
  const row = await docs.get(id);
  if (!row) throw new Error(`no such document ${id}`);
  row.createdAt = new Date(Date.parse(row.createdAt) - ms).toISOString();
}

const OLD_ENOUGH_MS = 120_000; // 2 minutes — comfortably past the production 60s default

describe("pruneSupersededBrandLogos", () => {
  it("deletes an old, unpinned row", async () => {
    const docs = new MemoryDocumentRepository();
    const make = () => docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" as const });
    const abandoned = await make();
    await ageBy(docs, abandoned.id, OLD_ENOUGH_MS);
    const fresh = await make();

    const result = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, getPinned: async () => null, graceMs: BRAND_LOGO_PRUNE_GRACE_MS });

    expect(result.removed.map((r) => r.id)).toEqual([abandoned.id]);
    expect(result.lostPinnedId).toBeNull();
    expect(await docs.get(abandoned.id)).toBeNull();
    expect(await docs.get(fresh.id)).not.toBeNull();
  });

  it("spares a pinned row even once it's old enough to prune", async () => {
    const docs = new MemoryDocumentRepository();
    const make = () => docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" as const });
    const pinned = await make();
    await ageBy(docs, pinned.id, OLD_ENOUGH_MS);
    const fresh = await make();

    const result = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, getPinned: async () => pinned.id, graceMs: BRAND_LOGO_PRUNE_GRACE_MS });

    expect(result.removed).toEqual([]);
    expect(await docs.get(pinned.id)).not.toBeNull();
  });

  /**
   * THE ACTUAL CONCURRENCY GUARD (quality review, second round). A pre-store
   * snapshot ("only ever consider rows listed before this call's own store")
   * was tried and found insufficient: reproduced on a real server over real
   * TCP against real SQLite, it still loses a concurrent upload, because only
   * ONE side of two overlapping requests needs to list AFTER the other's
   * store lands — mutual visibility was never the actual failure mode. See
   * the long module comment for the exact interleaving that broke it.
   *
   * The age floor sidesteps the ordering question entirely: a row is a
   * deletion candidate only once it is at least `graceMs` old, independent of
   * when anyone listed anything. At the production default, a row that is
   * only milliseconds old — exactly what a genuinely concurrent sibling
   * upload looks like, regardless of which request's list or store ran
   * first — is unconditionally spared.
   */
  it("PRODUCTION DEFAULT: spares a freshly-created row regardless of pin state", async () => {
    const docs = new MemoryDocumentRepository();
    const make = () => docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" as const });
    const freshSibling = await make(); // NOT aged — milliseconds old, like a concurrent upload
    const justUploaded = await make();

    const result = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: justUploaded.id, getPinned: async () => null, graceMs: BRAND_LOGO_PRUNE_GRACE_MS });

    expect(result.removed).toEqual([]);
    expect(await docs.get(freshSibling.id)).not.toBeNull();
  });

  it("with graceMs: 0, an unaged row is still prunable — the floor becomes a no-op, not a permanent hold", async () => {
    const docs = new MemoryDocumentRepository();
    const make = () => docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" as const });
    const abandoned = await make();
    const fresh = await make();

    const result = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, getPinned: async () => null, graceMs: 0 });

    expect(result.removed.map((r) => r.id)).toEqual([abandoned.id]);
  });

  it("never touches another org's rows or this org's non-brand-logo documents", async () => {
    const docs = new MemoryDocumentRepository();
    const mine = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    await ageBy(docs, mine.id, OLD_ENOUGH_MS);
    const artwork = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: null });
    const theirs = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_b", purpose: "brand-logo" });
    await ageBy(docs, theirs.id, OLD_ENOUGH_MS);
    const fresh = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });

    const result = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, getPinned: async () => null, graceMs: BRAND_LOGO_PRUNE_GRACE_MS });

    expect(result.removed.map((r) => r.id)).toEqual([mine.id]);
    expect(await docs.get(artwork.id)).not.toBeNull();
    expect(await docs.get(theirs.id)).not.toBeNull();
  });

  it("is best-effort: one failing delete does not stop the others, and nothing throws", async () => {
    const docs = new MemoryDocumentRepository();
    const doomed = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    await ageBy(docs, doomed.id, OLD_ENOUGH_MS);
    const other = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    await ageBy(docs, other.id, OLD_ENOUGH_MS);
    const fresh = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });

    const realRemove = docs.removeByOwnerPurpose.bind(docs);
    docs.removeByOwnerPurpose = async (id: string, ownerOrgId: string, purpose: "brand-logo") => {
      if (id === doomed.id) throw new Error("database is on fire");
      await realRemove(id, ownerOrgId, purpose);
    };

    const result = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, getPinned: async () => null, graceMs: BRAND_LOGO_PRUNE_GRACE_MS });

    expect(result.removed.map((r) => r.id)).toEqual([other.id]);
    expect(await docs.get(doomed.id)).not.toBeNull();
  });

  it("returns nothing removed when listing itself fails", async () => {
    const docs = new MemoryDocumentRepository();
    const fresh = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    docs.listByOwnerPurpose = async () => { throw new Error("database is on fire"); };

    await expect(pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, getPinned: async () => null, graceMs: 0 }))
      .resolves.toEqual({ removed: [], lostPinnedId: null });
  });

  /**
   * IMPORTANT 3 (quality review): `getPinned` throwing — the org could not be
   * re-read, so the pin state is UNKNOWN — must fail closed (leave the row),
   * never be treated as "nothing is pinned".
   */
  it("fails closed: leaves a row in place when the pin state cannot be determined", async () => {
    const docs = new MemoryDocumentRepository();
    const old = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    await ageBy(docs, old.id, OLD_ENOUGH_MS);
    const fresh = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });

    const result = await pruneSupersededBrandLogos(docs, "org_a", {
      justUploaded: fresh.id,
      getPinned: async () => { throw new Error("cannot reach the organization row"); },
      graceMs: BRAND_LOGO_PRUNE_GRACE_MS,
    });

    expect(result.removed).toEqual([]);
    expect(await docs.get(old.id)).not.toBeNull();
  });

  /**
   * CRITICAL 2 (quality review): the pin is now re-read fresh immediately
   * before each delete, which closes the wide "read once up front" window —
   * but a PATCH landing strictly between that fresh read and the DELETE
   * succeeding is still possible. This proves the residual is DETECTED
   * (`lostPinnedId`), not silently absorbed. Left as detection, not
   * prevention: the deletion has already happened by the time this could
   * notice, so there is nothing left to gate.
   */
  it("reports lostPinnedId when a row becomes pinned between its own check and the delete completing", async () => {
    const docs = new MemoryDocumentRepository();
    const raced = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });
    await ageBy(docs, raced.id, OLD_ENOUGH_MS);
    const fresh = await docs.create({ contentType: "image/png", bytes: PNG, ownerOrgId: "org_a", purpose: "brand-logo" });

    let pinnedNow: string | null = null;
    const realRemove = docs.removeByOwnerPurpose.bind(docs);
    docs.removeByOwnerPurpose = async (id: string, ownerOrgId: string, purpose: "brand-logo") => {
      // Simulates a PATCH pinning `raced` in the gap between the per-row
      // getPinned() read (which had already returned null) and this delete.
      if (id === raced.id) pinnedNow = raced.id;
      await realRemove(id, ownerOrgId, purpose);
    };

    const result = await pruneSupersededBrandLogos(docs, "org_a", { justUploaded: fresh.id, getPinned: async () => pinnedNow, graceMs: BRAND_LOGO_PRUNE_GRACE_MS });

    // The row was still deleted — the window is narrowed, not closed — but
    // the loss is detected and reported rather than silently absorbed.
    expect(await docs.get(raced.id)).toBeNull();
    expect(result.removed.map((r) => r.id)).toEqual([raced.id]);
    expect(result.lostPinnedId).toBe(raced.id);
  });
});
