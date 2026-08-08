import { describe, expect, it } from "vitest";
import { MemoryApiKeyRepository } from "../src/persistence/memory.js";

describe("MemoryApiKeyRepository", () => {
  it("creates, finds by prefix and id, touches lastUsedAt and revokes", async () => {
    const repo = new MemoryApiKeyRepository();
    const rec = await repo.create({
      orgId: "org_1",
      userId: "user_svc",
      name: "ERP invoice sync",
      prefix: "a1b2c3d4",
      secretHash: "$2a$10$notarealhash",
      scopes: ["credentials:issue", "credentials:read"],
      expiresAt: null,
      createdBy: "user_admin",
    });
    expect(rec.id).toBeTruthy();
    expect(rec.createdAt).toBeTruthy();
    expect(rec.scopes).toEqual(["credentials:issue", "credentials:read"]);
    // Repo-managed lifecycle columns start null — a fresh key is live and unused.
    expect(rec.lastUsedAt).toBeNull();
    expect(rec.revokedAt).toBeNull();
    expect(rec.revokedBy).toBeNull();

    expect((await repo.findByPrefix("a1b2c3d4"))?.id).toBe(rec.id);
    expect(await repo.findByPrefix("zzzzzzzz")).toBeNull();
    expect((await repo.findById(rec.id))?.name).toBe("ERP invoice sync");
    expect(await repo.findById("ak_nope")).toBeNull();

    await repo.touchLastUsed(rec.id, "2026-08-08T10:00:00.000Z");
    expect((await repo.findById(rec.id))?.lastUsedAt).toBe("2026-08-08T10:00:00.000Z");
    await repo.touchLastUsed(rec.id, "2026-08-08T10:05:00.000Z");
    expect((await repo.findById(rec.id))?.lastUsedAt).toBe("2026-08-08T10:05:00.000Z");

    const revoked = await repo.revoke(rec.id, { by: "user_admin", at: "2026-08-08T11:00:00.000Z" });
    expect(revoked.revokedAt).toBe("2026-08-08T11:00:00.000Z");
    expect(revoked.revokedBy).toBe("user_admin");
    expect((await repo.findByPrefix("a1b2c3d4"))?.revokedAt).toBe("2026-08-08T11:00:00.000Z");
  });

  it("lists an org's keys INCLUDING revoked ones — they carry the audit trail", async () => {
    const repo = new MemoryApiKeyRepository();
    const base = { userId: "user_svc", secretHash: "h", scopes: ["*"], expiresAt: null, createdBy: "user_admin" };
    const live = await repo.create({ ...base, orgId: "org_1", name: "live", prefix: "aaaaaaaa" });
    const dead = await repo.create({ ...base, orgId: "org_1", name: "dead", prefix: "bbbbbbbb" });
    await repo.create({ ...base, orgId: "org_2", name: "other org", prefix: "cccccccc" });
    // A platform-owned key (orgId null) belongs to no org listing.
    await repo.create({ ...base, orgId: null, name: "platform", prefix: "dddddddd" });
    await repo.revoke(dead.id, { by: "user_admin", at: "2026-08-08T11:00:00.000Z" });

    const listed = await repo.listByOrg("org_1");
    expect(listed.map((k) => k.id).sort()).toEqual([live.id, dead.id].sort());
    expect(listed.find((k) => k.id === dead.id)?.revokedAt).toBe("2026-08-08T11:00:00.000Z");
    expect(await repo.listByOrg("org_none")).toEqual([]);
  });

  it("rejects lifecycle writes against an unknown key", async () => {
    const repo = new MemoryApiKeyRepository();
    await expect(repo.revoke("ak_nope", { by: "u", at: "2026-08-08T11:00:00.000Z" })).rejects.toThrow("unknown api key");
  });
});
