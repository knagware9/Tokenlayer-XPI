import { describe, expect, it } from "vitest";
import { MemoryVerificationRequestRepository } from "../src/persistence/memory.js";

const base = {
  verifierOrgId: "org_v", holderDid: "did:key:zH", requestedTypes: ["KycCredential"],
  purpose: "onboarding", challenge: "chal-1", status: "pending" as const,
  presentationVpJwt: null, consentedAt: null, consentedCredentialIds: null,
  verifierResult: null, verifiedAt: null, expiresAt: "2026-07-18T00:00:00.000Z",
};

describe("MemoryVerificationRequestRepository", () => {
  it("creates, gets, and lists by holder and by verifier org", async () => {
    const repo = new MemoryVerificationRequestRepository();
    const r = await repo.create(base);
    expect(r.id).toBeTruthy();
    expect(r.status).toBe("pending");
    expect((await repo.get(r.id))?.purpose).toBe("onboarding");
    expect(await repo.listByHolder("did:key:zH")).toHaveLength(1);
    expect(await repo.listByHolder("did:key:zH", "consented")).toHaveLength(0);
    expect(await repo.listByVerifierOrg("org_v")).toHaveLength(1);
    expect(await repo.listByVerifierOrg("org_other")).toHaveLength(0);
  });

  it("sets consent and status transitions", async () => {
    const repo = new MemoryVerificationRequestRepository();
    const r = await repo.create(base);
    const c = await repo.setConsented(r.id, { vpJwt: "a.b.c", credentialIds: ["cred_1"], at: "2026-07-17T12:00:00.000Z" });
    expect(c.status).toBe("consented");
    expect(c.presentationVpJwt).toBe("a.b.c");
    expect(c.consentedCredentialIds).toEqual(["cred_1"]);
    const rej = await repo.setStatus(r.id, "rejected");
    expect(rej.status).toBe("rejected");
    const v = await repo.setVerifierResult(r.id, { result: { valid: true }, at: "2026-07-17T13:00:00.000Z" });
    expect(v.verifierResult).toEqual({ valid: true });
    expect(v.verifiedAt).toBe("2026-07-17T13:00:00.000Z");
  });
});
