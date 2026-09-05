import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

async function uploadDoc(app: import("fastify").FastifyInstance, token: string, label: string) {
  const res = await app.inject({
    method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(token),
    payload: { contentType: "application/pdf", dataBase64: Buffer.from(`%PDF-1.4 ${label}`).toString("base64") },
  });
  return res.json().id as string;
}

const SUBMISSION = {
  legalName: "Test Holder", country: "IN", idType: "passport", idNumber: "P1234567",
  dateOfBirth: "1990-01-01", address: { street: "1 Main St", city: "Mumbai", postalCode: "400001" },
  occupation: "Engineer", sourceOfFunds: "Salary", pepDeclaration: false,
};

describe("self-service KYC submission", () => {
  it("submitting sets kycStatus pending and stores the full field set plus both documents", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const idDocId = await uploadDoc(h.app, buyer, "id");
    const addressDocId = await uploadDoc(h.app, buyer, "address");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(buyer),
      payload: { ...SUBMISSION, idDocumentId: idDocId, addressDocumentId: addressDocId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kycStatus).toBe("pending");
    const list = await h.app.inject({ method: "GET", url: `${V1}/users`, headers: auth(await loginAs(h.app, "admin@tokenlayer.dev", "admin123")) });
    const row = (list.json() as { email: string; kycStatus: string; kyc: Record<string, unknown> }[]).find((u) => u.email === "carbon.buyer@tokenlayer.dev");
    expect(row?.kycStatus).toBe("pending");
    expect(row?.kyc?.legalName).toBe("Test Holder");
    expect((row?.kyc?.idDocument as { id: string }).id).toBe(idDocId);
  });

  it("rejects a submission referencing a document uploaded by someone else", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const other = await loginAs(h.app, "carbon.issuer@tokenlayer.dev", "carbon123");
    const idDocId = await uploadDoc(h.app, other, "not-yours");
    const addressDocId = await uploadDoc(h.app, buyer, "address");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(buyer),
      payload: { ...SUBMISSION, idDocumentId: idDocId, addressDocumentId: addressDocId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("DOCUMENT_NOT_YOURS");
  });

  it("rejects a submission missing a required document", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const addressDocId = await uploadDoc(h.app, buyer, "address");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(buyer),
      payload: { ...SUBMISSION, addressDocumentId: addressDocId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a re-submission MERGES over the caller's existing kyc blob, keeping fields the submission form does not carry (revokedAt/revokeReason)", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    // Simulate a prior revocation — a field the submission body never sends.
    await h.users.update(user!.id, { kyc: { ...(user!.kyc ?? {}), revokedAt: "2026-01-01T00:00:00.000Z", revokeReason: "credential compromised" } });
    const idDocId = await uploadDoc(h.app, buyer, "id-merge");
    const addressDocId = await uploadDoc(h.app, buyer, "address-merge");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(buyer),
      payload: { ...SUBMISSION, idDocumentId: idDocId, addressDocumentId: addressDocId },
    });
    expect(res.statusCode).toBe(200);
    const updated = await h.users.findById(user!.id);
    expect(updated!.kyc!.revokedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated!.kyc!.revokeReason).toBe("credential compromised");
    // The submission's own fields still land.
    expect(updated!.kyc!.legalName).toBe("Test Holder");
  });

  it("a re-submission after rejection works the same way", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    await h.users.update(user!.id, { kycStatus: "rejected", kyc: { ...SUBMISSION, rejectionReason: "blurry document" } });
    const idDocId = await uploadDoc(h.app, buyer, "id-2");
    const addressDocId = await uploadDoc(h.app, buyer, "address-2");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(buyer),
      payload: { ...SUBMISSION, idDocumentId: idDocId, addressDocumentId: addressDocId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kycStatus).toBe("pending");
  });
});
