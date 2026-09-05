import { describe, expect, it } from "vitest";
import { MemoryUserRepository } from "../src/persistence/memory/index.js";
import { findKycDocumentIds } from "../src/shared/kyc-document-backfill.js";

describe("findKycDocumentIds", () => {
  it("collects both the id and address document from a user's kyc, deduplicated across users", async () => {
    const users = new MemoryUserRepository();
    await users.create({
      email: "a@x.dev", passwordHash: "h", role: "Buyer", useCaseKey: null, accountId: null, active: true,
      kycStatus: "approved",
      kyc: { idDocument: { id: "doc-1", sha256: "0x1" }, addressDocument: { id: "doc-2", sha256: "0x2" } },
    });
    await users.create({
      email: "b@x.dev", passwordHash: "h", role: "Buyer", useCaseKey: null, accountId: null, active: true,
      kycStatus: "approved",
      // Shares doc-2 with the user above (e.g. a re-submission that reused an
      // id by coincidence in test data) — must appear once in the result.
      kyc: { idDocument: { id: "doc-3", sha256: "0x3" }, addressDocument: { id: "doc-2", sha256: "0x2" } },
    });

    const ids = await findKycDocumentIds({ users });
    expect(ids.sort()).toEqual(["doc-1", "doc-2", "doc-3"]);
  });

  it("skips users with no kyc, or with kyc but no document references yet", async () => {
    const users = new MemoryUserRepository();
    await users.create({ email: "c@x.dev", passwordHash: "h", role: "Buyer", useCaseKey: null, accountId: null, active: true, kycStatus: "pending", kyc: null });
    await users.create({ email: "d@x.dev", passwordHash: "h", role: "Buyer", useCaseKey: null, accountId: null, active: true, kycStatus: "pending", kyc: { legalName: "No Docs Yet" } });

    const ids = await findKycDocumentIds({ users });
    expect(ids).toEqual([]);
  });

  it("returns an empty list when there are no users at all", async () => {
    const users = new MemoryUserRepository();
    expect(await findKycDocumentIds({ users })).toEqual([]);
  });
});
