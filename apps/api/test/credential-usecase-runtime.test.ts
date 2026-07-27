import { describe, expect, it } from "vitest";
import { MemoryCredentialRepository } from "../src/persistence/memory.js";

describe("credential record carries credentialUseCaseKey", () => {
  it("round-trips the new field through the repo", async () => {
    const repo = new MemoryCredentialRepository();
    const rec = await repo.create({
      id: "c1", holderDid: "did:key:zH", issuerDid: "did:key:zI", type: "MCACredential",
      vcJwt: "jwt", subjectClaims: { id: "did:key:zH" }, issuedAt: new Date().toISOString(),
      expiresAt: null, revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
      proposalId: null, credentialUseCaseKey: "corp-trade-credentials",
    });
    expect(rec.credentialUseCaseKey).toBe("corp-trade-credentials");
    const back = await repo.get("c1");
    expect(back?.credentialUseCaseKey).toBe("corp-trade-credentials");
  });
});
