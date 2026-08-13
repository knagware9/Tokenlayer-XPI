/**
 * AN ISSUER'S REGISTER HAS TO SAY WHICH PROGRAMME, AND WHETHER IT IS IN FORCE.
 *
 * `GET /orgs/{id}/credentials` returned an undifferentiated pile: an authority
 * running several credential use cases could not tell which one a credential
 * came from, so nothing could be counted or reconciled per programme — and a
 * revoked-but-never-accepted credential was indistinguishable from one in
 * active use.
 *
 * Both facts were already on the row. The failure was the projection, and
 * `fast-json-stringify` makes that failure silent twice over: a field the
 * response schema does not name is dropped on the way out, so adding it in the
 * handler alone changes nothing an integrator can see. Hence a test that reads
 * the HTTP response rather than the repository.
 */
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

/** An org with a DID, and a session that may read its credentials. */
async function issuerOrg(h: TestAppHandle, admin: string): Promise<{ id: string; did: string }> {
  const res = await h.app.inject({
    method: "POST", url: `${V1}/orgs`, headers: auth(admin),
    payload: { name: `Authority ${Math.random().toString(36).slice(2, 8)}`, orgType: "government" },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id as string, did: res.json().did as string };
}

describe("the issuer's credential register carries its programme", () => {
  it("returns credentialUseCaseKey and acceptance on every row", async () => {
    const h = await buildTestAppWithRepos();
    try {
      const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
      const org = await issuerOrg(h, admin);

      // Two credentials from the SAME issuer under DIFFERENT programmes — the
      // case the old projection could not distinguish at all.
      await h.deps.credentials.create({
        id: "cred_a", holderDid: "did:key:zHolderA", issuerDid: org.did, type: "DomicileCredential",
        vcJwt: "h.p.s", subjectClaims: { holderName: "Asha" },
        issuedAt: new Date().toISOString(), expiresAt: null,
        revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
        proposalId: null, credentialUseCaseKey: "domicile-certificate",
        acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
        anchorTxHash: null, anchorChainId: null,
      } as never);
      await h.deps.credentials.create({
        id: "cred_b", holderDid: "did:key:zHolderB", issuerDid: org.did, type: "IncomeCertificate",
        vcJwt: "h.p.s", subjectClaims: { holderName: "Ravi" },
        issuedAt: new Date().toISOString(), expiresAt: null,
        revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
        proposalId: null, credentialUseCaseKey: "egovernance-certificate",
        acceptance: "pending", acceptanceAt: null, acceptanceNote: null,
        anchorTxHash: null, anchorChainId: null,
      } as never);

      const res = await h.app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/credentials`, headers: auth(admin) });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as { id: string; credentialUseCaseKey: string | null; acceptance: string }[];

      const a = rows.find((r) => r.id === "cred_a");
      const b = rows.find((r) => r.id === "cred_b");
      expect(a?.credentialUseCaseKey).toBe("domicile-certificate");
      expect(b?.credentialUseCaseKey).toBe("egovernance-certificate");

      // The second fact: issued is not the same as in force.
      expect(a?.acceptance).toBe("accepted");
      expect(b?.acceptance).toBe("pending");
    } finally {
      await h.app.close();
    }
  }, 30_000);

  it("keeps a null programme null — a platform-catalog credential belongs to no use case", async () => {
    // KycCredential minted at onboarding carries no credentialUseCaseKey.
    // Rendering that as a programme id (or dropping the row) would put every
    // onboarding credential into whichever scheme sorted first.
    const h = await buildTestAppWithRepos();
    try {
      const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
      const org = await issuerOrg(h, admin);
      await h.deps.credentials.create({
        id: "cred_kyc", holderDid: "did:key:zHolderC", issuerDid: org.did, type: "KycCredential",
        vcJwt: "h.p.s", subjectClaims: {}, issuedAt: new Date().toISOString(), expiresAt: null,
        revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
        proposalId: null, credentialUseCaseKey: null,
        acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
        anchorTxHash: null, anchorChainId: null,
      } as never);

      const rows = (await h.app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/credentials`, headers: auth(admin) })).json() as
        { id: string; credentialUseCaseKey: string | null }[];
      const row = rows.find((r) => r.id === "cred_kyc");
      expect(row).toBeTruthy();
      expect(row?.credentialUseCaseKey ?? null).toBeNull();
    } finally {
      await h.app.close();
    }
  }, 30_000);

  it("still refuses another organization's register", async () => {
    // The addition must not have widened who can read this.
    const h = await buildTestAppWithRepos();
    try {
      const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
      const orgA = await issuerOrg(h, admin);
      const orgB = await issuerOrg(h, admin);
      const email = `oadmin-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const add = await h.app.inject({
        method: "POST", url: `${V1}/orgs/${orgB.id}/users`, headers: auth(admin),
        payload: { email, password: "Password123!", role: "OrgAdmin" },
      });
      expect(add.statusCode).toBe(201);
      const bAdmin = await loginAs(h.app, email, "Password123!");

      const own = await h.app.inject({ method: "GET", url: `${V1}/orgs/${orgB.id}/credentials`, headers: auth(bAdmin) });
      expect(own.statusCode).toBe(200);
      const other = await h.app.inject({ method: "GET", url: `${V1}/orgs/${orgA.id}/credentials`, headers: auth(bAdmin) });
      expect(other.statusCode).toBe(403);
    } finally {
      await h.app.close();
    }
  }, 30_000);
});
