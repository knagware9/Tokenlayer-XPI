import { describe, expect, it } from "vitest";
import { MemoryCredentialRepository, MemoryVerificationRequestRepository } from "../src/persistence/memory.js";
import type { CredentialRecord } from "../src/persistence/types.js";

const cred = (id: string, over: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id, holderDid: `did:key:h-${id}`, issuerDid: "did:key:issuer", type: "ScoreCredential",
  vcJwt: "jwt", subjectClaims: {}, issuedAt: "2026-08-01T00:00:00.000Z", expiresAt: null,
  revoked: false, revokedAt: null, revokedReason: null, revokedBy: null, proposalId: null,
  credentialUseCaseKey: "uc-a", acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
  ...over,
});

describe("repo list() (ID-N task N1)", () => {
  it("MemoryCredentialRepository.list returns every stored credential", async () => {
    const repo = new MemoryCredentialRepository();
    await repo.create(cred("c1"));
    await repo.create(cred("c2", { credentialUseCaseKey: null }));
    const all = await repo.list();
    expect(all.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("MemoryVerificationRequestRepository.list returns every request", async () => {
    const repo = new MemoryVerificationRequestRepository();
    await repo.create({
      verifierOrgId: "org-1", holderDid: "did:key:h", requestedTypes: ["ScoreCredential"],
      purpose: "p", credentialUseCaseKey: "uc-a", challenge: "ch", status: "pending",
      presentationVpJwt: null, consentedAt: null, consentedCredentialIds: null,
      verifierResult: null, verifiedAt: null, expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect((await repo.list())).toHaveLength(1);
  });
});
